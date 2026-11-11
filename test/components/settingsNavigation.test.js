const test = require("node:test");
const assert = require("node:assert/strict");

// Navigation and request identity for the Settings layer: repeated requests,
// bare reopen, in-Settings links and the cold-start drain of a destination main
// kept waiting. Where each destination lands is in settingsPages.test.js.

async function load() {
  const pages = await import("../../src/components/settings/settingsPages.ts");
  const navigation = await import("../../src/components/settings/settingsNavigation.ts");
  return { ...(pages.default ?? pages), ...(navigation.default ?? navigation) };
}

const ALL = { cloudDisabled: false, isSignedIn: true, agentAllowed: true };
const CLOUD_OFF = { cloudDisabled: true, isSignedIn: false, agentAllowed: true };

test("each named request gets a new id", async () => {
  const { nextSettingsRequest } = await load();
  const first = nextSettingsRequest(null, "meetings");
  const second = nextSettingsRequest(first, "meetings");
  assert.deepEqual(first, { section: "meetings", id: 1 });
  assert.deepEqual(second, { section: "meetings", id: 2 });
});

test("first mount opens the request it was created for, or the default page", async () => {
  const { initialSettingsNavigation, nextSettingsRequest } = await load();
  const opened = initialSettingsNavigation(nextSettingsRequest(null, "meetings"), { ctx: ALL });
  assert.equal(opened.page, "noteFormatting");
  assert.equal(opened.requestId, 1);
  assert.equal(opened.navigationId, 0);

  // After onboarding ("transcription"): Recognition.
  const onboarded = initialSettingsNavigation(nextSettingsRequest(null, "transcription"), {
    ctx: CLOUD_OFF,
  });
  assert.equal(onboarded.page, "recognition");

  const bare = initialSettingsNavigation(null, { ctx: CLOUD_OFF });
  assert.equal(bare.page, "recognition");
  assert.equal(bare.requestId, 0);
  assert.equal(initialSettingsNavigation(null, { ctx: ALL }).page, "account");
});

test("a repeated named request navigates again after the user moved elsewhere", async () => {
  const {
    applySettingsRequest,
    initialSettingsNavigation,
    navigateWithinSettings,
    nextSettingsRequest,
  } = await load();
  const first = nextSettingsRequest(null, "transcription");
  let state = initialSettingsNavigation(first, { ctx: ALL });
  assert.equal(state.page, "recognition");

  state = navigateWithinSettings(state, "hotkeys");
  assert.equal(state.page, "hotkeys");

  const again = nextSettingsRequest(first, "transcription");
  const before = state.navigationId;
  state = applySettingsRequest(state, again, { ctx: ALL });
  assert.equal(state.page, "recognition");
  assert.equal(state.requestId, again.id);
  assert.ok(state.navigationId > before);

  // The same request object seen again (a re-render) changes nothing.
  assert.equal(applySettingsRequest(state, again, { ctx: ALL }), state);
});

test("the same destination requested twice in a row still bumps the navigation", async () => {
  const { applySettingsRequest, initialSettingsNavigation, nextSettingsRequest } = await load();
  const first = nextSettingsRequest(null, "meetings");
  const opened = initialSettingsNavigation(first, { ctx: ALL });
  const repeated = applySettingsRequest(opened, nextSettingsRequest(first, "meetings"), {
    ctx: ALL,
  });
  assert.equal(repeated.page, "noteFormatting");
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
  let state = initialSettingsNavigation(request, { ctx: ALL });
  state = navigateWithinSettings(state, "privacyData");
  // Ctrl+, and the sidebar's Settings button open without a new request.
  assert.equal(applySettingsRequest(state, request, { ctx: ALL }), state);
  assert.equal(applySettingsRequest(state, request, { ctx: ALL }).page, "privacyData");
});

test("Hotkeys → a style opens Styles again, even when it is already the page", async () => {
  const { initialSettingsNavigation, navigateWithinSettings } = await load();
  let state = initialSettingsNavigation(null, { ctx: ALL });
  state = navigateWithinSettings(state, "styles");
  const first = state.navigationId;
  state = navigateWithinSettings(state, "hotkeys");
  state = navigateWithinSettings(state, "styles");
  assert.equal(state.page, "styles");
  assert.ok(state.navigationId > first + 1);
});

test("the cold-start drain opens the waiting destination; a bare show keeps the page", async () => {
  const { drainPendingSettingsSection } = await load();
  const calls = [];
  const open = (...args) => calls.push(args);

  await drainPendingSettingsSection(async () => "privacyData", open, false);
  assert.deepEqual(calls, [["privacyData"]]);

  calls.length = 0;
  await drainPendingSettingsSection(async () => null, open, false);
  assert.deepEqual(calls, [], "nothing waiting on mount opens nothing");

  await drainPendingSettingsSection(async () => null, open, true);
  assert.deepEqual(calls, [[]], "the app menu's Settings opens without a destination");

  calls.length = 0;
  await drainPendingSettingsSection(() => undefined, open, true);
  assert.deepEqual(calls, [[]], "a preload without the IPC still opens Settings");

  // An Integrations section is a view, not a Settings page (upstream's open-settings-section).
  calls.length = 0;
  const integrations = [];
  const openIntegrations = (section) => integrations.push(section);
  await drainPendingSettingsSection(async () => "integrations.calendars", open, false, openIntegrations);
  assert.deepEqual(integrations, ["calendars"]);
  assert.deepEqual(calls, [], "Settings stays closed");
  await drainPendingSettingsSection(async () => "privacyData", open, false, openIntegrations);
  assert.deepEqual(calls, [["privacyData"]]);
});

