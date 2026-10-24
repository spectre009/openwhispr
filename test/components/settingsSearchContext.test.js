const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The settings search context is built from the real stores: what each feature
// runs on (policy-effective provider · model), engines and hotkeys become
// searchable values, and nothing secret (API keys, custom keys, endpoints that
// can carry credentials) ever reaches a value or a matched term.

const SECRETS = {
  openaiApiKey: "sk-openai-SECRET-1111",
  anthropicApiKey: "sk-ant-SECRET-2222",
  groqApiKey: "gsk_SECRET-3333",
  cleanupCustomApiKey: "sk-cleanup-SECRET-4444",
  chatAgentCustomApiKey: "sk-chat-SECRET-5555",
  dictationAgentCustomApiKey: "sk-agent-SECRET-6666",
  cleanupCloudBaseUrl: "https://private-gateway.example.internal/v1",
  cleanupRemoteUrl: "http://user:hunter2@10.0.0.5:11434/v1",
  remoteTranscriptionUrl: "http://user:hunter2@10.0.0.6:9000",
};

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };

const managedPolicy = (features) => ({
  status: "managed",
  appVersion: "1.10.3",
  policy: {
    version: 1,
    transcription: { allowedModes: ["providers", "local"], allowedByokProviders: ["groq"] },
    llm: {
      allowedModes: ["providers", "local"],
      allowedByokProviders: ["anthropic", "openai"],
      allowedEnterpriseProviders: [],
    },
    features: {
      agentEnabled: true,
      webSearchEnabled: true,
      screenContextEnabled: true,
      ...features,
    },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    minAppVersion: null,
  },
});

async function load(t) {
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-search-context-",
  });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const context = await vite.ssrLoadModule("/components/settings/search/searchContext.ts");
  return { ...store, ...context };
}

const STYLE_LIBRARY = {
  version: 1,
  dictationStyleId: "plain",
  seededStarters: [],
  styles: [
    {
      id: "email",
      name: "Email",
      emoji: "",
      instruction: "Write it as an email.",
      runMode: "two-steps",
      enabled: true,
      appGlossary: false,
      hotkey: "F9",
    },
  ],
};

function build(lib, settings, overrides = {}) {
  return lib.buildSettingsSearchContext({
    settings,
    policy: UNMANAGED,
    styleLibrary: STYLE_LIBRARY,
    styleBindings: [{ hotkey: "F9", styleId: "email", active: true, error: null }],
    platform: "win32",
    cloudDisabled: false,
    canManageWorkspace: false,
    env: { isWayland: null, gpuCount: null },
    agentName: "Jarvis",
    t: (key) => `t:${key}`,
    ...overrides,
  });
}

test("values name what each feature runs on, and never a secret", async (t) => {
  const lib = await load(t);
  lib.useSettingsStore.setState({
    ...SECRETS,
    useCleanupModel: true,
    cleanupMode: "providers",
    cleanupProvider: "anthropic",
    cleanupModel: "claude-haiku-4-5",
    chatAgentMode: "self-hosted",
    chatAgentModel: "qwen3:8b",
    chatAgentRemoteUrl: "http://user:hunter2@10.0.0.7:11434/v1",
    transcriptionMode: "providers",
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "whisper-large-v3-turbo",
    dictationKey: "F8",
    voiceAgentKey: "",
    translationKey: "Control+Alt+T",
    theme: "dark",
    activationMode: "push",
  });
  const ctx = build(lib, lib.useSettingsStore.getState());

  assert.equal(ctx.values["llm.dictationCleanup"].display, "Anthropic · Claude Haiku 4.5");
  assert.ok(ctx.values["llm.dictationCleanup"].terms.includes("claude-haiku-4-5"));
  assert.equal(
    ctx.values["llm.chatIntelligence"].display,
    "t:settingsPage.aiModels.modes.selfHosted · qwen3:8b"
  );
  assert.match(ctx.values["stt.dictation"].display, /^Groq · /);
  assert.ok(ctx.values["stt.dictation"].terms.includes("groq"));
  assert.equal(ctx.values["hotkey.dictation"].display, "F8");
  assert.equal(ctx.values["hotkey.assistant"], undefined, "an unset hotkey has no value");
  assert.ok(ctx.values["hotkey.translation"].display.includes("T"));
  assert.equal(ctx.values["hotkey.styles"].display, "Email: F9");
  assert.deepEqual(ctx.values.theme, {
    display: "t:settingsPage.general.appearance.dark",
    terms: ["dark"],
  });
  assert.ok(ctx.values.activationMode.terms.includes("push"));
  assert.equal(ctx.values.agentName.display, "Jarvis");
  assert.equal(ctx.interpolation.hotkey, "F8");

  const everything = JSON.stringify(ctx);
  for (const [field, secret] of Object.entries(SECRETS)) {
    assert.ok(!everything.includes(secret), `${field} leaked into the search context`);
  }
  assert.ok(!everything.includes("hunter2"));
  assert.ok(!everything.includes("10.0.0."), "no endpoints");
});

test("toggles and modes follow the policy-effective settings", async (t) => {
  const lib = await load(t);
  lib.useSettingsStore.setState({
    useCleanupModel: false,
    useDictationAgent: true,
    voiceAgentScreenContext: true,
    useDictationTranslation: false,
    preferredLanguage: "auto",
    transcriptionMode: "local",
    localTranscriptionProvider: "whisper",
    cleanupMode: "local",
    cleanupModel: "qwen3-4b",
  });
  const settings = lib.useSettingsStore.getState();

  const open = build(lib, settings);
  assert.equal(open.agentAllowed, true);
  assert.equal(open.on.cleanup, false);
  assert.equal(open.on.assistant, true);
  assert.equal(open.on.screenContext, true);
  assert.equal(open.on.autoLanguage, true);
  assert.equal(open.on.localWhisper, true);
  assert.equal(open.on.transcriptionPreview, true, "local engines preview live");
  assert.equal(open.localLlm.dictationCleanup, true);
  assert.equal(open.isWayland, false, "only Linux asks about Wayland");

  const locked = build(lib, settings, {
    policy: managedPolicy({ agentEnabled: false, screenContextEnabled: false }),
  });
  assert.equal(locked.agentAllowed, false);
  assert.equal(locked.screenContextAllowed, false);
  assert.equal(locked.on.screenContext, false, "screen context is off when policy blocks it");
  assert.equal(locked.visionOverrideAllowed, true);

  const linux = build(lib, settings, { platform: "linux", env: { isWayland: true, gpuCount: 2 } });
  assert.equal(linux.isWayland, true);
  assert.equal(linux.gpuCount, 2);
});
