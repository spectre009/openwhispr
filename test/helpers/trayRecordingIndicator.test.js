const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const env = { scaleFactor: 1.354, drawn: 0 };
const debugLines = [];

class FakeImage {
  constructor(label, size = 256) {
    this.label = label;
    this.size = size;
  }
  isEmpty() {
    return false;
  }
  resize({ width }) {
    return new FakeImage(this.label, width);
  }
  toBitmap() {
    return Buffer.alloc(this.size * this.size * 4);
  }
}

const originalLoad = Module._load;
Module._load = function loadTrayWithStubs(request, parent, isMain) {
  if (request === "electron")
    return {
      Tray: class {},
      Menu: { buildFromTemplate: (template) => ({ template }) },
      nativeImage: {
        createFromBitmap: (buffer, { width }) => {
          env.drawn += 1;
          const image = new FakeImage("badged", width);
          image.bitmap = buffer;
          return image;
        },
      },
      app: { on: () => undefined },
      screen: { getPrimaryDisplay: () => ({ scaleFactor: env.scaleFactor }) },
    };
  if (request === "./debugLogger")
    return {
      info: () => undefined,
      debug: (message) => debugLines.push(message),
      warn: () => undefined,
    };
  if (request === "./i18nMain")
    return {
      i18nMain: {
        t: (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key),
      },
    };
  return originalLoad.call(this, request, parent, isMain);
};
const TrayManager = require("../../src/helpers/tray");
Module._load = originalLoad;

function harness({ platform } = {}) {
  const state = { dictating: false, settings: { color: "red", tray: true }, graphics: null };
  const log = [];
  const images = [];
  const trayManager = new TrayManager();
  trayManager.windowManager = {
    isDictationPanelVisible: () => false,
    isDictating: () => state.dictating,
    getRecordingIndicatorSettings: () => state.settings,
    graphicsMode: { getState: () => state.graphics },
  };
  const base = new FakeImage("base");
  trayManager._baseIcon = base;
  trayManager.tray = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    setImage: (image) => {
      log.push(["image", image.label, image.size]);
      images.push(image);
    },
    setToolTip: (text) => log.push(["tooltip", text]),
    setContextMenu: (menu) => log.push(["menu", menu.template]),
  };
  if (platform) Object.defineProperty(process, "platform", { value: platform });
  const after = () => trayManager._stopTooltipTimer();
  return { state, log, images, trayManager, base, after };
}

const lastOf = (log, kind) => log.filter(([k]) => k === kind).at(-1);
const realPlatform = process.platform;
test.afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform }));

test("a recording badges the icon at the tray's pixel size and times the tooltip", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.dictating = true;
  trayManager.updateTrayIcon();
  assert.deepEqual(lastOf(log, "image"), ["image", "badged", 22]);
  assert.match(lastOf(log, "tooltip")[1], /^tray\.recordingTooltip .*"elapsed":"0:00"/);
  assert.ok(trayManager._tooltipTimer, "the tooltip ticks while recording");

  state.dictating = false;
  trayManager.updateTrayIcon();
  assert.deepEqual(lastOf(log, "image"), ["image", "base", 256], "the original icon comes back");
  assert.equal(lastOf(log, "tooltip")[1], "tray.tooltip");
  assert.equal(trayManager._tooltipTimer, null);
  after();
});

test("with the setting off, a recording leaves the icon and tooltip alone", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.settings = { color: "red", tray: false };
  state.dictating = true;
  trayManager.updateTrayIcon();
  assert.equal(lastOf(log, "image"), undefined);
  assert.equal(lastOf(log, "tooltip")[1], "tray.tooltip");
  assert.equal(trayManager._tooltipTimer, null);
  after();
});

test("turning the setting off mid-recording restores the icon", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.dictating = true;
  trayManager.updateTrayIcon();
  state.settings = { color: "red", tray: false };
  trayManager.updateTrayIcon();
  assert.deepEqual(lastOf(log, "image"), ["image", "base", 256]);
  after();
});

test("the elapsed time counts from the recording's start across menu rebuilds", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.dictating = true;
  trayManager.updateTrayIcon();
  trayManager._recordingStartedAt -= 65_000;
  trayManager.updateTrayMenu();
  assert.match(lastOf(log, "tooltip")[1], /"elapsed":"1:05"/);
  trayManager.updateTrayIcon();
  assert.match(lastOf(log, "tooltip")[1], /"elapsed":"1:05"/, "the start time is kept");
  after();
});

