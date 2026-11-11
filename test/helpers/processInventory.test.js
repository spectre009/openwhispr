const test = require("node:test");
const assert = require("node:assert/strict");

const inv = require("../../src/helpers/processInventory");

// The process inventory's pure parts (helpers/processInventory.js): the
// helper's JSON validated, Electron's KiB in bytes, rows merged by (pid,
// creation time), CPU % of one core from cumulative seconds, the 24-hour
// history's expiry and gaps, a recording's phases, the warning thresholds and
// the allowlisted report the log and Copy diagnostics use.

const MB = 1024 * 1024;
const T0 = Date.UTC(2026, 10, 10, 8, 0, 0);

function helperLine(processes, extra = {}) {
  return JSON.stringify({
    v: 1,
    mode: "once",
    root: 100,
    self: 999,
    at: T0,
    gpu: { status: "off", error: null, processesWithDedicated: null, engine: "off" },
    pdhInitMs: null,
    processes,
    sampleMs: 12.3,
    selfCpuMs: 15.6,
    ...extra,
  });
}

const helperProcess = (fields) => ({
  pid: 100,
  ppid: 1,
  exe: "OpenWhispr.exe",
  createdAt: T0 - 3600_000,
  cpuSec: 10,
  ws: 100 * MB,
  priv: 200 * MB,
  peak: 150 * MB,
  handles: 1000,
  threads: 40,
  gdi: 40,
  user: 60,
  gpuDedicated: null,
  gpuShared: null,
  gpuUse: null,
  errors: [],
  ...fields,
});

const electronMetric = (fields) => ({
  pid: 100,
  type: "Browser",
  creationTime: T0 - 3600_000 + 0.42,
  cpu: { percentCPUUsage: 3, cumulativeCPUUsage: 10, idleWakeupsPerSecond: 0 },
  memory: { workingSetSize: 102400, peakWorkingSetSize: 153600, privateBytes: 204800 },
  ...fields,
});

test("helper output: numbers or null, exe names only, codes only, the helper itself excluded", () => {
  const parsed = inv.parseHelperOutput(
    helperLine([
      helperProcess({}),
      helperProcess({
        pid: 200,
        exe: "C:\\Users\\Dana\\AppData\\Local\\Programs\\OpenWhispr\\resources\\bin\\qdrant-win32-x64.exe",
        ws: -1,
        priv: "lots",
        handles: 1.5,
        gdi: null,
        errors: ["open_failed", "Access is denied.", "gdi_failed"],
      }),
      helperProcess({ pid: 999, exe: "windows-process-stats.exe" }),
      { pid: "x" },
      null,
    ])
  );
  assert.equal(parsed.ok, true);
  const [root, qdrant, ...rest] = parsed.sample.processes;
  assert.equal(rest.length, 0, "the helper and malformed entries are dropped");
  assert.equal(root.ws, 100 * MB);
  assert.equal(root.createdAt, T0 - 3600_000);
  assert.equal(qdrant.exe, "qdrant-win32-x64.exe", "a path becomes its file name");
  assert.equal(qdrant.ws, null);
  assert.equal(qdrant.priv, null);
  assert.equal(qdrant.handles, null);
  assert.equal(qdrant.gdi, null);
  assert.deepEqual(qdrant.errors, ["open_failed", "gdi_failed"], "free text never passes");
  assert.equal(parsed.sample.gpu.status, "off");

  assert.deepEqual(inv.parseHelperOutput('{"v":1,"mode":"once","error":"root_not_found"}'), {
    ok: false,
    error: "root_not_found",
  });
  assert.deepEqual(inv.parseHelperOutput('{"v":1,"error":"C:\\\\secret path failed"}'), {
    ok: false,
    error: "invalid_output",
  });
  assert.deepEqual(inv.parseHelperOutput("not json"), { ok: false, error: "invalid_output" });
  assert.deepEqual(inv.parseHelperOutput('{"v":2,"processes":[]}'), {
    ok: false,
    error: "invalid_output",
  });
  const gpu = inv.parseHelperOutput(
    helperLine([], { gpu: { status: "weird", error: "PDH said no", engine: "?" } })
  );
  assert.deepEqual(gpu.sample.gpu, {
    status: "failed",
    error: null,
    processesWithDedicated: null,
    engine: "off",
  });
});

