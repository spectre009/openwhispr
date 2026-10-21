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
    setRecording: (recording) => calls.push(["setRecording", recording]),
    refresh: (reason) => calls.push(["refresh", reason]),
    handleDisplaysChanged: () => calls.push(["displays"]),
    configure: (settings) => calls.push(["configure", settings]),
    preview: () => true,
    release: () => calls.push(["release"]),
    destroy: () => calls.push(["destroy"]),
  };
  return { manager, calls };
}

test("the strip follows the main process's recording state", () => {
  const { manager, calls } = managerWithStripSpy();
  manager.setDictationLifecycleState("recording", "assistant");
  manager.setDictationLifecycleState("processing", "assistant");
  manager.setDictationLifecycleState("recording", "translation");
  manager.setDictationLifecycleState("idle");
  assert.deepEqual(
    calls.filter(([kind]) => kind === "setRecording").map(([, value]) => value),
    [true, false, true, false]
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
  });
  assert.deepEqual(calls.at(-1), [
    "configure",
    { color: "red", strip: "off", displays: "all", tray: false },
  ]);
  assert.deepEqual(manager.getRecordingIndicatorSettings(), {
    color: "red",
    strip: "off",
    displays: "all",
    tray: false,
  });
});
