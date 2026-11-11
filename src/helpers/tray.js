const { Tray, Menu, nativeImage, app, screen, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");
const { i18nMain } = require("./i18nMain");
const { drawRecordingBadge, formatRecordingElapsed } = require("./trayRecordingBadge");
const { resolveRecordingAccent, resolveRecordingModeColor } = require("./recordingIndicator");
const { graphicsModeLabel, isSoftwareFallback } = require("./graphicsMode");
const { windowsTrayIdentity } = require("../../package.json");

// The dot on the tray icon while Chromium has fallen back to drawing on the CPU.
const GRAPHICS_WARNING_ACCENT = "#f5a524";
// Settings › System › Diagnostics, at its graphics warning.
const GRAPHICS_SETTINGS_DESTINATION = "system#system.diagnostics.graphics";
// Badged bitmaps kept, one per size and color: the recording dot and the
// graphics warning take turns without redrawing.
const BADGE_CACHE_LIMIT = 4;
const BADGE_LOG = {
  recording: { shown: "Tray recording badge shown", removed: "Tray recording badge removed" },
  graphics: { shown: "Tray graphics warning shown", removed: "Tray graphics warning removed" },
};

// Permanent identity for signed production Windows builds; keep across releases.
// Windows binds an unsigned executable's GUID to its path, so only builds from the
// signed config, which sets windowsTrayIdentity, may use it.
const WINDOWS_PRODUCTION_TRAY_GUID = "9afd9bd5-53da-42ef-8334-6e2b494c66fe";

// macOS saves the menu-bar position under this GUID, so changing it resets every
// user's placement. Electron lowercases the GUID before handing it to macOS, so
// it stays lowercase here or the position key below matches no item.
const MACOS_TRAY_GUID = "eb809902-04b5-5b08-b12a-f81d6f27e185";
const MACOS_TRAY_POSITION_KEY = `NSStatusItem Preferred Position ${MACOS_TRAY_GUID}`;

const ACCELERATOR_MODIFIERS = new Set([
  "commandorcontrol",
  "cmdorctrl",
  "command",
  "cmd",
  "control",
  "ctrl",
  "alt",
  "option",
  "altgr",
  "shift",
  "super",
  "meta",
]);
const ACCELERATOR_KEY =
  /^([A-Za-z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|PrintScreen|Plus|[`\-=[\];',./\\])$/;

/**
 * Whether a hotkey reads as a menu accelerator: modifiers and one ordinary
 * key. Modifier-only keys, Globe, mouse buttons and side-specific modifiers
 * (which only the native listeners watch) aren't.
 */
function isMenuAccelerator(hotkey) {
  if (typeof hotkey !== "string" || !hotkey) return false;
  const parts = hotkey.split("+");
  const key = parts.pop();
  return (
    ACCELERATOR_KEY.test(key) &&
    parts.every((part) => ACCELERATOR_MODIFIERS.has(part.toLowerCase()))
  );
}

const MENU_KEY_NAMES = { Control: "Ctrl", Ctrl: "Ctrl", Command: "Cmd", Cmd: "Cmd", GLOBE: "Fn" };

/** A hotkey Electron can't show as an accelerator, written out for the menu label. */
function hotkeyMenuLabel(hotkey, platform = process.platform) {
  const superName = platform === "darwin" ? "Cmd" : platform === "win32" ? "Win" : "Super";
  return hotkey
    .split("+")
    .map((part) => {
      const match = /^(Right|Left)?(.+)$/.exec(part);
      if (!match) return part;
      const [, side, name] = match;
      const shown = ["Super", "Meta", "Win"].includes(name)
        ? superName
        : (MENU_KEY_NAMES[name] ?? name);
      return side ? `${side} ${shown}` : shown;
    })
    .join("+");
}

class TrayManager {
  constructor() {
    this.tray = null;
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.windowManager = null;
    this.attachedControlPanels = new WeakSet();
    // The icon as loaded (a multi-size .ico on Windows), restored when no dot
    // shows; a badged copy is a single bitmap.
    this._baseIcon = null;
    this._badgeCache = new Map();
    // "recording", "graphics" or null: the dot the icon carries.
    this._badgeKind = null;
    this._recordingStartedAt = null;
    this._tooltipTimer = null;
    // Set by main.js: the shared restart (appRelaunch.js) and whether a
    // meeting is being recorded.
    this._relaunch = null;
    this._isMeetingRecording = null;
    app.on("before-quit", () => this._stopTooltipTimer());
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;

    if (this.mainWindow) {
      this.mainWindow.on("show", () => this.updateTrayMenu?.());
      this.mainWindow.on("hide", () => this.updateTrayMenu?.());
      this.mainWindow.on("minimize", () => this.updateTrayMenu?.());
      this.mainWindow.on("restore", () => this.updateTrayMenu?.());
    }

    if (this.controlPanelWindow) {
      this.attachControlPanelListeners(this.controlPanelWindow);
    }

    this.updateTrayMenu?.();
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
  }

  setRestartControls({ relaunch, isMeetingRecording } = {}) {
    this._relaunch = relaunch ?? null;
    this._isMeetingRecording = isMeetingRecording ?? null;
  }

  setCreateControlPanelCallback(callback) {
    this.createControlPanelCallback = callback;
  }

  attachControlPanelListeners(window) {
    if (!window || this.attachedControlPanels.has(window)) {
      return;
    }

    this.attachedControlPanels.add(window);

    window.on("show", () => {
      this.updateTrayMenu?.();
    });

    window.on("hide", () => {
      this.updateTrayMenu?.();
    });

    window.on("minimize", () => {
      this.updateTrayMenu?.();
    });

    window.on("restore", () => {
      this.updateTrayMenu?.();
    });

    window.on("destroyed", () => {
      this.controlPanelWindow = null;
      this.updateTrayMenu?.();
    });
  }

  syncControlPanelWindow() {
    if (this.windowManager) {
      this.controlPanelWindow = this.windowManager.controlPanelWindow || this.controlPanelWindow;
    }
    this.attachControlPanelListeners(this.controlPanelWindow);
    return this.controlPanelWindow;
  }

  isControlPanelVisible() {
    const win = this.syncControlPanelWindow();
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  }

  // On Linux a window parked on another workspace still reports as visible, so
  // the first click hides it and the next re-shows it on the current workspace.
  async toggleControlPanelFromTray() {
    if (this.isControlPanelVisible()) {
      this.windowManager?.hideControlPanelToTray();
      return;
    }

    await this.showControlPanelFromTray();
  }

  async showControlPanelFromTray() {
    try {
      this.syncControlPanelWindow();

      if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
        this.windowManager.showControlPanel();
        if (this.controlPanelWindow.webContents.isCrashed()) {
          this.controlPanelWindow.webContents.reload();
        }
        return;
      }

      if (this.createControlPanelCallback) {
        await this.createControlPanelCallback();
        this.syncControlPanelWindow();
        this.windowManager.showControlPanel();
        return;
      }

      debugLogger.error("No control panel callback available", undefined, "tray");
    } catch (error) {
      debugLogger.error("Failed to open control panel", { error: error?.message }, "tray");
    }
  }

  async createTray() {
    try {
      const trayIcon = await this.loadTrayIcon();
      if (!trayIcon || trayIcon.isEmpty()) {
        debugLogger.error("Failed to load tray icon", undefined, "tray");
        return;
      }

      if (process.platform === "darwin") {
        // The position key is an undocumented AppKit default, so placement is best
        // effort. Position 0 starts the icon as far right as macOS allows, beside
        // the system icons. A registered default only fills in for a missing value,
        // so once the user drags the icon, their saved position wins.
        systemPreferences.registerDefaults({ [MACOS_TRAY_POSITION_KEY]: 0 });
        this.tray = new Tray(trayIcon, MACOS_TRAY_GUID);
        this.tray.setIgnoreDoubleClickEvents(true);
      } else if (
        process.platform === "win32" &&
        process.env.OPENWHISPR_CHANNEL === "production" &&
        windowsTrayIdentity === true
      ) {
        // Other channels have their own profile and single-instance lock, so they can
        // run beside production and must not claim its GUID.
        this.tray = new Tray(trayIcon, WINDOWS_PRODUCTION_TRAY_GUID);
      } else {
        this.tray = new Tray(trayIcon);
      }
      this._baseIcon = trayIcon;

      this.updateTrayMenu();
      this.setupTrayEventHandlers();
    } catch (error) {
      debugLogger.error("Error creating tray icon", { error: error.message }, "tray");
    }
  }

  async loadTrayIcon() {
    const platform = process.platform;
    const isDevelopment = process.env.NODE_ENV === "development";

    const candidatePaths = [];

    if (platform === "darwin") {
      if (isDevelopment) {
        candidatePaths.push(path.join(__dirname, "..", "assets", "iconTemplate@3x.png"));
      } else {
        candidatePaths.push(
          path.join(process.resourcesPath, "src", "assets", "iconTemplate@3x.png"),
          path.join(process.resourcesPath, "assets", "iconTemplate@3x.png"),
          path.join(
            process.resourcesPath,
            "app.asar.unpacked",
            "src",
            "assets",
            "iconTemplate@3x.png"
          ),
          path.join(__dirname, "..", "..", "src", "assets", "iconTemplate@3x.png"),
          path.join(app.getAppPath(), "src", "assets", "iconTemplate@3x.png")
        );
      }
    } else {
      const fileName = platform === "win32" ? "icon.ico" : "icon.png";
      if (isDevelopment) {
        candidatePaths.push(
          path.join(__dirname, "..", "assets", fileName),
          path.join(__dirname, "..", "assets", "icon.png")
        );
      } else {
        candidatePaths.push(
          path.join(process.resourcesPath, "src", "assets", fileName),
          path.join(process.resourcesPath, "assets", fileName),
          path.join(process.resourcesPath, "app.asar.unpacked", "src", "assets", fileName),
          path.join(__dirname, "..", "..", "src", "assets", fileName),
          path.join(app.getAppPath(), "src", "assets", fileName)
        );
      }
    }

    for (const testPath of candidatePaths) {
      try {
        if (fs.existsSync(testPath)) {
          const icon = nativeImage.createFromPath(testPath);
          if (icon && !icon.isEmpty()) {
            if (platform === "darwin") {
              icon.setTemplateImage(true);
            }
            debugLogger.debug("Using tray icon", { path: testPath }, "tray");
            return icon;
          }
        }
      } catch (error) {
        debugLogger.error(
          "Error checking tray icon path",
          { path: testPath, error: error.message },
          "tray"
        );
      }
    }

    debugLogger.error("Could not find tray icon in any expected location", undefined, "tray");
    return this.createFallbackIcon();
  }

  createFallbackIcon() {
    try {
      // Create a simple 16x16 PNG icon programmatically
      const { createCanvas } = require("canvas");
      const canvas = createCanvas(16, 16);
      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.arc(8, 8, 6, 0, 2 * Math.PI);
      ctx.fill();

      const buffer = canvas.toBuffer("image/png");
      const fallbackIcon = nativeImage.createFromBuffer(buffer);
      debugLogger.info("Created fallback tray icon", undefined, "tray");
      return fallbackIcon;
    } catch (fallbackError) {
      debugLogger.warn("Canvas not available, creating minimal fallback icon", undefined, "tray");
      // Create a minimal 16x16 black square PNG as fallback
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x91, 0x68, 0x36, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x28, 0x53, 0x63, 0x08,
        0x05, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);

      const fallbackIcon = nativeImage.createFromBuffer(pngData);
      debugLogger.info("Created minimal fallback tray icon", undefined, "tray");
      return fallbackIcon;
    }
  }

  buildContextMenuTemplate() {
    const dictationVisible = this.windowManager?.isDictationPanelVisible?.() ?? false;
    const dictating = this.windowManager?.isDictating?.() ?? false;
    const restartBlocked = this._restartBlocker() !== null;

    return [
      ...this._graphicsWarningItems(restartBlocked),
      {
        label: dictating
          ? i18nMain.t("app.commandMenu.stopListening")
          : i18nMain.t("app.commandMenu.startListening"),
        click: () =>
          dictating
            ? this.windowManager?.sendStopDictation()
            : this.windowManager?.sendStartDictation(),
      },
      {
        label: i18nMain.t("app.commandMenu.askAssistant"),
        click: () => this.windowManager?.openAgentWindow(),
      },
      {
        // Starts in the main process, like the meeting hotkey, which refuses
        // it under policy; the pill's menu hides it then, the tray disables it.
        label: i18nMain.t("app.commandMenu.startMeetingRecording"),
        enabled: !this.windowManager?.getMeetingRecordingRefusal?.(),
        click: () => this.windowManager?.startManualMeeting(),
      },
      { type: "separator" },
      {
        label: dictationVisible
          ? i18nMain.t("tray.toggleDictation.hide")
          : i18nMain.t("tray.toggleDictation.show"),
        click: () => {
          if (!this.windowManager) return;
          if (this.windowManager.isDictationPanelVisible()) {
            this.windowManager.hideDictationPanel();
          } else {
            this.windowManager.showDictationPanel({ focus: true, reposition: true });
          }
          this.updateTrayMenu();
        },
      },
      {
        label: this.isControlPanelVisible()
          ? i18nMain.t("tray.hideControlPanel")
          : i18nMain.t("tray.openControlPanel"),
        click: () => {
          void this.toggleControlPanelFromTray();
        },
      },
      this._reviewMenuItem(),
      { type: "separator" },
      {
        label: i18nMain.t("tray.restart"),
        enabled: !restartBlocked,
        click: () => void this._restartFromTray("menu"),
      },
      {
        label: i18nMain.t("tray.quit"),
        click: () => {
          debugLogger.info("Quitting app via tray menu", undefined, "tray");
          app.quit();
        },
      },
    ];
  }

  // While Chromium draws on the CPU: the warning, which opens Settings at it,
  // and a restart to get the graphics card back. Windows menus can't color
  // text, so the ⚠ and the place at the top are the hint.
  _graphicsWarningItems(restartBlocked) {
    if (!this._graphicsFallback()) return [];
    return [
      {
        label: `⚠ ${i18nMain.t("tray.graphicsFallback.title")}`,
        click: () => void this._openGraphicsSettings(),
      },
      {
        label: restartBlocked
          ? i18nMain.t("tray.graphicsFallback.restartAfterRecording")
          : i18nMain.t("tray.graphicsFallback.restart"),
        enabled: !restartBlocked,
        click: () => void this._restartFromTray("graphicsWarning"),
      },
      { type: "separator" },
    ];
  }

  async _openGraphicsSettings() {
    try {
      await this.windowManager?.openSettings?.(GRAPHICS_SETTINGS_DESTINATION);
    } catch (error) {
      debugLogger.error("Failed to open graphics settings", { error: error?.message }, "tray");
    }
  }

  _graphicsState() {
    return this.windowManager?.graphicsMode?.getState?.() ?? null;
  }

  _graphicsFallback() {
    return isSoftwareFallback(this._graphicsState());
  }

  // What a restart now would cut off: a dictation being recorded, processed
  // or delivered (pasted and saved), or a meeting recording. Null when none.
  _restartBlocker() {
    if (this.windowManager?.isDictationBusy?.()) return "dictation";
    if (this._isMeetingRecording?.()) return "meeting";
    return null;
  }

  // Checked again on click: the menu was built before whatever runs now.
  async _restartFromTray(item) {
    const graphics = graphicsModeLabel(this._graphicsState());
    const busy = this._restartBlocker();
    if (busy) {
      debugLogger.info("Tray restart skipped", { item, busy, graphics }, "tray");
      return;
    }
    if (!this._relaunch) {
      debugLogger.warn("Tray restart unavailable", { item }, "tray");
      return;
    }
    debugLogger.info("Restarting via tray menu", { item, graphics }, "tray");
    try {
      await this._relaunch();
    } catch (error) {
      debugLogger.error("Tray restart failed", { error: error?.message }, "tray");
    }
  }

  // "Review last dictation", the review hotkey's action, with that hotkey
  // beside it when one is set: as the menu's accelerator text when Electron
  // can show it (never registered: the hotkey manager owns the key), in the
  // label otherwise.
  _reviewMenuItem() {
    const label = i18nMain.t("tray.reviewLastDictation");
    const hotkey = this.windowManager?.hotkeyManager?.getSlotHotkey?.("review") || null;
    const item = { label, click: () => void this.windowManager?.reviewLastDictation?.() };
    if (!hotkey) return item;
    if (isMenuAccelerator(hotkey)) {
      return { ...item, accelerator: hotkey, registerAccelerator: false };
    }
    return { ...item, label: `${label} (${hotkeyMenuLabel(hotkey)})` };
  }

  updateTrayMenu() {
    if (!this._isTrayLive()) return;

    const contextMenu = Menu.buildFromTemplate(this.buildContextMenuTemplate());
    this.tray.setToolTip(this._tooltip());
    this.tray.setContextMenu(contextMenu);
  }

  _isTrayLive() {
    return Boolean(this.tray && !this.tray.isDestroyed?.());
  }

  _recordingIndicatorWanted() {
    const recording = this.windowManager?.isDictating?.() ?? false;
    const settings = this.windowManager?.getRecordingIndicatorSettings?.();
    const inputKind = this.windowManager?.getDictationInputKind?.();
    return {
      recording,
      enabled: recording && settings?.tray === true,
      settings,
      color: resolveRecordingModeColor(settings, inputKind),
    };
  }

  // The window manager keeps one start time for every surface that shows the
  // elapsed time; the tray's own clock only fills in without one.
  _recordingStart() {
    const shared = this.windowManager?.getRecordingStartedAt?.();
    return Number.isFinite(shared) ? shared : this._recordingStartedAt;
  }

  _tooltip() {
    const { enabled } = this._recordingIndicatorWanted();
    const startedAt = this._recordingStart();
    if (enabled && startedAt) {
      return i18nMain.t("tray.recordingTooltip", {
        elapsed: formatRecordingElapsed(Date.now() - startedAt),
      });
    }
    // macOS opens the menu on a click; Windows and Linux on a right-click.
    if (this._graphicsFallback()) {
      return i18nMain.t(
        process.platform === "darwin"
          ? "tray.graphicsFallbackTooltipMac"
          : "tray.graphicsFallbackTooltip"
      );
    }
    return i18nMain.t("tray.tooltip");
  }

  // The dot the icon should carry: the recording dot while it shows (its
  // setting on), else the graphics warning while Chromium has fallen back to
  // the CPU, whatever the recording setting says: it's a health warning.
  _badgeWanted() {
    const { enabled, color } = this._recordingIndicatorWanted();
    if (enabled) return { kind: "recording", color };
    if (this._graphicsFallback()) return { kind: "graphics", color: GRAPHICS_WARNING_ACCENT };
    return null;
  }

  /**
   * The tray icon and tooltip, from the recording and the graphics mode. While
   * a dictation records and the setting is on: a dot in the recording color
   * and the elapsed time in the tooltip. Otherwise, while graphics fell back
   * to the CPU: an amber dot and the warning in the tooltip. Driven by the
   * main-process lifecycle, settings and graphics mode, so every way a
   * recording ends (stop, cancel, a crashed or reloaded renderer) puts the
   * icon back.
   */
  updateTrayIcon() {
    const { recording, enabled } = this._recordingIndicatorWanted();
    if (!recording) this._recordingStartedAt = null;
    else if (!this._recordingStartedAt) this._recordingStartedAt = Date.now();

    if (!this._isTrayLive()) {
      this._stopTooltipTimer();
      return;
    }
    const wanted = this._badgeWanted();
    const badge = wanted ? this._badgedIcon(wanted.color) : null;
    const kind = badge ? wanted.kind : null;
    if (badge) {
      this.tray.setImage(badge);
    } else if (this._badgeKind && this._baseIcon) {
      this.tray.setImage(this._baseIcon);
    }
    if (kind !== this._badgeKind) {
      if (this._badgeKind) debugLogger.debug(BADGE_LOG[this._badgeKind].removed, undefined, "tray");
      if (kind) debugLogger.debug(BADGE_LOG[kind].shown, { size: badge.getSize?.() }, "tray");
      this._badgeKind = kind;
    }
    this.tray.setToolTip(this._tooltip());
    if (enabled) this._startTooltipTimer();
    else this._stopTooltipTimer();
  }

  // The graphics mode changed (main.js): the dot, the tooltip and the menu's
  // warning follow it.
  onGraphicsModeChanged() {
    this.updateTrayMenu();
    this.updateTrayIcon();
  }

  // Only the tooltip ticks; the menu rebuilds on state changes alone.
  _startTooltipTimer() {
    if (this._tooltipTimer) return;
    this._tooltipTimer = setInterval(() => {
      if (!this._isTrayLive() || !this._recordingIndicatorWanted().enabled) {
        this._stopTooltipTimer();
        return;
      }
      this.tray.setToolTip(this._tooltip());
    }, 1000);
  }

  _stopTooltipTimer() {
    if (!this._tooltipTimer) return;
    clearInterval(this._tooltipTimer);
    this._tooltipTimer = null;
  }

  // One bitmap at the tray's pixel size: Windows turns a generated image into
  // a single bitmap whatever representations it carries, so this draws at
  // 16 DIP on the primary display (where the taskbar's tray is). macOS keeps
  // its template icon, which can't carry a color. `color` is a recording
  // color id or "#rrggbb".
  _badgedIcon(color) {
    if (process.platform === "darwin" || !this._baseIcon || this._baseIcon.isEmpty()) return null;
    const accent = resolveRecordingAccent(color);
    const scale = screen.getPrimaryDisplay()?.scaleFactor || 1;
    const size = Math.max(16, Math.round(16 * scale));
    const key = `${size}:${accent}`;
    const cached = this._badgeCache.get(key);
    if (cached) return cached;
    try {
      const bitmap = this._baseIcon
        .resize({ width: size, height: size, quality: "best" })
        .toBitmap();
      if (bitmap.length !== size * size * 4) {
        debugLogger.warn(
          "Tray icon bitmap has an unexpected size",
          { size, bytes: bitmap.length },
          "tray"
        );
        return null;
      }
      const image = nativeImage.createFromBitmap(drawRecordingBadge(bitmap, size, accent), {
        width: size,
        height: size,
      });
      if (this._badgeCache.size >= BADGE_CACHE_LIMIT) {
        this._badgeCache.delete(this._badgeCache.keys().next().value);
      }
      this._badgeCache.set(key, image);
      return image;
    } catch (error) {
      debugLogger.warn("Could not draw the tray badge", { accent, error: error.message }, "tray");
      return null;
    }
  }

  setupTrayEventHandlers() {
    if (!this.tray) {
      return;
    }

    if (process.platform !== "darwin") {
      this.tray.on("click", () => {
        void this.toggleControlPanelFromTray();
      });
    }

    this.tray.on("destroyed", () => {
      debugLogger.debug("Tray icon destroyed", undefined, "tray");
      this.tray = null;
    });
  }
}

module.exports = TrayManager;