test("Electron's metrics in bytes; missing or zero memory is null, never 0", () => {
  const [main, linux] = inv.normalizeElectronMetrics([
    electronMetric({}),
    electronMetric({ pid: 101, type: "Tab", memory: undefined, creationTime: undefined }),
    { pid: 0 },
    { pid: -3 },
  ]);
  assert.equal(main.ws, 102400 * 1024);
  assert.equal(main.peak, 153600 * 1024);
  assert.equal(main.priv, 204800 * 1024);
  assert.equal(main.cpuSec, 10);
  assert.equal(main.createdAt, T0 - 3600_000, "creation time floored to the helper's ms");
  assert.equal(linux.ws, null);
  assert.equal(linux.priv, null);
  assert.equal(linux.createdAt, null);
  const [zero] = inv.normalizeElectronMetrics([
    electronMetric({ memory: { workingSetSize: 0, privateBytes: 0 } }),
  ]);
  assert.equal(zero.ws, null);
  assert.equal(zero.priv, null);
  assert.deepEqual(inv.normalizeElectronMetrics(undefined), []);
});

test("merge: the helper enriches Electron's row for the same (pid, creation time), never duplicates it", () => {
  const electron = inv.normalizeElectronMetrics([
    electronMetric({}),
    electronMetric({ pid: 300, type: "GPU", creationTime: T0 - 3000_000 }),
  ]);
  const helper = inv.parseHelperOutput(
    helperLine([
      helperProcess({ ws: 1 }),
      helperProcess({ pid: 300, createdAt: T0 - 3000_000, gpuDedicated: 326 * MB, gdi: 12 }),
      helperProcess({ pid: 400, ppid: 100, exe: "windows-key-listener.exe", createdAt: T0 - 100 }),
    ])
  ).sample;
  const rows = inv.mergeProcesses({ electron, helper });
  assert.equal(rows.length, 3);
  const main = rows.find((row) => row.pid === 100);
  assert.equal(main.source, "both");
  assert.equal(main.ws, 102400 * 1024, "Electron's own reading is kept");
  assert.equal(main.handles, 1000, "the helper adds what Electron can't see");
  assert.equal(main.exe, "OpenWhispr.exe");
  assert.equal(main.key, `100:${T0 - 3600_000}`);
  const gpu = rows.find((row) => row.pid === 300);
  assert.equal(gpu.gpuDedicated, 326 * MB);
  assert.equal(gpu.gdi, 12);
  const key = rows.find((row) => row.pid === 400);
  assert.equal(key.source, "helper");
  assert.equal(key.type, null);
});

test("merge: a reused PID is another process; one exiting mid-sample keeps what was read", () => {
  const electron = inv.normalizeElectronMetrics([
    electronMetric({ pid: 500, type: "Tab", creationTime: T0 - 60_000 }),
    electronMetric({ pid: 600, type: "Tab", creationTime: T0 - 50_000 }),
  ]);
  const helper = inv.parseHelperOutput(
    helperLine([
      // pid 500 reused by a new process after the renderer Electron listed exited
      helperProcess({ pid: 500, createdAt: T0 - 1_000, exe: "ffmpeg.exe", handles: 50 }),
      // a process that exited after Electron's read but before the helper's
      helperProcess({ pid: 700, createdAt: T0 - 9_000, exe: "windows-text-monitor.exe" }),
    ])
  ).sample;
  const rows = inv.mergeProcesses({ electron, helper });
  const at500 = rows.filter((row) => row.pid === 500);
  assert.equal(at500.length, 2, "two processes, two keys");
  assert.notEqual(at500[0].key, at500[1].key);
  assert.equal(at500.find((row) => row.source === "electron").handles, null);
  assert.equal(at500.find((row) => row.source === "helper").handles, 50);
  const gone = rows.find((row) => row.pid === 600);
  assert.equal(gone.source, "electron", "listed by Electron, gone before the helper ran");
  assert.equal(gone.handles, null);
  assert.ok(rows.some((row) => row.pid === 700 && row.source === "helper"));
});

