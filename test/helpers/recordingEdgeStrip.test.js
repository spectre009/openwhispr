const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EDGE_FRAME_IDLE_RELEASE_MS,
  EDGE_STRIP_IDLE_RELEASE_MS,
  EDGE_STRIP_PREVIEW_MS,
  RecordingEdgeStrip,
  buildEdgeStripPage,
  edgeStripUrl,
} = require("../../src/helpers/recordingEdgeStrip");

const G95 = {
  id: 1217155111,
  bounds: { x: 0, y: 0, width: 5672, height: 1596 },
  workArea: { x: 0, y: 0, width: 5672, height: 1548 },
};
const PG = { id: 2373425187, bounds: { x: -16, y: -1596, width: 2836, height: 1596 } };
const M32 = { id: 1564834236, bounds: { x: 2820, y: -1602, width: 2837, height: 1596 } };

// Lets the strip's loadURL promise callbacks run.
const settle = () => new Promise((resolve) => setImmediate(resolve));

class FakeContents {
  constructor() {
    this.listeners = new Map();
  }
  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(listener);
  }
  emit(event, ...args) {
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }
}

function harness({ displays = [PG, G95, M32], pill = G95, autoLoad = true, supported } = {}) {
  const env = { displays, pill, windows: [], timers: [], onTop: 0 };
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.visible = false;
      this.destroyed = false;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.log = [];
      this.webContents = new FakeContents();
      this.closedListeners = [];
      // Like Electron: each loadURL settles on its own, a newer one aborts the
      // one in flight, and only a finished load commits its URL.
      this.pending = null;
      this.committedUrl = "";
      env.windows.push(this);
    }
    setIgnoreMouseEvents(...args) {
      this.log.push(["ignoreMouse", ...args]);
    }
    setContentProtection(value) {
      this.log.push(["contentProtection", value]);
    }
    loadURL(url) {
      this.log.push(["load"]);
      if (this.pending)
        this.pending.reject(new Error("ERR_ABORTED (-3) loading " + this.pending.url));
      return new Promise((resolve, reject) => {
        this.pending = { url, resolve, reject };
        if (autoLoad) this.finishLoad();
      });
    }
    finishLoad() {
      const load = this.pending;
      if (!load || this.destroyed) return;
      this.pending = null;
      this.committedUrl = load.url;
      load.resolve();
    }
    setBounds(bounds) {
      this.bounds = { ...bounds };
      this.log.push(["setBounds", bounds]);
    }
    getBounds() {
      return { ...this.bounds };
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    showInactive() {
      this.visible = true;
      this.log.push(["showInactive"]);
    }
    show() {
      throw new Error("the strip must never take focus");
    }
    hide() {
      this.visible = false;
      this.log.push(["hide"]);
    }
    destroy() {
      this.destroyed = true;
      this.visible = false;
      if (this.pending) this.pending.reject(new Error("ERR_ABORTED (-3)"));
      this.pending = null;
      for (const listener of this.closedListeners) listener();
    }
    on(event, listener) {
      if (event === "closed") this.closedListeners.push(listener);
    }
  }
  const strip = new RecordingEdgeStrip({
    BrowserWindow: FakeWindow,
    screen: {
      getAllDisplays: () => env.displays,
      getPrimaryDisplay: () => G95,
    },
    getPillDisplay: () => env.pill,
    setupAlwaysOnTop: () => {
      env.onTop += 1;
    },
    windowType: "normal",
    supported,
    timers: {
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        env.timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        if (timer) timer.cleared = true;
      },
    },
  });
  const live = () => env.windows.filter((win) => !win.destroyed);
  const shown = () => live().filter((win) => win.visible);
  const runTimers = (ms) => {
    const due = env.timers.filter((timer) => ms === undefined || timer.ms === ms);
    env.timers = env.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) if (!timer.cleared) timer.fn();
  };
  const pendingTimers = (ms) => env.timers.filter((timer) => !timer.cleared && timer.ms === ms);
  return { env, strip, live, shown, runTimers, pendingTimers };
}

const ON = { color: "red", strip: "short", displays: "pill" };

