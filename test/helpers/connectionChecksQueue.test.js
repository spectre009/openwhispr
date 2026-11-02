const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { deferred } = require("./harness/deferred");
const {
  AZURE,
  CORTI,
  DESCRIPTORS: D,
  KEYS,
  createHarness,
  reply,
} = require("./harness/connectionCheckHarness");

// Main's connection-check queue (helpers/connectionChecks.js): cached results
// answer at once while younger than maxAgeMs and still fenced by the
// descriptor's generation and the slot's credential generation; a check whose
// generations changed while it ran is dropped; a key written, copied or
// removed invalidates its results (Reset app data, all of them); one queue
// deduplicates a descriptor already being checked; at most four requests run
// at once; the Cloud switch's gate still applies; and keys, bodies and model
// lists never reach a log, an event or a result. Wired through IPC, the key
// hook is environment.js's onSecretChanged.

const list = (...ids) => ({ data: ids.map((id) => ({ id })) });

test("cache: young results answer at once, older or re-generated ones are checked", async () => {
  let clock = 1_000_000;
  const { checks, check, requests } = createHarness({
    route: () => reply(200, list("gpt-5-mini")),
    now: () => clock,
  });
  await check(D.openai(["gpt-5-mini"]));
  assert.equal(requests.length, 1);

  clock += 9 * 60 * 1000;
  let answer = checks.run({
    descriptors: [D.openai(["gpt-5-mini"])],
    maxAgeMs: 600_000,
    fresh: false,
  });
  assert.equal(answer.results["provider:openai"].credentials, "accepted", "from the cache");
  assert.deepEqual(answer.pending, []);
  assert.equal(requests.length, 1);

  // Fresh (an explicit Check) skips the cache.
  answer = checks.run({ descriptors: [D.openai(["gpt-5-mini"])], maxAgeMs: 600_000, fresh: true });
  assert.deepEqual(answer.pending, ["provider:openai"]);
  await checks.idle();
  assert.equal(requests.length, 2);

  // Older than maxAgeMs: checked again.
  clock += 11 * 60 * 1000;
  answer = checks.run({ descriptors: [D.openai(["gpt-5-mini"])], maxAgeMs: 600_000, fresh: false });
  assert.deepEqual(answer.pending, ["provider:openai"]);
  await checks.idle();
  assert.equal(requests.length, 3);

  // Another generation (a model edit): not the cached answer.
  answer = checks.run({
    descriptors: [D.openai(["gpt-5"], "g2")],
    maxAgeMs: 600_000,
    fresh: false,
  });
  assert.deepEqual(answer.pending, ["provider:openai"]);
  await checks.idle();
  assert.equal(requests.length, 4);
});

test("one queue: a descriptor already being checked isn't checked twice", async () => {
  const gate = deferred();
  const { checks, requests, events } = createHarness({
    route: () => async () => {
      await gate.promise;
      return reply(200, list());
    },
  });
  const first = checks.run({ descriptors: [D.groq()], maxAgeMs: 0, fresh: false });
  const second = checks.run({ descriptors: [D.groq()], maxAgeMs: 0, fresh: true });
  assert.deepEqual(first.pending, ["provider:groq"]);
  assert.deepEqual(second.pending, ["provider:groq"]);
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  await checks.idle();
  assert.equal(requests.length, 1);
  assert.equal(events.filter((event) => event.result).length, 1);
});

test("fencing: a check whose generation changed while it ran is dropped", async () => {
  const gates = [deferred(), deferred()];
  let calls = 0;
  const { checks, events } = createHarness({
    route: () => {
      const gate = gates[calls++];
      return async () => {
        await gate.promise;
        return reply(200, list("gpt-5-mini"));
      };
    },
  });
  checks.run({ descriptors: [D.openai(["gpt-5-mini"], "g1")], maxAgeMs: 0, fresh: false });
  checks.run({ descriptors: [D.openai(["gpt-5"], "g2")], maxAgeMs: 0, fresh: false });
  await new Promise((resolve) => setImmediate(resolve));
  gates[0].resolve();
  gates[1].resolve();
  await checks.idle();
  const answered = events.filter((event) => event.result);
  assert.deepEqual(
    answered.map((event) => event.generation),
    ["g2"],
    "only the generation still shown"
  );
});

