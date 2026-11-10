// What each process OpenWhispr runs is for, for Settings › Data › Processes &
// resources, the "Resource snapshot" log line and Copy diagnostics
// (processInventory.js). Pure: maps Electron's process type and service name,
// the window a renderer belongs to, or a helper's exe name to a role id, and a
// role plus the parameters main fills in (which hotkey, hidden since when,
// stops in how long) to i18n keys. The English texts live in
// test/fixtures/processRoles.en.json, for the page's locales to copy.

const KEY_PREFIX = "settingsPage.processes.roles";
const NOT_RUNNING_PREFIX = "settingsPage.processes.notRunning";

// app: the main and graphics processes; windows: renderers; services:
// Chromium's utility processes; helpers: programs OpenWhispr starts.
const GROUPS = Object.freeze(["app", "windows", "services", "helpers"]);

// Chromium's utility services by Electron's serviceName.
const SERVICE_ROLES = Object.freeze({
  "network.mojom.NetworkService": "network",
  "audio.mojom.AudioService": "audio",
  "video_capture.mojom.VideoCaptureService": "videoCapture",
  "storage.mojom.StorageService": "storage",
});

// utilityProcess.fork's serviceName for the ONNX worker (onnxWorkerClient.js):
// Electron reports it as the process's name.
const ONNX_WORKER_NAME = "openwhispr-onnx";

// Helper programs by exe name (lower case). Release builds add the platform
// and backend to some names (whisper-server-win32-x64.exe), so these match a
// prefix up to "-" or ".".
const HELPER_EXE_ROLES = Object.freeze([
  ["windows-key-listener", "keyListener"],
  ["copilot-runtime", "copilotRuntime"],
  ["whisper-server", "whisperServer"],
  ["sherpa-onnx-online-ws", "parakeetServer"],
  ["sherpa-onnx-ws", "parakeetServer"],
  ["sherpa-onnx-diarize", "diarization"],
  ["llama-server", "llamaServer"],
  ["qdrant", "qdrant"],
  ["windows-system-audio-helper", "systemAudioHelper"],
  ["windows-mic-listener", "micListener"],
  ["windows-text-monitor", "textMonitor"],
  ["meeting-aec-helper", "meetingAecHelper"],
  ["ffmpeg", "ffmpeg"],
  ["conhost", "consoleHost"],
]);

const sinceParams = (at) => (Number.isFinite(at) ? { since: at } : {});

// Each role's group, and for some the variant of "why it's running" and
// "when it goes away" its parameters pick (default otherwise).
const ROLE_SPECS = Object.freeze({
  main: { group: "app" },
  gpu: { group: "app" },
  network: { group: "services" },
  audio: { group: "services" },
  videoCapture: { group: "services" },
  storage: { group: "services" },
  controlPanel: {
    group: "windows",
    why: (p) => {
      if (p.visible === true) return ["visible"];
      if (Number.isFinite(p.hiddenSince)) return ["hidden", sinceParams(p.hiddenSince)];
      return p.visible === false ? ["hiddenUnknown"] : null;
    },
  },
  dictationWindow: { group: "windows" },
  edgeStrip: {
    group: "windows",
    why: (p) => (p.recording === true ? ["recording"] : p.recording === false ? ["kept"] : null),
    goesAway: (p) => {
      if (!Number.isFinite(p.releaseAfterSec)) return null;
      return p.releaseAfterSec < 120
        ? ["afterSeconds", { seconds: p.releaseAfterSec }]
        : ["afterMinutes", { minutes: Math.round(p.releaseAfterSec / 60) }];
    },
  },
  companionPill: { group: "windows" },
  meetingOverlay: { group: "windows" },
  permissionGuide: { group: "windows" },
  keyListener: {
    group: "helpers",
    why: (p) =>
      typeof p.hotkey === "string" && p.hotkey ? ["hotkey", { hotkey: p.hotkey }] : null,
  },
  copilotRuntime: {
    group: "helpers",
    why: (p) => (p.busy === true ? ["busy"] : null),
    goesAway: (p) =>
      p.busy !== true && Number.isInteger(p.minutes)
        ? ["stopsIn", { minutes: p.minutes, stopsAt: p.stopsAt }]
        : null,
  },
  whisperServer: { group: "helpers" },
  parakeetServer: { group: "helpers" },
  llamaServer: { group: "helpers" },
  qdrant: { group: "helpers" },
  searchWorker: { group: "services" },
  systemAudioHelper: { group: "helpers" },
  micListener: { group: "helpers" },
  textMonitor: { group: "helpers" },
  ffmpeg: { group: "helpers" },
  meetingAecHelper: { group: "helpers" },
  diarization: { group: "helpers" },
  consoleHost: { group: "helpers" },
  unknown: { group: "helpers" },
});

