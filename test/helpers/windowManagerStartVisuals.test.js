const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// WindowManager's half of "Dictation start visuals": a hold or a toggle's start
// begins one line keyed by the press trace's pressId (a toggle's is stamped by
// main, and travels with prepare and the toggle), the dictation window is asked
// for its first painted frame once the pill is on screen, the lifecycle and the
// edge strip add theirs, and a hold released before anything showed writes
// nothing.

const lines = [];
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    const display = {
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    };
    return {
      app: { on: () => undefined },
      screen: {
        getAllDisplays: () => [display],
        getPrimaryDisplay: () => display,
        getCursorScreenPoint: () => ({ x: 10, y: 10 }),
        getDisplayNearestPoint: () => display,
        getDisplayMatching: () => display,
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
  if (request === "./debugLogger") {
    const at = (level) => (message, meta, scope) => lines.push({ level, message, meta, scope });
    return { info: at("info"), warn: at("warn"), debug: () => undefined, error: at("error") };
  }
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {
      unregisterAll() {}
      isInListeningMode() {
        return false;
      }
    };
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager") return class {};
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") {
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  }
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

const NOW = 1_800_000_000_000;
const HARDWARE = { mode: "hardware", reason: null };

function setup(t, { visible = false, strip = "frame", graphics = HARDWARE, show = true } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  t.after(() => t.mock.timers.reset());
  lines.length = 0;
  const sent = [];
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  const win = {
    visible,
    isDestroyed: () => false,
    isVisible: () => win.visible,
    isMinimized: () => false,
    showInactive: () => {
      win.visible = true;
    },
    hide: () => {
      win.visible = false;
    },
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };
  manager.mainWindow = win;
  // Placement is out of scope: the pill surfaces at once, or (show: false) later.
  manager.showDictationPanel = () => {
    if (show) manager._surfaceMainWindow(false);
  };
  manager.hideDictationPanel = () => win.hide();
  const stripCalls = [];
  manager.recordingEdgeStrip = {
    stripModeForRecording: () => strip,
    setRecording: (recording) => stripCalls.push(recording),
    pulse: () => undefined,
    release: () => undefined,
    destroy: () => undefined,
  };
  manager.graphicsMode = { getState: () => graphics };
  const channels = () => sent.map(([channel]) => channel);
  const payload = (name) => sent.find(([channel]) => channel === name)?.[1];
  return { manager, win, sent, channels, payload, stripCalls };
}

test("a hold: probe after the prepare, then the pill, its entrance and the frame make one line", (t) => {
  const { manager, channels, payload } = setup(t);
  manager.startWindowsPushToTalk("F8", { eventAt: NOW - 6, hookAt: NOW - 4 });
  assert.deepEqual(channels(), ["prepare-dictation", "dictation-start-visuals-probe"]);
  const { pressId } = payload("prepare-dictation").trace;
  assert.deepEqual(payload("dictation-start-visuals-probe"), { pressId });

  manager.handleStartVisualMark({ pressId, mark: "pillPainted", at: NOW + 24 });
  t.mock.timers.tick(150);
  manager.setDictationLifecycleState("preparing");
  t.mock.timers.tick(250);
  manager.setDictationLifecycleState("recording", undefined, {
    inputKind: "dictation",
    startedAt: Date.now(),
  });
  // The strip reports through the callback main wires into it.
  manager._startVisuals.frameShown({ window: "new", at: Date.now() + 140 });
  assert.deepEqual(lines, [], "the entrance hasn't ended");
  manager.handleStartVisualMark({ pressId, mark: "pillSettled", at: NOW + 980 });

  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    level: "info",
    message: "Dictation start visuals",
    meta: {
      pressId,
      keyTimeSource: "os",
      pillShownAfterKeyMs: 30,
      pillWasVisible: false,
      pillSettledAfterKeyMs: 986,
      recordingAfterKeyMs: 406,
      frameShownAfterKeyMs: 546,
      frameWindow: "new",
      strip: "frame",
      graphics: "hardware",
      outcome: "complete",
      loggedAfterKeyMs: 406,
    },
    scope: "window",
  });
});

test("the edge strip's show reaches the line through the constructor's wiring", (t) => {
  setup(t);
  const manager = new WindowManager();
  const shown = [];
  manager._startVisuals.frameShown = (details) => shown.push(details);
  manager.recordingEdgeStrip._onRecordingShown({ window: "reused", mode: "full", at: 5 });
  assert.deepEqual(shown, [{ window: "reused", mode: "full", at: 5 }]);
});

