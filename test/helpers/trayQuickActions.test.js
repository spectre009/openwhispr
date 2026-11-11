const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const logs = [];
const originalLoad = Module._load;
Module._load = function loadTrayWithStubs(request, parent, isMain) {
  if (request === "electron")
    return { Tray: class {}, Menu: {}, nativeImage: {}, app: { on: () => undefined } };
  if (request === "./debugLogger")
    return {
      info: (message, meta) => logs.push([message, meta]),
      debug: () => undefined,
      warn: (message, meta) => logs.push([message, meta]),
      error: (message, meta) => logs.push([message, meta]),
    };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  return originalLoad.call(this, request, parent, isMain);
};
const TrayManager = require("../../src/helpers/tray");
Module._load = originalLoad;

function createTrayManager(
  calls,
  { dictating = false, reviewKey = null, meetingRefusal = null } = {}
) {
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
    getMeetingRecordingRefusal: () => meetingRefusal,
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

// Restart OpenWhispr, and the warning while Chromium draws on the CPU.
const FALLBACK = Object.freeze({ mode: "software", reason: "fallback" });
const REQUESTED = Object.freeze({
  mode: "software",
  reason: "requested",
  requestedBy: "--disable-gpu",
});

function restartTray({ graphics = null, busy = false, meeting = false } = {}) {
  const state = { graphics, busy, meeting };
  const calls = [];
  const trayManager = createTrayManager(calls);
  Object.assign(trayManager.windowManager, {
    graphicsMode: { getState: () => state.graphics },
    isDictationBusy: () => state.busy,
    openSettings: async (destination) => calls.push(["settings", destination]),
  });
  trayManager.setRestartControls({
    relaunch: async () => calls.push("relaunch"),
    isMeetingRecording: () => state.meeting,
  });
  return { state, calls, trayManager };
}

const labels = (template) => template.map((item) => item.label ?? item.type);
const restartItem = (template) => template.find((item) => item.label === "tray.restart");

test("Restart OpenWhispr sits right above Quit, with no warning while the GPU draws", () => {
  const { calls, trayManager } = restartTray({ graphics: { mode: "hardware", reason: null } });
  const template = trayManager.buildContextMenuTemplate();
  assert.equal(template[0].label, "app.commandMenu.startListening");
  assert.deepEqual(labels(template).slice(-3), ["separator", "tray.restart", "tray.quit"]);
  assert.equal(restartItem(template).enabled, true);

  logs.length = 0;
  restartItem(template).click();
  assert.deepEqual(calls, ["relaunch"]);
  assert.deepEqual(logs, [["Restarting via tray menu", { item: "menu", graphics: "hardware" }]]);
});

test("a graphics fallback leads the menu with the warning and a restart", () => {
  const { calls, trayManager } = restartTray({ graphics: FALLBACK });
  const template = trayManager.buildContextMenuTemplate();
  assert.deepEqual(labels(template).slice(0, 4), [
    "⚠ tray.graphicsFallback.title",
    "tray.graphicsFallback.restart",
    "separator",
    "app.commandMenu.startListening",
  ]);
  assert.equal(template[1].enabled, true);
  assert.deepEqual(labels(template).slice(-2), ["tray.restart", "tray.quit"], "kept near Quit");

  // The warning opens Settings at it.
  template[0].click();
  assert.deepEqual(calls, [["settings", "system#system.diagnostics.graphics"]]);

  logs.length = 0;
  template[1].click();
  assert.equal(calls.at(-1), "relaunch");
  assert.deepEqual(logs, [
    ["Restarting via tray menu", { item: "graphicsWarning", graphics: "software (fallback)" }],
  ]);
});

test("while a dictation is busy, both restarts wait and the top one says so", () => {
  const { trayManager } = restartTray({ graphics: FALLBACK, busy: true });
  const template = trayManager.buildContextMenuTemplate();
  assert.equal(template[1].label, "tray.graphicsFallback.restartAfterRecording");
  assert.equal(template[1].enabled, false);
  assert.equal(restartItem(template).enabled, false);
  assert.equal(template[0].enabled, undefined, "the warning still opens Settings");
});

test("a meeting recording holds Restart too", () => {
  const { trayManager } = restartTray({ graphics: FALLBACK, meeting: true });
  const template = trayManager.buildContextMenuTemplate();
  assert.equal(template[1].label, "tray.graphicsFallback.restartAfterRecording");
  assert.equal(template[1].enabled, false);
  assert.equal(restartItem(template).enabled, false);

  const plain = restartTray({ meeting: true }).trayManager.buildContextMenuTemplate();
  assert.equal(plain[0].label, "app.commandMenu.startListening");
  assert.equal(restartItem(plain).enabled, false);
});

test("a software mode a launch flag asked for shows no warning", () => {
  for (const graphics of [REQUESTED, { mode: "unknown", reason: null }, null]) {
    const template = restartTray({ graphics }).trayManager.buildContextMenuTemplate();
    assert.equal(template[0].label, "app.commandMenu.startListening");
    assert.equal(restartItem(template).enabled, true);
  }
});

test("a click on a stale menu checks again and restarts nothing while busy", () => {
  const { state, calls, trayManager } = restartTray({ graphics: FALLBACK });
  const template = trayManager.buildContextMenuTemplate();
  logs.length = 0;

  state.busy = true;
  template[1].click();
  state.busy = false;
  state.meeting = true;
  restartItem(template).click();
  assert.deepEqual(calls, [], "no restart");
  assert.deepEqual(logs, [
    [
      "Tray restart skipped",
      { item: "graphicsWarning", busy: "dictation", graphics: "software (fallback)" },
    ],
    ["Tray restart skipped", { item: "menu", busy: "meeting", graphics: "software (fallback)" }],
  ]);
});

test("the tray's meeting item is disabled while the org refuses meeting recording", () => {
  const meetingItem = (meetingRefusal) =>
    createTrayManager([], { meetingRefusal }).buildContextMenuTemplate()[2];

  assert.equal(meetingItem(null).enabled, true);
  assert.equal(meetingItem({ code: "POLICY_MEETING_RECORDING_DISABLED" }).enabled, false);
  assert.equal(meetingItem({ code: "POLICY_UNRESOLVABLE" }).enabled, false);
});
