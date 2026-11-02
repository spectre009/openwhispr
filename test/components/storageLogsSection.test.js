const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, settle } = require("../lib/settingsDomHarness");

// Storage › Logs (settings/LogsSection.tsx) and System › Diagnostics
// (settings/DiagnosticsSection.tsx) in happy-dom, with a stubbed preload standing
// in for main's log IPC: the three levels and an override's note, retention and
// dictated text saved as one setting each, recent problems folded, Clear logs
// asking first and reporting what it kept, Copy diagnostics previewing exactly
// what it copies, nothing read while the page is hidden, and the graphics row:
// a warning with Restart for a software fallback, a note for a launch flag's.

const HOUR = 3600 * 1000;
const NOW = Date.now();
const iso = (ago) => new Date(NOW - ago).toISOString();

const INFO = {
  level: "warn",
  effectiveLevel: "warn",
  overriddenBy: null,
  retentionDays: 7,
  includeText: false,
  totalBytes: 9122611,
  fileCount: 72,
  currentFile: "debug-2026-10-25T15-02-11-123Z.log",
  logsDir: "%USERPROFILE%\\AppData\\Roaming\\open-whispr\\logs",
  system: { platform: "win32", version: "10.0.26100", arch: "x64" },
};

const PROBLEMS = [
  { time: iso(1000), level: "warn", area: "transcription", message: "Speech-to-text retried" },
  { time: iso(2000), level: "error", area: "clipboard", message: "Paste held back" },
  { time: iso(3000), level: "warn", area: "transcription", message: "Slow response" },
  { time: iso(4000), level: "fatal", area: null, message: "Renderer crashed" },
  { time: iso(48 * HOUR), level: "warn", area: "copilot", message: "Model list refresh failed" },
];

const BUILD = {
  version: "1.10.3",
  builtAt: "2026-10-25T07:45:00.000Z",
  commit: "616ead3b0d8d4c1e9f2a3b4c5d6e7f8091a2b3c4",
  dirty: false,
  source: "selfhost",
  commitSubject: null,
  channel: "selfhost-stable",
  startedAt: "2026-10-25T15:02:00.000Z",
  uptimeSec: 3600,
  exePath: "%USERPROFILE%\\AppData\\Local\\Programs\\OpenWhispr\\OpenWhispr.exe",
  electron: "41.0.0",
  chrome: "146.0.7680.31",
  node: "24.11.1",
};

let info = INFO;
let problems = PROBLEMS;
let clearResult = { deleted: 72, failed: [] };
let rejectSave = false;
let relaunches = 0;
const graphicsListeners = new Set();
const saved = [];
const clipboard = [];
let dom;
let vite;
const cleanups = [];

test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      getLogInfo: async () => info,
      getRecentLogProblems: async () => problems,
      setLogSettings: async (update) => {
        if (rejectSave) throw new Error("Invalid log level");
        saved.push(update);
        info = { ...info, ...update };
        return info;
      },
      clearLogs: async () => clearResult,
      openLogsFolder: async () => ({ success: true }),
      getBuildInfo: async () => BUILD,
      writeClipboard: async (text) => {
        clipboard.push(text);
        return { success: true };
      },
      relaunchApp: async () => {
        relaunches += 1;
      },
      onGraphicsModeChanged: (callback) => {
        graphicsListeners.add(callback);
        return () => graphicsListeners.delete(callback);
      },
    },
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vite = await createRendererServer(
    { after: (fn) => cleanups.push(fn) },
    { resolveAlias: { "@": path.resolve(__dirname, "../../src") } }
  );
  await vite.ssrLoadModule("/i18n.ts");
});

test.after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await dom.close();
});

const buttonLabel = (button) =>
  [...button.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent)
    .join("");

