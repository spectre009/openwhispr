const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { deferred } = require("./harness/deferred");

// Main's side of the custom connection (helpers/customConnectionIpc.js): only
// the fixed key slots are accepted; copies into and out of them are awaited,
// serialized and announced by setting name; comparisons answer booleans; and
// Check connection stays behind the Cloud gate, reports a rejected key apart
// from an unreachable endpoint, and never fails over deployment discovery.
// Wired into ipcHandlers, a copy is announced to every window, the sender too.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const ipcChannels = new Map();
const notifications = [];
const windows = [1, 2, 3].map((id) => ({
  isDestroyed: () => id === 3,
  webContents: { id, send: (...args) => notifications.push([id, ...args]) },
}));

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => ipcChannels.set(channel, handler),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: { getAllWindows: () => windows, fromWebContents: () => windows[0] },
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
};

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

// ipcHandlers' own modules are inert here, except the one under test.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (
    parent?.filename === handlersModulePath &&
    request !== "./customConnectionIpc" &&
    (request.startsWith("./") || request.startsWith("../"))
  ) {
    return anything();
  }
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => {
  Module._load = originalLoad;
});

const { BYOK_API_KEYS } = require("../../src/config/secretKeys");
const {
  CUSTOM_CONNECTION_SLOTS,
  CUSTOM_CONNECTION_STORE_KEY,
} = require("../../src/config/customConnection.js");
const {
  SLOT_GETTERS,
  createCustomConnectionHandlers,
} = require("../../src/helpers/customConnectionIpc");
const cloudGate = require("../../src/helpers/openWhisprCloudGate");

const CONNECTION = "CUSTOM_CONNECTION_API_KEY";
const STT = "CUSTOM_TRANSCRIPTION_API_KEY";
const CLEANUP = "CUSTOM_CLEANUP_API_KEY";
const CHAT = "CHAT_AGENT_CUSTOM_API_KEY";

/** Secrets by env name, read through the real accessor names and written like persistSecret. */
function fakeEnvironment(initial = {}, { persist } = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  const read = (name) => values.get(name) || "";
  const environmentManager = {
    getCustomConnectionKey: () => read(CONNECTION),
    getCustomTranscriptionKey: () => read(STT),
    getCleanupCustomKey: () => read(CLEANUP),
    saveCustomTranscriptionKey: (key) => {
      values.set(STT, key);
      return { success: true };
    },
    async persistSecret(name, value) {
      writes.push(name);
      await (persist ? persist(name) : Promise.resolve());
      if (value) values.set(name, value);
      else values.delete(name);
      return { success: true };
    },
  };
  for (const entry of BYOK_API_KEYS) environmentManager[entry.get] = () => read(entry.env);
  return { environmentManager, values, writes, read };
}

function setup(initial, options = {}) {
  const env = fakeEnvironment(initial, options);
  const announced = [];
  const handlers = createCustomConnectionHandlers({
    environmentManager: env.environmentManager,
    onKeysChanged: (storeKeys) => announced.push(storeKeys),
    ...options.deps,
  });
  return { ...env, announced, handlers };
}

test("the slots are the custom-endpoint keys the requests read, with their store fields", () => {
  const perScope = BYOK_API_KEYS.filter((entry) => entry.base.endsWith("-custom"));
  assert.deepEqual(
    Object.keys(CUSTOM_CONNECTION_SLOTS).sort(),
    [STT, CLEANUP, ...perScope.map((entry) => entry.env)].sort()
  );
  assert.deepEqual(Object.keys(SLOT_GETTERS).sort(), Object.keys(CUSTOM_CONNECTION_SLOTS).sort());
  for (const entry of perScope) {
    assert.equal(CUSTOM_CONNECTION_SLOTS[entry.env], entry.storeKey, entry.env);
    assert.equal(SLOT_GETTERS[entry.env], entry.get, entry.env);
  }
  assert.equal(CUSTOM_CONNECTION_SLOTS[STT], "customTranscriptionApiKey");
  assert.equal(CUSTOM_CONNECTION_SLOTS[CLEANUP], "cleanupCustomApiKey");
});

