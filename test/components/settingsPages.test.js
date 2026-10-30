const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { LOCALES, readLocale } = require("../lib/settingsSearchFixtures");

// The Settings page tree and its destinations: every string `openSettings`
// accepted before pages still lands on the page that holds what it named,
// hidden pages fall back, the retired saved-tab keys are used once, and every
// Preferences block lives on exactly one page.

const SRC = path.join(__dirname, "..", "..", "src");

async function load() {
  const pages = await import("../../src/components/settings/settingsPages.ts");
  const navigation = await import("../../src/components/settings/settingsNavigation.ts");
  const registry = await import("../../src/components/settings/search/registry.ts");
  return {
    ...(pages.default ?? pages),
    ...(navigation.default ?? navigation),
    locateSetting: (registry.default ?? registry).locateSetting,
  };
}

const ALL = { cloudDisabled: false, isSignedIn: true, agentAllowed: true };
const CLOUD_OFF = { cloudDisabled: true, isSignedIn: false, agentAllowed: true };

// Where each name Settings accepted before pages lands now.
const LEGACY_PAGES = {
  // The nine sections.
  account: "account",
  plansBilling: "plansBilling",
  workspace: "workspace",
  general: "appearance",
  hotkeys: "hotkeys",
  speechToText: "recognition",
  llms: "cleanup",
  privacyData: "privacyData",
  system: "system",
  // Aliases and legacy sub-tab names.
  aiModels: "cleanup",
  agentConfig: "chat",
  agentMode: "chat",
  dictationAgent: "assistant",
  intelligence: "cleanup",
  meetings: "noteFormatting",
  prompts: "cleanup",
  transcription: "recognition",
  uploadTranscription: "fileTranscription",
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
};

function sourceFiles(directory = SRC) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "locales" || entry.name === "dist" ? [] : sourceFiles(absolute);
    }
    return /\.(tsx?|jsx?)$/.test(entry.name) ? [absolute] : [];
  });
}

/** The arguments of each call to `name(` in the text, parentheses balanced. */
function callArguments(text, name) {
  const calls = [];
  const pattern = new RegExp(`\\b${name.replace(/[?.]/g, "\\$&")}\\(`, "g");
  for (const match of text.matchAll(pattern)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < text.length && depth > 0) {
      if (text[index] === "(") depth++;
      else if (text[index] === ")") depth--;
      index++;
    }
    calls.push(text.slice(start, index - 1));
  }
  return calls;
}

/** Every literal destination string a renderer call site passes to Settings. */
function destinationCallSites() {
  const found = new Map();
  const add = (value, file) => {
    if (!found.has(value)) found.set(value, new Set());
    found.get(value).add(path.relative(SRC, file));
  };
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, "utf8");
    for (const name of [
      "openSettings",
      "onOpenSettings",
      "onOpenSettings?.",
      "setPostOnboardingSettingsSection",
    ]) {
      for (const args of callArguments(text, name)) {
        for (const literal of args.matchAll(/"([A-Za-z#.]+)"/g)) add(literal[1], file);
      }
    }
  }
  return found;
}

test("every name Settings accepted before pages resolves to the page that holds it", async () => {
  const { resolveSettingsDestination, SECTION_ALIASES, LEGACY_SUB_TAB } = await load();
  // The table covers every alias, legacy sub-tab name and section.
  for (const name of [...Object.keys(SECTION_ALIASES), ...Object.keys(LEGACY_SUB_TAB)]) {
    assert.ok(name in LEGACY_PAGES, `${name} is in the table`);
  }
  for (const [name, page] of Object.entries(LEGACY_PAGES)) {
    assert.deepEqual(resolveSettingsDestination(name, { ctx: ALL }), { page }, name);
  }
});

test("every destination a call site passes today resolves (call sites read from src)", async () => {
  const { resolveSettingsDestination, isSettingsPageId } = await load();
  const sites = destinationCallSites();
  // The GPU banner, provider errors, post-onboarding and the upload views.
  for (const expected of [
    "transcription",
    "intelligence",
    "dictationAgent",
    "uploadTranscription",
    "privacyData",
    "plansBilling",
    "account",
  ]) {
    assert.ok(sites.has(expected), `found the call site passing "${expected}"`);
  }
  for (const [value, files] of sites) {
    const known = value in LEGACY_PAGES || isSettingsPageId(value) || value.includes("#");
    assert.ok(known, `"${value}" (${[...files].join(", ")}) is a known destination`);
    const { page } = resolveSettingsDestination(value, { ctx: ALL });
    if (value in LEGACY_PAGES) assert.equal(page, LEGACY_PAGES[value], value);
  }
});