async function mount(t, modulePath, props = {}, { openSettings = null } = {}) {
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const { default: Component } = await vite.ssrLoadModule(modulePath);
  const { SettingsLinkContext } = await vite.ssrLoadModule("/components/settings/settingsLink.ts");
  const doc = dom.window.document;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  const render = (extra = {}) =>
    React.act(async () => {
      root.render(
        React.createElement(
          SettingsLinkContext.Provider,
          { value: openSettings },
          React.createElement(Component, { showing: true, ...props, ...extra })
        )
      );
      await settle();
    });
  await render();
  await React.act(async () => settle());
  const click = async (element) => {
    await React.act(async () => {
      element.click();
      await settle();
    });
  };
  const button = (label, scope = doc.body) =>
    [...scope.querySelectorAll("button")].find((candidate) => buttonLabel(candidate) === label);
  return { host, doc, render, click, button, React };
}

const row = (host, id) => host.querySelector(`[data-setting-id="${id}"]`);

async function choose(React, select, value) {
  await React.act(async () => {
    select.value = String(value);
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
  });
}

test("What to log offers Off, Problems only and Everything, and saves the one picked", async (t) => {
  info = INFO;
  saved.length = 0;
  const { host, React } = await mount(t, "/components/settings/LogsSection.tsx");
  const select = row(host, "system.developer.debug").querySelector("select");
  assert.deepEqual(
    [...select.options].map((option) => [option.value, option.textContent]),
    [
      ["off", "Off"],
      ["warn", "Problems only"],
      ["debug", "Everything (debug)"],
    ]
  );
  assert.equal(select.value, "warn");
  assert.equal(host.querySelector("[data-log-override]"), null, "no override, no note");

  await choose(React, select, "debug");
  assert.deepEqual(saved, [{ level: "debug" }], "only the level is sent");

  const retention = row(host, "storage.logs.retention").querySelector("select");
  assert.deepEqual(
    [...retention.options].map((option) => option.textContent),
    ["7 days", "14 days", "30 days", "90 days"]
  );
  await choose(React, retention, 30);
  assert.deepEqual(saved[1], { retentionDays: 30 });

  const toggle = row(host, "storage.logs.text").querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  await React.act(async () => {
    toggle.click();
    await settle();
  });
  assert.deepEqual(saved[2], { includeText: true });
});

test("an override says what's in force and why, and the control stays usable", async (t) => {
  info = { ...INFO, level: "warn", effectiveLevel: "debug", overriddenBy: "flag" };
  const flag = await mount(t, "/components/settings/LogsSection.tsx");
  const note = flag.host.querySelector('[data-log-override="flag"]');
  assert.ok(note, "a note under the level");
  assert.equal(
    note.textContent,
    "In force: Everything (debug), set by --log-level. It wins over this setting until it's removed."
  );
  assert.equal(note.querySelector("bdi").getAttribute("dir"), "ltr");
  assert.equal(row(flag.host, "system.developer.debug").querySelector("select").disabled, false);

  info = { ...INFO, level: "off", effectiveLevel: "info", overriddenBy: "env" };
  const env = await mount(t, "/components/settings/LogsSection.tsx");
  assert.equal(
    env.host.querySelector('[data-log-override="env"]').textContent,
    "In force: info, set by the OPENWHISPR_LOG_LEVEL environment variable. It wins over this setting until it's removed."
  );

  // An override that agrees with the setting needs no note.
  info = { ...INFO, level: "debug", effectiveLevel: "debug", overriddenBy: "env" };
  const same = await mount(t, "/components/settings/LogsSection.tsx");
  assert.equal(same.host.querySelector("[data-log-override]"), null);
  info = INFO;
});

