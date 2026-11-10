// Every process OpenWhispr runs, what each one is and what it costs: one
// shared collector for Settings › Data › Processes & resources, the
// 24-hour history, the "Resource snapshot" log line and Copy diagnostics.
//
// - Electron's app.getAppMetrics() covers OpenWhispr.exe's own processes on
//   every platform (KiB, converted to bytes here; private bytes are Windows-only).
// - On Windows, resources/windows-process-stats.exe adds what Electron can't
//   see: helper programs, handles, threads, GDI/USER objects and, with --gpu,
//   graphics memory per process and how many processes on this PC hold it.
//   Its rows enrich Electron's for the same (pid, creation time), never
//   duplicate them.
// - CPU % is "% of one core", from each instance's total CPU seconds over a
//   monotonic clock; Electron's own % divides by the core count and resets
//   whenever anyone (ownProcessPids.js) reads the metrics.
//
// Sampling: a once-run every 5 minutes (graphics memory only in the run that
// feeds the 30-minute log line: PDH's first counter costs ~200 ms of CPU per
// run), a stream (one sample every 2 s, one PDH query kept open) only while a
// subscribed, visible page asks for it, and nothing while a dictation is
// being prepared, recorded, processed or delivered: a dictation starting
// cancels a run and stops the stream, and its only reads are getAppMetrics()
// at the recording's boundaries. History lives in memory for 24 hours. Logs
// and Copy diagnostics get an allowlisted report: roles, PIDs and numbers,
// never exe names, paths, command lines, window titles or helper output.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn: nodeSpawn } = require("child_process");
const { describeRole, notRunningRoles, resolveRole, ROLE_IDS } = require("./processRoles");

const HELPER_EXE = "windows-process-stats.exe";
const KIB = 1024;
const MB = 1024 * 1024;

const ONCE_DEADLINE_MS = 2000;
const STREAM_INTERVAL_MS = 2000;
// A stream that printed nothing for this long is restarted.
const STREAM_WATCHDOG_MS = 8000;
const STREAM_STOP_GRACE_MS = 1000;
const STREAM_RETRY_MS = Object.freeze([2000, 10_000, 60_000]);
// After this many failed starts in a row the stream rests for STREAM_REST_MS.
const STREAM_MAX_FAILURES = 3;
const STREAM_REST_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const RUN_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HISTORY_MAX_INSTANCES = 200;
// Points further apart than this get no CPU % (the app slept, or sampling paused).
const HISTORY_CPU_GAP_MS = 15 * 60 * 1000;
const SNAPSHOT_LOG_INTERVAL_MS = 30 * 60 * 1000;
// Timers drift: a run that lands this close to its mark counts as on time.
const SCHEDULE_SLACK_MS = 60 * 1000;
const CREATED_MATCH_TOLERANCE_MS = 1000;
// Windows refuses more than 10,000 GDI or USER objects per process.
const OBJECT_LIMIT = 10_000;
const OBJECT_WARN = 5000;
const HANDLE_GROWTH_RATIO = 0.5;
const HANDLE_GROWTH_MIN = 200;
const HANDLE_GROWTH_WINDOW_MS = 6 * 60 * 60 * 1000;
const TOTAL_WS_WARN_BYTES = 2 * 1024 * MB;
const WARN_REPEAT_MS = 60 * 60 * 1000;
// recordingEdgeStrip.js releases an idle frame after 30 s and idle strips
// (short, full) after 5 minutes.
const EDGE_RELEASE_SEC = Object.freeze({ frame: 30, short: 300, full: 300 });
const EDGE_STRIP_MODES = Object.freeze(["off", "short", "full", "frame"]);

const HELPER_GPU_STATES = new Set(["ok", "off", "failed"]);
const HELPER_ENGINE_STATES = new Set(["ok", "pending", "off", "failed"]);

const round = (value, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Math.round(value * 10 ** digits) / 10 ** digits;
const finiteOrNull = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const countOrNull = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const codeOrNull = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : null;
const toMb = (bytes) => (bytes === null ? null : round(bytes / MB, 1));

function exeName(value) {
  if (typeof value !== "string") return null;
  const base = value.split(/[\\/]/).pop().slice(0, 128);
  return base || null;
}

function processKey(pid, createdAt) {
  return `${pid}:${createdAt ?? "?"}`;
}

// ---------------------------------------------------------------------------
// Parsing and merging
// ---------------------------------------------------------------------------

/**
 * One line of the helper's output, validated: numbers or null, exe file
 * names only, structured error codes only. `{ ok: false, error }` for a
 * helper-reported error (root_not_found, bad_args, …) or unreadable output.
 */
function parseHelperOutput(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_output" };
  }
  if (!data || typeof data !== "object" || data.v !== 1) {
    return { ok: false, error: "invalid_output" };
  }
  if (data.error !== undefined)
    return { ok: false, error: codeOrNull(data.error) ?? "invalid_output" };
  if (!Array.isArray(data.processes)) return { ok: false, error: "invalid_output" };

  const self = countOrNull(data.self);
  const processes = [];
  for (const item of data.processes) {
    if (!item || typeof item !== "object" || !Number.isInteger(item.pid) || item.pid <= 0) continue;
    if (item.pid === self) continue;
    const createdAt = finiteOrNull(item.createdAt);
    processes.push({
      pid: item.pid,
      ppid: countOrNull(item.ppid),
      exe: exeName(item.exe),
      createdAt: createdAt === null ? null : Math.floor(createdAt),
      cpuSec: finiteOrNull(item.cpuSec),
      ws: finiteOrNull(item.ws),
      priv: finiteOrNull(item.priv),
      peak: finiteOrNull(item.peak),
      handles: countOrNull(item.handles),
      threads: countOrNull(item.threads),
      gdi: countOrNull(item.gdi),
      user: countOrNull(item.user),
      gpuDedicated: finiteOrNull(item.gpuDedicated),
      gpuShared: finiteOrNull(item.gpuShared),
      gpuUse: finiteOrNull(item.gpuUse),
      errors: Array.isArray(item.errors)
        ? item.errors.map(codeOrNull).filter(Boolean).slice(0, 8)
        : [],
    });
  }
  const gpu = data.gpu && typeof data.gpu === "object" ? data.gpu : {};
  return {
    ok: true,
    sample: {
      at: finiteOrNull(data.at),
      root: countOrNull(data.root),
      self,
      processes,
      gpu: {
        status: HELPER_GPU_STATES.has(gpu.status) ? gpu.status : "failed",
        error: codeOrNull(gpu.error),
        processesWithDedicated: countOrNull(gpu.processesWithDedicated),
        engine: HELPER_ENGINE_STATES.has(gpu.engine) ? gpu.engine : "off",
      },
      sampleMs: finiteOrNull(data.sampleMs),
      pdhInitMs: finiteOrNull(data.pdhInitMs),
      selfCpuMs: finiteOrNull(data.selfCpuMs),
    },
  };
}

