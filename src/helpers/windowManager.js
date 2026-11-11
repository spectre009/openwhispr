const { app, screen, BrowserWindow, dialog, ipcMain, powerMonitor } = require("electron");
const debugLogger = require("./debugLogger");
const tokenStore = require("./tokenStore");
const accountScopeBinding = require("./accountScopeBinding");
const {
  describeMeetingNote,
  meetingDestinationContext,
} = require("./meetingNotificationDestination");
const { createLinuxWindowInputRegion } = require("./linuxWindowInputRegion");
// Aliased: this class has an openExternalUrl method wrapping the helper.
const { openExternalUrl: openUrlInExternalBrowser } = require("./externalUrlOpener");
const HotkeyManager = require("./hotkeyManager");
const { isGlobeLikeHotkey } = HotkeyManager;
const DragManager = require("./dragManager");
const MainWindowPlacementCoordinator = require("./mainWindowPlacementCoordinator");
const {
  isFloatingIconDisplayLocked,
  isPointInWorkArea,
  normalizeFloatingIconDisplay,
  normalizePanelPosition,
  panelDocksAtTop,
  parsePanelPosition,
  pillRestingPoint,
  resolvePreferredDisplay,
} = require("./floatingIconPlacement");
const { plasmaWorkAreas } = require("./plasmaWorkAreas");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const {
  isAllowedAppNavigation,
  isExternalBrowserUrl,
  isExternalOpenUrl,
} = require("./navigationGuard");
const { pathToFileURL } = require("url");
const dockManager = require("./dockManager");
const { i18nMain } = require("./i18nMain");
const { NotificationDismissTimer, getNotificationTimeoutMs } = require("./notificationTimer");
const {
  DICTATION_LIFECYCLE,
  normalizeDictationLifecycle,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
} = require("./dictationLifecycle");
const { DEV_SERVER_PORT } = DevServerManager;
// What a recording is for, as the dictation window reports it: with "Color by
// mode" on, the edge strip and the tray take that mode's color.
const RECORDING_INPUT_KINDS = new Set(["dictation", "assistant", "translation"]);
const normalizeRecordingInputKind = (value) =>
  RECORDING_INPUT_KINDS.has(value) ? value : "dictation";
const DRAG_MOVE_TOLERANCE_PX = 2;
// Fractional display scaling rounds setBounds, so a window rarely reports the
// exact bounds it was given (and at 135% grows a pixel or two each time).
// Placement treats bounds within these margins as already in place, and puts a
// resting pill back at the exact BASE size rather than feeding a rounded size
// into the next move.
const PLACEMENT_TOLERANCE_PX = 2;
const PLACEMENT_SIZE_SLACK_PX = 4;
// The smallest grown surface (the pill menu) is 32px wider and 160px taller
// than BASE; anything closer to BASE is a resting pill with rounding creep.
const GROWN_SURFACE_THRESHOLD_PX = 16;
// Display events arrive in bursts while monitors wake or rearrange, and Windows
// may still move windows after the last one. Placement is reconciled once the
// burst settles, then checked again, a bounded number of times.
const TOPOLOGY_RECONCILE_DELAYS_MS = Object.freeze([750, 1750, 3750]);
const PLACEMENT_PREVIEW_MS = 2000;

function boundsWithin(a, b) {
  return (
    Math.abs(a.x - b.x) <= PLACEMENT_TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= PLACEMENT_TOLERANCE_PX &&
    Math.abs(a.width - b.width) <= PLACEMENT_SIZE_SLACK_PX &&
    Math.abs(a.height - b.height) <= PLACEMENT_SIZE_SLACK_PX
  );
}
const ERR_ABORTED = -3;
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  ONBOARDING_WINDOW_SIZES,
  NOTIFICATION_WINDOW_CONFIG,
  fitMeetingNotificationWindow,
  fitAssistantContentWindowToWorkArea,
  fitDictationErrorContentWindowToWorkArea,
  fitDictationErrorWindowToWorkArea,
  resolveHorizontalWindowDirection,
  WINDOW_SIZES,
  WindowPositionUtil,
} = require("./windowConfig");
// The collapsed prompt card, inset 4px inside the notification window.
const MEETING_NOTIFICATION_CARD_REGION = Object.freeze({
  x: 4,
  y: 4,
  width: NOTIFICATION_WINDOW_CONFIG.width - 8,
  height: NOTIFICATION_WINDOW_CONFIG.height - 8,
});
const { centeredBounds, clampedBounds } = require("./onboardingWindowBounds");
const { ONBOARDING_DEMO_KINDS, isOnboardingInputAllowed } = require("./onboardingInputPolicy");
const { createHotkeyRepeatGate } = require("./hotkeyRepeatGate");
const { RecordingEdgeStrip } = require("./recordingEdgeStrip");
const { StartVisualsTracker } = require("./dictationStartVisuals");
const {
  nextRecordingReminderDelay,
  normalizeRecordingIndicatorSettings,
  resolveRecordingStartedAt,
} = require("./recordingIndicator");
const { getLinuxSessionInfo } = require("./linuxSession");