test("fencing: a key written while its check ran drops the answer; the next run checks again", async () => {
  const gate = deferred();
  let first = true;
  const { checks, events, requests } = createHarness({
    route: () => {
      if (!first) return reply(200, list());
      first = false;
      return async () => {
        await gate.promise;
        return reply(401, {});
      };
    },
  });
  checks.run({ descriptors: [D.groq()], maxAgeMs: 600_000, fresh: false });
  await new Promise((resolve) => setImmediate(resolve));
  checks.noteSecretsChanged({ names: ["GROQ_API_KEY"] });
  gate.resolve();
  await checks.idle();
  assert.deepEqual(events.at(-1), { id: "provider:groq", generation: "g1", dropped: true });
  const again = checks.run({ descriptors: [D.groq()], maxAgeMs: 600_000, fresh: false });
  assert.deepEqual(again.pending, ["provider:groq"], "nothing cached for the old key");
  await checks.idle();
  assert.equal(requests.length, 2);
  assert.equal(events.at(-1).result.credentials, "accepted");
});

test("invalidation: a key change clears its results (Corti's by either credential); Reset clears all", async () => {
  const { checks, check, events } = createHarness({
    route: (url) =>
      url.includes("corti.app/realms")
        ? reply(200, { access_token: "t", expires_in: 300 })
        : reply(200, list()),
    cortiToken: async (_args, fetchImpl) => {
      const response = await fetchImpl("https://auth.eu.corti.app/realms/base/x", {
        method: "POST",
      });
      if (!response.ok) throw Object.assign(new Error("no"), { status: response.status });
      return "token";
    },
  });
  await check(D.groq());
  await check(D.openai());
  await check(D.cortiStt());
  events.length = 0;

  checks.noteSecretsChanged({ names: ["GROQ_API_KEY"] });
  assert.deepEqual(events, [{ id: "provider:groq", invalidated: true }]);
  checks.noteSecretsChanged({ names: ["CORTI_CLIENT_SECRET"] });
  assert.deepEqual(events.at(-1), { id: "corti:stt", invalidated: true });
  const cached = checks.run({ descriptors: [D.openai()], maxAgeMs: 600_000, fresh: false });
  assert.ok(cached.results["provider:openai"], "another provider's result stays");

  events.length = 0;
  checks.noteSecretsChanged({ names: Object.keys(KEYS), all: true });
  assert.deepEqual(events, [{ id: "provider:openai", invalidated: true }]);
  const after = checks.run({ descriptors: [D.openai()], maxAgeMs: 600_000, fresh: false });
  assert.deepEqual(after.pending, ["provider:openai"]);
  await checks.idle();
});

test("at most four requests at once", async () => {
  let active = 0;
  let peak = 0;
  const gate = deferred();
  const { checks, requests } = createHarness({
    route: () => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return reply(200, list());
    },
  });
  const descriptors = [
    D.openai(),
    D.groq(),
    D.anthropic(),
    D.mistral(),
    D.deepgram(),
    D.xai(),
    D.cortiLlm(),
  ];
  const answer = checks.run({ descriptors, maxAgeMs: 0, fresh: false });
  assert.equal(answer.pending.length, 7);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(active, 4);
  gate.resolve();
  await checks.idle();
  assert.equal(peak, 4);
  assert.equal(requests.length, 7);
});

test("the Cloud switch: an OpenWhispr route isn't contacted while Cloud is off", async (t) => {
  const gate = require("../../src/helpers/openWhisprCloudGate");
  t.after(() => gate.resetCloudGateForTests());
  gate.setCloudDisabled(true);
  const { check, requests } = createHarness({ cloudGate: gate });
  const result = await check(D.endpoint("https://api.openwhispr.com/v1"));
  assert.equal(result.code, "CHECK_CLOUD_DISABLED");
  assert.equal(result.reachable, false);
  assert.equal(requests.length, 0);
  // Other routes aren't Cloud's: the switch isn't an allowlist.
  const groq = await check(D.groq());
  assert.equal(groq.credentials, "accepted");
});

