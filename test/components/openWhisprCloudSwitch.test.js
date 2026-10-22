// Renderer side of the OpenWhispr account & Cloud switch: what disappears from
// Settings and the pickers, what the assistant is told, and how the auth
// client settles as a guest without touching the network.
const test = require("node:test");
const assert = require("node:assert/strict");

// The Integrations sections module pulls in icon components compiled for a global React.
globalThis.React = require("react");

test("Settings drops the account sections and opens on Preferences while off", async () => {
  const sections = await import("../../src/components/settingsSections.ts");
  const items = ["account", "plansBilling", "workspace", "general", "privacyData", "system"].map(
    (id) => ({ id })
  );
  const ids = (list) => list.map((item) => item.id);

  assert.deepEqual(
    ids(sections.visibleSettingsSections(items, { isSignedIn: false, cloudDisabled: false })),
    ["account", "plansBilling", "general", "privacyData", "system"]
  );
  assert.deepEqual(
    ids(sections.visibleSettingsSections(items, { isSignedIn: false, cloudDisabled: true })),
    ["general", "privacyData", "system"]
  );

  const aliases = { aiModels: "llms", privacy: "privacyData" };
  assert.equal(sections.resolveSettingsSection(undefined, aliases, false), "account");
  assert.equal(sections.resolveSettingsSection(undefined, aliases, true), "general");
  assert.equal(sections.resolveSettingsSection("plansBilling", aliases, true), "general");
  assert.equal(sections.resolveSettingsSection("account", aliases, true), "general");
  assert.equal(sections.resolveSettingsSection("privacy", aliases, true), "privacyData");
  assert.equal(sections.shownSettingsSection("workspace", true), "general");
  assert.equal(sections.shownSettingsSection("workspace", false), "workspace");
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

test("Integrations keeps only Calendars while off", async () => {
  const integrations = await import("../../src/components/integrations/integrationsSections.ts");
  assert.deepEqual(integrations.visibleIntegrationsSections(true), ["calendars"]);
  assert.deepEqual(integrations.visibleIntegrationsSections(false), [
    "calendars",
    "connectors",
    "api",
    "mcp",
    "cli",
  ]);
  assert.equal(integrations.shownIntegrationsSection("mcp", true), "calendars");
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
