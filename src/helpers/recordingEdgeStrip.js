const {
  normalizeRecordingIndicatorSettings,
  resolveEdgeStripBounds,
  resolveRecordingAccent,
} = require("./recordingIndicator");

const EDGE_STRIP_PREVIEW_MS = 3000;
// Strip windows stay for a while after the strip last hid, so back-to-back
// dictations reuse them, then go: each holds its own renderer (~20 MB private,
// measured on Windows). A frame covers the work area, and a hidden window keeps
// its surface (the GPU process grew by ~260 MB for one on a 5672 DIP display at
// 135%), so it goes much sooner.
const EDGE_STRIP_IDLE_RELEASE_MS = 5 * 60 * 1000;
const EDGE_FRAME_IDLE_RELEASE_MS = 30 * 1000;

// A few DIP tall, transparent, never focusable and click-through: the strip
// must never take a click or the keyboard from the app being dictated into.
// JavaScript is off; the page is CSS only. On Windows the native window ends
// up taller than asked (64 px measured at 135%); the rest is transparent and
// click-through, and the page draws at its top.
const EDGE_STRIP_WINDOW_OPTIONS = Object.freeze({
  frame: false,
  transparent: true,
  backgroundColor: "#00000000",
  show: false,
  focusable: false,
  skipTaskbar: true,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  hasShadow: false,
  thickFrame: false,
  alwaysOnTop: true,
  webPreferences: Object.freeze({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    javascript: false,
    spellcheck: false,
  }),
});

/**
 * The overlay's page, steady on purpose: a transparent window is
 * recomposited on every animation frame, and three breathing strips cost the
 * GPU process about a fifth of a core while recording. A strip is a 4 DIP bar
 * in the accent with a dark hairline under it (so it still reads on a
 * background of its own color) and a glow that fades out within the window.
 * A frame is a 3 DIP ring around the window's edge with a dark hairline
 * inside and a soft inner glow. The accent is a validated #rrggbb.
 */
function buildEdgeStripPage({ accent, mode }) {
  const base = "html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}";
  if (mode === "frame") {
    return page(
      base +
        `.s{position:absolute;inset:0;box-shadow:inset 0 0 0 3px ${accent},` +
        `inset 0 0 0 4px rgba(0,0,0,.35),inset 0 0 26px 6px ${accent}8c}`
    );
  }
  const inset = mode === "short" ? 6 : 0;
  const radius = mode === "short" ? "0 0 4px 4px" : "0";
  return page(
    base +
      `.s{position:absolute;top:0;left:${inset}px;right:${inset}px;height:4px;border-radius:${radius};` +
      `background:${accent};box-shadow:0 1px 0 rgba(0,0,0,.35),0 0 6px 1px ${accent}}`
  );
}

