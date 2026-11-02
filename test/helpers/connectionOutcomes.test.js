const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createConnectionOutcomes,
  registerConnectionOutcomesIpc,
} = require("../../src/helpers/connectionOutcomes.js");

// "Last recorded use", main's one writer: each descriptor keeps its last
// outcome and its last failure; an outcome from before its key changed is
// dropped, and a key change, a Cloud or Copilot sign-out and Reset app data
// clear what was recorded under it; it never throws into a request, and no
// key, body or text reaches its store, its logs or its broadcasts.

const KEY = "gsk_SECRET-groq-OUTCOME";
const BODY = '{"error":{"message":"Incorrect API key provided: gsk_SECRET-groq-OUTCOME"}}';
const PROMPT = "Dear Dr. Ramirez, the biopsy came back clean.";

function memoryStore(initial = []) {
  const rows = new Map(initial.map((row) => [row.descriptorId, row]));
  return {
    rows,
    calls: [],
    load() {
      this.calls.push(["load"]);
      return [...rows.values()];
    },
    save(row) {
      this.calls.push(["save", row.descriptorId]);
      rows.set(row.descriptorId, JSON.parse(JSON.stringify(row)));
    },
    remove(ids) {
      this.calls.push(["remove", ids]);
      for (const id of ids) rows.delete(id);
    },
    clear() {
      this.calls.push(["clear"]);
      rows.clear();
    },
  };
}

function setup({ store = memoryStore(), start = 1_000 } = {}) {
  let clock = start;
  const logs = [];
  const emitted = [];
  const logger = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      (message, meta, scope) => logs.push({ level, message, meta, scope }),
    ])
  );
  const outcomes = createConnectionOutcomes({
    store,
    logger,
    emit: (payload) => emitted.push(payload),
    now: () => clock,
  });
  return {
    outcomes,
    store,
    logs,
    emitted,
    tick: (ms = 10) => (clock += ms),
    now: () => clock,
  };
}

const groq = (fields = {}) => ({
  descriptorId: "provider:groq",
  feature: "cleanup",
  ok: true,
  code: "OK",
  startedAt: 900,
  ...fields,
});

test("records each descriptor's last outcome and keeps its last failure", () => {
  const { outcomes, store, emitted, tick } = setup();
  assert.equal(outcomes.recordConnectionOutcome(groq()), true);
  assert.deepEqual(outcomes.list(), {
    "provider:groq": {
      last: { feature: "cleanup", ok: true, code: "OK", at: 1000 },
      lastFailure: null,
    },
  });
  tick();
  outcomes.recordConnectionOutcome(
    groq({ feature: "styles", ok: false, code: "PROVIDER_RATE_LIMITED" })
  );
  tick();
  outcomes.recordConnectionOutcome(groq({ feature: "cleanup" }));
  const entry = outcomes.list()["provider:groq"];
  assert.deepEqual(entry.last, { feature: "cleanup", ok: true, code: "OK", at: 1020 });
  assert.deepEqual(entry.lastFailure, {
    feature: "styles",
    ok: false,
    code: "PROVIDER_RATE_LIMITED",
    at: 1010,
  });
  // Stored whole, under the descriptor's own fence slot.
  assert.deepEqual(store.rows.get("provider:groq"), {
    descriptorId: "provider:groq",
    slot: "GROQ_API_KEY",
    last: entry.last,
    lastFailure: entry.lastFailure,
  });
  assert.equal(emitted.length, 3, "every change is broadcast");
  assert.deepEqual(emitted.at(-1), { outcomes: outcomes.list() });
});