const round2 = (value) => Math.round(value * 100) / 100;

// Copilot's runtime (pid 200) and two key listeners (300, 310), each with its
// console host, plus a console host whose program isn't in the tree.
function consoleHostTree(overrides = {}) {
  const at = (offset) => T0 - 600_000 + offset;
  const electron = inv.normalizeElectronMetrics([electronMetric({})]);
  const helper = inv.parseHelperOutput(
    helperLine([
      helperProcess({}),
      helperProcess({
        pid: 200,
        ppid: 100,
        exe: "copilot-runtime.exe",
        createdAt: at(0),
        cpuSec: 4,
        ws: 119 * MB,
        priv: 123 * MB,
        peak: 130 * MB,
        handles: 400,
        threads: 20,
        gdi: 0,
        user: 0,
        gpuDedicated: 0,
        gpuShared: 2 * MB,
        gpuUse: 1.5,
        ...overrides[200],
      }),
      helperProcess({
        pid: 201,
        ppid: 200,
        exe: "conhost.exe",
        createdAt: at(30),
        cpuSec: 0.25,
        ws: 8.5 * MB,
        priv: 2 * MB,
        peak: 9 * MB,
        handles: 120,
        threads: 3,
        gdi: 4,
        user: 6,
        gpuDedicated: 0,
        gpuShared: 1 * MB,
        gpuUse: 0.5,
        ...overrides[201],
      }),
      helperProcess({
        pid: 300,
        ppid: 100,
        exe: "windows-key-listener.exe",
        createdAt: at(1000),
        ws: 5 * MB,
        priv: 1 * MB,
        handles: null,
        gdi: null,
        ...overrides[300],
      }),
      helperProcess({
        pid: 301,
        ppid: 300,
        exe: "conhost.exe",
        createdAt: at(1010),
        ws: 8 * MB,
        priv: null,
        handles: 50,
        gdi: null,
        ...overrides[301],
      }),
      helperProcess({
        pid: 310,
        ppid: 100,
        exe: "windows-key-listener.exe",
        createdAt: at(2000),
        ws: 5 * MB,
        ...overrides[310],
      }),
      helperProcess({
        pid: 311,
        ppid: 310,
        exe: "conhost.exe",
        createdAt: at(2005),
        ws: 7.5 * MB,
        ...overrides[311],
      }),
      // its program exited (the helper still listed it), so it's not in the tree
      helperProcess({ pid: 401, ppid: 400, exe: "conhost.exe", createdAt: at(3000) }),
    ])
  ).sample;
  return inv.mergeProcesses({ electron, helper });
}

