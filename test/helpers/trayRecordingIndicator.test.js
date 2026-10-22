const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const env = { scaleFactor: 1.354 };

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
          const image = new FakeImage("badged", width);
          image.bitmap = buffer;
          return image;
        },
      },
      app: { on: () => undefined },
      screen: { getPrimaryDisplay: () => ({ scaleFactor: env.scaleFactor }) },
    };
  if (request === "./debugLogger")
    return { info: () => undefined, debug: () => undefined, warn: () => undefined };
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
  const state = { dictating: false, settings: { color: "red", tray: true } };
  const log = [];
  const trayManager = new TrayManager();
  trayManager.windowManager = {
    isDictationPanelVisible: () => false,
    isDictating: () => state.dictating,
    getRecordingIndicatorSettings: () => state.settings,
  };
  const base = new FakeImage("base");
  trayManager._baseIcon = base;
  trayManager.tray = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    setImage: (image) => log.push(["image", image.label, image.size]),
    setToolTip: (text) => log.push(["tooltip", text]),
    setContextMenu: () => undefined,
  };
  if (platform) Object.defineProperty(process, "platform", { value: platform });
  const after = () => trayManager._stopTooltipTimer();
  return { state, log, trayManager, base, after };
}

const lastOf = (log, kind) => log.filter(([k]) => k === kind).at(-1);
const realPlatform = process.platform;
test.afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform }));

test("a recording badges the icon at the tray's pixel size and times the tooltip", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.dictating = true;
  trayManager.updateRecordingIndicator();
  assert.deepEqual(lastOf(log, "image"), ["image", "badged", 22]);
  assert.match(lastOf(log, "tooltip")[1], /^tray\.recordingTooltip .*"elapsed":"0:00"/);
  assert.ok(trayManager._tooltipTimer, "the tooltip ticks while recording");

  state.dictating = false;
  trayManager.updateRecordingIndicator();
  assert.deepEqual(lastOf(log, "image"), ["image", "base", 256], "the original icon comes back");
  assert.equal(lastOf(log, "tooltip")[1], "tray.tooltip");
  assert.equal(trayManager._tooltipTimer, null);
  after();
});

test("with the setting off, a recording leaves the icon and tooltip alone", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.settings = { color: "red", tray: false };
  state.dictating = true;
  trayManager.updateRecordingIndicator();
  assert.equal(lastOf(log, "image"), undefined);
  assert.equal(lastOf(log, "tooltip")[1], "tray.tooltip");
  assert.equal(trayManager._tooltipTimer, null);
  after();
});

test("turning the setting off mid-recording restores the icon", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.dictating = true;
  trayManager.updateRecordingIndicator();
  state.settings = { color: "red", tray: false };
  trayManager.updateRecordingIndicator();
  assert.deepEqual(lastOf(log, "image"), ["image", "base", 256]);
  after();
});

test("the elapsed time counts from the recording's start across menu rebuilds", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.dictating = true;
  trayManager.updateRecordingIndicator();
  trayManager._recordingStartedAt -= 65_000;
  trayManager.updateTrayMenu();
  assert.match(lastOf(log, "tooltip")[1], /"elapsed":"1:05"/);
  trayManager.updateRecordingIndicator();
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
  trayManager.updateRecordingIndicator();
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
  trayManager.updateRecordingIndicator();
  trayManager.windowManager.getDictationInputKind = () => "dictation";
  trayManager.updateRecordingIndicator();
  state.settings = { ...state.settings, colorByMode: false };
  trayManager.windowManager.getDictationInputKind = () => "assistant";
  trayManager.updateRecordingIndicator();
  assert.deepEqual(drawn, ["pink", "red", "red"]);
  after();
});

test("macOS keeps its template icon and gets the tooltip only", () => {
  const { state, log, trayManager, after } = harness({ platform: "darwin" });
  state.dictating = true;
  trayManager.updateRecordingIndicator();
  assert.equal(lastOf(log, "image"), undefined);
  assert.match(lastOf(log, "tooltip")[1], /^tray\.recordingTooltip/);
  after();
});

test("a destroyed tray is left alone and stops the tooltip timer", () => {
  const { state, log, trayManager, after } = harness({ platform: "win32" });
  state.dictating = true;
  trayManager.updateRecordingIndicator();
  trayManager.tray.destroyed = true;
  log.length = 0;
  trayManager.updateRecordingIndicator();
  trayManager.updateTrayMenu();
  assert.deepEqual(log, []);
  assert.equal(trayManager._tooltipTimer, null);
  after();
});
