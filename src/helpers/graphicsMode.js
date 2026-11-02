// What Chromium draws with: the graphics card ("hardware") or the CPU
// ("software"), and for software whether a launch flag asked for it
// ("requested") or Chromium gave up on the GPU ("fallback": a driver that
// refused a device, a GPU process that kept failing). Software compositing
// makes the pill's and the edge frame's animations stutter while the
// renderer's own frames stay on time, so renderer frame pacing never shows it;
// this is how the log, System › Diagnostics and the dictation start visuals
// line learn it.

// Launch flags that ask for software drawing. main.js appends
// --disable-gpu-compositing itself on Linux while an NVIDIA driver is loaded.
const SOFTWARE_SWITCHES = Object.freeze([
  { name: "disable-gpu" },
  { name: "disable-gpu-compositing" },
  { name: "use-angle", values: ["swiftshader", "swiftshader-webgl", "warp"] },
  { name: "use-gl", values: ["swiftshader", "swiftshader-webgl"] },
]);

// Before the GPU process reports, every feature reads as disabled, so nothing
// is classified until the first gpu-info-update, plus this long for a burst of
// updates (a fallback relaunching the GPU process) to settle.
const SETTLE_MS = 1000;
// No report at all by then: logged as unknown rather than guessed.
const NO_REPORT_MS = 15_000;
const DETAILS_TIMEOUT_MS = 5000;

const UNKNOWN_GRAPHICS = Object.freeze({
  mode: "unknown",
  reason: null,
  requestedBy: null,
  gpuCompositing: null,
  rasterization: null,
  glRenderer: null,
  displayType: null,
});

const stringOrNull = (value) => (typeof value === "string" && value !== "" ? value : null);

/** `gpu_compositing` from getGPUFeatureStatus(): enabled* is the GPU, disabled* / unavailable* the CPU. */
function classifyGpuCompositing(value) {
  if (typeof value !== "string" || value === "") return "unknown";
  if (value.startsWith("enabled")) return "hardware";
  if (value.startsWith("disabled") || value.startsWith("unavailable")) return "software";
  return "unknown";
}

/** The launch flag that asks for software drawing (e.g. "--disable-gpu"), or null. */
function requestedSoftwareSwitch(commandLine) {
  for (const { name, values } of SOFTWARE_SWITCHES) {
    let present = false;
    try {
      present = commandLine?.hasSwitch?.(name) === true;
    } catch {
      present = false;
    }
    if (!present) continue;
    if (!values) return `--${name}`;
    let value = "";
    try {
      value = String(commandLine.getSwitchValue?.(name) ?? "").toLowerCase();
    } catch {
      value = "";
    }
    if (values.includes(value)) return `--${name}=${value}`;
  }
  return null;
}

/**
 * The graphics mode from getGPUFeatureStatus(), the requesting flag (if any)
 * and the renderer details: glRenderer and displayType only, nothing else from
 * the GPU info.
 */
function classifyGraphicsMode({ featureStatus, requestedBy = null, details = null } = {}) {
  const gpuCompositing = stringOrNull(featureStatus?.gpu_compositing);
  const mode = classifyGpuCompositing(gpuCompositing);
  const software = mode === "software";
  return Object.freeze({
    mode,
    reason: software ? (requestedBy ? "requested" : "fallback") : null,
    requestedBy: software ? requestedBy || null : null,
    gpuCompositing,
    rasterization: stringOrNull(featureStatus?.rasterization),
    glRenderer: stringOrNull(details?.glRenderer),
    displayType: stringOrNull(details?.displayType),
  });
}

/** The renderer details from getGPUInfo("complete"); null when it has none. */
function gpuRendererDetails(info) {
  const aux = info?.auxAttributes;
  return {
    glRenderer: stringOrNull(aux?.glRenderer),
    displayType: stringOrNull(aux?.displayType),
  };
}

function isSoftwareFallback(state) {
  return state?.mode === "software" && state?.reason === "fallback";
}

/** "hardware", "software (fallback)", "software (requested)" or "unknown". */
function graphicsModeLabel(state) {
  const mode = state?.mode ?? "unknown";
  return state?.reason ? `${mode} (${state.reason})` : mode;
}

const sameMode = (a, b) => a?.mode === b?.mode && a?.reason === b?.reason;

/**
 * The log line for a settled mode: "Graphics mode" the first time, "Graphics
 * mode changed" after. Info for hardware and a requested software mode; warn
 * for a fallback, so it shows at Problems only.
 */
function graphicsModeLogEntry(state, { previous = null, disabledForNvidia } = {}) {
  const meta = {
    mode: state.mode,
    reason: state.reason,
    requestedBy: state.requestedBy,
    gpuCompositing: state.gpuCompositing,
    rasterization: state.rasterization,
    glRenderer: state.glRenderer,
    displayType: state.displayType,
    from: previous ? graphicsModeLabel(previous) : null,
    disabledForNvidia,
  };
  return {
    level: isSoftwareFallback(state) ? "warn" : "info",
    message: previous ? "Graphics mode changed" : "Graphics mode",
    meta: Object.fromEntries(
      Object.entries(meta).filter(([, value]) => value !== null && value !== undefined)
    ),
  };
}