test("the size, the folder and the current file; recent problems fold to three", async (t) => {
  info = INFO;
  problems = PROBLEMS;
  const { host, button, click } = await mount(t, "/components/settings/LogsSection.tsx");
  assert.match(host.querySelector("h3").textContent, /^Logs8\.7 MB · 72 files$/);
  const folder = row(host, "system.developer.logs");
  assert.match(folder.textContent, /8\.7 MB · 72 files/);
  const dir = [...folder.querySelectorAll("span")].find(
    (span) => span.textContent === INFO.logsDir
  );
  assert.equal(dir.getAttribute("dir"), "ltr");
  assert.match(folder.textContent, /Current file: debug-2026-10-25T15-02-11-123Z\.log/);

  const listed = () => [...host.querySelectorAll("[data-log-problem]")];
  assert.equal(listed().length, 3);
  assert.deepEqual(
    listed().map((item) => item.getAttribute("data-log-problem")),
    ["warn", "error", "warn"]
  );
  assert.match(listed()[1].textContent, /Error.*clipboard.*Paste held back/);
  const showAll = button("Show all (5)");
  assert.ok(showAll, "Show all names how many");
  await click(showAll);
  assert.equal(listed().length, 5);
  assert.match(listed()[3].textContent, /Fatal.*app.*Renderer crashed/);
  await click(button("Show less"));
  assert.equal(listed().length, 3);

  problems = [];
  const empty = await mount(t, "/components/settings/LogsSection.tsx");
  assert.match(
    row(empty.host, "storage.logs.problems").textContent,
    /No warnings or errors in the logs\./
  );
  assert.equal(empty.host.querySelectorAll("[data-log-problem]").length, 0);
  problems = PROBLEMS;
});

test("Clear logs asks first, then reports a file it couldn't delete", async (t) => {
  info = INFO;
  const calls = dom.calls;
  const { host, doc, button, click } = await mount(t, "/components/settings/LogsSection.tsx");
  const clearButton = row(host, "storage.logs.clear").querySelector("button");
  const before = calls.filter(([name]) => name === "clearLogs").length;

  await click(clearButton);
  const dialog = doc.querySelector('[role="dialog"]');
  assert.ok(dialog, "a confirmation first");
  assert.match(dialog.textContent, /Clear logs\?/);
  assert.equal(calls.filter(([name]) => name === "clearLogs").length, before, "nothing yet");

  clearResult = { deleted: 70, failed: ["debug-a.log", "debug-b.log"] };
  await click(button("Clear logs", dialog));
  assert.equal(calls.filter(([name]) => name === "clearLogs").length, before + 1);
  const notice = host.querySelector('[data-log-notice="error"]');
  assert.equal(
    notice.textContent,
    "Some files are in use by another OpenWhispr and were kept: debug-a.log, debug-b.log"
  );
  clearResult = { deleted: 72, failed: [] };
});

test("Copy diagnostics shows exactly what it copies: no user name, no log lines", async (t) => {
  info = { ...INFO, level: "warn", effectiveLevel: "debug", overriddenBy: "env" };
  problems = PROBLEMS;
  clipboard.length = 0;
  const { host, doc, button, click } = await mount(t, "/components/settings/LogsSection.tsx");
  await click(row(host, "storage.logs.diagnostics").querySelector("button"));
  const preview = doc.querySelector("[data-diagnostics-preview]");
  assert.ok(preview, "the dialog previews the text");
  assert.equal(preview.getAttribute("dir"), "ltr");
  const text = preview.textContent;
  const lines = text.split("\n");
  assert.equal(lines[0], "OpenWhispr diagnostics");
  assert.ok(lines.includes("OpenWhispr 1.10.3"), "build info");
  assert.ok(lines.includes("OS: Windows 10.0.26100 (x64)"));
  assert.ok(
    lines.includes(
      "Log level: Everything (debug), set by the OPENWHISPR_LOG_LEVEL environment variable (the setting is Problems only (warnings and errors))"
    )
  );
  assert.ok(lines.includes("Keep logs for: 7 days"));
  assert.ok(lines.includes("Include dictated text: off"));
  assert.ok(lines.includes(`Logs folder: ${INFO.logsDir}`));
  assert.ok(lines.includes("Log size: 8.7 MB in 72 files"));
  assert.ok(lines.includes("Recent problems: 2 errors, 3 warnings"));
  assert.deepEqual(lines.slice(-4), [
    "  transcription: 2",
    "  app: 1",
    "  clipboard: 1",
    "  copilot: 1",
  ]);
  for (const message of PROBLEMS.map((problem) => problem.message)) {
    assert.ok(!text.includes(message), `no log line: ${message}`);
  }
  assert.doesNotMatch(text, /\\Users\\/i, "no user name");

  await click(button("Copy", doc.querySelector('[role="dialog"]')));
  assert.equal(clipboard.length, 1);
  assert.equal(clipboard[0], text);
  info = INFO;
});

