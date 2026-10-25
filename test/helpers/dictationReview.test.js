const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { createDictationReview } = require("../../src/helpers/dictationReview.js");
const {
  historyRevision,
  normalizeFeedbackInput,
  ownerTag,
} = require("../../src/helpers/dictationFeedback.js");

// "Review last dictation" in main, without Electron: it never touches a
// dictation still being prepared, recorded, processed or delivered (pasted and
// saved, which the dictation window reports), main forgets that report when
// the window goes away, and the request waits until the control panel is
// ready to take it. The dictation it opens is resolved in SQL
// (dictationFeedbackDatabase.test.js); here, the owner it is resolved for.

const DISPLAY = {
  id: 1,
  label: "Display",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getAllDisplays: () => [DISPLAY],
        getPrimaryDisplay: () => DISPLAY,
        getCursorScreenPoint: () => ({ x: 10, y: 10 }),
        getDisplayNearestPoint: () => DISPLAY,
        getDisplayMatching: () => DISPLAY,
        on: () => undefined,
      },
      powerMonitor: { on: () => undefined },
      ipcMain: { on: () => undefined, removeListener: () => undefined },
      BrowserWindow: class {},
      Menu: { buildFromTemplate: () => ({ popup() {} }) },
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger")
    return {
      warn: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      log: () => undefined,
      error: () => undefined,
    };
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {
      constructor() {
        this.listening = false;
      }
      unregisterAll() {}
      isInListeningMode() {
        return this.listening;
      }
    };
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager")
    return class {
      isDragActive() {
        return false;
      }
    };
  if (request === "./menuManager") return {};
  if (request === "./devServerManager")
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppUrl: () => null,
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  if (request === "./dockManager") return { setControlPanelVisible: () => undefined };
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

function emitter() {
  const listeners = new Map();
  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    },
    once(event, listener) {
      const wrapped = (...args) => {
        listeners.set(
          event,
          (listeners.get(event) || []).filter((entry) => entry !== wrapped)
        );
        listener(...args);
      };
      this.on(event, wrapped);
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) || [])]) listener(...args);
    },
  };
}

function fakeWindow({ loading = false } = {}) {
  const win = emitter();
  const sent = [];
  win.webContents = {
    ...emitter(),
    sent,
    loading,
    send: (channel, payload) => sent.push(payload === undefined ? [channel] : [channel, payload]),
    isLoading() {
      return this.loading;
    },
  };
  win.isDestroyed = () => false;
  win.getBounds = () => ({ x: 0, y: 0, width: 200, height: 100 });
  return win;
}

function managerFor({ panel = null, target = 41, owner = "account:a" } = {}) {
  const manager = new WindowManager();
  const calls = [];
  manager.recordingEdgeStrip = {
    setRecording: () => undefined,
    refresh: () => undefined,
    configure: () => undefined,
    pulse: () => undefined,
    release: () => undefined,
    destroy: () => undefined,
  };
  manager._onboardingActive = false;
  manager.mainWindow = fakeWindow();
  manager.controlPanelWindow = panel;
  manager.createControlPanelWindow = async () => {
    calls.push("create-panel");
    if (!manager.controlPanelWindow) manager.controlPanelWindow = fakeWindow({ loading: true });
  };
  manager.showControlPanel = () => calls.push("show-panel");
  // Nothing about a running dictation may be touched.
  for (const name of [
    "sendCancelDictation",
    "sendStopDictation",
    "sendStartDictation",
    "sendToggleDictation",
    "hideDictationPanel",
  ]) {
    manager[name] = () => calls.push(name);
  }
  const owners = [];
  manager.dictationReview = createDictationReview({
    windowManager: manager,
    db: {
      getLastReviewableDictation: (forOwner) => {
        owners.push(forOwner);
        return target;
      },
    },
    getOwner: () => owner,
  });
  return { manager, calls, owners };
}

