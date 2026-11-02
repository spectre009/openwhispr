const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NO_REPORT_MS,
  SETTLE_MS,
  classifyGpuCompositing,
  classifyGraphicsMode,
  createGraphicsModeMonitor,
  graphicsModeLabel,
  graphicsModeLogEntry,
  isSoftwareFallback,
  requestedSoftwareSwitch,
} = require("../../src/helpers/graphicsMode");

// The graphics mode (helpers/graphicsMode.js): gpu_compositing classified as
// hardware, software or unknown; software is "requested" by a launch flag or a
// "fallback"; the monitor waits for the GPU process to report (before that,
// every feature reads disabled), logs one line, warns for a fallback, logs a
// change after the GPU process goes, and never guesses without a report.

const NVIDIA =
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.16.1088)";
const WARP =
  "ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11-10.0.26100.9711)";
const HARDWARE = { gpu_compositing: "enabled", rasterization: "enabled", webgl: "enabled" };
// What every feature reads before the GPU process reports, and after a fallback.
const SOFTWARE = { gpu_compositing: "disabled_software", rasterization: "disabled_software" };

function commandLine(switches = {}) {
  return {
    hasSwitch: (name) => Object.hasOwn(switches, name),
    getSwitchValue: (name) => switches[name] ?? "",
  };
}

test("gpu_compositing: enabled* is hardware, disabled*/unavailable* software, else unknown", () => {
  for (const value of ["enabled", "enabled_on", "enabled_readback", "enabled_force_on"]) {
    assert.equal(classifyGpuCompositing(value), "hardware", value);
  }
  for (const value of [
    "disabled_software",
    "unavailable_software",
    "disabled_off",
    "unavailable_off",
  ]) {
    assert.equal(classifyGpuCompositing(value), "software", value);
  }
  for (const value of [undefined, null, "", 1, "weird", "Enabled"]) {
    assert.equal(classifyGpuCompositing(value), "unknown", String(value));
  }
});

test("only flags that ask for software drawing count as requested", () => {
  assert.equal(requestedSoftwareSwitch(commandLine({ "disable-gpu": "" })), "--disable-gpu");
  assert.equal(
    requestedSoftwareSwitch(commandLine({ "disable-gpu-compositing": "" })),
    "--disable-gpu-compositing"
  );
  assert.equal(requestedSoftwareSwitch(commandLine({ "use-angle": "WARP" })), "--use-angle=warp");
  assert.equal(
    requestedSoftwareSwitch(commandLine({ "use-gl": "swiftshader" })),
    "--use-gl=swiftshader"
  );
  // A GL backend this platform can't run is a GPU failure Chromium falls back from.
  assert.equal(requestedSoftwareSwitch(commandLine({ "use-gl": "desktop" })), null);
  assert.equal(requestedSoftwareSwitch(commandLine({ "use-angle": "d3d11" })), null);
  assert.equal(requestedSoftwareSwitch(commandLine()), null);
  assert.equal(requestedSoftwareSwitch(undefined), null);
  const throwing = {
    hasSwitch: () => {
      throw new Error("gone");
    },
  };
  assert.equal(requestedSoftwareSwitch(throwing), null);
});

test("software is a fallback unless a flag asked for it; hardware has no reason", () => {
  const details = { glRenderer: WARP, displayType: "ANGLE_D3D11_WARP" };
  const fallback = classifyGraphicsMode({ featureStatus: SOFTWARE, details });
  assert.deepEqual(
    { ...fallback },
    {
      mode: "software",
      reason: "fallback",
      requestedBy: null,
      gpuCompositing: "disabled_software",
      rasterization: "disabled_software",
      glRenderer: WARP,
      displayType: "ANGLE_D3D11_WARP",
    }
  );
  assert.equal(isSoftwareFallback(fallback), true);
  assert.equal(graphicsModeLabel(fallback), "software (fallback)");

  const requested = classifyGraphicsMode({ featureStatus: SOFTWARE, requestedBy: "--disable-gpu" });
  assert.deepEqual([requested.reason, requested.requestedBy], ["requested", "--disable-gpu"]);
  assert.equal(isSoftwareFallback(requested), false);

  const hardware = classifyGraphicsMode({ featureStatus: HARDWARE, requestedBy: "--use-gl=x" });
  assert.deepEqual(
    [hardware.mode, hardware.reason, hardware.requestedBy],
    ["hardware", null, null]
  );
  assert.equal(graphicsModeLabel(hardware), "hardware");

  const unknown = classifyGraphicsMode({ featureStatus: {} });
  assert.deepEqual([unknown.mode, unknown.reason, unknown.gpuCompositing], ["unknown", null, null]);
  assert.equal(classifyGraphicsMode().mode, "unknown");
});

