const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, settle } = require("../lib/settingsDomHarness");

// Settings › Storage (settings/StoragePage.tsx) in happy-dom with a stubbed
// preload standing in for main: the size bar and its sections in order,
// "Measuring…" until main answers, Recordings (retention lists, the rule that
// recordings never outlive transcripts, quality with sizes and estimates,
// Open folder, Clear all and what's left), the History database's counts,
// everything else by id (only the app cache clears; models keep today's
// Remove all and link to AI Connections), and Privacy & Data's summaries.

const P = "%USERPROFILE%\\AppData\\Roaming\\open-whispr";
const KB = 1024;
const MB = 1024 * KB;

const item = (id, bytes, extra = {}) => ({
  id,
  path: `${P}\\${id}`,
  paths: [`${P}\\${id}`],
  target: "folder",
  exists: true,
  bytes,
  files: 1,
  parts: [],
  clearable: ["recordings", "logs", "appCache"].includes(id),
  ...extra,
});

const INVENTORY = {
  measuredAt: "2026-10-25T15:00:00.000Z",
  cached: false,
  totalBytes: 0,
  items: [
    item("recordings", 393 * MB, { path: `${P}\\audio`, paths: [`${P}\\audio`] }),
    item("logs", 8.7 * MB),
    item("database", 8 * MB, {
      path: `${P}\\transcriptions.db`,
      paths: [
        `${P}\\transcriptions.db`,
        `${P}\\transcriptions.db-wal`,
        `${P}\\transcriptions.db-shm`,
      ],
      target: "file",
    }),
    item("settings", 60 * KB, {
      path: `${P}\\Local Storage`,
      paths: [`${P}\\Local Storage`, `${P}\\.env`],
      target: "file",
    }),
    item("secrets", 12 * KB, { path: `${P}\\secure-keys`, paths: [`${P}\\secure-keys`] }),
    item("models", 755 * MB, {
      path: "%USERPROFILE%\\.cache\\openwhispr",
      parts: [
        { key: "whisper", bytes: 0, exists: false },
        { key: "parakeet", bytes: 632 * MB, exists: true },
        { key: "diarization", bytes: 36 * MB, exists: true },
        { key: "llm", bytes: 0, exists: false },
        { key: "embedding", bytes: 87 * MB, exists: true },
      ],
    }),
    item("searchIndex", 368 * MB),
    item("appCache", 46 * MB, { target: "file" }),
    item("cliBridge", 0, { exists: false, target: "file" }),
    item("selfhost", null, { files: null }),
  ],
  database: {
    counts: {
      dictations: 4003,
      stepRecords: 1105,
      reviews: 1,
      testCases: 1,
      dictionaryWords: 205,
      glossaryRules: 1,
      notes: 2,
    },
  },
  recordingPace: {
    windowDays: 30,
    spanDays: 30,
    dictations: 300,
    perDay: 10,
    averageSeconds: 84,
    minutesPerDay: 14,
  },
};

const LOG_INFO = {
  level: "warn",
  effectiveLevel: "warn",
  overriddenBy: null,
  retentionDays: 7,
  includeText: false,
  totalBytes: 9122611,
  fileCount: 72,
  currentFile: "debug-2026-10-25T15-02-11-123Z.log",
  logsDir: `${P}\\logs`,
  system: { platform: "win32", version: "10.0.26100", arch: "x64" },
};

let inventory = INVENTORY;
let pendingInventory = null;
let usage = { fileCount: 1054, totalBytes: 393 * MB };
let usageAfterClear = { fileCount: 0, totalBytes: 0 };
let clearResult = { deleted: 1054, failed: 0 };
const clipboard = [];
let dom;
let vite;
let store;
const cleanups = [];

