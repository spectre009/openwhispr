const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const G95 = {
  id: 1217155111,
  label: "Odyssey G95NC",
  bounds: { x: 0, y: 0, width: 5672, height: 1596 },
  workArea: { x: 0, y: 0, width: 5672, height: 1548 },
};

const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getAllDisplays: () => [G95],
        getPrimaryDisplay: () => G95,
        getCursorScreenPoint: () => ({ x: 10, y: 10 }),
        getDisplayNearestPoint: () => G95,
        getDisplayMatching: () => G95,
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
      unregisterAll() {}
      isInListeningMode() {
        return false;
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
      async startWindowDrag() {
        return { success: true };
      }
      async stopWindowDrag() {
        return { success: true };
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
  if (request === "./dockManager") return {};
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
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) listener(...args);
    },
  };
}

function fakeDictationWindow(bounds = { x: 2732, y: 1424, width: 208, height: 120 }) {
  const win = emitter();
  win.webContents = { ...emitter(), send: () => undefined };
  win.bounds = { ...bounds };
  win.isDestroyed = () => false;
  win.getBounds = () => ({ ...win.bounds });
  return win;
}

function managerWithStripSpy() {
  const manager = new WindowManager();
  const calls = [];
  manager.recordingEdgeStrip = {
    setRecording: (recording, kind) => calls.push(["setRecording", recording, kind]),
    refresh: (reason) => calls.push(["refresh", reason]),
    handleDisplaysChanged: () => calls.push(["displays"]),
    configure: (settings) => calls.push(["configure", settings]),
    preview: () => true,
    pulse: () => calls.push(["pulse"]),
    release: () => calls.push(["release"]),
    destroy: () => calls.push(["destroy"]),
  };
  return { manager, calls };
}

test("the strip follows the main process's recording state and mode", () => {
  const { manager, calls } = managerWithStripSpy();
  manager.setDictationLifecycleState("recording", undefined, { inputKind: "assistant" });
  manager.setDictationLifecycleState("processing", undefined, { inputKind: "assistant" });
  manager.setDictationLifecycleState("recording", undefined, { inputKind: "translation" });
  manager.setDictationLifecycleState("idle");
  assert.deepEqual(
    calls.filter(([kind]) => kind === "setRecording").map(([, value, mode]) => [value, mode]),
    [
      [true, "assistant"],
      [false, "assistant"],
      [true, "translation"],
      [false, "dictation"],
    ]
  );
});

for (const [name, trigger] of [
  [
    "a renderer crash",
    (win) => win.webContents.emit("render-process-gone", {}, { reason: "crashed" }),
  ],
  [
    "a reload",
    (win) =>
      win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }),
  ],
  ["closing the window", (win) => win.emit("closed")],
]) {
  test(`${name} mid-recording resets the lifecycle and hides the strip`, () => {
    const { manager, calls } = managerWithStripSpy();
    const win = fakeDictationWindow();
    manager._registerDictationLifecycleReset(win);
    manager.setDictationLifecycleState("recording");
    assert.equal(manager.isDictating(), true);
    trigger(win);
    assert.equal(manager.isDictating(), false);
    assert.equal(manager._dictationLifecycleState, "idle");
    assert.deepEqual(calls.filter(([kind]) => kind === "setRecording").at(-1), [
      "setRecording",
      false,
      "dictation",
    ]);
  });
}

test("in-page and subframe navigations leave a recording alone", () => {
  const { manager } = managerWithStripSpy();
  const win = fakeDictationWindow();
  manager._registerDictationLifecycleReset(win);
  manager.setDictationLifecycleState("recording");
  win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  win.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  assert.equal(manager.isDictating(), true);
});

test("a replaced dictation window's late events leave its successor's recording alone", () => {
  const { manager, calls } = managerWithStripSpy();
  const released = [];
  manager.recordingEdgeStrip.release = () => released.push("release");
  const old = fakeDictationWindow();
  manager.mainWindow = old;
  manager._registerDictationLifecycleReset(old);
  manager.mainWindow = fakeDictationWindow();
  manager.setDictationLifecycleState("recording");
  old.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  old.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  old.emit("closed");
  assert.equal(manager.isDictating(), true);
  assert.deepEqual(released, []);
  assert.equal(
    calls.filter(([kind, recording]) => kind === "setRecording" && !recording).length,
    0
  );
});

test("a dragged pill takes the strip along; a click without movement doesn't", async () => {
  const { manager, calls } = managerWithStripSpy();
  const win = fakeDictationWindow();
  manager.mainWindow = win;
  await manager.startWindowDrag();
  await manager.stopWindowDrag();
  assert.equal(calls.filter(([kind]) => kind === "refresh").length, 0);
  await manager.startWindowDrag();
  win.bounds = { ...win.bounds, x: 400 };
  await manager.stopWindowDrag();
  assert.deepEqual(
    calls.filter(([kind]) => kind === "refresh"),
    [["refresh", "drag"]]
  );
});

