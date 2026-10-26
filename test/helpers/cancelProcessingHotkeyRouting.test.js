const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Esc held for a long-running dictation's processing has its own event:
// cancel-hotkey-pressed also carries the Fn-key and onboarding input resets
// (sendCancelDictation), which must never cancel a transcription.

const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: { getPrimaryDisplay: () => ({}), on: () => undefined },
      BrowserWindow: class {},
      shell: {},
      dialog: {},
      ipcMain: { on: () => undefined, handle: () => undefined },
      Menu: {},
    };
  }
  if (request === "./debugLogger") {
    return { warn: () => undefined, debug: () => undefined, info: () => undefined };
  }
  if (request === "./hotkeyManager") return class {};
  if (request === "./dragManager") return class {};
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") {
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: () => Promise.resolve(),
    };
  }
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES: {},
      WindowPositionUtil: { setupAlwaysOnTop: () => undefined },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

function receiver({ destroyed = false } = {}) {
  const sent = [];
  return {
    sent,
    mainWindow: {
      isDestroyed: () => destroyed,
      webContents: { send: (channel) => sent.push(channel) },
    },
    hotkeyManager: { isInListeningMode: () => false },
  };
}

test("the processing Esc sends its own event to the dictation window", () => {
  const manager = receiver();
  WindowManager.prototype.sendCancelProcessingHotkey.call(manager);
  assert.deepEqual(manager.sent, ["cancel-processing-hotkey-pressed"]);

  const closed = receiver({ destroyed: true });
  WindowManager.prototype.sendCancelProcessingHotkey.call(closed);
  assert.deepEqual(closed.sent, []);
});

test("Fn and onboarding resets never send the processing cancel", () => {
  const manager = receiver();
  WindowManager.prototype.sendCancelDictation.call(manager);
  assert.deepEqual(manager.sent, ["cancel-dictation-preparation", "cancel-hotkey-pressed"]);
  assert.equal(manager.sent.includes("cancel-processing-hotkey-pressed"), false);
});
