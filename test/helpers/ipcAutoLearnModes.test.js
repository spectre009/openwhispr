const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// "Learn from your corrections" in main: Suggest, Add directly or Off.
// Nothing is watched until a window has synced the mode; Off stops the
// monitor, a paste's pending 500 ms start and a pending correction debounce.
// Suggest writes a suggestion instead of a word, with evidence tied to the
// paste it came from (captured when that paste was made) when this owner's
// local History is durable and holds that dictation. Synthetic text only.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const listeners = new Map();
const broadcasts = [];

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
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
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

Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }) };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
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

const DURABLE = { synced: true, enabled: true, forcedOff: false, resolved: true };
let target;
let ipc;
let Ctor;

function freshTarget() {
  const db = {
    added: [],
    suggested: [],
    evidence: [],
    lookups: [],
    dictionary: [],
    transcriptionId: 42,
    getDictionary: () => db.dictionary,
    applyDictionaryChanges: ({ add }, source) => {
      db.added.push({ add, source });
      return { success: true, added: add.length };
    },
    recordDictionarySuggestions: (words) => {
      db.suggested.push(words);
      return words.map((word, index) => ({ id: index + 1, word, key: word.toLowerCase() }));
    },
    findEvidenceTranscription: (owner, text, pastedAt) => {
      db.lookups.push({ owner, text, pastedAt });
      return db.transcriptionId;
    },
    addDictionaryWordEvidence: (row) => {
      db.evidence.push(row);
      return true;
    },
    getGlossaryRules: () => ({ rules: [] }),
  };
  const state = { owner: "account:a", policy: { ...DURABLE } };
  return {
    sessionId: "test-session",
    _autoLearnMode: "suggest",
    _autoLearnSynced: false,
    _autoLearnPasteSeq: 0,
    _autoLearnPasteContext: null,
    _autoLearnStartTimer: null,
    _autoLearnDebounceTimer: null,
    _autoLearnLatestData: null,
    state,
    databaseManager: db,
    stepHistory: { currentOwner: () => state.owner },
    _historyPolicy: () => state.policy,
    windowManager: { isOnboardingDemoActive: () => false, showDictationPanel: () => {} },
    clipboardManager: { pasteText: async () => ({}) },
    selectionManager: {
      getWinTarget: async () => ({ kind: "win-hwnd", id: "1", exeName: "github.exe" }),
    },
    dictionaryUsage: { invalidate: () => {} },
    _getDictionarySafe: () => db.dictionary,
    ...Object.fromEntries(
      [
        "_autoLearnArmed",
        "_stopAutoLearn",
        "_dictionaryOwnerMaybeChanged",
        "_processCorrections",
        "_suggestCorrections",
        "_recordCorrectionEvidence",
        "_withoutGlossaryWords",
        "_setupTextEditMonitor",
      ].map((name) => [name, Ctor.prototype[name]])
    ),
  };
}

test.before(() => {
  delete require.cache[handlersModulePath];
  const loaded = require(handlersModulePath);
  Ctor = loaded.default || loaded;
  target = freshTarget();
  ipc = new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
    set: (value, property, next) => {
      value[property] = next;
      return true;
    },
  });
  Ctor.prototype.setupHandlers.call(ipc);
});

test.after(() => {
  Module._load = originalLoad;
});

// A fresh state per test, on the same handlers.
function reset(t) {
  const fresh = freshTarget();
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, fresh);
  broadcasts.length = 0;
  const timers = [];
  const cleared = new Set();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = (callback, ms) => {
    timers.push({ callback, ms, id: timers.length + 1 });
    return timers.length;
  };
  global.clearTimeout = (id) => cleared.add(id);
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });
  const monitor = { started: [], stopped: 0, handler: null };
  target.textEditMonitor = {
    lastTargetPid: 42,
    activateTargetPid: async () => true,
    startMonitoring: (text) => monitor.started.push(text),
    stopMonitoring: () => {
      monitor.stopped += 1;
    },
    on: (event, handler) => {
      if (event === "text-edited") monitor.handler = handler;
    },
    removeListener: () => {},
  };
  Ctor.prototype._setupTextEditMonitor.call(ipc);
  const run = (ms) => {
    for (const timer of timers.splice(0)) {
      if (cleared.has(timer.id)) continue;
      if (ms === undefined || timer.ms === ms) timer.callback();
      else timers.push(timer);
    }
  };
  const sync = (mode) => listeners.get("auto-learn-changed")({}, mode);
  const paste = (text) => handlers.get("paste-text")({ sender: { id: 1 } }, text, {});
  const edit = (originalText, newFieldValue) => monitor.handler({ originalText, newFieldValue });
  return { monitor, run, sync, paste, edit, db: target.databaseManager };
}

const PASTED = "Please ask Kerry about the release.";
const EDITED = "Please ask Kiri about the release.";

test("no window has synced the mode: nothing is watched", async (t) => {
  const { monitor, run, paste } = reset(t);
  await paste(PASTED);
  run();
  assert.deepEqual(monitor.started, [], "Suggest by default, but unsynced");
});