function page(css) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="s" aria-hidden="true"></div></body></html>`;
}

// Encoded whole: a literal "#" in the CSS would otherwise start a fragment.
function edgeStripUrl(page) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
}

/**
 * One small overlay window per display that shows the strip. Windows are
 * created when the strip first shows and kept hidden between recordings until
 * it has been idle for EDGE_STRIP_IDLE_RELEASE_MS. The strip shows while a
 * recording is live or a preview runs; a recording keeps its own strip, so a
 * preview never replaces or ends it.
 */
class RecordingEdgeStrip {
  constructor({
    BrowserWindow,
    screen,
    getPillDisplay,
    setupAlwaysOnTop = () => undefined,
    windowType,
    logger,
    supported = true,
    timers = { setTimeout, clearTimeout },
  }) {
    this._BrowserWindow = BrowserWindow;
    this._screen = screen;
    this._getPillDisplay = getPillDisplay;
    this._setupAlwaysOnTop = setupAlwaysOnTop;
    this._windowType = windowType;
    this._logger = logger;
    this._supported = supported;
    this._timers = timers;
    this._settings = normalizeRecordingIndicatorSettings(null);
    this._recording = false;
    this._preview = null;
    this._idleTimer = null;
    this._lastShownMode = null;
    this._windows = new Map();
    this._destroyed = false;
    this._loggedUnsupported = false;
  }

  configure(settings) {
    this._settings = normalizeRecordingIndicatorSettings(settings);
    this._apply("settings");
  }

  setRecording(recording) {
    const next = Boolean(recording);
    if (next === this._recording) return;
    this._recording = next;
    this._apply(next ? "recording" : "stopped");
  }

  // Shows the strip with `settings` for a moment. The preview carries its own
  // settings, so it never waits for the dictation window to report a change.
  preview(settings, durationMs = EDGE_STRIP_PREVIEW_MS) {
    const normalized = normalizeRecordingIndicatorSettings(settings);
    if (this._destroyed || !this._isSupported() || normalized.strip === "off") return false;
    if (this._preview) this._timers.clearTimeout(this._preview.timer);
    const preview = { settings: normalized, timer: null };
    preview.timer = this._timers.setTimeout(() => {
      if (this._preview !== preview) return;
      this._preview = null;
      this._apply("preview-ended");
    }, durationMs);
    this._preview = preview;
    this._apply("preview");
    return true;
  }

  // The pill moved (placement, drag) or the displays changed: re-place a
  // visible strip and drop windows whose display is gone.
  refresh(reason = "refresh") {
    this._apply(reason);
  }

  handleDisplaysChanged() {
    this._apply("displays-changed");
  }

  // The dictation window is gone: drop every strip window, so hidden strips
  // never keep the app alive or count as its windows, and forget the settings
  // until a new dictation window reports them. Unlike destroy(), the strip
  // works again afterwards.
  release() {
    this._clearPreview();
    this._recording = false;
    this._settings = normalizeRecordingIndicatorSettings(null);
    this._destroyAll();
  }

  destroy() {
    this._destroyed = true;
    this._clearPreview();
    this._destroyAll();
  }

  _clearPreview() {
    if (this._preview) this._timers.clearTimeout(this._preview.timer);
    this._preview = null;
  }

  _isSupported() {
    if (this._supported) return true;
    if (!this._loggedUnsupported) {
      this._loggedUnsupported = true;
      this._logger?.info?.(
        "[RecordingEdgeStrip] Not supported in this session; the strip stays off",
        {},
        "window"
      );
    }
    return false;
  }

  // The settings the strip shows with now, or null when it is hidden.
  _activeSettings() {
    if (this._recording && this._settings.strip !== "off") return this._settings;
    if (this._preview) return this._preview.settings;
    return null;
  }

  _apply(reason) {
    if (this._destroyed) return;
    const active = this._activeSettings();
    if (!active) {
      if (this._settings.strip === "off") {
        this._destroyAll();
        return;
      }
      this._pruneDisconnected(this._screen.getAllDisplays());
      for (const { win } of this._windows.values()) if (win.isVisible()) win.hide();
      this._scheduleIdleRelease();
      return;
    }
    if (!this._isSupported()) return;
    this._cancelIdleRelease();

    const displays = this._screen.getAllDisplays();
    this._pruneDisconnected(displays);
    const targets = this._targetDisplays(active, displays);
    const targetIds = new Set(targets.map((display) => String(display.id)));
    const url = edgeStripUrl(
      buildEdgeStripPage({ accent: resolveRecordingAccent(active.color), mode: active.strip })
    );

    for (const display of targets) {
      const id = String(display.id);
      const bounds = resolveEdgeStripBounds(display, active.strip);
      const entry = this._windows.get(id) || this._createWindow(id, bounds);
      if (!entry) continue;
      if (entry.url !== url) this._load(id, entry, url);
      // The exact box on every show: at fractional scaling each setBounds
      // rounds, so reported bounds are never fed back.
      entry.win.setBounds(bounds);
      if (entry.loaded && !entry.win.isVisible()) {
        this._setupAlwaysOnTop(entry.win);
        entry.win.showInactive();
        this._logger?.debug?.(
          "[RecordingEdgeStrip] Showing strip",
          { reason, displayId: id, mode: active.strip, bounds, actual: entry.win.getBounds() },
          "window"
        );
      }
    }

    for (const [id, entry] of [...this._windows]) {
      if (targetIds.has(id)) continue;
      // A frame left behind on another monitor holds a work-area surface.
      if (active.strip === "frame") this._destroyWindow(id);
      else if (entry.win.isVisible()) entry.win.hide();
    }
    this._lastShownMode = active.strip;
  }

  _load(id, entry, url) {
    entry.url = url;
    entry.loaded = false;
    // The promise settles for this load only: Electron rejects it with
    // ERR_ABORTED when a newer page replaces it. Comparing getURL() instead
    // would depend on how Chromium canonicalizes a long data: URL.
    entry.win.loadURL(url).then(
      () => {
        if (this._windows.get(id) !== entry || entry.url !== url) return;
        entry.loaded = true;
        // The state may have moved on while the page loaded: show it only if
        // a recording or preview still wants it.
        this._apply("loaded");
      },
      (error) => {
        // A newer page replacing this one aborts its load; that's expected.
        if (this._windows.get(id) === entry && entry.url === url) {
          this._logger?.warn?.(
            "[RecordingEdgeStrip] Strip page failed to load",
            { displayId: id, error: error?.message },
            "window"
          );
        }
      }
    );
  }

  _targetDisplays(settings, displays) {
    // A frame only ever outlines the floating icon's monitor.
    if (settings.displays === "all" && settings.strip !== "frame") return displays;
    const pill = this._getPillDisplay?.();
    const match = pill && displays.find((display) => display.id === pill.id);
    const display = match || this._screen.getPrimaryDisplay?.() || displays[0];
    return display ? [display] : [];
  }

  _pruneDisconnected(displays) {
    const connected = new Set(displays.map((display) => String(display.id)));
    for (const id of [...this._windows.keys()]) {
      if (!connected.has(id)) this._destroyWindow(id);
    }
  }

  _scheduleIdleRelease() {
    if (this._idleTimer || this._windows.size === 0) return;
    const delay =
      this._lastShownMode === "frame" ? EDGE_FRAME_IDLE_RELEASE_MS : EDGE_STRIP_IDLE_RELEASE_MS;
    this._idleTimer = this._timers.setTimeout(() => {
      this._idleTimer = null;
      if (this._activeSettings()) return;
      this._logger?.debug?.("[RecordingEdgeStrip] Releasing idle strip windows", {}, "window");
      this._destroyAll();
    }, delay);
  }

  _cancelIdleRelease() {
    if (!this._idleTimer) return;
    this._timers.clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  _createWindow(id, bounds) {
    let win;
    try {
      win = new this._BrowserWindow({
        ...EDGE_STRIP_WINDOW_OPTIONS,
        ...(this._windowType ? { type: this._windowType } : {}),
        ...bounds,
      });
    } catch (error) {
      this._logger?.warn?.(
        "[RecordingEdgeStrip] Could not create the strip window",
        { displayId: id, error: error?.message },
        "window"
      );
      return null;
    }
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    this._setupAlwaysOnTop(win);

    const entry = { win, url: null, loaded: false };
    win.webContents.on("render-process-gone", (_event, details) => {
      this._logger?.warn?.(
        "[RecordingEdgeStrip] Strip renderer gone",
        { displayId: id, reason: details?.reason },
        "window"
      );
      // Recreated by the next show, not now, so a crashing page can't loop.
      if (this._windows.get(id) === entry) this._destroyWindow(id);
    });
    win.on("closed", () => {
      if (this._windows.get(id) === entry) this._windows.delete(id);
    });
    this._windows.set(id, entry);
    this._logger?.debug?.(
      "[RecordingEdgeStrip] Created strip window",
      { displayId: id, bounds },
      "window"
    );
    return entry;
  }

  _destroyWindow(id) {
    const entry = this._windows.get(id);
    this._windows.delete(id);
    if (entry && !entry.win.isDestroyed()) entry.win.destroy();
  }

  _destroyAll() {
    this._cancelIdleRelease();
    for (const id of [...this._windows.keys()]) this._destroyWindow(id);
  }
}

module.exports = {
  EDGE_FRAME_IDLE_RELEASE_MS,
  EDGE_STRIP_IDLE_RELEASE_MS,
  EDGE_STRIP_PREVIEW_MS,
  EDGE_STRIP_WINDOW_OPTIONS,
  RecordingEdgeStrip,
  buildEdgeStripPage,
  edgeStripUrl,
};
