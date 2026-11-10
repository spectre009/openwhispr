const test = require("node:test");
const assert = require("node:assert/strict");

const roles = require("../../src/helpers/processRoles");
const english = require("../fixtures/processRoles.en.json");

// processRoles.js: Electron's process types and service names, main's window
// roles and helper exe names map to role ids; a role and the parameters main
// fills in pick i18n keys. Every key it can produce has an English text in
// test/fixtures/processRoles.en.json, which stage 2's locales copy.

const lookup = (key) =>
  key
    .split(".")
    .reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), english);

test("Electron's processes map by type, service name and the window a renderer hosts", () => {
  assert.equal(roles.resolveRole({ type: "Browser" }), "main");
  assert.equal(roles.resolveRole({ type: "GPU" }), "gpu");
  const service = (serviceName) => roles.resolveRole({ type: "Utility", serviceName });
  assert.equal(service("network.mojom.NetworkService"), "network");
  assert.equal(service("audio.mojom.AudioService"), "audio");
  assert.equal(service("video_capture.mojom.VideoCaptureService"), "videoCapture");
  assert.equal(service("storage.mojom.StorageService"), "storage");
  assert.equal(service("data_decoder.mojom.DataDecoderService"), "unknown");
  assert.equal(
    roles.resolveRole({
      type: "Utility",
      serviceName: "node.mojom.NodeService",
      name: "openwhispr-onnx",
    }),
    "searchWorker"
  );
  for (const windowRole of [
    "controlPanel",
    "dictationWindow",
    "edgeStrip",
    "companionPill",
    "meetingOverlay",
    "permissionGuide",
  ]) {
    assert.equal(roles.resolveRole({ type: "Tab", windowRole }), windowRole);
  }
  assert.equal(roles.resolveRole({ type: "Tab" }), "unknown", "a renderer of no known window");
  assert.equal(roles.resolveRole({ type: "Tab", windowRole: "bogus" }), "unknown");
  assert.equal(roles.resolveRole({ type: "Zygote" }), "unknown");
});

test("helper programs map by exe name, release names and case included", () => {
  const cases = {
    "windows-key-listener.exe": "keyListener",
    "copilot-runtime.exe": "copilotRuntime",
    "whisper-server-win32-x64.exe": "whisperServer",
    "whisper-server-win32-x64-cuda.exe": "whisperServer",
    "sherpa-onnx-ws-win32-x64.exe": "parakeetServer",
    "sherpa-onnx-online-ws-win32-x64.exe": "parakeetServer",
    "sherpa-onnx-diarize-win32-x64.exe": "diarization",
    "llama-server-win32-x64-cpu.exe": "llamaServer",
    "qdrant-win32-x64.exe": "qdrant",
    "windows-system-audio-helper.exe": "systemAudioHelper",
    "windows-mic-listener.exe": "micListener",
    "windows-text-monitor.exe": "textMonitor",
    "meeting-aec-helper-win32-x64.exe": "meetingAecHelper",
    "ffmpeg.exe": "ffmpeg",
    "conhost.exe": "consoleHost",
    "CONHOST.EXE": "consoleHost",
  };
  for (const [exe, role] of Object.entries(cases)) {
    assert.equal(roles.resolveRole({ exe }), role, exe);
  }
  for (const exe of [
    "OpenWhispr.exe",
    "notepad.exe",
    "qdrantx.exe",
    "windows-key-listenerx.exe",
    "",
    null,
  ]) {
    assert.equal(roles.roleForExe(exe), "unknown", String(exe));
  }
});

test("groups: app, windows, services, helpers; an unknown process stays with its kind", () => {
  assert.equal(roles.describeRole("main").group, "app");
  assert.equal(roles.describeRole("gpu").group, "app");
  assert.equal(roles.describeRole("controlPanel").group, "windows");
  assert.equal(roles.describeRole("videoCapture").group, "services");
  assert.equal(roles.describeRole("searchWorker").group, "services");
  assert.equal(roles.describeRole("keyListener").group, "helpers");
  assert.equal(roles.groupFor("unknown", { type: "Tab" }), "windows");
  assert.equal(roles.groupFor("unknown", { type: "Utility" }), "services");
  assert.equal(roles.groupFor("unknown", { type: null }), "helpers");
});

