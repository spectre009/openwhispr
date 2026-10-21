const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// The desk this feature was built for: a 57" primary display under two 32"
// monitors (Electron DIP coordinates).
const G95 = {
  id: 1217155111,
  label: "Odyssey G95NC",
  bounds: { x: 0, y: 0, width: 5672, height: 1596 },
  workArea: { x: 0, y: 0, width: 5672, height: 1548 },
};
const PG = {
  id: 2373425187,
  label: "PG32UQXR",
  bounds: { x: -16, y: -1596, width: 2836, height: 1596 },
  workArea: { x: -16, y: -1596, width: 2836, height: 1596 },
};
const M32 = {
  id: 1564834236,
  label: "M32P10",
  bounds: { x: 2820, y: -1602, width: 2837, height: 1596 },
  workArea: { x: 2820, y: -1602, width: 2837, height: 1596 },
};

const env = {
  displays: [PG, G95, M32],
  cursor: { x: 500, y: -500 },
  screenListeners: [],
  ipcListeners: new Map(),
  dragActive: false,
};

function nearestDisplay(point) {
  const inside = env.displays.find(
    (d) =>
      point.x >= d.bounds.x &&
      point.x < d.bounds.x + d.bounds.width &&
      point.y >= d.bounds.y &&
      point.y < d.bounds.y + d.bounds.height
  );
  if (inside) return inside;
  const distance = (d) => {
    const dx = Math.max(d.bounds.x - point.x, 0, point.x - (d.bounds.x + d.bounds.width));
    const dy = Math.max(d.bounds.y - point.y, 0, point.y - (d.bounds.y + d.bounds.height));
    return dx * dx + dy * dy;
  };
  return [...env.displays].sort((a, b) => distance(a) - distance(b))[0];
}

const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getAllDisplays: () => env.displays,
        getPrimaryDisplay: () => G95,
        getCursorScreenPoint: () => env.cursor,
        getDisplayNearestPoint: (point) => nearestDisplay(point),
        getDisplayMatching: (b) => nearestDisplay({ x: b.x + b.width / 2, y: b.y + b.height / 2 }),
        on: (event, listener) => env.screenListeners.push({ event, listener }),
      },
      powerMonitor: { on: () => undefined },
      ipcMain: {
        on: (channel, listener) => env.ipcListeners.set(channel, listener),
        removeListener: (channel, listener) => {
          if (env.ipcListeners.get(channel) === listener) env.ipcListeners.delete(channel);
        },
      },
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
        return env.dragActive;
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
const { WindowPositionUtil } = require("../../src/helpers/windowConfig");
Module._load = originalLoad;