// The renderer asks for a window mode per onboarding step; each one names its
// size in ONBOARDING_WINDOW_SIZES. "restore" is handled separately.
const ONBOARDING_WINDOW_SIZE_KEYS = {
  compact: "COMPACT",
  expanded: "EXPANDED",
  "local-setup": "LOCAL_SETUP",
};

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this._resizeMaskTokenCounter = 0;
    this._controlPanelVisibilityTimer = null;
    this._onboardingRestoreBounds = null;
    this._onboardingWindowMode = null;
    this._onboardingWindowState = null;
    // Fail closed until AppRouter has resolved persisted onboarding state and
    // committed the normal app. This covers the startup gap before React mounts.
    this._onboardingActive = true;
    this._onboardingDemoKind = null;
    // Set by IPCHandlers so its demo session dies with the demo kind on every
    // teardown path (id-matched end, onboarding exit, control panel closed).
    this.onOnboardingDemoTeardown = null;
    // Set by main.js so the tray's listen and Restart items rebuild with the
    // dictation's lifecycle and delivery.
    this.onDictationStateChanged = null;
    // Set by IPCHandlers: the org-policy refusal of meeting recording, or null.
    this.getMeetingRecordingRefusal = () => null;
    // Set by IPCHandlers: the same refusal, fetching the policy if it hasn't loaded.
    this.resolveMeetingRecordingRefusal = async () => null;
    // Set by main.js: an app started to the tray creates no control panel.
    this.startedMinimized = false;
    this.notificationWindow = null;
    this._meetingNotificationOwner = null;
    this.meetingRecentDestinations = [];
    this._notificationDismissTimer = new NotificationDismissTimer(() => {
      // Dismiss first: a prompt raised from the timeout handler must not be
      // closed by this dismissal. The engine is not told the card closed either —
      // handleNotificationTimeout below settles this expiry, and a close report
      // here would flush the queue into a card that handler is about to clear.
      this.dismissMeetingNotification({ notifyEngine: false });
      this.meetingDetectionEngine?.handleNotificationTimeout();
    });
    this.notificationPrefs = {
      notificationsEnabled: true,
      notifyMeetingDetection: true,
      notifyCalendarReminders: true,
    };
    this.tray = null;
    // Set by main.js: the assistant's own window (agentWindowManager.js).
    this.agentWindow = null;
    this.hotkeyManager = new HotkeyManager();
    this.dragManager = new DragManager();
    this._mainWindowPlacementCoordinator = new MainWindowPlacementCoordinator();
    this.isQuitting = false;
    this.loadErrorShown = false;
    this.macCompoundPushState = null;
    this.winPushState = null;
    this._nativeKeyListenersReady = false;
    this._cachedActivationMode = "tap";
    this._floatingIconAutoHide = false;
    this._panelStartPosition = "bottom-right";
    this._floatingIconDisplay = "cursor";
    this._floatingIconDisplayLabel = "";
    this._lastLockedDisplayMatch = null;
    this._manualRestingBounds = null;
    this._surfaceGeneration = 0;
    this._topologyTimers = [];
    this._placementTopologyListening = false;
    this._activeHorizontalDirection = null;
    this._isDictatingToggle = false;
    this._dictationLifecycleState = DICTATION_LIFECYCLE.IDLE;
    this._dictationInputKind = "dictation";
    this._dictationAttempt = null;
    this._pendingMeetingNoteNavigation = null;
    this._pendingNoteNavigation = null;
    this._pendingSettingsSection = null;
    // "Review last dictation": the request the control panel picks up, the
    // service that resolves it (set by IPCHandlers), and whether the dictation
    // window is still pasting or saving a finished dictation.
    this._pendingReviewRequest = null;
    // "Open in History" from a dictation error card: the row to show, no review.
    this._pendingHistoryItemRequest = null;
    this.dictationReview = null;
    this._dictationDelivering = false;
    this._recordingIndicatorSettings = normalizeRecordingIndicatorSettings(null);
    this._recordingStartedAt = null;
    this._recordingReminderTimer = null;
    // The graphics mode monitor (graphicsMode.js), set by main.js.
    this.graphicsMode = null;
    // "Dictation start visuals": one line per press, from the pill's first
    // painted frame, its entrance and the strip's show (dictationStartVisuals.js).
    this._startVisuals = new StartVisualsTracker({
      logger: debugLogger,
      getGraphics: () => this.graphicsMode?.getState?.() ?? null,
    });
    this._startVisualsProbe = null;
    this.recordingEdgeStrip = new RecordingEdgeStrip({
      BrowserWindow,
      screen,
      getPillDisplay: () => this._edgeStripPillDisplay(),
      setupAlwaysOnTop: (win) => WindowPositionUtil.setupAlwaysOnTop(win),
      windowType: NOTIFICATION_WINDOW_CONFIG.type,
      logger: debugLogger,
      // Wayland compositors place windows themselves, so nothing can pin the
      // strip to the top edge there.
      supported: !(process.platform === "linux" && getLinuxSessionInfo().isWayland),
      onRecordingShown: (details) => this._startVisuals.frameShown(details),
    });

    app.on("before-quit", () => {
      this.isQuitting = true;
      this.hotkeyManager.unregisterAll();
      this._clearRecordingReminder();
      this._startVisuals.dispose();
      this.recordingEdgeStrip.destroy();
    });
  }

  async createMainWindow() {
    // KDE Plasma: each monitor's own panels decide its work area (#2624). A
    // correction that arrives later puts the pill back on its configured spot,
    // and the agent window, which anchors above a center-docked pill, follows.
    void plasmaWorkAreas.start(async () => {
      await this._reanchorMainWindow();
      this.agentWindow?.refit();
    });
    const display =
      this._resolveLockedDisplay() ||
      plasmaWorkAreas.resolve(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
    const position = WindowPositionUtil.getMainWindowPosition(
      display,
      null,
      this._panelStartPosition
    );

    this.mainWindow = new BrowserWindow({
      ...MAIN_WINDOW_CONFIG,
      ...position,
    });
    this._listenForPlacementTopologyChanges();

    this.setMainWindowInteractivity(false);
    this.registerMainWindowEvents();
    this._registerDictationLifecycleReset(this.mainWindow);
    this.registerExternalLinkHandlers(this.mainWindow, false);

    // Register load event handlers BEFORE loading to catch all events
    this.mainWindow.webContents.on(
      "did-fail-load",
      async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        if (
          process.env.NODE_ENV === "development" &&
          validatedURL &&
          validatedURL.includes(`localhost:${DEV_SERVER_PORT}`)
        ) {
          setTimeout(async () => {
            const isReady = await DevServerManager.waitForDevServer();
            if (isReady) {
              this.mainWindow.reload();
            }
          }, 2000);
        } else {
          this.showLoadFailureDialog("Dictation panel", errorCode, errorDescription, validatedURL);
        }
      }
    );

    const dictationContents = this.mainWindow.webContents;
    const releaseDictation = () => {
      if (this.mainWindow?.webContents === dictationContents) {
        this.setDictationLifecycleState(DICTATION_LIFECYCLE.IDLE);
      }
    };
    dictationContents.on("did-navigate", releaseDictation);
    dictationContents.on("render-process-gone", releaseDictation);
    dictationContents.on("destroyed", releaseDictation);
    this.mainWindow.webContents.on("did-finish-load", () => {
      // A reload has not resolved its route yet. AppRouter releases this gate
      // after it renders the normal app; fresh onboarding keeps it active.
      this.setOnboardingActive(true);
      this.endOnboardingDemo();
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
      this.enforceMainWindowOnTop();
      this._notifyMainWindowHorizontalDirection();
    });

    await this.loadMainWindow();
    await this.initializeHotkey();
    this.dragManager.setTargetWindow(this.mainWindow);
    MenuManager.setupMainMenu(() => this.openSettings());
  }

  _updateMainContentProtection() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.setContentProtection(Boolean(this._screenContextProtection));
  }

  setScreenContextProtection(enabled) {
    this._screenContextProtection = Boolean(enabled);
    this._updateMainContentProtection();
  }

  // blur() leaves X focus on the Linux pill, and GNOME hands focus back to the
  // previous app only when the focused override-redirect window unmaps. A hidden
  // pill holds no focus, and remapping it would undo whatever hid it.
  returnLinuxKeyboardFocus() {
    const win = this.mainWindow;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.hide();
    win.showInactive();
  }

  setMainWindowInteractivity(shouldCapture) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (process.platform === "win32") {
      // Windows click-through forwarding is unreliable for this floating panel.
      this.mainWindow.setIgnoreMouseEvents(false);
      return;
    }

    if (process.platform === "linux") {
      // Native capture is the fallback when the input-region helper is unavailable.
      this.mainWindow.setIgnoreMouseEvents(!shouldCapture);
    } else if (shouldCapture) {
      this.mainWindow.setIgnoreMouseEvents(false);
    } else {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  _mainWindowInputRegion() {
    const win = this.mainWindow;
    if (this._linuxWindowInputRegion?.window !== win) {
      this._linuxWindowInputRegion?.stop();
      this._linuxWindowInputRegion = { window: win, ...createLinuxWindowInputRegion(win) };
    }
    return this._linuxWindowInputRegion;
  }

  async setMainWindowInputRegion(region) {
    const win = this.mainWindow;
    if (process.platform !== "linux" || !win || win.isDestroyed()) return false;
    try {
      await this._mainWindowInputRegion().set(region);
      return !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    } catch (error) {
      // The writer rejects after its process closes, so an old shape cannot
      // overwrite this fallback and leave native hover unreachable.
      if (!win.isDestroyed()) win.setIgnoreMouseEvents(false);
      throw error;
    }
  }

  // Every token or account change retires the prompt first, so only the
  // current binding has to agree with the database's account.
  hasMeetingNotificationScope() {
    const database = this.meetingDetectionEngine?.databaseManager;
    if (!database) return false;
    const state = tokenStore.getState();
    // A token without a valid binding scopes like no token (signed out).
    const boundAccountId = state.token
      ? (accountScopeBinding.resolveActiveAccountScope({
          ...state,
          binding: accountScopeBinding.read(),
        })?.accountId ?? null)
      : null;
    return boundAccountId === database.activeAccountId;
  }

  captureMeetingNotificationOwner(sender) {
    const owner = this._meetingNotificationOwner;
    return owner && owner.window.webContents === sender && this.isMeetingNotificationOwner(owner)
      ? owner
      : null;
  }

  isMeetingNotificationOwner(owner) {
    return Boolean(
      owner &&
      owner === this._meetingNotificationOwner &&
      !owner.window.isDestroyed() &&
      !this._onboardingActive &&
      owner.detection &&
      this.meetingDetectionEngine?.activeDetections?.get(owner.prompt.detectionId) ===
        owner.detection &&
      this.hasMeetingNotificationScope()
    );
  }

  retireMeetingNotificationScope() {
    this.meetingRecentDestinations = [];
    this._pendingMeetingNoteNavigation = null;
    this._cancelMeetingNavigation("STALE_NOTIFICATION");
    if (this.meetingDetectionEngine) {
      this.meetingDetectionEngine._notificationQueue = [];
      this.meetingDetectionEngine.activeDetections.clear();
    }
    this.dismissMeetingNotification({ notifyEngine: false });
  }

  updateMeetingNotificationPause(owner) {
    if (owner !== this._meetingNotificationOwner) return;
    if (owner.pointerInside || owner.mode !== "closed" || owner.responseInFlight) {
      this._notificationDismissTimer.pause();
    } else this._notificationDismissTimer.resume();
  }

  setNotificationInteractivity(sender, interactive) {
    const win = this.notificationWindow;
    if (!win || win.isDestroyed() || sender !== win.webContents) return;
    if (process.platform !== "linux") win.setIgnoreMouseEvents(!interactive, { forward: true });
    const owner = this._meetingNotificationOwner;
    owner.pointerInside = interactive;
    this.updateMeetingNotificationPause(owner);
  }

  setMeetingNotificationSurface(owner, state) {
    if (!this.isMeetingNotificationOwner(owner))
      return { success: false, code: "STALE_NOTIFICATION" };
    if (
      !state ||
      !Number.isSafeInteger(state.revision) ||
      state.revision <= owner.layoutRevision ||
      !["closed", "list", "form"].includes(state.mode) ||
      !["request", "release", "keep"].includes(state.focus) ||
      !Number.isFinite(state.contentHeight) ||
      state.contentHeight <= 0 ||
      state.contentHeight > 4096 ||
      !Array.isArray(state.regions) ||
      !state.regions.length ||
      state.regions.length > 16 ||
      state.regions.some(
        (r) =>
          !r ||
          ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
          r.x < 0 ||
          r.y < 0 ||
          r.width <= 0 ||
          r.height <= 0 ||
          r.x + r.width > NOTIFICATION_WINDOW_CONFIG.width ||
          r.y + r.height > 4096
      )
    ) {
      return { success: false, code: "INVALID_REQUEST" };
    }
    const win = owner.window;
    const display = screen.getDisplayMatching(win.getBounds());
    const bounds = fitMeetingNotificationWindow(
      state.contentHeight,
      display.workArea || display.bounds
    );
    const regions = state.regions
      .map((r) => ({
        x: Math.min(Math.round(r.x), bounds.width),
        y: Math.min(Math.round(r.y), bounds.height),
        width: Math.max(0, Math.min(Math.ceil(r.width), bounds.width - Math.round(r.x))),
        height: Math.max(0, Math.min(Math.ceil(r.height), bounds.height - Math.round(r.y))),
      }))
      .filter((r) => r.width > 0 && r.height > 0);
    if (!regions.length) return { success: false, code: "INVALID_REQUEST" };
    owner.layoutRevision = state.revision;
    owner.mode = state.mode;
    owner.surface = state;
    const previousBounds = win.getBounds();
    if (Object.keys(bounds).some((key) => bounds[key] !== previousBounds[key]))
      win.setBounds(bounds);
    if (process.platform === "linux") win.setShape(regions);
    if (state.focus === "request" && state.mode !== "closed") {
      if (process.platform !== "linux") win.setFocusable(true);
      // macOS panels need show() to activate after becoming focusable. Only an
      // explicit chooser action reaches here; measurement never raises them.
      win.show();
      win.focus();
    } else if (state.focus === "release") {
      // macOS blur orders the window out and back, blinking the whole card.
      // Keep it visible while disabling input focus.
      if (process.platform !== "darwin") win.blur();
      if (process.platform !== "linux") win.setFocusable(false);
    }
    const cursor = screen.getCursorScreenPoint();
    owner.pointerInside = regions.some(
      (r) =>
        cursor.x >= bounds.x + r.x &&
        cursor.x < bounds.x + r.x + r.width &&
        cursor.y >= bounds.y + r.y &&
        cursor.y < bounds.y + r.y + r.height
    );
    if (process.platform !== "linux")
      win.setIgnoreMouseEvents(!owner.pointerInside, { forward: true });
    this.updateMeetingNotificationPause(owner);
    return {
      success: true,
      value: {
        width: bounds.width,
        height: bounds.height,
        maxHeight: fitMeetingNotificationWindow(512, display.workArea || display.bounds).height,
      },
    };
  }

  resizeMainWindow(sizeKey) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }
    return this._enqueueMainWindowMutation(() => this._performMainWindowResize(sizeKey));
  }

  resizeAssistantWindowToContent(surfaceHeight) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    return this._enqueueMainWindowMutation(() =>
      this._performMainWindowResize("ASSISTANT_CONTENT", { surfaceHeight })
    );
  }

  resizeDictationErrorWindowToContent(surfaceHeight) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    return this._enqueueMainWindowMutation(() =>
      this._performMainWindowResize("DICTATION_ERROR_CONTENT", { surfaceHeight })
    );
  }

  // Deliberate moves are not anchored resizes: the renderer must drop any live
  // resize mask rather than hold a translation against invalidated bounds.
  _clearRendererResizeMask() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("main-window-will-resize", { anchor: "none" });
  }

  async _prepareRendererForMainWindowResize(bounds, anchor) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    // The renderer must install screen-space anchor compensation before
    // setBounds reaches the OS compositor. Without this handshake, Windows
    // and macOS can paint the new viewport size one frame before the
    // corresponding window position, which visibly kicks the pill or panel.
    // A fixed sleep loses that race whenever the renderer is mid-task (an
    // entrance commit, mic warm-up), so wait for its explicit ack; the
    // timeout only covers an unresponsive or torn-down renderer.
    const token = ++this._resizeMaskTokenCounter;
    const ackPromise = new Promise((resolve) => {
      const listener = (_event, ackToken) => {
        if (ackToken !== token) return;
        ipcMain.removeListener("main-window-resize-mask-ready", listener);
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        ipcMain.removeListener("main-window-resize-mask-ready", listener);
        resolve();
      }, 60);
      ipcMain.on("main-window-resize-mask-ready", listener);
    });
    this.mainWindow.webContents.send("main-window-will-resize", { bounds, anchor, token });
    await ackPromise;
  }

  _enqueueMainWindowMutation(run) {
    // Renderer voice requests are latest-wins, while errors and other overlays
    // and active-display placement can also mutate the native bounds. Serialize
    // once more at the native boundary so setBounds calls cannot interleave.
    this._mainWindowResizeQueue = (this._mainWindowResizeQueue || Promise.resolve()).then(run, run);
    return this._mainWindowResizeQueue;
  }

  // The display that owns the resting pill must keep it through resizes and
  // repositions. The pill's own center identifies it: an edge point can sit on
  // a neighbouring display once a grown surface reaches a display edge.
  _getMainWindowDisplayFor(bounds) {
    return plasmaWorkAreas.resolve(
      screen.getDisplayNearestPoint(pillRestingPoint(bounds, this._panelStartPosition))
    );
  }

  // The resize mask's anchor: the edge the pill docks against (top, or bottom
  // for the other rows) and its side of the window, or its center.
  _mainWindowResizeAnchor() {
    const top = panelDocksAtTop(this._panelStartPosition);
    if (parsePanelPosition(this._panelStartPosition).horizontal === "center") {
      return top ? "top-center" : "center";
    }
    const side = this._activeHorizontalDirection || this.getMainWindowHorizontalDirection();
    return `${top ? "top" : "bottom"}-${side}`;
  }

  _resolveMainWindowSize(sizeKey, workArea, request) {
    switch (sizeKey) {
      case "DICTATION_ERROR":
      case "DICTATION_ERROR_WITH_TRANSCRIPT":
        return fitDictationErrorWindowToWorkArea(WINDOW_SIZES[sizeKey], workArea);
      case "ASSISTANT_CONTENT":
        return fitAssistantContentWindowToWorkArea(request?.surfaceHeight, workArea);
      case "DICTATION_ERROR_CONTENT":
        return fitDictationErrorContentWindowToWorkArea(request?.surfaceHeight, workArea);
      default:
        return WINDOW_SIZES[sizeKey] || WINDOW_SIZES.BASE;
    }
  }

  async _performMainWindowResize(sizeKey, request) {
    // The queue can drain after the window is gone (quit, recreate); the
    // caller's guard ran before enqueueing.
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, error: "Main window not available" };
    }
    // Bounds, display and the work-area fit are all sampled inside the queue:
    // a queued cross-display move would otherwise leave a fit computed at
    // enqueue time describing the display the window is about to leave.
    const currentBounds = this.mainWindow.getBounds();
    const display = this._getMainWindowDisplayFor(currentBounds);
    const newSize = this._resolveMainWindowSize(
      sizeKey,
      display.workArea || display.bounds,
      request
    );

    // A window moved since the last resize (dragged) means the captured BASE
    // bounds no longer describe where the user wants the pill — drop them.
    // Tolerate a couple of pixels: fractional DPI scaling can round setBounds
    // values, and treating that as a drag would defeat the restore forever.
    const MOVE_TOLERANCE_PX = 2;
    if (
      this._lastResizeBounds &&
      (Math.abs(currentBounds.x - this._lastResizeBounds.x) > MOVE_TOLERANCE_PX ||
        Math.abs(currentBounds.y - this._lastResizeBounds.y) > MOVE_TOLERANCE_PX)
    ) {
      this._baseBoundsBeforeResize = null;
      this._activeHorizontalDirection = null;
    }

    // Returning to BASE restores the exact pre-grow bounds. Anchoring the
    // shrink on the grown bounds instead would re-anchor on whatever the
    // work-area clamp did on the way up, walking the pill away from where the
    // user put it a little more on every grow/shrink cycle.
    if (sizeKey === "BASE" && this._baseBoundsBeforeResize) {
      // The work area can shrink while the window is grown (dock/taskbar
      // reappearing, resolution change) — clamp the restore so the pill
      // cannot come back off-screen.
      const restored = {
        ...this._baseBoundsBeforeResize,
        ...WindowPositionUtil.clampToWorkArea(this._baseBoundsBeforeResize, display),
      };
      const restoreAnchor = this._mainWindowResizeAnchor();
      this._baseBoundsBeforeResize = null;
      if (
        restored.x === currentBounds.x &&
        restored.y === currentBounds.y &&
        restored.width === currentBounds.width &&
        restored.height === currentBounds.height
      ) {
        // Nothing moved (BASE and the grown size share bounds) — skip the mask
        // handshake and setBounds so the restore cannot perturb the renderer.
        this._lastResizeBounds = restored;
        this._activeHorizontalDirection = null;
        this._notifyMainWindowHorizontalDirection();
        return { success: true, bounds: restored, changed: false };
      }
      await this._prepareRendererForMainWindowResize(restored, restoreAnchor);
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        return { success: false, message: "Window not available" };
      }
      this._lastResizeBounds = restored;
      this.mainWindow.setBounds(restored);
      this._activeHorizontalDirection = null;
      this._notifyMainWindowHorizontalDirection();
      return { success: true, bounds: restored, changed: true };
    }

    if (
      sizeKey !== "BASE" &&
      !this._baseBoundsBeforeResize &&
      Math.abs(currentBounds.width - WINDOW_SIZES.BASE.width) <= PLACEMENT_SIZE_SLACK_PX &&
      Math.abs(currentBounds.height - WINDOW_SIZES.BASE.height) <= PLACEMENT_SIZE_SLACK_PX
    ) {
      // Fractional scaling rounds the resting window a pixel or two off BASE;
      // record the exact BASE box at the pill's anchor so the restore neither
      // misses it nor feeds the rounded size back in.
      this._baseBoundsBeforeResize = WindowPositionUtil.anchorToRestingBounds(
        currentBounds,
        WINDOW_SIZES.BASE,
        this._panelStartPosition,
        display
      );
      this._activeHorizontalDirection = resolveHorizontalWindowDirection(
        currentBounds,
        display,
        this._panelStartPosition
      );
    }

    if (sizeKey !== "BASE" && !this._activeHorizontalDirection) {
      this._activeHorizontalDirection = resolveHorizontalWindowDirection(
        currentBounds,
        display,
        this._panelStartPosition
      );
    }
    const position = this._mainWindowResizeAnchor();

    // Keep the pill's docked edge fixed: the top edge for the top row (surfaces
    // open downward), the bottom edge otherwise (they open upward); and its
    // side of the window, or its center.
    const horizontalAnchor =
      position === "center" || position === "top-center"
        ? "center"
        : position.endsWith("-left")
          ? "left"
          : "right";
    let newX;
    if (horizontalAnchor === "left") {
      newX = currentBounds.x;
    } else if (horizontalAnchor === "center") {
      newX = currentBounds.x + currentBounds.width / 2 - newSize.width / 2;
    } else {
      newX = currentBounds.x + currentBounds.width - newSize.width;
    }
    const newY = position.startsWith("top")
      ? currentBounds.y
      : currentBounds.y + currentBounds.height - newSize.height;

    const clamped = WindowPositionUtil.clampToWorkArea({ x: newX, y: newY, ...newSize }, display);
    const newBounds = { ...clamped, ...newSize };

    // Opening a voice mode and the size-priority effect can request the same
    // footprint in adjacent ticks. Avoid asking the OS compositor to rebuild
    // an unchanged transparent window surface.
    if (
      currentBounds.x === newBounds.x &&
      currentBounds.y === newBounds.y &&
      currentBounds.width === newBounds.width &&
      currentBounds.height === newBounds.height
    ) {
      this._lastResizeBounds = { ...currentBounds };
      if (sizeKey === "BASE") {
        this._activeHorizontalDirection = null;
        this._notifyMainWindowHorizontalDirection();
      }
      return { success: true, bounds: currentBounds, changed: false };
    }

    await this._prepareRendererForMainWindowResize(newBounds, position);
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }
    this.mainWindow.setBounds(newBounds);
    this._lastResizeBounds = newBounds;
    if (sizeKey === "BASE") {
      this._activeHorizontalDirection = null;
      this._notifyMainWindowHorizontalDirection();
    }

    return { success: true, bounds: newBounds, changed: true };
  }

  async loadWindowContent(window, isControlPanel = false, query = {}) {
    if (process.env.NODE_ENV === "development") {
      const appUrl = DevServerManager.getAppUrl(isControlPanel, query);
      await DevServerManager.waitForDevServer();
      await window.loadURL(appUrl);
    } else {
      const fileInfo = DevServerManager.getAppFilePath(isControlPanel, query);
      if (!fileInfo) {
        throw new Error("Failed to get app file path");
      }

      const fs = require("fs");
      if (!fs.existsSync(fileInfo.path)) {
        throw new Error(`HTML file not found: ${fileInfo.path}`);
      }

      await window.loadFile(fileInfo.path, { query: fileInfo.query });
    }
  }

  async loadMainWindow() {
    await this.loadWindowContent(this.mainWindow, false);
  }

  createHotkeyCallback() {
    const isPress = createHotkeyRepeatGate();

    // globalShortcut registrations pass the hotkey that fired; native shortcuts
    // use down/up phases and resolve their primary hotkey from the active slot.
    // A style key (Stage 4) names its style; the dictation hotkey names none.
    return async (triggeredHotkey, phase) => {
      if (this.hotkeyManager.isInListeningMode()) {
        return;
      }
      if (this.isDictationProcessing()) {
        return;
      }

      const activationMode = this.getActivationMode();
      const currentHotkey = triggeredHotkey || this.hotkeyManager.getCurrentHotkey?.();
      const styleId = this.hotkeyManager.getStyleIdForHotkey?.(currentHotkey) || undefined;

      if (process.platform === "linux" && activationMode === "push") {
        if (phase === "down") {
          this.startWindowsPushToTalk(currentHotkey, undefined, { styleId });
        } else if (phase === "up") {
          this.handleWindowsPushKeyUp(currentHotkey);
        }
        return;
      }
      if (phase === "up") return;

      if (
        process.platform === "darwin" &&
        activationMode === "push" &&
        currentHotkey &&
        !isGlobeLikeHotkey(currentHotkey) &&
        currentHotkey.includes("+")
      ) {
        this.startMacCompoundPushToTalk(currentHotkey);
        return;
      }

      // Push mode: defer to native listener (globalShortcut can't detect key-up)
      if (
        (process.platform === "win32" || process.platform === "linux") &&
        activationMode === "push"
      ) {
        return;
      }

      if (!isPress()) return;
      this.sendToggleDictation({ styleId });
    };
  }

  startMacCompoundPushToTalk(hotkey) {
    if (!this._isOnboardingInputAllowed("dictation")) return;
    if (this.macCompoundPushState?.active || this.isDictationProcessing()) {
      return;
    }

    const requiredModifiers = this.getMacRequiredModifiers(hotkey);
    if (requiredModifiers.size === 0) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const MAX_PUSH_DURATION_MS = 300000; // 5 minutes max recording
    const downTime = Date.now();

    const targetPidPromise = this.textEditMonitor?.captureTargetPid?.();
    this.showDictationPanel({ reposition: true, targetPidPromise });
    this.sendPrepareDictation();

    const safetyTimeoutId = setTimeout(() => {
      if (this.macCompoundPushState?.active) {
        debugLogger.warn("Compound PTT safety timeout", undefined, "ptt");
        this.forceStopMacCompoundPush("timeout");
      }
    }, MAX_PUSH_DURATION_MS);

    this.macCompoundPushState = {
      active: true,
      hotkey,
      downTime,
      isRecording: false,
      requiredModifiers,
      safetyTimeoutId,
    };

    setTimeout(() => {
      if (!this.macCompoundPushState || this.macCompoundPushState.downTime !== downTime) {
        return;
      }

      if (!this.macCompoundPushState.isRecording) {
        this.macCompoundPushState.isRecording = true;
        this.sendStartDictation();
      }
    }, MIN_HOLD_DURATION_MS);
  }

  handleMacPushModifierUp(modifier) {
    if (!this.macCompoundPushState?.active) {
      return;
    }

    if (!this.macCompoundPushState.requiredModifiers.has(modifier)) {
      return;
    }

    // The press came through globalShortcut, which can't see the release.
    this.hotkeyManager.logHotkeyEvent("macos-native", "up", this.macCompoundPushState.hotkey);

    if (this.macCompoundPushState.safetyTimeoutId) {
      clearTimeout(this.macCompoundPushState.safetyTimeoutId);
    }

    const wasRecording = this.macCompoundPushState.isRecording;
    this.macCompoundPushState = null;

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      this.sendCancelDictationPreparation();
      this.hideDictationPanel();
    }
  }

  // A push that ends without a physical release leaves the trigger keys down, so
  // an injected paste shortcut lands in a modifier state the target app cannot
  // interpret and the transcript is lost. Tell the renderer to hold the text
  // back instead of pasting it.
  _notifyPushForceStopped(reason) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("dictation-force-stopped", { reason });
    }
  }

  forceStopMacCompoundPush(reason = "manual") {
    if (!this.macCompoundPushState) {
      return;
    }

    if (this.macCompoundPushState.safetyTimeoutId) {
      clearTimeout(this.macCompoundPushState.safetyTimeoutId);
    }

    const wasRecording = this.macCompoundPushState.isRecording;
    this.macCompoundPushState = null;

    this._notifyPushForceStopped(reason);

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      this.sendCancelDictationPreparation();
      this.hideDictationPanel();
    }
  }

  getMacRequiredModifiers(hotkey) {
    const required = new Set();
    const parts = hotkey.split("+").map((part) => part.trim());

    for (const part of parts) {
      switch (part) {
        case "Command":
        case "Cmd":
        case "RightCommand":
        case "RightCmd":
        case "CommandOrControl":
        case "Super":
        case "Meta":
          required.add("command");
          break;
        case "Control":
        case "Ctrl":
        case "RightControl":
        case "RightCtrl":
          required.add("control");
          break;
        case "Alt":
        case "Option":
        case "RightAlt":
        case "RightOption":
          required.add("option");
          break;
        case "Shift":
        case "RightShift":
          required.add("shift");
          break;
        case "Fn":
          required.add("fn");
          break;
        default:
          break;
      }
    }

    return required;
  }

  // `styleId` (Stage 4 style keys) is frozen with the push: prepare and start
  // both carry the style of the key that began it.
  startWindowsPushToTalk(key, keyTiming, { styleId } = {}) {
    if (!this._isOnboardingInputAllowed("dictation")) return;
    if (this.winPushState?.active || this.isDictationProcessing()) {
      return;
    }

    const MIN_HOLD_DURATION_MS = 150;
    const MAX_PUSH_DURATION_MS = 300000;
    const downTime = Date.now();
    // Travels with prepare and start so the renderer can log where the time
    // between the physical key press and the recording went.
    const trace = {
      pressId: downTime,
      keyAt: keyTiming?.eventAt ?? downTime,
      keyTimeSource: keyTiming?.eventAt ? "os" : "main",
      hookAt: keyTiming?.hookAt,
      mainAt: downTime,
    };
    const pushStyleId = typeof styleId === "string" && styleId ? styleId : undefined;

    const pillWasVisible = this._isPillOnScreen();
    this.showDictationPanel({ reposition: true });
    if (this.sendPrepareDictation({ trace, styleId: pushStyleId })) {
      this._beginStartVisuals(trace, { pillWasVisible });
      this._probeStartVisuals({ ready: true });
    }

    const safetyTimeoutId = setTimeout(() => {
      if (!this.winPushState || this.winPushState.downTime !== downTime) return;
      debugLogger.warn("Native PTT safety timeout", undefined, "ptt");
      this.handleWindowsPushKeyUp(undefined, { reason: "timeout" });
    }, MAX_PUSH_DURATION_MS);

    this.winPushState = {
      active: true,
      key,
      styleId: pushStyleId ?? null,
      downTime,
      isRecording: false,
      safetyTimeoutId,
    };

    setTimeout(() => {
      if (!this.winPushState || this.winPushState.downTime !== downTime) {
        return;
      }

      if (!this.winPushState.isRecording) {
        this.winPushState.isRecording = true;
        this.sendStartDictation({ trace, styleId: this.winPushState.styleId ?? undefined });
      }
    }, MIN_HOLD_DURATION_MS);
  }

  // With several dictation hotkeys bound, only the key that started the push may
  // stop it; called without a key to force-stop. "release" is the user letting
  // go; every other reason ends a push whose trigger keys are still physically
  // down, which the renderer must know before it pastes.
  handleWindowsPushKeyUp(key, { reason = "release" } = {}) {
    if (!this.winPushState?.active) {
      return;
    }
    if (key && this.winPushState.key && key !== this.winPushState.key) {
      return;
    }

    if (this.winPushState.safetyTimeoutId) {
      clearTimeout(this.winPushState.safetyTimeoutId);
    }

    const wasRecording = this.winPushState.isRecording;
    this.winPushState = null;

    if (reason !== "release") this._notifyPushForceStopped(reason);

    if (wasRecording) {
      this.sendStopDictation();
    } else {
      // Released before the hold started a recording.
      this._startVisuals?.cancelled();
      this.sendCancelDictationPreparation();
      this.hideDictationPanel();
    }
  }

  resetWindowsPushState() {
    if (!this.winPushState?.active) {
      return;
    }

    this.handleWindowsPushKeyUp(undefined, { reason: "reset" });
  }

  _isOnboardingInputAllowed(inputKind) {
    return isOnboardingInputAllowed(this._onboardingActive, this._onboardingDemoKind, inputKind);
  }

  // "meeting" is never a demo kind, so this is simply "not during onboarding".
  isMeetingInputAllowed() {
    return this._isOnboardingInputAllowed("meeting");
  }

  // The one entry for starting a meeting by hand: the meeting hotkey, the pill's
  // command menu, and the tray. Fails closed during onboarding and while a
  // hotkey is being captured, like every hotkey slot.
  async startManualMeeting(options) {
    if (this.hotkeyManager.isInListeningMode() || !this.isMeetingInputAllowed()) return;
    try {
      await this.meetingDetectionEngine?.startManualMeeting(options);
    } catch (error) {
      debugLogger.error("Failed to start manual meeting", { error: error.message }, "meeting");
    }
  }

  // "Review last dictation", from its hotkey and the tray. Like every hotkey
  // slot it does nothing during onboarding or while a hotkey is being captured
  // ("review" is never a demo kind).
  async reviewLastDictation() {
    if (this.hotkeyManager.isInListeningMode() || !this._isOnboardingInputAllowed("review")) {
      return;
    }
    try {
      await this.dictationReview?.run();
    } catch (error) {
      debugLogger.error("Failed to open the review", { error: error.message }, "history");
    }
  }

  // The pill says why the review didn't open; the dictation is left alone.
  notifyReviewBusy() {
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    win.webContents.send("review-dictation-busy");
  }

  // The control panel asks for the request once its renderer is ready
  // (get-pending-review-request); one created here hears it on mount.
  async queueReviewRequest(request) {
    this._pendingReviewRequest = request;
    const existed = Boolean(this.controlPanelWindow && !this.controlPanelWindow.isDestroyed());
    await this.createControlPanelWindow();
    if (!existed) this.showControlPanel();
    this.sendToControlPanel("review-dictation-pending");
  }

  consumePendingReviewRequest() {
    const request = this._pendingReviewRequest;
    this._pendingReviewRequest = null;
    return request;
  }

  // "Open in History" on a dictation error card: History at that dictation's
  // row, with no review drafted. Shown and focused like a review request, and
  // held the same way until the control panel asks for it
  // (get-pending-history-item-request), so a panel still loading gets it.
  async queueHistoryItemRequest(request) {
    this._pendingHistoryItemRequest = request;
    const existed = Boolean(this.controlPanelWindow && !this.controlPanelWindow.isDestroyed());
    await this.createControlPanelWindow();
    if (!existed) this.showControlPanel();
    this.sendToControlPanel("history-item-pending");
  }

  consumePendingHistoryItemRequest() {
    const request = this._pendingHistoryItemRequest ?? null;
    this._pendingHistoryItemRequest = null;
    return request;
  }

  // The auto-learn suggestion toast's Review: the Dictionary page with its
  // suggestions, shown and held like a History request until the control
  // panel asks (get-pending-dictionary-suggestions-request).
  async queueDictionarySuggestionsRequest() {
    this._pendingDictionarySuggestionsRequest = true;
    await this.createControlPanelWindow();
    this.showControlPanel();
    this.sendToControlPanel("dictionary-suggestions-pending");
  }

  consumePendingDictionarySuggestionsRequest() {
    const pending = this._pendingDictionarySuggestionsRequest === true;
    this._pendingDictionarySuggestionsRequest = false;
    return pending;
  }

  // The assistant is listening: the microphone is its until the take ends.
  _shouldBlockDictationInput() {
    return Boolean(this.agentWindow?.isRecording());
  }

  _sendDictationToggle(channel, inputKind, payload) {
    if (!this._isOnboardingInputAllowed(inputKind)) return;
    if (this._shouldBlockDictationInput()) {
      return;
    }
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (shouldIgnoreDictationHotkey(this._dictationLifecycleState)) {
      debugLogger.debug("Ignoring dictation toggle while transcription is processing", {
        channel,
      });
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const isStarting = !this._isDictatingToggle;
      // A start press is stamped like a hold's (the key time is main's own),
      // so the renderer's start trace and the start visuals share its pressId.
      const pressAt = Date.now();
      const trace = isStarting
        ? { pressId: pressAt, keyAt: pressAt, keyTimeSource: "main", mainAt: pressAt }
        : null;
      // Capture the paste target and any selection on every toggle press,
      // before the overlay steals focus — the paste can't refocus the target
      // otherwise (#668). The renderer owns the real recording state and may
      // decline a toggle (mic error, silence gate, Esc cancel), so gating this
      // on _isDictatingToggle desyncs and leaves a stale target from a
      // previous app. Press-time capture matches the dictation hotkey call
      // sites in main.js; a stop-press capture resolves the same frontmost
      // app, since NSWorkspace ignores the overlay panel.
      const targetPidPromise = this.textEditMonitor?.captureTargetPid?.();
      void this.selectionManager?.captureTarget?.({ force: !isStarting });
      if (!isStarting) {
        this._mainWindowPlacementCoordinator.cancelPending();
      }
      const pillWasVisible = this._isPillOnScreen();
      this.showDictationPanel({
        reposition: isStarting,
        targetPidPromise,
      });
      // About-to-start guess: open the mic one IPC message ahead of the toggle.
      // A wrong guess (renderer declines) is bounded by the prepared capture's
      // max-age expiry, and the renderer dedups its own prepare call. Pass the
      // toggle's own kind so the pre-warm survives the assistant demo, whose
      // gate rejects "dictation".
      if (isStarting) {
        this.sendPrepareDictation({ inputKind, styleId: payload?.styleId, trace });
        this._beginStartVisuals(trace, { pillWasVisible });
      }
      const message = trace
        ? { ...(payload || {}), trace: { ...trace, startSentAt: Date.now() } }
        : payload;
      if (message) this.mainWindow.webContents.send(channel, message);
      else this.mainWindow.webContents.send(channel);
      if (isStarting) this._probeStartVisuals({ ready: true });
    }
  }

  setDictationLifecycleState(state, attempt, details) {
    const nextState = normalizeDictationLifecycle(state);
    if (attempt !== undefined) {
      if (nextState === DICTATION_LIFECYCLE.PREPARING && !this._dictationAttempt) {
        if (this.agentWindow?.isRecording()) return false;
        this._dictationAttempt = attempt;
      }
      if (this._dictationAttempt !== attempt) return false;
    }
    if (nextState === DICTATION_LIFECYCLE.IDLE) this._dictationAttempt = null;
    const nextInputKind = normalizeRecordingInputKind(details?.inputKind);
    if (nextState === this._dictationLifecycleState) {
      // The same state in another mode only recolors what shows the recording.
      if (nextState !== DICTATION_LIFECYCLE.IDLE && nextInputKind !== this._dictationInputKind) {
        this._dictationInputKind = nextInputKind;
        this.recordingEdgeStrip.setRecording(this._isDictatingToggle, nextInputKind);
      }
      return true;
    }

    const wasRecording = this._isDictatingToggle;
    this._dictationLifecycleState = nextState;
    this._dictationInputKind = nextInputKind;
    this._isDictatingToggle = isDictationRecording(nextState);
    // One start time for every surface that shows the elapsed time (the pill,
    // the tray) and for the reminders, set once per recording.
    if (!this._isDictatingToggle) this._recordingStartedAt = null;
    else if (!wasRecording)
      this._recordingStartedAt = resolveRecordingStartedAt(details?.startedAt, Date.now());
    // Before the strip: a strip window it can reuse shows at once.
    if (this._isDictatingToggle && !wasRecording) this._startVisuals?.recordingStarted();
    else if (!this._isDictatingToggle && wasRecording) this._startVisuals?.recordingEnded();
    else if (nextState === DICTATION_LIFECYCLE.IDLE) this._startVisuals?.cancelled();
    this.recordingEdgeStrip.setRecording(this._isDictatingToggle, this._dictationInputKind);
    this._scheduleRecordingReminder();
    this.syncUserRecording();
    this._sendDictationLifecycleToControlPanel();
    this.onDictationStateChanged?.();
    return true;
  }

  /** The dictation lifecycle as the dictation window last reported it. */
  getDictationLifecycle() {
    return { state: this._dictationLifecycleState, inputKind: this._dictationInputKind };
  }

  // The lifecycle goes idle before the paste and the save that follow it, so
  // the dictation window reports those separately (dictation-delivery-state).
  // Announced like the lifecycle: the tray's Restart waits for the delivery.
  setDictationDeliveryState(delivering) {
    const next = delivering === true;
    if (next === this._dictationDelivering) return;
    this._dictationDelivering = next;
    this.onDictationStateChanged?.();
  }

  /** A dictation is being made or still delivered: the review action waits for it. */
  isDictationBusy() {
    return this.isDictationActive() || this._dictationDelivering;
  }

  // Prompt Studio's test set gives way to a dictation, so the control panel
  // follows the lifecycle. A panel still loading asks for it once it mounts.
  _sendDictationLifecycleToControlPanel() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed?.() || win.webContents?.isLoading?.()) return;
    win.webContents?.send?.("dictation-lifecycle-changed", this.getDictationLifecycle());
  }

  getRecordingStartedAt() {
    return this._recordingStartedAt;
  }

  getDictationInputKind() {
    return this._dictationInputKind;
  }

  // "Remind me while recording": at each whole interval since the start, the
  // strip or frame pulses and the pill that shows the recording pulses too.
  _scheduleRecordingReminder(now = Date.now()) {
    this._clearRecordingReminder();
    if (!this._isDictatingToggle || this._recordingStartedAt === null) return;
    const delay = nextRecordingReminderDelay({
      startedAt: this._recordingStartedAt,
      now,
      minutes: this._recordingIndicatorSettings.reminderMinutes,
    });
    if (delay === null) return;
    const mark = now + delay;
    this._recordingReminderTimer = setTimeout(() => {
      this._recordingReminderTimer = null;
      this._fireRecordingReminder();
      // A timer may fire a little early; counting from the mark keeps it from
      // firing twice for the same one.
      this._scheduleRecordingReminder(Math.max(Date.now(), mark));
    }, delay);
  }

  _clearRecordingReminder() {
    if (!this._recordingReminderTimer) return;
    clearTimeout(this._recordingReminderTimer);
    this._recordingReminderTimer = null;
  }

  _fireRecordingReminder() {
    this.recordingEdgeStrip.pulse?.();
    const owner = this._recordingPillOwner();
    if (!owner) return;
    owner.webContents.send("recording-reminder", {
      startedAt: this._recordingStartedAt,
      inputKind: this._dictationInputKind,
    });
  }

  // Every dictation recording shows on the dictation window's own pill.
  _recordingPillOwner() {
    const main = this.mainWindow;
    return main && !main.isDestroyed() ? main : null;
  }

  // The dictation renderer reports the lifecycle, so one that crashes, reloads
  // or closes mid-recording would leave main believing it still records: the
  // edge strip would stay up and the recording gate would stay stuck. Main
  // resets it itself.
  _registerDictationLifecycleReset(win) {
    if (!win) return;
    const contents = win.webContents;
    // A window that has since been replaced must not reset its successor's.
    const replaced = () => Boolean(this.mainWindow) && this.mainWindow.webContents !== contents;
    contents.on("render-process-gone", (_event, details) => {
      if (!replaced()) this._resetDictationLifecycle("render-process-gone", details?.reason);
    });
    // Electron passes the details object first; the positional arguments are
    // the older form of the same values.
    contents.on("did-start-navigation", (details, _url, isInPlace, legacyIsMainFrame) => {
      const isMainFrame = details?.isMainFrame ?? legacyIsMainFrame;
      const isSameDocument = details?.isSameDocument ?? isInPlace;
      if (isMainFrame && !isSameDocument && !replaced())
        this._resetDictationLifecycle("navigation");
    });
    win.on("closed", () => {
      if (replaced()) return;
      this._resetDictationLifecycle("closed");
      this.recordingEdgeStrip.release();
    });
  }

  _resetDictationLifecycle(reason, detail) {
    // A renderer that went away mid-paste can't report the end of it either.
    this.setDictationDeliveryState(false);
    if (this._dictationLifecycleState === DICTATION_LIFECYCLE.IDLE) return;
    debugLogger.info(
      "[WindowManager] Dictation renderer went away; resetting its lifecycle",
      { reason, detail, state: this._dictationLifecycleState },
      "window"
    );
    this.setDictationLifecycleState(DICTATION_LIFECYCLE.IDLE, undefined, {
      inputKind: this._dictationInputKind,
    });
  }

  // The dictation window reports the settings of the indicators main draws:
  // the edge strip or frame, and the tray icon. They are kept, since the tray
  // is created after that window first reports.
  setRecordingIndicatorSettings(settings) {
    const normalized = normalizeRecordingIndicatorSettings(settings);
    this._recordingIndicatorSettings = normalized;
    this.recordingEdgeStrip.configure(normalized);
    this._scheduleRecordingReminder();
    this.onRecordingIndicatorSettings?.(normalized);
  }

  getRecordingIndicatorSettings() {
    return this._recordingIndicatorSettings;
  }

  previewRecordingEdgeStrip(settings) {
    // Without the dictation window there's nothing to record with, and strip
    // windows left behind would count as the app's windows.
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return { success: false };
    return { success: this.recordingEdgeStrip.preview(settings) };
  }

  // The strip follows the pill's own display, read when it shows, so a drag
  // to another monitor takes it along.
  _edgeStripPillDisplay() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      return this._getMainWindowDisplayFor(this.mainWindow.getBounds());
    }
    return this._resolveLockedDisplay() || screen.getPrimaryDisplay();
  }

  // The tray's listen item is a toggle over this state, like the pill's.
  isDictating() {
    return this._isDictatingToggle;
  }

  // Preparing, recording or processing: the agent window stays off the mic.
  isDictationActive() {
    return this._dictationLifecycleState !== DICTATION_LIFECYCLE.IDLE;
  }

  // Talking to the assistant is the user recording too: it must not read as a
  // meeting starting.
  syncUserRecording() {
    this.meetingDetectionEngine?.setUserRecording(
      this._isDictatingToggle || Boolean(this.agentWindow?.isRecording())
    );
  }

  isDictationProcessing() {
    return shouldIgnoreDictationHotkey(this._dictationLifecycleState);
  }

  sendToggleDictation({ styleId } = {}) {
    // A style key (Stage 4) names its style; the dictation hotkey names none,
    // so the renderer applies the style chosen for it.
    this._sendDictationToggle(
      "toggle-dictation",
      "dictation",
      typeof styleId === "string" && styleId ? { styleId } : undefined
    );
  }

  // The assistant lives in its own window. Onboarding's assistant demo is the
  // exception: it still records in the dictation window, whose gate admits it.
  sendToggleVoiceAgent() {
    if (this._onboardingActive) {
      this._sendDictationToggle("toggle-voice-agent", "assistant");
      return;
    }
    this.agentWindow?.handleHotkey();
  }

  sendToggleTranslation() {
    this._sendDictationToggle("toggle-translation", "translation");
  }

  // The pill explains a refused meeting start the way it explains a refused
  // tray action: the start may have come from a hotkey with nothing else shown.
  sendMeetingStartRefused(code) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("meeting-start-refused", code);
  }

  // The tray's and the pill menu's Ask assistant: the agent window opens to the
  // composer, and its renderer explains a policy refusal itself.
  openAgentWindow() {
    this.agentWindow?.open({ layout: "typing" });
  }

  sendStartDictation({ trace, styleId } = {}) {
    if (!this._isOnboardingInputAllowed("dictation")) return;
    if (this._shouldBlockDictationInput()) {
      return;
    }
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (shouldIgnoreDictationHotkey(this._dictationLifecycleState)) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const targetPidPromise = this.textEditMonitor?.captureTargetPid?.();
      void this.selectionManager?.captureTarget?.();
      this.showDictationPanel({ reposition: true, targetPidPromise });
      // The style travels with the start, so the recording carries the style
      // of the key that started it (Stage 4); none means the hotkey's style.
      const hasStyle = typeof styleId === "string" && styleId.length > 0;
      this.mainWindow.webContents.send(
        "start-dictation",
        trace || hasStyle
          ? {
              ...(trace ? { trace: { ...trace, startSentAt: Date.now() } } : {}),
              ...(hasStyle ? { styleId } : {}),
            }
          : undefined
      );
    }
  }

  sendStopDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stop-dictation");
    }
  }

  sendPrepareDictation({ inputKind = "dictation", trace, styleId } = {}) {
    if (!this._isOnboardingInputAllowed(inputKind)) return false;
    if (this._shouldBlockDictationInput()) {
      return false;
    }
    if (this.hotkeyManager.isInListeningMode()) {
      return false;
    }
    if (shouldIgnoreDictationHotkey(this._dictationLifecycleState)) {
      return false;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("prepare-dictation", {
        inputKind,
        ...(trace && { trace: { ...trace, prepareSentAt: Date.now() } }),
        ...(typeof styleId === "string" && styleId && { styleId }),
      });
      return true;
    }
    return false;
  }

  sendCancelDictationPreparation() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("cancel-dictation-preparation");
    }
  }

  sendCancelDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("cancel-dictation-preparation");
      this.mainWindow.webContents.send("cancel-hotkey-pressed");
    }
  }

  // Esc while a dictation has been processing for long (the dictation window
  // holds it then): cancels that processing only. Kept apart from
  // cancel-hotkey-pressed, which sendCancelDictation's input resets share.
  sendCancelProcessingHotkey() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("cancel-processing-hotkey-pressed");
    }
  }

  getActivationMode() {
    return this._cachedActivationMode;
  }

  async setActivationModeCache(mode) {
    const nextMode = mode === "push" ? "push" : "tap";
    const success = await this.hotkeyManager.setActivationMode(nextMode);
    if (!success) return false;
    this._cachedActivationMode = nextMode;
    return true;
  }

  // Called once dispatch handlers and optional slots are installed. Registration
  // may still be reading the saved dictation key or falling back to another backend.
  async initializeNativeKeyListeners() {
    await this.hotkeyManager.registrationReady;
    this._nativeKeyListenersReady = true;
    this.reconcileNativeKeyListeners();
  }

  /**
   * Sync the native low-level key listeners (Windows/Linux) so every hotkey slot
   * that needs one is watched. Call after any change to a slot hotkey or the
   * activation mode. No-op during hotkey capture (listeners are stopped then).
   */
  reconcileNativeKeyListeners() {
    if (this.isQuitting || !this._nativeKeyListenersReady) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.hotkeyManager.isInListeningMode()) return;
    const activationMode = this.getActivationMode();
    const nativeListenerKeys = this.hotkeyManager.getNativeListenerKeys(activationMode);
    // Native desktop shortcuts replace the low-level listener in tap mode. In
    // push mode, keep the dictation listener as a release-event fallback; the
    // push state machine makes duplicate backend and low-level phases harmless.
    const keys = this.hotkeyManager.isUsingNativeShortcut()
      ? activationMode === "push"
        ? nativeListenerKeys.filter((key) => this.hotkeyManager.slotHasHotkey("dictation", key))
        : []
      : nativeListenerKeys;
    if (process.platform === "win32" && this.windowsKeyManager) {
      this.windowsKeyManager.setKeys(keys);
    } else if (process.platform === "linux" && this.linuxKeyManager) {
      this.linuxKeyManager.setKeys(keys);
    }
  }

  setFloatingIconAutoHide(enabled) {
    this._floatingIconAutoHide = Boolean(enabled);
  }

  getMainWindowHorizontalDirection() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return parsePanelPosition(this._panelStartPosition).horizontal === "left" ? "left" : "right";
    }
    const bounds = this.mainWindow.getBounds();
    const display = this._getMainWindowDisplayFor(bounds);
    return resolveHorizontalWindowDirection(bounds, display, this._panelStartPosition);
  }

  _notifyMainWindowHorizontalDirection() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(
      "main-window-horizontal-direction-changed",
      this.getMainWindowHorizontalDirection()
    );
  }

  setPanelStartPosition(position) {
    const next = normalizePanelPosition(position);
    if (next === this._panelStartPosition) return;
    this._panelStartPosition = next;
    this._applyChangedPlacementSetting();
  }

  setFloatingIconDisplay(display, label = "") {
    const nextDisplay = normalizeFloatingIconDisplay(display);
    const nextLabel = typeof label === "string" ? label.trim() : "";
    if (nextDisplay === this._floatingIconDisplay && nextLabel === this._floatingIconDisplayLabel) {
      return;
    }
    this._floatingIconDisplay = nextDisplay;
    this._floatingIconDisplayLabel = nextLabel;
    this._lastLockedDisplayMatch = null;
    this._applyChangedPlacementSetting();
  }

  // A new placement setting is the user choosing a spot: it replaces any drag
  // and applies right away, refitting an open panel rather than collapsing it.
  _applyChangedPlacementSetting() {
    this._mainWindowPlacementCoordinator.resetManualPosition();
    this._manualRestingBounds = null;
    this._activeHorizontalDirection = null;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    void this._enqueueMainWindowMutation(() => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return { applied: false };
      const result = this._commitPlacement(this._resolvePlacementDisplay(), { reason: "setting" });
      this._notifyMainWindowHorizontalDirection();
      return result;
    });
  }

  // Shows the pill at its configured spot for a moment, so a settings change
  // can be seen without dictating. The renderer holds auto-hide off for the
  // preview and hides the pill again only if nothing else claimed it.
  async previewFloatingIconPlacement() {
    if (this._onboardingActive || !this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false };
    }
    this._mainWindowPlacementCoordinator.resetManualPosition();
    this._manualRestingBounds = null;
    await this._enqueueMainWindowMutation(() =>
      this.mainWindow && !this.mainWindow.isDestroyed()
        ? this._commitPlacement(this._resolvePlacementDisplay({ followCursor: true }), {
            reason: "preview",
          })
        : { applied: false }
    );
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return { success: false };
    this.mainWindow.webContents.send("floating-icon-placement-preview", {
      durationMs: PLACEMENT_PREVIEW_MS,
    });
    this._surfaceMainWindow(false);
    return { success: true };
  }

  getDisplaysForSettings() {
    const primaryId = screen.getPrimaryDisplay()?.id;
    return screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      label: typeof display.label === "string" ? display.label : "",
      primary: display.id === primaryId,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
    }));
  }

  // The configured display, re-read from the connected displays each time so a
  // removed monitor is never used. Null when the icon follows the cursor.
  _resolveLockedDisplay() {
    if (!isFloatingIconDisplayLocked(this._floatingIconDisplay)) return null;
    const resolved = resolvePreferredDisplay({
      preference: this._floatingIconDisplay,
      label: this._floatingIconDisplayLabel,
      displays: screen.getAllDisplays(),
      primaryDisplay: screen.getPrimaryDisplay(),
    });
    if (resolved && resolved.matchedBy !== this._lastLockedDisplayMatch) {
      this._lastLockedDisplayMatch = resolved.matchedBy;
      debugLogger.info(
        "[WindowManager] Floating icon display resolved",
        {
          preference: this._floatingIconDisplay,
          label: this._floatingIconDisplayLabel,
          matchedBy: resolved.matchedBy,
          displayId: resolved.display?.id,
        },
        "window"
      );
    }
    return resolved?.display ? plasmaWorkAreas.resolve(resolved.display) : null;
  }

  // Where a placement that isn't a dictation start lands: the locked display,
  // or, following the cursor, the display the pill is already on (a settings
  // change keeps it there) or the one under the mouse (a preview shows it
  // where dictating would).
  _resolvePlacementDisplay({ followCursor = false } = {}) {
    const locked = this._resolveLockedDisplay();
    if (locked) return locked;
    if (followCursor) {
      return plasmaWorkAreas.resolve(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
    }
    return this._getMainWindowDisplayFor(this.mainWindow.getBounds());
  }

  // Configured bounds on `display` for the window's current surface. A resting
  // pill gets the exact BASE bounds; a grown surface keeps the resting pill's
  // anchor, and the resting bounds it returns to are recorded so a clamp on the
  // way can't make the pill drift.
  _configuredMainWindowBounds(display, currentBounds) {
    const base = WindowPositionUtil.getMainWindowPosition(
      display,
      WINDOW_SIZES.BASE,
      this._panelStartPosition
    );
    const size = { width: currentBounds.width, height: currentBounds.height };
    const grown =
      size.width > base.width + GROWN_SURFACE_THRESHOLD_PX ||
      size.height > base.height + GROWN_SURFACE_THRESHOLD_PX;
    const bounds = grown
      ? WindowPositionUtil.anchorToRestingBounds(base, size, this._panelStartPosition, display)
      : { ...base };
    return { base, bounds, grown };
  }

  // Puts the pill where the settings say on `display`. Runs inside the native
  // geometry queue, so a resize already in flight finishes first and nothing
  // queued earlier can overwrite it.
  _commitPlacement(display, { reason }) {
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !display) {
      return { applied: false, reason: "no-window" };
    }
    if (this.dragManager.isDragActive()) return { applied: false, reason: "dragging" };

    const currentBounds = this.mainWindow.getBounds();
    const coordinator = this._mainWindowPlacementCoordinator;
    if (coordinator.hasManualPosition()) {
      const manual = this._manualRestingBounds;
      if (
        manual &&
        isPointInWorkArea(pillRestingPoint(manual, this._panelStartPosition), display)
      ) {
        // The drag still applies. Put the pill back only when something else
        // (Windows, after a monitor change) moved it; a grown surface stays.
        const sameSize =
          Math.abs(manual.width - currentBounds.width) <= PLACEMENT_SIZE_SLACK_PX &&
          Math.abs(manual.height - currentBounds.height) <= PLACEMENT_SIZE_SLACK_PX;
        if (!sameSize || boundsWithin(manual, currentBounds)) {
          return { applied: false, reason: "manual-position" };
        }
        return this._setPlacedBounds({ ...manual }, null, {
          reason: `${reason}:manual`,
          display,
        });
      }
      // Dragged off the display the pill belongs on: the drag no longer applies.
      coordinator.releaseManualPosition();
      this._manualRestingBounds = null;
    }

    const { base, bounds, grown } = this._configuredMainWindowBounds(display, currentBounds);
    if (boundsWithin(bounds, currentBounds)) {
      if (grown && !this._baseBoundsBeforeResize) this._baseBoundsBeforeResize = base;
      return { applied: false, reason: "in-place" };
    }
    return this._setPlacedBounds(bounds, grown ? base : null, { reason, display });
  }

  _setPlacedBounds(bounds, restingBase, { reason, display }) {
    debugLogger.debug(
      "[WindowManager] Placing dictation panel",
      { reason, from: this.mainWindow.getBounds(), to: bounds, displayId: display?.id },
      "window"
    );
    this._clearRendererResizeMask();
    this.mainWindow.setBounds(bounds);
    // An intentional native move, not a drag: resize restoration must not read
    // it as the user moving the pill.
    this._lastResizeBounds = { ...bounds };
    this._baseBoundsBeforeResize = restingBase ? { ...restingBase } : null;
    this._activeHorizontalDirection = restingBase
      ? resolveHorizontalWindowDirection(restingBase, display, this._panelStartPosition)
      : null;
    this._notifyMainWindowHorizontalDirection();
    // A strip on the pill's monitor goes where the pill went.
    this.recordingEdgeStrip.refresh("placement");
    return { applied: true, bounds };
  }

  _listenForPlacementTopologyChanges() {
    if (this._placementTopologyListening) return;
    this._placementTopologyListening = true;
    const schedule = (event) => () => this._scheduleTopologyReconcile(event);
    for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
      screen.on(event, schedule(event));
    }
    powerMonitor?.on?.("resume", schedule("resume"));
    powerMonitor?.on?.("unlock-screen", schedule("unlock-screen"));
  }

  _scheduleTopologyReconcile(event) {
    for (const timer of this._topologyTimers) clearTimeout(timer);
    this._topologyTimers = TOPOLOGY_RECONCILE_DELAYS_MS.map((delay, pass) =>
      setTimeout(() => {
        if (pass === 0) this._broadcastDisplaysChanged();
        this.recordingEdgeStrip.handleDisplaysChanged();
        void this._enqueueMainWindowMutation(() => this._reconcilePlacementAfterTopology(event));
      }, delay)
    );
  }

  _broadcastDisplaysChanged() {
    const panel = this.controlPanelWindow;
    if (!panel || panel.isDestroyed()) return;
    panel.webContents.send("displays-changed", this.getDisplaysForSettings());
  }

  // After monitors change (or sleep, wake and unlock), put the pill back where
  // it belongs: Windows relocates windows off displays it is turning off and
  // does not move them back.
  _reconcilePlacementAfterTopology(event) {
    if (!this.mainWindow || this.mainWindow.isDestroyed() || this._onboardingActive) {
      return { applied: false, reason: "no-window" };
    }
    if (this.dragManager.isDragActive()) return { applied: false, reason: "dragging" };
    const currentBounds = this.mainWindow.getBounds();
    const display = this._resolveLockedDisplay() || this._getMainWindowDisplayFor(currentBounds);
    return this._commitPlacement(display, { reason: `topology:${event}` });
  }

  setHotkeyListeningMode(enabled) {
    this.hotkeyManager.setListeningMode(enabled);
  }

  async initializeHotkey() {
    await this.hotkeyManager.initializeHotkey(this.mainWindow, this.createHotkeyCallback());
  }

  async updateHotkey(hotkey) {
    const result = await this.hotkeyManager.updateHotkey(hotkey, this.createHotkeyCallback());
    // The style keys were registered again with the new dictation key; a
    // window showing their status follows.
    if (result?.success) void this.styleHotkeys?.notifyChanged?.();
    return result;
  }

  isUsingGnomeHotkeys() {
    return this.hotkeyManager.isUsingGnome();
  }

  isUsingHyprlandHotkeys() {
    return this.hotkeyManager.isUsingHyprland();
  }

  getHyprlandConfigStatus() {
    return this.hotkeyManager.getHyprlandConfigStatus();
  }

  isUsingKDEHotkeys() {
    return this.hotkeyManager.isUsingKDE();
  }

  isUsingNativeShortcutHotkeys() {
    return this.hotkeyManager.isUsingNativeShortcut();
  }

  // The control panel is transparent on macOS, where Electron ignores
  // `-webkit-app-region: drag` entirely — the renderer recreates its titlebar
  // drag through the shared DragManager instead (useControlPanelWindowDrag).
  // No pill bookkeeping: position ownership below is main-window-only.
  async startControlPanelDrag() {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }
    return await this.dragManager.startWindowDrag(this.controlPanelWindow);
  }

  async stopControlPanelDrag() {
    return await this.dragManager.stopWindowDrag();
  }

  async startWindowDrag() {
    // A lookup started by a prior hotkey must never land while the user is
    // taking ownership of the panel position.
    this._mainWindowPlacementCoordinator.cancelPending();
    this._dragStartBounds =
      this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow.getBounds() : null;
    return await this.dragManager.startWindowDrag();
  }

  async stopWindowDrag() {
    const result = await this.dragManager.stopWindowDrag();
    if (result.success && this.mainWindow && !this.mainWindow.isDestroyed()) {
      const draggedBounds = this.mainWindow.getBounds();
      const start = this._dragStartBounds;
      // Every pill click goes through start/stopWindowDrag; only an actual
      // move hands position ownership to the user.
      const moved =
        !start ||
        Math.abs(draggedBounds.x - start.x) > DRAG_MOVE_TOLERANCE_PX ||
        Math.abs(draggedBounds.y - start.y) > DRAG_MOVE_TOLERANCE_PX;
      if (moved) {
        this._mainWindowPlacementCoordinator.markManuallyPositioned();
        this._manualRestingBounds = { ...draggedBounds };
        this._baseBoundsBeforeResize = null;
        this._lastResizeBounds = { ...draggedBounds };
        this.recordingEdgeStrip.refresh("drag");
      }
    }
    this._dragStartBounds = null;
    this._activeHorizontalDirection = null;
    this._notifyMainWindowHorizontalDirection();
    return result;
  }

  openExternalUrl(url, showError = true) {
    openUrlInExternalBrowser(url).catch((error) => {
      if (showError) {
        dialog.showErrorBox(
          i18nMain.t("dialog.openLink.title"),
          i18nMain.t("dialog.openLink.message", { url, error: error.message })
        );
      }
    });
  }

  // Links in either window open in the default browser, never in an in-app
  // window or by navigating the app away from itself.
  registerExternalLinkHandlers(window, isControlPanel) {
    window.webContents.on("will-navigate", (event, url) => {
      // getAppUrl() is null in packaged builds; exactly one of the two is set.
      const appUrl =
        DevServerManager.getAppUrl(isControlPanel) ??
        pathToFileURL(DevServerManager.getAppFilePath(isControlPanel).path).href;

      if (isAllowedAppNavigation(url, appUrl)) {
        return;
      }

      event.preventDefault();
      if (isExternalBrowserUrl(url)) {
        this.openExternalUrl(url);
      } else {
        debugLogger.debug("Blocked untrusted navigation", { url }, "window");
      }
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternalOpenUrl(url)) {
        this.openExternalUrl(url);
      } else {
        debugLogger.debug("Blocked untrusted window open", { url }, "window");
      }
      return { action: "deny" };
    });

    window.webContents.on("did-create-window", (childWindow, details) => {
      childWindow.close();
      if (details.url && isExternalOpenUrl(details.url)) {
        this.openExternalUrl(details.url, false);
      }
    });
  }

  async createControlPanelWindow(options) {
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      this.showControlPanel(options);
      return;
    }

    this.controlPanelWindow = new BrowserWindow(CONTROL_PANEL_CONFIG);
    this._onboardingRestoreBounds = null;
    this._onboardingWindowMode = null;
    this._onboardingWindowState = null;

    this.registerExternalLinkHandlers(this.controlPanelWindow, true);

    // Nothing else shows this window: ready-to-show deliberately doesn't, so the
    // renderer can pick the onboarding size first and avoid a visible
    // expanded → compact flash on fresh installs. That makes this the only
    // backstop if the renderer never gets that far — it loads but throws, a lazy
    // chunk fails, or auth/policy resolution never settles — so it must outlive
    // did-finish-load. Only a real show cancels it.
    this._controlPanelVisibilityTimer = setTimeout(() => {
      this._showControlPanel();
    }, 10000);

    this.controlPanelWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.hideControlPanelToTray();
      }
    });

    this.controlPanelWindow.on("closed", () => {
      this.meetingDetectionEngine?.closeCurrentMeetingNote?.();
      this._clearControlPanelVisibilityTimer();
      this.endOnboardingDemo();
      this.controlPanelWindow = null;
      this._onboardingActive = true;
      this._hideNormalAppSurfaces();
      this._onboardingRestoreBounds = null;
      this._onboardingWindowMode = null;
      this._onboardingWindowState = null;
      dockManager.setControlPanelVisible(false);
    });

    MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => this.openSettings());

    // The initial load may already own a queued note; only release a replaced document's session.
    // On commit, not on start: a navigation will-navigate blocks leaves the document in place.
    let controlPanelDocumentLoaded = false;
    this.controlPanelWindow.webContents.on("did-navigate", () => {
      if (!controlPanelDocumentLoaded) return;
      controlPanelDocumentLoaded = false;
      this.meetingDetectionEngine?.closeCurrentMeetingNote?.();
    });
    this.controlPanelWindow.webContents.on("did-finish-load", () => {
      controlPanelDocumentLoaded = true;
      // Every fresh document starts unresolved. AppRouter releases the gate
      // only after it commits the normal app, so OAuth/onboarding reloads cannot
      // expose the dictation pill, hotkeys, or popup surfaces in between.
      this.setOnboardingActive(true);
      this.endOnboardingDemo();
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    });

    this.controlPanelWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        // An aborted navigation leaves the document in place; any other failure replaced it.
        if (errorCode !== ERR_ABORTED) this.meetingDetectionEngine?.closeCurrentMeetingNote?.();
        if (process.env.NODE_ENV !== "development") {
          this.showLoadFailureDialog("Control panel", errorCode, errorDescription, validatedURL);
        }
        // Show it regardless: a failed load can't reach the renderer path that
        // normally does, and a hidden window leaves the failure invisible.
        this._showControlPanel();
      }
    );

    this.controlPanelWindow.webContents.on("render-process-gone", (_event, details) => {
      this.meetingDetectionEngine?.closeCurrentMeetingNote?.();
      if (details.reason === "crashed" || details.reason === "killed" || details.reason === "oom") {
        debugLogger.error(
          "Control panel renderer process gone",
          { reason: details.reason, exitCode: details.exitCode },
          "window"
        );
        // The renderer owned any running demo; without this, its stale session
        // keeps swallowing dictations after the reload.
        this.endOnboardingDemo();
        setTimeout(() => this.loadControlPanel(), 1000);
      }
    });

    this.controlPanelWindow.on("show", () => {
      if (this.controlPanelWindow.webContents.isCrashed()) {
        debugLogger.error("Control panel crashed, reloading on show", undefined, "window");
        this.loadControlPanel();
      }
    });

    await this.loadControlPanel();
  }

  async loadControlPanel() {
    await this.loadWindowContent(this.controlPanelWindow, true);
  }

  async showTranscriptionPreview(text) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-text", text);
    // Partials arrive several times a second; re-showing a visible window
    // restacks it (and re-fires "show") on every chunk (#1262).
    if (!this.mainWindow.isVisible()) {
      this.mainWindow.showInactive();
      this.enforceMainWindowOnTop();
    }
  }

  appendTranscriptionPreview(text) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-append", text);
  }

  holdTranscriptionPreview(options = {}) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const payload = {
      showCleanup: !!options.showCleanup,
    };
    this.mainWindow.webContents.send("preview-hold", payload);
  }

  completeTranscriptionPreview(text) {
    if (this._onboardingActive) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const payload = { text };
    this.mainWindow.webContents.send("preview-result", payload);
    this.enforceMainWindowOnTop();
  }

  hideTranscriptionPreview() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send("preview-hide");
  }

  // The display the user is working on is the one showing the app being dictated
  // into, which on a multi-monitor desk is often not the one the mouse rests on.
  // Falls back to the cursor when the target has no readable window (non-macOS,
  // no target captured yet, or an app with no ordinary window).
  async _resolveActiveDisplay(targetPidPromise) {
    let pid = this.textEditMonitor?.lastTargetPid;
    if (targetPidPromise) {
      try {
        pid = await targetPidPromise;
      } catch {
        pid = null;
      }
    }
    const bounds = pid ? await this.textEditMonitor.getTargetWindowBounds(pid) : null;
    return plasmaWorkAreas.resolve(
      bounds
        ? screen.getDisplayMatching(bounds)
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    );
  }

  // A dictation is starting: put the pill at its configured spot on the locked
  // display, or on the display the user is working on. This also undoes any
  // move Windows made while monitors slept or rearranged.
  _repositionToActiveDisplay(targetPidPromise) {
    const locked = isFloatingIconDisplayLocked(this._floatingIconDisplay);
    // A panel edit that leaves the root work area unchanged raises no display
    // event, so look again on every show; a change re-anchors the pill.
    void plasmaWorkAreas.refresh();
    return this._mainWindowPlacementCoordinator.request(
      () => (locked ? this._resolveLockedDisplay() : this._resolveActiveDisplay(targetPidPromise)),
      (activeDisplay, isCurrent) =>
        this._enqueueMainWindowMutation(() =>
          this._performActiveDisplayReposition(activeDisplay, isCurrent)
        ),
      { deferManual: locked }
    );
  }

  _performActiveDisplayReposition(activeDisplay, isCurrent) {
    if (
      !isCurrent() ||
      this.dragManager.isDragActive() ||
      !this.mainWindow ||
      this.mainWindow.isDestroyed()
    ) {
      return { applied: false, reason: "superseded" };
    }
    // Re-read the display inside the queue: the one resolved before it may have
    // been disconnected while a resize ran.
    const display =
      this._resolveLockedDisplay() ||
      plasmaWorkAreas.resolve(
        screen.getAllDisplays().find((candidate) => candidate.id === activeDisplay?.id) ||
          screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      );
    return this._commitPlacement(display, { reason: "dictation-start" });
  }

  // Corrected work areas can arrive after the pill was placed: plasmashell
  // answers after startup, or a panel changed. The pill goes back to its
  // configured spot on the corrected work area: a drag that still lands on its
  // display stays where the user put it (_commitPlacement). Like the first
  // placement in createMainWindow, this doesn't wait for the onboarding gate,
  // since plasmashell's first answer usually lands before AppRouter releases it.
  _reanchorMainWindow() {
    return this._enqueueMainWindowMutation(() => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        return { applied: false, reason: "no-window" };
      }
      const display =
        this._resolveLockedDisplay() || this._getMainWindowDisplayFor(this.mainWindow.getBounds());
      return this._commitPlacement(display, { reason: "work-areas" });
    });
  }

  // hide() also hides Chromium's child input window (Chrome_RenderWidgetHostHWND),
  // and showing the pill again does not bring it back. Clicks then land on the
  // non-focusable top-level window, which answers WM_MOUSEACTIVATE with
  // MA_NOACTIVATEANDEAT, so Windows drops every button press while moves and
  // releases still arrive: the pill can't be clicked or dragged until something
  // resizes the window (a menu or toast). A resize shows the child again, so
  // nudge the width and put it back.
  _restoreWin32MainWindowClicks() {
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    // Electron stores the non-resizable pill's requested size in its constraints.
    // Reading the size from getBounds() instead rounds screen edges outward at
    // fractional DPI, so restoring that size would grow the window on each show.
    const [width, height] = win.getMinimumSize();
    // Nudge past the rounded bounds so the renderer's DIP size also changes.
    win.setBounds({ ...bounds, width: bounds.width + 1 });
    win.setBounds({ ...bounds, width, height });
  }

  showDictationPanel(options = {}) {
    if (this._onboardingActive) return;
    const { focus = false, reposition = false, targetPidPromise } = options;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (reposition) {
      const placement = this._repositionToActiveDisplay(targetPidPromise);
      // With a locked display the target is known at once, so a hidden pill is
      // shown only after it moved: it never flashes at its previous spot. A
      // hide in the meantime (a quick stop or cancel) wins.
      if (isFloatingIconDisplayLocked(this._floatingIconDisplay) && !this.mainWindow.isVisible()) {
        const generation = ++this._surfaceGeneration;
        const surface = () => {
          if (generation === this._surfaceGeneration) this._surfaceMainWindow(focus);
        };
        void placement.then(surface, surface);
        return;
      }
    }
    this._surfaceMainWindow(focus);
  }

  _surfaceMainWindow(focus) {
    if (this._onboardingActive || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }
    if (!this.mainWindow.isVisible()) {
      if (typeof this.mainWindow.showInactive === "function") {
        this.mainWindow.showInactive();
      } else {
        this.mainWindow.show();
      }
      // A pill shown after its press's messages (a locked display moves it first).
      this._probeStartVisuals();
    }
    if (focus) {
      this.mainWindow.focus();
    }
  }

  _isPillOnScreen() {
    const win = this.mainWindow;
    if (!win || win.isDestroyed?.() || typeof win.isVisible !== "function") return false;
    return win.isVisible() === true && win.isMinimized?.() !== true;
  }

  // Dictation start visuals: one line per press, keyed by its trace's pressId
  // like the renderer's start trace. Not during onboarding, which shows no pill.
  _beginStartVisuals(trace, { pillWasVisible = false } = {}) {
    if (!this._startVisuals || this._onboardingActive || !trace || !this.mainWindow) return;
    this._startVisuals.begin({
      pressId: trace.pressId,
      keyAt: trace.keyAt,
      keyTimeSource: trace.keyTimeSource,
      pillWasVisible,
      strip: this.recordingEdgeStrip?.stripModeForRecording?.() ?? "off",
      expectSettle: true,
    });
    this._startVisualsProbe = { pressId: trace.pressId, ready: false };
  }

  // Asks the dictation window for its first frame painted with the pill on
  // screen, once the press's messages are sent (`ready`) and the window shows.
  _probeStartVisuals({ ready = false } = {}) {
    const probe = this._startVisualsProbe;
    if (!probe) return;
    if (ready) probe.ready = true;
    if (!probe.ready || !this._isPillOnScreen()) return;
    this._startVisualsProbe = null;
    if (this._startVisuals?.pendingPressId !== probe.pressId) return;
    this.mainWindow.webContents.send("dictation-start-visuals-probe", { pressId: probe.pressId });
  }

  /** The dictation window's painted frame for a start (`dictation-start-visual`). */
  handleStartVisualMark(mark) {
    if (!mark || typeof mark !== "object") return;
    this._startVisuals?.mark(mark.pressId, mark.mark, mark.at);
  }

  setOnboardingActive(active) {
    const nextActive = active === true;
    if (!nextActive) this.permissionGuide?.close();
    if (nextActive === this._onboardingActive) {
      if (nextActive) this._hideNormalAppSurfaces();
      return true;
    }

    if (nextActive) {
      this._onboardingActive = true;
      this.sendCancelDictation();
      this._hideNormalAppSurfaces();
      return true;
    }

    this.endOnboardingDemo();
    this.sendCancelDictation();
    this.hideDictationPanel();
    this._onboardingActive = false;
    if (!this._floatingIconAutoHide) this.showDictationPanel();
    this.agentWindow?.prewarm();
    return true;
  }

  _hideNormalAppSurfaces() {
    this.hideDictationPanel();
    this.hideTranscriptionPreview();
    this.agentWindow?.dismiss();
    this.dismissMeetingNotification({ flushQueued: false });
  }

  beginOnboardingDemo(kind) {
    if (!ONBOARDING_DEMO_KINDS.has(kind)) return false;
    this._onboardingActive = true;
    this._onboardingDemoKind = kind;
    // A prior recording must not leak into a new correlated demo session.
    this.sendCancelDictation();
    this.hideDictationPanel();
    return true;
  }

  isOnboardingDemoActive() {
    return this._onboardingDemoKind !== null;
  }

  stopOnboardingDemoRecording() {
    if (!this._onboardingDemoKind) return false;
    this.sendStopDictation();
    this.hideDictationPanel();
    return true;
  }

  endOnboardingDemo() {
    // Before the early return on purpose: IPCHandlers' demo session must die
    // on every teardown path even if the demo kind is already gone — a stale
    // session broadcasts every later dictation on onboarding-demo-event.
    this.onOnboardingDemoTeardown?.();
    if (!this._onboardingDemoKind) return false;
    // Leaving/retrying is cancellation, not a transcription request. The
    // overlay owns AudioManager, so route cleanup must be delivered there.
    this.sendCancelDictation();
    this.hideDictationPanel();
    this._onboardingDemoKind = null;
    return true;
  }

  _clearControlPanelVisibilityTimer() {
    clearTimeout(this._controlPanelVisibilityTimer);
    this._controlPanelVisibilityTimer = null;
  }

  _showControlPanel({ onlyBeforeFirstShow = false } = {}) {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    // onlyBeforeFirstShow reveals a new panel only while its visibility timer is pending;
    // after that, a hidden or minimized panel stays as the user left it.
    if (onlyBeforeFirstShow && this._controlPanelVisibilityTimer === null) return;
    // Cancel the backstop either way: once the window has been shown on purpose,
    // a later timer firing could pull it back out of the tray.
    this._clearControlPanelVisibilityTimer();
    if (win.isVisible()) return;
    this.showControlPanel();
  }

  // Every path that opens the control panel comes through here. The Dock is
  // reported first: on an active app dock.show() activates the Dock and then
  // re-activates the app, which macOS does not honour, so a window surfaced
  // before it is left behind the previously frontmost app. show() runs even
  // for a visible window, since on macOS it activates the app while another
  // app is active and focus() does not. `activate: false` skips that for an
  // open panel, for openers that send the user to another app (joining a
  // meeting, the meeting hotkey mid-call): the panel updates behind it.
  showControlPanel({ activate = true } = {}) {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    this._clearControlPanelVisibilityTimer();
    dockManager.setControlPanelVisible(true);
    if (win.isMinimized()) win.restore();
    if (activate || !win.isVisible()) win.show();
    win.focus();
  }

  // Compact onboarding starts at smaller bounds, but every mode exposes the
  // complete window-control contract so a frameless window never traps the
  // user in setup.
  _applyOnboardingWindowChrome(win, mode) {
    win.setResizable(true);
    win.setMinimizable(true);
    win.setMaximizable(true);
    win.setClosable(true);
    win.setFullScreenable(false);
    // Floor at the mode's canonical size so no step renders below the bounds
    // it was designed for — clamped to the work area, or a 1366x768-class
    // display could never fit (and setContentBounds would fight the minimum).
    const floor = ONBOARDING_WINDOW_SIZES[ONBOARDING_WINDOW_SIZE_KEYS[mode]];
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    win.setMinimumSize(
      Math.min(floor.width, workArea.width),
      Math.min(floor.height, workArea.height)
    );
    if (process.platform === "darwin" && typeof win.setWindowButtonVisibility === "function") {
      win.setWindowButtonVisibility(true);
    }
  }

  setOnboardingWindowMode(mode) {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return false;
    if (mode !== "restore" && !Object.hasOwn(ONBOARDING_WINDOW_SIZE_KEYS, mode)) return false;
    if (mode !== "restore" && (win.isFullScreen() || win.isMaximized())) {
      // Entering onboarding from a maximized/fullscreen control panel must not
      // refuse: each mode is applied at its canonical centered bounds, which
      // only take effect from a normal window state. Both modes stay
      // maximizable, so the user can simply maximize again afterwards.
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    }

    const current = win.getContentBounds();
    const { workArea } = screen.getDisplayMatching(win.getBounds());

    if (mode === "restore") {
      // A maximized/fullscreen window the user made keeps its bounds, but the
      // chrome state below must still be restored and the tracking cleared —
      // refusing outright left setFullScreenable(false) and onboarding's
      // minimum-size floor on the control panel for the rest of its life.
      if (!win.isFullScreen() && !win.isMaximized() && this._onboardingRestoreBounds) {
        win.setContentBounds(clampedBounds(this._onboardingRestoreBounds, workArea), true);
      }
      const state = this._onboardingWindowState;
      if (state) {
        win.setResizable(state.resizable);
        win.setMinimizable(state.minimizable);
        win.setMaximizable(state.maximizable);
        win.setClosable(state.closable);
        win.setFullScreenable(state.fullscreenable);
        if (state.minimumSize) win.setMinimumSize(...state.minimumSize);
      }
      if (process.platform === "darwin" && typeof win.setWindowButtonVisibility === "function") {
        win.setWindowButtonVisibility(true);
      }
      this._onboardingRestoreBounds = null;
      this._onboardingWindowMode = null;
      this._onboardingWindowState = null;
      this._showControlPanel({ onlyBeforeFirstShow: true });
      return true;
    }

    if (!this._onboardingRestoreBounds) {
      this._onboardingRestoreBounds = current;
      this._onboardingWindowState = {
        resizable: win.isResizable(),
        minimizable: win.isMinimizable(),
        maximizable: win.isMaximizable(),
        closable: win.isClosable(),
        fullscreenable: win.isFullScreenable(),
        minimumSize: win.getMinimumSize(),
      };
    }

    this._applyOnboardingWindowChrome(win, mode);

    if (this._onboardingWindowMode === mode) {
      this._showControlPanel({ onlyBeforeFirstShow: true });
      return true;
    }

    const target = ONBOARDING_WINDOW_SIZES[ONBOARDING_WINDOW_SIZE_KEYS[mode]];
    const next = centeredBounds(current, target, workArea);
    if (
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
    ) {
      this._onboardingWindowMode = mode;
      this._showControlPanel({ onlyBeforeFirstShow: true });
      return true;
    }

    win.setContentBounds(next, true);
    this._onboardingWindowMode = mode;
    this._showControlPanel({ onlyBeforeFirstShow: true });
    return true;
  }

  hideControlPanelToTray() {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return;
    }

    // An explicit hide is authoritative: the visibility backstop exists to
    // rescue a window that never got shown, and letting it fire now would
    // pull the panel (and the Dock icon) back out of the tray.
    this._clearControlPanelVisibilityTimer();
    // A demo left running when the panel hides would keep swallowing normal
    // dictations (paste suppressed, transcripts rerouted to the demo session).
    this.endOnboardingDemo();
    // The guide cannot watch the panel's hide event (occlusion fires it too),
    // so the one real hide path tells it.
    this.permissionGuide?.close(false, true);
    this.controlPanelWindow.hide();
    dockManager.setControlPanelVisible(false);
  }

  hideDictationPanel() {
    this._mainWindowPlacementCoordinator.cancelPending();
    this._surfaceGeneration += 1;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.hide();
  }

  isDictationPanelVisible() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }

    if (this.mainWindow.isMinimized && this.mainWindow.isMinimized()) {
      return false;
    }

    return this.mainWindow.isVisible();
  }

  registerMainWindowEvents() {
    if (!this.mainWindow) {
      return;
    }

    if (process.platform === "linux") {
      const win = this.mainWindow;
      // backgroundThrottling:false keeps document.visibilityState visible even
      // after hide(). Native visibility owns the Linux input-region updates.
      for (const event of ["show", "hide", "minimize", "restore"]) {
        win.on(event, () => {
          win.webContents.send(
            "main-window-visibility-changed",
            win.isVisible() && !win.isMinimized()
          );
        });
      }
    }

    // Safety timeout: force show the window if ready-to-show doesn't fire within 10 seconds
    const showTimeout = setTimeout(() => {
      if (
        this.mainWindow &&
        !this.mainWindow.isDestroyed() &&
        !this.mainWindow.isVisible() &&
        !this._floatingIconAutoHide
      ) {
        this.showDictationPanel();
      }
    }, 10000);

    this.mainWindow.once("ready-to-show", () => {
      clearTimeout(showTimeout);
      this.enforceMainWindowOnTop();
      if (!this.mainWindow.isVisible() && !this._floatingIconAutoHide) {
        this.showDictationPanel();
      }
    });

    this.mainWindow.on("show", () => {
      this.enforceMainWindowOnTop();
      if (process.platform === "win32") this._restoreWin32MainWindowClicks();
    });

    this.mainWindow.on("focus", () => this.enforceMainWindowOnTop());

    this.mainWindow.on("closed", () => {
      this.dragManager.cleanup();
      this.mainWindow = null;
    });
  }

  enforceMainWindowOnTop() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      WindowPositionUtil.setupAlwaysOnTop(this.mainWindow);
    }
  }

  async showMeetingNotification(promptData, { autoDismiss = true } = {}) {
    if (this._onboardingActive) {
      // No card will settle this detection, and while it stays active the
      // engine skips every repeat of it.
      if (promptData?.detectionId) {
        this.meetingDetectionEngine?.handleDetectionNotificationClosed?.(promptData.detectionId, {
          flushQueued: false,
        });
      }
      return false;
    }
    this._cancelMeetingNavigation("STALE_NOTIFICATION");
    const previousOwner = this._meetingNotificationOwner;
    if (
      previousOwner?.detection &&
      previousOwner.prompt.detectionId !== promptData.detectionId &&
      this.meetingDetectionEngine?.activeDetections?.get(previousOwner.prompt.detectionId) ===
        previousOwner.detection
    ) {
      this.meetingDetectionEngine.activeDetections.delete(previousOwner.prompt.detectionId);
    }
    this._meetingNotificationOwner = null;
    if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
      const previousWindow = this.notificationWindow;
      this.notificationWindow = null;
      this._pendingNotificationData = null;
      previousWindow.close();
    }
    this._notificationDismissTimer.cancel();
    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }

    const display = screen.getPrimaryDisplay();
    const position = WindowPositionUtil.getNotificationPosition(display);

    const win = new BrowserWindow({
      ...NOTIFICATION_WINDOW_CONFIG,
      // Linux has no setFocusable, so the picker's typing needs this from creation.
      ...(process.platform === "linux" && { focusable: true, type: "normal" }),
      ...position,
    });
    this.notificationWindow = win;

    // "closed" fires asynchronously, so a replaced prompt's window emits it
    // after the replacement already took over the reference and the countdown.
    win.on("closed", () => {
      if (this.notificationWindow !== win) return;
      const closedDetectionId = this._pendingNotificationData?.detectionId ?? null;
      this.notificationWindow = null;
      this._meetingNotificationOwner = null;
      this._pendingNotificationData = null;
      this._notificationDismissTimer.cancel();
      if (this._notificationReadyFallback) {
        clearTimeout(this._notificationReadyFallback);
        this._notificationReadyFallback = null;
      }
      if (closedDetectionId) {
        this.meetingDetectionEngine?.handleDetectionNotificationClosed?.(closedDetectionId);
      }
    });

    win.setContentProtection(true);

    if (process.platform === "darwin") {
      win.setIgnoreMouseEvents(true, { forward: true });
    }

    // Notifications must clear every other window, including our own floating
    // dictation panel and the agent window.
    WindowPositionUtil.setupAlwaysOnTop(win, { level: "screen-saver" });

    this._pendingNotificationData = promptData;
    const owner = {
      prompt: promptData,
      window: win,
      detection: this.meetingDetectionEngine?.activeDetections?.get(promptData.detectionId),
      selectedDestination: null,
      createRequests: new Map(),
      layoutRevision: 0,
      mode: "closed",
      pointerInside: false,
    };
    this._meetingNotificationOwner = owner;
    const retireRenderer = () => {
      if (this._meetingNotificationOwner !== owner) return;
      this.dismissMeetingNotification();
    };
    const notificationContents = win.webContents;
    notificationContents.once("render-process-gone", retireRenderer);
    win.on("closed", () => {
      notificationContents.removeListener("render-process-gone", retireRenderer);
    });
    if (process.platform === "linux") win.setShape([MEETING_NOTIFICATION_CARD_REGION]);
    win.on("blur", () => {
      if (!this.isMeetingNotificationOwner(owner) || owner.mode === "closed") return;
      this.setMeetingNotificationSurface(owner, {
        revision: owner.layoutRevision + 1,
        mode: "closed",
        contentHeight: NOTIFICATION_WINDOW_CONFIG.height,
        regions: [MEETING_NOTIFICATION_CARD_REGION],
        focus: "release",
      });
      win.webContents.send("meeting-notification-surface-closed", {
        revision: owner.layoutRevision,
      });
    });
    const refit = () => {
      if (!this.isMeetingNotificationOwner(owner) || !owner.surface) return;
      this.setMeetingNotificationSurface(owner, {
        ...owner.surface,
        revision: owner.layoutRevision + 1,
        focus: "keep",
      });
      win.webContents.send("meeting-notification-surface-resized", {
        revision: owner.layoutRevision,
      });
    };
    for (const event of ["display-metrics-changed", "display-removed", "display-added"])
      screen.on(event, refit);
    win.on("closed", () => {
      for (const event of ["display-metrics-changed", "display-removed", "display-added"])
        screen.removeListener(event, refit);
    });

    // Everything past the load addresses `win` directly: a replacement taking
    // over mid-load must not have this prompt's data, countdown or force-show
    // applied to its window.
    try {
      if (process.env.NODE_ENV === "development") {
        await DevServerManager.waitForDevServer();
        if (this.notificationWindow !== win) return false;
        await win.loadURL(`${DevServerManager.DEV_SERVER_URL}?meeting-notification=true`);
      } else {
        const fileInfo = DevServerManager.getAppFilePath(false);
        await win.loadFile(fileInfo.path, {
          query: { ...fileInfo.query, "meeting-notification": "true" },
        });
      }
    } catch (error) {
      // A load aborted by our own replacement or dismissal is not a failure —
      // but the caller must still learn the notification never appeared.
      if (this.notificationWindow !== win) return false;
      this.dismissMeetingNotification();
      throw error;
    }
    if (this.notificationWindow !== win) return false;
    if (this._onboardingActive) {
      // Queued prompts would only reach the same closed gate.
      this.dismissMeetingNotification({ flushQueued: false });
      return false;
    }

    const readyFallback = setTimeout(() => {
      if (this._notificationReadyFallback !== readyFallback) return;
      this._notificationReadyFallback = null;
      if (this._onboardingActive || this.notificationWindow !== win || win.isDestroyed()) return;
      debugLogger.warn("Notification renderer did not signal ready, force-showing", {}, "meeting");
      win.webContents.send("meeting-notification-data", promptData);
      win.showInactive();
    }, 3000);
    this._notificationReadyFallback = readyFallback;

    if (autoDismiss) {
      this._notificationDismissTimer.start(getNotificationTimeoutMs(promptData.source));
    }
    return true;
  }

  // Only the window that loaded the prompt may reveal it: a stale window's late
  // "ready" must not clear the fallback that would force-show its replacement.
  showNotificationWindow(ownerWebContents) {
    if (this._onboardingActive) {
      this.dismissMeetingNotification({ flushQueued: false });
      return;
    }
    const win = this.notificationWindow;
    if (!win || win.isDestroyed() || (ownerWebContents && win.webContents !== ownerWebContents)) {
      return;
    }

    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }
    win.showInactive();
  }

  dismissMeetingNotification({ notifyEngine = true, flushQueued = true } = {}) {
    const notification = this._pendingNotificationData;
    this._meetingNotificationOwner = null;
    this._pendingNotificationData = null;
    if (this._notificationReadyFallback) {
      clearTimeout(this._notificationReadyFallback);
      this._notificationReadyFallback = null;
    }
    this._notificationDismissTimer.cancel();
    const win = this.notificationWindow;
    this.notificationWindow = null;
    if (win && !win.isDestroyed()) win.close();
    if (notifyEngine && notification?.detectionId) {
      this.meetingDetectionEngine?.handleDetectionNotificationClosed?.(notification.detectionId, {
        flushQueued,
      });
    }
  }

  sendToControlPanel(channel, data) {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", () => {
        if (!win.isDestroyed()) win.webContents.send(channel, data);
      });
    } else {
      win.webContents.send(channel, data);
    }
  }

  async queueMeetingNoteNavigation(payload, options) {
    if (!payload.navigationId) {
      this._pendingMeetingNoteNavigation = payload;
      try {
        await this.createControlPanelWindow(options);
        if (this._pendingMeetingNoteNavigation === payload)
          this.sendToControlPanel("meeting-note-navigation-pending");
      } catch (error) {
        if (this._pendingMeetingNoteNavigation === payload)
          this._pendingMeetingNoteNavigation = null;
        this.meetingDetectionEngine?.abandonMeetingNote?.(payload.noteSessionId);
        throw error;
      }
      return;
    }
    if (!this.isMeetingNotificationOwner(options.owner))
      return { success: false, code: "STALE_NOTIFICATION" };
    this._cancelMeetingNavigation("STALE_NOTIFICATION");
    let resolve;
    const result = new Promise((done) => {
      resolve = done;
    });
    const operation = {
      payload,
      owner: options.owner,
      resolve,
      consumed: false,
      panel: null,
    };
    this._meetingNavigationOperation = operation;
    // Bound panel creation as well as the renderer handshake; reset at delivery.
    operation.timer = setTimeout(
      () => this._settleMeetingNavigation(operation, { success: false, code: "START_FAILED" }),
      15000
    );
    void (async () => {
      try {
        await this.createControlPanelWindow({ activate: options.activate });
        if (this._meetingNavigationOperation !== operation) return;
        const panel = this.controlPanelWindow;
        if (!panel || panel.isDestroyed()) throw new Error("Panel unavailable");
        operation.panel = panel;
        operation.contents = panel.webContents;
        operation.onClose = () =>
          this._settleMeetingNavigation(operation, { success: false, code: "START_FAILED" });
        panel.once("closed", operation.onClose);
        panel.webContents.once("render-process-gone", operation.onClose);
        const deliver = () => {
          if (this._meetingNavigationOperation !== operation) return;
          if (this.controlPanelWindow !== panel || panel.isDestroyed()) {
            this._settleMeetingNavigation(operation, {
              success: false,
              code: "STALE_NOTIFICATION",
            });
            return;
          }
          clearTimeout(operation.timer);
          operation.timer = setTimeout(
            () =>
              this._settleMeetingNavigation(operation, { success: false, code: "START_FAILED" }),
            15000
          );
          this._pendingMeetingNoteNavigation = payload;
          panel.webContents.send("meeting-note-navigation-pending");
        };
        operation.deliver = deliver;
        // Not did-finish-load: creating a panel resolves inside it, with isLoading() still true.
        // Waiting keeps a reloading panel's outgoing document from taking the navigation.
        if (panel.webContents.isLoading()) panel.webContents.once("did-stop-loading", deliver);
        else deliver();
      } catch {
        this._settleMeetingNavigation(operation, { success: false, code: "START_FAILED" });
      }
    })();
    return result;
  }

  isMeetingNoteNavigationPending(noteSessionId) {
    if (noteSessionId == null) return false;
    return (
      this._pendingMeetingNoteNavigation?.noteSessionId === noteSessionId ||
      // A navigation still waiting for a reloading panel isn't pending yet.
      this._meetingNavigationOperation?.payload.noteSessionId === noteSessionId
    );
  }

  _settleMeetingNavigation(operation, result) {
    if (this._meetingNavigationOperation !== operation) return;
    if (!result.success)
      this.meetingDetectionEngine?.abandonMeetingNote?.(operation.payload.noteSessionId);
    this._meetingNavigationOperation = null;
    clearTimeout(operation.timer);
    operation.panel?.removeListener("closed", operation.onClose);
    operation.contents?.removeListener("render-process-gone", operation.onClose);
    if (operation.deliver) operation.contents.removeListener("did-stop-loading", operation.deliver);
    if (this._pendingMeetingNoteNavigation === operation.payload)
      this._pendingMeetingNoteNavigation = null;
    operation.resolve(result);
  }

  _cancelMeetingNavigation(code) {
    const operation = this._meetingNavigationOperation;
    if (operation) this._settleMeetingNavigation(operation, { success: false, code });
  }

  consumePendingMeetingNoteNavigation(sender) {
    const payload = this._pendingMeetingNoteNavigation;
    if (payload?.navigationId) {
      const operation = this._meetingNavigationOperation;
      if (
        !operation ||
        operation.payload !== payload ||
        operation.panel !== this.controlPanelWindow ||
        operation.contents !== sender
      )
        return null;
      operation.consumed = true;
    }
    this._pendingMeetingNoteNavigation = null;
    return payload;
  }

  confirmMeetingNoteNavigation(sender, navigationId, status = "ready") {
    const operation = this._meetingNavigationOperation;
    if (
      !operation ||
      operation.payload.navigationId !== navigationId ||
      !operation.consumed ||
      operation.panel !== this.controlPanelWindow ||
      operation.contents !== sender
    ) {
      return { success: false, code: "STALE_NOTIFICATION" };
    }
    let result;
    if (status === "cancel") result = { success: false, code: "START_FAILED" };
    else if (status !== "ready") return { success: false, code: "INVALID_REQUEST" };
    else {
      try {
        const db = this.meetingDetectionEngine.databaseManager;
        const note = db.getNote(operation.payload.noteId);
        if (!describeMeetingNote(db, note)) result = { success: false, code: "NOTE_UNAVAILABLE" };
        else if (
          note.space_id !== operation.payload.spaceId ||
          note.folder_id !== operation.payload.folderId
        ) {
          result = {
            success: false,
            code: "LINKED_NOTE_CHANGED",
            context: meetingDestinationContext(db, operation.owner, this.meetingRecentDestinations),
          };
        } else result = { success: true, value: note };
      } catch {
        result = { success: false, code: "NOTE_UNAVAILABLE" };
      }
    }
    this._settleMeetingNavigation(operation, result);
    return result;
  }

  async queueNoteNavigation(payload, options) {
    this._pendingNoteNavigation = payload;
    await this.createControlPanelWindow(options);
    this.sendToControlPanel("note-navigation-pending");
  }

  consumePendingNoteNavigation() {
    const payload = this._pendingNoteNavigation;
    this._pendingNoteNavigation = null;
    return payload;
  }

  snapControlPanelToMeetingMode() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    this._preMeetingBounds = win.getBounds();
    const display = screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const width = Math.round(workArea.width / 3);
    win.setBounds({
      x: workArea.x + workArea.width - width,
      y: workArea.y,
      width,
      height: workArea.height,
    });
    win.focus();
  }

  restoreControlPanelFromMeetingMode() {
    const win = this.controlPanelWindow;
    if (!win || win.isDestroyed()) return;
    if (this._preMeetingBounds) {
      win.setBounds(this._preMeetingBounds);
      this._preMeetingBounds = null;
    } else {
      const { width, height } = CONTROL_PANEL_CONFIG;
      win.setSize(width, height);
      win.center();
    }
  }

  refreshLocalizedUi() {
    MenuManager.setupMainMenu(() => this.openSettings());

    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      MenuManager.setupControlPanelMenu(this.controlPanelWindow, () => this.openSettings());
      this.controlPanelWindow.setTitle(i18nMain.t("window.controlPanelTitle"));
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setTitle(i18nMain.t("window.voiceRecorderTitle"));
    }
  }

  // A named section waits here like a note navigation: a control panel created
  // by this call registers its show-settings listener only after the event.
  async openSettings(section) {
    if (section) this._pendingSettingsSection = section;
    await this.createControlPanelWindow();
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      this.controlPanelWindow.webContents.send("show-settings");
    }
  }

  consumePendingSettingsSection() {
    const section = this._pendingSettingsSection;
    this._pendingSettingsSection = null;
    return section;
  }

  showLoadFailureDialog(windowName, errorCode, errorDescription, validatedURL) {
    if (this.loadErrorShown) {
      return;
    }
    this.loadErrorShown = true;
    const detailLines = [
      i18nMain.t("dialog.loadFailure.detail.window", { windowName }),
      i18nMain.t("dialog.loadFailure.detail.error", { errorCode, errorDescription }),
      validatedURL ? i18nMain.t("dialog.loadFailure.detail.url", { url: validatedURL }) : null,
      i18nMain.t("dialog.loadFailure.detail.hint"),
    ].filter(Boolean);
    dialog.showMessageBox({
      type: "error",
      title: i18nMain.t("dialog.loadFailure.title"),
      message: i18nMain.t("dialog.loadFailure.message"),
      detail: detailLines.join("\n"),
    });
  }
}

module.exports = WindowManager;
