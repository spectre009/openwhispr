const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// A recording's target app is frozen when it starts (capture-dictation-target)
// and survives the stop-press probe that captureTarget() fires on every toggle
// press, without changing what the paste path reads from lastTarget.

const selectionManagerPath = require.resolve("../../src/helpers/selectionManager");
const originalLoad = Module._load;

function loadSelectionManager() {
  delete require.cache[selectionManagerPath];
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === "electron") return { clipboard: { readText: () => "", writeText: () => {} } };
    if (request === "./debugLogger") {
      return { debug() {}, info() {}, warn() {}, error() {}, trace() {}, log() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../../src/helpers/selectionManager");
  } finally {
    Module._load = originalLoad;
  }
}

const SelectionManager = loadSelectionManager();

const win = (exeName, id = exeName) => ({ kind: "win-hwnd", id, exeName, windowClass: null });

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A manager whose window probes the test settles by hand.
function makeManager({ platform = "win32", clock = { now: 1000 } } = {}) {
  const manager = new SelectionManager({
    clipboardManager: {},
    platform,
    now: () => clock.now,
  });
  const probes = [];
  manager._probeTarget = () => {
    const probe = deferred();
    probes.push(probe);
    return probe.promise;
  };
  return { manager, probes, clock };
}

test("the start target is frozen while the stop press probes again", async () => {
  const { manager, probes } = makeManager();

  // Start press: main's toggle probe, then the renderer's capture joins and freezes it.
  void manager.captureTarget();
  void manager.captureTarget();
  manager.freezeRecordingTarget();
  assert.equal(probes.length, 1, "the renderer's capture joins the in-flight probe");

  // Stop press (forced) starts a new probe before the start probe has landed.
  void manager.captureTarget({ force: true });
  assert.equal(probes.length, 2);
  probes[1].resolve(win("ms-teams.exe"));
  probes[0].resolve(win("Code.exe"));

  assert.deepEqual(await manager.getRecordingTargetApp(), { exeName: "Code.exe" });
  // The paste path still follows the newest probe, exactly as before.
  assert.equal((await manager.getWinTarget()).exeName, "ms-teams.exe");
});

test("a fresh capture the start press skipped is frozen as is", async () => {
  const { manager, probes, clock } = makeManager();
  void manager.captureTarget();
  probes[0].resolve(win("Obsidian.exe"));
  await manager.getWinTarget();

  clock.now += 10; // inside the freshness window: no new probe
  void manager.captureTarget();
  manager.freezeRecordingTarget();
  assert.equal(probes.length, 1);

  void manager.captureTarget({ force: true });
  probes[1].resolve(win("chrome.exe"));
  assert.deepEqual(await manager.getRecordingTargetApp(), { exeName: "Obsidian.exe" });
});

test("each start replaces the frozen target", async () => {
  const { manager, probes } = makeManager();
  void manager.captureTarget({ force: true });
  manager.freezeRecordingTarget();
  probes[0].resolve(win("Code.exe"));
  assert.deepEqual(await manager.getRecordingTargetApp(), { exeName: "Code.exe" });

  void manager.captureTarget({ force: true });
  manager.freezeRecordingTarget();
  probes[1].resolve(win("WindowsTerminal.exe"));
  assert.deepEqual(await manager.getRecordingTargetApp(), { exeName: "WindowsTerminal.exe" });
});

test("no freeze, a failed probe, or a non-Windows target is unknown", async () => {
  const { manager, probes } = makeManager();
  assert.equal(await manager.getRecordingTargetApp(), null);

  void manager.captureTarget({ force: true });
  manager.freezeRecordingTarget();
  probes[0].resolve(null);
  assert.equal(await manager.getRecordingTargetApp(), null);

  void manager.captureTarget({ force: true });
  manager.freezeRecordingTarget();
  probes[1].resolve({ kind: "win-hwnd", id: "9", exeName: null });
  assert.equal(await manager.getRecordingTargetApp(), null);

  const linux = makeManager({ platform: "linux" });
  void linux.manager.captureTarget({ force: true });
  linux.manager.freezeRecordingTarget();
  linux.probes[0].resolve({ kind: "x11-window", id: "0x1", appName: "code" });
  assert.equal(await linux.manager.getRecordingTargetApp(), null);
});