test("a hidden page reads nothing until it shows", async (t) => {
  info = INFO;
  const calls = dom.calls;
  const before = calls.filter(([name]) => name === "getLogInfo").length;
  const page = await mount(t, "/components/settings/LogsSection.tsx", { showing: false });
  assert.equal(calls.filter(([name]) => name === "getLogInfo").length, before);
  assert.equal(row(page.host, "system.developer.debug").querySelector("select").disabled, true);
  await page.render({ showing: true });
  await page.React.act(async () => settle());
  assert.equal(calls.filter(([name]) => name === "getLogInfo").length, before + 1);
});

test("System › Diagnostics sums the log up in a line and links to Storage › Logs", async (t) => {
  info = { ...INFO, level: "debug", effectiveLevel: "debug", retentionDays: 30 };
  problems = PROBLEMS;
  const opened = [];
  const { host, button, click } = await mount(
    t,
    "/components/settings/DiagnosticsSection.tsx",
    {},
    { openSettings: (destination) => opened.push(destination) }
  );
  const panel = row(host, "system.diagnostics");
  assert.ok(panel, "the Diagnostics anchor");
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = PROBLEMS.filter((problem) => Date.parse(problem.time) >= midnight.getTime());
  assert.ok(
    panel.textContent.includes(
      `Everything (debug) · kept 30 days · 8.7 MB · ${today.length} problems today`
    ),
    panel.textContent
  );
  await click(button("Manage in Storage", panel));
  assert.deepEqual(opened, ["storage#system.developer.debug"]);
  assert.ok(button("Copy…", panel), "Copy diagnostics is here too");

  // Outside Settings there's nowhere to link to.
  const outside = await mount(t, "/components/settings/DiagnosticsSection.tsx");
  assert.equal(button("Manage in Storage", outside.host), undefined);
  info = INFO;
});

test("a setting that couldn't be saved says so under its own row", async (t) => {
  info = INFO;
  rejectSave = true;
  t.after(() => {
    rejectSave = false;
  });
  const { host, React } = await mount(t, "/components/settings/LogsSection.tsx");
  await choose(React, row(host, "storage.logs.retention").querySelector("select"), 90);
  const alert = row(host, "storage.logs.retention").querySelector('[role="alert"]');
  assert.equal(alert?.textContent, "Couldn't save the log settings. Try again.");
  assert.equal(row(host, "system.developer.debug").querySelector('[role="alert"]'), null);
});

const WARP =
  "ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11-10.0.26100.9711)";
const FALLBACK = {
  mode: "software",
  reason: "fallback",
  requestedBy: null,
  gpuCompositing: "disabled_software",
  rasterization: "disabled_software",
  glRenderer: WARP,
  displayType: "ANGLE_D3D11_WARP",
};
const REQUESTED = {
  ...FALLBACK,
  reason: "requested",
  requestedBy: "--disable-gpu",
  glRenderer: null,
  displayType: null,
};
const HARDWARE = {
  mode: "hardware",
  reason: null,
  requestedBy: null,
  gpuCompositing: "enabled",
  rasterization: "enabled",
  glRenderer:
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  displayType: "ANGLE_D3D11",
};

