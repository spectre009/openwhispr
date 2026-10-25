const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, settle } = require("../lib/settingsDomHarness");

// System › This build (settings/BuildInfoPanel.tsx), in happy-dom with a stubbed
// preload standing in for main's `get-build-info`: each field as the panel
// shows it for a self-built install, an older package without a stamp and a
// run from source; Copy build info as plain text with no user name; and the
// panel at the top of the real System page, carrying the version's anchor.

const SHA = "616ead3b0d8d4c1e9f2a3b4c5d6e7f8091a2b3c4";
const HOUR = 3600 * 1000;
const NOW = Date.now();
const BUILT_AT = new Date(NOW - 8 * HOUR - 5 * 60 * 1000).toISOString();
const STARTED_AT = new Date(NOW - HOUR - 2 * 60 * 1000).toISOString();

const SELF_BUILT = {
  version: "1.10.3",
  builtAt: BUILT_AT,
  commit: SHA,
  dirty: true,
  source: "selfhost",
  commitSubject: null,
  channel: "selfhost-stable",
  startedAt: STARTED_AT,
  uptimeSec: 3720,
  exePath: "%USERPROFILE%\\AppData\\Local\\Programs\\OpenWhispr\\OpenWhispr.exe",
  electron: "41.0.0",
  chrome: "146.0.7680.31",
  node: "24.11.1",
};

const OLDER_PACKAGE = {
  ...SELF_BUILT,
  builtAt: null,
  commit: null,
  dirty: null,
  source: null,
  channel: "release",
};

const FROM_SOURCE = {
  ...SELF_BUILT,
  builtAt: null,
  dirty: false,
  source: null,
  channel: "source",
  commitSubject: "feat(history): turn a review into a fix",
  exePath: "C:\\Git\\openwhispr\\node_modules\\electron\\dist\\electron.exe",
};

let answer = () => Promise.resolve(SELF_BUILT);
const clipboard = [];
let dom;
let vite;
const cleanups = [];

test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      getBuildInfo: () => answer(),
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
});

test.after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await dom.close();
});

// A button's own text, without the icon's SVG title
const buttonLabel = (button) =>
  [...button.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent)
    .join("");

const local = (iso) =>
  new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

async function mountPanel(t, info, props = {}) {
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  answer = typeof info === "function" ? info : () => Promise.resolve(info);
  const { default: BuildInfoPanel } = await vite.ssrLoadModule(
    "/components/settings/BuildInfoPanel.tsx"
  );
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
        React.createElement(BuildInfoPanel, {
          showing: true,
          fallbackVersion: "1.10.3",
          updateAvailable: false,
          updatesSupported: false,
          ...props,
          ...extra,
        })
      );
      await settle();
    });
  await render();
  await settle();
  // { label: shown value } for each row of the panel
  const fields = () =>
    Object.fromEntries(
      [...host.querySelectorAll("dl[data-build-info] dt")].map((dt) => [
        dt.textContent,
        dt.nextElementSibling.textContent,
      ])
    );
  const click = async (label) => {
    const button = [...host.querySelectorAll("button")].find((b) => buttonLabel(b) === label);
    assert.ok(button, `a "${label}" button`);
    await React.act(async () => {
      button.click();
      await settle();
    });
  };
  return { host, fields, click, render };
}

test("a self-built install shows when, from what and where it was built", async (t) => {
  const panel = await mountPanel(t, SELF_BUILT);
  assert.deepEqual(panel.fields(), {
    Version: "1.10.3Self-built",
    Built: `${local(BUILT_AT)} (8 hours ago)`,
    "From commit": "616ead3b · uncommitted changes",
    "Running since": `${local(STARTED_AT)} (1 hour ago)`,
    "Installed at": "%USERPROFILE%\\AppData\\Local\\Programs\\OpenWhispr",
    Engine: "Electron 41.0.0 · Chromium 146.0.7680.31 · Node 24.11.1",
  });
  const folder = [...panel.host.querySelectorAll("dd span")].find(
    (span) => span.textContent === "%USERPROFILE%\\AppData\\Local\\Programs\\OpenWhispr"
  );
  assert.equal(folder.getAttribute("dir"), "ltr");
  assert.match(folder.className, /font-mono/);
});

test("an older package without build-info.json shows Unknown, not a guess", async (t) => {
  const panel = await mountPanel(t, OLDER_PACKAGE, { updatesSupported: true });
  const fields = panel.fields();
  assert.equal(fields.Version, "1.10.3Latest");
  assert.equal(fields.Built, "Unknown");
  assert.equal(fields["From commit"], "Unknown");
  assert.equal(fields["Running since"], `${local(STARTED_AT)} (1 hour ago)`);
});

test("a run from source says so, with the working tree's HEAD and its subject", async (t) => {
  const panel = await mountPanel(t, FROM_SOURCE);
  const fields = panel.fields();
  assert.equal(fields.Version, "1.10.3Running from source");
  assert.equal(fields.Built, "Running from source");
  assert.equal(fields["From commit"], "616ead3b · feat(history): turn a review into a fix");
  assert.equal(fields["Installed at"], "C:\\Git\\openwhispr\\node_modules\\electron\\dist");
});