test("console hosts fold into the program they serve, its numbers added; one without its program keeps its row", () => {
  const merged = consoleHostTree();
  const before = inv.computeTotals(merged);
  const rows = inv.annotateRows(inv.foldConsoleHosts(merged), {}, T0);
  assert.deepEqual(
    rows.map((row) => `${row.pid}:${row.role}`),
    ["100:main", "200:copilotRuntime", "300:keyListener", "310:keyListener", "401:consoleHost"]
  );

  const copilot = rows.find((row) => row.pid === 200);
  assert.equal(
    copilot.key,
    `200:${T0 - 600_000}`,
    "the program's identity, so its history continues"
  );
  assert.equal(copilot.exe, "copilot-runtime.exe");
  assert.equal(copilot.ws, 127.5 * MB);
  assert.equal(copilot.priv, 125 * MB);
  assert.equal(copilot.peak, 139 * MB);
  assert.equal(copilot.cpuSec, 4.25);
  assert.deepEqual([copilot.handles, copilot.threads, copilot.gdi, copilot.user], [520, 23, 4, 6]);
  assert.deepEqual(
    [copilot.gpuDedicated, copilot.gpuShared, copilot.gpuUse],
    [0, 3 * MB, 2],
    "graphics memory and use added too"
  );
  assert.deepEqual(
    copilot.includes.map((part) => [part.pid, part.exe, part.role, part.ws]),
    [
      [200, "copilot-runtime.exe", "copilotRuntime", 119 * MB],
      [201, "conhost.exe", "consoleHost", 8.5 * MB],
    ]
  );
  assert.equal(copilot.includes[1].createdAt, T0 - 600_000 + 30);
  assert.equal(copilot.includes[0].cpuAvg, round2((100 * 4) / 600));

  // Two key listeners, each with its own console host.
  const [first, second] = rows.filter((row) => row.role === "keyListener");
  assert.deepEqual(
    first.includes.map((part) => part.pid),
    [300, 301]
  );
  assert.deepEqual(
    second.includes.map((part) => part.pid),
    [310, 311]
  );
  assert.equal(second.ws, 12.5 * MB);

  // A null in either part: the known part's number; null only when neither is known.
  assert.equal(first.priv, 1 * MB, "the console host's committed is unknown");
  assert.equal(first.handles, 50, "the key listener's handles are unknown");
  assert.equal(first.gdi, null, "neither is known");

  const orphan = rows.find((row) => row.pid === 401);
  assert.equal(orphan.includes, undefined);
  assert.equal(orphan.about.nameKey, "settingsPage.processes.roles.consoleHost.name");

  const after = inv.computeTotals(rows);
  assert.deepEqual(after, before, "the same totals, every process counted");
  assert.equal(after.processes, 8);
});

test("a console host older than the process now at its parent's PID isn't folded into it", () => {
  const rows = inv.foldConsoleHosts(
    consoleHostTree({ 311: { createdAt: T0 - 600_000 + 2000 - 5000 } })
  );
  assert.ok(rows.some((row) => row.pid === 311 && row.includes === undefined));
  assert.deepEqual(
    rows.find((row) => row.pid === 310).includes,
    undefined,
    "nothing folded into the newer process"
  );
  assert.deepEqual(inv.foldConsoleHosts([]), []);
});

test("a folded row's CPU %: each part against its own last reading, added", () => {
  const tracker = inv.createCpuTracker();
  const sample = (parentSec, hostSec, { withHost = true } = {}) => {
    const rows = inv.foldConsoleHosts(
      consoleHostTree({
        200: { cpuSec: parentSec },
        201: { cpuSec: hostSec },
        ...(withHost ? {} : { 201: { ppid: 400 } }),
      })
    );
    return rows.find((row) => row.pid === 200);
  };
  const first = sample(4, 0.25, { withHost: false });
  tracker.apply([first], 0);
  assert.equal(first.includes, undefined, "no console host listed yet");

  // The console host appears: its whole CPU time isn't counted as this interval's.
  const second = sample(4.2, 0.25);
  tracker.apply([second], 2000);
  assert.equal(second.cpuPct, 10);
  assert.deepEqual(
    second.includes.map((part) => part.cpuPct),
    [10, null]
  );
  const third = sample(4.4, 0.27);
  tracker.apply([third], 4000);
  assert.equal(third.cpuPct, 11);
  // A part that can't be read: the other's alone, never a drop or a spike.
  const fourth = sample(4.6, null);
  tracker.apply([fourth], 6000);
  assert.equal(fourth.cpuPct, 10);
});