test("a software fallback puts a warning with Restart OpenWhispr first in Diagnostics", async (t) => {
  info = { ...INFO, graphics: FALLBACK };
  relaunches = 0;
  const { host, button, click } = await mount(t, "/components/settings/DiagnosticsSection.tsx");
  const panel = row(host, "system.diagnostics");
  const graphics = row(host, "system.diagnostics.graphics");
  assert.ok(graphics, "the graphics row has its own anchor");
  assert.equal(panel.firstElementChild, graphics, "it comes first");
  const notice = graphics.querySelector('[data-graphics-notice="fallback"]');
  assert.equal(
    notice.textContent,
    "Graphics acceleration is off. OpenWhispr is drawing on the CPU, so animations can stutter. This usually means another app has used up the graphics card; restart OpenWhispr once it's free."
  );
  assert.match(graphics.textContent, /^Graphics/);
  const restart = button("Restart OpenWhispr", graphics);
  assert.ok(restart, "Restart OpenWhispr");
  await click(restart);
  assert.equal(relaunches, 1, "the existing relaunch-app");
  assert.equal(restart.disabled, true, "pressed once");
  info = INFO;
});

test("a launch flag's software mode gets a neutral note, hardware nothing; the row follows main", async (t) => {
  info = { ...INFO, graphics: REQUESTED };
  const requested = await mount(t, "/components/settings/DiagnosticsSection.tsx");
  const note = row(requested.host, "system.diagnostics.graphics");
  assert.equal(
    note.querySelector('[data-graphics-notice="requested"]').textContent,
    "Drawing on the CPU (set by a launch flag)"
  );
  assert.equal(requested.button("Restart OpenWhispr", note), undefined, "nothing to fix");
  assert.equal(note.querySelector('[data-graphics-notice="fallback"]'), null);

  for (const graphics of [HARDWARE, { ...HARDWARE, mode: "unknown" }, null, undefined]) {
    info = { ...INFO, graphics };
    const quiet = await mount(t, "/components/settings/DiagnosticsSection.tsx");
    assert.equal(row(quiet.host, "system.diagnostics.graphics"), null, String(graphics?.mode));
  }

  // A fallback mid-session reaches an open page through the broadcast.
  info = { ...INFO, graphics: HARDWARE };
  const live = await mount(t, "/components/settings/DiagnosticsSection.tsx");
  assert.equal(row(live.host, "system.diagnostics.graphics"), null);
  await live.React.act(async () => {
    for (const listener of graphicsListeners) listener(FALLBACK);
    await settle();
  });
  assert.ok(live.host.querySelector('[data-graphics-notice="fallback"]'));
  info = INFO;
});

test("Copy diagnostics names the graphics mode and its renderer", async (t) => {
  info = { ...INFO, graphics: FALLBACK };
  const { host, doc, button, click } = await mount(
    t,
    "/components/settings/DiagnosticsSection.tsx"
  );
  await click(button("Copy…", row(host, "system.diagnostics")));
  const lines = doc.querySelector("[data-diagnostics-preview]").textContent.split("\n");
  const os = lines.indexOf("OS: Windows 10.0.26100 (x64)");
  assert.deepEqual(lines.slice(os + 1, os + 3), [
    "Graphics: software (fallback), gpu_compositing disabled_software, rasterization disabled_software",
    `Graphics renderer: ${WARP} [ANGLE_D3D11_WARP]`,
  ]);

  const { diagnosticsText } = await vite.ssrLoadModule("/components/settings/logSettingsFormat.ts");
  const text = (graphics) =>
    diagnosticsText({ build: null, log: { ...INFO, graphics }, problems: [] });
  assert.match(
    text(REQUESTED),
    /^Graphics: software \(requested by --disable-gpu\), gpu_compositing disabled_software, rasterization disabled_software$/m
  );
  assert.doesNotMatch(text(REQUESTED), /Graphics renderer/);
  assert.match(text(null), /^Graphics: unknown$/m);
  info = INFO;
});
