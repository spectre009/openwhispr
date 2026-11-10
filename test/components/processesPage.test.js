const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");
const { describeRole, notRunningRoles } = require("../../src/helpers/processRoles");
const { buildReport } = require("../../src/helpers/processInventory");

// Settings › Data › Processes & resources (settings/ProcessesPage.tsx) and
// System › Diagnostics' processes row in happy-dom, with a stubbed preload
// standing in for main's process inventory: the tiles and their sums, the
// groups in order, sorting, an expanded row's panels and texts with their
// parameters, "—" with why and the one note off Windows, a failed helper,
// paused, the last recording with partial processes, the chart's text
// alternative, subscribing only while shown, the Diagnostics row and the
// search anchors.

const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 10, 10, 16, 5, 0);
const START = NOW - 27.6 * 3600 * 1000;
const MIN = 60 * 1000;

function proc(role, spec) {
  const {
    pid,
    type = null,
    exe = null,
    ws,
    priv = null,
    peak = null,
    cpuPct = 0,
    cpuSec = 1,
    gpuDedicated = 0,
    gpuUse = 0,
    handles = 100,
    gdi = 0,
    user = 0,
    threads = 10,
    createdAt = START,
    state = null,
    params = {},
  } = spec;
  const about = describeRole(role, params, { type });
  const uptime = (NOW - createdAt) / 1000;
  return {
    key: `${pid}:${createdAt}`,
    pid,
    ppid: null,
    createdAt,
    type,
    serviceName: null,
    name: null,
    exe,
    source: type ? "both" : "helper",
    role,
    group: about.group,
    about,
    windows: [],
    state,
    ws: ws === null ? null : ws * MB,
    priv: priv === null ? null : priv * MB,
    peak: peak === null ? null : peak * MB,
    cpuSec,
    cpuPct,
    cpuAvg: cpuSec === null ? null : Math.round(((100 * cpuSec) / uptime) * 100) / 100,
    handles,
    threads,
    gdi,
    user,
    gpuDedicated: gpuDedicated === null ? null : gpuDedicated * MB,
    gpuShared: gpuDedicated === null ? null : 0,
    gpuUse,
    errors: [],
  };
}

function processes() {
  return [
    proc("main", {
      pid: 13368,
      type: "Browser",
      exe: "OpenWhispr.exe",
      ws: 151,
      priv: 302,
      peak: 180,
      cpuPct: 0.4,
      cpuSec: 361,
      handles: 1103,
      gdi: 41,
      user: 60,
      threads: 49,
    }),
    proc("gpu", {
      pid: 4832,
      type: "GPU",
      exe: "OpenWhispr.exe",
      ws: 165,
      priv: 527,
      peak: 300,
      cpuPct: 0.3,
      cpuSec: 1375,
      gpuDedicated: 326,
      gpuUse: 1.5,
      handles: 1108,
      gdi: 13,
      user: 20,
      threads: 109,
    }),
    proc("controlPanel", {
      pid: 34724,
      type: "Tab",
      exe: "OpenWhispr.exe",
      ws: 136,
      priv: 148,
      cpuPct: 0,
      state: "hidden",
      params: { visible: false, hiddenSince: NOW - 90 * MIN },
    }),
    proc("dictationWindow", {
      pid: 29856,
      type: "Tab",
      exe: "OpenWhispr.exe",
      ws: 119,
      priv: 89,
      cpuPct: 0.2,
      cpuSec: 2572,
    }),
    proc("network", {
      pid: 4876,
      type: "Utility",
      exe: "OpenWhispr.exe",
      ws: 34,
      priv: 12,
      cpuPct: 0.04,
    }),
    proc("audio", { pid: 30276, type: "Utility", exe: "OpenWhispr.exe", ws: 53, priv: 11 }),
    proc("videoCapture", {
      pid: 30268,
      type: "Utility",
      exe: "OpenWhispr.exe",
      ws: 79,
      priv: 68,
      gpuDedicated: 16,
    }),
    proc("keyListener", {
      pid: 30168,
      exe: "windows-key-listener.exe",
      ws: 5,
      priv: 1,
      params: { hotkey: "Control+`" },
    }),
    proc("keyListener", {
      pid: 30176,
      exe: "windows-key-listener.exe",
      ws: 5,
      priv: 1,
      params: { hotkey: "Control+Alt+1" },
    }),
    proc("consoleHost", {
      pid: 30170,
      exe: "conhost.exe",
      ws: 7,
      priv: 2,
      cpuPct: null,
      cpuSec: 0.1,
      createdAt: NOW - 3000,
    }),
    proc("copilotRuntime", {
      pid: 92352,
      exe: "copilot-runtime.exe",
      ws: 116,
      priv: 122,
      state: "idle",
      createdAt: NOW - 25 * MIN,
      params: { busy: false, minutes: 6, stopsAt: NOW + 6 * MIN },
    }),
  ];
}