test("the badge is drawn in the recording color and cached per size and color", () => {
  const { state, trayManager, after } = harness({ platform: "win32" });
  state.dictating = true;
  const first = trayManager._badgedIcon("green");
  assert.equal(trayManager._badgedIcon("green"), first);
  const center = Math.round(22 - 22 * 0.24);
  const i = (center * 22 + center) * 4;
  assert.deepEqual([...first.bitmap.subarray(i, i + 4)], [0x5e, 0xc5, 0x22, 255]);
  assert.notEqual(trayManager._badgedIcon("blue"), first);
  env.scaleFactor = 2;
  assert.equal(trayManager._badgedIcon("blue").size, 32);
  env.scaleFactor = 1.354;
  after();
});

test("the tooltip counts from the window manager's start time when it has one", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.dictating = true;
  trayManager.windowManager.getRecordingStartedAt = () => Date.now() - 125_000;
  trayManager.updateTrayIcon();
  assert.match(lastOf(log, "tooltip")[1], /"elapsed":"2:05"/);
  after();
});

test("with color by mode, the badge takes the recording's mode color", () => {
  const { state, trayManager, after } = harness({ platform: "win32" });
  const drawn = [];
  trayManager._badgedIcon = (color) => {
    drawn.push(color);
    return new FakeImage("badged", 22);
  };
  state.dictating = true;
  state.settings = { color: "red", tray: true, colorByMode: true, assistantColor: "pink" };
  trayManager.windowManager.getDictationInputKind = () => "assistant";
  trayManager.updateTrayIcon();
  trayManager.windowManager.getDictationInputKind = () => "dictation";
  trayManager.updateTrayIcon();
  state.settings = { ...state.settings, colorByMode: false };
  trayManager.windowManager.getDictationInputKind = () => "assistant";
  trayManager.updateTrayIcon();
  assert.deepEqual(drawn, ["pink", "red", "red"]);
  after();
});

test("macOS keeps its template icon and gets the tooltip only", () => {
  const { state, log, trayManager, after } = harness({ platform: "darwin" });
  state.dictating = true;
  trayManager.updateTrayIcon();
  assert.equal(lastOf(log, "image"), undefined);
  assert.match(lastOf(log, "tooltip")[1], /^tray\.recordingTooltip/);
  after();
});

test("a destroyed tray is left alone and stops the tooltip timer", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.dictating = true;
  trayManager.updateTrayIcon();
  trayManager.tray.destroyed = true;
  log.length = 0;
  trayManager.updateTrayIcon();
  trayManager.updateTrayMenu();
  assert.deepEqual(log, []);
  assert.equal(trayManager._tooltipTimer, null);
  after();
});

// Graphics fallback: Chromium gave up on the GPU, so the pill and frame stutter.
const FALLBACK = Object.freeze({ mode: "software", reason: "fallback" });
const REQUESTED = Object.freeze({
  mode: "software",
  reason: "requested",
  requestedBy: "--disable-gpu",
});
const HARDWARE = Object.freeze({ mode: "hardware", reason: null });
const UNKNOWN = Object.freeze({ mode: "unknown", reason: null });

// The dot's center pixel (BGRA) in the last badged image the tray showed.
function dotPixel(images) {
  const image = images.at(-1);
  const center = Math.round(image.size - image.size * 0.24);
  const i = (center * image.size + center) * 4;
  return [...image.bitmap.subarray(i, i + 4)];
}
const AMBER = [0x24, 0xa5, 0xf5, 255];
const RED = [0x3b, 0x3b, 0xef, 255];

test("a graphics fallback puts an amber dot on the icon and the warning in the tooltip", () => {
  const { state, log, images, trayManager, after } = harness({ platform: "win32" });
  state.graphics = FALLBACK;
  trayManager.updateTrayIcon();
  assert.deepEqual(lastOf(log, "image"), ["image", "badged", 22]);
  assert.deepEqual(dotPixel(images), AMBER);
  assert.equal(lastOf(log, "tooltip")[1], "tray.graphicsFallbackTooltip");
  assert.equal(trayManager._tooltipTimer, null, "nothing ticks");

  state.graphics = HARDWARE;
  trayManager.updateTrayIcon();
  assert.deepEqual(lastOf(log, "image"), ["image", "base", 256], "the graphics card is back");
  assert.equal(lastOf(log, "tooltip")[1], "tray.tooltip");
  after();
});

