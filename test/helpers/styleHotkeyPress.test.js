const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// A style key's press carries its style (Stage 4). Style keys are extra keys on
// the dictation slot, so a press goes down the dictation hotkey's own path in
// the user's activation mode: Hold through the native listener's key-down and
// key-up (one hook process per key), Tap through globalShortcut or the
// listener. The style rides on prepare and start (Hold, frozen for the push)
// or on the toggle (Tap). Everything else must behave exactly as it does for
// the dictation hotkey: overlapping presses, a short hold, a press during
// processing and a blocked start. The native listener, globalShortcut and the
// renderer are stubs.

const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        if (registered.has(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        registered.delete(accelerator);
      },
      isRegistered(accelerator) {
        return registered.has(accelerator);
      },
      unregisterAll() {
        registered.clear();
      },
    },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
  },
};
const HotkeyManager = require("../../src/helpers/hotkeyManager.js");
const { createNativeHotkeyDispatch } = require("../../src/helpers/nativeHotkeyDispatch.js");

const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: { on: () => undefined, getPrimaryDisplay: () => ({}) },
      BrowserWindow: class {},
      Menu: {},
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger") {
    return { warn: () => undefined, debug: () => undefined, log: () => undefined };
  }
  if (request === "./dragManager") return class {};
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") {
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  }
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: { COMPACT: {}, EXPANDED: {} },
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (b) => b,
        getMainWindowPosition: () => ({ x: 0, y: 0 }),
        getNotificationPosition: () => ({ x: 0, y: 0 }),
      },
      fitAssistantWindowToWorkArea: (s) => s,
      fitAssistantContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      fitDictationErrorWindowToWorkArea: (s) => s,
      fitDictationErrorContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      resolveHorizontalWindowDirection: () => "right",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
test.beforeEach(() => {
  registered.clear();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});
test.after(() => Object.defineProperty(process, "platform", originalPlatform));

const TEAMS = "starter-teams";
const EMAIL = "starter-email";
const NOTES = "my-notes";
const DICTATION_KEY = "Control+`";
const TEAMS_KEY = "F21";
const EMAIL_KEY = "Control+Alt+2";
const NOTES_KEY = "Alt+Shift"; // modifier-only: only the native listener sees it

function harness(t, mode = "push") {
  registered.clear();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  t.after(() => t.mock.timers.reset());
  const sent = [];
  const hotkeys = new HotkeyManager();
  hotkeys.notifyActiveHotkey = () => {};
  hotkeys.setStyleKeys(
    new Map([
      [TEAMS_KEY, TEAMS],
      [EMAIL_KEY, EMAIL],
      [NOTES_KEY, NOTES],
    ])
  );
  const manager = new WindowManager();
  manager.hotkeyManager = hotkeys;
  manager.setOnboardingActive(false);
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };
  manager.showDictationPanel = () => undefined;
  manager.hideDictationPanel = () => undefined;
  manager.showAgentDictationPill = () => undefined;
  manager._cachedActivationMode = mode;
  // Startup: the dictation key, then the style keys, all on one callback.
  const result = hotkeys.setupShortcuts(DICTATION_KEY, manager.createHotkeyCallback());
  assert.deepEqual(hotkeys.getSlotHotkeys("dictation"), [
    DICTATION_KEY,
    TEAMS_KEY,
    EMAIL_KEY,
    NOTES_KEY,
  ]);
  assert.equal(result.success, true);
  // Hold watches every key of the slot, one listener process each; Tap only
  // the keys globalShortcut can't take.
  assert.deepEqual(
    hotkeys.getNativeListenerKeys(mode),
    mode === "push" ? hotkeys.getSlotHotkeys("dictation") : [NOTES_KEY]
  );
  const keys = createNativeHotkeyDispatch({
    hotkeyManager: hotkeys,
    windowManager: manager,
    isLiveWindow: (window) => Boolean(window) && !window.isDestroyed(),
  });
  const events = () => sent.map(([channel, payload]) => [channel, payload?.styleId ?? null]);
  const clear = () => (sent.length = 0);
  return { manager, hotkeys, keys, events, clear, tick: (ms) => t.mock.timers.tick(ms) };
}

test("Hold with two keys: the dictation key starts Plain, a style key starts its style", (t) => {
  const { keys, events, clear, tick } = harness(t);

  keys.onKeyDown(DICTATION_KEY);
  tick(150);
  keys.onKeyUp(DICTATION_KEY);
  assert.deepEqual(events(), [
    ["prepare-dictation", null],
    ["start-dictation", null],
    ["stop-dictation", null],
  ]);

  clear();
  keys.onKeyDown(TEAMS_KEY);
  tick(150);
  keys.onKeyUp(TEAMS_KEY);
  assert.deepEqual(events(), [
    ["prepare-dictation", TEAMS],
    ["start-dictation", TEAMS],
    ["stop-dictation", null],
  ]);

  clear();
  keys.onKeyDown(EMAIL_KEY);
  tick(150);
  keys.onKeyUp(EMAIL_KEY);
  assert.deepEqual(events(), [
    ["prepare-dictation", EMAIL],
    ["start-dictation", EMAIL],
    ["stop-dictation", null],
  ]);
});