test("refuses anything that isn't an outcome stage A could show", () => {
  const { outcomes, store } = setup();
  const refused = [
    null,
    "provider:groq",
    groq({ descriptorId: "provider:nope" }),
    groq({ descriptorId: "https://api.groq.com" }),
    groq({ descriptorId: "endpoint:0a1b2c3d" }),
    groq({ descriptorId: "endpoint:0a1b2c3d", slot: "GROQ_API_KEY" }),
    groq({ feature: "assistantVision" }),
    groq({ feature: "everything" }),
    groq({ ok: "yes" }),
    groq({ ok: false, code: "OK" }),
    groq({ ok: false, code: KEY }),
    groq({ ok: false, code: "provider_auth_failed" }),
    groq({ ok: false, code: undefined }),
  ];
  for (const input of refused) {
    assert.equal(outcomes.recordConnectionOutcome(input), false, JSON.stringify(input));
  }
  assert.deepEqual(outcomes.list(), {});
  assert.equal(store.rows.size, 0);
  // A feature endpoint names its slot; an OK ignores whatever code it came with.
  assert.equal(
    outcomes.recordConnectionOutcome(
      groq({
        descriptorId: "endpoint:0a1b2c3d",
        slot: "CUSTOM_CLEANUP_API_KEY",
        code: "WHATEVER",
      })
    ),
    true
  );
  assert.equal(outcomes.list()["endpoint:0a1b2c3d"].last.code, "OK");
  assert.equal(store.rows.get("endpoint:0a1b2c3d").slot, "CUSTOM_CLEANUP_API_KEY");
});

test("fenced like the checks: an outcome from before its key changed is dropped", () => {
  const { outcomes, logs, tick, now } = setup();
  const startedAt = now();
  tick();
  outcomes.noteSecretsChanged({ names: ["GROQ_API_KEY"] });
  tick();
  assert.equal(
    outcomes.recordConnectionOutcome(groq({ ok: false, code: "PROVIDER_AUTH_FAILED", startedAt })),
    false,
    "the old key's 401 says nothing about the new one"
  );
  assert.deepEqual(outcomes.list(), {});
  assert.ok(logs.some((entry) => entry.message === "Connection outcome dropped"));
  // A request that started after the change counts.
  assert.equal(outcomes.recordConnectionOutcome(groq({ startedAt: now() - 5 })), true);
  // Another slot's change doesn't touch it.
  const geminiStart = now();
  tick();
  outcomes.noteSecretsChanged({ names: ["OPENAI_API_KEY"] });
  assert.equal(
    outcomes.recordConnectionOutcome(
      groq({ descriptorId: "provider:gemini", startedAt: geminiStart })
    ),
    true
  );
  // Slots read from several secrets: Corti's client credentials, Cleanup's old name.
  const cortiStart = now();
  tick();
  outcomes.noteSecretsChanged({ names: ["CORTI_CLIENT_SECRET"] });
  assert.equal(
    outcomes.recordConnectionOutcome({
      descriptorId: "corti:stt",
      feature: "recognition",
      ok: true,
      startedAt: cortiStart,
    }),
    false
  );
  const endpointStart = now();
  tick();
  outcomes.noteSecretsChanged({ names: ["CUSTOM_REASONING_API_KEY"] });
  assert.equal(
    outcomes.recordConnectionOutcome({
      descriptorId: "endpoint:0a1b2c3d",
      slot: "CUSTOM_CLEANUP_API_KEY",
      feature: "cleanup",
      ok: true,
      startedAt: endpointStart,
    }),
    false
  );
  // Cloud: a sign-out in between.
  const cloudStart = now();
  tick();
  outcomes.noteCloudSignedOut();
  assert.equal(
    outcomes.recordConnectionOutcome({
      descriptorId: "cloud",
      feature: "recognition",
      ok: true,
      startedAt: cloudStart,
    }),
    false
  );
  // A start in the future is read as now; one without a start too.
  assert.equal(
    outcomes.recordConnectionOutcome(groq({ startedAt: now() + 60_000, feature: "translation" })),
    true
  );
  assert.equal(outcomes.list()["provider:groq"].last.at, now());
});

