const test = require("node:test");
const assert = require("node:assert/strict");

// Destinations and request identity for the Settings layer: legacy deep links,
// repeated requests, bare reopen, hidden sections, in-Settings links and the
// cold-start drain of a section main kept waiting.

async function load() {
  const sections = await import("../../src/components/settingsSections.ts");
  const navigation = await import("../../src/components/settings/settingsNavigation.ts");
  return { ...(sections.default ?? sections), ...(navigation.default ?? navigation) };
}

test("legacy names and aliases land on their section and sub-tab", async () => {
  const { resolveSettingsDestination } = await load();
  const expectations = {
    meetings: { section: "llms", subTab: "noteFormatting" },
    intelligence: { section: "llms", subTab: "dictationCleanup" },
    prompts: { section: "llms", subTab: "dictationCleanup" },
    aiModels: { section: "llms", subTab: "dictationCleanup" },
    agentMode: { section: "llms", subTab: "chatIntelligence" },
    agentConfig: { section: "llms", subTab: "chatIntelligence" },
    dictationAgent: { section: "llms", subTab: "dictationAgent" },
    transcription: { section: "speechToText", subTab: "dictation" },
    uploadTranscription: { section: "speechToText", subTab: "upload" },
    softwareUpdates: { section: "system", subTab: undefined },
    developer: { section: "system", subTab: undefined },
    privacy: { section: "privacyData", subTab: undefined },
    permissions: { section: "privacyData", subTab: undefined },
    hotkeys: { section: "hotkeys", subTab: undefined },
    llms: { section: "llms", subTab: undefined },
    plansBilling: { section: "plansBilling", subTab: undefined },
  };
  for (const [requested, expected] of Object.entries(expectations)) {
    assert.deepEqual(resolveSettingsDestination(requested, false), expected, requested);
  }
});

test("no section opens on the default page, Preferences while Cloud is off", async () => {
  const { resolveSettingsDestination } = await load();
  assert.deepEqual(resolveSettingsDestination(undefined, false), {
    section: "account",
    subTab: undefined,
  });
  assert.deepEqual(resolveSettingsDestination(undefined, true), {
    section: "general",
    subTab: undefined,
  });
});

test("account sections hidden with Cloud off fall back to Preferences", async () => {
  const { resolveSettingsDestination, shownSettingsSection } = await load();
  for (const section of ["account", "plansBilling", "workspace"]) {
    assert.equal(resolveSettingsDestination(section, true).section, "general", section);
  }
  // The switch flipping while Settings is open moves off an account page...
  assert.equal(shownSettingsSection("account", true), "general");
  // ...without forgetting it, so turning Cloud back on shows it again.
  assert.equal(shownSettingsSection("account", false), "account");
});

test("each named request gets a new id", async () => {
  const { nextSettingsRequest } = await load();
  const first = nextSettingsRequest(null, "meetings");
  const second = nextSettingsRequest(first, "meetings");
  assert.deepEqual(first, { section: "meetings", id: 1 });
  assert.deepEqual(second, { section: "meetings", id: 2 });
});

test("first mount opens the request it was created for, or the default page", async () => {
  const { initialSettingsNavigation, nextSettingsRequest } = await load();
  const opened = initialSettingsNavigation(nextSettingsRequest(null, "meetings"), false);
  assert.equal(opened.section, "llms");
  assert.equal(opened.subTab, "noteFormatting");
  assert.equal(opened.requestId, 1);

  const bare = initialSettingsNavigation(null, true);
  assert.equal(bare.section, "general");
  assert.equal(bare.requestId, 0);
});