class FakeMainWindow {
  constructor(bounds, visible = false) {
    this.bounds = { ...bounds };
    this.visible = visible;
    this.log = [];
    this.sent = [];
    this.webContents = { send: (channel, payload) => this.sent.push({ channel, payload }) };
  }
  isDestroyed() {
    return false;
  }
  isMinimized() {
    return false;
  }
  isVisible() {
    return this.visible;
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(bounds) {
    this.bounds = { ...bounds };
    this.log.push(`setBounds ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
  }
  showInactive() {
    this.visible = true;
    this.log.push("show");
  }
  hide() {
    this.visible = false;
    this.log.push("hide");
  }
  focus() {}
}

const BASE = { width: 208, height: 120 };
const at = (display, position, size = BASE) =>
  WindowPositionUtil.getMainWindowPosition(display, size, position);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function makeManager({ position = "bottom-right", display, label = "", bounds, visible = false }) {
  env.displays = [PG, G95, M32];
  env.dragActive = false;
  env.ipcListeners.clear();
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager.setPanelStartPosition(position);
  if (display) manager.setFloatingIconDisplay(display, label);
  const window = new FakeMainWindow(bounds ?? at(G95, "bottom-right"), visible);
  manager.mainWindow = window;
  manager.enforceMainWindowOnTop = () => undefined;
  return { manager, window };
}

test("a locked display wins over the cursor, and the hidden pill shows only once placed", async () => {
  env.cursor = { x: 500, y: -500 }; // on the upper-left monitor
  const { manager, window } = makeManager({
    position: "middle-center",
    display: String(G95.id),
    label: G95.label,
    bounds: at(PG, "bottom-right"),
  });

  manager.showDictationPanel({ reposition: true });
  assert.equal(window.visible, false, "not shown at the old spot");
  await settle();

  assert.deepEqual(window.getBounds(), { x: 2732, y: 686, width: 208, height: 120 });
  assert.deepEqual(window.log, ["setBounds 2732,686 208x120", "show"]);
});

test("a hide before the placement lands keeps the pill hidden", async () => {
  const { manager, window } = makeManager({
    position: "middle-center",
    display: "primary",
    bounds: at(PG, "bottom-right"),
  });

  manager.showDictationPanel({ reposition: true });
  manager.hideDictationPanel();
  await settle();

  assert.equal(window.visible, false);
  assert.equal(window.log.includes("show"), false);
});

test("following the cursor, a dictation start also undoes a move Windows made", async () => {
  env.cursor = { x: 3000, y: 900 }; // on the 57"
  const { manager, window } = makeManager({
    position: "center",
    bounds: { x: 2610, y: 19, width: 208, height: 120 }, // where Windows left it
    visible: true,
  });

  manager.showDictationPanel({ reposition: true });
  await settle();

  assert.deepEqual(window.getBounds(), at(G95, "center"));
});

test("following the cursor still moves the pill to the cursor's display", async () => {
  env.cursor = { x: 3000, y: -500 }; // on the upper-right monitor
  const { manager, window } = makeManager({ position: "bottom-right", visible: true });

  manager.showDictationPanel({ reposition: true });
  await settle();

  assert.deepEqual(window.getBounds(), at(M32, "bottom-right"));
});

test("a placement queued behind an in-flight resize is not overwritten by it", async () => {
  const { manager, window } = makeManager({
    position: "middle-center",
    display: "primary",
    bounds: at(PG, "bottom-right"),
    visible: true,
  });

  const resize = manager.resizeMainWindow("WITH_TOAST");
  await settle();
  const maskRequest = window.sent.find((m) => m.channel === "main-window-will-resize");
  assert.ok(maskRequest, "the resize is waiting for the renderer's mask");

  manager.showDictationPanel({ reposition: true });
  await settle();
  env.ipcListeners.get("main-window-resize-mask-ready")?.(null, maskRequest.payload.token);
  await resize;
  await settle();

  // The toast-sized window sits over the configured pill spot on the 57".
  assert.deepEqual(window.getBounds(), { x: 2636, y: 306, width: 400, height: 500 });

  // Shrinking back restores the configured resting bounds exactly.
  const restore = manager.resizeMainWindow("BASE");
  await settle();
  const restoreMask = window.sent.filter((m) => m.channel === "main-window-will-resize").at(-1);
  env.ipcListeners.get("main-window-resize-mask-ready")?.(null, restoreMask.payload.token);
  await restore;
  assert.deepEqual(window.getBounds(), { x: 2732, y: 686, width: 208, height: 120 });
});

test("a settings change applies through the same queue, after an in-flight resize", async () => {
  const { manager, window } = makeManager({ position: "bottom-right", visible: true });

  const resize = manager.resizeMainWindow("WITH_TOAST");
  await settle();
  const maskRequest = window.sent.find((m) => m.channel === "main-window-will-resize");
  manager.setPanelStartPosition("middle-left");
  env.ipcListeners.get("main-window-resize-mask-ready")?.(null, maskRequest.payload.token);
  await resize;
  await settle();

  assert.deepEqual(window.getBounds(), { x: 4, y: 306, width: 400, height: 500 });
});

test("a moved pill gets the exact resting size, and rounding at its spot counts as in place", async () => {
  // Fractional scaling grows a window a pixel or two on every setBounds; the
  // rounded size must not be fed into the next move.
  const { manager, window } = makeManager({
    position: "middle-center",
    display: "primary",
    bounds: { x: 2610, y: 19, width: 213, height: 123 },
    visible: true,
  });

  manager.showDictationPanel({ reposition: true });
  await settle();
  assert.deepEqual(window.getBounds(), { x: 2732, y: 686, width: 208, height: 120 });

  window.bounds = { x: 2731, y: 687, width: 211, height: 122 };
  window.log.length = 0;
  manager.showDictationPanel({ reposition: true });
  await settle();
  assert.deepEqual(window.log, []);
});

async function resizeAndAck(manager, window, sizeKey) {
  const resize = manager.resizeMainWindow(sizeKey);
  await settle();
  const mask = window.sent.filter((m) => m.channel === "main-window-will-resize").at(-1);
  env.ipcListeners.get("main-window-resize-mask-ready")?.(null, mask?.payload?.token);
  await resize;
  return mask?.payload;
}

test("a top-row pill keeps its top edge while a surface opens downward and closes again", async () => {
  const { manager, window } = makeManager({
    position: "top-center",
    display: "primary",
    bounds: at(G95, "top-center"),
    visible: true,
  });

  const grow = await resizeAndAck(manager, window, "WITH_MENU");
  assert.equal(grow.anchor, "top-center");
  assert.deepEqual(window.getBounds(), { x: 2716, y: 4, width: 240, height: 280 });

  const shrink = await resizeAndAck(manager, window, "BASE");
  assert.equal(shrink.anchor, "top-center");
  assert.deepEqual(window.getBounds(), { x: 2732, y: 4, width: 208, height: 120 });
});

test("a pill grown from a rounded resting size returns to the exact resting box", async () => {
  const { manager, window } = makeManager({
    position: "top-right",
    display: "primary",
    bounds: { x: 5458, y: 4, width: 210, height: 121 },
    visible: true,
  });

  const grow = await resizeAndAck(manager, window, "WITH_TOAST");
  assert.equal(grow.anchor, "top-right");
  assert.deepEqual(window.getBounds(), { x: 5268, y: 4, width: 400, height: 500 });

  await resizeAndAck(manager, window, "BASE");
  assert.deepEqual(window.getBounds(), { x: 5460, y: 4, width: 208, height: 120 });
});

test("an unchanged setting does not move the pill", async () => {
  const { manager, window } = makeManager({ position: "middle-center", display: "primary" });
  manager.setPanelStartPosition("middle-center");
  manager.setFloatingIconDisplay("primary", "");
  await settle();
  assert.deepEqual(window.log, []);
});

test("under a lock, a drag is kept on the locked display and dropped off it", async () => {
  env.cursor = { x: 3000, y: 900 };
  const { manager, window } = makeManager({
    position: "middle-center",
    display: "primary",
    bounds: at(G95, "middle-center"),
    visible: true,
  });

  await manager.startWindowDrag();
  window.bounds = { x: 1000, y: 300, width: 208, height: 120 };
  await manager.stopWindowDrag();
  manager.showDictationPanel({ reposition: true });
  await settle();
  assert.deepEqual(window.getBounds(), { x: 1000, y: 300, width: 208, height: 120 });

  await manager.startWindowDrag();
  window.bounds = { x: 1000, y: -900, width: 208, height: 120 }; // onto the upper-left monitor
  await manager.stopWindowDrag();
  manager.showDictationPanel({ reposition: true });
  await settle();
  assert.deepEqual(window.getBounds(), at(G95, "middle-center"));
  assert.equal(manager._mainWindowPlacementCoordinator.hasManualPosition(), false);
});

test("a disconnected locked monitor falls back to the primary display", async () => {
  const { manager, window } = makeManager({
    position: "bottom-right",
    display: String(PG.id),
    label: PG.label,
    bounds: at(PG, "bottom-right"),
    visible: true,
  });
  env.displays = [G95, M32];

  manager.showDictationPanel({ reposition: true });
  await settle();

  assert.deepEqual(window.getBounds(), at(G95, "bottom-right"));
});

test("after a display change the pill converges back to its spot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  env.screenListeners.length = 0;
  const { manager, window } = makeManager({ position: "center", visible: true });
  manager._listenForPlacementTopologyChanges();
  const removed = env.screenListeners.find((entry) => entry.event === "display-removed");
  assert.ok(removed, "display-removed is observed");

  window.bounds = { x: 2610, y: 19, width: 208, height: 120 };
  removed.listener();
  t.mock.timers.tick(750);
  await settle();
  assert.deepEqual(window.getBounds(), at(G95, "center"));

  // Windows moves it again after the burst settled: a later pass catches it.
  window.bounds = { x: 2610, y: 19, width: 208, height: 120 };
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(window.getBounds(), at(G95, "center"));

  // The passes are bounded: nothing runs after the last one.
  t.mock.timers.tick(2000);
  await settle();
  window.bounds = { x: 2610, y: 19, width: 208, height: 120 };
  t.mock.timers.tick(10000);
  await settle();
  assert.deepEqual(window.getBounds(), { x: 2610, y: 19, width: 208, height: 120 });
});

test("a display change never moves a pill that is being dragged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  env.screenListeners.length = 0;
  const { manager, window } = makeManager({ position: "center", visible: true });
  manager._listenForPlacementTopologyChanges();
  window.bounds = { x: 2610, y: 19, width: 208, height: 120 };
  env.dragActive = true;

  env.screenListeners.find((entry) => entry.event === "display-metrics-changed").listener();
  t.mock.timers.tick(4000);
  await settle();

  assert.deepEqual(window.getBounds(), { x: 2610, y: 19, width: 208, height: 120 });
});

test("Show me places the pill and tells the renderer to hold it visible", async () => {
  env.cursor = { x: 3000, y: 900 };
  const { manager, window } = makeManager({
    position: "middle-center",
    bounds: at(PG, "bottom-right"),
  });

  const result = await manager.previewFloatingIconPlacement();

  assert.deepEqual(result, { success: true });
  assert.deepEqual(window.getBounds(), at(G95, "middle-center"));
  assert.equal(window.visible, true);
  assert.deepEqual(
    window.sent.find((m) => m.channel === "floating-icon-placement-preview")?.payload,
    { durationMs: 2000 }
  );
});