test("provider-error targets (main's allow-list) land on their pages", async () => {
  const { resolveSettingsDestination } = await load();
  const text = fs.readFileSync(path.join(SRC, "helpers", "providerHttpErrors.js"), "utf8");
  const targets = [
    ...(text.match(/PROVIDER_SETTINGS_TARGETS = Object\.freeze\(\[([^\]]*)\]/)?.[1] ?? "").matchAll(
      /"([^"]+)"/g
    ),
  ].map((match) => match[1]);
  assert.deepEqual(targets.sort(), ["llms", "speechToText"]);
  for (const target of targets) {
    assert.equal(resolveSettingsDestination(target, { ctx: ALL }).page, LEGACY_PAGES[target]);
  }
});

test("page ids, parents and settings resolve; a setting's page wins over the name", async () => {
  const { resolveSettingsDestination, SETTINGS_PAGE_IDS, locateSetting } = await load();
  for (const page of SETTINGS_PAGE_IDS) {
    assert.deepEqual(resolveSettingsDestination(page, { ctx: ALL }), { page }, page);
  }
  assert.equal(resolveSettingsDestination("dictation", { ctx: ALL }).page, "overview");
  // Overview is Dictation's first page, also with Cloud off and without the agent.
  assert.equal(resolveSettingsDestination("dictation", { ctx: CLOUD_OFF }).page, "overview");
  assert.equal(
    resolveSettingsDestination("dictation", { ctx: { ...ALL, agentAllowed: false } }).page,
    "overview"
  );
  assert.equal(resolveSettingsDestination("notes", { ctx: ALL }).page, "liveRecording");
  assert.equal(resolveSettingsDestination("app", { ctx: ALL }).page, "appearance");

  const resolve = (destination, ctx = ALL) =>
    resolveSettingsDestination(destination, { ctx, locateSetting });
  assert.deepEqual(resolve("#dictation.cleanup.model"), {
    page: "cleanup",
    settingId: "dictation.cleanup.model",
  });
  assert.deepEqual(resolve("cleanup#dictation.styles.list"), {
    page: "styles",
    settingId: "dictation.styles.list",
  });
  // The registry wins over a stale page or section name.
  assert.deepEqual(resolve("system#preferences.theme"), {
    page: "appearance",
    settingId: "preferences.theme",
  });
  assert.deepEqual(resolve("general#dictation.output.autoPaste"), {
    page: "output",
    settingId: "dictation.output.autoPaste",
  });
  // An unknown id falls back to the name part, legacy names included.
  assert.deepEqual(resolve("meetings#gone.setting"), {
    page: "noteFormatting",
    settingId: "gone.setting",
  });
  assert.deepEqual(resolve("hotkeys#gone.setting"), { page: "hotkeys", settingId: "gone.setting" });
  // A Workspace tab comes along.
  assert.deepEqual(resolve("#workspace.members"), {
    page: "workspace",
    subTab: "members",
    settingId: "workspace.members",
  });
  // Unknown names and nothing at all open the default page.
  assert.deepEqual(resolve("nope"), { page: "account" });
  assert.deepEqual(resolve(undefined), { page: "account" });
  assert.deepEqual(resolve(undefined, CLOUD_OFF), { page: "recognition" });
});

test("hidden pages fall back to a visible one", async () => {
  const { resolveSettingsDestination, shownSettingsPage, locateSetting } = await load();
  const resolve = (destination, ctx) =>
    resolveSettingsDestination(destination, { ctx, locateSetting }).page;
  // Cloud off: the account group is gone.
  for (const name of ["account", "plansBilling", "workspace", "#account.name", "#plans.pricing"]) {
    assert.equal(resolve(name, CLOUD_OFF), "recognition", name);
  }
  // Signed out, Cloud on: Workspace falls back to Profile.
  const signedOut = { ...ALL, isSignedIn: false };
  assert.equal(resolve("workspace", signedOut), "account");
  assert.equal(resolve("#workspace.members", signedOut), "account");
  // Agent policy off: the voice assistant and chat fall back to Cleanup (as LlmsTabs did).
  const noAgent = { ...ALL, agentAllowed: false };
  for (const name of ["assistant", "chat", "dictationAgent", "agentMode", "#assistant.enabled"]) {
    assert.equal(resolve(name, noAgent), "cleanup", name);
  }
  assert.equal(shownSettingsPage("chat", noAgent), "cleanup");
  // Visible pages stay put.
  assert.equal(shownSettingsPage("translation", noAgent), "translation");
});