// SettingsPage is too large to render here: People re-applies its tab on
// every navigation id, and Hotkeys → a style asks Style Studio for focus
// before opening Styles.
test("SettingsPage re-applies a People tab on every navigation; Hotkeys opens Styles", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (file) => fs.readFileSync(path.join(__dirname, "../../src", file), "utf8");
  const page = read("components/SettingsPage.tsx");
  assert.equal(page.match(/requestId=\{subTabRequestId\}/g)?.length, 1);
  assert.match(page, /initialSubTab=\{page === "workspacePeople" \? initialSubTab : undefined\}/);
  assert.match(
    page,
    /requestStyleFocus\(styleId \?\? STYLE_LIST_FOCUS\);\s*onNavigate\?\.\("styles"\);/
  );
  const modal = read("components/SettingsModal.tsx");
  assert.match(modal, /subTabRequestId=\{current\.navigationId\}/);
  assert.match(modal, /onNavigate=\{handleNavigate\}/);
  assert.match(modal, /page=\{shownPage\}/);
});

// Settings search destinations: `#settingId` (or `<page>#<settingId>`) lands on
// the setting's own page from the registry, keeps the id for the reveal, and
// leaves every plain string caller as it was.

async function locate() {
  const registry = await import("../../src/components/settings/search/registry.ts");
  return (registry.default ?? registry).locateSetting;
}

test("a setting destination parses into its name and setting id", async () => {
  const { parseSettingsDestination, settingDestination } = await load();
  assert.deepEqual(parseSettingsDestination("llms"), { name: "llms" });
  assert.deepEqual(parseSettingsDestination("#preferences.theme"), {
    name: undefined,
    settingId: "preferences.theme",
  });
  assert.deepEqual(parseSettingsDestination("appearance#preferences.theme"), {
    name: "appearance",
    settingId: "preferences.theme",
  });
  assert.deepEqual(parseSettingsDestination("general#"), { name: "general" });
  assert.deepEqual(parseSettingsDestination(undefined), {});
  assert.equal(settingDestination("hotkeys.dictation"), "#hotkeys.dictation");
  assert.equal(settingDestination("hotkeys.dictation", "hotkeys"), "hotkeys#hotkeys.dictation");
});

test("Ctrl+K opening the same setting twice navigates (and reveals) twice", async () => {
  const {
    applySettingsRequest,
    initialSettingsNavigation,
    navigateWithinSettings,
    nextSettingsRequest,
  } = await load();
  const locateSetting = await locate();
  const options = { ctx: ALL, locateSetting };
  const first = nextSettingsRequest(null, "#hotkeys.activationMode");
  let state = initialSettingsNavigation(first, options);
  assert.equal(state.page, "hotkeys");
  assert.equal(state.settingId, "hotkeys.activationMode");

  // Moving elsewhere through the nav forgets the setting to land on.
  state = navigateWithinSettings(state, "appearance");
  assert.equal(state.settingId, undefined);
  assert.ok(!("settingId" in state));

  const again = nextSettingsRequest(first, "#hotkeys.activationMode");
  const before = state.navigationId;
  state = applySettingsRequest(state, again, options);
  assert.equal(state.page, "hotkeys");
  assert.equal(state.settingId, "hotkeys.activationMode");
  assert.ok(state.navigationId > before);
  assert.equal(applySettingsRequest(state, again, options), state);
});

test("a search result inside Settings navigates with the setting to land on", async () => {
  const { initialSettingsNavigation, navigateWithinSettings } = await load();
  let state = initialSettingsNavigation(null, { ctx: ALL });
  state = navigateWithinSettings(state, "assistant", undefined, "assistant.screenContext");
  assert.deepEqual(
    { page: state.page, subTab: state.subTab, settingId: state.settingId },
    { page: "assistant", subTab: undefined, settingId: "assistant.screenContext" }
  );
  const id = state.navigationId;
  // The same result again is a new navigation, so it lands again.
  state = navigateWithinSettings(state, "assistant", undefined, "assistant.screenContext");
  assert.equal(state.navigationId, id + 1);
  // A People tab is carried.
  state = navigateWithinSettings(state, "workspacePeople", "members", "workspace.members");
  assert.equal(state.subTab, "members");
});

test("SettingsModal resolves setting ids, reveals and focuses them, and clears the search", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const modal = fs.readFileSync(
    path.join(__dirname, "../../src/components/SettingsModal.tsx"),
    "utf8"
  );
  assert.match(modal, /initialSettingsNavigation\(request, \{\s*ctx: pageCtx,\s*locateSetting,/);
  assert.match(
    modal,
    /applySettingsRequest\(navigation, request, \{ ctx: pageCtx, locateSetting \}\)/
  );
  assert.match(modal, /if \(query\) setQuery\(""\);/);
  assert.match(modal, /revealSetting\(\{/);
  assert.match(modal, /focusLandedSetting\(layer, landed\)/);
  assert.match(modal, /shownSettingsPage\(current\.page, pageCtx\)/);
});