/**
 * Watches the graphics mode for the whole session. Created before app ready,
 * so the first gpu-info-update and a GPU process that fails early are seen;
 * logs and announces once `attach` gives it the logger. Re-evaluated after
 * every burst of gpu-info-update and after a GPU child-process-gone; a change
 * of mode is logged and passed to `onChange`.
 *
 * @param {object} deps
 * @param {object} deps.app  Electron's app (on, getGPUFeatureStatus, getGPUInfo, commandLine)
 * @param {boolean} [deps.disabledForNvidia]  Linux's NVIDIA rule, kept in the Linux log line
 */
function createGraphicsModeMonitor({
  app,
  commandLine = app.commandLine,
  platform = process.platform,
  disabledForNvidia = false,
  timers = { setTimeout, clearTimeout },
  settleMs = SETTLE_MS,
  noReportMs = NO_REPORT_MS,
  detailsTimeoutMs = DETAILS_TIMEOUT_MS,
}) {
  let logger = null;
  let onChange = null;
  let reported = false;
  let state = UNKNOWN_GRAPHICS;
  let logged = null;
  let settleTimer = null;
  let noReportTimer = null;
  let queue = Promise.resolve();
  // GPU process exits before the logger was attached, logged on attach.
  const earlyExits = [];
  const linuxMeta = platform === "linux" ? { disabledForNvidia: Boolean(disabledForNvidia) } : {};

  const unref = (timer) => {
    timer?.unref?.();
    return timer;
  };

  function schedule() {
    if (!logger) return;
    if (settleTimer) timers.clearTimeout(settleTimer);
    settleTimer = unref(
      timers.setTimeout(() => {
        settleTimer = null;
        queue = queue.then(evaluate, evaluate);
      }, settleMs)
    );
  }

  function readStatus() {
    try {
      return app.getGPUFeatureStatus();
    } catch {
      return null;
    }
  }

  async function readDetails() {
    let timer = null;
    try {
      const info = await Promise.race([
        Promise.resolve().then(() => app.getGPUInfo("complete")),
        new Promise((resolve) => {
          timer = unref(timers.setTimeout(() => resolve(null), detailsTimeoutMs));
        }),
      ]);
      return gpuRendererDetails(info);
    } catch {
      return gpuRendererDetails(null);
    } finally {
      if (timer) timers.clearTimeout(timer);
    }
  }

  function settle(next, extra = {}) {
    const previous = logged;
    logged = next;
    state = next;
    const entry = graphicsModeLogEntry(next, { previous, ...linuxMeta });
    logger?.[entry.level]?.(entry.message, { ...entry.meta, ...extra }, "gpu");
    try {
      onChange?.(next);
    } catch {
      // a broadcast failing must not stop the monitor
    }
  }

  async function evaluate() {
    if (!logger || !reported) return;
    const requestedBy = requestedSoftwareSwitch(commandLine);
    const quick = classifyGraphicsMode({ featureStatus: readStatus(), requestedBy });
    if (logged && sameMode(quick, logged)) return;
    const details = await readDetails();
    const next = classifyGraphicsMode({ featureStatus: readStatus(), requestedBy, details });
    if (logged && sameMode(next, logged)) return;
    settle(next);
  }

  function reportMissing() {
    if (logger && !reported && !logged) settle(UNKNOWN_GRAPHICS, { gpuReported: false });
  }

  app.on("gpu-info-update", () => {
    reported = true;
    if (noReportTimer) {
      timers.clearTimeout(noReportTimer);
      noReportTimer = null;
    }
    schedule();
  });

  app.on("child-process-gone", (_event, details) => {
    if (details?.type !== "GPU") return;
    const exit = { reason: details.reason, exitCode: details.exitCode };
    if (logger) logger.warn?.("GPU process gone", exit, "gpu");
    else earlyExits.push(exit);
    schedule();
  });

  return {
    /** Starts logging and announcing; until now changes are only recorded. */
    attach({ logger: nextLogger, onChange: nextOnChange } = {}) {
      logger = nextLogger ?? null;
      onChange = nextOnChange ?? null;
      if (!logger) return;
      for (const exit of earlyExits.splice(0)) {
        logger.warn?.("GPU process gone", { ...exit, beforeLogging: true }, "gpu");
      }
      if (reported) {
        schedule();
      } else if (!noReportTimer) {
        noReportTimer = unref(
          timers.setTimeout(() => {
            noReportTimer = null;
            reportMissing();
          }, noReportMs)
        );
      }
    },
    /** The mode as last settled (unknown until the GPU process has reported). */
    getState: () => state,
    /** Resolves once queued evaluations have run (tests). */
    idle: () => queue,
  };
}

module.exports = {
  DETAILS_TIMEOUT_MS,
  NO_REPORT_MS,
  SETTLE_MS,
  SOFTWARE_SWITCHES,
  UNKNOWN_GRAPHICS,
  classifyGpuCompositing,
  classifyGraphicsMode,
  createGraphicsModeMonitor,
  gpuRendererDetails,
  graphicsModeLabel,
  graphicsModeLogEntry,
  isSoftwareFallback,
  requestedSoftwareSwitch,
};