const ROLE_IDS = Object.freeze(Object.keys(ROLE_SPECS));

// Roles a feature starts and stops, listed under "Not running now" when absent
// (only where the helper can see programs: Windows).
const ON_DEMAND_ROLES = Object.freeze([
  "whisperServer",
  "parakeetServer",
  "llamaServer",
  "copilotRuntime",
  "qdrant",
  "searchWorker",
  "systemAudioHelper",
  "meetingAecHelper",
  "diarization",
  "micListener",
  "textMonitor",
  "edgeStrip",
]);

/** The role of a helper program from its exe name; "unknown" for anything else. */
function roleForExe(exe) {
  if (typeof exe !== "string" || !exe) return "unknown";
  const name = exe.toLowerCase();
  for (const [prefix, role] of HELPER_EXE_ROLES) {
    if (name === `${prefix}.exe` || name === prefix) return role;
    if (name.startsWith(prefix) && /^[-.]/.test(name.slice(prefix.length))) return role;
  }
  return "unknown";
}

/**
 * A process's role. `type` and `serviceName` are Electron's (app.getAppMetrics);
 * `windowRole` is the window a renderer hosts (main's own windows); `exe` is the
 * helper's exe name for a process Electron doesn't list.
 */
function resolveRole({ type, serviceName, name, windowRole, exe } = {}) {
  if (type === "Browser") return "main";
  if (type === "GPU") return "gpu";
  if (type === "Tab") return windowRole && ROLE_SPECS[windowRole] ? windowRole : "unknown";
  if (type === "Utility") {
    if (name === ONNX_WORKER_NAME) return "searchWorker";
    return SERVICE_ROLES[serviceName] ?? "unknown";
  }
  if (type) return "unknown";
  return roleForExe(exe);
}

/**
 * The group a role is shown in. An unknown renderer stays with the windows and
 * an unknown Chromium utility with the services.
 */
function groupFor(role, { type } = {}) {
  if (role === "unknown") {
    if (type === "Tab") return "windows";
    if (type === "Utility") return "services";
    if (type === "Browser" || type === "GPU") return "app";
    return "helpers";
  }
  return ROLE_SPECS[role]?.group ?? "helpers";
}

function variant(spec, params) {
  const picked = typeof spec === "function" ? spec(params) : null;
  if (!picked) return { variant: "default", params: {} };
  return { variant: picked[0], params: picked[1] ?? {} };
}

/**
 * The i18n keys that explain a process: its name, what it does, why it's
 * running and when it goes away, with the parameters the why and goes-away
 * texts take.
 */
function describeRole(role, params = {}, context = {}) {
  const id = ROLE_SPECS[role] ? role : "unknown";
  const spec = ROLE_SPECS[id];
  const base = `${KEY_PREFIX}.${id}`;
  const why = variant(spec.why, params ?? {});
  const goesAway = variant(spec.goesAway, params ?? {});
  return {
    role: id,
    group: groupFor(id, context),
    nameKey: `${base}.name`,
    whatKey: `${base}.what`,
    whyKey: `${base}.why.${why.variant}`,
    whyParams: why.params,
    goesAwayKey: `${base}.goesAway.${goesAway.variant}`,
    goesAwayParams: goesAway.params,
  };
}

/** "Not running now": the on-demand roles absent from `presentRoles`, with when each starts. */
function notRunningRoles(presentRoles) {
  const present = new Set(presentRoles);
  return ON_DEMAND_ROLES.filter((role) => !present.has(role)).map((role) => ({
    role,
    nameKey: `${KEY_PREFIX}.${role}.name`,
    startsKey: `${NOT_RUNNING_PREFIX}.${role}`,
  }));
}

module.exports = {
  GROUPS,
  HELPER_EXE_ROLES,
  KEY_PREFIX,
  NOT_RUNNING_PREFIX,
  ON_DEMAND_ROLES,
  ONNX_WORKER_NAME,
  ROLE_IDS,
  SERVICE_ROLES,
  describeRole,
  groupFor,
  notRunningRoles,
  resolveRole,
  roleForExe,
};