function totalsOf(rows) {
  const sum = (field) => {
    const values = rows.map((row) => row[field]).filter((value) => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    processes: rows.length,
    ws: sum("ws"),
    priv: sum("priv"),
    cpuPct: sum("cpuPct"),
    gpuDedicated: sum("gpuDedicated"),
    gpuShared: sum("gpuShared"),
  };
}

function snapshotOf(rows, extra = {}) {
  return {
    at: NOW,
    source: "stream",
    cpuIntervalSec: 2,
    gpuAt: NOW,
    processes: rows,
    totals: totalsOf(rows),
    machine: {
      gpuProcesses: 44,
      graphics: { mode: "hardware", reason: null, glRenderer: null },
      ramTotal: 64 * 1024 * MB,
      ramFree: 14 * 1024 * MB,
    },
    helper: { status: "ok", error: null, gpu: "ok", gpuError: null, engine: "ok" },
    notRunning: notRunningRoles(rows.map((row) => row.role)),
    ...extra,
  };
}

const ROWS = processes();
const key = (role, index = 0) => ROWS.filter((row) => row.role === role)[index].key;

const LAST_RECORDING = {
  at: NOW - 20 * MIN,
  inputKind: "dictation",
  strip: "frame",
  frameWindow: "new",
  recordingMs: 54000,
  processingMs: 1200,
  overlapped: false,
  processes: [
    {
      key: key("dictationWindow"),
      pid: 29856,
      role: "dictationWindow",
      recording: {
        key: key("dictationWindow"),
        pid: 29856,
        role: "dictationWindow",
        cpuPct: 21,
        partial: false,
        change: null,
      },
      processing: {
        key: key("dictationWindow"),
        pid: 29856,
        role: "dictationWindow",
        cpuPct: 5,
        partial: false,
        change: null,
      },
      gpuAfterDelivery: 0,
    },
    {
      key: key("gpu"),
      pid: 4832,
      role: "gpu",
      recording: {
        key: key("gpu"),
        pid: 4832,
        role: "gpu",
        cpuPct: 35,
        partial: false,
        change: null,
      },
      processing: {
        key: key("gpu"),
        pid: 4832,
        role: "gpu",
        cpuPct: 12,
        partial: false,
        change: null,
      },
      gpuAfterDelivery: 478 * MB,
    },
    {
      key: "3716:1",
      pid: 3716,
      role: "edgeStrip",
      recording: {
        key: "3716:1",
        pid: 3716,
        role: "edgeStrip",
        cpuPct: 3.2,
        partial: true,
        change: "appeared",
      },
      processing: {
        key: "3716:1",
        pid: 3716,
        role: "edgeStrip",
        cpuPct: 0.4,
        partial: false,
        change: null,
      },
      gpuAfterDelivery: null,
    },
    {
      key: "5555:1",
      pid: 5555,
      role: "textMonitor",
      recording: {
        key: "5555:1",
        pid: 5555,
        role: "textMonitor",
        cpuPct: null,
        partial: true,
        change: "exited",
      },
      processing: null,
      gpuAfterDelivery: null,
    },
  ],
  afterDelivery: { status: "ok", at: NOW - 19 * MIN, gpuProcesses: 45, gpuDedicated: 494 * MB },
};

// 24 hours in memory: two runs of 5-minute points with an hour's gap between them.
function historyOf() {
  const run1 = Array.from({ length: 25 }, (_, i) => NOW - 3 * 60 * MIN + i * 5 * MIN);
  const run2 = Array.from({ length: 8 }, (_, i) => NOW - 40 * MIN + i * 5 * MIN);
  const samples = [...run1, ...run2];
  const instance = (role, ws, cpu, extra = () => ({})) => ({
    key: key(role),
    role,
    group: ROWS.find((row) => row.role === role).group,
    pid: ROWS.find((row) => row.role === role).pid,
    createdAt: START,
    points: samples.map((at, index) => ({
      at,
      ws: ws * MB,
      priv: null,
      cpuPct: index === 0 || index === run1.length ? null : cpu,
      gpuDedicated: null,
      handles: null,
      gdi: null,
      user: null,
      ...extra(index),
    })),
  });
  return {
    maxAgeMs: 24 * 60 * MIN,
    samples,
    recordings: [
      { at: NOW - 20 * MIN, durationMs: 54000 },
      { at: NOW - 2 * 60 * MIN, durationMs: 3000 },
    ],
    instances: [
      instance("main", 150, 0.4, (index) => ({ handles: 1000 + index * 3 })),
      instance("gpu", 160, 0.3, (index) => ({ gpuDedicated: index % 6 === 0 ? 300 * MB : null })),
      instance("dictationWindow", 110, 0.2),
      instance("network", 30, 0.05),
    ],
  };
}

function sampleOf(extra = {}) {
  return {
    snapshot: snapshotOf(ROWS),
    lastRecording: LAST_RECORDING,
    unavailable: [],
    paused: false,
    streaming: true,
    ...extra,
  };
}

let subscribeAnswer = sampleOf();
let subscribeFails = false;
let getAnswer = null;
const listeners = new Set();
const clipboard = [];
let dom;
let vite;
let format;
const cleanups = [];

test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      subscribeProcessInventory: async () => {
        if (subscribeFails) throw new Error("no inventory");
        return subscribeAnswer;
      },
      unsubscribeProcessInventory: async () => ({ success: true }),
      getProcessInventory: async (options) => {
        const base = getAnswer ?? subscribeAnswer;
        return {
          ...base,
          history: options?.history === false ? null : historyOf(),
          report: base.snapshot ? buildReport(base.snapshot, NOW) : null,
        };
      },
      onProcessInventorySample: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      getLogInfo: async () => ({
        level: "warn",
        effectiveLevel: "warn",
        overriddenBy: null,
        retentionDays: 7,
        includeText: false,
        totalBytes: 9122611,
        fileCount: 72,
        currentFile: "debug.log",
        logsDir: "%USERPROFILE%\\logs",
        system: { platform: "win32", version: "10.0.26100", arch: "x64" },
      }),
      getRecentLogProblems: async () => [],
      writeClipboard: async (text) => {
        clipboard.push(text);
        return { success: true };
      },
    },
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vite = await createRendererServer(
    { after: (fn) => cleanups.push(fn) },
    { resolveAlias: { "@": path.resolve(__dirname, "../../src") } }
  );
  await vite.ssrLoadModule("/i18n.ts");
  format = await vite.ssrLoadModule("/components/settings/processInventoryFormat.ts");
});