test("a toggle's start: main stamps the press, prepare and toggle carry it, the probe follows", (t) => {
  const { manager, channels, payload, sent } = setup(t, { visible: true, strip: "off" });
  manager.sendToggleDictation({ styleId: "starter-teams" });
  assert.deepEqual(channels(), [
    "prepare-dictation",
    "toggle-dictation",
    "dictation-start-visuals-probe",
  ]);
  const prepared = payload("prepare-dictation").trace;
  const toggled = payload("toggle-dictation");
  assert.deepEqual(
    [prepared.keyTimeSource, prepared.keyAt, prepared.pressId],
    ["main", NOW, NOW],
    "a toggle's key time is main's own"
  );
  assert.equal(toggled.styleId, "starter-teams");
  assert.equal(toggled.trace.pressId, prepared.pressId);
  assert.equal(typeof toggled.trace.startSentAt, "number");

  manager.handleStartVisualMark({ pressId: NOW, mark: "pillPainted", at: NOW + 16 });
  manager.setDictationLifecycleState("recording", undefined, {
    inputKind: "dictation",
    startedAt: Date.now(),
  });
  // Strip off: the frame isn't awaited; the entrance still is.
  manager.handleStartVisualMark({ pressId: NOW, mark: "pillSettled", at: NOW + 700 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].meta.pillWasVisible, true);
  assert.equal(lines[0].meta.frameWindow, "none");
  assert.equal(lines[0].meta.keyTimeSource, "main");

  // A stop press is no start: no trace, no probe, nothing begun.
  sent.length = 0;
  manager.sendToggleDictation();
  assert.deepEqual(channels(), ["toggle-dictation"]);
  assert.equal(payload("toggle-dictation"), undefined);
  assert.equal(manager._startVisuals.pendingPressId, null);
});

test("a pill shown after its press (a locked display) is probed when it surfaces", (t) => {
  const { manager, win, channels } = setup(t, { show: false });
  manager.startWindowsPushToTalk("F8");
  assert.deepEqual(channels(), ["prepare-dictation"], "not on screen yet");
  t.mock.timers.tick(20);
  manager._surfaceMainWindow(false);
  assert.equal(win.visible, true);
  assert.deepEqual(channels(), ["prepare-dictation", "dictation-start-visuals-probe"]);
  // Surfacing again asks nothing more.
  win.visible = false;
  manager._surfaceMainWindow(false);
  assert.equal(channels().length, 2);
});

test("a hold released before anything showed writes nothing; after the pill showed, it's written", (t) => {
  const { manager } = setup(t);
  manager.startWindowsPushToTalk("F8");
  t.mock.timers.tick(80);
  manager.handleWindowsPushKeyUp("F8");
  t.mock.timers.tick(5000);
  assert.deepEqual(lines, []);

  manager.startWindowsPushToTalk("F8");
  const pressId = manager._startVisuals.pendingPressId;
  manager.handleStartVisualMark({ pressId, mark: "pillPainted", at: Date.now() + 20 });
  t.mock.timers.tick(90);
  manager.setDictationLifecycleState("preparing");
  manager.setDictationLifecycleState("idle");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].meta.outcome, "cancelled");
});

test("a software fallback warns; onboarding begins nothing; marks from another press are ignored", (t) => {
  const fallback = { mode: "software", reason: "fallback" };
  const { manager } = setup(t, { strip: "off", graphics: fallback });
  manager.startWindowsPushToTalk("F8");
  const pressId = manager._startVisuals.pendingPressId;
  manager.handleStartVisualMark({ pressId: pressId + 1, mark: "pillPainted", at: Date.now() });
  manager.handleStartVisualMark(null);
  manager.handleStartVisualMark({ pressId, mark: "pillPainted", at: Date.now() + 12 });
  t.mock.timers.tick(150);
  manager.setDictationLifecycleState("recording", undefined, {
    inputKind: "dictation",
    startedAt: Date.now(),
  });
  manager.handleStartVisualMark({ pressId, mark: "pillSettled", at: Date.now() + 560 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "warn");
  assert.equal(lines[0].message, "Slow dictation start visuals");
  assert.deepEqual(lines[0].meta.slow, ["graphics"]);
  assert.equal(lines[0].meta.graphicsReason, "fallback");

  manager.setDictationLifecycleState("idle");
  // The assistant has its own window now: every start in this one runs the
  // pill's entrance, so each line waits for it to settle.
  manager._beginStartVisuals({ pressId: 2, keyAt: Date.now(), keyTimeSource: "main" });
  assert.equal(manager._startVisuals._start.expectSettle, true);
  manager._startVisuals.dispose();

  manager._onboardingActive = true;
  manager._beginStartVisuals({ pressId: 1, keyAt: Date.now(), keyTimeSource: "main" });
  assert.equal(manager._startVisuals.pendingPressId, null);
});
