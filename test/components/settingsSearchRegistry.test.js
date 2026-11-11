const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { LOCALES, readLocale, makeContext, translators } = require("../lib/settingsSearchFixtures");

// The settings search registry against the source: every descriptor lands on a
// `data-setting-id` that the markup renders, every anchor in the markup has a
// descriptor, every location is a real page (every page has its descriptor,
// every legacy destination still resolves), every string exists in all 11
// locales, and availability explains prerequisites instead of hiding results
// or pointing at something that isn't rendered.

const SRC = path.join(__dirname, "..", "..", "src");
const COMPONENTS = path.join(SRC, "components");

async function load() {
  const registry = await import("../../src/components/settings/search/registry.ts");
  const types = await import("../../src/components/settings/search/types.ts");
  const index = await import("../../src/components/settings/search/searchIndex.ts");
  const match = await import("../../src/components/settings/search/match.ts");
  const action = await import("../../src/components/settings/search/openSettingsResult.ts");
  const pages = await loadPages();
  return {
    ...(registry.default ?? registry),
    ...(types.default ?? types),
    ...(index.default ?? index),
    ...(match.default ?? match),
    ...(action.default ?? action),
    settingDestination: pages.settingDestination,
  };
}

async function loadPages() {
  const pages = await import("../../src/components/settings/settingsPages.ts");
  return pages.default ?? pages;
}

function componentFiles(directory = COMPONENTS) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(absolute);
    return /\.tsx?$/.test(entry.name) ? [absolute] : [];
  });
}

// Editors take a base anchor and render these rows under it (InferenceConfigEditor).
const DERIVED_ANCHOR_SUFFIXES = {
  InferenceConfigEditor: [".thinking", ".reasoningEffort", ".keepLoaded"],
};

/**
 * Anchors the markup renders: `data-setting-id="x"`, the string results of a
 * `data-setting-id={cond ? "a" : "b"}` expression (comparison operands aren't
 * anchors), and the documented derived anchors.
 */
function sourceAnchors() {
  const anchors = new Map();
  const add = (anchor, file) => {
    if (!anchors.has(anchor)) anchors.set(anchor, new Set());
    anchors.get(anchor).add(path.relative(SRC, file));
  };
  for (const file of componentFiles()) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/data-setting-id=(?:"([^"]+)"|\{([^}]*)\})/g)) {
      if (match[1]) add(match[1], file);
      else {
        const expression = match[2].replace(/[!=]==?\s*"[^"]*"/g, "");
        for (const literal of expression.matchAll(/"([^"]+)"/g)) add(literal[1], file);
      }
    }
    for (const [component, suffixes] of Object.entries(DERIVED_ANCHOR_SUFFIXES)) {
      const usage = new RegExp(`<${component}\\b[^>]*?data-setting-id="([^"]+)"`, "gs");
      for (const match of text.matchAll(usage)) {
        for (const suffix of suffixes) add(`${match[1]}${suffix}`, file);
      }
    }
  }
  return anchors;
}

const get = (data, key) => key.split(".").reduce((node, part) => node?.[part], data);

test("descriptor ids are unique and scope-qualified", async () => {
  const { SETTINGS_SEARCH_DESCRIPTORS } = await load();
  const ids = SETTINGS_SEARCH_DESCRIPTORS.map((descriptor) => descriptor.id);
  assert.deepEqual(
    ids.filter((id, index) => ids.indexOf(id) !== index),
    [],
    "duplicate ids"
  );
  for (const id of ids) assert.match(id, /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/, id);
  assert.ok(ids.length >= 120, `${ids.length} descriptors`);
});