test("unknown slots are refused before anything is read or written", async () => {
  const { handlers, writes, announced, values } = setup({
    [CONNECTION]: "conn-SECRET",
    OPENAI_API_KEY: "sk-openai-SECRET",
  });
  const refusals = [
    () => handlers.copyKey({ fromSlot: "OPENAI_API_KEY" }),
    () => handlers.copyKey({ fromSlot: "GITHUB_COPILOT_TOKEN" }),
    () => handlers.copyKey({}),
    () => handlers.saveKey({ key: "new-SECRET", applyTo: [CHAT, "OPENAI_API_KEY"] }),
    () => handlers.saveKey({ key: "new-SECRET", applyTo: "CHAT_AGENT_CUSTOM_API_KEY" }),
    () => handlers.applyKey({ slots: [CONNECTION] }),
    () => handlers.applyKey({ slots: ["__proto__"] }),
    () => handlers.applyKey({}),
    () => handlers.compare({ slots: ["toString"] }),
    () => handlers.check({ endpoint: "https://lb.openai.azure.com", fromSlot: "OPENAI_API_KEY" }),
  ];
  for (const refuse of refusals) {
    await assert.rejects(refuse, (error) => {
      assert.ok(error instanceof TypeError);
      assert.doesNotMatch(error.message, /SECRET|OPENAI_API_KEY|COPILOT/);
      return true;
    });
  }
  await assert.rejects(() => handlers.saveKey({ key: "   ", applyTo: [] }), TypeError);
  await assert.rejects(() => handlers.saveKey({ applyTo: [] }), TypeError);
  assert.deepEqual(writes, []);
  assert.deepEqual(announced, []);
  assert.equal(values.get(CONNECTION), "conn-SECRET");
  assert.equal(values.get("OPENAI_API_KEY"), "sk-openai-SECRET");
});

test("copy, save and apply write durably, then announce what changed", async () => {
  const { handlers, values, writes, announced } = setup({
    [STT]: "stt-SECRET",
    [CHAT]: "chat-SECRET",
  });

  // Save as connection: the connection takes Recognition's key.
  assert.deepEqual(await handlers.copyKey({ fromSlot: STT }), { success: true });
  assert.equal(values.get(CONNECTION), "stt-SECRET");
  assert.deepEqual(announced, [[CUSTOM_CONNECTION_STORE_KEY]]);
  // The same value again writes nothing and announces nothing.
  await handlers.copyKey({ fromSlot: STT });
  assert.deepEqual(writes, [CONNECTION]);
  assert.equal(announced.length, 1);

  // Replace key: the connection first, then each slot, one announcement.
  announced.length = 0;
  writes.length = 0;
  await handlers.saveKey({ key: " new-SECRET ", applyTo: [CHAT, STT, CHAT] });
  assert.deepEqual(writes, [CONNECTION, CHAT, STT]);
  for (const name of [CONNECTION, CHAT, STT]) assert.equal(values.get(name), "new-SECRET", name);
  assert.deepEqual(announced, [
    [CUSTOM_CONNECTION_STORE_KEY, "chatAgentCustomApiKey", "customTranscriptionApiKey"],
  ]);

  // Update on a mismatched chip: the connection's key into that slot only.
  announced.length = 0;
  await handlers.applyKey({ slots: [CLEANUP] });
  assert.equal(values.get(CLEANUP), "new-SECRET");
  assert.deepEqual(announced, [["cleanupCustomApiKey"]]);

  // Remove: the connection's key goes; the features keep their copies.
  announced.length = 0;
  await handlers.deleteKey();
  assert.equal(values.has(CONNECTION), false);
  assert.equal(values.get(CHAT), "new-SECRET");
  assert.deepEqual(announced, [[CUSTOM_CONNECTION_STORE_KEY]]);
  await assert.rejects(() => handlers.applyKey({ slots: [CHAT] }), /no key/);
});