test("a committed placement re-places the strip", () => {
  const { manager, calls } = managerWithStripSpy();
  const win = fakeDictationWindow();
  win.setBounds = (bounds) => {
    win.bounds = { ...bounds };
  };
  manager.mainWindow = win;
  manager._notifyMainWindowHorizontalDirection = () => undefined;
  manager._setPlacedBounds({ x: 10, y: 10, width: 208, height: 120 }, null, {
    reason: "setting",
    display: G95,
  });
  assert.deepEqual(calls.at(-1), ["refresh", "placement"]);
});

test("closing the dictation window releases the strip's windows", () => {
  const { manager, calls } = managerWithStripSpy();
  const released = [];
  manager.recordingEdgeStrip.release = () => released.push("release");
  const win = fakeDictationWindow();
  manager._registerDictationLifecycleReset(win);
  win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.deepEqual(released, [], "a crashed renderer keeps its window; it reloads");
  win.emit("closed");
  assert.deepEqual(released, ["release"]);
  assert.equal(calls.filter(([kind]) => kind === "destroy").length, 0);
});

test("a preview needs the dictation window", () => {
  const { manager } = managerWithStripSpy();
  assert.deepEqual(manager.previewRecordingEdgeStrip({ strip: "short" }), { success: false });
  manager.mainWindow = fakeDictationWindow();
  assert.deepEqual(manager.previewRecordingEdgeStrip({ strip: "short" }), { success: true });
});

test("settings reach the strip normalized", () => {
  const { manager, calls } = managerWithStripSpy();
  manager.setRecordingIndicatorSettings({
    style: "beacon",
    color: "RED",
    strip: "huge",
    displays: "all",
    colorByMode: "yes",
    assistantColor: "#ABCDEF",
    translationColor: "nope",
    reminderMinutes: 4,
  });
  const expected = {
    color: "red",
    strip: "off",
    displays: "all",
    tray: false,
    colorByMode: false,
    assistantColor: "#abcdef",
    translationColor: "cyan",
    reminderMinutes: 0,
  };
  assert.deepEqual(calls.at(-1), ["configure", expected]);
  assert.deepEqual(manager.getRecordingIndicatorSettings(), expected);
});

const NOW = 1_800_000_000_000;

function pillWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };
}

test("main keeps the renderer's start time only when it is near the present", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  for (const [reported, kept] of [
    [NOW - 1500, NOW - 1500],
    [NOW - 60_000, NOW],
    [NOW + 5000, NOW],
    [NOW + 500, NOW],
    [Number.NaN, NOW],
    ["soon", NOW],
    [undefined, NOW],
  ]) {
    const { manager } = managerWithStripSpy();
    manager.setDictationLifecycleState("recording", undefined, {
      inputKind: "dictation",
      startedAt: reported,
    });
    assert.equal(manager.getRecordingStartedAt(), kept, `reported ${reported}`);
  }
});

test("the control panel follows the dictation lifecycle, so the test set can give way", () => {
  const { manager } = managerWithStripSpy();
  const sent = [];
  manager.controlPanelWindow = {
    isDestroyed: () => false,
    webContents: {
      isLoading: () => false,
      send: (channel, payload) => sent.push([channel, payload]),
    },
  };
  assert.equal(manager.isDictationActive(), false);
  manager.setDictationLifecycleState("preparing");
  assert.equal(manager.isDictationActive(), true, "preparing already counts");
  manager.setDictationLifecycleState("recording");
  manager.setDictationLifecycleState("processing");
  manager.setDictationLifecycleState("idle");
  assert.equal(manager.isDictationActive(), false);
  assert.deepEqual(
    sent.map(([channel, payload]) => [channel, payload.state]),
    [
      ["dictation-lifecycle-changed", "preparing"],
      ["dictation-lifecycle-changed", "recording"],
      ["dictation-lifecycle-changed", "processing"],
      ["dictation-lifecycle-changed", "idle"],
    ]
  );
  assert.deepEqual(manager.getDictationLifecycle(), { state: "idle", inputKind: "dictation" });

  // A panel still loading asks for the state itself once it mounts.
  manager.controlPanelWindow.webContents.isLoading = () => true;
  manager.setDictationLifecycleState("recording");
  assert.equal(sent.length, 4);
  assert.equal(manager.getDictationLifecycle().state, "recording");
  manager.setDictationLifecycleState("idle");
});