test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      getStorageInventory: async () => (pendingInventory ? pendingInventory.promise : inventory),
      getAudioStorageUsage: async () => usage,
      deleteAllAudio: async () => {
        usage = usageAfterClear;
        return clearResult;
      },
      openRecordingsFolder: async () => ({ success: true }),
      openStorageItem: async () => ({ success: true }),
      clearStorageItem: async () => ({ success: true }),
      getLogInfo: async () => LOG_INFO,
      getRecentLogProblems: async () => [],
      deleteAllWhisperModels: async () => ({ success: true }),
      deleteAllParakeetModels: async () => ({ success: true }),
      modelDeleteAll: async () => ({ success: true }),
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
  store = (await vite.ssrLoadModule("/stores/settingsStore.ts")).useSettingsStore;
});

test.after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await dom.close();
});

// Inside act: a mounted section re-renders on these store updates.
async function resetSettings() {
  await require("react").act(async () => {
    const state = store.getState();
    state.setAudioRetentionDays(30);
    state.setTranscriptRetentionDays(0);
    state.setDataRetentionEnabled(true);
    state.setRecordingQuality("original");
    await settle();
  });
}

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
const calls = (name) => dom.calls.filter(([called]) => called === name);

async function choose(React, select, value) {
  await React.act(async () => {
    select.value = String(value);
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
  });
}

test("the size bar, then Recordings, Logs, the History database and everything else", async (t) => {
  inventory = INVENTORY;
  await resetSettings();
  const { host } = await mount(t, "/components/settings/StoragePage.tsx");
  assert.deepEqual(
    [...host.querySelectorAll("[data-storage-section]")].map((node) =>
      node.getAttribute("data-storage-section")
    ),
    ["overview", "recordings", "logs", "database", "everythingElse"]
  );
  const segments = [...host.querySelectorAll("[data-storage-segment]")];
  assert.deepEqual(
    segments.map((segment) => segment.getAttribute("data-storage-segment")),
    ["recordings", "models", "searchIndex", "appCache", "logs", "database", "other"]
  );
  const share = (key) =>
    parseFloat(host.querySelector(`[data-storage-segment="${key}"]`).style.width);
  assert.ok(share("models") > share("recordings") && share("recordings") > share("appCache"));
  const legend = host.querySelector('[data-storage-legend="models"]').textContent;
  assert.equal(legend, "Local models755 MB");
  assert.match(
    host.querySelector('[data-storage-section="overview"] h3').textContent,
    /On this computer.*1\.\d GB in all/
  );
  for (const id of [
    "storage.inventory",
    "privacy.audioRetention",
    "storage.recordings.quality",
    "privacy.audioStorage",
    "storage.recordings.folder",
    "system.developer.debug",
    "storage.database",
    "storage.settings",
    "storage.secrets",
    "storage.models",
    "system.data.modelCache",
    "storage.searchIndex",
    "storage.appCache",
    "storage.cliBridge",
  ]) {
    assert.equal(host.querySelectorAll(`[data-setting-id="${id}"]`).length, 1, id);
  }
});

test("Measuring… until main answers; a hidden page reads nothing; Refresh asks past the cache", async (t) => {
  inventory = INVENTORY;
  const before = calls("getStorageInventory").length;
  const hidden = await mount(t, "/components/settings/StoragePage.tsx", { showing: false });
  assert.equal(calls("getStorageInventory").length, before, "nothing read while hidden");

  let resolve;
  pendingInventory = { promise: new Promise((done) => (resolve = done)) };
  await hidden.render({ showing: true });
  const overview = hidden.host.querySelector('[data-storage-section="overview"]');
  assert.match(overview.textContent, /Measuring…/);
  assert.match(row(hidden.host, "storage.secrets").textContent, /Measuring…/);
  assert.equal(hidden.host.querySelector("[data-storage-bar]"), null);
  await hidden.React.act(async () => {
    resolve(INVENTORY);
    await settle();
  });
  pendingInventory = null;
  assert.ok(hidden.host.querySelector("[data-storage-bar]"));
  assert.doesNotMatch(overview.textContent, /Measuring…/);
  assert.deepEqual(calls("getStorageInventory").at(-1)[1], [{ refresh: false }]);

  await hidden.click(hidden.button("Refresh", overview));
  assert.deepEqual(calls("getStorageInventory").at(-1)[1], [{ refresh: true }]);
});