test("nothing is announced before the write is on disk", async () => {
  const gate = deferred();
  const { handlers, announced } = setup({}, { persist: () => gate.promise });
  const saving = handlers.saveKey({ key: "k-SECRET", applyTo: [CHAT] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(announced, [], "still writing");
  gate.resolve();
  await saving;
  assert.deepEqual(announced, [[CUSTOM_CONNECTION_STORE_KEY, "chatAgentCustomApiKey"]]);
});

test("a failed write still announces what it already changed, and rejects", async () => {
  const { handlers, announced, values } = setup(
    {},
    {
      persist: async (name) => {
        if (name === STT) throw new Error("disk full");
      },
    }
  );
  await assert.rejects(() => handlers.saveKey({ key: "k-SECRET", applyTo: [CHAT, STT] }));
  assert.equal(values.get(CHAT), "k-SECRET");
  assert.equal(values.has(STT), false);
  assert.deepEqual(announced, [[CUSTOM_CONNECTION_STORE_KEY, "chatAgentCustomApiKey"]]);
});

test("compare answers booleans only, after any write in flight", async () => {
  const gate = deferred();
  let slow = true;
  const { handlers } = setup(
    { [CONNECTION]: "k-SECRET", [CHAT]: "k-SECRET", [STT]: "other-SECRET" },
    { persist: () => (slow ? gate.promise : Promise.resolve()) }
  );
  const result = await handlers.compare({ slots: [CHAT, STT, CLEANUP] });
  assert.deepEqual(result, { [CHAT]: true, [STT]: false, [CLEANUP]: false });
  assert.ok(Object.values(result).every((value) => typeof value === "boolean"));
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);

  // A comparison asked during a save waits for it, and sees the new key.
  const saving = handlers.saveKey({ key: "k2-SECRET", applyTo: [STT] });
  const comparing = handlers.compare({ slots: [CHAT, STT] });
  gate.resolve();
  slow = false;
  await saving;
  assert.deepEqual(await comparing, { [CHAT]: false, [STT]: true });

  // With no connection key nothing matches, not even an empty slot.
  const empty = setup({});
  assert.deepEqual(await empty.handlers.compare({ slots: [CLEANUP] }), { [CLEANUP]: false });
});

// ── Check connection ────────────────────────────────────────────────────────

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    const respond = responses(url, init);
    if (respond instanceof Error) throw respond;
    return respond;
  };
  return { calls, fetchImpl };
}

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const AZURE = "https://lb.openai.azure.com";
const DEPLOYMENTS = `${AZURE}/openai/deployments?api-version=2022-12-01`;

