const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const modelRegistryData = require("../../src/models/modelRegistryData.json");
const { buildGguf, LLAMA_3_2_3B_ENTRIES } = require("./harness/ggufFixtures");
const { createLocalRequestYield, YIELDED_CODE } = require("../../src/helpers/localRequestYield.js");

// Dictation comes first on the local model: the real IPC bridge
// (localReasoningBridge → modelManagerBridge → llamaServer) against an HTTP
// stub standing in for llama-server. A test-set request in flight is aborted
// by its request id when a dictation starts, which frees the one slot the
// bridge has, so the dictation's own cleanup never meets LOCAL_MODEL_BUSY; a
// test request never starts during a dictation; and a test request's text and
// reply stay out of main's reasoning log.

const TEST_INPUT = "um please send the quarterly numbers to Maria by friday";
const TEST_REPLY = "Please send the quarterly numbers to Maria by Friday.";

const originalLoad = Module._load;
const CHAIN_MODULES = [
  "../../src/services/localReasoningBridge.js",
  "../../src/helpers/modelManagerBridge.js",
  "../../src/helpers/modelDirUtils.js",
  "../../src/helpers/llamaServer.js",
].map((relative) => require.resolve(relative));
let electronHome = os.tmpdir();

function loadChain() {
  for (const modulePath of CHAIN_MODULES) delete require.cache[modulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          isReady: () => true,
          getAppPath: () => process.cwd(),
          getPath: (name) => (name === "home" ? electronHome : path.join(electronHome, name)),
        },
        net: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require("../../src/helpers/modelDirUtils.js");
    const bridge = require("../../src/services/localReasoningBridge.js").default;
    const modelManager = require("../../src/helpers/modelManagerBridge.js").default;
    const debugLogger = require("../../src/helpers/debugLogger.js");
    return { bridge, modelManager, debugLogger };
  } finally {
    Module._load = originalLoad;
  }
}

const MODEL_FILE = Buffer.concat([buildGguf(LLAMA_3_2_3B_ENTRIES), Buffer.alloc(1_000_001, 1)]);

async function setupChain(t, respond) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-local-yield-"));
  electronHome = home;
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      const reply = respond(requests.length);
      if (reply === null) return; // still generating
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: reply } }] })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const { bridge, modelManager, debugLogger } = loadChain();
  const model = modelRegistryData.localProviders[0].models[0];
  modelManager.ensureInitialized();
  await fs.mkdir(modelManager.modelsDir, { recursive: true });
  await fs.writeFile(path.join(modelManager.modelsDir, model.fileName), MODEL_FILE);
  modelManager._systemMemoryBytes = () => 48 * 1024 * 1024 * 1024;
  const serverManager = modelManager.serverManager;
  serverManager.cachedServerBinaryPaths = { default: "/stub/llama-server" };
  serverManager.ready = true;
  serverManager.process = {};
  serverManager.port = server.address().port;
  modelManager.currentServerModelId = model.id;
  t.after(() => serverManager.clearIdleTimer());

  // Everything the chain logs, as it would reach the debug log.
  const logged = [];
  const capture =
    (level) =>
    (...args) =>
      logged.push({ level, args });
  for (const level of ["logReasoning", "debug", "info", "warn", "error"]) {
    const original = debugLogger[level];
    debugLogger[level] = capture(level);
    t.after(() => {
      debugLogger[level] = original;
    });
  }

  return { bridge, modelId: model.id, requests, logged };
}

const waitFor = async (predicate) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(predicate(), "timed out waiting");
};

const testConfig = (requestId) => ({
  systemPrompt: "Clean up this transcript.",
  temperature: 0,
  requireCompleteOutput: true,
  requestId,
  yieldToDictation: true,
  redactLogs: true,
});

test("a dictation aborts an in-flight test request and gets the freed model", async (t) => {
  const { bridge, modelId, requests } = await setupChain(t, (n) =>
    n === 1 ? null : "Dictation cleaned."
  );
  let dictating = false;
  const gate = createLocalRequestYield({
    getBridge: () => bridge,
    isDictationActive: () => dictating,
    newRequestId: () => "generated-id",
  });

  const testRequest = gate.run(TEST_INPUT, modelId, testConfig("prompt-test-1"));
  await waitFor(() => requests.length === 1);
  assert.equal(gate.inFlightCount, 1);

  // The recording starts: main aborts the test request by its id.
  dictating = true;
  assert.equal(gate.yieldAll(), 1);
  const yielded = await testRequest;
  assert.equal(yielded.success, false);
  assert.equal(yielded.code, YIELDED_CODE);
  assert.equal(gate.inFlightCount, 0);

  // A test request never starts while the dictation runs.
  const refused = await gate.run(TEST_INPUT, modelId, testConfig("prompt-test-2"));
  assert.equal(refused.code, YIELDED_CODE);
  assert.equal(requests.length, 1, "nothing reached the model");

  // The dictation's own cleanup passes through and finds the slot free.
  const dictation = await gate.run("raw dictation", modelId, { systemPrompt: "Clean up." });
  assert.deepEqual(dictation, { success: true, text: "Dictation cleaned." });

  // After the dictation, the test request goes through (its id kept, or one minted).
  dictating = false;
  const retried = await gate.run(TEST_INPUT, modelId, {
    ...testConfig(undefined),
    requestId: undefined,
  });
  assert.equal(retried.success, true);
});

test("a dictation's abort leaves other callers' requests alone", async (t) => {
  const { bridge, modelId, requests } = await setupChain(t, (n) => (n === 1 ? null : "ok"));
  let dictating = false;
  const gate = createLocalRequestYield({
    getBridge: () => bridge,
    isDictationActive: () => dictating,
    newRequestId: () => "generated-id",
  });
  // A note action that never agreed to yield.
  const note = gate.run("note text", modelId, { systemPrompt: "Summarize.", requestId: "note-1" });
  await waitFor(() => requests.length === 1);
  dictating = true;
  assert.equal(gate.yieldAll(), 0);
  bridge.cancel("note-1");
  const result = await note;
  assert.notEqual(result.code, YIELDED_CODE);
});

test("a test request's text and reply stay out of main's reasoning log", async (t) => {
  const { bridge, modelId, logged } = await setupChain(t, () => TEST_REPLY);
  const gate = createLocalRequestYield({
    getBridge: () => bridge,
    isDictationActive: () => false,
    newRequestId: () => "generated-id",
  });

  const redacted = await gate.run(TEST_INPUT, modelId, testConfig("prompt-test-3"));
  assert.equal(redacted.text, TEST_REPLY);
  const quiet = JSON.stringify(logged);
  assert.equal(quiet.includes("quarterly"), false, "no input or reply text");
  assert.equal(quiet.includes("Clean up this transcript"), false, "no prompt text");
  assert.ok(quiet.includes("textRedacted"), "the log says what it left out");

  // Control: an untagged request still logs its preview as before.
  logged.length = 0;
  await gate.run(TEST_INPUT, modelId, { systemPrompt: "Clean up." });
  assert.ok(JSON.stringify(logged).includes("quarterly"));
});
