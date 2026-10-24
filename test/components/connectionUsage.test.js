const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// "Used by" on Settings › AI Connections & Local Models, from the real route
// resolvers: each feature lands on the connection its requests use, labelled
// configured, inherited (note formatting, live recording and uploads borrowing
// another feature's values, Styles on Cleanup's model), fallback (the voice
// assistant answering through Chat) or off (switched off, policy, Cloud off,
// Copilot where it can't run). Nothing secret ever reaches the result.

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };

const managedPolicy = ({ llm = {}, transcription = {}, features = {} } = {}) => ({
  status: "managed",
  appVersion: "1.10.3",
  policy: {
    version: 1,
    transcription: {
      allowedModes: ["providers", "local", "self-hosted"],
      allowedByokProviders: ["groq", "openai"],
      ...transcription,
    },
    llm: {
      allowedModes: ["providers", "local", "self-hosted"],
      allowedByokProviders: ["openai", "anthropic", "groq"],
      allowedEnterpriseProviders: [],
      ...llm,
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

const SECRETS = [
  "sk-openai-SECRET-1111",
  "sk-ant-SECRET-2222",
  "gsk_SECRET-3333",
  "sk-cleanup-SECRET-4444",
  "sk-chat-SECRET-5555",
  "sk-nf-SECRET-6666",
  "stt-custom-SECRET-7777",
  "corti-SECRET-8888",
  "pass-in-url-SECRET-9999",
];

// Every feature on, each on its own connection, nothing inherited.
const BASE = {
  isSignedIn: true,
  enterpriseSetupMode: "auto",
  enterpriseTranscriptionSetupMode: "auto",
  transcriptionMode: "providers",
  useLocalWhisper: false,
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "groq",
  cloudTranscriptionModel: "whisper-large-v3-turbo",
  cloudTranscriptionBaseUrl: "",
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  parakeetModel: "parakeet-tdt-0.6b-v3",
  cohereModel: "",
  remoteTranscriptionUrl: "",
  remoteTranscriptionModel: "",
  meetingTranscriptionMode: "providers",
  meetingUseLocalWhisper: false,
  meetingCloudTranscriptionMode: "byok",
  meetingCloudTranscriptionProvider: "openai",
  meetingCloudTranscriptionModel: "gpt-4o-transcribe",
  meetingCloudTranscriptionBaseUrl: "",
  meetingLocalTranscriptionProvider: "whisper",
  meetingWhisperModel: "",
  meetingParakeetModel: "",
  meetingCohereModel: "",
  meetingRemoteTranscriptionUrl: "",
  uploadTranscriptionMode: "providers",
  uploadUseLocalWhisper: false,
  uploadCloudTranscriptionMode: "byok",
  uploadCloudTranscriptionProvider: "openai",
  uploadCloudTranscriptionModel: "whisper-1",
  uploadCloudTranscriptionBaseUrl: "",
  uploadLocalTranscriptionProvider: "whisper",
  uploadWhisperModel: "",
  uploadParakeetModel: "",
  uploadCohereModel: "",
  uploadRemoteTranscriptionUrl: "",
  uploadRemoteTranscriptionModel: "",
  useCleanupModel: true,
  cleanupMode: "providers",
  cleanupCloudMode: "byok",
  cleanupProvider: "openai",
  cleanupModel: "gpt-5-mini",
  cleanupCloudBaseUrl: "",
  cleanupRemoteUrl: "",
  useDictationAgent: true,
  dictationAgentMode: "providers",
  dictationAgentCloudMode: "byok",
  dictationAgentProvider: "anthropic",
  dictationAgentModel: "claude-haiku-4-5",
  dictationAgentCloudBaseUrl: "",
  dictationAgentRemoteUrl: "",
  useDictationAgentVisionModel: false,
  dictationAgentVisionProvider: "",
  dictationAgentVisionModel: "",
  dictationAgentVisionCloudBaseUrl: "",
  voiceAgentScreenContext: false,
  useDictationTranslation: true,
  translationMode: "providers",
  translationCloudMode: "byok",
  translationProvider: "groq",
  translationModel: "llama-3.3-70b-versatile",
  translationCloudBaseUrl: "",
  translationRemoteUrl: "",
  noteFormattingMode: "providers",
  noteFormattingCloudMode: "byok",
  noteFormattingProvider: "anthropic",
  noteFormattingModel: "claude-sonnet-4-5",
  noteFormattingCloudBaseUrl: "",
  noteFormattingRemoteUrl: "",
  chatAgentMode: "providers",
  chatAgentCloudMode: "byok",
  chatAgentProvider: "openai",
  chatAgentModel: "gpt-5.2",
  chatAgentCloudBaseUrl: "",
  chatAgentRemoteUrl: "",
  // Secrets everywhere a route could read one; none may surface.
  openaiApiKey: SECRETS[0],
  anthropicApiKey: SECRETS[1],
  groqApiKey: SECRETS[2],
  cleanupCustomApiKey: SECRETS[3],
  chatAgentCustomApiKey: SECRETS[4],
  noteFormattingCustomApiKey: SECRETS[5],
  customTranscriptionApiKey: SECRETS[6],
  cortiClientSecret: SECRETS[7],
};

async function load(t) {
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-connection-usage-" });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const enterprise = await vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts");
  const usage = await vite.ssrLoadModule("/components/settings/connectionUsage.ts");
  return { ...store, ...enterprise, ...usage, vite };
}

test("Used by follows the real routes", { timeout: 60000 }, async (t) => {
  const lib = await load(t);
  const defaults = lib.useSettingsStore.getState();
  const compute = (overrides = {}, options = {}) =>
    lib.computeConnectionUsage({
      settings: { ...defaults, ...BASE, ...overrides },
      policy: UNMANAGED,
      cloudDisabled: false,
      stylesInUse: false,
      ...options,
    });
  const find = (usages, feature) => usages.find((usage) => usage.feature === feature);
  const keyOf = (usages, feature) => lib.connectionKey(find(usages, feature).connection);

  await t.test("each feature lands on its own connection", () => {
    const usages = compute();
    assert.deepEqual(
      usages.map((usage) => [usage.feature, lib.connectionKey(usage.connection), usage.kind]),
      [
        ["recognition", "provider:groq", "configured"],
        ["cleanup", "provider:openai", "configured"],
        ["assistant", "provider:anthropic", "configured"],
        ["translation", "provider:groq", "configured"],
        ["chat", "provider:openai", "configured"],
        ["liveRecording", "provider:openai", "configured"],
        ["fileTranscription", "provider:openai", "configured"],
        ["noteFormatting", "provider:anthropic", "configured"],
      ]
    );
    assert.equal(find(usages, "cleanup").edit, "cleanup#dictation.cleanup.model");
    assert.equal(find(usages, "recognition").edit, "recognition#dictation.stt.engine");
    assert.deepEqual(
      lib.usagesOfProvider(usages, "openai").map((usage) => usage.feature),
      ["cleanup", "chat", "liveRecording", "fileTranscription"]
    );
  });

  await t.test("every kind of connection", () => {
    const usages = compute({
      cleanupMode: "local",
      cleanupProvider: "qwen",
      cleanupModel: "qwen3-4b-q4_k_m",
      translationProvider: "copilot",
      translationModel: "gpt-5-mini",
      chatAgentMode: "self-hosted",
      chatAgentModel: "qwen3:8b",
      chatAgentRemoteUrl: `http://me:${SECRETS[8]}@10.0.0.7:11434/v1?key=${SECRETS[4]}`,
      noteFormattingProvider: "custom",
      noteFormattingModel: "my-model",
      noteFormattingCloudBaseUrl: "https://gateway.example.test/v1/private",
      dictationAgentMode: "openwhispr",
      dictationAgentCloudMode: "openwhispr",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionModel: "whisper-1",
      cloudTranscriptionBaseUrl: "https://stt.example.test/v1",
      meetingTranscriptionMode: "local",
      meetingLocalTranscriptionProvider: "nvidia",
      meetingParakeetModel: "parakeet-tdt-0.6b-v3",
      uploadTranscriptionMode: "self-hosted",
      uploadRemoteTranscriptionUrl: "192.168.1.126:8178",
      uploadRemoteTranscriptionModel: "large-v3",
    });
    assert.deepEqual(find(usages, "cleanup").connection, {
      type: "local",
      engine: "llm",
      model: "qwen3-4b-q4_k_m",
    });
    assert.deepEqual(find(usages, "translation").connection, { type: "copilot" });
    assert.deepEqual(find(usages, "chat").connection, {
      type: "selfHosted",
      host: "10.0.0.7:11434",
      model: "qwen3:8b",
    });
    assert.deepEqual(find(usages, "noteFormatting").connection, {
      type: "custom",
      host: "gateway.example.test",
      model: "my-model",
      secret: "feature",
    });
    assert.deepEqual(find(usages, "assistant").connection, { type: "cloud" });
    assert.equal(find(usages, "assistant").kind, "configured");
    assert.deepEqual(find(usages, "recognition").connection, {
      type: "custom",
      host: "stt.example.test",
      model: "whisper-1",
      secret: "speechToText",
    });
    assert.deepEqual(find(usages, "liveRecording").connection, {
      type: "local",
      engine: "sherpa",
      model: "parakeet-tdt-0.6b-v3",
    });
    assert.deepEqual(find(usages, "fileTranscription").connection, {
      type: "selfHosted",
      host: "192.168.1.126:8178",
      model: "large-v3",
    });
    assert.deepEqual(
      lib.endpointUsages(usages).map((usage) => usage.feature),
      ["recognition", "chat", "fileTranscription", "noteFormatting"]
    );
    assert.deepEqual(
      lib.usagesOfLocalModel(usages, "llm", "qwen3-4b-q4_k_m").map((usage) => usage.feature),
      ["cleanup"]
    );
  });

  await t.test("note formatting inherits Cleanup's unset fields", () => {
    let usages = compute({ noteFormattingProvider: "", noteFormattingModel: "" });
    assert.equal(keyOf(usages, "noteFormatting"), "provider:openai");
    assert.equal(find(usages, "noteFormatting").kind, "inherited");
    assert.equal(find(usages, "noteFormatting").from, "cleanup");
    // Only the model is unset: still Cleanup's model, on its own provider.
    usages = compute({ noteFormattingModel: "" });
    assert.equal(keyOf(usages, "noteFormatting"), "provider:anthropic");
    assert.equal(find(usages, "noteFormatting").kind, "inherited");
    // An inherited custom endpoint reports Cleanup's host, never its key.
    usages = compute({
      cleanupProvider: "custom",
      cleanupModel: "local-gpt",
      cleanupCloudBaseUrl: "https://cleanup.example.test/v1",
      noteFormattingProvider: "",
      noteFormattingModel: "",
    });
    assert.deepEqual(find(usages, "noteFormatting").connection, {
      type: "custom",
      host: "cleanup.example.test",
      model: "local-gpt",
      secret: "feature",
    });
    // Its own picks: configured.
    assert.equal(find(compute(), "noteFormatting").kind, "configured");
  });

  await t.test("live recording and uploads inherit Recognition's unset picks", () => {
    const usages = compute({
      meetingCloudTranscriptionProvider: "",
      meetingCloudTranscriptionModel: "",
      uploadTranscriptionMode: "local",
      uploadLocalTranscriptionProvider: "whisper",
      uploadWhisperModel: "",
    });
    assert.equal(keyOf(usages, "liveRecording"), "provider:groq");
    assert.equal(find(usages, "liveRecording").kind, "inherited");
    assert.equal(find(usages, "liveRecording").from, "recognition");
    assert.equal(keyOf(usages, "fileTranscription"), "local:whisper:base");
    assert.equal(find(usages, "fileTranscription").kind, "inherited");
  });

  await t.test("the assistant falls back to Chat while its own pick can't run", () => {
    const usages = compute({ dictationAgentModel: "" });
    const assistant = find(usages, "assistant");
    assert.equal(assistant.kind, "fallback");
    assert.equal(assistant.from, "chat");
    assert.equal(lib.connectionKey(assistant.connection), "provider:openai");
    assert.equal(assistant.edit, "assistant#assistant.model");
    assert.deepEqual(
      lib.usagesOfProvider(usages, "anthropic").map((usage) => usage.feature),
      ["noteFormatting"],
      "its unreachable pick isn't listed as a use"
    );
  });

  await t.test("the vision override counts once picked, on API-key providers only", () => {
    const visionOn = {
      voiceAgentScreenContext: true,
      useDictationAgentVisionModel: true,
      dictationAgentVisionProvider: "groq",
      dictationAgentVisionModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    };
    let usages = compute(visionOn);
    let vision = find(usages, "assistantVision");
    assert.equal(lib.connectionKey(vision.connection), "provider:groq");
    assert.equal(vision.kind, "configured");
    assert.equal(vision.edit, "assistant#assistant.visionOverride");
    // No provider of its own: the assistant's, inherited.
    usages = compute({ ...visionOn, dictationAgentVisionProvider: "" });
    vision = find(usages, "assistantVision");
    assert.equal(lib.connectionKey(vision.connection), "provider:anthropic");
    assert.equal(vision.kind, "inherited");
    assert.equal(vision.from, "assistant");
    // Toggled on but never picked: screenshots ride the assistant's own route.
    assert.equal(
      find(compute({ ...visionOn, dictationAgentVisionModel: "" }), "assistantVision"),
      undefined
    );
    // Screen context off, or a policy without API-key providers: off.
    vision = find(compute({ ...visionOn, voiceAgentScreenContext: false }), "assistantVision");
    assert.equal(vision.kind, "off");
    assert.equal(vision.offReason, "disabled");
    usages = compute(visionOn, {
      policy: managedPolicy({ llm: { allowedModes: ["local", "self-hosted"] } }),
    });
    assert.equal(find(usages, "assistantVision").kind, "off");
    assert.equal(find(usages, "assistantVision").offReason, "policy");
  });

  await t.test("Styles run on Cleanup's model, even with Cleanup off", () => {
    let usages = compute({}, { stylesInUse: true });
    let styles = find(usages, "styles");
    assert.equal(lib.connectionKey(styles.connection), "provider:openai");
    assert.equal(styles.kind, "inherited");
    assert.equal(styles.from, "cleanup");
    usages = compute({ useCleanupModel: false }, { stylesInUse: true });
    assert.equal(find(usages, "cleanup").kind, "off");
    styles = find(usages, "styles");
    assert.equal(styles.kind, "inherited");
    assert.ok(lib.isActiveUsage(styles), "a style still needs the key");
    assert.equal(find(compute(), "styles"), undefined, "no styles, no use");
  });

  await t.test("a switched-off feature is off, not a use", () => {
    const usages = compute({
      useCleanupModel: false,
      useDictationTranslation: false,
      useDictationAgent: false,
    });
    for (const feature of ["cleanup", "translation", "assistant"]) {
      const usage = find(usages, feature);
      assert.equal(usage.kind, "off", feature);
      assert.equal(usage.offReason, "disabled", feature);
      assert.equal(lib.isActiveUsage(usage), false, feature);
    }
    // Groq still serves Recognition; Translation's use is listed after it, off.
    assert.deepEqual(
      lib.usagesOfProvider(usages, "groq").map((usage) => [usage.feature, usage.kind]),
      [
        ["recognition", "configured"],
        ["translation", "off"],
      ]
    );
  });

  await t.test("policy reroutes forbidden providers and turns the agent off", () => {
    const policy = managedPolicy({
      llm: { allowedByokProviders: ["openai"] },
      features: { agentEnabled: false },
    });
    const usages = compute({}, { policy });
    assert.equal(keyOf(usages, "noteFormatting"), "provider:openai", "anthropic isn't allowed");
    assert.equal(lib.usagesOfProvider(usages, "anthropic").filter(lib.isActiveUsage).length, 0);
    assert.equal(find(usages, "chat").kind, "off");
    assert.equal(find(usages, "chat").offReason, "policy");
    assert.equal(find(usages, "assistant").offReason, "policy");
  });

  await t.test("OpenWhispr Cloud off, or signed out: its features can't run", () => {
    const cloud = { cleanupMode: "openwhispr", cleanupCloudMode: "openwhispr" };
    let usages = compute({ ...cloud, isSignedIn: false }, { cloudDisabled: true });
    assert.deepEqual(find(usages, "cleanup").connection, { type: "cloud" });
    assert.equal(find(usages, "cleanup").kind, "off");
    assert.equal(find(usages, "cleanup").offReason, "cloudOff");
    usages = compute({ ...cloud, isSignedIn: false });
    assert.equal(find(usages, "cleanup").offReason, "signedOut");
    usages = compute(cloud);
    assert.equal(find(usages, "cleanup").kind, "configured");
    assert.deepEqual(
      lib.usagesOfProvider(usages, "cloud").map((usage) => usage.feature),
      ["cleanup"]
    );
  });

  await t.test("GitHub Copilot left on a feature it can't serve is off", () => {
    const usages = compute({ chatAgentProvider: "copilot", chatAgentModel: "gpt-5-mini" });
    assert.deepEqual(find(usages, "chat").connection, { type: "copilot" });
    assert.equal(find(usages, "chat").offReason, "unsupported");
  });

  await t.test("a managed enterprise deployment outranks the personal pick", () => {
    const model = "anthropic.claude-sonnet-4-20250514-v1:0";
    const scopes = [
      "dictationCleanup",
      "dictationAgent",
      "noteFormatting",
      "chatIntelligence",
      "dictationTranslation",
    ];
    lib.useEnterpriseIdentityStore.setState({
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 1,
      status: "ready",
      error: null,
      config: {
        workspaceId: "workspace-a",
        version: 1,
        generation: 1,
        identity: {
          issuer: "https://api.example.com/enterprise-identity",
          jwksUri: "https://api.example.com/enterprise-identity/jwks.json",
          subject: "workspace:workspace-a",
          audiences: { bedrock: "sts.amazonaws.com", azure: "api://AzureADTokenExchange" },
        },
        providers: [
          {
            provider: "bedrock",
            mode: "managed_required",
            allowManualSetup: false,
            config: {
              roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
              region: "us-east-1",
              allowedModels: [model],
              scopeDefaults: Object.fromEntries(scopes.map((scope) => [scope, model])),
            },
            version: 1,
            updatedAt: "2026-08-10T00:00:00.000Z",
          },
        ],
      },
    });
    t.after(() =>
      lib.useEnterpriseIdentityStore.setState({
        accountId: null,
        workspaceId: null,
        authGeneration: null,
        status: "idle",
        config: null,
        error: null,
        managedScopes: [],
        enforcedScopes: [],
      })
    );
    const usages = compute();
    for (const feature of ["cleanup", "assistant", "translation", "chat", "noteFormatting"]) {
      assert.deepEqual(
        find(usages, feature).connection,
        { type: "enterprise", provider: "bedrock", managed: true, model },
        feature
      );
    }
    // Speech-to-text has no managed deployment here: the personal pick stands.
    assert.equal(keyOf(usages, "recognition"), "provider:groq");
    assert.equal(lib.enterpriseUsages(usages).length, 5);
  });

  await t.test("nothing secret reaches the result", () => {
    const runs = [
      compute(),
      compute({
        chatAgentMode: "self-hosted",
        chatAgentRemoteUrl: `http://user:${SECRETS[8]}@10.0.0.7:11434/v1?token=${SECRETS[4]}`,
        cleanupProvider: "custom",
        cleanupCloudBaseUrl: `https://gw.example.test/v1?api_key=${SECRETS[3]}`,
        cloudTranscriptionProvider: "custom",
        cloudTranscriptionBaseUrl: `https://u:${SECRETS[6]}@stt.example.test/x`,
        uploadTranscriptionMode: "self-hosted",
        uploadRemoteTranscriptionUrl: `http://${SECRETS[8]}@10.0.0.9:8178/`,
        noteFormattingProvider: "",
        noteFormattingModel: "",
      }),
    ];
    const text = JSON.stringify(runs);
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.ok(!/api_key|token=|\/v1\b|private/.test(text), "no paths or queries");
  });
});

test("each feature's edit link lands on its model setting", async (t) => {
  const lib = await load(t);
  const { vite } = lib;
  const pages = await vite.ssrLoadModule("/components/settings/settingsPages.ts");
  const registry = await vite.ssrLoadModule("/components/settings/search/registry.ts");
  const ctx = { cloudDisabled: false, isSignedIn: true, agentAllowed: true };
  for (const [feature, destination] of Object.entries(lib.USAGE_EDIT_DESTINATIONS)) {
    const resolved = pages.resolveSettingsDestination(destination, {
      ctx,
      locateSetting: registry.locateSetting,
    });
    // Styles run on Cleanup's model, so they're edited there.
    const page = feature === "styles" ? "cleanup" : lib.USAGE_FEATURE_PAGES[feature];
    assert.equal(resolved.page, page, feature);
    assert.ok(registry.findSettingDescriptor(resolved.settingId)?.anchor, `${feature} anchor`);
  }
});

test("endpointHost keeps the host only", async (t) => {
  const lib = await load(t);
  assert.equal(lib.endpointHost("http://user:pass@10.0.0.5:11434/v1?key=x#y"), "10.0.0.5:11434");
  assert.equal(lib.endpointHost("https://api.example.test/v1"), "api.example.test");
  assert.equal(lib.endpointHost("localhost:1234"), "localhost:1234");
  assert.equal(lib.endpointHost("  "), "");
  assert.equal(lib.endpointHost(undefined), "");
  assert.equal(lib.endpointHost("http://exa mple"), "");
});