test("the Cloud switch flipping while Settings is open moves off an account page, and back", async () => {
  const { initialSettingsNavigation, nextSettingsRequest, shownSettingsPage } = await load();
  const state = initialSettingsNavigation(nextSettingsRequest(null, "plansBilling"), { ctx: ALL });
  assert.equal(state.page, "plansBilling");
  // Turned off with Plans & Billing open: the page shown falls back...
  assert.equal(shownSettingsPage(state.page, CLOUD_OFF), "recognition");
  // ...without forgetting it, so turning Cloud back on shows it again.
  assert.equal(shownSettingsPage(state.page, ALL), "plansBilling");
});

test("the nav hides what the context hides, and lists every page once", async () => {
  const { SETTINGS_NAV, SETTINGS_PAGE_IDS, SETTINGS_PAGES, visibleSettingsNav } = await load();
  const pagesIn = (nav) =>
    nav.flatMap((group) =>
      group.items.flatMap((item) =>
        item.kind === "page" ? [item.page] : item.kind === "parent" ? [...item.pages] : []
      )
    );
  const all = pagesIn(SETTINGS_NAV);
  assert.deepEqual(all, [...SETTINGS_PAGE_IDS]);
  assert.equal(new Set(all).size, all.length, "no page twice");
  assert.deepEqual(Object.keys(SETTINGS_PAGES).sort(), [...all].sort());

  assert.deepEqual(pagesIn(visibleSettingsNav(ALL)), all);
  const cloudOff = visibleSettingsNav(CLOUD_OFF);
  assert.ok(!cloudOff.some((group) => group.id === "account"), "the Account group is gone");
  assert.ok(!pagesIn(visibleSettingsNav({ ...ALL, isSignedIn: false })).includes("workspace"));
  const noAgent = pagesIn(visibleSettingsNav({ ...ALL, agentAllowed: false }));
  assert.ok(!noAgent.includes("assistant") && !noAgent.includes("chat"));
  assert.ok(noAgent.includes("translation"));

  // Elsewhere comes last and leaves Settings for the app's views.
  const last = SETTINGS_NAV[SETTINGS_NAV.length - 1];
  assert.equal(last.id, "elsewhere");
  assert.deepEqual(
    last.items.map((item) => item.kind === "elsewhere" && item.location.view),
    ["dictionary", "integrations"]
  );
});

test("the breadcrumb names the parent (or group) and the page", async () => {
  const { settingsBreadcrumbKeys } = await load();
  assert.deepEqual(settingsBreadcrumbKeys("cleanup"), [
    "settingsNav.parents.dictation",
    "settingsNav.pages.cleanup.title",
  ]);
  assert.deepEqual(settingsBreadcrumbKeys("translation"), [
    "settingsNav.groups.features",
    "settingsPage.llms.tabs.dictationTranslation",
  ]);
  assert.deepEqual(settingsBreadcrumbKeys("hotkeys"), [
    "settingsNav.parents.app",
    "settingsModal.sections.hotkeys.label",
  ]);
});