test("an official release shows its update state next to the version", async (t) => {
  const panel = await mountPanel(t, OLDER_PACKAGE, {
    updatesSupported: true,
    updateAvailable: true,
  });
  assert.equal(panel.fields().Version, "1.10.3Update");
});

test("when main can't answer, the version still shows and the rest reads Unknown", async (t) => {
  const panel = await mountPanel(t, () => Promise.reject(new Error("no handler")), {
    fallbackVersion: "1.10.2",
  });
  const fields = panel.fields();
  assert.equal(fields.Version, "1.10.2");
  for (const label of ["Built", "From commit", "Running since", "Installed at", "Engine"]) {
    assert.equal(fields[label], "Unknown", label);
  }
  const copy = [...panel.host.querySelectorAll("button")].find((b) => buttonLabel(b) === "Copy");
  assert.equal(copy.disabled, true, "nothing to copy");
});

test("Copy build info copies plain lines, with the profile path masked", async (t) => {
  clipboard.length = 0;
  const panel = await mountPanel(t, SELF_BUILT);
  await panel.click("Copy");
  assert.equal(clipboard.length, 1);
  assert.deepEqual(clipboard[0].split("\n"), [
    "OpenWhispr 1.10.3",
    "Channel: self-built (selfhost Stable)",
    `Built: ${BUILT_AT}`,
    `Commit: ${SHA} (uncommitted changes)`,
    `Running since: ${STARTED_AT} (up 1h 2m)`,
    "Installed at: %USERPROFILE%\\AppData\\Local\\Programs\\OpenWhispr",
    "Engine: Electron 41.0.0 · Chromium 146.0.7680.31 · Node 24.11.1",
  ]);
  assert.doesNotMatch(clipboard[0], /\\Users\\/i, "no user name");
  assert.ok(
    [...panel.host.querySelectorAll("button")].some((b) => buttonLabel(b) === "Copied"),
    "the button confirms"
  );

  clipboard.length = 0;
  const source = await mountPanel(t, FROM_SOURCE);
  await source.click("Copy");
  const lines = clipboard[0].split("\n");
  assert.equal(lines[1], "Channel: running from source (selfhost Dev or npm run dev)");
  assert.equal(lines[2], "Built: running from source");
  assert.equal(lines[3], `Commit: ${SHA}`);
  assert.equal(lines[4], "Subject: feat(history): turn a review into a fix");
});

test("relative times move on once a minute, and only while the page shows", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const panel = await mountPanel(t, { ...SELF_BUILT, startedAt: STARTED_AT, uptimeSec: 3720 });
  assert.match(panel.fields()["Running since"], /\(1 hour ago\)$/);
  assert.match(panel.fields().Built, /\(8 hours ago\)$/);

  const React = require("react");
  await React.act(async () => t.mock.timers.tick(60 * 60 * 1000));
  assert.match(panel.fields()["Running since"], /\(2 hours ago\)$/);
  assert.match(panel.fields().Built, /\(9 hours ago\)$/);

  // Another page is on screen: no ticking, and catching up as soon as it shows
  await panel.render({ showing: false });
  await React.act(async () => t.mock.timers.tick(60 * 60 * 1000));
  assert.match(panel.fields()["Running since"], /\(2 hours ago\)$/);
  await panel.render({ showing: true });
  assert.match(panel.fields()["Running since"], /\(3 hours ago\)$/);
  assert.match(panel.fields().Built, /\(10 hours ago\)$/);
});

test("on the System page the panel sits above Updates and carries the version anchor", async (t) => {
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const h = React.createElement;
  answer = () => Promise.resolve(SELF_BUILT);
  const { default: SettingsModal } = await vite.ssrLoadModule("/components/SettingsModal.tsx");
  const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  const { default: reasoningService } = await vite.ssrLoadModule("/services/ReasoningService.ts");
  t.after(() => reasoningService.destroy());

  const doc = dom.window.document;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  await React.act(async () => {
    root.render(
      h(
        ToastProvider,
        null,
        h(
          SettingsProvider,
          null,
          h(SettingsModal, {
            open: true,
            request: { section: "system", id: 1 },
            onRequestClose: () => true,
            railItems: [],
            activeView: "home",
            onSelectView: () => {},
            onOpenSearch: () => {},
            onOpenElsewhere: () => {},
          })
        )
      )
    );
    await settle(60);
  });
  await React.act(async () => settle(200));

  const page = doc.querySelector('[data-settings-page-id="system"]');
  const anchors = page.querySelectorAll('[data-setting-id="system.updates.version"]');
  assert.equal(anchors.length, 1, "the version anchor renders once");
  const panel = anchors[0];
  assert.ok(panel.querySelector("dl[data-build-info]"), "on the This build panel");
  assert.match(panel.textContent, /616ead3b/);

  const headings = [...page.querySelectorAll("h3")].map((heading) => heading.textContent);
  assert.ok(headings.indexOf("This build") >= 0, "a This build section");
  assert.ok(headings.indexOf("This build") < headings.indexOf("Updates"), "above Updates");

  // Updates no longer shows the version, and says why automatic updates are off
  const auto = page.querySelector('[data-setting-id="system.updates.auto"]');
  assert.ok(auto, "the automatic updates row renders while updates are unavailable");
  assert.match(auto.textContent, /Not available/);
});