test("the why and goes-away texts follow what main filled in", () => {
  const panel = (params) => roles.describeRole("controlPanel", params);
  assert.equal(
    panel({ visible: true }).whyKey,
    "settingsPage.processes.roles.controlPanel.why.visible"
  );
  const hidden = panel({ visible: false, hiddenSince: 1_000 });
  assert.equal(hidden.whyKey, "settingsPage.processes.roles.controlPanel.why.hidden");
  assert.deepEqual(hidden.whyParams, { since: 1_000 });
  assert.equal(
    panel({ visible: false, hiddenSince: null }).whyKey,
    "settingsPage.processes.roles.controlPanel.why.hiddenUnknown"
  );
  assert.equal(panel({}).whyKey, "settingsPage.processes.roles.controlPanel.why.default");

  const key = roles.describeRole("keyListener", { hotkey: "Control+`" });
  assert.equal(key.whyKey, "settingsPage.processes.roles.keyListener.why.hotkey");
  assert.deepEqual(key.whyParams, { hotkey: "Control+`" });

  const copilotIdle = roles.describeRole("copilotRuntime", {
    busy: false,
    minutes: 6,
    stopsAt: 99,
  });
  assert.equal(
    copilotIdle.goesAwayKey,
    "settingsPage.processes.roles.copilotRuntime.goesAway.stopsIn"
  );
  assert.deepEqual(copilotIdle.goesAwayParams, { minutes: 6, stopsAt: 99 });
  const copilotBusy = roles.describeRole("copilotRuntime", { busy: true, minutes: 6 });
  assert.equal(copilotBusy.whyKey, "settingsPage.processes.roles.copilotRuntime.why.busy");
  assert.equal(
    copilotBusy.goesAwayKey,
    "settingsPage.processes.roles.copilotRuntime.goesAway.default"
  );

  const frame = roles.describeRole("edgeStrip", { recording: false, releaseAfterSec: 30 });
  assert.equal(frame.whyKey, "settingsPage.processes.roles.edgeStrip.why.kept");
  assert.equal(frame.goesAwayKey, "settingsPage.processes.roles.edgeStrip.goesAway.afterSeconds");
  assert.deepEqual(frame.goesAwayParams, { seconds: 30 });
  const strip = roles.describeRole("edgeStrip", { recording: true, releaseAfterSec: 300 });
  assert.equal(strip.whyKey, "settingsPage.processes.roles.edgeStrip.why.recording");
  assert.deepEqual(strip.goesAwayParams, { minutes: 5 });

  const cameras = roles.describeRole("videoCapture", { cameras: 2 });
  assert.equal(cameras.whyKey, "settingsPage.processes.roles.videoCapture.why.cameras");
  assert.deepEqual(cameras.whyParams, { cameras: 2 });

  const bogus = roles.describeRole("nope");
  assert.equal(bogus.role, "unknown");
  assert.equal(bogus.nameKey, "settingsPage.processes.roles.unknown.name");
});

test("Not running now lists the on-demand roles that are absent", () => {
  const absent = roles.notRunningRoles(["main", "gpu", "copilotRuntime", "keyListener"]);
  const ids = absent.map((item) => item.role);
  assert.ok(!ids.includes("copilotRuntime"));
  assert.ok(ids.includes("whisperServer") && ids.includes("qdrant") && ids.includes("edgeStrip"));
  assert.deepEqual(
    absent.find((item) => item.role === "qdrant"),
    {
      role: "qdrant",
      nameKey: "settingsPage.processes.roles.qdrant.name",
      startsKey: "settingsPage.processes.notRunning.qdrant",
    }
  );
});

test("every key the roles can produce has an English text, and the fixture has no stray roles", () => {
  const variants = [
    {},
    { visible: true },
    { visible: false, hiddenSince: 1 },
    { visible: false },
    { hotkey: "F8" },
    { busy: true },
    { busy: false, minutes: 3 },
    { recording: true, releaseAfterSec: 30 },
    { recording: false, releaseAfterSec: 300 },
    { cameras: 1 },
  ];
  const keys = new Set();
  for (const role of roles.ROLE_IDS) {
    for (const params of variants) {
      const about = roles.describeRole(role, params);
      for (const key of [about.nameKey, about.whatKey, about.whyKey, about.goesAwayKey])
        keys.add(key);
    }
  }
  for (const item of roles.notRunningRoles([])) {
    keys.add(item.nameKey);
    keys.add(item.startsKey);
  }
  for (const key of keys) {
    assert.equal(typeof lookup(key), "string", `English text for ${key}`);
  }
  assert.deepEqual(
    Object.keys(english.settingsPage.processes.roles).sort(),
    [...roles.ROLE_IDS].sort()
  );
  assert.deepEqual(
    Object.keys(english.settingsPage.processes.notRunning).sort(),
    [...roles.ON_DEMAND_ROLES].sort()
  );
});

test("each English text's placeholders are parameters the role passes", () => {
  const params = {
    "controlPanel.why.hidden": ["since"],
    "keyListener.why.hotkey": ["hotkey"],
    "copilotRuntime.goesAway.stopsIn": ["minutes"],
    "edgeStrip.goesAway.afterSeconds": ["seconds"],
    "edgeStrip.goesAway.afterMinutes": ["minutes"],
    "videoCapture.why.cameras": ["cameras"],
  };
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (typeof value === "object") {
        walk(value, path);
        continue;
      }
      const used = [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]);
      assert.deepEqual(used, params[path] ?? [], path);
    }
  };
  walk(english.settingsPage.processes.roles, "");
});