test("busy while a dictation is prepared, recorded, processed or still delivered", () => {
  const { manager } = managerFor();
  assert.equal(manager.isDictationBusy(), false);
  for (const state of ["preparing", "recording", "processing"]) {
    manager.setDictationLifecycleState(state, "dictation");
    assert.equal(manager.isDictationBusy(), true, state);
  }
  manager.setDictationLifecycleState("idle", "dictation");
  assert.equal(manager.isDictationBusy(), false);
  // Main's lifecycle is idle before the paste and the save that follow it.
  manager.setDictationDeliveryState(true);
  assert.equal(manager.isDictationBusy(), true, "pasting or saving");
  manager.setDictationDeliveryState(false);
  assert.equal(manager.isDictationBusy(), false);
});

test("the delivery report is forgotten when the dictation window goes away", () => {
  for (const [reason, goAway] of [
    ["crash", (win) => win.webContents.emit("render-process-gone", {}, { reason: "crashed" })],
    [
      "reload",
      (win) =>
        win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }),
    ],
    ["close", (win) => win.emit("closed")],
  ]) {
    const { manager } = managerFor();
    const win = fakeWindow();
    manager._registerDictationLifecycleReset(win);
    manager.setDictationLifecycleState("processing", "dictation");
    manager.setDictationDeliveryState(true);
    goAway(win);
    assert.equal(manager.isDictationBusy(), false, reason);
  }
  // Also when the lifecycle itself was already idle.
  const { manager } = managerFor();
  const win = fakeWindow();
  manager._registerDictationLifecycleReset(win);
  manager.setDictationDeliveryState(true);
  win.webContents.emit("render-process-gone", {}, { reason: "oom" });
  assert.equal(manager.isDictationBusy(), false);
});

test("pressed during a dictation it says why on the pill and does nothing else", async () => {
  const panel = fakeWindow();
  const { manager, calls, owners } = managerFor({ panel });
  for (const busy of [
    () => manager.setDictationLifecycleState("recording", "dictation"),
    () => {
      manager.setDictationLifecycleState("idle", "dictation");
      manager.setDictationDeliveryState(true);
    },
  ]) {
    busy();
    await manager.reviewLastDictation();
  }
  assert.deepEqual(manager.mainWindow.webContents.sent, [
    ["review-dictation-busy"],
    ["review-dictation-busy"],
  ]);
  assert.deepEqual(calls, [], "no panel, and the dictation is left alone");
  assert.deepEqual(owners, [], "nothing resolved");
  assert.ok(
    !panel.webContents.sent.some(([channel]) => channel === "review-dictation-pending"),
    "no request for the control panel"
  );
  assert.equal(manager.consumePendingReviewRequest(), null);
});

test("it opens the panel and hands the request over once, for the current owner", async () => {
  const panel = fakeWindow();
  const { manager, calls, owners } = managerFor({ panel, target: 41 });
  await manager.reviewLastDictation();
  assert.deepEqual(owners, ["account:a"]);
  assert.deepEqual(
    calls,
    ["create-panel"],
    "an existing panel is shown by createControlPanelWindow"
  );
  assert.deepEqual(panel.webContents.sent, [["review-dictation-pending"]]);
  assert.deepEqual(manager.consumePendingReviewRequest(), { requestId: 1, id: 41 });
  assert.equal(manager.consumePendingReviewRequest(), null, "taken once");

  // None found: the request says so, and History opens with a notice.
  manager.dictationReview = createDictationReview({
    windowManager: manager,
    db: { getLastReviewableDictation: () => null },
    getOwner: () => "account:a",
  });
  await manager.reviewLastDictation();
  assert.deepEqual(manager.consumePendingReviewRequest(), { requestId: 1, id: null });
});

test("a panel still loading gets the request after it has loaded", async () => {
  const { manager, calls } = managerFor({ panel: null });
  await manager.reviewLastDictation();
  const panel = manager.controlPanelWindow;
  assert.deepEqual(calls, ["create-panel", "show-panel"], "a new panel is shown");
  assert.deepEqual(panel.webContents.sent, [], "not before it has loaded");
  // The renderer asks on mount as well, so a request can't be lost either way.
  panel.webContents.loading = false;
  panel.webContents.emit("did-finish-load");
  assert.deepEqual(panel.webContents.sent, [["review-dictation-pending"]]);
  assert.deepEqual(manager.consumePendingReviewRequest(), { requestId: 1, id: 41 });
});