test("every nav string exists in all 11 locales", async () => {
  const { SETTINGS_NAV, SETTINGS_PAGES } = await load();
  const keys = new Set(["settingsNav.switch.on", "settingsNav.switch.off"]);
  for (const group of SETTINGS_NAV) {
    keys.add(group.labelKey);
    for (const item of group.items) if (item.kind !== "page") keys.add(item.titleKey);
  }
  for (const page of Object.values(SETTINGS_PAGES)) {
    keys.add(page.titleKey);
    keys.add(page.descriptionKey);
  }
  // Header pills (SettingsPageHeader asks for them by name).
  const header = fs.readFileSync(
    path.join(SRC, "components", "settings", "SettingsPageHeader.tsx"),
    "utf8"
  );
  for (const match of header.matchAll(/t\("(settingsNav\.[A-Za-z.]+)"/g)) keys.add(match[1]);
  const get = (data, key) => key.split(".").reduce((node, part) => node?.[part], data);
  for (const lang of LOCALES) {
    const data = readLocale(lang);
    const missing = [...keys].filter((key) => typeof get(data, key) !== "string");
    assert.deepEqual(missing, [], `${lang} is missing keys`);
  }
});

test("AI Connections & Local Models opens from Setup, its cards and its links", async () => {
  const { SETTINGS_NAV, resolveSettingsDestination, locateSetting, settingsBreadcrumbKeys } =
    await load();
  const providers = await import("../../src/components/settings/connectionProviders.ts");
  const { CONNECTION_PROVIDERS, connectionAnchor, connectionDestination } =
    providers.default ?? providers;

  // First in Setup, before App & Controls, on its own (no parent).
  const setup = SETTINGS_NAV.find((group) => group.id === "setup");
  assert.deepEqual(setup.items[0], { kind: "page", page: "connections" });
  assert.equal(setup.items[1].kind === "parent" && setup.items[1].id, "app");
  assert.deepEqual(settingsBreadcrumbKeys("connections"), [
    "settingsNav.groups.setup",
    "settingsNav.pages.connections.title",
  ]);

  const resolve = (destination, ctx = ALL) =>
    resolveSettingsDestination(destination, { ctx, locateSetting });
  assert.deepEqual(resolve("connections"), { page: "connections" });
  // Visible with Cloud off and without the agent: keys serve every feature.
  assert.deepEqual(resolve("connections", CLOUD_OFF), { page: "connections" });
  assert.deepEqual(resolve("connections", { ...ALL, agentAllowed: false }), {
    page: "connections",
  });
  // Every provider card, Copilot and Cloud ("Manage keys in AI Connections ›").
  // Anchors are camelCase: Azure Speech's id is "azure-speech", its anchor "connections.azureSpeech".
  assert.equal(connectionAnchor("azure-speech"), "connections.azureSpeech");
  for (const id of [...CONNECTION_PROVIDERS.map((provider) => provider.id), "copilot", "cloud"]) {
    assert.deepEqual(resolve(connectionDestination(id)), {
      page: "connections",
      settingId: connectionAnchor(id),
    });
  }
  assert.deepEqual(resolve("#connections.localModels"), {
    page: "connections",
    settingId: "connections.localModels",
  });
  // The page's own links out.
  for (const [destination, page] of [
    ["privacyData#privacy.cloud", "privacyData"],
    ["account#account.signIn", "account"],
    ["cleanup#dictation.cleanup.model", "cleanup"],
  ]) {
    assert.equal(resolve(destination).page, page, destination);
  }
});

test("the retired saved tabs are read once, mapped to pages and removed", async () => {
  const { takeSavedLegacyTabs, RETIRED_TAB_KEYS } = await load();
  const store = new Map([
    [RETIRED_TAB_KEYS.llms, JSON.stringify("dictationTranslation")],
    [RETIRED_TAB_KEYS.speechToText, JSON.stringify("upload")],
    ["unrelated", "kept"],
  ]);
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    removeItem: (key) => store.delete(key),
  };
  assert.deepEqual(takeSavedLegacyTabs(storage), {
    llms: "translation",
    speechToText: "fileTranscription",
  });
  assert.deepEqual([...store.keys()], ["unrelated"], "both keys are gone");
  assert.deepEqual(takeSavedLegacyTabs(storage), {}, "a second read finds nothing");

  // Unknown or unreadable values are dropped (and still removed).
  store.set(RETIRED_TAB_KEYS.llms, "not json");
  store.set(RETIRED_TAB_KEYS.speechToText, JSON.stringify("gone"));
  assert.deepEqual(takeSavedLegacyTabs(storage), {});
  assert.deepEqual([...store.keys()], ["unrelated"]);
  assert.deepEqual(takeSavedLegacyTabs(undefined), {});
});

test("a bare llms / speechToText uses the saved tab once, then the default page", async () => {
  const { applySettingsRequest, initialSettingsNavigation, nextSettingsRequest } = await load();
  const savedTabs = { llms: "chat", speechToText: "liveRecording" };
  const first = nextSettingsRequest(null, "llms");
  let state = initialSettingsNavigation(first, { ctx: ALL, savedTabs });
  assert.equal(state.page, "chat", "the tab Language Models last showed");
  assert.deepEqual(state.savedTabs, { speechToText: "liveRecording" });

  const second = nextSettingsRequest(first, "llms");
  state = applySettingsRequest(state, second, { ctx: ALL });
  assert.equal(state.page, "cleanup", "used up: the default page now");

  // A named sub-tab never uses (or spends) the saved one.
  const third = nextSettingsRequest(second, "transcription");
  state = applySettingsRequest(state, third, { ctx: ALL });
  assert.equal(state.page, "recognition");
  assert.deepEqual(state.savedTabs, { speechToText: "liveRecording" });

  const fourth = nextSettingsRequest(third, "speechToText");
  state = applySettingsRequest(state, fourth, { ctx: ALL });
  assert.equal(state.page, "liveRecording");
  assert.deepEqual(state.savedTabs, {});
});

