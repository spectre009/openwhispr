// Renderer side of the OpenWhispr account & Cloud switch: what disappears from
// Settings and the pickers, what the assistant is told, and how the auth
// client settles as a guest without touching the network.
const test = require("node:test");
const assert = require("node:assert/strict");

// The Integrations sections module pulls in icon components compiled for a global React.
globalThis.React = require("react");

test("Settings drops the account pages and opens on Dictation › Recognition while off", async () => {
  const mod = await import("../../src/components/settings/settingsPages.ts");
  const pages = mod.default ?? mod;
  // Workspace is a parent of pages now (#2959): General, People, Teamspaces, Developer.
  const ACCOUNT_PAGES = [
    "account",
    "plansBilling",
    "workspaceGeneral",
    "workspacePeople",
    "workspaceTeamspaces",
    "workspaceDeveloper",
  ];
  const accountPages = (ctx) =>
    pages
      .visibleSettingsNav(ctx)
      .flatMap((group) => group.items)
      .flatMap((item) => (item.kind === "page" ? [item.page] : (item.pages ?? [])))
      .filter((page) => ACCOUNT_PAGES.includes(page));

  const on = { cloudDisabled: false, isSignedIn: false, agentAllowed: true };
  const off = { cloudDisabled: true, isSignedIn: false, agentAllowed: true };
  assert.deepEqual(accountPages(on), ["account", "plansBilling"]);
  // Signed in, while the workspace list loads (no hasWorkspace yet), every page shows.
  assert.deepEqual(accountPages({ ...on, isSignedIn: true }), ACCOUNT_PAGES);
  assert.deepEqual(accountPages(off), []);

  const resolve = (destination, ctx) => pages.resolveSettingsDestination(destination, { ctx }).page;
  assert.equal(resolve(undefined, on), "account");
  assert.equal(resolve(undefined, off), "recognition");
  assert.equal(resolve("plansBilling", off), "recognition");
  assert.equal(resolve("account", off), "recognition");
  assert.equal(resolve("privacy", off), "privacyData");
  assert.equal(pages.shownSettingsPage("workspaceGeneral", off), "recognition");
  assert.equal(
    pages.shownSettingsPage("workspaceGeneral", { ...on, isSignedIn: true }),
    "workspaceGeneral"
  );
  // The old Workspace page's destination opens General.
  assert.equal(resolve("workspace", { ...on, isSignedIn: true }), "workspaceGeneral");
  assert.equal(resolve("workspace", off), "recognition");
});

test("the OpenWhispr Cloud mode disappears, unless it is the one selected", async () => {
  const { applyCloudSwitchToModeOptions, isModeAllowedWithCloudSwitch } =
    await import("../../src/utils/openWhisprCloudModes.ts");
  const options = [
    { id: "openwhispr", disabled: true, signInRequired: true, description: "Cloud" },
    { id: "providers" },
    { id: "local" },
  ];
  const unavailable = { badge: "Turned off", description: "Choose another mode." };

  assert.equal(applyCloudSwitchToModeOptions(options, false, "providers", unavailable), options);
  assert.deepEqual(
    applyCloudSwitchToModeOptions(options, true, "providers", unavailable).map((o) => o.id),
    ["providers", "local"]
  );

  const [kept] = applyCloudSwitchToModeOptions(options, true, "openwhispr", unavailable);
  assert.deepEqual(kept, {
    id: "openwhispr",
    disabled: true,
    signInRequired: false,
    badge: "Turned off",
    description: "Choose another mode.",
  });

  assert.equal(isModeAllowedWithCloudSwitch("openwhispr", true), false);
  assert.equal(isModeAllowedWithCloudSwitch("openwhispr", false), true);
  assert.equal(isModeAllowedWithCloudSwitch("local", true), true);
});

// Skills (upstream #2824) are a local library (files under the user data
// folder, no account calls), so they stay while Cloud is off.
test("Integrations keeps only Calendars and Skills while off", async () => {
  const integrations = await import("../../src/components/integrations/integrationsSections.ts");
  assert.deepEqual(integrations.visibleIntegrationsSections(true), ["calendars", "skills"]);
  assert.deepEqual(integrations.visibleIntegrationsSections(false), [
    "calendars",
    "connectors",
    "skills",
    "api",
    "mcp",
    "cli",
  ]);
  assert.equal(integrations.shownIntegrationsSection("mcp", true), "calendars");
  assert.equal(integrations.shownIntegrationsSection("skills", true), "skills");
  assert.equal(integrations.shownIntegrationsSection("mcp", false), "mcp");
});

test("the assistant hears 'turned off', never 'sign in', while off", async () => {
  const { resolveUnavailableCapabilities, describeUnavailable } =
    await import("../../src/config/agentCapabilities.ts");
  const unavailable = resolveUnavailableCapabilities({
    supportsTools: true,
    isSignedIn: false,
    cloudDisabled: true,
    webSearch: { allowed: false, blockedByOrg: false },
    calendarConnected: true,
    connectors: { hasPlan: false, allowed: false, blockedByOrg: false, statuses: {} },
    locations: {
      account: "Settings → Profile",
      plans: "Settings → Plans & Billing",
      calendars: "Integrations → Calendars",
      connectors: "Integrations → Connectors",
      models: "Settings → Language Models",
    },
  });
  assert.deepEqual(
    unavailable.map((item) => item.reason),
    ["cloudOff", "cloudOff"]
  );
  const prompt = describeUnavailable(unavailable);
  assert.match(prompt, /turned off OpenWhispr account features/);
  assert.doesNotMatch(prompt, /needs the user to sign in/);
  assert.doesNotMatch(prompt, /Settings → Profile|Plans & Billing/);
});

function installWindow() {
  const previous = global.window;
  global.window = {
    location: { origin: "https://desktop.openwhispr.test" },
    electronAPI: { authGetTokenState: async () => ({ token: null, generation: 0 }) },
  };
  return () => {
    global.window = previous;
  };
}

test("a session check settles as a guest locally; nothing reaches the network", async (t) => {
  t.after(installWindow());
  const store = await import("../../src/stores/openWhisprCloudStore.ts");
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (input) => {
    fetched.push(String(input));
    throw new Error("fetch must not be called");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    store.useOpenWhisprCloudStore.setState({ disabled: false });
  });

  store.useOpenWhisprCloudStore.setState({ disabled: true });
  const init = { headers: new Headers(), openWhisprAuthGeneration: 0 };
  const response = await auth.authContextFetch(
    "https://auth.openwhispr.com/api/auth/get-session",
    init
  );
  assert.equal(response.status, 200);
  assert.equal(await response.json(), null);

  await assert.rejects(
    auth.authContextFetch("https://auth.openwhispr.com/api/auth/sign-in/email", init),
    /OpenWhispr account is turned off/
  );
  assert.deepEqual(fetched, []);

  store.useOpenWhisprCloudStore.setState({ disabled: false });
  await assert.rejects(
    auth.authContextFetch("https://auth.openwhispr.com/api/auth/get-session", init),
    /fetch must not be called/
  );
  assert.deepEqual(fetched, ["https://auth.openwhispr.com/api/auth/get-session"]);
});