test.after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await dom.close();
});

const captured = new WeakSet();

async function mount(t, modulePath, props = {}, { openSettings = null, visible = true } = {}) {
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  // React's warnings (invalid nesting, keys, act) fail the test.
  if (!captured.has(t)) {
    captured.add(t);
    const logs = captureConsole(t);
    t.after(() => assert.deepEqual(logs.errors, [], "console errors"));
  }
  const { default: Component } = await vite.ssrLoadModule(modulePath);
  const { SettingsLinkContext } = await vite.ssrLoadModule("/components/settings/settingsLink.ts");
  const { SettingsVisibleProvider } = await vite.ssrLoadModule(
    "/components/settings/useSettingsVisible.ts"
  );
  const doc = dom.window.document;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await React.act(async () => root.unmount());
    host.remove();
  };
  t.after(unmount);
  let current = { ...props };
  let currentVisible = visible;
  const render = (extra = {}, { visible: nextVisible } = {}) => {
    current = { ...current, ...extra };
    if (nextVisible !== undefined) currentVisible = nextVisible;
    return React.act(async () => {
      root.render(
        React.createElement(
          SettingsVisibleProvider,
          { value: currentVisible },
          React.createElement(
            SettingsLinkContext.Provider,
            { value: openSettings },
            React.createElement(Component, { showing: true, ...current })
          )
        )
      );
      await settle();
    });
  };
  await render();
  await React.act(async () => settle());
  const click = async (element) => {
    assert.ok(element, "element to click");
    await React.act(async () => {
      element.click();
      await settle();
    });
  };
  const broadcast = async (sample) => {
    await React.act(async () => {
      for (const listener of listeners) listener(sample);
      await settle();
    });
  };
  return { host, doc, render, click, broadcast, unmount, React };
}

const PAGE = "/components/settings/ProcessesPage.tsx";
const calls = (name) => dom.calls.filter(([called]) => called === name);
const text = (node) => node?.textContent.replace(/\s+/g, " ").trim();
const tile = (host, id) => host.querySelector(`[data-process-tile="${id}"]`);
const tileValue = (host, id) => text(tile(host, id).querySelector("[data-process-tile-value]"));
const bytes = (mb) => format.formatProcessBytes(mb * MB, "en");

/** The table's group ids and each group's rows (role:pid), in order. */
function tableGroups(host) {
  const groups = [];
  for (const tr of host.querySelectorAll("[data-process-table] tbody tr")) {
    const group = tr.getAttribute("data-process-group");
    if (group) groups.push({ group, rows: [] });
    else if (tr.hasAttribute("data-process-row")) {
      const row = ROWS.find((item) => item.key === tr.getAttribute("data-process-row"));
      groups.at(-1).rows.push(`${row.role}:${row.pid}`);
    } else if (tr.hasAttribute("data-process-not-running")) {
      groups.at(-1).rows.push(tr.getAttribute("data-process-not-running"));
    }
  }
  return groups;
}

const rowOf = (host, rowKey) => host.querySelector(`[data-process-row="${rowKey}"]`);
const cellOf = (host, rowKey, column) =>
  rowOf(host, rowKey).querySelector(`[data-process-cell="${column}"]`);
const dashReason = (node) =>
  node?.querySelector("[data-process-dash]")?.getAttribute("data-process-dash");

test("the tiles: in RAM by group, CPU now, graphics memory and the PC's graphics processes", async (t) => {
  subscribeAnswer = sampleOf();
  const { host } = await mount(t, PAGE);
  const totals = totalsOf(ROWS);
  assert.equal(tileValue(host, "memory"), format.formatProcessBytes(totals.ws, "en"));
  assert.deepEqual(
    [...host.querySelectorAll("[data-process-memory-segment]")].map((node) =>
      node.getAttribute("data-process-memory-segment")
    ),
    ["app", "windows", "services", "helpers"]
  );
  assert.equal(
    text(host.querySelector('[data-process-memory-legend="app"]')),
    `App${bytes(151 + 165)}`
  );
  assert.equal(
    text(tile(host, "memory").querySelector("[data-process-tile-subline]")),
    `11 processes · ${format.formatProcessBytes(totals.priv, "en")} committed`
  );
  assert.match(text(tile(host, "cpu")), /0\.9%\s*of one core/);
  assert.equal(tileValue(host, "graphics"), bytes(326 + 16));
  assert.equal(tileValue(host, "gpuProcesses"), "44");
  assert.match(text(tile(host, "gpuProcesses")), /processes holding graphics memory on this PC/);
  assert.equal(
    host.querySelector("[data-process-graphics-mode]").getAttribute("data-process-graphics-mode"),
    "hardware"
  );
  assert.equal(
    host.querySelector("[data-process-status]").getAttribute("data-process-status"),
    "live"
  );
});