test("off creates nothing, whatever the recording state", async () => {
  const { strip, env } = harness();
  strip.configure({ ...ON, strip: "off" });
  strip.setRecording(true);
  strip.setRecording(false);
  await settle();
  assert.equal(env.windows.length, 0);
});

test("turning the strip on creates no window until it first shows", async () => {
  const { strip, env } = harness();
  strip.configure({ ...ON, displays: "all" });
  await settle();
  assert.equal(env.windows.length, 0);
});

test("strip windows are click-through, focusless, protected and transparent", async () => {
  const { strip, env } = harness();
  strip.configure(ON);
  strip.setRecording(true);
  await settle();
  const [win] = env.windows;
  assert.ok(win);
  const { options } = win;
  assert.equal(options.transparent, true);
  assert.equal(options.frame, false);
  assert.equal(options.focusable, false);
  assert.equal(options.show, false);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.backgroundColor, "#00000000");
  assert.equal(options.type, "normal");
  assert.equal(options.webPreferences.javascript, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.preload, undefined);
  assert.deepEqual(
    win.log.filter(([kind]) => kind === "ignoreMouse"),
    [["ignoreMouse", true]]
  );
  assert.deepEqual(
    win.log.filter(([kind]) => kind === "contentProtection"),
    [["contentProtection", true]]
  );
  assert.ok(win.log.some(([kind]) => kind === "showInactive"));
});

test("the page is a steady, script-free bar in the accent, as an encoded data URL", () => {
  const page = buildEdgeStripPage({ accent: "#ef3b3b", mode: "short" });
  assert.ok(page.includes("#ef3b3b"));
  assert.ok(!/animation|@keyframes|transition/.test(page), "steady: every frame recomposites");
  assert.ok(!/<script/i.test(page));
  const url = edgeStripUrl(page);
  assert.ok(url.startsWith("data:text/html;charset=utf-8,"));
  assert.ok(!url.includes("#"), "a literal # would start a URL fragment");
  assert.equal(decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length)), page);
});

test("a recording shows the strip on the pill's monitor, without focus, at the exact box", async () => {
  const { strip, shown } = harness();
  strip.configure(ON);
  strip.setRecording(true);
  await settle();
  const visible = shown();
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].getBounds(), { x: 2136, y: 0, width: 1400, height: 8 });
  strip.setRecording(false);
  assert.equal(shown().length, 0);
  strip.setRecording(true);
  assert.equal(shown().length, 1, "a kept window shows again at once");
});

test("hidden strip windows are released after the idle period, and come back on the next recording", async () => {
  const { strip, env, live, shown, runTimers, pendingTimers } = harness();
  strip.configure({ ...ON, displays: "all" });
  strip.setRecording(true);
  await settle();
  assert.equal(pendingTimers(EDGE_STRIP_IDLE_RELEASE_MS).length, 0, "no release while showing");
  strip.setRecording(false);
  assert.equal(live().length, 3, "kept for the next dictation");
  assert.equal(pendingTimers(EDGE_STRIP_IDLE_RELEASE_MS).length, 1);
  // A dictation inside the idle period reuses the windows and cancels the release.
  strip.setRecording(true);
  assert.equal(shown().length, 3);
  assert.equal(pendingTimers(EDGE_STRIP_IDLE_RELEASE_MS).length, 0);
  strip.setRecording(false);
  runTimers(EDGE_STRIP_IDLE_RELEASE_MS);
  assert.equal(live().length, 0);
  strip.setRecording(true);
  await settle();
  assert.equal(shown().length, 3);
  assert.equal(env.windows.length, 6, "new windows after the release");
});

test("all monitors shows one strip per display, at each display's own top edge", async () => {
  const { strip, shown } = harness();
  strip.configure({ ...ON, displays: "all", strip: "full" });
  strip.setRecording(true);
  await settle();
  const boxes = shown()
    .map((win) => win.getBounds())
    .sort((a, b) => a.x - b.x);
  assert.deepEqual(boxes, [
    { x: -16, y: -1596, width: 2836, height: 8 },
    { x: 0, y: 0, width: 5672, height: 8 },
    { x: 2820, y: -1602, width: 2837, height: 8 },
  ]);
});