test("overlapping presses: the key that started the push owns it and its style", (t) => {
  const { manager, keys, events, tick } = harness(t);

  keys.onKeyDown(TEAMS_KEY);
  tick(50);
  keys.onKeyDown(EMAIL_KEY); // a second style key while holding
  keys.onKeyDown(DICTATION_KEY); // and the dictation key
  tick(100);
  assert.equal(manager.winPushState.styleId, TEAMS);
  keys.onKeyUp(EMAIL_KEY);
  keys.onKeyUp(DICTATION_KEY);
  assert.equal(manager.winPushState?.active, true, "releasing another key never stops it");
  keys.onKeyUp(TEAMS_KEY);

  assert.deepEqual(events(), [
    ["prepare-dictation", TEAMS],
    ["start-dictation", TEAMS],
    ["stop-dictation", null],
  ]);
});

test("a short hold cancels without starting, and the next press carries its own style", (t) => {
  const { keys, events, clear, tick } = harness(t);

  keys.onKeyDown(TEAMS_KEY);
  tick(100); // released before the 150 ms hold threshold
  keys.onKeyUp(TEAMS_KEY);
  tick(500);
  assert.deepEqual(events(), [
    ["prepare-dictation", TEAMS],
    ["cancel-dictation-preparation", null],
  ]);

  clear();
  keys.onKeyDown(EMAIL_KEY);
  tick(150);
  keys.onKeyUp(EMAIL_KEY);
  assert.deepEqual(events(), [
    ["prepare-dictation", EMAIL],
    ["start-dictation", EMAIL],
    ["stop-dictation", null],
  ]);
});

test("a press during processing does nothing, for a style key as for the dictation key", async (t) => {
  for (const mode of ["push", "tap"]) {
    const { manager, keys, events, tick } = harness(t, mode);
    manager._dictationLifecycleState = "processing";

    for (const key of [TEAMS_KEY, DICTATION_KEY]) {
      keys.onKeyDown(key);
      tick(150);
      keys.onKeyUp(key);
      await registered.get(key)?.();
      tick(1000);
    }
    assert.deepEqual(events(), [], `${mode}: nothing reaches the renderer`);
    assert.equal(manager.winPushState, null);
    t.mock.timers.reset();
  }
});

test("a blocked start behaves exactly as it does for the dictation key, and carries no style", (t) => {
  const run = (key) => {
    const { manager, keys, events, tick } = harness(t);
    // The assistant panel is open and its companion pill isn't up: dictation
    // input is blocked (windowManager._shouldBlockDictationInput).
    manager._assistantPanelOpen = true;
    manager._agentDictationPillReady = false;
    keys.onKeyDown(key);
    tick(150);
    keys.onKeyUp(key);
    const seen = events();
    t.mock.timers.reset();
    return seen;
  };

  const dictation = run(DICTATION_KEY);
  const styled = run(TEAMS_KEY);
  assert.deepEqual(styled, dictation, "the same channels as the dictation key");
  assert.ok(
    styled.every(([channel, styleId]) => styleId === null || channel === "stop-dictation"),
    "no prepare or start carried a style"
  );
  assert.equal(
    styled.some(([channel]) => channel === "start-dictation" || channel === "prepare-dictation"),
    false
  );
});

test("after a blocked press, listening mode and onboarding, the next press is styled as usual", (t) => {
  const { manager, hotkeys, keys, events, clear, tick } = harness(t);

  hotkeys.setListeningMode(true); // capturing a hotkey in Settings
  keys.onKeyDown(TEAMS_KEY);
  tick(150);
  keys.onKeyUp(TEAMS_KEY);
  hotkeys.setListeningMode(false);
  manager.setOnboardingActive(true);
  keys.onKeyDown(TEAMS_KEY);
  tick(150);
  keys.onKeyUp(TEAMS_KEY);
  manager.setOnboardingActive(false);
  assert.equal(
    events().some(([channel]) => channel === "start-dictation"),
    false,
    "neither block let a recording start"
  );

  clear();
  keys.onKeyDown(EMAIL_KEY);
  tick(150);
  keys.onKeyUp(EMAIL_KEY);
  assert.deepEqual(events(), [
    ["prepare-dictation", EMAIL],
    ["start-dictation", EMAIL],
    ["stop-dictation", null],
  ]);
});

test("Tap: a style key's toggle names its style, through globalShortcut and the listener", async (t) => {
  const { manager, keys, events, clear, tick } = harness(t, "tap");

  // A regular key in Tap is a globalShortcut; its callback gets the key.
  await registered.get(TEAMS_KEY)();
  assert.deepEqual(events(), [
    ["prepare-dictation", TEAMS],
    ["toggle-dictation", TEAMS],
  ]);

  // The renderer reports the recording; a second press of another key stops it
  // and opens nothing new (the renderer's stop never restyles a recording).
  manager._isDictatingToggle = true;
  clear();
  tick(1000);
  await registered.get(EMAIL_KEY)();
  assert.deepEqual(events(), [["toggle-dictation", EMAIL]], "no prepare: it is a stop press");

  // A modifier-only style key in Tap comes from the native listener.
  manager._isDictatingToggle = false;
  clear();
  tick(1000);
  keys.onKeyDown(NOTES_KEY);
  keys.onKeyUp(NOTES_KEY);
  assert.deepEqual(events(), [
    ["prepare-dictation", NOTES],
    ["toggle-dictation", NOTES],
  ]);

  // The dictation key names none.
  clear();
  tick(1000);
  await registered.get(DICTATION_KEY)();
  assert.deepEqual(events(), [
    ["prepare-dictation", null],
    ["toggle-dictation", null],
  ]);
});

test("Hold ignores globalShortcut's press: the listener's key-down and key-up drive it", async (t) => {
  const { manager, events } = harness(t);
  await registered.get(TEAMS_KEY)();
  assert.deepEqual(events(), []);
  assert.equal(manager.winPushState, null);
});