test("not during onboarding or while a hotkey is being captured", async () => {
  const panel = fakeWindow();
  const { manager, calls, owners } = managerFor({ panel });
  manager._onboardingActive = true;
  await manager.reviewLastDictation();
  manager._onboardingActive = false;
  manager.hotkeyManager.listening = true;
  await manager.reviewLastDictation();
  assert.deepEqual([calls, owners, panel.webContents.sent], [[], [], []]);
});

test("the target is resolved for the current owner, and none without one", () => {
  const owners = [];
  const db = {
    getLastReviewableDictation: (owner) => {
      owners.push(owner);
      return 7;
    },
  };
  let owner = "signed-out";
  const review = createDictationReview({ windowManager: {}, db, getOwner: () => owner });
  assert.equal(review.resolveTarget(), 7);
  owner = null;
  assert.equal(review.resolveTarget(), null);
  assert.deepEqual(owners, ["signed-out"], "never asked without an owner");
  const failing = createDictationReview({
    windowManager: {},
    db: {
      getLastReviewableDictation: () => {
        throw new Error("database closed");
      },
    },
    getOwner: () => "account:a",
  });
  assert.equal(failing.resolveTarget(), null);
});

test("a revision changes with the text, the status and the owner's steps", () => {
  const row = { text: "Hello there.", raw_text: "hello there", status: "completed" };
  const base = historyRevision(row, [1, 2, 3]);
  assert.match(base, /^[0-9a-f]{32}$/);
  assert.equal(historyRevision({ ...row }, [1, 2, 3]), base, "stable while nothing changes");
  assert.notEqual(historyRevision({ ...row, text: "Hello, there." }, [1, 2, 3]), base);
  assert.notEqual(historyRevision({ ...row, raw_text: "hello their" }, [1, 2, 3]), base);
  assert.notEqual(historyRevision({ ...row, status: "failed" }, [1, 2, 3]), base);
  assert.notEqual(historyRevision(row, [4, 5, 6]), base, "a retry's new steps");
  assert.notEqual(historyRevision(row, []), base);
  assert.notEqual(ownerTag("account:a"), ownerTag("account:b"));
  assert.ok(!ownerTag("account:a").includes("account"));
});

test("a review's input is checked before it reaches the database", () => {
  const valid = { id: 3, revision: "r".repeat(32), verdict: "bad" };
  assert.deepEqual(normalizeFeedbackInput({ ...valid, stage: { kind: "glossary", seq: 1 } }), {
    value: {
      id: 3,
      revision: valid.revision,
      verdict: "bad",
      stageKind: "glossary",
      stageSeq: 1,
      expectedText: null,
      note: null,
    },
  });
  assert.equal(normalizeFeedbackInput(null).error, "INVALID");
  assert.equal(normalizeFeedbackInput({ ...valid, id: "3" }).error, "INVALID");
  assert.equal(normalizeFeedbackInput({ ...valid, revision: "r".repeat(65) }).error, "INVALID");
  assert.equal(
    normalizeFeedbackInput({ ...valid, stage: { kind: "voice-over", seq: 0 } }).error,
    "INVALID_STAGE"
  );
  assert.equal(
    normalizeFeedbackInput({ ...valid, stage: { kind: "cleanup", seq: -1 } }).error,
    "INVALID_STAGE"
  );
  assert.equal(normalizeFeedbackInput({ ...valid, stage: "cleanup" }).error, "INVALID_STAGE");
  assert.equal(normalizeFeedbackInput({ ...valid, note: 5 }).error, "INVALID");
  // A good review drops the step and the correction; blanks are nothing.
  const good = normalizeFeedbackInput({
    ...valid,
    verdict: "good",
    stage: { kind: "cleanup", seq: 2 },
    expectedText: "x",
    note: "   ",
  }).value;
  assert.deepEqual(
    [good.stageKind, good.stageSeq, good.expectedText, good.note],
    [null, null, null, null]
  );
  assert.equal(
    normalizeFeedbackInput({ ...valid, expectedText: "  \n " }).value.expectedText,
    null
  );
});