test("every descriptor anchor is rendered by the markup", async () => {
  const { SETTINGS_SEARCH_DESCRIPTORS } = await load();
  const anchors = sourceAnchors();
  const missing = [];
  for (const descriptor of SETTINGS_SEARCH_DESCRIPTORS) {
    for (const anchor of [descriptor.anchor, descriptor.fallbackAnchor]) {
      if (anchor && !anchors.has(anchor)) missing.push(`${descriptor.id} → ${anchor}`);
    }
    for (const anchor of descriptor.reveal?.expand ?? []) {
      if (!anchors.has(anchor)) missing.push(`${descriptor.id} expands ${anchor}`);
    }
  }
  assert.deepEqual(missing, [], "add data-setting-id to the row, or fix the descriptor");
});

test("every data-setting-id in the markup has a descriptor", async () => {
  const { SETTINGS_SEARCH_DESCRIPTORS } = await load();
  const used = new Set(
    SETTINGS_SEARCH_DESCRIPTORS.flatMap((descriptor) => [
      descriptor.anchor,
      descriptor.fallbackAnchor,
      ...(descriptor.reveal?.expand ?? []),
    ])
  );
  const orphans = [...sourceAnchors()]
    .filter(([anchor]) => !used.has(anchor))
    .map(([anchor, files]) => `${anchor} (${[...files].join(", ")})`);
  assert.deepEqual(orphans, [], "add a descriptor to settings/search/registry.ts");
});

test("settings land on an anchor, pages and app pages navigate", async () => {
  const { SETTINGS_SEARCH_DESCRIPTORS } = await load();
  for (const descriptor of SETTINGS_SEARCH_DESCRIPTORS) {
    if (descriptor.kind === "setting") {
      assert.ok(descriptor.anchor, `${descriptor.id} has an anchor`);
      assert.ok(descriptor.location, `${descriptor.id} has a location`);
    } else if (descriptor.kind === "page") {
      assert.equal(descriptor.anchor, undefined, descriptor.id);
      assert.ok(descriptor.location, `${descriptor.id} has a location`);
    } else {
      assert.ok(["dictionary", "integrations"].includes(descriptor.elsewhere?.view), descriptor.id);
      assert.equal(descriptor.location, undefined, descriptor.id);
    }
  }
});

test("every location is a real page (and People tab)", async () => {
  const { SETTINGS_SEARCH_DESCRIPTORS, PEOPLE_SUB_TABS } = await load();
  const { SETTINGS_PAGE_IDS } = await loadPages();
  // The People tab list mirrors the one WorkspacePeopleSection renders.
  const read = (file) => fs.readFileSync(path.join(COMPONENTS, file), "utf8");
  const list = (text, pattern) =>
    [...(text.match(pattern)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    list(read("settings/WorkspacePeopleSection.tsx"), /const PEOPLE_TABS = \[([^\]]*)\]/),
    [...PEOPLE_SUB_TABS]
  );

  for (const { id, location } of SETTINGS_SEARCH_DESCRIPTORS) {
    if (!location) continue;
    assert.ok(SETTINGS_PAGE_IDS.includes(location.page), `${id}: ${location.page}`);
    assert.ok(!("section" in location), `${id} names a page, not a section`);
    if (location.subTab) {
      assert.equal(location.page, "workspacePeople", `${id}: only People has tabs`);
      assert.ok(PEOPLE_SUB_TABS.includes(location.subTab), `${id}: ${location.subTab}`);
    }
  }
});

test("every page in the nav tree has a page descriptor titled like it", async () => {
  const { SETTINGS_SEARCH_DESCRIPTORS } = await load();
  const { SETTINGS_PAGE_IDS, SETTINGS_PAGES } = await loadPages();
  for (const page of SETTINGS_PAGE_IDS) {
    const own = SETTINGS_SEARCH_DESCRIPTORS.filter(
      (descriptor) =>
        descriptor.kind === "page" &&
        descriptor.location?.page === page &&
        !descriptor.location.subTab &&
        descriptor.titleKey === SETTINGS_PAGES[page].titleKey
    );
    assert.equal(own.length, 1, `one page descriptor for ${page}`);
    assert.equal(own[0].descriptionKey, SETTINGS_PAGES[page].descriptionKey, page);
  }
});