test("CPU % of one core from cumulative seconds; the first sample of an instance is unavailable", () => {
  assert.equal(inv.cpuPercent(null, { cpuSec: 5, mono: 1000 }), null);
  assert.equal(inv.cpuPercent({ cpuSec: 5, mono: 0 }, { cpuSec: 5.5, mono: 2000 }), 25);
  assert.equal(
    inv.cpuPercent({ cpuSec: 5, mono: 0 }, { cpuSec: 8, mono: 2000 }),
    150,
    "more than one core: over 100%"
  );
  assert.equal(inv.cpuPercent({ cpuSec: 5, mono: 0 }, { cpuSec: 4, mono: 2000 }), null);
  assert.equal(inv.cpuPercent({ cpuSec: 5, mono: 0 }, { cpuSec: 5.1, mono: 100 }), null);
  assert.equal(inv.cpuPercent({ cpuSec: null, mono: 0 }, { cpuSec: 5, mono: 2000 }), null);

  const tracker = inv.createCpuTracker();
  const rows = (cpuSec) => [
    { key: "1:1", cpuSec },
    { key: "2:2", cpuSec: null },
  ];
  const first = rows(10);
  assert.equal(tracker.apply(first, 0), null);
  assert.equal(first[0].cpuPct, null);
  const second = rows(10.4);
  assert.equal(tracker.apply(second, 2000), 2);
  assert.equal(second[0].cpuPct, 20);
  assert.equal(second[1].cpuPct, null);
  tracker.reset();
  const third = rows(11);
  tracker.apply(third, 4000);
  assert.equal(third[0].cpuPct, null, "after a reset, the first sample again");
});

test("history: points per instance, expired by age, gaps left as gaps", () => {
  const history = inv.createHistory();
  const HOUR = 3600_000;
  const row = (key, cpuSec, handles = 100) => ({
    key,
    pid: Number(key.split(":")[0]),
    createdAt: 1,
    role: "main",
    group: "app",
    ws: 10 * MB,
    priv: 20 * MB,
    cpuSec,
    gpuDedicated: 5 * MB,
    handles,
    gdi: 1,
    user: 2,
  });
  history.add([row("1:1", 100)], { at: T0, mono: 0 });
  history.add([row("1:1", 103), row("2:1", 1)], {
    at: T0 + 300_000,
    mono: 300_000,
    gpuFresh: false,
  });
  // the app slept for an hour: no CPU % across the gap
  history.add([row("1:1", 104)], { at: T0 + 2 * HOUR, mono: 2 * HOUR });
  let json = history.toJSON(T0 + 2 * HOUR);
  const main = json.instances.find((entry) => entry.key === "1:1");
  assert.deepEqual(
    main.points.map((point) => point.cpuPct),
    [null, 1, null]
  );
  assert.equal(main.points[1].gpuDedicated, null, "a sample without graphics memory stores none");
  assert.equal(main.points[0].gpuDedicated, 5 * MB);
  assert.ok(!("mono" in main.points[0]) && !("cpuSec" in main.points[0]));
  assert.deepEqual(json.samples, [T0, T0 + 300_000, T0 + 2 * HOUR]);
  assert.equal(history.pointBefore("1:1", T0 + HOUR).at, T0 + 300_000);
  assert.equal(history.pointBefore("1:1", T0 - 1), null);

  history.addRecording({ at: T0 + 2 * HOUR, durationMs: 5000 }, T0 + 2 * HOUR);
  json = history.toJSON(T0 + 24 * HOUR + 400_000);
  assert.deepEqual(
    json.instances.map((entry) => entry.key),
    ["1:1"],
    "an instance whose points all expired is gone"
  );
  assert.equal(json.instances[0].points.length, 1);
  assert.deepEqual(json.samples, [T0 + 2 * HOUR]);
  assert.equal(json.recordings.length, 1);
  json = history.toJSON(T0 + 27 * HOUR);
  assert.deepEqual(json.instances, []);
  assert.deepEqual(json.recordings, []);
});

