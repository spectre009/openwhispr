const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadTrayWithStubs(request, parent, isMain) {
  if (request === "electron")
    return { Tray: class {}, Menu: {}, nativeImage: {}, app: { on: () => undefined } };
  if (request === "./debugLogger") return { info: () => undefined, debug: () => undefined };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  return originalLoad.call(this, request, parent, isMain);
};
const TrayManager = require("../../src/helpers/tray");
Module._load = originalLoad;

function createTrayManager(calls, { dictating = false, reviewKey = null } = {}) {
  const trayManager = new TrayManager();
  trayManager.windowManager = {
    isDictationPanelVisible: () => false,
    isDictating: () => dictating,
    sendStartDictation: () => calls.push("start-dictation"),
    sendStopDictation: () => calls.push("stop-dictation"),
    sendOpenAssistantPanel: () => calls.push("assistant"),
    startManualMeeting: () => calls.push("meeting"),
    reviewLastDictation: async () => calls.push("review"),
    hotkeyManager: { getSlotHotkey: (slot) => (slot === "review" ? reviewKey : null) },
  };
  return trayManager;
}

const reviewItem = (trayManager) =>
  trayManager
    .buildContextMenuTemplate()
    .find((item) => item.label?.startsWith("tray.reviewLastDictation"));

test("the tray menu leads with the dictation pill's quick actions", () => {
  const calls = [];
  const [listen, assistant, meeting, separator] =
    createTrayManager(calls).buildContextMenuTemplate();

  assert.deepEqual(
    [listen.label, assistant.label, meeting.label, separator.type],
    [
      "app.commandMenu.startListening",
      "app.commandMenu.askAssistant",
      "app.commandMenu.startMeetingRecording",
      "separator",
    ]
  );

  listen.click();
  assistant.click();
  meeting.click();
  // Listening and a meeting start in the main process; only the assistant needs
  // the renderer, which is the one that can open its panel.
  assert.deepEqual(calls, ["start-dictation", "assistant", "meeting"]);
});

test("the tray's listen item stops the recording it reflects", () => {
  const calls = [];
  const [listen] = createTrayManager(calls, { dictating: true }).buildContextMenuTemplate();

  assert.equal(listen.label, "app.commandMenu.stopListening");
  listen.click();
  assert.deepEqual(calls, ["stop-dictation"]);
});

test("Review last dictation sits in the tray, with its hotkey when one is set", () => {
  const calls = [];
  const plain = reviewItem(createTrayManager(calls));
  assert.equal(plain.label, "tray.reviewLastDictation");
  assert.equal(plain.accelerator, undefined);
  plain.click();
  // The same action as the hotkey: main refuses it during a dictation.
  assert.deepEqual(calls, ["review"]);

  // Shown as the item's accelerator text, never registered by the menu: the
  // hotkey manager owns the key.
  const withKey = reviewItem(createTrayManager([], { reviewKey: "Control+Shift+F9" }));
  assert.equal(withKey.label, "tray.reviewLastDictation");
  assert.equal(withKey.accelerator, "Control+Shift+F9");
  assert.equal(withKey.registerAccelerator, false);

  // A key a menu can't show (modifier-only, a side-specific modifier) goes in the label.
  const modifiers = reviewItem(createTrayManager([], { reviewKey: "Control+Super" }));
  assert.equal(modifiers.accelerator, undefined);
  assert.match(modifiers.label, /^tray\.reviewLastDictation \(Ctrl\+(Win|Cmd|Super)\)$/);
  const side = reviewItem(createTrayManager([], { reviewKey: "RightControl" }));
  assert.equal(side.label, "tray.reviewLastDictation (Right Ctrl)");
});