test("every destination still resolves: legacy names, descriptors and pages", async () => {
  const { SETTINGS_SEARCH_DESCRIPTORS, locateSetting, settingDestination } = await load();
  const {
    SETTINGS_PAGE_IDS,
    SECTION_ALIASES,
    LEGACY_SUB_TAB,
    isSettingsPageId,
    resolveSettingsDestination,
  } = await loadPages();
  const ctx = { cloudDisabled: false, isSignedIn: true, agentAllowed: true };
  const legacy = [
    ...Object.keys(SECTION_ALIASES),
    ...Object.keys(LEGACY_SUB_TAB),
    "account",
    "plansBilling",
    "workspace",
    "general",
    "hotkeys",
    "speechToText",
    "llms",
    "privacyData",
    "system",
  ];
  for (const name of [...legacy, ...SETTINGS_PAGE_IDS]) {
    const { page } = resolveSettingsDestination(name, { ctx, locateSetting });
    assert.ok(isSettingsPageId(page), `${name} → ${page}`);
  }
  // A search result's destination string lands on the descriptor's page.
  for (const descriptor of SETTINGS_SEARCH_DESCRIPTORS) {
    if (!descriptor.location) continue;
    const destination = settingDestination(descriptor.id);
    const resolved = resolveSettingsDestination(destination, { ctx, locateSetting });
    assert.equal(resolved.page, descriptor.location.page, destination);
    assert.equal(resolved.settingId, descriptor.id, destination);
  }
});