test("recording phases: measured, appeared (partial, over its own life) and exited (partial, no number)", () => {
  const reading = (at, mono, rows) => ({ at, mono, rows });
  const r = (key, role, cpuSec, createdAt = 1) => ({
    key,
    pid: Number(key.split(":")[0]),
    role,
    cpuSec,
    createdAt,
  });
  const start = reading(T0, 0, [
    r("10:1", "dictationWindow", 100),
    r("11:1", "gpu", 50),
    r("12:1", "textMonitor", 1),
  ]);
  const stop = reading(T0 + 10_000, 10_000, [
    r("10:1", "dictationWindow", 102.1),
    r("11:1", "gpu", 53.5),
    r("13:9", "edgeStrip", 0.05, T0 + 5_000),
  ]);
  const usage = inv.phaseUsage(start, stop);
  const byKey = Object.fromEntries(usage.map((item) => [item.key, item]));
  assert.equal(byKey["10:1"].cpuPct, 21);
  assert.equal(byKey["11:1"].cpuPct, 35);
  assert.equal(byKey["10:1"].partial, false);
  assert.deepEqual(
    { cpuPct: byKey["13:9"].cpuPct, partial: byKey["13:9"].partial, change: byKey["13:9"].change },
    { cpuPct: 1, partial: true, change: "appeared" }
  );
  assert.deepEqual(
    { cpuPct: byKey["12:1"].cpuPct, partial: byKey["12:1"].partial, change: byKey["12:1"].change },
    { cpuPct: null, partial: true, change: "exited" }
  );
  assert.deepEqual(inv.cpuByRole(usage), { dictationWindow: 21, gpu: 35, edgeStrip: 1 });
  assert.equal(inv.frameWindowOf(stop, T0), "new");
  assert.equal(inv.frameWindowOf(stop, T0 + 9_000), "reused");
  assert.equal(inv.frameWindowOf(start, T0), "none");
});

test("warnings: GDI/USER over 5,000, handles up 50% over 6 hours, everything over 2 GB; once an hour each", () => {
  const lastWarned = new Map();
  const history = inv.createHistory();
  const sixHours = inv.HANDLE_GROWTH_WINDOW_MS;
  const base = (fields) => ({
    key: "1:1",
    pid: 1,
    role: "main",
    ws: 100 * MB,
    handles: 1000,
    gdi: 40,
    user: 60,
    ...fields,
  });
  history.add([base({})], { at: T0, mono: 0 });
  const later = T0 + sixHours + 60_000;
  const warnings = inv.evaluateWarnings({
    rows: [
      base({ handles: 1600, gdi: 5001 }),
      {
        key: "2:2",
        pid: 2,
        role: "dictationWindow",
        ws: 2100 * MB,
        handles: null,
        gdi: 0,
        user: 7000,
      },
    ],
    history,
    lastWarned,
    now: later,
  });
  assert.deepEqual(warnings.map((warning) => warning.kind).sort(), [
    "gdiObjects",
    "handleGrowth",
    "totalMemory",
    "userObjects",
  ]);
  const growth = warnings.find((warning) => warning.kind === "handleGrowth");
  assert.deepEqual(growth, {
    kind: "handleGrowth",
    role: "main",
    pid: 1,
    handles: 1600,
    handlesBefore: 1000,
    hours: 6,
  });
  const again = inv.evaluateWarnings({
    rows: [base({ handles: 1600, gdi: 5001 })],
    history,
    lastWarned,
    now: later + 30 * 60_000,
  });
  assert.deepEqual(again, [], "not again within the hour");
  const hourLater = inv.evaluateWarnings({
    rows: [base({ handles: 1600, gdi: 5001 })],
    history,
    lastWarned,
    now: later + 61 * 60_000,
  });
  assert.deepEqual(hourLater.map((warning) => warning.kind).sort(), ["gdiObjects", "handleGrowth"]);
  const quiet = inv.evaluateWarnings({
    rows: [base({ handles: 1150, gdi: 5000, user: 4999 })],
    history,
    lastWarned: new Map(),
    now: later,
  });
  assert.deepEqual(quiet, [], "at the thresholds, and +15% handles, nothing");
  const small = inv.evaluateWarnings({
    rows: [base({ key: "3:3", handles: 90 })],
    history: (() => {
      const h = inv.createHistory();
      h.add([base({ key: "3:3", handles: 50 })], { at: T0, mono: 0 });
      return h;
    })(),
    lastWarned: new Map(),
    now: later,
  });
  assert.deepEqual(small, [], "+80% but only 40 handles: no leak worth a warning");
});