test("an older window's boolean still syncs (true → Suggest), and same-value syncs are ignored", async (t) => {
  const { monitor, run, sync, paste } = reset(t);
  sync(true);
  assert.equal(target._autoLearnMode, "suggest");
  assert.equal(target._autoLearnSynced, true);
  sync("suggest");
  await paste(PASTED);
  run(500);
  assert.deepEqual(monitor.started, [PASTED]);
  sync("bogus");
  assert.equal(target._autoLearnMode, "suggest", "unknown reads as Suggest");
});

test("Off during the 500 ms start: monitoring never starts", async (t) => {
  const { monitor, run, sync, paste } = reset(t);
  sync("suggest");
  await paste(PASTED);
  sync("off");
  run();
  assert.deepEqual(monitor.started, []);
  assert.ok(monitor.stopped >= 1, "the monitor is stopped");
  assert.equal(target._autoLearnPasteContext, null);
});

test("Off during the correction debounce: nothing is learned", async (t) => {
  const { monitor, run, sync, paste, edit, db } = reset(t);
  sync("add");
  await paste(PASTED);
  run(500);
  assert.deepEqual(monitor.started, [PASTED]);
  edit(PASTED, EDITED);
  sync("off");
  run();
  assert.deepEqual(db.added, []);
  assert.deepEqual(db.suggested, []);
  // A late debounce still firing finds nothing to do.
  Ctor.prototype._processCorrections.call(ipc);
  assert.deepEqual(db.added, []);
});

test("Add directly: the word goes straight into the dictionary, as before", async (t) => {
  const { run, sync, paste, edit, db } = reset(t);
  sync("add");
  await paste(PASTED);
  run(500);
  edit(PASTED, EDITED);
  run();
  assert.deepEqual(db.added, [{ add: ["Kiri"], source: "learned" }]);
  assert.deepEqual(db.suggested, []);
  assert.ok(broadcasts.some((b) => b.channel === "corrections-learned"));
});

test("Suggest: a suggestion with evidence from the paste it came from", async (t) => {
  const { run, sync, paste, edit, db } = reset(t);
  sync("suggest");
  const before = Date.now();
  await paste(PASTED);
  run(500);
  edit(PASTED, EDITED);
  run();
  assert.deepEqual(db.added, [], "nothing is added");
  assert.deepEqual(db.suggested, [["Kiri"]]);
  assert.equal(db.lookups.length, 1);
  assert.equal(db.lookups[0].owner, "account:a");
  assert.equal(db.lookups[0].text, PASTED);
  assert.ok(db.lookups[0].pastedAt >= before && db.lookups[0].pastedAt <= Date.now());
  const appExpected = process.platform === "win32" ? "github.exe" : null;
  assert.deepEqual(db.evidence, [
    {
      word: "Kiri",
      owner: "account:a",
      transcriptionId: 42,
      replaced: "Kerry",
      app: appExpected,
    },
  ]);
  assert.ok(broadcasts.some((b) => b.channel === "dictionary-suggestions-updated"));
  const toast = broadcasts.find((b) => b.channel === "corrections-suggested");
  assert.deepEqual(toast.payload, [{ id: 1, word: "Kiri" }]);
});

test("Suggest keeps the suggestion but no evidence when History can't hold it", async (t) => {
  for (const [name, change] of [
    ["the owner changed", (s) => (s.owner = "account:b")],
    ["history is off", (s) => (s.policy = { ...DURABLE, enabled: false })],
    ["the policy is pending", (s) => (s.policy = { ...DURABLE, resolved: false })],
    ["forced off", (s) => (s.policy = { ...DURABLE, forcedOff: true })],
    ["no dictation matched", () => (target.databaseManager.transcriptionId = null)],
  ]) {
    await t.test(name, async (st) => {
      const { run, sync, paste, edit, db } = reset(st);
      sync("suggest");
      await paste(PASTED);
      run(500);
      change(target.state);
      edit(PASTED, EDITED);
      run();
      assert.deepEqual(db.suggested, [["Kiri"]]);
      assert.deepEqual(db.evidence, []);
    });
  }
});

test("an edit of another paste's text leaves no evidence", async (t) => {
  const { run, sync, paste, edit, db } = reset(t);
  sync("suggest");
  await paste(PASTED);
  run(500);
  edit("An older paste for Kerry.", "An older paste for Kiri.");
  run();
  assert.deepEqual(db.suggested, [["Kiri"]]);
  assert.deepEqual(db.lookups, []);
  assert.deepEqual(db.evidence, []);
});

test("an owner change or clearing History drops the paste being watched", async (t) => {
  const { run, sync, paste } = reset(t);
  sync("suggest");
  await paste(PASTED);
  run(500);
  assert.equal(target._autoLearnPasteContext.owner, "account:a");
  Ctor.prototype._dictionaryOwnerMaybeChanged.call(ipc);
  assert.ok(target._autoLearnPasteContext, "the same owner keeps it");
  target.state.owner = "account:b";
  Ctor.prototype._dictionaryOwnerMaybeChanged.call(ipc);
  assert.equal(target._autoLearnPasteContext, null);

  await paste(PASTED);
  run(500);
  assert.ok(target._autoLearnPasteContext);
  target.audioStorageManager = { deleteAllAudio: () => {} };
  target.databaseManager.clearTranscriptions = () => ({ success: true, cleared: 1 });
  await handlers.get("db-clear-transcriptions")({});
  assert.equal(target._autoLearnPasteContext, null);
});