test("a repeated named request navigates again after the user moved elsewhere", async () => {
  const {
    applySettingsRequest,
    initialSettingsNavigation,
    navigateWithinSettings,
    nextSettingsRequest,
  } = await load();
  const first = nextSettingsRequest(null, "transcription");
  let state = initialSettingsNavigation(first, false);
  assert.equal(state.section, "speechToText");

  state = navigateWithinSettings(state, "hotkeys");
  assert.equal(state.section, "hotkeys");

  const again = nextSettingsRequest(first, "transcription");
  const before = state.navigationId;
  state = applySettingsRequest(state, again, false);
  assert.equal(state.section, "speechToText");
  assert.equal(state.subTab, "dictation");
  assert.equal(state.requestId, again.id);
  // The sub-tab is unchanged, so only the new navigation id makes it re-apply.
  assert.ok(state.navigationId > before);

  // The same request object seen again (a re-render) changes nothing.
  assert.equal(applySettingsRequest(state, again, false), state);
});

test("the same section requested twice in a row still bumps the navigation", async () => {
  const { applySettingsRequest, initialSettingsNavigation, nextSettingsRequest } = await load();
  const first = nextSettingsRequest(null, "meetings");
  const opened = initialSettingsNavigation(first, false);
  const repeated = applySettingsRequest(opened, nextSettingsRequest(first, "meetings"), false);
  assert.equal(repeated.section, "llms");
  assert.equal(repeated.subTab, "noteFormatting");
  assert.equal(repeated.navigationId, opened.navigationId + 1);
});

test("a bare reopen keeps the page Settings was on", async () => {
  const {
    applySettingsRequest,
    initialSettingsNavigation,
    navigateWithinSettings,
    nextSettingsRequest,
  } = await load();
  const request = nextSettingsRequest(null, "meetings");
  let state = initialSettingsNavigation(request, false);
  state = navigateWithinSettings(state, "privacyData");
  // Ctrl+, and the sidebar's Settings button open without a new request.
  assert.equal(applySettingsRequest(state, request, false), state);
  assert.equal(applySettingsRequest(state, request, false).section, "privacyData");
});

test("Hotkeys → a style opens Cleanup again, even when it is already the sub-tab", async () => {
  const { initialSettingsNavigation, navigateWithinSettings } = await load();
  let state = initialSettingsNavigation(null, false);
  state = navigateWithinSettings(state, "llms", "dictationCleanup");
  const first = state.navigationId;
  state = navigateWithinSettings(state, "hotkeys");
  state = navigateWithinSettings(state, "llms", "dictationCleanup");
  assert.equal(state.section, "llms");
  assert.equal(state.subTab, "dictationCleanup");
  assert.ok(state.navigationId > first + 1);
});

test("the cold-start drain opens the waiting section; a bare show keeps the page", async () => {
  const { drainPendingSettingsSection } = await load();
  const calls = [];
  const open = (...args) => calls.push(args);

  await drainPendingSettingsSection(async () => "privacyData", open, false);
  assert.deepEqual(calls, [["privacyData"]]);

  calls.length = 0;
  await drainPendingSettingsSection(async () => null, open, false);
  assert.deepEqual(calls, [], "nothing waiting on mount opens nothing");

  await drainPendingSettingsSection(async () => null, open, true);
  assert.deepEqual(calls, [[]], "the app menu's Settings opens without a section");

  calls.length = 0;
  await drainPendingSettingsSection(() => undefined, open, true);
  assert.deepEqual(calls, [[]], "a preload without the IPC still opens Settings");
});

// SettingsPage is too large to render here: its sub-tab hooks must re-apply on
// every navigation id, and Hotkeys → a style still asks Style Studio for focus
// before opening Cleanup.
test("SettingsPage re-applies a requested sub-tab on every navigation", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (file) => fs.readFileSync(path.join(__dirname, "../../src", file), "utf8");
  const page = read("components/SettingsPage.tsx");
  assert.match(page, /function useSubTab<[\s\S]*?\}, \[initial, requestId\]\);/);
  assert.equal(page.match(/requestId=\{subTabRequestId\}/g)?.length, 2);
  assert.match(
    page,
    /requestStyleFocus\(styleId \?\? STYLE_LIST_FOCUS\);\s*onNavigateToSection\?\.\("llms", "dictationCleanup"\);/
  );
  const modal = read("components/SettingsModal.tsx");
  assert.match(modal, /subTabRequestId=\{current\.navigationId\}/);
  assert.match(modal, /onNavigateToSection=\{handleSectionChange\}/);
});