test("the recording dot wins while it shows, and the amber dot comes back after", () => {
  const { state, log, images, trayManager, after } = harness({ platform: "win32" });
  state.graphics = FALLBACK;
  trayManager.updateTrayIcon();
  state.dictating = true;
  trayManager.updateTrayIcon();
  assert.deepEqual(dotPixel(images), RED);
  assert.match(lastOf(log, "tooltip")[1], /^tray\.recordingTooltip/);

  state.dictating = false;
  trayManager.updateTrayIcon();
  assert.deepEqual(lastOf(log, "image"), ["image", "badged", 22]);
  assert.deepEqual(dotPixel(images), AMBER);
  assert.equal(lastOf(log, "tooltip")[1], "tray.graphicsFallbackTooltip");
  after();
});

test("with the recording setting off, the amber dot stays through a recording", () => {
  const { state, log, images, trayManager, after } = harness({ platform: "win32" });
  state.settings = { color: "red", tray: false };
  state.graphics = FALLBACK;
  state.dictating = true;
  trayManager.updateTrayIcon();
  assert.deepEqual(dotPixel(images), AMBER);
  assert.equal(lastOf(log, "tooltip")[1], "tray.graphicsFallbackTooltip");
  assert.equal(trayManager._tooltipTimer, null);
  after();
});

test("a software mode a launch flag asked for, or no report yet, shows no warning", () => {
  for (const graphics of [REQUESTED, UNKNOWN, HARDWARE, null]) {
    const { state, log, trayManager, after } = harness({ platform: "win32" });
    state.graphics = graphics;
    trayManager.updateTrayIcon();
    trayManager.updateTrayMenu();
    assert.equal(lastOf(log, "image"), undefined, graphics?.mode ?? "null");
    assert.equal(lastOf(log, "tooltip")[1], "tray.tooltip");
    assert.equal(lastOf(log, "menu")[1][0].label, "app.commandMenu.startListening");
    after();
  }
});

test("macOS keeps its template icon in a fallback and still gets the warning tooltip", () => {
  const { state, log, trayManager, after } = harness({ platform: "darwin" });
  state.graphics = FALLBACK;
  trayManager.updateTrayIcon();
  assert.equal(lastOf(log, "image"), undefined);
  assert.equal(lastOf(log, "tooltip")[1], "tray.graphicsFallbackTooltipMac");
  state.dictating = true;
  trayManager.updateTrayIcon();
  assert.match(lastOf(log, "tooltip")[1], /^tray\.recordingTooltip/, "the recording's wins");
  after();
});

test("the two dots are cached apart, so taking turns doesn't redraw them", () => {
  const { state, trayManager, after } = harness({ platform: "win32" });
  env.drawn = 0;
  state.graphics = FALLBACK;
  for (const dictating of [false, true, false, true, false]) {
    state.dictating = dictating;
    trayManager.updateTrayIcon();
  }
  assert.equal(env.drawn, 2);
  after();
});

test("the badge changes are logged, the graphics warning's as its own", () => {
  const { state, trayManager, after } = harness({ platform: "win32" });
  debugLines.length = 0;
  state.graphics = FALLBACK;
  trayManager.updateTrayIcon();
  trayManager.updateTrayIcon();
  state.dictating = true;
  trayManager.updateTrayIcon();
  state.dictating = false;
  trayManager.updateTrayIcon();
  state.graphics = HARDWARE;
  trayManager.updateTrayIcon();
  assert.deepEqual(debugLines, [
    "Tray graphics warning shown",
    "Tray graphics warning removed",
    "Tray recording badge shown",
    "Tray recording badge removed",
    "Tray graphics warning shown",
    "Tray graphics warning removed",
  ]);
  after();
});

test("a change of graphics mode updates the icon, the tooltip and the menu", () => {
  const { state, log, images, trayManager, after } = harness({ platform: "win32" });
  trayManager.onGraphicsModeChanged();
  assert.equal(lastOf(log, "image"), undefined);
  state.graphics = FALLBACK;
  trayManager.onGraphicsModeChanged();
  assert.deepEqual(dotPixel(images), AMBER);
  assert.equal(lastOf(log, "tooltip")[1], "tray.graphicsFallbackTooltip");
  assert.equal(lastOf(log, "menu")[1][0].label, "⚠ tray.graphicsFallback.title");
  state.graphics = HARDWARE;
  trayManager.onGraphicsModeChanged();
  assert.deepEqual(lastOf(log, "image"), ["image", "base", 256]);
  assert.equal(lastOf(log, "menu")[1][0].label, "app.commandMenu.startListening");
  after();
});