test("every search string exists in all 11 locales", async () => {
  const lib = await load();
  const { SETTINGS_PAGES, SETTINGS_NAV } = await loadPages();
  const keys = new Set(lib.SETTINGS_SEARCH_REASON_KEYS);
  for (const descriptor of lib.SETTINGS_SEARCH_DESCRIPTORS) {
    for (const key of [descriptor.titleKey, descriptor.descriptionKey, descriptor.groupKey]) {
      if (key) keys.add(key);
    }
    for (const key of descriptor.aliasKeys ?? []) keys.add(key);
    const { location } = descriptor;
    if (location) {
      keys.add(SETTINGS_PAGES[location.page].titleKey);
      if (location.subTab) keys.add(lib.subTabLabelKey(location.subTab));
    }
  }
  // Breadcrumbs and result groups name the nav's parents.
  for (const group of SETTINGS_NAV) {
    for (const item of group.items) if (item.kind === "parent") keys.add(item.titleKey);
  }
  // Strings the search UI and the index ask for directly.
  for (const file of componentFiles(path.join(COMPONENTS, "settings", "search"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/["'`](settingsSearch\.[A-Za-z.]+)["'`]/g))
      keys.add(match[1]);
  }
  keys.add("sidebar.integrations");
  for (const lang of LOCALES) {
    const data = readLocale(lang);
    const missing = [...keys].filter((key) => typeof get(data, key) !== "string");
    assert.deepEqual(missing, [], `${lang} is missing keys`);
  }
});

// Contexts covering every rule's branches.
const CONTEXTS = [
  makeContext(),
  makeContext({ cloudDisabled: true, isSignedIn: false }),
  makeContext({ isSignedIn: false }),
  makeContext({ agentAllowed: false, screenContextAllowed: false, visionOverrideAllowed: false }),
  makeContext({
    platform: "darwin",
    gpuCount: 2,
    on: Object.fromEntries(
      [
        "cleanup",
        "assistant",
        "screenContext",
        "visionModel",
        "translation",
        "noteFiles",
        "colorByMode",
        "autoLanguage",
        "localWhisper",
        "transcriptionPreview",
      ].map((flag) => [flag, false])
    ),
    localLlm: { dictationCleanup: false },
  }),
  makeContext({
    platform: "linux",
    isWayland: true,
    canManageWorkspace: false,
    canManageMembers: false,
  }),
  // Signed in while in Personal: the workspace's own pages wait for a chosen workspace.
  makeContext({ hasWorkspace: false, canManageWorkspace: false, canManageMembers: false }),
];

test("every unavailable result names a reason and an existing prerequisite", async () => {
  const { SETTINGS_SEARCH_DESCRIPTORS, findSettingDescriptor, settingAvailability } = await load();
  for (const ctx of CONTEXTS) {
    for (const descriptor of SETTINGS_SEARCH_DESCRIPTORS) {
      const availability = settingAvailability(descriptor, ctx);
      if (availability === true || availability === null) continue;
      assert.ok(availability.reason, `${descriptor.id} has a reason`);
      if (availability.prerequisite) {
        const prerequisite = findSettingDescriptor(availability.prerequisite);
        assert.ok(prerequisite, `${descriptor.id} → ${availability.prerequisite}`);
        assert.notEqual(prerequisite.id, descriptor.id);
        assert.equal(prerequisite.kind, "setting", `${prerequisite.id} lands on a setting`);
      }
    }
  }
});

async function searchIndex(ctx, lang = "en") {
  const lib = await load();
  const { t, tEn } = await translators(lang);
  return {
    ...lib,
    index: lib.buildSettingsSearchIndex({
      descriptors: lib.SETTINGS_SEARCH_DESCRIPTORS,
      ctx,
      t,
      tEn,
    }),
  };
}

test("with Cloud off, account results explain the prerequisite and link to it", async () => {
  const { index, rankSettings, settingsSearchAction } = await searchIndex(
    makeContext({ cloudDisabled: true, isSignedIn: false })
  );
  const results = rankSettings(index, "account");
  assert.ok(results.length > 0, "searching “account” is never empty");
  const profile = results.find((result) => result.entry.id === "page.account").entry;
  assert.equal(
    profile.unavailable.reason,
    "Hidden while “OpenWhispr account & Cloud” is off. Turn it on in Privacy & Data."
  );
  assert.equal(profile.unavailable.prerequisite, "privacy.cloud");
  assert.equal(profile.unavailable.prerequisiteTitle, "OpenWhispr account & Cloud");
  // Opening it goes to the switch, never to the hidden page.
  assert.deepEqual(settingsSearchAction(profile), {
    kind: "navigate",
    location: { page: "privacyData" },
    settingId: "privacy.cloud",
    destination: "#privacy.cloud",
  });
  for (const id of ["plans.pricing", "workspace.members", "privacy.insightsSync"]) {
    const entry = index.find((candidate) => candidate.id === id);
    assert.equal(entry.unavailable?.prerequisite, "privacy.cloud", id);
  }
  // The switch itself stays reachable, as does an integrations page that doesn't need Cloud.
  assert.equal(index.find((e) => e.id === "privacy.cloud").unavailable, undefined);
  assert.equal(
    index.find((e) => e.id === "elsewhere.integrations.calendars").unavailable,
    undefined
  );
  assert.ok(index.find((e) => e.id === "elsewhere.integrations.mcp").unavailable);
});

test("with the agent turned off by policy, assistant and chat results say so", async () => {
  const { index } = await searchIndex(makeContext({ agentAllowed: false }));
  const managed = "Managed by your organization";
  for (const id of [
    "page.llms.dictationAgent",
    "assistant.enabled",
    "assistant.model",
    "assistant.screenContext",
    "assistant.name",
    "chat.model",
    "chat.prompt",
    "hotkeys.assistant",
  ]) {
    const entry = index.find((candidate) => candidate.id === id);
    assert.equal(entry.unavailable?.reason, managed, id);
    assert.equal(entry.unavailable.prerequisite, undefined, `${id} has nothing to turn on`);
  }
  assert.equal(index.find((e) => e.id === "translation.enabled").unavailable, undefined);
});

test("with cleanup off, the cleanup model result leads to the cleanup toggle", async () => {
  const { index, settingsSearchAction } = await searchIndex(
    makeContext({ on: { cleanup: false } })
  );
  const model = index.find((entry) => entry.id === "dictation.cleanup.model");
  assert.equal(model.unavailable.reason, "Shown when “Enable text cleanup” is on.");
  assert.equal(model.unavailable.prerequisite, "dictation.cleanup.enabled");
  assert.deepEqual(settingsSearchAction(model), {
    kind: "navigate",
    location: { page: "cleanup" },
    settingId: "dictation.cleanup.enabled",
    destination: "#dictation.cleanup.enabled",
  });
  // The value still shows what cleanup would use.
  assert.equal(model.value, "Anthropic · Claude Haiku 4.5");
  for (const id of ["dictation.cleanup.model.thinking", "dictation.cleanup.model.keepLoaded"]) {
    assert.equal(
      index.find((e) => e.id === id).unavailable?.prerequisite,
      "dictation.cleanup.enabled"
    );
  }
});

test("platform, mode and parent rows explain themselves", async () => {
  const { index } = await searchIndex(
    makeContext({
      platform: "win32",
      on: { autoLanguage: false, localWhisper: false, noteFiles: false },
      localLlm: { dictationCleanup: false },
    })
  );
  const reason = (id) => index.find((e) => e.id === id).unavailable;
  assert.equal(reason("privacy.permissions.accessibility").reason, "Available on macOS only.");
  assert.equal(
    reason("dictation.output.waylandPaste").reason,
    "Available on Linux with Wayland only."
  );
  assert.equal(reason("dictation.language.chineseScript").prerequisite, "dictation.language");
  assert.equal(reason("dictation.stt.vad").prerequisite, "dictation.stt.engine");
  assert.equal(reason("notes.files.path").prerequisite, "notes.files.enabled");
  assert.equal(
    reason("dictation.cleanup.model.keepLoaded").prerequisite,
    "dictation.cleanup.model"
  );
  assert.equal(
    reason("dictation.stt.gpu").reason,
    "Shown on computers with more than one NVIDIA GPU."
  );
});

test("workspace results: People's tabs land on their tab, and wait for a chosen workspace", async () => {
  const { findSettingDescriptor, settingsSearchAction } = await load();
  // The ids the single Workspace page had still open their place.
  assert.deepEqual(settingsSearchAction({ id: "workspace.members" }), {
    kind: "navigate",
    location: { page: "workspacePeople", subTab: "members" },
    settingId: "workspace.members",
    destination: "#workspace.members",
  });
  assert.equal(findSettingDescriptor("workspace.general").location.page, "workspaceGeneral");
  assert.equal(findSettingDescriptor("workspace.developer").location.page, "workspaceDeveloper");

  const personal = await searchIndex(
    makeContext({ hasWorkspace: false, canManageWorkspace: false, canManageMembers: false })
  );
  const entry = (id) => personal.index.find((candidate) => candidate.id === id);
  for (const id of ["workspace.members", "workspace.guests", "page.workspaceTeamspaces"]) {
    assert.equal(entry(id).unavailable?.prerequisite, "workspace.general", id);
  }
  assert.equal(entry("workspace.general").unavailable, undefined, "General is where to choose one");

  const member = await searchIndex(makeContext({ canManageWorkspace: false, canManageMembers: false }));
  const memberEntry = (id) => member.index.find((candidate) => candidate.id === id);
  assert.equal(memberEntry("workspace.members").unavailable, undefined);
  assert.equal(
    memberEntry("workspace.invitations").unavailable?.reason,
    "Shown to workspace owners and admins."
  );
  assert.equal(
    memberEntry("page.workspaceDeveloper").unavailable?.reason,
    "Shown to workspace owners and admins."
  );
});

test("a signed-in user isn't offered the sign-in card", async () => {
  const signedIn = await searchIndex(makeContext({ isSignedIn: true }));
  assert.equal(
    signedIn.index.find((e) => e.id === "account.signIn"),
    undefined
  );
  const signedOut = await searchIndex(makeContext({ isSignedIn: false }));
  assert.ok(signedOut.index.find((e) => e.id === "account.signIn"));
  assert.equal(
    signedOut.index.find((e) => e.id === "account.delete").unavailable.prerequisite,
    "account.signIn"
  );
});

test("opening results: settings land on their id, pages navigate, app pages leave Settings", async () => {
  const { settingsSearchAction } = await load();
  assert.deepEqual(settingsSearchAction({ id: "preferences.theme" }), {
    kind: "navigate",
    location: { page: "appearance" },
    settingId: "preferences.theme",
    destination: "#preferences.theme",
  });
  assert.deepEqual(settingsSearchAction({ id: "page.llms.dictationAgent" }), {
    kind: "navigate",
    location: { page: "assistant" },
    settingId: undefined,
    destination: "#page.llms.dictationAgent",
  });
  assert.deepEqual(settingsSearchAction({ id: "elsewhere.integrations.calendars" }), {
    kind: "elsewhere",
    location: { view: "integrations", integrationsSection: "calendars" },
  });
  assert.deepEqual(settingsSearchAction({ id: "nope" }), { kind: "none" });
  assert.deepEqual(
    settingsSearchAction({ id: "privacy.permissions.accessibility", unavailable: { reason: "x" } }),
    { kind: "none" },
    "nothing to open when there is no prerequisite"
  );
});

test("Storage › Logs holds the logging rows, the old System ids included, and search finds them", async () => {
  const { findSettingDescriptor, settingsSearchAction } = await load();
  const anchors = sourceAnchors();
  const logsSection = path.join("components", "settings", "LogsSection.tsx");
  // The two System ids keep their names where the debug switch and the logs folder went.
  for (const id of [
    "system.developer.debug",
    "system.developer.logs",
    "storage.logs.retention",
    "storage.logs.text",
    "storage.logs.clear",
    "storage.logs.problems",
    "storage.logs.diagnostics",
  ]) {
    const descriptor = findSettingDescriptor(id);
    assert.equal(descriptor?.location.page, "storage", id);
    assert.equal(descriptor.anchor, id);
    assert.equal(descriptor.fallbackAnchor, undefined, `${id} always renders`);
    assert.deepEqual([...(anchors.get(id) ?? [])], [logsSection], id);
  }
  assert.deepEqual(settingsSearchAction({ id: "system.developer.debug" }), {
    kind: "navigate",
    location: { page: "storage" },
    settingId: "system.developer.debug",
    destination: "#system.developer.debug",
  });
  const diagnostics = findSettingDescriptor("system.diagnostics");
  assert.equal(diagnostics.location.page, "system");
  assert.deepEqual(
    [...anchors.get("system.diagnostics")],
    [path.join("components", "settings", "DiagnosticsSection.tsx")]
  );

  const { index, rankSettings } = await searchIndex(makeContext());
  const top = (query) => rankSettings(index, query)[0]?.entry.id;
  assert.equal(top("clear logs"), "storage.logs.clear");
  assert.equal(top("include dictated text"), "storage.logs.text");
  for (const [query, id] of [
    ["debug", "system.developer.debug"],
    ["logging", "system.developer.debug"],
    ["log size", "system.developer.logs"],
    ["diagnostics", "system.diagnostics"],
    ["keep logs", "storage.logs.retention"],
  ]) {
    const ids = rankSettings(index, query).map((result) => result.entry.id);
    assert.ok(ids.includes(id), `"${query}" finds ${id} (${ids.slice(0, 5).join(", ")})`);
  }
});

test("Storage holds recordings and the inventory: moved ids keep their names, search finds the new rows", async () => {
  const { findSettingDescriptor, settingsSearchAction } = await load();
  const anchors = sourceAnchors();
  const file = (name) => path.join("components", "settings", name);
  // Audio retention and storage came from Privacy & Data, the model cache from System.
  for (const [id, where] of [
    ["privacy.audioRetention", "RecordingsSection.tsx"],
    ["privacy.audioStorage", "RecordingsSection.tsx"],
    ["storage.recordings.quality", "RecordingsSection.tsx"],
    ["storage.recordings.folder", "RecordingsSection.tsx"],
    ["storage.inventory", "StorageInventorySections.tsx"],
    ["storage.database", "StorageInventorySections.tsx"],
    ["storage.settings", "StorageInventorySections.tsx"],
    ["storage.secrets", "StorageInventorySections.tsx"],
    ["storage.models", "StorageInventorySections.tsx"],
    ["system.data.modelCache", "StorageInventorySections.tsx"],
    ["storage.searchIndex", "StorageInventorySections.tsx"],
    ["storage.appCache", "StorageInventorySections.tsx"],
    ["storage.cliBridge", "StorageInventorySections.tsx"],
  ]) {
    const descriptor = findSettingDescriptor(id);
    assert.equal(descriptor?.location.page, "storage", id);
    assert.equal(descriptor.anchor, id);
    assert.equal(descriptor.fallbackAnchor, undefined, `${id} always renders`);
    assert.deepEqual([...(anchors.get(id) ?? [])], [file(where)], id);
  }
  // Privacy & Data keeps summaries with anchors of their own.
  for (const id of ["privacy.recordingsSummary", "privacy.logsSummary"]) {
    assert.equal(findSettingDescriptor(id)?.location.page, "privacyData", id);
    assert.deepEqual([...anchors.get(id)], [file("PrivacyStorageSummary.tsx")], id);
  }
  assert.deepEqual(settingsSearchAction({ id: "privacy.audioRetention" }), {
    kind: "navigate",
    location: { page: "storage" },
    settingId: "privacy.audioRetention",
    destination: "#privacy.audioRetention",
  });

  const { index, rankSettings } = await searchIndex(makeContext());
  assert.equal(rankSettings(index, "recording quality")[0]?.entry.id, "storage.recordings.quality");
  assert.equal(rankSettings(index, "keep recordings")[0]?.entry.id, "privacy.audioRetention");
  for (const [query, id] of [
    ["audio retention", "privacy.audioRetention"],
    ["1 year", "privacy.audioRetention"],
    ["bitrate", "storage.recordings.quality"],
    ["clear recordings", "privacy.audioStorage"],
    ["recordings folder", "storage.recordings.folder"],
    ["disk space", "storage.inventory"],
    ["storage", "storage.inventory"],
    ["where are my files", "storage.inventory"],
    ["folder", "storage.recordings.folder"],
    ["database", "storage.database"],
    ["cache", "storage.appCache"],
    ["model cache", "system.data.modelCache"],
    ["delete models", "system.data.modelCache"],
    ["search index", "storage.searchIndex"],
    ["api keys", "storage.secrets"],
  ]) {
    const ids = rankSettings(index, query).map((result) => result.entry.id);
    assert.ok(ids.includes(id), `"${query}" finds ${id} (${ids.slice(0, 5).join(", ")})`);
  }
});

test("Azure Speech's connection is found by the names Foundry shows it under", async () => {
  const { index, rankSettings } = await searchIndex(makeContext());
  for (const query of ["foundry", "azure ai foundry", "services.ai", "services.ai.azure.com"]) {
    const ids = rankSettings(index, query).map((result) => result.entry.id);
    assert.ok(
      ids.includes("connections.azureSpeech"),
      `"${query}" finds connections.azureSpeech (${ids.slice(0, 5).join(", ")})`
    );
  }
});