test("the report and the log line carry roles and numbers only", () => {
  const electron = inv.normalizeElectronMetrics([
    electronMetric({}),
    electronMetric({
      pid: 300,
      type: "Utility",
      serviceName: "network.mojom.NetworkService",
      creationTime: T0 - 10,
    }),
  ]);
  const helper = inv.parseHelperOutput(
    helperLine([
      helperProcess({}),
      helperProcess({ pid: 400, exe: "zqxprivateprogram.exe", createdAt: T0 - 5 }),
    ])
  ).sample;
  const rows = inv.annotateRows(inv.mergeProcesses({ electron, helper }), {}, T0);
  const snapshot = {
    at: T0,
    source: "once",
    cpuIntervalSec: 300,
    gpuAt: null,
    processes: rows,
    machine: {
      gpuProcesses: 44,
      graphics: { mode: "hardware", reason: null, glRenderer: "ANGLE x" },
    },
    helper: { status: "ok", error: null },
  };
  const report = inv.buildReport(snapshot, T0 + 5000);
  assert.equal(report.ageSec, 5);
  assert.deepEqual(
    report.processes.map((row) => row.role),
    ["main", "network", "unknown"]
  );
  assert.deepEqual(Object.keys(report.processes[0]).sort(), [
    "cpuAvg",
    "cpuPct",
    "cpuSec",
    "gdi",
    "gpuDedicated",
    "gpuShared",
    "gpuUse",
    "group",
    "handles",
    "peak",
    "pid",
    "priv",
    "role",
    "threads",
    "uptimeSec",
    "user",
    "ws",
  ]);
  const line = JSON.stringify(inv.snapshotLogMeta(report));
  assert.doesNotMatch(line, /zqxprivateprogram|OpenWhispr\.exe|NetworkService|ANGLE/);
  const meta = JSON.parse(line);
  assert.equal(meta.graphics, "hardware");
  assert.equal(meta.gpuProcesses, 44);
  assert.equal(meta.roles[0].wsMB, 100);
  assert.equal(meta.roles[0].cpuAvg, 0.3);
});

test("a folded row's parts go into the report by role; the log line keeps its shape and its allowlist", () => {
  const snapshotOf = (rows) => ({
    at: T0,
    source: "once",
    cpuIntervalSec: 300,
    gpuAt: null,
    processes: inv.annotateRows(rows, {}, T0),
    machine: { gpuProcesses: 44, graphics: { mode: "hardware", reason: null } },
    helper: { status: "ok", error: null },
  });
  const plain = inv.buildReport(snapshotOf(consoleHostTree()), T0);
  const report = inv.buildReport(snapshotOf(inv.foldConsoleHosts(consoleHostTree())), T0);

  const copilot = report.processes.find((row) => row.role === "copilotRuntime");
  assert.deepEqual(
    copilot.includes.map((part) => [part.role, part.pid, part.ws, part.priv]),
    [
      ["copilotRuntime", 200, 119 * MB, 123 * MB],
      ["consoleHost", 201, 8.5 * MB, 2 * MB],
    ]
  );
  assert.deepEqual(
    Object.keys(copilot.includes[1]).sort(),
    Object.keys(plain.processes[0]).sort(),
    "each part is a report row: roles, PIDs and numbers only"
  );
  assert.equal(
    report.processes.find((row) => row.role === "main").includes,
    undefined,
    "a row with nothing folded in is as before"
  );
  assert.deepEqual(report.totals, plain.totals);

  const line = JSON.stringify(inv.snapshotLogMeta(report));
  assert.doesNotMatch(line, /conhost|copilot-runtime|windows-key-listener|\.exe|includes/);
  const meta = JSON.parse(line);
  const before = inv.snapshotLogMeta(plain);
  assert.deepEqual(Object.keys(meta), Object.keys(before));
  assert.deepEqual(Object.keys(meta.roles[1]), Object.keys(before.roles[1]));
  assert.deepEqual(
    meta.roles.map((row) => row.role),
    ["main", "copilotRuntime", "keyListener", "keyListener", "consoleHost"]
  );
  assert.equal(meta.roles[1].wsMB, 127.5);
  assert.equal(meta.processes, 8, "every process counted");
});

