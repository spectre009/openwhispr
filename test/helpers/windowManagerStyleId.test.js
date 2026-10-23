const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// A recording carries its style from the press that started it: prepare,
// start and toggle can name one (Stage 4's style keys), a Hold freezes it for
// the whole push, and the dictation hotkey names none, so the renderer applies
// the style chosen for it. Nothing changes for presses without a style.

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
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {};
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
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

function makeManager() {
  const sent = [];
  const manager = new WindowManager();
  manager.hotkeyManager = { isInListeningMode: () => false };
  manager.setOnboardingActive(false);
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (...args) => sent.push(args) },
  };
  manager.showDictationPanel = () => undefined;
  manager.isDictationProcessing = () => false;
  manager.hideDictationPanel = () => undefined;
  return { manager, sent };
}

test("a Hold started by a style key carries its style through prepare and start", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const { manager, sent } = makeManager();

  manager.startWindowsPushToTalk("Control+Alt+1", undefined, { styleId: "starter-teams" });
  // A second press of another key while holding never starts (or restyles) anything.
  manager.startWindowsPushToTalk("Control+`", undefined, { styleId: "starter-email" });
  t.mock.timers.tick(150);

  assert.deepEqual(
    sent.map(([channel, payload]) => [channel, payload?.styleId]),
    [
      ["prepare-dictation", "starter-teams"],
      ["start-dictation", "starter-teams"],
    ]
  );
  assert.equal(manager.winPushState.styleId, "starter-teams");
});

test("the dictation hotkey names no style, and its payloads are unchanged", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const { manager, sent } = makeManager();

  manager.startWindowsPushToTalk("Control+`");
  t.mock.timers.tick(150);
  const [prepare, start] = sent;
  assert.equal(prepare[0], "prepare-dictation");
  assert.equal("styleId" in prepare[1], false);
  assert.equal(start[0], "start-dictation");
  assert.equal("styleId" in start[1], false);

  sent.length = 0;
  manager.sendToggleDictation();
  assert.deepEqual(sent.at(-1), ["toggle-dictation"], "a toggle without a style sends no payload");
});

test("a toggle can name a style, which its prepare carries too", () => {
  const { manager, sent } = makeManager();
  manager.sendToggleDictation({ styleId: "starter-requirements" });
  assert.deepEqual(
    sent.map(([channel, payload]) => [channel, payload?.styleId]),
    [
      ["prepare-dictation", "starter-requirements"],
      ["toggle-dictation", "starter-requirements"],
    ]
  );
});