test("cleared when the key is removed or replaced, at sign-out and with Reset app data", () => {
  const { outcomes, store, emitted } = setup();
  const record = (descriptorId, extra = {}) =>
    outcomes.recordConnectionOutcome({
      descriptorId,
      feature: "chat",
      ok: false,
      code: "PROVIDER_AUTH_FAILED",
      startedAt: 999,
      ...extra,
    });
  record("provider:groq");
  record("provider:gemini");
  record("copilot", { feature: "cleanup" });
  record("cloud");
  record("corti:stt", { feature: "recognition" });
  record("endpoint:0a1b2c3d", { slot: "CUSTOM_CLEANUP_API_KEY" });
  record("selfHosted:0a1b2c3d");
  assert.equal(store.rows.size, 7);

  outcomes.noteSecretsChanged({ names: ["GROQ_API_KEY"] });
  assert.ok(!("provider:groq" in outcomes.list()), "replaced or removed: gone");
  assert.ok("provider:gemini" in outcomes.list(), "another key's stays");
  assert.ok(!store.rows.has("provider:groq"));

  // Copilot's sign-out is its token's removal.
  outcomes.noteSecretsChanged({ names: ["GITHUB_COPILOT_TOKEN"] });
  assert.ok(!("copilot" in outcomes.list()));
  outcomes.noteSecretsChanged({ names: ["CORTI_CLIENT_ID"] });
  assert.ok(!("corti:stt" in outcomes.list()));
  outcomes.noteSecretsChanged({ names: ["CUSTOM_REASONING_API_KEY"] });
  assert.ok(!("endpoint:0a1b2c3d" in outcomes.list()));
  // A self-hosted server has no slot: key changes never touch it.
  assert.ok("selfHosted:0a1b2c3d" in outcomes.list());

  outcomes.noteCloudSignedOut();
  assert.ok(!("cloud" in outcomes.list()));
  assert.ok(!store.rows.has("cloud"));

  const before = emitted.length;
  outcomes.noteSecretsChanged({ names: ["OPENAI_API_KEY"] });
  assert.equal(emitted.length, before, "nothing recorded under it: nothing to tell");

  outcomes.noteSecretsChanged({ names: ["GROQ_API_KEY", "GEMINI_API_KEY"], all: true });
  assert.deepEqual(outcomes.list(), {});
  assert.equal(store.rows.size, 0);
  assert.deepEqual(store.calls.at(-1), ["clear"]);
  // After Reset, Cloud's earlier requests are dropped too.
  assert.equal(record("cloud", { startedAt: 999 }), false);
});

test("loads what History's database kept, and never throws when it can't", () => {
  const kept = memoryStore([
    {
      descriptorId: "provider:azure-speech",
      slot: "AZURE_SPEECH_API_KEY",
      last: { feature: "recognition", ok: true, code: "OK", at: 500 },
      lastFailure: { feature: "fileTranscription", ok: false, code: "PROVIDER_TIMEOUT", at: 400 },
    },
    // Anything malformed is skipped.
    { descriptorId: "provider:nope", slot: null, last: { feature: "cleanup", ok: true, at: 1 } },
    { descriptorId: "provider:groq", slot: null, last: null },
  ]);
  const { outcomes } = setup({ store: kept });
  assert.deepEqual(Object.keys(outcomes.list()), ["provider:azure-speech"]);
  assert.equal(outcomes.list()["provider:azure-speech"].lastFailure.code, "PROVIDER_TIMEOUT");

  const broken = {
    load() {
      throw Object.assign(new Error("Database not initialized"), { code: "DB_CLOSED" });
    },
    save() {
      throw new Error(`disk full ${KEY}`);
    },
    remove() {
      throw new Error("closed");
    },
    clear() {
      throw new Error("closed");
    },
  };
  const failing = setup({ store: broken });
  assert.equal(failing.outcomes.recordConnectionOutcome(groq()), true, "kept for the session");
  assert.ok(failing.outcomes.list()["provider:groq"]);
  assert.doesNotThrow(() => failing.outcomes.noteSecretsChanged({ names: ["GROQ_API_KEY"] }));
  assert.doesNotThrow(() => failing.outcomes.noteSecretsChanged({ all: true }));
  assert.doesNotThrow(() => failing.outcomes.noteCloudSignedOut());
  const warned = failing.logs.filter((entry) => entry.level === "warn");
  assert.ok(warned.length >= 3);
  assert.ok(!JSON.stringify(warned).includes(KEY), "a failure's message isn't logged");

  // An emit that throws (a window going away) costs nothing either.
  const throwing = createConnectionOutcomes({
    emit: () => {
      throw new Error("gone");
    },
  });
  assert.equal(throwing.recordConnectionOutcome(groq()), true);
  assert.equal(
    throwing.recordConnectionOutcome({
      get descriptorId() {
        throw new Error("x");
      },
    }),
    false
  );
});