test("the pill's monitor is read when the strip shows, so it follows the pill", async () => {
  const { strip, env, shown } = harness();
  strip.configure(ON);
  env.pill = PG;
  strip.setRecording(true);
  await settle();
  assert.deepEqual(shown()[0].getBounds(), { x: -16 + 1064, y: -1596, width: 709, height: 8 });
  // Dragged to another monitor mid-recording.
  env.pill = M32;
  strip.refresh("drag");
  await settle();
  assert.equal(shown().length, 1);
  assert.equal(shown()[0].getBounds().x, 2820 + Math.round((2837 - 709) / 2));
});

test("a strip shows only once its page has loaded, and a late load after stop stays hidden", async () => {
  const { strip, env, shown } = harness({ autoLoad: false });
  strip.configure(ON);
  strip.setRecording(true);
  await settle();
  assert.equal(shown().length, 0, "not before the page loads");
  env.windows[0].finishLoad();
  await settle();
  assert.equal(shown().length, 1);

  const late = harness({ autoLoad: false });
  late.strip.configure(ON);
  late.strip.setRecording(true);
  late.strip.setRecording(false);
  late.env.windows[0].finishLoad();
  await settle();
  assert.equal(late.shown().length, 0);
});

test("a page replaced before it loads never shows; the replacement does", async () => {
  const { strip, env, shown } = harness({ autoLoad: false });
  strip.configure(ON);
  strip.setRecording(true);
  const [win] = env.windows;
  strip.configure({ ...ON, color: "#22c55e" });
  await settle();
  assert.equal(shown().length, 0, "the first page's load was aborted");
  win.finishLoad();
  await settle();
  assert.equal(shown().length, 1);
  assert.ok(decodeURIComponent(win.committedUrl).includes("#22c55e"));
});

test("a window destroyed before its page loads stays gone", async () => {
  const { strip, env, live } = harness({ autoLoad: false });
  strip.configure(ON);
  strip.setRecording(true);
  strip.configure({ ...ON, strip: "off" });
  env.windows[0].finishLoad();
  await settle();
  assert.equal(live().length, 0);
  assert.equal(env.windows.length, 1, "nothing recreated");
});

test("a settings change while recording reloads the page in place", async () => {
  const { strip, env, shown } = harness();
  strip.configure(ON);
  strip.setRecording(true);
  await settle();
  const before = env.windows[0].committedUrl;
  strip.configure({ ...ON, color: "#22c55e" });
  await settle();
  const after = env.windows[0].committedUrl;
  assert.notEqual(after, before);
  assert.ok(decodeURIComponent(after).includes("#22c55e"));
  assert.equal(shown().length, 1);
  assert.equal(env.windows.length, 1);
});

test("turning the strip off destroys its windows, even mid-recording", async () => {
  const { strip, live } = harness();
  strip.configure({ ...ON, displays: "all" });
  strip.setRecording(true);
  await settle();
  assert.equal(live().length, 3);
  strip.configure({ ...ON, strip: "off" });
  assert.equal(live().length, 0);
});

test("a removed display's window is destroyed; the others stay", async () => {
  const { strip, env, live, shown } = harness();
  strip.configure({ ...ON, displays: "all" });
  strip.setRecording(true);
  await settle();
  env.displays = [G95, M32];
  strip.handleDisplaysChanged();
  assert.equal(live().length, 2);
  assert.equal(shown().length, 2);
});

test("a preview shows its own settings and ends by itself", async () => {
  const { strip, shown, live, runTimers, env } = harness();
  strip.configure({ ...ON, strip: "off" });
  assert.equal(strip.preview({ ...ON, strip: "off" }), false, "nothing to preview while off");
  assert.equal(strip.preview(ON), true);
  await settle();
  assert.equal(shown().length, 1);
  assert.equal(env.timers[0].ms, EDGE_STRIP_PREVIEW_MS);
  runTimers();
  assert.equal(shown().length, 0);
  assert.equal(live().length, 0, "configured off, so the preview's window goes too");
});