test("Keep recordings for: Off to 1 year, never longer than the transcript", async (t) => {
  await resetSettings();
  const { host, React } = await mount(t, "/components/settings/StoragePage.tsx");
  const retention = row(host, "privacy.audioRetention");
  const select = retention.querySelector("select");
  assert.deepEqual(
    [...select.options].map((option) => option.textContent),
    [
      "Off (don't keep)",
      "1 day",
      "7 days",
      "14 days",
      "30 days",
      "60 days",
      "90 days",
      "6 months",
      "1 year",
    ]
  );
  assert.ok(
    [...select.options].every((option) => !option.disabled),
    "no organization cap"
  );
  assert.match(retention.textContent, /Never kept longer than its transcript\./);
  assert.equal(retention.querySelector('[data-recordings-note="effective"]'), null);

  await choose(React, select, 365);
  assert.equal(store.getState().audioRetentionDays, 365);
  assert.equal(dom.window.localStorage.getItem("audioRetentionDays"), "365");

  // Transcripts kept 30 days: recordings go with them, and the estimate uses 30 days.
  await React.act(async () => {
    store.getState().setTranscriptRetentionDays(30);
    await settle();
  });
  assert.equal(
    retention.querySelector('[data-recordings-note="effective"]').textContent,
    "Transcripts are kept 30 days, so recordings go with them after 30 days."
  );
  assert.match(
    row(host, "storage.recordings.quality").querySelector('[data-recording-quality="original"]')
      .textContent,
    /for 30 days \(estimate\)/
  );

  await React.act(async () => {
    store.getState().setDataRetentionEnabled(false);
    await settle();
  });
  assert.equal(
    retention.querySelector('[data-recordings-note="historyOff"]').textContent,
    "Not saved while local history is off (Privacy & Data)."
  );
  assert.equal(host.querySelector("[data-quality-estimate]"), null, "nothing kept, no estimate");
  await resetSettings();
});

test("Recording quality: sizes a minute, estimates at the user's pace, and the pick is saved", async (t) => {
  await resetSettings();
  inventory = INVENTORY;
  const { host, click } = await mount(t, "/components/settings/StoragePage.tsx");
  const quality = row(host, "storage.recordings.quality");
  const radios = [...quality.querySelectorAll('[role="radio"]')];
  assert.deepEqual(
    radios.map((radio) => [
      radio.getAttribute("data-recording-quality"),
      radio.getAttribute("aria-checked"),
    ]),
    [
      ["smaller", "false"],
      ["balanced", "false"],
      ["original", "true"],
    ]
  );
  const card = (name) => quality.querySelector(`[data-recording-quality="${name}"]`);
  assert.match(card("smaller").textContent, /^SmallerRecommended/);
  assert.match(card("original").textContent, /^OriginalDefault/);
  assert.deepEqual(
    ["smaller", "balanced", "original"].map(
      (name) => card(name).querySelector("[data-quality-size]").textContent
    ),
    ["~240 KB / min", "~480 KB / min", "~945 KB / min"]
  );
  // 14 minutes a day, kept 30 days.
  assert.equal(
    card("smaller").querySelector("[data-quality-estimate]").textContent,
    "~98.4 MB for 30 days (estimate)"
  );
  assert.equal(
    card("original").querySelector("[data-quality-estimate]").textContent,
    "~387.6 MB for 30 days (estimate)"
  );
  assert.match(
    quality.querySelector("[data-recordings-pace]").textContent,
    /about 14 min of recordings a day/
  );

  await click(card("smaller"));
  assert.equal(card("smaller").getAttribute("aria-checked"), "true");
  assert.equal(store.getState().recordingQuality, "smaller");
  assert.equal(dom.window.localStorage.getItem("recordingQuality"), "smaller");
  await resetSettings();
});