test("privacy canary: keys, bodies and model lists never in logs, events or results", async () => {
  const BODY = "BODY-CANARY-dictated-text";
  const CATALOG = "catalog-model-CANARY";
  const route = (url) => {
    if (url.includes("api.github.com")) return reply(200, { login: BODY });
    if (url.endsWith("/key")) return reply(200, { data: { label: BODY, limit: null } });
    if (url.includes("/api-key")) return reply(200, { name: BODY });
    if (url.includes("corti.app/realms")) return reply(200, { access_token: BODY });
    if (url.includes("/openai/deployments")) {
      return reply(200, { data: [{ id: CATALOG, model: BODY }] });
    }
    if (url.includes("groq")) return reply(401, { error: { message: `${BODY} invalid api key` } });
    return reply(200, { data: [{ id: CATALOG, description: BODY }], models: [{ name: CATALOG }] });
  };
  const tinfoil = async () => reply(200, { data: [{ id: CATALOG, note: BODY }] });
  const copilot = { runtime: { listModels: async () => [{ id: CATALOG }] }, auth: {} };
  const { checks, events, logs } = createHarness({
    route,
    tinfoil,
    copilot,
    cortiToken: require("../../src/helpers/cortiAuth").getCortiToken,
  });
  const descriptors = [
    D.openai(["gpt-5-mini"]),
    D.anthropic(),
    D.gemini(["gemini-2.5-flash"]),
    D.groq(),
    D.openrouter(["openai/gpt-5-mini"]),
    D.mistral(),
    D.xai(),
    D.deepgram(),
    D.assemblyai(),
    D.azureSpeech(),
    D.tinfoil(["llama"]),
    D.cortiLlm(),
    D.cortiStt(`p${Date.now()}`),
    D.custom(["gpt-5-mini"]),
    D.endpoint(),
    D.selfHosted(),
    D.copilot(["claude-haiku-5.5"]),
  ];
  const answer = checks.run({ descriptors, maxAgeMs: 0, fresh: true });
  await checks.idle();
  const seen = JSON.stringify({ answer, events, logs });
  for (const secret of [...Object.values(KEYS), CORTI.clientId, CORTI.clientSecret]) {
    assert.ok(!seen.includes(secret), `${secret} leaked`);
  }
  assert.ok(!seen.includes(BODY), "a body leaked");
  assert.ok(!seen.includes(CATALOG), "a provider's model list leaked");
  assert.ok(!seen.includes(AZURE), "a route was logged");
  assert.equal(events.filter((event) => event.result).length, descriptors.length);
  // Logs: the kind, the code and the HTTP status. Nothing else.
  assert.ok(logs.length >= descriptors.length);
  for (const [, , meta] of logs) {
    assert.deepEqual(Object.keys(meta).sort(), ["code", "httpStatus", "kind"]);
  }
});

test("IPC: connection-checks-run, streamed answers, and environment.js's key hook", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-connection-checks-"));
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userData;
  const originalLoad = Module._load;
  const sent = [];
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => userData },
        session: { fromPartition: () => ({ fetch: async () => reply(200, list()) }) },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    if (request === "./secretCrypto") {
      return {
        isAvailable: () => false,
        encrypt: (value) => Buffer.from(value),
        decrypt: (buffer) => ({ value: buffer.toString(), needsReencrypt: false }),
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: (channel, payload) => sent.push([channel, payload]) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userData, { recursive: true, force: true });
    delete process.env.GROQ_API_KEY;
  });
  for (const id of [
    require.resolve("../../src/helpers/environment"),
    require.resolve("../../src/helpers/connectionChecksIpc"),
  ]) {
    delete require.cache[id];
  }
  const EnvironmentManager = require("../../src/helpers/environment");
  const {
    registerConnectionChecksIpc,
    CHECK_PARTITION,
  } = require("../../src/helpers/connectionChecksIpc");
  assert.equal(CHECK_PARTITION, "ow-connection-checks");

  const environmentManager = new EnvironmentManager();
  environmentManager.saveGroqKey("gsk_CANARY-first");
  const fetches = [];
  const handlers = new Map();
  const checks = registerConnectionChecksIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    environmentManager,
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      return reply(200, list());
    },
  });
  assert.ok(handlers.has("connection-checks-run"));
  const answer = await handlers.get("connection-checks-run")(null, {
    descriptors: [D.groq()],
    maxAgeMs: 600_000,
    fresh: false,
  });
  assert.deepEqual(answer.pending, ["provider:groq"]);
  await checks.idle();
  assert.equal(
    new Headers(fetches[0].init.headers).get("authorization"),
    "Bearer gsk_CANARY-first"
  );
  assert.equal(sent.at(-1)[0], "connection-check-result");
  assert.equal(sent.at(-1)[1].result.credentials, "accepted");

  // Saving the same key again changes nothing; a new key invalidates the result.
  sent.length = 0;
  environmentManager.saveGroqKey("gsk_CANARY-first");
  assert.deepEqual(sent, []);
  environmentManager.saveGroqKey("gsk_CANARY-second");
  assert.deepEqual(sent, [["connection-check-result", { id: "provider:groq", invalidated: true }]]);
  const next = await handlers.get("connection-checks-run")(null, {
    descriptors: [D.groq()],
    maxAgeMs: 600_000,
    fresh: false,
  });
  assert.deepEqual(next.pending, ["provider:groq"], "checked again with the new key");
  await checks.idle();
  assert.equal(
    new Headers(fetches[1].init.headers).get("authorization"),
    "Bearer gsk_CANARY-second"
  );
  assert.ok(!JSON.stringify(sent).includes("CANARY"), "no key in what windows receive");
});