test("window roles: each of main's windows by its renderer's PID, the dictation window first", () => {
  const { EventEmitter } = require("node:events");
  const win = (pid, { visible = true, destroyed = false } = {}) => {
    const w = new EventEmitter();
    w.isDestroyed = () => destroyed;
    w.isVisible = () => visible;
    w.webContents = { getOSProcessId: () => pid };
    return w;
  };
  const panel = win(20, { visible: false });
  const visibility = { get: (w) => (w === panel ? { visible: false, since: T0 - 60_000 } : null) };
  const roles = inv.collectWindowRoles({
    windowManager: {
      mainWindow: win(10),
      controlPanelWindow: panel,
      agentWindow: { window: win(0) },
      notificationWindow: win(30, { destroyed: true }),
      permissionGuide: { window: null },
      recordingEdgeStrip: {
        listWindows: () => [
          { window: win(40), mode: "frame" },
          { window: win(10), mode: "short" },
        ],
      },
    },
    visibility,
  });
  assert.deepEqual([...roles.keys()].sort(), [10, 20, 40]);
  assert.deepEqual(
    roles.get(10).map((info) => info.role),
    ["dictationWindow", "edgeStrip"],
    "a renderer two windows share keeps both, the dictation window first"
  );
  assert.deepEqual(roles.get(20), [{ role: "controlPanel", visible: false, since: T0 - 60_000 }]);
  assert.equal(roles.get(40)[0].mode, "frame");
  assert.deepEqual(inv.collectWindowRoles({}), new Map());

  const rows = inv.annotateRows(
    inv.mergeProcesses({
      electron: inv.normalizeElectronMetrics([
        electronMetric({ pid: 20, type: "Tab", creationTime: T0 - 100_000 }),
        electronMetric({ pid: 40, type: "Tab", creationTime: T0 - 1_000 }),
      ]),
      helper: inv.parseHelperOutput(
        helperLine([
          helperProcess({ pid: 50, exe: "windows-key-listener.exe", createdAt: T0 - 9_000 }),
          helperProcess({ pid: 60, exe: "copilot-runtime.exe", createdAt: T0 - 9_000 }),
        ])
      ).sample,
    }),
    {
      windows: roles,
      recording: false,
      keyListeners: new Map([[50, "Control+`"]]),
      copilot: { activeRequests: 0, idleStopAt: T0 + 5.5 * 60_000 },
    },
    T0
  );
  const byRole = Object.fromEntries(rows.map((row) => [row.role, row]));
  assert.equal(byRole.controlPanel.state, "hidden");
  assert.deepEqual(byRole.controlPanel.about.whyParams, { since: T0 - 60_000 });
  assert.equal(byRole.edgeStrip.about.whyKey, "settingsPage.processes.roles.edgeStrip.why.kept");
  assert.deepEqual(byRole.edgeStrip.about.goesAwayParams, { seconds: 30 });
  assert.deepEqual(byRole.keyListener.about.whyParams, { hotkey: "Control+`" });
  assert.equal(byRole.copilotRuntime.state, "idle");
  assert.deepEqual(byRole.copilotRuntime.about.goesAwayParams, {
    minutes: 6,
    stopsAt: T0 + 5.5 * 60_000,
  });
  assert.equal(byRole.keyListener.group, "helpers");
  assert.equal(byRole.controlPanel.group, "windows");
});

test("window visibility: since its creation, then since each show or hide", () => {
  const { EventEmitter } = require("node:events");
  let clock = T0;
  const app = new EventEmitter();
  const tracker = inv.createWindowVisibilityTracker({ app, now: () => clock });
  const w = new EventEmitter();
  w.isVisible = () => false;
  app.emit("browser-window-created", {}, w);
  assert.deepEqual(tracker.get(w), { visible: false, since: T0 });
  clock += 5_000;
  w.emit("show");
  assert.deepEqual(tracker.get(w), { visible: true, since: T0 + 5_000 });
  clock += 5_000;
  w.emit("show");
  assert.equal(tracker.get(w).since, T0 + 5_000, "a repeated show changes nothing");
  clock += 5_000;
  w.emit("hide");
  assert.deepEqual(tracker.get(w), { visible: false, since: T0 + 15_000 });
  assert.equal(tracker.get({}), null);
});