test("groups in order (App, Windows, Chromium services, Helpers, Not running now), each by in RAM", async (t) => {
  subscribeAnswer = sampleOf();
  const { host } = await mount(t, PAGE);
  const groups = tableGroups(host);
  assert.deepEqual(
    groups.map((entry) => entry.group),
    ["app", "windows", "services", "helpers", "notRunning"]
  );
  assert.deepEqual(groups[0].rows, ["gpu:4832", "main:13368"]);
  assert.deepEqual(groups[1].rows, ["controlPanel:34724", "dictationWindow:29856"]);
  assert.deepEqual(groups[2].rows, ["videoCapture:30268", "audio:30276", "network:4876"]);
  // Two key listeners: one row each.
  assert.deepEqual(groups[3].rows, [
    "copilotRuntime:92352",
    "consoleHost:30170",
    "keyListener:30168",
    "keyListener:30176",
  ]);
  assert.ok(groups[4].rows.includes("whisperServer"));
  assert.ok(
    !groups[4].rows.includes("copilotRuntime"),
    "a running role isn't listed as not running"
  );
  assert.equal(
    text(host.querySelector('[data-process-not-running="whisperServer"]')),
    "Local Whisper serverStarts when you dictate with a local Whisper model."
  );
  // Names, the program and PID, the hotkey, the state.
  assert.match(
    text(rowOf(host, key("keyListener", 0))),
    /Key listener.*windows-key-listener\.exe · PID 30168 · Ctrl\+`/
  );
  assert.match(text(rowOf(host, key("controlPanel"))), /Control panel windowHidden/);
  assert.match(text(rowOf(host, key("copilotRuntime"))), /Stops in 6 min/);
  // Column headers: Started too; Committed and Graphics on Windows.
  assert.deepEqual(
    [...host.querySelectorAll("[data-process-column]")].map((node) =>
      node.getAttribute("data-process-column")
    ),
    ["process", "ws", "priv", "cpu", "gpu", "started"]
  );
});

test("sorting by in RAM, committed, CPU and graphics, with aria-sort", async (t) => {
  subscribeAnswer = sampleOf();
  const { host, click } = await mount(t, PAGE);
  const sortOf = (column) =>
    host.querySelector(`[data-process-column="${column}"]`).getAttribute("aria-sort");
  assert.equal(sortOf("ws"), "descending");
  assert.equal(sortOf("cpu"), "none");
  assert.equal(
    host.querySelector('[data-process-column="process"]').hasAttribute("aria-sort"),
    false
  );

  await click(host.querySelector('[data-process-sort="cpu"]'));
  assert.equal(sortOf("cpu"), "descending");
  assert.equal(sortOf("ws"), "none");
  let groups = tableGroups(host);
  assert.deepEqual(groups[0].rows, ["main:13368", "gpu:4832"]);
  assert.equal(groups[3].rows.at(-1), "consoleHost:30170", "an unavailable CPU sorts last");

  await click(host.querySelector('[data-process-sort="cpu"]'));
  assert.equal(sortOf("cpu"), "ascending");
  groups = tableGroups(host);
  assert.deepEqual(groups[0].rows, ["gpu:4832", "main:13368"]);
  assert.equal(groups[3].rows.at(-1), "consoleHost:30170", "still last ascending");

  await click(host.querySelector('[data-process-sort="gpu"]'));
  assert.equal(sortOf("gpu"), "descending");
  assert.deepEqual(tableGroups(host)[2].rows[0], "videoCapture:30268");

  await click(host.querySelector('[data-process-sort="priv"]'));
  assert.deepEqual(tableGroups(host)[0].rows, ["gpu:4832", "main:13368"]);
});

test("an expanded row: About with its parameters, three panels, the footer, Copy and the graphics link", async (t) => {
  subscribeAnswer = sampleOf();
  const opened = [];
  const { host, click } = await mount(t, PAGE, {}, { openSettings: (to) => opened.push(to) });
  const toggle = (rowKey) => host.querySelector(`[data-process-toggle="${rowKey}"]`);

  assert.equal(toggle(key("gpu")).getAttribute("aria-expanded"), "false");
  await click(toggle(key("gpu")));
  assert.equal(toggle(key("gpu")).getAttribute("aria-expanded"), "true");
  const details = host.querySelector(`[data-process-details="${key("gpu")}"]`);
  assert.equal(toggle(key("gpu")).getAttribute("aria-controls"), details.id);
  assert.deepEqual(
    [...details.querySelectorAll("[data-process-panel]")].map((node) =>
      node.getAttribute("data-process-panel")
    ),
    ["memory", "cpu", "objects"]
  );
  const value = (field) => text(details.querySelector(`[data-process-value="${field}"]`));
  assert.equal(value("ws"), bytes(165));
  assert.equal(value("priv"), bytes(527));
  assert.equal(value("peak"), bytes(300));
  assert.equal(value("gpuDedicated"), bytes(326));
  assert.equal(value("cpuPct"), "0.3%of one core");
  assert.equal(value("cpuRecording"), "35%");
  assert.equal(value("cpuSec"), format.formatProcessDuration(1375, "en"));
  assert.equal(value("gpuUse"), "1.5%");
  assert.equal(value("gdi"), "13of 10,000");
  assert.equal(value("user"), "20of 10,000");
  assert.equal(value("handles"), "1,108");
  assert.equal(value("threads"), "109");
  assert.match(
    text(details.querySelector("[data-process-about-what]")),
    /Draws every OpenWhispr window/
  );
  // Sparklines from the 24-hour history.
  assert.equal(details.querySelectorAll("[data-process-sparkline]").length, 2);
  // Jargon explained: the term carries its description and focus shows the tooltip.
  const term = details
    .querySelector('[data-process-value="ws"]')
    .previousElementSibling.querySelector("[data-process-term]");
  assert.equal(term.getAttribute("tabindex"), "0");
  const description = host.ownerDocument.getElementById(term.getAttribute("aria-describedby"));
  assert.match(description.textContent, /^Working set:/);
  const footer = text(details.querySelector("[data-process-footer]"));
  assert.match(footer, /PID 4832/);
  assert.match(footer, /GPU/);
  assert.match(footer, new RegExp(`Started ${format.formatProcessTime(START, "en", NOW)}`));
  assert.match(footer, /Running for 27\.6 hr/);

  await click(details.querySelector("[data-process-graphics-link]"));
  assert.deepEqual(opened, ["system#system.diagnostics.graphics"]);

  await click(details.querySelector(`[data-process-copy="${key("gpu")}"]`));
  const row = ROWS.find((item) => item.role === "gpu");
  assert.equal(clipboard.at(-1), format.processRowText(format.reportRowOf(row, NOW)));
  assert.match(clipboard.at(-1), /^Role\s+PID\s+In RAM/);
  assert.match(text(details.querySelector(`[data-process-copy="${key("gpu")}"]`)), /Copied/);

  // Why it's running, with the parameters main filled in.
  await click(toggle(key("controlPanel")));
  const panel = host.querySelector(`[data-process-details="${key("controlPanel")}"]`);
  assert.equal(
    text(panel.querySelector("[data-process-about-why]")),
    `Hidden since ${format.formatProcessTime(NOW - 90 * MIN, "en", NOW)}. Closing it only hides it, so it stays loaded.`
  );
  assert.equal(
    panel.querySelector("[data-process-graphics-link]"),
    null,
    "the link is the graphics row's"
  );
  await click(toggle(key("keyListener", 1)));
  assert.equal(
    text(
      host.querySelector(
        `[data-process-details="${key("keyListener", 1)}"] [data-process-about-why]`
      )
    ),
    "Your hotkey Ctrl+Alt+1 needs it: Hold, or a key Windows can't register on its own."
  );
  await click(toggle(key("copilotRuntime")));
  assert.equal(
    text(
      host.querySelector(
        `[data-process-details="${key("copilotRuntime")}"] [data-process-about-goes]`
      )
    ),
    "After 10 minutes without a request (in about 6 min)."
  );
  // Clicking the row (not just its button) toggles too.
  await click(rowOf(host, key("gpu")).querySelector('[data-process-cell="ws"]'));
  assert.equal(host.querySelector(`[data-process-details="${key("gpu")}"]`), null);
});

test("handles over the history and the leak note", async (t) => {
  subscribeAnswer = sampleOf();
  const { host, click } = await mount(t, PAGE);
  await click(host.querySelector(`[data-process-toggle="${key("main")}"]`));
  const note = text(
    host.querySelector(`[data-process-details="${key("main")}"] [data-process-leak-note]`)
  );
  assert.match(
    note,
    /^Handles went from 1,000 to 1,096 over 2\.9 hr\. A count that only grows points to a leak\.$/
  );
});

test("unavailable numbers show — with why; a first sample's CPU is never 0", async (t) => {
  subscribeAnswer = sampleOf();
  const { host, click } = await mount(t, PAGE);
  const cell = cellOf(host, key("consoleHost"), "cpu");
  assert.equal(dashReason(cell), "Not measured yet: CPU needs two samples.");
  assert.doesNotMatch(cell.textContent, /0%/);
  assert.match(cell.textContent, /—/);
  // An instance not in the last recording.
  await click(host.querySelector(`[data-process-toggle="${key("network")}"]`));
  assert.equal(
    dashReason(
      host.querySelector(
        `[data-process-details="${key("network")}"] [data-process-value="cpuRecording"]`
      )
    ),
    "This process wasn't running during the last recording."
  );
});

test("off Windows: one note, no Windows-only columns, tiles or panels, and no per-cell dashes for them", async (t) => {
  const rows = processes()
    .filter((row) => row.type)
    .map((row) => ({
      ...row,
      priv: null,
      handles: null,
      gdi: null,
      user: null,
      threads: null,
      gpuDedicated: null,
      gpuShared: null,
      gpuUse: null,
      exe: null,
    }));
  subscribeAnswer = sampleOf({
    snapshot: snapshotOf(rows, {
      helper: { status: "unsupported", error: null, gpu: "off", gpuError: null, engine: "off" },
      machine: { gpuProcesses: null, graphics: null, ramTotal: null, ramFree: null },
      notRunning: [],
    }),
    unavailable: ["windowsOnly"],
  });
  const { host, click } = await mount(t, PAGE);
  const notices = [...host.querySelectorAll("[data-process-notice]")];
  assert.deepEqual(
    notices.map((node) => node.getAttribute("data-process-notice")),
    ["windowsOnly"]
  );
  assert.match(
    text(notices[0]),
    /^Not available on this system: committed memory, graphics memory/
  );
  assert.deepEqual(
    [...host.querySelectorAll("[data-process-column]")].map((node) =>
      node.getAttribute("data-process-column")
    ),
    ["process", "ws", "cpu", "started"]
  );
  assert.equal(tile(host, "graphics"), null);
  assert.equal(tile(host, "gpuProcesses"), null);
  assert.equal(host.querySelector('[data-process-group="notRunning"]'), null);
  assert.doesNotMatch(text(tile(host, "memory")), /committed/);
  await click(host.querySelector(`[data-process-toggle="${key("gpu")}"]`));
  const details = host.querySelector(`[data-process-details="${key("gpu")}"]`);
  assert.deepEqual(
    [...details.querySelectorAll("[data-process-panel]")].map((node) =>
      node.getAttribute("data-process-panel")
    ),
    ["memory", "cpu"]
  );
  assert.equal(
    text(details.querySelector('[data-process-panel="cpu"] h4')),
    "CPU",
    "no graphics rows, so the panel isn't titled CPU & graphics"
  );
  for (const field of ["priv", "gpuDedicated", "gpuUse", "handles", "gdi"]) {
    assert.equal(details.querySelector(`[data-process-value="${field}"]`), null, field);
  }
  assert.equal(
    [...host.querySelectorAll("[data-process-dash]")].filter((node) =>
      /Not available on this system/.test(node.getAttribute("data-process-dash"))
    ).length,
    0,
    "no per-cell note"
  );
  // The last recording and the chart leave graphics memory out too.
  assert.equal(host.querySelector('[data-process-phase="gpu"]'), null);
  assert.equal(host.querySelector("[data-process-after-delivery]"), null);
  assert.ok(host.querySelector('[data-process-phase="recording"]'));
  assert.equal(host.querySelector('[data-process-history-metric="graphics"]'), null);
  assert.ok(host.querySelector('[data-process-history-metric="cpu"]'));
});

test("Linux: memory is unavailable, never 0", async (t) => {
  const rows = processes()
    .filter((row) => row.type)
    .map((row) => ({
      ...row,
      ws: null,
      priv: null,
      peak: null,
      exe: null,
      gpuDedicated: null,
      gpuShared: null,
      gpuUse: null,
      handles: null,
      gdi: null,
      user: null,
      threads: null,
    }));
  subscribeAnswer = sampleOf({
    snapshot: snapshotOf(rows, {
      helper: { status: "unsupported", error: null, gpu: "off", gpuError: null, engine: "off" },
      machine: { gpuProcesses: null, graphics: null, ramTotal: null, ramFree: null },
      notRunning: [],
    }),
    unavailable: ["windowsOnly", "memory"],
  });
  const { host } = await mount(t, PAGE);
  assert.deepEqual(
    [...host.querySelectorAll("[data-process-notice]")].map((node) =>
      node.getAttribute("data-process-notice")
    ),
    ["windowsOnly", "memory"]
  );
  assert.equal(dashReason(tile(host, "memory")), "This system doesn't report memory per process.");
  assert.doesNotMatch(tileValue(host, "memory"), /\b0\b/);
  assert.equal(host.querySelector("[data-process-memory-bar]"), null);
  assert.equal(
    dashReason(cellOf(host, key("main"), "ws")),
    "This system doesn't report memory per process."
  );
});

test("a failed helper: one notice with its code, Electron's numbers still shown", async (t) => {
  const rows = processes()
    .filter((row) => row.type)
    .map((row) => ({
      ...row,
      exe: null,
      source: "electron",
      handles: null,
      gdi: null,
      user: null,
      threads: null,
      gpuDedicated: null,
      gpuShared: null,
      gpuUse: null,
    }));
  subscribeAnswer = sampleOf({
    snapshot: snapshotOf(rows, {
      gpuAt: null,
      helper: { status: "failed", error: "timeout", gpu: "off", gpuError: null, engine: "off" },
      machine: {
        gpuProcesses: null,
        graphics: { mode: "hardware", reason: null, glRenderer: null },
        ramTotal: null,
        ramFree: null,
      },
      notRunning: [],
    }),
    unavailable: ["helperFailed"],
  });
  const { host, click } = await mount(t, PAGE);
  const notices = [...host.querySelectorAll("[data-process-notice]")];
  assert.equal(notices.length, 1);
  assert.match(
    text(notices[0]),
    /^The Windows helper stopped working.*The rest comes from Electron\.timeout$/
  );
  assert.equal(cellOf(host, key("main"), "ws").textContent.includes(bytes(151)), true);
  assert.equal(
    dashReason(cellOf(host, key("main"), "gpu")),
    "Read by the Windows helper, which isn't working."
  );
  assert.equal(
    dashReason(tile(host, "graphics")),
    "Read by the Windows helper, which isn't working."
  );
  await click(host.querySelector(`[data-process-toggle="${key("main")}"]`));
  assert.equal(
    dashReason(
      host.querySelector(`[data-process-details="${key("main")}"] [data-process-value="gdi"]`)
    ),
    "Read by the Windows helper, which isn't working."
  );
});

test("before the first sample: Measuring…, never zeros; a failed read says so", async (t) => {
  subscribeAnswer = {
    snapshot: null,
    lastRecording: null,
    unavailable: [],
    paused: false,
    streaming: true,
  };
  getAnswer = subscribeAnswer;
  t.after(() => {
    getAnswer = null;
  });
  const { host } = await mount(t, PAGE);
  assert.equal(
    host.querySelector("[data-process-status]").getAttribute("data-process-status"),
    "loading"
  );
  assert.match(text(host.querySelector("[data-process-status]")), /Measuring…/);
  assert.equal(host.querySelector("[data-process-tile]"), null);
  assert.equal(host.querySelector("[data-process-table]"), null);
  assert.doesNotMatch(text(host.querySelector('[data-setting-id="data.processes.summary"]')), /\d/);
  assert.equal(
    text(host.querySelector('[data-process-recording="none"]')),
    "No recording since OpenWhispr started."
  );

  subscribeFails = true;
  t.after(() => {
    subscribeFails = false;
  });
  const broken = await mount(t, PAGE);
  const status = broken.host.querySelector("[data-process-status]");
  assert.equal(status.getAttribute("data-process-status"), "failed");
  assert.equal(text(status), "Couldn't read OpenWhispr's processes.");
});

test("paused while dictating: says so and keeps the last sample", async (t) => {
  subscribeAnswer = sampleOf();
  const { host, broadcast } = await mount(t, PAGE);
  const before = tileValue(host, "memory");
  await broadcast({ ...sampleOf(), paused: true, streaming: false });
  const status = host.querySelector("[data-process-status]");
  assert.equal(status.getAttribute("data-process-status"), "paused");
  assert.match(text(status), /^Paused while you dictate/);
  assert.match(text(status), new RegExp(`numbers from ${format.formatProcessTime(NOW, "en")}`));
  assert.equal(tileValue(host, "memory"), before);
  assert.match(text(tile(host, "cpu")), /Paused while you dictate/);
  // An older snapshot crossing a newer one never takes the numbers back.
  const older = snapshotOf(
    processes().map((row) => ({ ...row, ws: 1 * MB })),
    { at: NOW - 60000 }
  );
  await broadcast({ ...sampleOf(), snapshot: older });
  assert.equal(tileValue(host, "memory"), before);
  // A new sample: live again.
  const newer = snapshotOf(
    processes().map((row) => ({ ...row, ws: 10 * MB })),
    { at: NOW + 2000 }
  );
  await broadcast({ ...sampleOf(), snapshot: newer });
  assert.equal(tileValue(host, "memory"), bytes(110));
  assert.equal(
    host.querySelector("[data-process-status]").getAttribute("data-process-status"),
    "live"
  );
});

test("the last recording: phases, partial processes, the edge strip and graphics memory after delivery", async (t) => {
  subscribeAnswer = sampleOf();
  const { host } = await mount(t, PAGE);
  const card = host.querySelector('[data-process-recording=""]');
  assert.equal(
    text(card.querySelector("[data-process-recording-facts]")),
    `${format.formatProcessTime(NOW - 20 * MIN, "en", NOW)} · 54 sec · Dictation`
  );
  assert.equal(
    text(card.querySelector("[data-process-recording-edge]")),
    "Screen edge: Full frame · its window opened for this recording"
  );
  const rows = [...card.querySelectorAll("[data-process-recording-row]")];
  assert.deepEqual(
    rows.map((row) => row.getAttribute("data-process-recording-row")),
    [key("gpu"), key("dictationWindow"), "3716:1", "5555:1"]
  );
  const phase = (row, name) => text(row.querySelector(`[data-process-phase="${name}"]`));
  assert.equal(phase(rows[0], "recording"), "35%");
  assert.equal(phase(rows[0], "processing"), "12%");
  assert.equal(phase(rows[0], "gpu"), bytes(478));
  assert.equal(phase(rows[1], "gpu"), "none");
  // The strip appeared during the recording: measured over its own life, marked partial.
  assert.equal(
    rows[2].querySelector("[data-process-partial]").getAttribute("data-process-partial"),
    "appeared"
  );
  assert.match(phase(rows[2], "recording"), /^3\.2%partial/);
  // The correction watcher exited: partial, no number (never 0).
  assert.equal(
    rows[3].querySelector("[data-process-partial]").getAttribute("data-process-partial"),
    "exited"
  );
  assert.equal(
    dashReason(rows[3].querySelector('[data-process-phase="recording"]')),
    "Exited during this phase, so it has no number."
  );
  assert.match(text(card.querySelector("thead")), /Processing and delivery \(1 sec\)/);
  assert.match(text(card.querySelector("[data-process-recording-total]")), /59%/);
  assert.equal(
    text(card.querySelector("[data-process-after-delivery]")),
    `Graphics memory was read at ${format.formatProcessTime(NOW - 19 * MIN, "en", NOW)}, after delivery: not a peak. 45 processes on this PC held graphics memory then.`
  );
});

test("the last recording: a processing phase under 0.2 s says it was too short, not unreadable", async (t) => {
  const processes = LAST_RECORDING.processes.map((row) => ({
    ...row,
    processing: row.processing ? { ...row.processing, cpuPct: null } : row.processing,
  }));
  subscribeAnswer = sampleOf({ lastRecording: { ...LAST_RECORDING, processingMs: 5, processes } });
  const { host } = await mount(t, PAGE);
  const card = host.querySelector('[data-process-recording=""]');
  const cells = [...card.querySelectorAll('[data-process-phase="processing"]')];
  assert.ok(cells.length > 0);
  for (const cell of cells) {
    assert.equal(dashReason(cell), "Too short to measure: under 0.2 seconds.");
  }
});

test("the 24-hour chart: stacked by group with gaps, recordings marked, its numbers in a table", async (t) => {
  subscribeAnswer = sampleOf();
  const { host, click } = await mount(t, PAGE);
  const figure = host.querySelector("[data-process-history]");
  assert.equal(figure.getAttribute("data-process-history"), "memory");
  // Two runs (an hour's gap) × four groups.
  assert.equal(figure.querySelectorAll("polygon").length, 8);
  assert.equal(figure.querySelectorAll("[data-process-history-recording]").length, 2);
  const table = figure.querySelector("[data-process-history-table]");
  assert.equal(text(table.querySelector("caption")), "Memory by group over the last 24 hours");
  const cells = (group) =>
    [...table.querySelectorAll(`[data-process-history-row="${group}"] td`)].map((cell) =>
      text(cell)
    );
  assert.deepEqual(cells("app"), [bytes(310), bytes(310), bytes(310)]);
  assert.deepEqual(cells("helpers"), ["0 kB", "0 kB", "0 kB"]);
  assert.deepEqual(cells("total"), [bytes(450), bytes(450), bytes(450)]);
  // The legend names only the groups that drew something: helpers held 0 here.
  assert.deepEqual(
    [...figure.querySelectorAll("[data-process-history-legend]")].map((node) =>
      node.getAttribute("data-process-history-legend")
    ),
    ["app", "windows", "services"]
  );
  assert.match(
    text(figure.querySelector("[data-process-history-summary]")),
    new RegExp(`^Highest ${bytes(450)} at`)
  );

  await click(host.querySelector('[data-process-history-metric="cpu"]'));
  assert.equal(
    host.querySelector('[data-process-history-metric="cpu"]').getAttribute("aria-pressed"),
    "true"
  );
  const cpu = host.querySelector("[data-process-history]");
  assert.equal(text(cpu.querySelector("caption")), "CPU by group over the last 24 hours");
  assert.deepEqual(
    [...cpu.querySelectorAll('[data-process-history-row="app"] td')].map((cell) => text(cell)),
    ["0.7%", "0.7%", "0.7%"]
  );

  await click(host.querySelector('[data-process-history-metric="graphics"]'));
  const graphics = host.querySelector("[data-process-history]");
  assert.deepEqual(
    [...graphics.querySelectorAll('[data-process-history-row="app"] td')].map((cell) => text(cell)),
    [bytes(300), bytes(300), bytes(300)]
  );
});

test("subscribes while shown and Settings is visible; unsubscribes on hide and unmount", async (t) => {
  subscribeAnswer = sampleOf();
  const count = (name) => calls(name).length;
  const before = {
    sub: count("subscribeProcessInventory"),
    unsub: count("unsubscribeProcessInventory"),
  };
  const page = await mount(t, PAGE, { showing: false });
  assert.equal(count("subscribeProcessInventory"), before.sub, "nothing while hidden");
  assert.equal(listeners.size, 0);

  await page.render({ showing: true });
  assert.equal(count("subscribeProcessInventory"), before.sub + 1);
  assert.equal(listeners.size, 1);
  assert.deepEqual(calls("getProcessInventory").at(-1)[1], [{ history: true }]);

  await page.render({ showing: false });
  assert.equal(count("unsubscribeProcessInventory"), before.unsub + 1);
  assert.equal(listeners.size, 0);
  assert.ok(page.host.querySelector("[data-process-tile]"), "the last numbers stay");

  await page.render({ showing: true });
  assert.equal(count("subscribeProcessInventory"), before.sub + 2);
  await page.render({}, { visible: false });
  assert.equal(count("unsubscribeProcessInventory"), before.unsub + 2, "Settings hidden");
  await page.render({}, { visible: true });
  assert.equal(count("subscribeProcessInventory"), before.sub + 3);

  await page.unmount();
  assert.equal(count("unsubscribeProcessInventory"), before.unsub + 3, "unmount");
  assert.equal(listeners.size, 0);
});

test("Copy as text copies Copy diagnostics' English table", async (t) => {
  subscribeAnswer = sampleOf();
  const { host, click } = await mount(t, PAGE);
  await click(host.querySelector("[data-process-copy-all]"));
  assert.deepEqual(calls("getProcessInventory").at(-1)[1], [{ history: false }]);
  const expected = format.processesText(buildReport(subscribeAnswer.snapshot, NOW)).join("\n");
  assert.equal(clipboard.at(-1), expected);
  assert.match(clipboard.at(-1), /^Processes: 11, sampled/);
  assert.match(text(host.querySelector("[data-process-copy-all]")), /Copied/);
});

test("System › Diagnostics: one processes row that opens Processes & resources", async (t) => {
  subscribeAnswer = sampleOf();
  const opened = [];
  const { host, click } = await mount(
    t,
    "/components/settings/DiagnosticsSection.tsx",
    {},
    { openSettings: (to) => opened.push(to) }
  );
  const row = host.querySelector('[data-setting-id="system.diagnostics.processes"]');
  const totals = totalsOf(ROWS);
  assert.equal(
    text(row.querySelector("[data-process-summary]")),
    `${format.formatProcessBytes(totals.ws, "en")} in RAM · 11 processes · ${bytes(342)} graphics memory`
  );
  assert.deepEqual(calls("getProcessInventory").at(-1)[1], [{ history: false }]);
  const button = [...row.querySelectorAll("button")].find((node) =>
    /Open Processes & resources/.test(node.textContent)
  );
  await click(button);
  assert.deepEqual(opened, ["processes"]);

  // Outside Settings there's no link; before the first sample it says so.
  getAnswer = {
    snapshot: null,
    lastRecording: null,
    unavailable: [],
    paused: false,
    streaming: false,
  };
  t.after(() => {
    getAnswer = null;
  });
  const bare = await mount(t, "/components/settings/DiagnosticsSection.tsx");
  const bareRow = bare.host.querySelector('[data-setting-id="system.diagnostics.processes"]');
  assert.equal(
    text(bareRow.querySelector("[data-process-summary]")),
    "Not measured yet: the first sample runs a minute after OpenWhispr starts."
  );
  assert.equal(bareRow.querySelector("button"), null);
});

test("search anchors: every data.processes.* descriptor lands on a rendered anchor", async (t) => {
  subscribeAnswer = sampleOf();
  const registry = await vite.ssrLoadModule("/components/settings/search/registry.ts");
  const { host } = await mount(t, PAGE);
  const ids = registry.SETTINGS_SEARCH_DESCRIPTORS.filter(
    (descriptor) => descriptor.location?.page === "processes" && descriptor.kind === "setting"
  ).map((descriptor) => descriptor.id);
  assert.deepEqual(ids.sort(), [
    "data.processes.copy",
    "data.processes.history",
    "data.processes.lastRecording",
    "data.processes.summary",
    "data.processes.table",
  ]);
  for (const id of ids) {
    assert.equal(host.querySelectorAll(`[data-setting-id="${id}"]`).length, 1, id);
  }
  const page = registry.SETTINGS_SEARCH_DESCRIPTORS.find(
    (descriptor) => descriptor.id === "page.processes"
  );
  for (const alias of ["processes", "memory", "ram", "cpu", "gpu", "task manager", "performance"]) {
    assert.ok(page.aliases.includes(alias), alias);
  }
  const all = registry.SETTINGS_SEARCH_DESCRIPTORS.filter(
    (descriptor) =>
      descriptor.id.startsWith("data.processes.") || descriptor.id === "page.processes"
  ).flatMap((descriptor) => descriptor.aliases ?? []);
  for (const alias of ["graphics", "handles", "gdi"]) assert.ok(all.includes(alias), alias);
  const diagnostics = registry.SETTINGS_SEARCH_DESCRIPTORS.find(
    (descriptor) => descriptor.id === "system.diagnostics.processes"
  );
  assert.equal(diagnostics.location.page, "system");
  assert.equal(diagnostics.summary, true);
});