test("the recordings folder: Open, and Clear all asks first and says what's left", async (t) => {
  await resetSettings();
  inventory = INVENTORY;
  usage = { fileCount: 1054, totalBytes: 393 * MB };
  usageAfterClear = { fileCount: 2, totalBytes: 2 * KB };
  clearResult = { deleted: 1052, failed: 2 };
  const { host, doc, click, button } = await mount(t, "/components/settings/StoragePage.tsx");
  const folder = row(host, "privacy.audioStorage");
  assert.match(folder.textContent, /393 MB · 1054 files/);
  assert.match(folder.textContent, /%USERPROFILE%\\AppData\\Roaming\\open-whispr\\audio/);
  assert.match(
    host.querySelector('[data-storage-section="recordings"] h3').textContent,
    /Recordings393 MB · 1054 files/
  );

  const opens = calls("openRecordingsFolder").length;
  await click(button("Open folder", row(host, "storage.recordings.folder")));
  assert.equal(calls("openRecordingsFolder").length, opens + 1);

  const deletes = calls("deleteAllAudio").length;
  await click(button("Clear all recordings", folder));
  const dialog = doc.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Clear all recordings\?/);
  assert.equal(calls("deleteAllAudio").length, deletes, "nothing until confirmed");
  const measures = calls("getStorageInventory").length;
  await click(button("Clear all recordings", dialog));
  assert.equal(calls("deleteAllAudio").length, deletes + 1);
  assert.equal(
    folder.querySelector('[data-recordings-notice="error"]').textContent,
    "Some recordings couldn't be deleted (in use?) and are still in the folder: 2 KB · 2 files."
  );
  assert.ok(calls("getStorageInventory").length > measures, "the page measures again");
  assert.deepEqual(calls("getStorageInventory").at(-1)[1], [{ refresh: true }]);
  clearResult = { deleted: 1054, failed: 0 };
  usage = { fileCount: 1054, totalBytes: 393 * MB };
});

test("the History database: what it holds, Show in folder, and clearing history in Privacy & Data", async (t) => {
  inventory = INVENTORY;
  const opened = [];
  const { host, click, button } = await mount(
    t,
    "/components/settings/StoragePage.tsx",
    {},
    { openSettings: (destination) => opened.push(destination) }
  );
  const section = host.querySelector('[data-storage-section="database"]');
  assert.match(section.querySelector("h3").textContent, /History database8 MB/);
  const counts = Object.fromEntries(
    [...section.querySelectorAll("[data-database-count]")].map((node) => [
      node.getAttribute("data-database-count"),
      node.querySelector("dd").textContent,
    ])
  );
  assert.deepEqual(counts, {
    dictations: "4,003",
    stepRecords: "1,105",
    reviews: "1",
    testCases: "1",
    dictionaryWords: "205",
    glossaryRules: "1",
    notes: "2",
  });
  assert.match(section.textContent, /Dictations4,003/);
  await click(button("Show in folder", section));
  assert.deepEqual(calls("openStorageItem").at(-1)[1], ["database"]);
  await click(button("Clear history in Privacy & Data", section));
  assert.deepEqual(opened, ["privacyData#privacy.history"]);
});

