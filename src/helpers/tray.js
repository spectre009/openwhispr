const { Tray, Menu, nativeImage, app, screen, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");
const { i18nMain } = require("./i18nMain");
const { drawRecordingBadge, formatRecordingElapsed } = require("./trayRecordingBadge");
const { resolveRecordingAccent } = require("./recordingIndicator");
const { windowsTrayIdentity } = require("../../package.json");

// Permanent identity for signed production Windows builds; keep across releases.
// Windows binds an unsigned executable's GUID to its path, so only builds from the
// signed config, which sets windowsTrayIdentity, may use it.
const WINDOWS_PRODUCTION_TRAY_GUID = "9afd9bd5-53da-42ef-8334-6e2b494c66fe";

// macOS saves the menu-bar position under this GUID, so changing it resets every
// user's placement. Electron lowercases the GUID before handing it to macOS, so
// it stays lowercase here or the position key below matches no item.
const MACOS_TRAY_GUID = "eb809902-04b5-5b08-b12a-f81d6f27e185";
const MACOS_TRAY_POSITION_KEY = `NSStatusItem Preferred Position ${MACOS_TRAY_GUID}`;

class TrayManager {
  constructor() {
    this.tray = null;
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.windowManager = null;
    this.attachedControlPanels = new WeakSet();
    // The icon as loaded (a multi-size .ico on Windows), restored after a
    // recording; the badged copy is a single bitmap.
    this._baseIcon = null;
    this._badgeCache = null;
    this._badgeShown = false;
    this._recordingStartedAt = null;
    this._tooltipTimer = null;
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

    return [
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
        click: () => this.windowManager?.sendOpenAssistantPanel(),
      },
      {
        // Starts in the main process, like the meeting hotkey: the recording it
        // opens is policy-gated where it actually begins, in the control panel.
        label: i18nMain.t("app.commandMenu.startMeetingRecording"),
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
      { type: "separator" },
      {
        label: i18nMain.t("tray.quit"),
        click: () => {
          debugLogger.info("Quitting app via tray menu", undefined, "tray");
          app.quit();
        },
      },
    ];
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
    return { recording, enabled: recording && settings?.tray === true, settings };
  }

  _tooltip() {
    const { enabled } = this._recordingIndicatorWanted();
    if (!enabled || !this._recordingStartedAt) return i18nMain.t("tray.tooltip");
    return i18nMain.t("tray.recordingTooltip", {
      elapsed: formatRecordingElapsed(Date.now() - this._recordingStartedAt),
    });
  }

  /**
   * While a dictation records and the setting is on: a dot in the recording
   * color on the tray icon and the elapsed time in its tooltip. Driven by the
   * main-process lifecycle and settings, so every way a recording ends
   * (stop, cancel, a crashed or reloaded renderer) puts the icon back.
   */
  updateRecordingIndicator() {
    const { recording, enabled, settings } = this._recordingIndicatorWanted();
    if (!recording) this._recordingStartedAt = null;
    else if (!this._recordingStartedAt) this._recordingStartedAt = Date.now();

    if (!this._isTrayLive()) {
      this._stopTooltipTimer();
      return;
    }
    const badge = enabled ? this._badgedIcon(settings.color) : null;
    if (badge) {
      this.tray.setImage(badge);
      if (!this._badgeShown) {
        debugLogger.debug("Tray recording badge shown", { size: badge.getSize?.() }, "tray");
      }
      this._badgeShown = true;
    } else if (this._badgeShown && this._baseIcon) {
      this.tray.setImage(this._baseIcon);
      this._badgeShown = false;
      debugLogger.debug("Tray recording badge removed", undefined, "tray");
    }
    this.tray.setToolTip(this._tooltip());
    if (enabled) this._startTooltipTimer();
    else this._stopTooltipTimer();
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
  // its template icon, which can't carry a color.
  _badgedIcon(color) {
    if (process.platform === "darwin" || !this._baseIcon || this._baseIcon.isEmpty()) return null;
    const accent = resolveRecordingAccent(color);
    const scale = screen.getPrimaryDisplay()?.scaleFactor || 1;
    const size = Math.max(16, Math.round(16 * scale));
    const key = `${size}:${accent}`;
    if (this._badgeCache?.key === key) return this._badgeCache.image;
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
      this._badgeCache = { key, image };
      return image;
    } catch (error) {
      debugLogger.warn("Could not draw the tray recording badge", { error: error.message }, "tray");
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
