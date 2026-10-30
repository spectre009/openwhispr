const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const { loadAudioManager } = require("./harness/audioManager");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Canary: dictated text never reaches a written log unless "Include dictated
// text" is on, and then only as a snippet of at most 80 characters. A marker
// word rides through dictation (the transcript received, local speech-to-text's
// reply and its dictionary prompt), cleanup (local and over HTTP, success and
// failure, a provider error that echoes the request), auto-learn (the paste,
// the edited field, the learned words) and the text monitor's raw output
// (plain and base64 lines). Main's real logger writes the file; the renderer's
// real logger reaches it through the preload's `log`, as in the app.

const MARKER = "zqxcanary7";
const TEXT = `${MARKER} please send the numbers to Dana by friday`;
const EDITED_MULTILINE = `${MARKER} first line\nsecond line`;
const BASE64 = Buffer.from(EDITED_MULTILINE).toString("base64");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-log-canary-"));
const logsDir = path.join(userData, "logs");
const savedEnv = {
  OPENWHISPR_LOG_LEVEL: process.env.OPENWHISPR_LOG_LEVEL,
  OPENWHISPR_LOG_TEXT: process.env.OPENWHISPR_LOG_TEXT,
  OPENWHISPR_LOG_RETENTION_DAYS: process.env.OPENWHISPR_LOG_RETENTION_DAYS,
};
process.env.OPENWHISPR_LOG_LEVEL = "debug";
delete process.env.OPENWHISPR_LOG_TEXT;
delete process.env.OPENWHISPR_LOG_RETENTION_DAYS;
// dotenv's tips go to stdout, which carries the test runner's own messages.
process.env.DOTENV_CONFIG_QUIET = "true";