test("the log line warns for a fallback only, and carries just the listed fields", () => {
  const fallback = classifyGraphicsMode({
    featureStatus: { ...SOFTWARE, webgl: "unavailable_software", video_decode: "x" },
    details: { glRenderer: WARP, displayType: "ANGLE_D3D11_WARP" },
  });
  assert.deepEqual(graphicsModeLogEntry(fallback), {
    level: "warn",
    message: "Graphics mode",
    meta: {
      mode: "software",
      reason: "fallback",
      gpuCompositing: "disabled_software",
      rasterization: "disabled_software",
      glRenderer: WARP,
      displayType: "ANGLE_D3D11_WARP",
    },
  });
  const hardware = classifyGraphicsMode({ featureStatus: HARDWARE });
  const changed = graphicsModeLogEntry(fallback, { previous: hardware });
  assert.equal(changed.message, "Graphics mode changed");
  assert.equal(changed.meta.from, "hardware");

  const linux = classifyGraphicsMode({
    featureStatus: SOFTWARE,
    requestedBy: "--disable-gpu-compositing",
  });
  assert.deepEqual(graphicsModeLogEntry(linux, { disabledForNvidia: true }), {
    level: "info",
    message: "Graphics mode",
    meta: {
      mode: "software",
      reason: "requested",
      requestedBy: "--disable-gpu-compositing",
      gpuCompositing: "disabled_software",
      rasterization: "disabled_software",
      disabledForNvidia: true,
    },
  });
  assert.equal(graphicsModeLogEntry(hardware).level, "info");
});

function fakeApp({ status = SOFTWARE, switches = {}, info } = {}) {
  const listeners = new Map();
  const app = {
    status,
    info: info ?? { auxAttributes: { glRenderer: NVIDIA, displayType: "ANGLE_D3D11" } },
    infoCalls: [],
    commandLine: commandLine(switches),
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) listener(...args);
    },
    getGPUFeatureStatus: () => app.status,
    getGPUInfo: (kind) => {
      app.infoCalls.push(kind);
      return typeof app.info === "function" ? app.info() : Promise.resolve(app.info);
    },
  };
  return app;
}