test("everything else: a row per place; only the app cache clears; models keep Remove all", async (t) => {
  inventory = INVENTORY;
  clipboard.length = 0;
  const opened = [];
  const { host, doc, click, button } = await mount(
    t,
    "/components/settings/StoragePage.tsx",
    {},
    { openSettings: (destination) => opened.push(destination) }
  );
  const section = host.querySelector('[data-storage-section="everythingElse"]');
  assert.deepEqual(
    [...section.querySelectorAll("[data-storage-item]")].map((node) =>
      node.getAttribute("data-storage-item")
    ),
    ["settings", "secrets", "models", "searchIndex", "appCache", "cliBridge", "selfhost"]
  );
  const size = (id) =>
    section.querySelector(`[data-storage-item="${id}"] [data-storage-size]`).textContent;
  assert.equal(size("models"), "755 MB");
  assert.equal(size("cliBridge"), "Not created yet");
  assert.equal(size("selfhost"), "—", "never measured");
  assert.match(section.querySelector('[data-storage-item="selfhost"]').textContent, /this fork/);
  assert.equal(
    section.querySelector('[data-storage-item="settings"] [data-storage-path]').textContent,
    `${P}\\Local Storage · .env`
  );
  assert.deepEqual(
    [...section.querySelectorAll('[data-storage-action="clear"]')].map((node) =>
      node.closest("[data-storage-item]").getAttribute("data-storage-item")
    ),
    ["appCache"],
    "only the app cache has Clear"
  );

  const secrets = section.querySelector('[data-storage-item="secrets"]');
  await click(secrets.querySelector('[data-storage-action="copy"]'));
  assert.deepEqual(clipboard, [`${P}\\secure-keys`], "the masked path");
  await click(secrets.querySelector('[data-storage-action="open"]'));
  assert.deepEqual(calls("openStorageItem").at(-1)[1], ["secrets"]);
  const bridgeOpen = section.querySelector(
    '[data-storage-item="cliBridge"] [data-storage-action="open"]'
  );
  assert.equal(bridgeOpen.disabled, true, "nothing to show yet");

  const appCache = section.querySelector('[data-storage-item="appCache"]');
  const clears = calls("clearStorageItem").length;
  await click(appCache.querySelector('[data-storage-action="clear"]'));
  const dialog = doc.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Clear the app cache\?/);
  await click(button("Clear", dialog));
  assert.deepEqual(
    calls("clearStorageItem")
      .slice(clears)
      .map(([, args]) => args),
    [["appCache"]]
  );
  assert.equal(appCache.querySelector("[data-app-cache-notice]").textContent, "App cache cleared.");

  const models = row(host, "storage.models");
  assert.equal(
    models.querySelector("[data-model-kinds]").textContent,
    "Parakeet and Cohere 632 MB · Speaker detection 36 MB · Note search 87 MB"
  );
  await click(button("Manage in AI Connections", models));
  assert.deepEqual(opened, ["connections#connections.localModels"]);
  const removeAnchor = row(host, "system.data.modelCache");
  assert.ok(models.contains(removeAnchor), "the model cache action lives in the models row");
  await click(button("Remove all models", removeAnchor));
  const confirm = doc.querySelector('[role="dialog"]');
  assert.match(confirm.textContent, /%USERPROFILE%\\\.cache\\openwhispr/);
  await click(button("Delete Models", confirm));
  for (const name of ["deleteAllWhisperModels", "deleteAllParakeetModels", "modelDeleteAll"]) {
    assert.equal(calls(name).length, 1, name);
  }
});

test("Privacy & Data sums up recordings and logs and links to Storage, with anchors of its own", async (t) => {
  await resetSettings();
  usage = { fileCount: 1054, totalBytes: 393 * MB };
  const opened = [];
  const { host, click, button } = await mount(
    t,
    "/components/settings/PrivacyStorageSummary.tsx",
    {},
    { openSettings: (destination) => opened.push(destination) }
  );
  const recordings = row(host, "privacy.recordingsSummary");
  const logs = row(host, "privacy.logsSummary");
  assert.match(recordings.textContent, /RecordingsKept 30 days · 393 MB/);
  assert.match(logs.textContent, /LogsProblems only · 8\.7 MB/);
  for (const moved of [
    "privacy.audioRetention",
    "privacy.audioStorage",
    "system.developer.debug",
  ]) {
    assert.equal(row(host, moved), null, `${moved} isn't here`);
  }
  await click(button("Manage in Storage", recordings));
  await click(button("Manage in Storage", logs));
  assert.deepEqual(opened, ["storage#privacy.audioRetention", "storage#system.developer.debug"]);

  const React = require("react");
  await React.act(async () => {
    store.getState().setAudioRetentionDays(365);
    store.getState().setTranscriptRetentionDays(180);
    await settle();
  });
  assert.match(recordings.textContent, /Kept 6 months/, "the shorter transcript limit");
  await React.act(async () => {
    store.getState().setAudioRetentionDays(0);
    await settle();
  });
  assert.match(recordings.textContent, /Not saved · 393 MB/);
  await resetSettings();
});
