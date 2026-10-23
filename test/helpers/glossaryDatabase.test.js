const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Loads DatabaseManager behind the shared electron stub first, so the
// database module keeps that stub's userData path.
const { createDb } = require("./harness/db.js");
const { getUserDataDir } = require("./harness/electronStub.js");
const DatabaseManager = require("../../src/helpers/database.js");
const {
  SEED_RULES,
  glossaryLearnExclusions,
  normalizeGlossaryRuleInput,
} = require("../../src/helpers/glossaryRules.js");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const handlers = new Map();
const broadcasts = [];

// ipcHandlers needs ipcMain and friends; its broadcasts are recorded.
const previousLoad = Module._load;
Module._load = function loadWithIpcStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => getUserDataDir(),
        getName: () => "test",
        getVersion: () => "0.0.0",
        getAppPath: () => process.cwd(),
        isPackaged: false,
        isReady: () => false,
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
    };
  }
  if (request === "./windowBroadcast" && parent?.filename === handlersModulePath) {
    return {
      broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
    };
  }
  return previousLoad.call(this, request, parent, isMain);
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

const fakeTarget = { sessionId: "test-session", databaseManager: null };
const fakeThis = new Proxy(fakeTarget, {
  get: (target, property) => (property in target ? target[property] : anything()),
});
let IPCHandlersCtor = null;