test("privacy canary: no key, body, prompt or text in the store, the logs or the broadcasts", () => {
  const { outcomes, store, logs, emitted } = setup();
  outcomes.recordConnectionOutcome({
    ...groq({ ok: false, code: "PROVIDER_AUTH_FAILED" }),
    apiKey: KEY,
    body: BODY,
    prompt: PROMPT,
    text: PROMPT,
    headers: { Authorization: `Bearer ${KEY}` },
    error: new Error(BODY),
  });
  outcomes.recordConnectionOutcome(groq({ feature: "chat" }));
  outcomes.noteSecretsChanged({ names: ["GEMINI_API_KEY"] });
  const everything = JSON.stringify({
    rows: [...store.rows.values()],
    logs,
    emitted,
    list: outcomes.list(),
  });
  for (const secret of [KEY, "SECRET", "Incorrect API key", "Ramirez", "biopsy", "Bearer"]) {
    assert.ok(!everything.includes(secret), `${secret} leaked`);
  }
  // Logs carry the feature and the code only.
  for (const entry of logs) {
    assert.equal(entry.scope, "connection-outcomes");
    for (const key of Object.keys(entry.meta || {})) {
      assert.ok(["feature", "ok", "code", "operation"].includes(key), key);
    }
  }
});

test("IPC: get, a fire-and-forget record, onSecretChanged wired, changes broadcast", async () => {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  };
  let secretListener = null;
  const emitted = [];
  const database = {
    rows: [],
    getConnectionOutcomes() {
      return this.rows;
    },
    saveConnectionOutcome(row) {
      this.rows = [...this.rows.filter((r) => r.descriptorId !== row.descriptorId), row];
    },
    deleteConnectionOutcomes(ids) {
      this.rows = this.rows.filter((row) => !ids.includes(row.descriptorId));
    },
    clearConnectionOutcomes() {
      this.rows = [];
    },
  };
  const outcomes = registerConnectionOutcomesIpc({
    ipcMain,
    getDatabase: () => database,
    onSecretChanged: (listener) => {
      secretListener = listener;
    },
    emit: (payload) => emitted.push(payload),
  });
  assert.deepEqual(await handlers.get("connection-outcomes-get")(), { outcomes: {} });
  const result = listeners.get("connection-outcome-record")(
    {},
    { descriptorId: "copilot", feature: "translation", ok: true, startedAt: Date.now() }
  );
  assert.equal(result, undefined, "a renderer is never answered");
  const { outcomes: listed } = await handlers.get("connection-outcomes-get")();
  assert.equal(listed.copilot.last.feature, "translation");
  assert.equal(database.rows.length, 1);
  assert.equal(emitted.length, 1);
  secretListener({ names: ["GITHUB_COPILOT_TOKEN"] });
  assert.deepEqual(outcomes.list(), {});
  assert.equal(database.rows.length, 0);
  assert.deepEqual(emitted.at(-1), { outcomes: {} });
  // A malformed report is dropped without a word.
  assert.doesNotThrow(() => listeners.get("connection-outcome-record")({}, "garbage"));
});