const handlers = new Map();
const electronStub = {
  app: {
    isReady: () => true,
    isPackaged: true,
    getPath: () => userData,
    getAppPath: () => userData,
    getName: () => "test",
    getVersion: () => "9.9.9-test",
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
  safeStorage: { isEncryptionAvailable: () => false },
};

const bridgeModelPath = require.resolve("../../src/helpers/modelManagerBridge");
let localReply = async () => `${TEXT} (cleaned)`;
const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (
    parent?.filename?.endsWith(path.join("services", "localReasoningBridge.js")) &&
    request === "../helpers/modelManagerBridge"
  ) {
    return { default: { runInference: (...args) => localReply(...args) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const debugLogger = require("../../src/helpers/debugLogger");
const TextEditMonitor = require("../../src/helpers/textEditMonitor");
const WhisperServerManager = require("../../src/helpers/whisperServer");
const { pcm16ToWav } = require("../../src/utils/audioUtils");
const localBridge = require("../../src/services/localReasoningBridge").default;
const IPCHandlers = require("../../src/helpers/ipcHandlers");
void bridgeModelPath;

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

const Handlers = IPCHandlers.default || IPCHandlers;
const target = {
  sessionId: "canary-session",
  _autoLearnMode: "add",
  _autoLearnSynced: true,
  _autoLearnPasteSeq: 0,
  selectionManager: null,
  windowManager: { isOnboardingDemoActive: () => false, showDictationPanel: () => {} },
  clipboardManager: { pasteText: async () => ({}) },
  databaseManager: {
    applyDictionaryChanges: () => ({ success: true }),
    getDictionary: () => [],
    // Suggest mode: the inbox and the evidence, as main's database answers.
    recordDictionarySuggestions: (words) =>
      words.map((word, index) => ({ id: index + 1, word, key: word.toLowerCase() })),
    findEvidenceTranscription: () => 7,
    addDictionaryWordEvidence: () => true,
  },
  stepHistory: { currentOwner: () => "signed-out" },
  _historyPolicy: () => ({ synced: true, enabled: true, forcedOff: false, resolved: true }),
  _getDictionarySafe: () => [],
  _withoutGlossaryWords: (words) => words,
  _autoLearnArmed: Handlers.prototype._autoLearnArmed,
  _processCorrections: Handlers.prototype._processCorrections,
  _suggestCorrections: Handlers.prototype._suggestCorrections,
  _recordCorrectionEvidence: Handlers.prototype._recordCorrectionEvidence,
};
const ipc = new Proxy(target, {
  get: (value, property) => (property in value ? value[property] : anything()),
});

test.before(() => {
  // The file is what's checked; the console (on outside packaged Windows) stays quiet.
  debugLogger.consoleLoggingEnabled = false;
  debugLogger.ensureFileLogging();
  Handlers.prototype.setupHandlers.call(ipc);
});

test.after(async () => {
  debugLogger.stopMaintenance();
  await debugLogger.closeSession();
  Module._load = originalLoad;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(userData, { recursive: true, force: true });
});

// The auto-learn delays (paste settling, the edit debounce), run on demand.
function captureTimers(t) {
  const timers = [];
  const original = global.setTimeout;
  global.setTimeout = (callback, ms, ...args) => {
    if (typeof ms === "number" && ms >= 400) {
      timers.push(() => callback(...args));
      return timers.length;
    }
    return original(callback, ms, ...args);
  };
  const restore = () => {
    global.setTimeout = original;
  };
  t.after(restore);
  return {
    flush: () => {
      for (const run of timers.splice(0)) run();
    },
    restore,
  };
}

async function autoLearn(t) {
  const { flush, restore } = captureTimers(t);
  let onEdit = null;
  target.textEditMonitor = {
    lastTargetPid: 42,
    activateTargetPid: async () => true,
    startMonitoring: () => {},
    stopMonitoring: () => {},
    on: (event, handler) => {
      if (event === "text-edited") onEdit = handler;
    },
  };
  // The paste arms monitoring with the pasted text.
  await handlers.get("paste-text")({ sender: { id: 1 } }, TEXT, {});
  flush();
  // The edited field comes back, and words are learned from it.
  Handlers.prototype._setupTextEditMonitor.call(ipc);
  onEdit({
    originalText: `please email ${MARKER}bob about the plan`,
    newFieldValue: `please email ${MARKER}rob about the plan`,
  });
  flush();
  restore();
}

// Suggest mode: the learned word, what it replaced and the app the paste went
// to become a suggestion with evidence. The app never appears in a log; the
// words only inside the edit's own dictated-text snippets.
const LEARNED_MARKER = "zqxlearnedword";
const REPLACED_MARKER = "zqxreplacedword";
const APP_MARKER = "zqxcanaryapp.exe";
async function autoLearnSuggest(t) {
  const { flush, restore } = captureTimers(t);
  let onEdit = null;
  const pasted = `please ask ${REPLACED_MARKER} about the plan`;
  target._autoLearnMode = "suggest";
  t.after(() => {
    target._autoLearnMode = "add";
  });
  target.textEditMonitor = {
    lastTargetPid: 42,
    activateTargetPid: async () => true,
    startMonitoring: () => {},
    stopMonitoring: () => {},
    on: (event, handler) => {
      if (event === "text-edited") onEdit = handler;
    },
  };
  await handlers.get("paste-text")({ sender: { id: 1 } }, pasted, {});
  flush();
  // The paste's target app (Windows reports its exe name).
  if (target._autoLearnPasteContext) target._autoLearnPasteContext.app = APP_MARKER;
  Handlers.prototype._setupTextEditMonitor.call(ipc);
  onEdit({
    originalText: pasted,
    newFieldValue: `please ask ${LEARNED_MARKER} about the plan`,
  });
  flush();
  restore();
}

// The real monitor, with a stand-in helper that prints a base64 and a plain
// CHANGED line, then gives up.
async function textMonitor() {
  const monitor = new TextEditMonitor();
  const script = [
    "process.stdin.once('data', () => {",
    `  console.log('CHANGED_B64:${BASE64}');`,
    `  console.log(${JSON.stringify(`CHANGED:${TEXT} (edited)`)});`,
    "  setTimeout(() => console.log('NO_VALUE'), 50);",
    "});",
  ].join("\n");
  // From a file: the monitor logs its command line, which in the app never holds text.
  const helper = path.join(userData, "fake-text-monitor.js");
  fs.writeFileSync(helper, script);
  monitor.resolveBinary = () => ({ command: process.execPath, args: [helper] });
  const edits = [];
  monitor.on("text-edited", (edit) => edits.push(edit));
  monitor.startMonitoring(TEXT, 10000, { targetPid: 4242 });
  const deadline = Date.now() + 8000;
  while ((edits.length < 2 || monitor.process) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  monitor.stopMonitoring();
  assert.equal(edits.length, 2, "both edits arrived");
  assert.equal(edits[0].newFieldValue, EDITED_MULTILINE);
}

// Local speech-to-text against a stand-in whisper-server: the dictionary prompt,
// the transcript in the reply, and two failures whose bodies carry the text.
async function whisperServer() {
  const replies = [
    { status: 200, body: JSON.stringify({ text: TEXT }) },
    { status: 200, body: `${MARKER} is not JSON` },
    { status: 500, body: `${TEXT} crashed` },
  ];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const reply = replies.shift();
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(reply.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const manager = new WhisperServerManager();
    Object.assign(manager, {
      ready: true,
      isRemote: true,
      hostname: "127.0.0.1",
      port: server.address().port,
    });
    const wav = pcm16ToWav(Buffer.alloc(3200));
    const result = await manager.transcribe(wav, { initialPrompt: `${MARKER} Dana Kubernetes` });
    assert.equal(result.text, TEXT);
    for (let i = 0; i < 2; i += 1) {
      await manager.transcribe(wav, {}).then(
        () => assert.fail("expected a failure"),
        (error) => debugLogger.error("Local Whisper transcription error", error)
      );
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function localCleanup() {
  localReply = async () => `${TEXT} (cleaned)`;
  await localBridge.processText(TEXT, "local-model", {
    systemPrompt: `Fix the spelling of ${MARKER} and Dana.`,
  });
  localReply = async () => {
    throw new Error("llama-server returned status 500");
  };
  await localBridge.processText(TEXT, "local-model", { systemPrompt: "Clean up." }).catch(() => {});
}

function rendererApi(includeText) {
  return {
    getLogState: async () => ({ level: debugLogger.getLevel(), includeText }),
    log: async (entry) => debugLogger.logEntry(entry),
  };
}

// The renderer's dictation pipeline: the transcript arrives, cleanup succeeds,
// then cleanup fails.
async function rendererDictation(t, includeText) {
  const { window, createManager, vite } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-log-canary-audio-",
    settingsKey: "__logCanarySettings",
    settings: {
      useCleanupModel: true,
      cleanupProvider: "bedrock",
      cleanupMode: "enterprise",
      cleanupDisableThinking: true,
      useDictationAgent: false,
      useDictationTranslation: false,
      preferredLanguage: "en",
      enterpriseSetupMode: "manual",
    },
    mockModules: {
      // The real renderer logger, not the harness's no-op.
      "/utils/logger": 'export { default } from "/utils/logger.ts";',
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__logCanarySettings;
        export const getEffectiveCleanupModel = () => "anthropic.claude-haiku";
        export const selectResolvedLLMConfig = () => ({
          mode: "enterprise", provider: "bedrock", model: "anthropic.claude-haiku"
        });
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
        export const useSettingsStore = { subscribe: () => () => {} };
      `,
      "/dictationAgentInference": `
        export const resolveDictationAgentInference = () => ({
          reachable: false, model: "", displayProvider: "none", config: {}
        });
        export const resolveDictationAgentVisionInference = () => ({
          active: false, model: "", config: {}
        });
      `,
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: false, model: "", displayProvider: "none", config: {}
        });
      `,
      "/stores/cleanupFailureStore": "export const recordCleanupFailure = () => {};",
    },
  });
  Object.assign(window.electronAPI, rendererApi(includeText));
  const { default: logger } = await vite.ssrLoadModule("/utils/logger.ts");
  logger.refreshLogLevel();
  await logger.debug("renderer ready");

  const base = {
    voiceAgentRequested: false,
    translationRequested: false,
    pendingCleanupFailure: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    isReasoningAvailable: async () => true,
  };
  const cleaned = await createManager({
    ...base,
    processWithReasoningModel: async (text) => `${text} (cleaned)`,
  }).processTranscriptionCore(TEXT, "local");
  assert.equal(cleaned, `${TEXT} (cleaned)`);
  const kept = await createManager({
    ...base,
    processWithReasoningModel: async () => {
      throw new Error("Cleanup timed out");
    },
  }).processTranscriptionCore(TEXT, "local");
  assert.equal(kept, TEXT);
}

// Cleanup over HTTP: the request, the model's reply, and a provider error whose
// body echoes the request.
async function rendererReasoning(t, includeText) {
  installBrowserGlobals(t, { window: { electronAPI: rendererApi(includeText) } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-log-canary-reasoning-" });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  const { default: logger } = await vite.ssrLoadModule("/utils/logger.ts");
  t.after(() => reasoningService.destroy());
  logger.refreshLogLevel();
  await logger.debug("renderer ready");

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `${TEXT} (cleaned)` }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ error: { message: "Bad request" }, request: { messages: [TEXT] } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  };
  await reasoningService.processText(TEXT, "some-model", null, {
    lanUrl: "http://127.0.0.1:11434/v1",
  });
  await assert.rejects(
    reasoningService.processText(TEXT, "some-model", null, {
      lanUrl: "http://127.0.0.1:11434/v1",
    })
  );
}

async function driveEverything(t, includeText) {
  await autoLearn(t);
  await autoLearnSuggest(t);
  await textMonitor();
  await whisperServer();
  await localCleanup();
  await rendererDictation(t, includeText);
  await rendererReasoning(t, includeText);
}

// Everything written so far, once the stream has caught up.
async function writtenLogs() {
  for (let i = 0; i < 400 && debugLogger.logStream?.writableLength > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  return fs
    .readdirSync(logsDir)
    .filter((name) => name.startsWith("debug-"))
    .map((name) => fs.readFileSync(path.join(logsDir, name), "utf8"))
    .join("\n");
}

test("with Include dictated text off, no written log holds the dictated text", async (t) => {
  const written = await (async () => {
    await driveEverything(t, false);
    return writtenLogs();
  })();
  // The paths ran and were logged...
  for (const expected of [
    "[AutoLearn] Starting monitoring",
    "[AutoLearn] text-edited event",
    "[AutoLearn] Corrections result",
    "[TextEditMonitor] stdout",
    "CHANGED_B64",
    "whisper-server transcription completed",
    "Using custom dictionary prompt",
    "Failed to parse whisper-server response",
    "whisper-server returned status 500",
    "LOCAL_BRIDGE_INFERENCE",
    "LOCAL_BRIDGE_SUCCESS",
    "TRANSCRIPTION_RECEIVED",
    "REASONING_SUCCESS",
    "REASONING_FAILED",
    "LAN_REQUEST",
    "LAN_RAW_RESPONSE",
    "LAN_API_ERROR_DETAIL",
  ]) {
    assert.ok(written.includes(expected), `logged: ${expected}`);
  }
  // ...and none of them kept the text, plain or base64.
  const leaks = written.split("\n").filter((line) => line.includes(MARKER));
  assert.deepEqual(leaks, [], "the marker never reaches the log");
  assert.equal(written.includes(BASE64), false, "nor its base64");
  assert.equal(written.includes("Dana"), false, "nor any other word of it");
  assert.match(written, /"chars": \d+,\s+"words": \d+/, "only its size");
  // Suggest mode ran, and logged counts only: no word, no replaced text, no app.
  assert.ok(written.includes("[AutoLearn] Suggested"), "the suggestion was logged");
  for (const marker of [LEARNED_MARKER, REPLACED_MARKER, APP_MARKER]) {
    assert.equal(written.includes(marker), false, `${marker} never reaches the log`);
  }
});

test("with Include dictated text on, it appears only as snippets of at most 80 characters", async (t) => {
  process.env.OPENWHISPR_LOG_TEXT = "true";
  debugLogger.refreshLogLevel();
  t.after(() => {
    delete process.env.OPENWHISPR_LOG_TEXT;
    debugLogger.refreshLogLevel();
  });
  const current = path.basename(debugLogger.getLogPath());
  assert.match(current, /-text\.log$/, "a file named for the text");

  await driveEverything(t, true);
  await writtenLogs();
  const text = fs.readFileSync(path.join(logsDir, current), "utf8");
  const lines = text.split("\n").filter((line) => line.includes(MARKER));
  assert.ok(lines.length >= 8, `snippets were logged (${lines.length})`);
  for (const line of lines) {
    const match = /^\s*"text": ("(?:[^"\\]|\\.)*"),?$/.exec(line);
    assert.ok(match, `only inside a snippet: ${line.trim().slice(0, 120)}`);
    assert.ok(Array.from(JSON.parse(match[1])).length <= 80, "at most 80 characters");
  }
  assert.equal(text.includes(BASE64), false, "never the raw base64");
  // Suggest mode: the app is never logged, and the learned and replaced words
  // only inside the edit's own dictated-text snippets, never in what the
  // suggestion or its evidence logs.
  assert.equal(text.includes(APP_MARKER), false, "the app never reaches the log");
  for (const marker of [LEARNED_MARKER, REPLACED_MARKER]) {
    for (const line of text.split("\n").filter((entry) => entry.includes(marker))) {
      assert.match(
        line,
        /^\s*"(?:text)": "/,
        `${marker} only inside a snippet: ${line.trim().slice(0, 120)}`
      );
    }
  }
  // The renderer learned the switch too.
  assert.ok(
    text.split("TRANSCRIPTION_RECEIVED")[1]?.includes(MARKER),
    "the renderer's lines carry snippets"
  );
});