// Registers the real handler closures once, against a `this` whose database
// each test points at its own DatabaseManager.
function ipcFor(db) {
  if (!IPCHandlersCtor) {
    delete require.cache[handlersModulePath];
    const IPCHandlers = require(handlersModulePath);
    IPCHandlersCtor = IPCHandlers.default || IPCHandlers;
    IPCHandlersCtor.prototype.setupHandlers.call(fakeThis);
  }
  fakeTarget.databaseManager = db;
  broadcasts.length = 0;
  return (channel, ...args) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} must be registered`);
    return handler({ sender: {} }, ...args);
  };
}

const seedShape = () => normalizeGlossaryRuleInput(SEED_RULES[0]);

test("first run seeds exactly one Little Buddy rule", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { revision, rules } = db.getGlossaryRules();
  assert.equal(revision, 1);
  assert.equal(rules.length, 1);
  const [rule] = rules;
  assert.equal(typeof rule.id, "string");
  assert.ok(rule.id.length > 0);
  assert.equal(rule.canonical, "Little Buddy");
  assert.equal(rule.enabled, true);
  assert.equal(rule.revision, 1);
  assert.deepEqual(rule.spellings, [
    { text: "littlebuddy", scope: "anywhere" },
    { text: "everybody", scope: "start" },
    { text: "every body", scope: "start" },
    { text: "buddy", scope: "start" },
    { text: "buddies", scope: "start" },
    { text: "little buddies", scope: "start" },
  ]);
  assert.deepEqual(rule.apps, ["github.exe", "Code.exe", "WindowsTerminal.exe", "Obsidian.exe"]);
  assert.deepEqual(
    { ...rule, id: undefined, revision: undefined },
    {
      ...rule,
      ...seedShape(),
      id: undefined,
      revision: undefined,
    }
  );
});

test("table creation is idempotent and the seed never comes back", (t) => {
  const db = createDb(t);
  if (!db) return;
  db._initGlossaryRules();
  db._initGlossaryRules();
  assert.equal(db.getGlossaryRules().rules.length, 1, "re-running the migration must not reseed");

  const [seed] = db.getGlossaryRules().rules;
  assert.equal(db.deleteGlossaryRule(seed.id).deleted, true);
  db._initGlossaryRules();
  assert.deepEqual(db.getGlossaryRules().rules, []);

  // A second app launch on the same database file.
  const reopened = new DatabaseManager();
  try {
    assert.deepEqual(reopened.getGlossaryRules().rules, []);
    assert.equal(reopened.getGlossaryRules().revision, db.getGlossaryRules().revision);
  } finally {
    reopened.db.close();
  }
});

test("every change bumps the rule's revision and the set's", (t) => {
  const db = createDb(t);
  if (!db) return;
  const start = db.getGlossaryRules().revision;

  const created = db.saveGlossaryRule({
    canonical: "Gizmo Labs",
    spellings: [{ text: "gizmolabs", scope: "anywhere" }],
    apps: [],
    enabled: true,
  });
  assert.equal(created.rule.revision, 1);
  assert.equal(created.snapshot.revision, start + 1);
  assert.equal(created.snapshot.rules.length, 2);
  assert.equal(created.snapshot.rules.at(-1).id, created.rule.id, "new rules go last");

  const edited = db.saveGlossaryRule({ ...created.rule, canonical: "Gizmo  Labs Inc" });
  assert.equal(edited.rule.id, created.rule.id);
  assert.equal(edited.rule.canonical, "Gizmo Labs Inc");
  assert.equal(edited.rule.revision, 2);
  assert.equal(edited.snapshot.revision, start + 2);

  const disabled = db.saveGlossaryRule({ ...edited.rule, enabled: false });
  assert.equal(disabled.rule.enabled, false);
  assert.equal(disabled.rule.revision, 3);

  const removed = db.deleteGlossaryRule(created.rule.id);
  assert.equal(removed.deleted, true);
  assert.equal(removed.snapshot.revision, start + 4);
  assert.equal(db.deleteGlossaryRule(created.rule.id).deleted, false);
  assert.equal(db.getGlossaryRules().revision, start + 4, "a no-op delete changes nothing");

  assert.throws(
    () => db.saveGlossaryRule({ ...edited.rule, id: "no-such-rule" }),
    (error) => error.code === "GLOSSARY_NOT_FOUND"
  );
});

test("rule input is validated and normalized in main", () => {
  assert.throws(
    () => normalizeGlossaryRuleInput({ canonical: "  ", spellings: [] }),
    (error) => error.code === "GLOSSARY_CANONICAL_REQUIRED"
  );
  assert.throws(
    () => normalizeGlossaryRuleInput({ canonical: "X", spellings: "everybody" }),
    (error) => error.code === "GLOSSARY_INVALID"
  );
  assert.throws(
    () => normalizeGlossaryRuleInput({ canonical: "x".repeat(101), spellings: [] }),
    (error) => error.code === "GLOSSARY_CANONICAL_TOO_LONG"
  );
  assert.deepEqual(
    normalizeGlossaryRuleInput({
      canonical: "  Little   Buddy ",
      spellings: [
        { text: " every   body ", scope: "start" },
        { text: "EVERY BODY", scope: "anywhere" },
        { text: "little buddy", scope: "anywhere" },
        { text: "buddy", scope: "nonsense" },
        { text: "   " },
      ],
      apps: [" Code.exe ", "code.exe", "", "github.exe"],
    }),
    {
      canonical: "Little Buddy",
      spellings: [
        { text: "every body", scope: "start" },
        { text: "buddy", scope: "start" },
      ],
      apps: ["Code.exe", "github.exe"],
      enabled: true,
    }
  );
});

test("IPC: rules round-trip, and every saved change is broadcast to all windows", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const invoke = ipcFor(db);

  const initial = await invoke("glossary-get-rules");
  assert.equal(initial.rules.length, 1);

  const saved = await invoke("glossary-save-rule", {
    canonical: "Gizmo Labs",
    spellings: [{ text: "gizmolabs", scope: "anywhere" }],
    apps: [],
    enabled: true,
  });
  assert.equal(saved.success, true);
  assert.equal(saved.snapshot.revision, initial.revision + 1);
  assert.deepEqual(broadcasts, [{ channel: "glossary-rules-updated", payload: saved.snapshot }]);

  const toggled = await invoke("glossary-save-rule", { ...saved.rule, enabled: false });
  assert.equal(toggled.rule.revision, 2);
  assert.equal(toggled.rule.enabled, false);
  assert.equal(broadcasts.length, 2);

  broadcasts.length = 0;
  const invalid = await invoke("glossary-save-rule", { canonical: "", spellings: [] });
  assert.deepEqual(
    { success: invalid.success, code: invalid.code },
    { success: false, code: "GLOSSARY_CANONICAL_REQUIRED" }
  );
  assert.deepEqual(broadcasts, [], "a rejected save broadcasts nothing");

  const deleted = await invoke("glossary-delete-rule", saved.rule.id);
  assert.equal(deleted.success, true);
  assert.equal(deleted.snapshot.rules.length, 1);
  assert.equal(broadcasts.at(-1).channel, "glossary-rules-updated");

  broadcasts.length = 0;
  const missing = await invoke("glossary-delete-rule", saved.rule.id);
  assert.equal(missing.success, false);
  assert.equal(missing.code, "GLOSSARY_NOT_FOUND");
  assert.deepEqual(broadcasts, []);
  assert.equal((await invoke("glossary-delete-rule", 42)).code, "GLOSSARY_INVALID");
});

test("IPC: dictionary entries carry each word's source", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const invoke = ipcFor(db);
  db.applyDictionaryChanges({ add: ["OpenWhispr", "Kubernetes"] }, "manual");
  db.applyDictionaryChanges({ add: ["Hello"] }, "learned");
  assert.deepEqual(await invoke("db-get-dictionary-entries"), [
    { word: "OpenWhispr", source: "manual" },
    { word: "Kubernetes", source: "manual" },
    { word: "Hello", source: "learned" },
  ]);
});

test("auto-learn never learns a glossary word", async (t) => {
  const db = createDb(t);
  if (!db) return;
  ipcFor(db);
  // Reverting "Little Buddy" to "everybody" would otherwise teach the hint list the mishearing.
  assert.deepEqual(
    IPCHandlersCtor.prototype._withoutGlossaryWords.call(fakeThis, [
      "everybody",
      "Kubernetes",
      "Buddy",
      "Buddies",
    ]),
    ["Kubernetes"]
  );
});

test("glossary learn exclusions cover every spelling word and canonical form", () => {
  const excluded = glossaryLearnExclusions([seedShape()]);
  for (const word of ["little buddy", "little", "buddy", "everybody", "every", "body", "buddies"]) {
    assert.ok(excluded.has(word), word);
  }
  assert.ok(!excluded.has("kubernetes"));
  assert.deepEqual([...glossaryLearnExclusions(null)], []);
});