test("a preview never takes over or ends a recording's strip", async () => {
  const { strip, shown, runTimers } = harness();
  strip.configure({ ...ON, displays: "all" });
  strip.setRecording(true);
  await settle();
  assert.equal(shown().length, 3);
  strip.preview({ ...ON, displays: "pill", color: "#22c55e" });
  await settle();
  assert.equal(shown().length, 3, "the recording keeps every monitor");
  runTimers();
  await settle();
  assert.equal(shown().length, 3, "the preview ending leaves the recording's strips");
});

test("a renderer crash drops that window, and the next show makes a new one", async () => {
  const { strip, env, live, shown } = harness();
  strip.configure(ON);
  strip.setRecording(true);
  await settle();
  env.windows[0].webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(live().length, 0);
  strip.setRecording(false);
  strip.setRecording(true);
  await settle();
  assert.equal(shown().length, 1);
});

test("an unsupported session never creates a window", async () => {
  const { strip, env } = harness({ supported: false });
  strip.configure(ON);
  strip.setRecording(true);
  assert.equal(strip.preview(ON), false);
  await settle();
  assert.equal(env.windows.length, 0);
});

test("release drops every window and the settings, but the strip works again afterwards", async () => {
  const { strip, live, shown, runTimers } = harness();
  strip.configure({ ...ON, displays: "all" });
  strip.setRecording(true);
  strip.preview(ON);
  await settle();
  strip.release();
  assert.equal(live().length, 0);
  runTimers();
  strip.refresh("placement");
  await settle();
  assert.equal(live().length, 0, "nothing comes back until settings are reported again");
  strip.configure(ON);
  strip.setRecording(true);
  await settle();
  assert.equal(shown().length, 1);
});

test("destroy removes every window and ignores later calls", async () => {
  const { strip, live } = harness();
  strip.configure({ ...ON, displays: "all" });
  strip.setRecording(true);
  await settle();
  strip.destroy();
  assert.equal(live().length, 0);
  strip.setRecording(false);
  strip.setRecording(true);
  strip.configure(ON);
  await settle();
  assert.equal(live().length, 0);
});

const FRAME = { color: "red", strip: "frame", displays: "all" };

test("a frame covers the work area of the floating icon's monitor only, whatever the monitors setting", async () => {
  const { strip, shown, live } = harness();
  strip.configure(FRAME);
  strip.setRecording(true);
  await settle();
  assert.equal(live().length, 1);
  assert.deepEqual(shown()[0].getBounds(), { x: 0, y: 0, width: 5672, height: 1548 });
});

test("the frame page is a steady ring in the accent, hidden from assistive tech", () => {
  const page = buildEdgeStripPage({ accent: "#ef3b3b", mode: "frame" });
  assert.ok(page.includes("inset 0 0 0 3px #ef3b3b"));
  assert.ok(page.includes("#ef3b3b8c"), "the soft glow is the accent at partial alpha");
  assert.ok(!/animation|@keyframes|transition/.test(page));
  assert.ok(page.includes('aria-hidden="true"'));
});

test("a frame left behind when the pill changes monitors is destroyed, not kept hidden", async () => {
  const { strip, env, live, shown } = harness();
  strip.configure(FRAME);
  strip.setRecording(true);
  await settle();
  env.pill = { ...PG, workArea: PG.bounds };
  strip.refresh("drag");
  await settle();
  assert.equal(live().length, 1, "only the new monitor's frame remains");
  assert.deepEqual(shown()[0].getBounds(), PG.bounds);
});

test("a hidden frame is released after the short frame grace", async () => {
  const { strip, live, pendingTimers, runTimers } = harness();
  strip.configure(FRAME);
  strip.setRecording(true);
  await settle();
  strip.setRecording(false);
  assert.equal(pendingTimers(EDGE_FRAME_IDLE_RELEASE_MS).length, 1);
  assert.equal(pendingTimers(EDGE_STRIP_IDLE_RELEASE_MS).length, 0);
  runTimers(EDGE_FRAME_IDLE_RELEASE_MS);
  assert.equal(live().length, 0);
});