test("the start time is set once per recording and cleared when it ends", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const { manager } = managerWithStripSpy();
  manager.setDictationLifecycleState("recording", undefined, {
    inputKind: "dictation",
    startedAt: NOW - 1000,
  });
  t.mock.timers.tick(3000);
  manager.setDictationLifecycleState("recording", undefined, {
    inputKind: "assistant",
    startedAt: Date.now(),
  });
  assert.equal(manager.getRecordingStartedAt(), NOW - 1000, "a mode change keeps the start");
  manager.setDictationLifecycleState("processing", undefined, { inputKind: "assistant" });
  assert.equal(manager.getRecordingStartedAt(), null);
  assert.equal(manager.getDictationInputKind(), "assistant");
});

// The renderer reports the lifecycle with its attempt (the microphone's
// reservation against the agent window) and the recording's mode and start.
test("the attempt's report carries its mode and start; an older attempt's changes nothing", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const { manager, calls } = managerWithStripSpy();
  assert.equal(
    manager.setDictationLifecycleState("preparing", "a1", { inputKind: "assistant" }),
    true
  );
  assert.equal(
    manager.setDictationLifecycleState("recording", "a1", {
      inputKind: "assistant",
      startedAt: NOW - 800,
    }),
    true
  );
  assert.equal(manager.getRecordingStartedAt(), NOW - 800);
  assert.equal(manager.getDictationInputKind(), "assistant");
  assert.deepEqual(calls.filter(([kind]) => kind === "setRecording").at(-1), [
    "setRecording",
    true,
    "assistant",
  ]);
  const before = calls.length;
  assert.equal(
    manager.setDictationLifecycleState("idle", "a0", { inputKind: "dictation" }),
    false,
    "another attempt can't end this recording"
  );
  assert.equal(calls.length, before);
  assert.equal(manager.isDictating(), true);
  assert.equal(manager.setDictationLifecycleState("idle", "a1"), true);
  assert.equal(manager.getRecordingStartedAt(), null);
});

test("reminders fire at each whole interval from the start until the recording stops", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const { manager, calls } = managerWithStripSpy();
  const main = pillWindow();
  manager.mainWindow = main;
  manager.setRecordingIndicatorSettings({ reminderMinutes: 2 });
  manager.setDictationLifecycleState("recording", undefined, {
    inputKind: "translation",
    startedAt: NOW - 8000,
  });
  const reminders = () => main.sent.filter(([channel]) => channel === "recording-reminder");

  t.mock.timers.tick(111_999);
  assert.equal(reminders().length, 0);
  t.mock.timers.tick(1);
  assert.equal(reminders().length, 1, "2 minutes after the start, not after the report");
  assert.deepEqual(reminders()[0][1], { startedAt: NOW - 8000, inputKind: "translation" });
  assert.equal(calls.filter(([kind]) => kind === "pulse").length, 1);
  t.mock.timers.tick(120_000);
  assert.equal(reminders().length, 2);

  manager.setDictationLifecycleState("processing", undefined, { inputKind: "translation" });
  t.mock.timers.tick(600_000);
  assert.equal(reminders().length, 2, "none after the recording stops");
});

test("changing or clearing the interval reschedules a running recording's reminder", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const { manager } = managerWithStripSpy();
  const main = pillWindow();
  manager.mainWindow = main;
  manager.setDictationLifecycleState("recording", undefined, {
    inputKind: "dictation",
    startedAt: NOW,
  });
  t.mock.timers.tick(150_000);
  manager.setRecordingIndicatorSettings({ reminderMinutes: 2 });
  t.mock.timers.tick(89_999);
  assert.equal(main.sent.length, 0, "the next mark is 4 minutes; 2 already passed");
  t.mock.timers.tick(1);
  assert.equal(main.sent.length, 1);
  manager.setRecordingIndicatorSettings({ reminderMinutes: 0 });
  t.mock.timers.tick(600_000);
  assert.equal(main.sent.length, 1);
});

// The dictation window's assistant panel and its companion pill are gone (the
// assistant has its own window): every dictation shows on the dictation pill.
test("every dictation's reminders go to the dictation window's pill", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const { manager } = managerWithStripSpy();
  const main = pillWindow();
  manager.mainWindow = main;
  manager.setRecordingIndicatorSettings({ reminderMinutes: 2 });
  manager.setDictationLifecycleState("recording", undefined, {
    inputKind: "dictation",
    startedAt: NOW,
  });
  t.mock.timers.tick(120_000);
  assert.equal(main.sent.filter(([c]) => c === "recording-reminder").length, 1);

  manager.setDictationLifecycleState("idle");
  manager.setDictationLifecycleState("recording", undefined, {
    inputKind: "assistant",
    startedAt: Date.now(),
  });
  t.mock.timers.tick(120_000);
  assert.equal(
    main.sent.filter(([c]) => c === "recording-reminder").length,
    2,
    "the onboarding demo's assistant recording too"
  );
});