function fakeLogger() {
  const lines = [];
  const at = (level) => (message, meta, scope) => lines.push({ level, message, meta, scope });
  return { lines, info: at("info"), warn: at("warn"), debug: at("debug") };
}

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const app = fakeApp(options);
  const logger = fakeLogger();
  const changes = [];
  const monitor = createGraphicsModeMonitor({
    app,
    platform: options.platform ?? "win32",
    disabledForNvidia: options.disabledForNvidia,
  });
  const attach = () => monitor.attach({ logger, onChange: (state) => changes.push(state) });
  // Ticks the mocked timers, then lets the evaluations' promises run.
  const settle = async (ms = SETTLE_MS) => {
    t.mock.timers.tick(ms);
    for (let round = 0; round < 5; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { app, logger, changes, monitor, attach, settle };
}

test("nothing is classified before the GPU process reports; then one line", async (t) => {
  const { app, logger, changes, monitor, attach, settle } = setup(t);
  attach();
  // Before the report every feature reads disabled_software, even on a working GPU.
  await settle(5000);
  assert.deepEqual(logger.lines, []);
  assert.equal(monitor.getState().mode, "unknown");

  app.status = HARDWARE;
  app.emit("gpu-info-update");
  app.emit("gpu-info-update");
  await settle(SETTLE_MS - 1);
  assert.deepEqual(logger.lines, [], "a burst settles first");
  await settle(1);
  assert.deepEqual(logger.lines, [
    {
      level: "info",
      message: "Graphics mode",
      meta: {
        mode: "hardware",
        gpuCompositing: "enabled",
        rasterization: "enabled",
        glRenderer: NVIDIA,
        displayType: "ANGLE_D3D11",
      },
      scope: "gpu",
    },
  ]);
  assert.deepEqual(app.infoCalls, ["complete"]);
  assert.equal(monitor.getState().mode, "hardware");
  assert.deepEqual(
    changes.map((state) => state.mode),
    ["hardware"]
  );

  // More updates with the same mode log nothing and fetch nothing.
  app.emit("gpu-info-update");
  await settle();
  assert.equal(logger.lines.length, 1);
  assert.deepEqual(app.infoCalls, ["complete"]);
});

test("a driver that refused the GPU: one warning naming the software renderer", async (t) => {
  const { app, logger, changes, monitor, attach, settle } = setup(t, {
    info: { auxAttributes: { glRenderer: WARP, displayType: "ANGLE_D3D11_WARP" } },
  });
  // The report can come before the logger is up (startApp awaits first).
  app.emit("gpu-info-update");
  attach();
  await settle();
  assert.equal(logger.lines.length, 1);
  assert.deepEqual(logger.lines[0], {
    level: "warn",
    message: "Graphics mode",
    meta: {
      mode: "software",
      reason: "fallback",
      gpuCompositing: "disabled_software",
      rasterization: "disabled_software",
      glRenderer: WARP,
      displayType: "ANGLE_D3D11_WARP",
    },
    scope: "gpu",
  });
  assert.equal(isSoftwareFallback(monitor.getState()), true);
  assert.equal(changes.length, 1);
});

test("Linux's NVIDIA rule is a request, logged with disabledForNvidia", async (t) => {
  const { app, logger, attach, settle } = setup(t, {
    platform: "linux",
    disabledForNvidia: true,
    switches: { "disable-gpu-compositing": "" },
    info: {},
  });
  attach();
  app.emit("gpu-info-update");
  await settle();
  assert.deepEqual(logger.lines[0], {
    level: "info",
    message: "Graphics mode",
    meta: {
      mode: "software",
      reason: "requested",
      requestedBy: "--disable-gpu-compositing",
      gpuCompositing: "disabled_software",
      rasterization: "disabled_software",
      disabledForNvidia: true,
    },
    scope: "gpu",
  });
});

test("a GPU process lost mid-session: the exit and the change of mode are logged", async (t) => {
  const { app, logger, changes, attach, settle } = setup(t, { status: HARDWARE });
  attach();
  app.emit("gpu-info-update");
  await settle();
  assert.equal(logger.lines.at(-1).meta.mode, "hardware");

  app.emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: 1 });
  assert.equal(logger.lines.length, 1, "other processes are not ours");
  app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: -1073741819 });
  assert.deepEqual(logger.lines.at(-1), {
    level: "warn",
    message: "GPU process gone",
    meta: { reason: "crashed", exitCode: -1073741819 },
    scope: "gpu",
  });
  app.status = SOFTWARE;
  app.info = { auxAttributes: { glRenderer: WARP, displayType: "ANGLE_D3D11_WARP" } };
  await settle();
  const changed = logger.lines.at(-1);
  assert.equal(changed.level, "warn");
  assert.equal(changed.message, "Graphics mode changed");
  assert.equal(changed.meta.from, "hardware");
  assert.equal(changed.meta.reason, "fallback");
  assert.deepEqual(changes.map(graphicsModeLabel), ["hardware", "software (fallback)"]);
});

test("a GPU process gone before logging started is logged once the logger is attached", async (t) => {
  const { app, logger, attach } = setup(t);
  app.emit("child-process-gone", {}, { type: "GPU", reason: "launch-failed", exitCode: 1004 });
  assert.deepEqual(logger.lines, []);
  attach();
  assert.deepEqual(logger.lines, [
    {
      level: "warn",
      message: "GPU process gone",
      meta: { reason: "launch-failed", exitCode: 1004, beforeLogging: true },
      scope: "gpu",
    },
  ]);
});

test("no report at all is logged as unknown, never guessed from the defaults", async (t) => {
  const { logger, changes, attach, settle } = setup(t);
  attach();
  await settle(NO_REPORT_MS);
  assert.deepEqual(logger.lines, [
    {
      level: "info",
      message: "Graphics mode",
      meta: { mode: "unknown", gpuReported: false },
      scope: "gpu",
    },
  ]);
  assert.equal(changes.length, 1);
});

test("renderer details that never come don't hold the line back", async (t) => {
  const { app, logger, attach, settle } = setup(t, {
    status: HARDWARE,
    info: () => new Promise(() => {}),
  });
  attach();
  app.emit("gpu-info-update");
  await settle();
  assert.deepEqual(logger.lines, []);
  await settle(5000);
  assert.deepEqual(logger.lines[0].meta, {
    mode: "hardware",
    gpuCompositing: "enabled",
    rasterization: "enabled",
  });
});