test("check: Azure reachable, key accepted, deployments listed", async () => {
  const { calls, fetchImpl } = fakeFetch((url) =>
    url === DEPLOYMENTS
      ? response(200, {
          data: [
            { id: "gpt-4o-transcribe", model: "gpt-4o-transcribe" },
            { id: "chat", model: "gpt-5-mini" },
            { id: 7 },
          ],
        })
      : response(200, { data: [] })
  );
  const { handlers } = setup({ [CONNECTION]: "k-SECRET" }, { deps: { fetchImpl } });
  const result = await handlers.check({ endpoint: `${AZURE}/openai/v1/` });
  assert.deepEqual(result, {
    status: "ok",
    discovery: "listed",
    deployments: [
      { id: "gpt-4o-transcribe", model: "gpt-4o-transcribe" },
      { id: "chat", model: "gpt-5-mini" },
    ],
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${AZURE}/openai/v1/models`, DEPLOYMENTS]
  );
  assert.equal(calls[0].headers.Authorization, "Bearer k-SECRET");
  assert.equal(calls[1].headers["api-key"], "k-SECRET");
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test("check: discovery that fails is 'unavailable', never a broken connection", async () => {
  const outcomes = [
    response(404, {}),
    response(401, {}),
    new Error("socket hang up"),
    response(200, { value: [] }),
    { ok: true, status: 200, json: async () => Promise.reject(new SyntaxError("bad json")) },
  ];
  for (const outcome of outcomes) {
    const { fetchImpl } = fakeFetch((url) => (url === DEPLOYMENTS ? outcome : response(200, {})));
    const { handlers } = setup({ [CONNECTION]: "k-SECRET" }, { deps: { fetchImpl } });
    assert.deepEqual(await handlers.check({ endpoint: AZURE }), {
      status: "ok",
      discovery: "unavailable",
    });
  }
});

test("check: a rejected key, an error status and an unreachable endpoint", async () => {
  const cases = [
    [response(401, {}), { status: "auth", httpStatus: 401, discovery: "unavailable" }],
    [response(403, {}), { status: "auth", httpStatus: 403, discovery: "unavailable" }],
    [response(500, {}), { status: "network", httpStatus: 500, discovery: "unavailable" }],
    [response(404, {}), { status: "network", httpStatus: 404, discovery: "unavailable" }],
    [new TypeError("fetch failed"), { status: "network", discovery: "unavailable" }],
  ];
  for (const [outcome, expected] of cases) {
    const { calls, fetchImpl } = fakeFetch(() => outcome);
    const { handlers } = setup({ [CONNECTION]: "k-SECRET" }, { deps: { fetchImpl } });
    assert.deepEqual(await handlers.check({ endpoint: AZURE }), expected);
    assert.equal(calls.length, 1, "no discovery after a failure");
  }

  // A request that never answers times out as unreachable.
  const hanging = async (_url, init) =>
    new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(new Error("aborted")))
    );
  const { handlers } = setup({}, { deps: { fetchImpl: hanging, timeoutMs: 10 } });
  assert.deepEqual(await handlers.check({ endpoint: "https://gw.example.test/v1" }), {
    status: "network",
    discovery: "unavailable",
  });
});

test("check: an OpenAI-compatible base is probed once; the key comes from where it's asked", async () => {
  const { calls, fetchImpl } = fakeFetch(() => response(200, {}));
  const { handlers } = setup(
    { [CONNECTION]: "conn-SECRET", [STT]: "stt-SECRET" },
    { deps: { fetchImpl } }
  );
  assert.deepEqual(await handlers.check({ endpoint: "https://gw.example.test/v1/" }), {
    status: "ok",
    discovery: "unavailable",
  });
  await handlers.check({ endpoint: "https://gw.example.test/v1", fromSlot: STT });
  await handlers.check({ endpoint: "https://gw.example.test/v1", key: " typed-SECRET " });
  assert.deepEqual(
    calls.map((call) => [call.url, call.headers.Authorization]),
    [
      ["https://gw.example.test/v1/models", "Bearer conn-SECRET"],
      ["https://gw.example.test/v1/models", "Bearer stt-SECRET"],
      ["https://gw.example.test/v1/models", "Bearer typed-SECRET"],
    ]
  );
  // No key at all: no Authorization header.
  const keyless = fakeFetch(() => response(200, {}));
  await setup({}, { deps: { fetchImpl: keyless.fetchImpl } }).handlers.check({
    endpoint: "http://localhost:11434/v1",
  });
  assert.equal(keyless.calls[0].headers.Authorization, undefined);
});

test("check: an endpoint it can't use, or OpenWhispr's own with Cloud off, sends nothing", async (t) => {
  t.after(() => cloudGate.resetCloudGateForTests());
  const { calls, fetchImpl } = fakeFetch(() => response(200, {}));
  const { handlers } = setup({ [CONNECTION]: "k-SECRET" }, { deps: { fetchImpl } });
  for (const endpoint of ["", "https://lb.services.ai.azure.com/api/projects/x", "ftp://x"]) {
    assert.deepEqual(await handlers.check({ endpoint }), {
      status: "invalid",
      discovery: "unavailable",
    });
  }
  cloudGate.setCloudDisabled(true);
  assert.deepEqual(await handlers.check({ endpoint: "https://api.openwhispr.com/v1" }), {
    status: "blocked",
    discovery: "unavailable",
  });
  // Cloud off doesn't stop the user's own endpoint.
  assert.equal((await handlers.check({ endpoint: "https://gw.example.test/v1" })).status, "ok");
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://gw.example.test/v1/models"]
  );
});

// ── Wired into ipcHandlers ──────────────────────────────────────────────────

test("a copy main makes is announced to every window, the sender too", async () => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const { environmentManager, values } = fakeEnvironment({ [STT]: "stt-SECRET" });
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(
      { environmentManager },
      { get: (value, property) => (property in value ? value[property] : anything()) }
    )
  );
  const sender = { sender: windows[0].webContents };
  const invoke = (channel, ...args) => ipcChannels.get(channel)(sender, ...args);

  for (const channel of [
    "get-custom-connection-key",
    "custom-connection-copy-key",
    "custom-connection-save-key",
    "custom-connection-apply-key",
    "custom-connection-compare",
    "custom-connection-delete-key",
    "custom-connection-check",
  ]) {
    assert.equal(typeof ipcChannels.get(channel), "function", channel);
  }
  assert.equal(ipcChannels.has("save-custom-connection-key"), false, "no plain renderer save");

  notifications.length = 0;
  await invoke("custom-connection-save-key", { key: "new-SECRET", applyTo: [STT] });
  assert.deepEqual(notifications, [
    [1, "api-key-updated", CUSTOM_CONNECTION_STORE_KEY],
    [1, "api-key-updated", "customTranscriptionApiKey"],
    [2, "api-key-updated", CUSTOM_CONNECTION_STORE_KEY],
    [2, "api-key-updated", "customTranscriptionApiKey"],
  ]);
  assert.equal(values.get(STT), "new-SECRET");
  assert.equal(await invoke("get-custom-connection-key"), "new-SECRET");
  assert.deepEqual(await invoke("custom-connection-compare", { slots: [STT] }), { [STT]: true });

  // A renderer's own save still skips its sender, whose field holds the new value.
  notifications.length = 0;
  invoke("save-custom-transcription-key", "typed-SECRET");
  assert.deepEqual(notifications, [[2, "api-key-updated", "customTranscriptionApiKey"]]);
});