/**
 * app.getAppMetrics() in bytes. Memory is KiB there (private bytes are
 * Windows-only); a missing or zero value is null, never 0: no live process
 * has an empty working set.
 */
function normalizeElectronMetrics(metrics) {
  if (!Array.isArray(metrics)) return [];
  const kib = (value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value * KIB : null;
  return metrics
    .filter((metric) => Number.isInteger(metric?.pid) && metric.pid > 0)
    .map((metric) => {
      const memory = metric.memory && typeof metric.memory === "object" ? metric.memory : null;
      const created = metric.creationTime;
      return {
        pid: metric.pid,
        type: typeof metric.type === "string" ? metric.type : null,
        serviceName: typeof metric.serviceName === "string" ? metric.serviceName : null,
        name: typeof metric.name === "string" ? metric.name : null,
        createdAt:
          typeof created === "number" && Number.isFinite(created) && created > 0
            ? Math.floor(created)
            : null,
        ws: kib(memory?.workingSetSize),
        priv: kib(memory?.privateBytes),
        peak: kib(memory?.peakWorkingSetSize),
        cpuSec: finiteOrNull(metric.cpu?.cumulativeCPUUsage),
      };
    });
}

const HELPER_ONLY_FIELDS = Object.freeze([
  "handles",
  "threads",
  "gdi",
  "user",
  "gpuDedicated",
  "gpuShared",
  "gpuUse",
]);
const SHARED_FIELDS = Object.freeze(["ws", "priv", "peak", "cpuSec"]);

function sameProcess(a, b) {
  if (a.pid !== b.pid) return false;
  if (a.createdAt === null || b.createdAt === null) return true;
  return Math.abs(a.createdAt - b.createdAt) <= CREATED_MATCH_TOLERANCE_MS;
}

/**
 * Electron's rows, enriched by the helper's for the same (pid, creation
 * time); the helper's other rows (programs Electron doesn't list) added. A
 * reused PID (another creation time) is another process.
 */
function mergeProcesses({ electron = [], helper = null } = {}) {
  const rows = electron.map((metric) => ({
    pid: metric.pid,
    ppid: null,
    createdAt: metric.createdAt,
    type: metric.type,
    serviceName: metric.serviceName,
    name: metric.name,
    exe: null,
    source: "electron",
    ws: metric.ws,
    priv: metric.priv,
    peak: metric.peak,
    cpuSec: metric.cpuSec,
    handles: null,
    threads: null,
    gdi: null,
    user: null,
    gpuDedicated: null,
    gpuShared: null,
    gpuUse: null,
    errors: [],
  }));
  for (const item of helper?.processes ?? []) {
    const row = rows.find(
      (candidate) => candidate.source === "electron" && sameProcess(candidate, item)
    );
    if (row) {
      row.source = "both";
      row.ppid = item.ppid;
      row.exe = item.exe;
      if (row.createdAt === null) row.createdAt = item.createdAt;
      for (const field of SHARED_FIELDS) if (row[field] === null) row[field] = item[field];
      for (const field of HELPER_ONLY_FIELDS) row[field] = item[field];
      row.errors = item.errors;
      continue;
    }
    rows.push({
      pid: item.pid,
      ppid: item.ppid,
      createdAt: item.createdAt,
      type: null,
      serviceName: null,
      name: null,
      exe: item.exe,
      source: "helper",
      ws: item.ws,
      priv: item.priv,
      peak: item.peak,
      cpuSec: item.cpuSec,
      handles: item.handles,
      threads: item.threads,
      gdi: item.gdi,
      user: item.user,
      gpuDedicated: item.gpuDedicated,
      gpuShared: item.gpuShared,
      gpuUse: item.gpuUse,
      errors: item.errors,
    });
  }
  for (const row of rows) row.key = processKey(row.pid, row.createdAt);
  return rows;
}

/** `100 × Δcpu seconds ÷ Δwall seconds`: % of one core; null without a usable previous reading. */
function cpuPercent(previous, current) {
  if (!previous || previous.cpuSec === null || current.cpuSec === null) return null;
  const wallSec = (current.mono - previous.mono) / 1000;
  const cpuDelta = current.cpuSec - previous.cpuSec;
  if (!(wallSec >= 0.2) || cpuDelta < 0) return null;
  return round((100 * cpuDelta) / wallSec, 2);
}

/** CPU % per process instance between successive samples of one sampling series. */
function createCpuTracker() {
  let previous = new Map();
  let previousMono = null;
  return {
    /** Sets each row's cpuPct; returns the interval it covers in seconds (null on the first). */
    apply(rows, mono) {
      const next = new Map();
      for (const row of rows) {
        row.cpuPct = cpuPercent(previous.get(row.key), { cpuSec: row.cpuSec, mono });
        if (row.cpuSec !== null) next.set(row.key, { cpuSec: row.cpuSec, mono });
      }
      const interval = previousMono === null ? null : round((mono - previousMono) / 1000, 1);
      previous = next;
      previousMono = mono;
      return interval;
    },
    reset() {
      previous = new Map();
      previousMono = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Roles and windows
// ---------------------------------------------------------------------------

/**
 * The renderers of main's own windows: pid → [{ role, visible, since, mode }],
 * the dictation window first, so a renderer two windows share is named after it.
 */
function collectWindowRoles({ windowManager, visibility = null } = {}) {
  const result = new Map();
  const add = (win, role, extra = {}) => {
    try {
      if (!win || win.isDestroyed?.()) return;
      const pid = win.webContents?.getOSProcessId?.();
      if (!Number.isInteger(pid) || pid <= 0) return;
      const seen = visibility?.get?.(win) ?? null;
      const info = {
        role,
        visible: typeof win.isVisible === "function" ? win.isVisible() : null,
        since: seen?.since ?? null,
        ...extra,
      };
      if (!result.has(pid)) result.set(pid, []);
      result.get(pid).push(info);
    } catch {
      // a window going away mid-read is simply not listed
    }
  };
  add(windowManager?.mainWindow, "dictationWindow");
  add(windowManager?.controlPanelWindow, "controlPanel");
  add(windowManager?.agentDictationPillWindow, "companionPill");
  add(windowManager?.notificationWindow, "meetingOverlay");
  add(windowManager?.permissionGuide?.window, "permissionGuide");
  let strips = [];
  try {
    strips = windowManager?.recordingEdgeStrip?.listWindows?.() ?? [];
  } catch {
    strips = [];
  }
  for (const strip of strips) add(strip.window, "edgeStrip", { mode: strip.mode ?? null });
  return result;
}

/**
 * When each window was last shown or hidden, from its creation: closing the
 * control panel only hides it, and "hidden since" is the page's answer to
 * "why is it running?". Tracks every BrowserWindow created after it starts.
 */
function createWindowVisibilityTracker({ app, now = Date.now } = {}) {
  const states = new WeakMap();
  const track = (win) => {
    if (!win || states.has(win)) return;
    let visible = false;
    try {
      visible = win.isVisible();
    } catch {
      visible = false;
    }
    const state = { visible, since: now() };
    states.set(win, state);
    const set = (next) => () => {
      if (state.visible === next) return;
      state.visible = next;
      state.since = now();
    };
    win.on?.("show", set(true));
    win.on?.("hide", set(false));
  };
  app?.on?.("browser-window-created", (_event, win) => track(win));
  return { track, get: (win) => states.get(win) ?? null };
}

function aboutParams(role, row, context, at) {
  const windowInfo = row.windows?.[0] ?? null;
  switch (role) {
    case "controlPanel":
      return {
        visible: windowInfo?.visible ?? null,
        hiddenSince: windowInfo?.visible === false ? (windowInfo.since ?? null) : null,
      };
    case "edgeStrip":
      return {
        recording: context.recording === true,
        mode: windowInfo?.mode ?? null,
        releaseAfterSec: EDGE_RELEASE_SEC[windowInfo?.mode] ?? null,
      };
    case "keyListener": {
      const hotkey = context.keyListeners?.get?.(row.pid);
      return typeof hotkey === "string" ? { hotkey } : {};
    }
    case "copilotRuntime": {
      const copilot = context.copilot ?? null;
      const stopsAt = Number.isFinite(copilot?.idleStopAt) ? copilot.idleStopAt : null;
      return {
        busy: (copilot?.activeRequests ?? 0) > 0,
        stopsAt,
        minutes: stopsAt === null ? null : Math.max(0, Math.ceil((stopsAt - at) / 60000)),
      };
    }
    case "videoCapture":
      return Number.isInteger(context.cameras) ? { cameras: context.cameras } : {};
    default:
      return {};
  }
}

/** Role, group, what-it-is keys, state and average CPU for every merged row. */
function annotateRows(rows, context = {}, at = Date.now()) {
  const windows = context.windows instanceof Map ? context.windows : new Map();
  for (const row of rows) {
    const hosted = row.type === "Tab" ? (windows.get(row.pid) ?? []) : [];
    row.windows = hosted.map((info) => ({ ...info }));
    row.role = resolveRole({
      type: row.type,
      serviceName: row.serviceName,
      name: row.name,
      windowRole: hosted[0]?.role ?? null,
      exe: row.exe,
    });
    const params = aboutParams(row.role, row, context, at);
    row.about = describeRole(row.role, params, { type: row.type });
    row.group = row.about.group;
    if (hosted.length) row.state = hosted[0].visible === false ? "hidden" : "visible";
    else if (row.role === "copilotRuntime") row.state = params.busy ? "busy" : "idle";
    else row.state = null;
    const uptimeSec = row.createdAt === null ? null : (at - row.createdAt) / 1000;
    row.cpuAvg =
      row.cpuSec !== null && uptimeSec !== null && uptimeSec >= 1
        ? round((100 * row.cpuSec) / uptimeSec, 2)
        : null;
  }
  return rows;
}

/** Sums over all processes: shared memory is counted once per process, so it's an upper bound. */
function computeTotals(rows) {
  const sum = (field) => {
    const values = rows
      .map((row) => row[field])
      .filter((value) => value !== null && value !== undefined);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const cpu = sum("cpuPct");
  return {
    processes: rows.length,
    ws: sum("ws"),
    priv: sum("priv"),
    cpuPct: cpu === null ? null : round(cpu, 2),
    gpuDedicated: sum("gpuDedicated"),
    gpuShared: sum("gpuShared"),
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Up to 24 hours of points per process instance, expired by age. A skipped
 * sample (a dictation, the app asleep) leaves a gap: nothing is interpolated.
 */
function createHistory({
  maxAgeMs = HISTORY_MAX_AGE_MS,
  maxInstances = HISTORY_MAX_INSTANCES,
  cpuGapMs = HISTORY_CPU_GAP_MS,
} = {}) {
  const instances = new Map();
  let samples = [];
  let recordings = [];

  function prune(now) {
    const cutoff = now - maxAgeMs;
    samples = samples.filter((at) => at >= cutoff);
    recordings = recordings.filter((recording) => recording.at >= cutoff);
    for (const [key, entry] of instances) {
      entry.points = entry.points.filter((point) => point.at >= cutoff);
      if (!entry.points.length) instances.delete(key);
    }
    if (instances.size > maxInstances) {
      const oldest = [...instances.values()]
        .sort((a, b) => a.points.at(-1).at - b.points.at(-1).at)
        .slice(0, instances.size - maxInstances);
      for (const entry of oldest) instances.delete(entry.key);
    }
  }

  return {
    /** One point per process at `at`; graphics memory only when `gpuFresh`. */
    add(rows, { at, mono, gpuFresh = true }) {
      samples.push(at);
      for (const row of rows) {
        let entry = instances.get(row.key);
        if (!entry) {
          entry = { key: row.key, pid: row.pid, createdAt: row.createdAt, points: [] };
          instances.set(row.key, entry);
        }
        entry.role = row.role;
        entry.group = row.group;
        const last = entry.points.at(-1);
        let cpuPct = null;
        if (last && last.mono < mono && mono - last.mono <= cpuGapMs) {
          cpuPct = cpuPercent(last, { cpuSec: row.cpuSec, mono });
        }
        entry.points.push({
          at,
          mono,
          ws: row.ws,
          priv: row.priv,
          cpuSec: row.cpuSec,
          cpuPct,
          gpuDedicated: gpuFresh ? row.gpuDedicated : null,
          handles: row.handles,
          gdi: row.gdi,
          user: row.user,
        });
      }
      prune(at);
    },
    addRecording(recording, now) {
      recordings.push(recording);
      prune(now);
    },
    /** The instance's latest point at or before `at`, or null. */
    pointBefore(key, at) {
      const points = instances.get(key)?.points ?? [];
      for (let i = points.length - 1; i >= 0; i--) if (points[i].at <= at) return points[i];
      return null;
    },
    toJSON(now) {
      prune(now);
      return {
        maxAgeMs,
        samples: [...samples],
        recordings: recordings.map((recording) => ({ ...recording })),
        instances: [...instances.values()].map((entry) => ({
          key: entry.key,
          role: entry.role,
          group: entry.group,
          pid: entry.pid,
          createdAt: entry.createdAt,
          points: entry.points.map(({ mono: _mono, cpuSec: _cpuSec, ...point }) => point),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Recording phases
// ---------------------------------------------------------------------------

/**
 * CPU per process between two getAppMetrics() readings. A process present at
 * both is measured; one that appeared is measured over its own lifetime and
 * marked partial; one that exited is partial with no number (never 0).
 */
function phaseUsage(before, after) {
  if (!before || !after) return [];
  const wallSec = (after.mono - before.mono) / 1000;
  const result = [];
  for (const row of after.rows) {
    const earlier = before.rows.find((candidate) => candidate.key === row.key);
    if (earlier) {
      result.push({
        key: row.key,
        pid: row.pid,
        role: row.role,
        cpuPct: cpuPercent(
          { cpuSec: earlier.cpuSec, mono: before.mono },
          { cpuSec: row.cpuSec, mono: after.mono }
        ),
        partial: false,
        change: null,
      });
      continue;
    }
    // Appeared during the phase: measured over its own lifetime within it.
    const lifeSec = row.createdAt === null ? null : (after.at - row.createdAt) / 1000;
    const seconds = lifeSec === null ? null : Math.min(lifeSec, wallSec);
    result.push({
      key: row.key,
      pid: row.pid,
      role: row.role,
      cpuPct:
        row.cpuSec !== null && seconds !== null && seconds >= 0.2
          ? round((100 * row.cpuSec) / seconds, 2)
          : null,
      partial: true,
      change: "appeared",
    });
  }
  for (const row of before.rows) {
    if (after.rows.some((candidate) => candidate.key === row.key)) continue;
    result.push({
      key: row.key,
      pid: row.pid,
      role: row.role,
      cpuPct: null,
      partial: true,
      change: "exited",
    });
  }
  return result;
}

/** Per-role sums of a phase's CPU %, for the log line (instances of one role add up). */
function cpuByRole(usage) {
  const byRole = {};
  for (const item of usage) {
    if (item.cpuPct === null) continue;
    byRole[item.role] = round((byRole[item.role] ?? 0) + item.cpuPct, 1);
  }
  return byRole;
}

/** "new" when an edge-strip renderer started during the recording, "reused", or "none". */
function frameWindowOf(reading, startedAt) {
  const strips = (reading?.rows ?? []).filter((row) => row.role === "edgeStrip");
  if (!strips.length) return "none";
  return strips.some((row) => row.createdAt !== null && row.createdAt >= startedAt - 1000)
    ? "new"
    : "reused";
}

// ---------------------------------------------------------------------------
// Report, log lines, warnings
// ---------------------------------------------------------------------------

const knownRole = (role) => (ROLE_IDS.includes(role) ? role : "unknown");

/**
 * The allowlisted view of a snapshot that logs and Copy diagnostics use:
 * roles, PIDs, numbers and enums only. Bytes; CPU in % of one core.
 */
function buildReport(snapshot, now = Date.now()) {
  if (!snapshot) return null;
  const processes = snapshot.processes.map((row) => ({
    role: knownRole(row.role),
    group: ["app", "windows", "services", "helpers"].includes(row.group) ? row.group : "helpers",
    pid: countOrNull(row.pid),
    ws: finiteOrNull(row.ws),
    priv: finiteOrNull(row.priv),
    peak: finiteOrNull(row.peak),
    cpuPct: finiteOrNull(row.cpuPct),
    cpuAvg: finiteOrNull(row.cpuAvg),
    cpuSec: finiteOrNull(row.cpuSec) === null ? null : round(row.cpuSec, 1),
    gpuDedicated: finiteOrNull(row.gpuDedicated),
    gpuShared: finiteOrNull(row.gpuShared),
    gpuUse: finiteOrNull(row.gpuUse),
    handles: countOrNull(row.handles),
    threads: countOrNull(row.threads),
    gdi: countOrNull(row.gdi),
    user: countOrNull(row.user),
    uptimeSec:
      Number.isFinite(row.createdAt) && row.createdAt > 0
        ? Math.max(0, Math.round((now - row.createdAt) / 1000))
        : null,
  }));
  const graphics = snapshot.machine?.graphics ?? null;
  return {
    at: snapshot.at,
    ageSec: Math.max(0, Math.round((now - snapshot.at) / 1000)),
    source: ["once", "stream", "electron"].includes(snapshot.source) ? snapshot.source : "once",
    cpuIntervalSec: finiteOrNull(snapshot.cpuIntervalSec),
    gpuAt: finiteOrNull(snapshot.gpuAt),
    totals: computeTotals(processes),
    gpuProcesses: countOrNull(snapshot.machine?.gpuProcesses),
    graphics: {
      mode: ["hardware", "software", "unknown"].includes(graphics?.mode)
        ? graphics.mode
        : "unknown",
      reason: ["requested", "fallback"].includes(graphics?.reason) ? graphics.reason : null,
    },
    ramTotal: finiteOrNull(snapshot.machine?.ramTotal),
    ramFree: finiteOrNull(snapshot.machine?.ramFree),
    helper: ["ok", "missing", "failed", "unsupported"].includes(snapshot.helper?.status)
      ? snapshot.helper.status
      : "unsupported",
    helperError: codeOrNull(snapshot.helper?.error),
    processes,
  };
}

/** "Resource snapshot": one line, MB and % of one core. */
function snapshotLogMeta(report) {
  const totals = report.totals;
  return {
    ageSec: report.ageSec,
    source: report.source,
    processes: totals.processes,
    wsMB: toMb(totals.ws),
    privMB: toMb(totals.priv),
    cpuPct: round(totals.cpuPct, 1),
    cpuIntervalSec: report.cpuIntervalSec,
    gpuMB: toMb(totals.gpuDedicated),
    gpuAgeSec:
      report.gpuAt === null
        ? null
        : report.ageSec + Math.max(0, Math.round((report.at - report.gpuAt) / 1000)),
    gpuProcesses: report.gpuProcesses,
    graphics: report.graphics.reason
      ? `${report.graphics.mode} (${report.graphics.reason})`
      : report.graphics.mode,
    helper: report.helper,
    ...(report.helperError ? { helperError: report.helperError } : {}),
    roles: report.processes.map((row) => ({
      role: row.role,
      pid: row.pid,
      wsMB: toMb(row.ws),
      privMB: toMb(row.priv),
      cpuAvg: round(row.cpuAvg, 1),
      cpuSec: row.cpuSec,
      gpuMB: toMb(row.gpuDedicated),
      handles: row.handles,
      gdi: row.gdi,
      user: row.user,
    })),
  };
}

/**
 * "Resource warning"s due now: GDI or USER objects over 5,000 in a process,
 * handles up more than 50% (and by 200+) over 6 hours, everything's in-RAM
 * sum over 2 GB. Each at most once an hour per process (per kind).
 */
function evaluateWarnings({ rows, history = null, lastWarned, now }) {
  const warnings = [];
  const due = (id) => {
    const last = lastWarned.get(id);
    if (last !== undefined && now - last < WARN_REPEAT_MS) return false;
    lastWarned.set(id, now);
    return true;
  };
  for (const row of rows) {
    const role = knownRole(row.role);
    for (const [field, kind] of [
      ["gdi", "gdiObjects"],
      ["user", "userObjects"],
    ]) {
      const count = row[field];
      if (count !== null && count > OBJECT_WARN && due(`${kind}:${row.key}`)) {
        warnings.push({ kind, role, pid: row.pid, count, limit: OBJECT_LIMIT });
      }
    }
    if (row.handles !== null && history) {
      const base = history.pointBefore(row.key, now - HANDLE_GROWTH_WINDOW_MS);
      if (
        base?.handles > 0 &&
        row.handles - base.handles >= HANDLE_GROWTH_MIN &&
        row.handles > base.handles * (1 + HANDLE_GROWTH_RATIO) &&
        due(`handleGrowth:${row.key}`)
      ) {
        warnings.push({
          kind: "handleGrowth",
          role,
          pid: row.pid,
          handles: row.handles,
          handlesBefore: base.handles,
          hours: round((now - base.at) / 3_600_000, 1),
        });
      }
    }
  }
  const ws = computeTotals(rows).ws;
  if (ws !== null && ws > TOTAL_WS_WARN_BYTES && due("totalMemory")) {
    warnings.push({
      kind: "totalMemory",
      wsMB: toMb(ws),
      processes: rows.length,
      limitMB: TOTAL_WS_WARN_BYTES / MB,
    });
  }
  return warnings;
}

/** "Recording cost" (debug): per-role CPU of the recording and of processing and delivery. */
function recordingCostMeta(record) {
  const partial = [
    ...new Set(
      [...record.recording, ...record.processing]
        .filter((item) => item.partial)
        .map((item) => knownRole(item.role))
    ),
  ];
  const gpuMB = {};
  for (const item of record.processes) {
    if (item.gpuAfterDelivery === null) continue;
    gpuMB[knownRole(item.role)] = round(
      (gpuMB[knownRole(item.role)] ?? 0) + item.gpuAfterDelivery / MB,
      1
    );
  }
  return {
    inputKind: ["dictation", "assistant", "translation"].includes(record.inputKind)
      ? record.inputKind
      : "dictation",
    recordingMs: record.recordingMs,
    processingMs: record.processingMs,
    strip: EDGE_STRIP_MODES.includes(record.strip) ? record.strip : "off",
    frameWindow: record.frameWindow,
    recordingCpu: cpuByRole(record.recording),
    processingCpu: cpuByRole(record.processing),
    partial,
    gpuAfterDelivery: record.afterDelivery.status,
    gpuAfterDeliveryMB: gpuMB,
    gpuProcesses: record.afterDelivery.gpuProcesses,
    ...(record.overlapped ? { overlapped: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

function defaultHelperCandidates() {
  const candidates = [path.join(__dirname, "..", "..", "resources", "bin", HELPER_EXE)];
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "bin", HELPER_EXE),
      path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", HELPER_EXE)
    );
  }
  return candidates;
}

function resolveHelperPath(candidates = defaultHelperCandidates()) {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function killQuietly(child) {
  try {
    child?.kill();
  } catch {
    // already gone
  }
}

/**
 * @param {object} deps
 * @param {{ getAppMetrics: Function }} deps.app
 * @param {object} [deps.logger]  debugLogger
 * @param {() => boolean} [deps.isDictationBusy]  windowManager.isDictationBusy
 * @param {() => { state: string, inputKind: string }} [deps.getDictationLifecycle]
 * @param {() => object} [deps.describeContext]  { windows, keyListeners, copilot, recording, cameras }
 * @param {() => object | null} [deps.getGraphics]  graphicsMode's state
 * @param {() => string} [deps.getStripMode]  the edge strip's mode for a recording
 * @param {(contents, payload) => void} [deps.send]  to one subscriber
 * @param {(contents) => boolean} [deps.isVisible]  the subscriber's window shows
 * @param {(contents, onChange) => Function} [deps.watchVisibility]  returns an unwatch function
 */
function createProcessInventory({
  app,
  platform = process.platform,
  rootPid = process.pid,
  logger = null,
  helperPath = undefined,
  spawn = nodeSpawn,
  isDictationBusy = () => false,
  getDictationLifecycle = () => ({ state: "idle", inputKind: "dictation" }),
  describeContext = () => ({}),
  getGraphics = () => null,
  getStripMode = () => "off",
  send = (contents, payload) => contents.send("process-inventory-sample", payload),
  isVisible = () => true,
  watchVisibility = () => () => {},
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  now = Date.now,
  mono = () => performance.now(),
  memory = { total: () => os.totalmem(), free: () => os.freemem() },
  firstRunDelayMs = FIRST_RUN_DELAY_MS,
  runIntervalMs = RUN_INTERVAL_MS,
  onceDeadlineMs = ONCE_DEADLINE_MS,
  streamIntervalMs = STREAM_INTERVAL_MS,
  streamWatchdogMs = STREAM_WATCHDOG_MS,
}) {
  const helperFile =
    platform !== "win32" ? null : helperPath === undefined ? resolveHelperPath() : helperPath;
  const onceCpu = createCpuTracker();
  const streamCpu = createCpuTracker();
  const history = createHistory();
  const lastWarned = new Map();
  const subscribers = new Map();
  const unref = (timer) => {
    timer?.unref?.();
    return timer;
  };
  const log = (level, message, meta) => {
    try {
      logger?.[level]?.(message, meta, "resources");
    } catch {
      // logging never breaks sampling
    }
  };

  let started = false;
  let stopped = false;
  let snapshot = null;
  let lastGpu = null;
  let helperState = {
    status: platform !== "win32" ? "unsupported" : helperFile ? "ok" : "missing",
    error: null,
  };
  let lastHistoryAt = null;
  let lastSnapshotLogAt = null;
  let firstTimer = null;
  let tickTimer = null;
  let deferredTick = false;
  let inflight = null;
  let stream = null;
  let electronStreamTimer = null;
  let streamFailures = 0;
  let streamRetryTimer = null;
  let busy = false;
  let recording = false;
  let record = null;
  let lastRecording = null;
  let awaitingDelivery = null;
  let pendingAfterDelivery = null;

  const helperUsable = () => helperFile !== null;

  function readElectron() {
    try {
      return normalizeElectronMetrics(app.getAppMetrics());
    } catch {
      return [];
    }
  }

  function readContext() {
    try {
      return describeContext() ?? {};
    } catch {
      return {};
    }
  }

  function readGraphics() {
    try {
      const state = getGraphics();
      return state
        ? {
            mode: state.mode ?? "unknown",
            reason: state.reason ?? null,
            glRenderer: state.glRenderer ?? null,
          }
        : null;
    } catch {
      return null;
    }
  }

  function noteHelper(status, error = null) {
    helperState = { status, error: codeOrNull(error) };
  }

  /** Merges, annotates and keeps one sample; returns the snapshot. */
  function ingest(sample, { source, tracker }) {
    const at = now();
    const monoAt = mono();
    const rows = mergeProcesses({ electron: readElectron(), helper: sample });
    annotateRows(rows, readContext(), at);
    const cpuIntervalSec = tracker.apply(rows, monoAt);

    const gpuFresh = sample?.gpu?.status === "ok";
    if (gpuFresh) {
      lastGpu = {
        at,
        processes: sample.gpu.processesWithDedicated,
        byKey: new Map(rows.map((row) => [row.key, row])),
      };
    } else if (lastGpu) {
      for (const row of rows) {
        const known = lastGpu.byKey.get(row.key);
        if (!known) continue;
        row.gpuDedicated = known.gpuDedicated;
        row.gpuShared = known.gpuShared;
      }
    }

    const presentRoles = rows.map((row) => row.role);
    snapshot = {
      at,
      source,
      cpuIntervalSec,
      gpuAt: lastGpu?.at ?? null,
      processes: rows,
      totals: computeTotals(rows),
      machine: {
        gpuProcesses: lastGpu?.processes ?? null,
        graphics: readGraphics(),
        ramTotal: finiteOrNull(memory.total()),
        ramFree: finiteOrNull(memory.free()),
      },
      helper: {
        ...helperState,
        gpu: sample?.gpu?.status ?? "off",
        gpuError: sample?.gpu?.error ?? null,
        engine: sample?.gpu?.engine ?? "off",
      },
      notRunning: sample ? notRunningRoles(presentRoles) : [],
    };

    if (lastHistoryAt === null || at - lastHistoryAt >= HISTORY_INTERVAL_MS - SCHEDULE_SLACK_MS) {
      lastHistoryAt = at;
      history.add(rows, { at, mono: monoAt, gpuFresh });
    }
    for (const warning of evaluateWarnings({ rows, history, lastWarned, now: at })) {
      log("warn", "Resource warning", warning);
    }
    // A run that asked for graphics memory answers a delivered dictation's "after delivery".
    if (pendingAfterDelivery && sample && sample.gpu.status !== "off") {
      settleAfterDelivery(sample.gpu.status === "ok" ? "ok" : "unavailable");
    }
    broadcast();
    return snapshot;
  }

  function unavailableList() {
    const list = [];
    if (platform !== "win32") list.push("windowsOnly");
    else if (helperState.status === "missing") list.push("helperMissing");
    else if (helperState.status === "failed") list.push("helperFailed");
    if (snapshot?.helper?.gpu === "failed") list.push("gpuCounters");
    if (
      snapshot &&
      snapshot.processes.length &&
      snapshot.processes.every((row) => row.ws === null)
    ) {
      list.push("memory");
    }
    return list;
  }

  function payload() {
    return {
      snapshot,
      lastRecording,
      unavailable: unavailableList(),
      paused: busy,
      streaming: stream !== null || electronStreamTimer !== null,
    };
  }

  function broadcast() {
    if (!subscribers.size) return;
    const message = payload();
    for (const { contents } of subscribers.values()) {
      try {
        if (!contents.isDestroyed?.()) send(contents, message);
      } catch {
        // a window closing mid-send
      }
    }
  }

  // --- once-runs -----------------------------------------------------------

  function runHelperOnce(run) {
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let deadline = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (deadline) timers.clearTimeout(deadline);
        resolve(result);
      };
      try {
        child = spawn(
          helperFile,
          ["--once", "--root", String(rootPid), ...(run.gpu ? ["--gpu"] : [])],
          { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
        );
      } catch {
        finish({ ok: false, error: "spawn_failed" });
        return;
      }
      run.cancel = () => {
        finish({ ok: false, error: "cancelled" });
        killQuietly(child);
      };
      deadline = unref(
        timers.setTimeout(() => {
          finish({ ok: false, error: "timeout" });
          killQuietly(child);
        }, onceDeadlineMs)
      );
      const chunks = [];
      // A pipe error (the helper gone mid-read) ends in "close" like any exit.
      child.stdout?.on?.("error", () => {});
      let bytes = 0;
      child.stdout?.on("data", (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          finish({ ok: false, error: "output_too_large" });
          killQuietly(child);
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", () => finish({ ok: false, error: "spawn_failed" }));
      child.on("close", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (!text) {
          finish({ ok: false, error: "no_output" });
          return;
        }
        finish(parseHelperOutput(text));
      });
    });
  }

  /**
   * One sample through the shared collector: joins a run in flight (one with
   * graphics memory serves a request without), never runs while a dictation
   * is busy, and drops a result that arrives after it was cancelled.
   */
  function collectOnce({ gpu = false } = {}) {
    if (stopped || !started) return Promise.resolve(null);
    if (busy) return Promise.resolve(null);
    if (inflight) {
      if (inflight.gpu || !gpu) return inflight.promise;
      return inflight.promise.then(() => collectOnce({ gpu }));
    }
    if (!helperUsable())
      return Promise.resolve(ingest(null, { source: "electron", tracker: onceCpu }));
    const run = { gpu, cancel: null, cancelled: false, promise: null };
    run.promise = runHelperOnce(run).then((result) => {
      if (inflight === run) inflight = null;
      if (stopped || run.cancelled || busy) return null;
      if (!result.ok) {
        noteHelper("failed", result.error);
        log("debug", "Process stats helper run failed", { error: codeOrNull(result.error) });
        return ingest(null, { source: "electron", tracker: onceCpu });
      }
      noteHelper("ok");
      return ingest(result.sample, { source: "once", tracker: onceCpu });
    });
    inflight = run;
    return run.promise;
  }

  function cancelOnce() {
    const run = inflight;
    if (!run) return;
    inflight = null;
    run.cancelled = true;
    run.cancel?.();
  }

  const snapshotLogDue = () =>
    lastSnapshotLogAt === null ||
    now() - lastSnapshotLogAt >= SNAPSHOT_LOG_INTERVAL_MS - SCHEDULE_SLACK_MS;

  function maybeLogSnapshot() {
    if (stopped || !snapshot || !snapshotLogDue()) return;
    lastSnapshotLogAt = now();
    const report = buildReport(snapshot, lastSnapshotLogAt);
    log("info", "Resource snapshot", JSON.stringify(snapshotLogMeta(report)));
  }

  function tick() {
    if (stopped) return;
    if (isStreaming()) {
      maybeLogSnapshot();
      return;
    }
    if (busy) {
      deferredTick = true;
      return;
    }
    // Graphics memory (PDH, ~200 ms of CPU) only for the run the log line uses;
    // a run a dictation cancelled logs nothing (the after-delivery run will).
    collectOnce({ gpu: snapshotLogDue() }).then((result) => {
      if (result) maybeLogSnapshot();
    });
  }

  // --- stream ----------------------------------------------------------------

  const isStreaming = () => stream !== null || electronStreamTimer !== null;

  function wantStream() {
    if (stopped || !started || busy) return false;
    for (const { contents } of subscribers.values()) {
      try {
        if (!contents.isDestroyed?.() && isVisible(contents)) return true;
      } catch {
        // gone
      }
    }
    return false;
  }

  function reconcileStream() {
    if (wantStream()) startStream();
    else stopStream();
  }

  function startStream() {
    if (isStreaming() || streamRetryTimer) return;
    streamCpu.reset();
    if (!helperUsable()) {
      ingest(null, { source: "electron", tracker: streamCpu });
      electronStreamTimer = unref(
        timers.setInterval(() => {
          if (!busy) ingest(null, { source: "electron", tracker: streamCpu });
        }, streamIntervalMs)
      );
      return;
    }
    let child;
    try {
      child = spawn(
        helperFile,
        ["--stream", "--root", String(rootPid), "--interval", String(streamIntervalMs), "--gpu"],
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }
      );
    } catch {
      streamFailed(null, "spawn_failed");
      return;
    }
    const current = { child, buffer: "", watchdog: null, stopping: false, lines: 0 };
    // Closing stdin of a helper that already exited is EPIPE: never an
    // unhandled stream error in main.
    child.stdin?.on?.("error", () => {});
    child.stdout?.on?.("error", () => {});
    stream = current;
    const armWatchdog = () => {
      if (current.watchdog) timers.clearTimeout(current.watchdog);
      current.watchdog = unref(
        timers.setTimeout(() => streamFailed(current, "stalled"), streamWatchdogMs)
      );
    };
    armWatchdog();
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (text) => {
      if (stream !== current || current.stopping) return;
      current.buffer += text;
      if (current.buffer.length > MAX_OUTPUT_BYTES) {
        streamFailed(current, "output_too_large");
        return;
      }
      let newline;
      while (stream === current && (newline = current.buffer.indexOf("\n")) >= 0) {
        const line = current.buffer.slice(0, newline).trim();
        current.buffer = current.buffer.slice(newline + 1);
        if (!line) continue;
        const parsed = parseHelperOutput(line);
        if (!parsed.ok) {
          streamFailed(current, parsed.error);
          return;
        }
        armWatchdog();
        current.lines += 1;
        streamFailures = 0;
        noteHelper("ok");
        if (!busy) ingest(parsed.sample, { source: "stream", tracker: streamCpu });
      }
    });
    child.on("error", () => streamFailed(current, "spawn_failed"));
    child.on("close", () => {
      if (stream === current && !current.stopping) streamFailed(current, "exited");
    });
  }

  function streamFailed(current, error) {
    if (current && stream !== current) return;
    stopStream();
    streamFailures += 1;
    noteHelper("failed", error);
    if (pendingAfterDelivery) settleAfterDelivery("unavailable");
    log("debug", "Process stats stream stopped", {
      error: codeOrNull(error),
      failures: streamFailures,
    });
    // The retry timer alone holds the stream back: startStream refuses while it's set.
    let delay;
    if (streamFailures >= STREAM_MAX_FAILURES) {
      streamFailures = 0;
      delay = STREAM_REST_MS;
    } else {
      delay = STREAM_RETRY_MS[Math.min(streamFailures - 1, STREAM_RETRY_MS.length - 1)];
    }
    streamRetryTimer = unref(
      timers.setTimeout(() => {
        streamRetryTimer = null;
        reconcileStream();
      }, delay)
    );
  }

  function stopStream() {
    if (electronStreamTimer) {
      timers.clearInterval(electronStreamTimer);
      electronStreamTimer = null;
    }
    const current = stream;
    if (!current) return null;
    stream = null;
    current.stopping = true;
    if (current.watchdog) timers.clearTimeout(current.watchdog);
    const exited = new Promise((resolve) => {
      if (current.child.exitCode !== null && current.child.exitCode !== undefined) {
        resolve();
        return;
      }
      const kill = unref(
        timers.setTimeout(() => {
          killQuietly(current.child);
          resolve();
        }, STREAM_STOP_GRACE_MS)
      );
      current.child.once?.("close", () => {
        timers.clearTimeout(kill);
        resolve();
      });
    });
    // Closing stdin ends the stream; the grace timer kills one that doesn't.
    try {
      current.child.stdin?.end();
    } catch {
      killQuietly(current.child);
    }
    return exited;
  }

  // --- dictations ------------------------------------------------------------

  function phaseReading() {
    const at = now();
    const rows = mergeProcesses({ electron: readElectron() });
    annotateRows(rows, readContext(), at);
    return { at, mono: mono(), rows };
  }

  function finishRecord(target, { overlapped = false } = {}) {
    if (!target || target.finished) return;
    target.finished = true;
    target.overlapped = overlapped;
    const end = target.end ?? phaseReading();
    target.processingEnd = end;
    target.processing = phaseUsage(target.stop ?? target.start, end);
    target.processingMs = target.stop ? Math.round(end.mono - target.stop.mono) : null;
    const keys = new Map();
    for (const item of [...target.recording, ...target.processing]) {
      if (!keys.has(item.key))
        keys.set(item.key, { key: item.key, pid: item.pid, role: item.role });
    }
    target.processes = [...keys.values()].map((item) => ({
      ...item,
      recording: target.recording.find((usage) => usage.key === item.key) ?? null,
      processing: target.processing.find((usage) => usage.key === item.key) ?? null,
      gpuAfterDelivery: null,
    }));
    lastRecording = publicRecord(target);
  }

  function publicRecord(target) {
    return {
      at: target.startedAt,
      inputKind: target.inputKind,
      strip: target.strip,
      frameWindow: target.frameWindow,
      recordingMs: target.recordingMs,
      processingMs: target.processingMs,
      overlapped: target.overlapped === true,
      processes: target.processes.map((item) => ({ ...item })),
      afterDelivery: { ...target.afterDelivery },
    };
  }

  function settleAfterDelivery(status) {
    const target = pendingAfterDelivery;
    if (!target) return;
    pendingAfterDelivery = null;
    target.afterDelivery.status = status;
    if (status === "ok" && snapshot) {
      target.afterDelivery.at = snapshot.at;
      target.afterDelivery.gpuProcesses = snapshot.machine.gpuProcesses;
      target.afterDelivery.gpuDedicated = snapshot.totals.gpuDedicated;
      for (const item of target.processes) {
        const row = snapshot.processes.find((candidate) => candidate.key === item.key);
        item.gpuAfterDelivery = row?.gpuDedicated ?? null;
      }
    }
    lastRecording = publicRecord(target);
    log("debug", "Recording cost", JSON.stringify(recordingCostMeta(target)));
  }

  function recordingBegan(inputKind) {
    const start = phaseReading();
    if (awaitingDelivery) {
      // The previous dictation is still being delivered: its processing ends here.
      awaitingDelivery.end = start;
      finishRecord(awaitingDelivery, { overlapped: true });
      pendingAfterDelivery = awaitingDelivery;
      settleAfterDelivery("skipped");
      awaitingDelivery = null;
    }
    let strip = "off";
    try {
      strip = getStripMode() ?? "off";
    } catch {
      strip = "off";
    }
    record = {
      startedAt: start.at,
      inputKind,
      strip,
      start,
      stop: null,
      end: null,
      recording: [],
      processing: [],
      processes: [],
      recordingMs: null,
      processingMs: null,
      frameWindow: "none",
      afterDelivery: { status: "pending", at: null, gpuProcesses: null, gpuDedicated: null },
      finished: false,
    };
  }

  function recordingEnded() {
    const target = record;
    if (!target) return;
    target.stop = phaseReading();
    target.recording = phaseUsage(target.start, target.stop);
    target.recordingMs = Math.round(target.stop.mono - target.start.mono);
    target.frameWindow = frameWindowOf(target.stop, target.startedAt);
    history.addRecording({ at: target.startedAt, durationMs: target.recordingMs }, now());
    awaitingDelivery = target;
    record = null;
  }

  function delivered() {
    const target = awaitingDelivery;
    awaitingDelivery = null;
    if (!target) return false;
    target.end = phaseReading();
    finishRecord(target);
    pendingAfterDelivery = target;
    return true;
  }

  /** Called on every lifecycle or delivery change (windowManager.onDictationStateChanged). */
  function handleDictationStateChanged() {
    if (stopped) return;
    let nextBusy = false;
    let lifecycle = null;
    try {
      nextBusy = isDictationBusy() === true;
      lifecycle = getDictationLifecycle();
    } catch {
      return;
    }
    const recordingNow = lifecycle?.state === "recording";

    if (nextBusy && !busy) {
      busy = true;
      cancelOnce();
      stopStream();
      if (pendingAfterDelivery) settleAfterDelivery("cancelled");
      broadcast();
    }
    if (recordingNow && !recording) recordingBegan(lifecycle?.inputKind ?? "dictation");
    else if (!recordingNow && recording) recordingEnded();
    recording = recordingNow;

    if (!nextBusy && busy) {
      busy = false;
      const hadRecording = delivered();
      if (!started) {
        if (hadRecording) settleAfterDelivery("skipped");
        return;
      }
      if (hadRecording && !helperUsable()) settleAfterDelivery("unavailable");
      // A stream's first sample carries graphics memory: it answers "after delivery".
      if (wantStream()) startStream();
      if (hadRecording && helperUsable() && !stream) {
        deferredTick = false;
        collectOnce({ gpu: true }).then((result) => {
          if (pendingAfterDelivery) settleAfterDelivery(result ? "unavailable" : "cancelled");
          if (result) maybeLogSnapshot();
        });
      } else if (deferredTick && !isStreaming()) {
        deferredTick = false;
        tick();
      }
      broadcast();
    }
  }

  // --- subscriptions -----------------------------------------------------------

  function subscribe(contents) {
    if (stopped || !contents) return payload();
    const id = contents.id ?? contents;
    if (!subscribers.has(id)) {
      let unwatch = () => {};
      try {
        unwatch = watchVisibility(contents, reconcileStream) ?? (() => {});
      } catch {
        unwatch = () => {};
      }
      const onGone = () => unsubscribe(contents);
      contents.once?.("destroyed", onGone);
      subscribers.set(id, {
        contents,
        cleanup: () => {
          unwatch();
          contents.removeListener?.("destroyed", onGone);
        },
      });
    }
    reconcileStream();
    return payload();
  }

  function unsubscribe(contents) {
    const id = contents?.id ?? contents;
    const entry = subscribers.get(id);
    if (entry) {
      subscribers.delete(id);
      entry.cleanup();
    }
    reconcileStream();
    return { success: true };
  }

  // --- lifecycle ---------------------------------------------------------------

  function start() {
    if (started || stopped) return;
    started = true;
    busy = isDictationBusy() === true;
    firstTimer = unref(
      timers.setTimeout(() => {
        firstTimer = null;
        tick();
        tickTimer = unref(timers.setInterval(tick, runIntervalMs));
      }, firstRunDelayMs)
    );
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (firstTimer) timers.clearTimeout(firstTimer);
    if (tickTimer) timers.clearInterval(tickTimer);
    if (streamRetryTimer) timers.clearTimeout(streamRetryTimer);
    firstTimer = tickTimer = streamRetryTimer = null;
    cancelOnce();
    for (const entry of subscribers.values()) entry.cleanup();
    subscribers.clear();
    await stopStream();
  }

  return {
    start,
    stop,
    collectOnce,
    handleDictationStateChanged,
    subscribe,
    unsubscribe,
    /** The latest sample, history, last recording and what's unavailable; never starts a run. */
    get({ history: withHistory = true } = {}) {
      const at = now();
      return {
        ...payload(),
        history: withHistory ? history.toJSON(at) : null,
        report: buildReport(snapshot, at),
      };
    },
    /** Tests. */
    _state: () => ({ busy, recording, inflight: inflight !== null, streaming: isStreaming() }),
  };
}

/** process-inventory-get / -subscribe / -unsubscribe; samples go to subscribers as process-inventory-sample. */
function registerProcessInventoryIpc({ ipcMain, inventory }) {
  ipcMain.handle("process-inventory-get", (_event, options) =>
    inventory.get({ history: options?.history !== false })
  );
  ipcMain.handle("process-inventory-subscribe", (event) => inventory.subscribe(event.sender));
  ipcMain.handle("process-inventory-unsubscribe", (event) => inventory.unsubscribe(event.sender));
}

module.exports = {
  CREATED_MATCH_TOLERANCE_MS,
  EDGE_RELEASE_SEC,
  FIRST_RUN_DELAY_MS,
  HANDLE_GROWTH_MIN,
  HANDLE_GROWTH_RATIO,
  HANDLE_GROWTH_WINDOW_MS,
  HELPER_EXE,
  HISTORY_INTERVAL_MS,
  HISTORY_MAX_AGE_MS,
  MAX_OUTPUT_BYTES,
  OBJECT_LIMIT,
  OBJECT_WARN,
  ONCE_DEADLINE_MS,
  RUN_INTERVAL_MS,
  SNAPSHOT_LOG_INTERVAL_MS,
  STREAM_INTERVAL_MS,
  STREAM_WATCHDOG_MS,
  TOTAL_WS_WARN_BYTES,
  WARN_REPEAT_MS,
  annotateRows,
  buildReport,
  collectWindowRoles,
  computeTotals,
  cpuByRole,
  cpuPercent,
  createCpuTracker,
  createHistory,
  createProcessInventory,
  createWindowVisibilityTracker,
  evaluateWarnings,
  frameWindowOf,
  mergeProcesses,
  normalizeElectronMetrics,
  parseHelperOutput,
  phaseUsage,
  processKey,
  recordingCostMeta,
  registerProcessInventoryIpc,
  resolveHelperPath,
  snapshotLogMeta,
};