test("nothing reads or writes the retired tab keys any more", () => {
  const offenders = sourceFiles()
    .filter((file) => !file.endsWith(path.join("settings", "settingsPages.ts")))
    .filter((file) => /settings\.(llmsTab|speechToTextTab)/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(SRC, file));
  assert.deepEqual(offenders, []);
  const page = fs.readFileSync(path.join(SRC, "components", "SettingsPage.tsx"), "utf8");
  assert.doesNotMatch(page, /useSubTab|useLocalStorage/);
});

// SettingsPage wraps each Preferences block in `show("<blockId>")`; settingsPages.ts
// says which page shows it.
test("every Preferences block is on exactly one page, and every listed block exists", async () => {
  const { SETTINGS_PAGES } = await load();
  const page = fs.readFileSync(path.join(SRC, "components", "SettingsPage.tsx"), "utf8");
  const used = new Set([...page.matchAll(/\bshow\("([^"]+)"\)/g)].map((match) => match[1]));
  assert.ok(used.size >= 13, `${used.size} blocks`);
  const owners = new Map();
  for (const [id, def] of Object.entries(SETTINGS_PAGES)) {
    for (const block of def.blocks ?? []) {
      if (!owners.has(block)) owners.set(block, []);
      owners.get(block).push(id);
    }
  }
  for (const block of used) {
    assert.deepEqual(
      owners.get(block)?.length,
      1,
      `${block} is on one page (${owners.get(block)})`
    );
  }
  for (const block of owners.keys()) assert.ok(used.has(block), `SettingsPage shows "${block}"`);
});

test("SettingsPage keeps visited pages mounted and wraps blocks, not moves them", () => {
  const page = fs.readFileSync(path.join(SRC, "components", "SettingsPage.tsx"), "utf8");
  // One body per visited page, hidden when it isn't the page shown.
  assert.match(page, /SETTINGS_PAGE_IDS\.filter\(\(id\) => visitedPages\.has\(id\)\)/);
  assert.match(page, /data-settings-page-id=\{id\}/);
  assert.match(page, /className=\{id === page \? undefined : "hidden"\}/);
  // Section-level dialogs stay outside every page body.
  const pagesAt = page.indexOf("SETTINGS_PAGE_IDS.filter(");
  for (const dialog of ["<ConfirmDialog", "<AlertDialog", "{insightsOptInDialog}"]) {
    const at = page.indexOf(dialog, page.indexOf("return (\n    <>"));
    assert.ok(at > 0 && at < pagesAt, `${dialog} renders outside the pages`);
  }
  // The feature switches moved into the page header: one control each.
  assert.match(page, /<AiModelsSection[\s\S]*?enableToggleInHeader/);
  assert.match(page, /<DictationAgentSettings hideEnableToggle \/>/);
  assert.match(page, /<DictationTranslationSettings hideEnableToggle \/>/);
});

test("feature headers: the prompt in use, and what shares Cleanup's model", async () => {
  const status = await import("../../src/components/settings/featurePageStatus.ts");
  const { activePromptName, noteFormattingInheritsCleanup, cleanupSharedWith } =
    status.default ?? status;
  const t = (key) => key;
  const library = (activeId, entries = []) => ({ version: 1, activeId, entries });
  const entry = (id, name) => ({ id, name, text: "x", updatedAt: 0, origin: "user" });
  assert.equal(activePromptName(undefined, t), "promptStudio.library.defaultName");
  assert.equal(activePromptName(library("default"), t), "promptStudio.library.defaultName");
  assert.equal(activePromptName(library("a", [entry("a", "Mine")]), t), "Mine");
  assert.equal(
    activePromptName(library("a", [entry("a", "")]), t),
    "promptStudio.library.untitled"
  );
  assert.equal(activePromptName(library("gone"), t), "promptStudio.library.defaultName");

  const nf = (mode, fields = {}) => ({
    noteFormattingMode: mode,
    noteFormattingProvider: "",
    noteFormattingModel: "",
    noteFormattingRemoteUrl: "",
    ...fields,
  });
  assert.equal(noteFormattingInheritsCleanup(nf("openwhispr")), false);
  assert.equal(noteFormattingInheritsCleanup(nf("enterprise")), false);
  assert.equal(noteFormattingInheritsCleanup(nf("providers")), true);
  assert.equal(
    noteFormattingInheritsCleanup(
      nf("providers", { noteFormattingProvider: "openai", noteFormattingModel: "gpt" })
    ),
    false
  );
  assert.equal(
    noteFormattingInheritsCleanup(nf("providers", { noteFormattingProvider: "openai" })),
    true
  );
  assert.equal(noteFormattingInheritsCleanup(nf("local", { noteFormattingModel: "qwen" })), false);
  assert.equal(
    noteFormattingInheritsCleanup(nf("self-hosted", { noteFormattingModel: "llama" })),
    true
  );

  assert.deepEqual(cleanupSharedWith({ stylesInUse: true, noteFormattingInherits: true }), [
    "styles",
    "noteFormatting",
  ]);
  assert.deepEqual(cleanupSharedWith({ stylesInUse: false, noteFormattingInherits: false }), []);
});

test("Dictation › Overview comes first; Overview, Styles and Hotkeys lay out wide", async () => {
  const {
    SETTINGS_NAV,
    SETTINGS_PAGES,
    SETTINGS_PAGE_IDS,
    firstSettingsPageOf,
    isWideSettingsPage,
    resolveSettingsDestination,
    settingsBreadcrumbKeys,
    settingsPageParent,
    locateSetting,
  } = await load();
  const dictation = SETTINGS_NAV.flatMap((group) => group.items).find(
    (item) => item.kind === "parent" && item.id === "dictation"
  );
  assert.deepEqual(dictation.pages, ["overview", "recognition", "cleanup", "styles", "output"]);
  assert.equal(firstSettingsPageOf("dictation", ALL), "overview");
  assert.equal(firstSettingsPageOf("dictation", CLOUD_OFF), "overview");
  assert.equal(settingsPageParent("overview"), "dictation");
  assert.deepEqual(settingsBreadcrumbKeys("overview"), [
    "settingsNav.parents.dictation",
    "settingsNav.pages.overview.title",
  ]);
  // By id, by setting, and the parent; nothing that named another page moved.
  const resolve = (destination, ctx = ALL) =>
    resolveSettingsDestination(destination, { ctx, locateSetting });
  assert.deepEqual(resolve("overview"), { page: "overview" });
  assert.deepEqual(resolve("#dictation.overview.lastDictation"), {
    page: "overview",
    settingId: "dictation.overview.lastDictation",
  });
  assert.deepEqual(resolve("#hotkeys.cancel"), { page: "hotkeys", settingId: "hotkeys.cancel" });
  for (const [name, page] of Object.entries(LEGACY_PAGES)) {
    assert.equal(resolve(name).page, page, name);
  }
  // The default page and hidden-page fallbacks stay where they were.
  assert.deepEqual(resolve(undefined, CLOUD_OFF), { page: "recognition" });
  assert.equal(resolve("account", CLOUD_OFF).page, "recognition");

  const wide = SETTINGS_PAGE_IDS.filter((page) => isWideSettingsPage(page));
  assert.deepEqual(wide.sort(), ["hotkeys", "overview", "styles"]);
  assert.equal(SETTINGS_PAGES.cleanup.wide, undefined, "feature pages keep the reading width");
});

test("Storage sits in Data between Privacy & Data and System, with its own title and icon", async () => {
  const { SETTINGS_NAV, SETTINGS_PAGES, resolveSettingsDestination, settingsBreadcrumbKeys } =
    await load();
  const data = SETTINGS_NAV.find((group) => group.id === "data");
  assert.deepEqual(
    data.items.map((item) => item.kind === "page" && item.page),
    ["privacyData", "storage", "system"]
  );
  assert.equal(SETTINGS_PAGES.storage.icon, "HardDrive");
  assert.deepEqual(settingsBreadcrumbKeys("storage"), [
    "settingsNav.groups.data",
    "settingsNav.pages.storage.title",
  ]);
  // Visible whatever Cloud, sign-in and agent policy say.
  for (const ctx of [ALL, CLOUD_OFF, { ...ALL, agentAllowed: false }]) {
    assert.deepEqual(resolveSettingsDestination("storage", { ctx }), { page: "storage" });
  }
});
