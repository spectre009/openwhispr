const nodeTest = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The language-model selection adapter (settings/modelPicker/selectLlm.ts).
// For every scope and every kind of pick, the store ends up exactly as the old
// editor left it (mode cards, then the provider tab's model, the local model
// list, the custom/OpenRouter panels), and every route a request resolves —
// selectResolvedLLMConfig per scope, note formatting's borrowed endpoint, the
// assistant, its vision override and Chat fallback, translation, the local
// server — is the same. Side effects: Cloud while signed out asks to sign in
// and writes nothing; a pick that became invalid is refused; the mode-change
// callback fires only on a mode change; the managed setup mode follows the
// managed entry; nothing is written by building the menu or browsing.

const SCOPES = [
  "dictationCleanup",
  "dictationAgent",
  "dictationAgentVision",
  "dictationTranslation",
  "noteFormatting",
  "chatIntelligence",
];
const COPILOT_SCOPES = new Set(["dictationCleanup", "noteFormatting", "dictationTranslation"]);
const UNMANAGED = { status: "unmanaged", policy: null, appVersion: "1.10.3" };

const managedPolicy = (llm) => ({
  status: "managed",
  appVersion: "1.10.3",
  policy: {
    version: 1,
    transcription: { allowedModes: ["providers"], allowedByokProviders: ["groq"] },
    llm: { allowedEnterpriseProviders: [], ...llm },
    features: { agentEnabled: true, webSearchEnabled: true, screenContextEnabled: true },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    minAppVersion: null,
  },
});

const COPILOT_MODELS = [
  { id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
];

// Cases run as subtests of one test, which owns the browser globals and Vite.
const subtests = [];
const test = (name, fn) => subtests.push([name, fn]);

let env;

async function load(t) {
  if (env) return env;
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-model-picker-adapter-" });
  const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const scopes = await vite.ssrLoadModule("/config/inferenceScopes.ts");
  const options = await vite.ssrLoadModule("/components/settings/modelPicker/options.ts");
  const adapter = await vite.ssrLoadModule("/components/settings/modelPicker/selectLlm.ts");
  const agent = await vite.ssrLoadModule("/helpers/dictationAgentInference.js");
  const translation = await vite.ssrLoadModule("/helpers/dictationTranslationInference.js");
  env = { registry, store, scopes, options, adapter, agent, translation };
  return env;
}

function fixtures({ registry }) {
  const groq = registry.REASONING_PROVIDERS.groq.models.map((model) => model.value);
  const openai = registry.REASONING_PROVIDERS.openai.models.map((model) => model.value);
  const localProvider = registry.modelRegistry.getAllProviders()[0];
  const local = localProvider.models.map((model) => model.id);
  const scopeKeys = (keys, { mode, cloudMode, provider = "", model = "" }) => ({
    [keys.mode]: mode,
    [keys.cloudMode]: cloudMode,
    [keys.provider]: provider,
    [keys.model]: model,
  });
  // The daily setup: Cleanup on GitHub Copilot, the assistant and Chat on Groq,
  // Translation on OpenWhispr Cloud, note formatting inheriting from Cleanup.
  const user = {
    isSignedIn: true,
    enterpriseSetupMode: "auto",
    useCleanupModel: true,
    useDictationAgent: true,
    useDictationTranslation: true,
    translationTargetLanguage: "fr",
    voiceAgentScreenContext: true,
    useDictationAgentVisionModel: true,
    groqApiKey: "gsk-test",
    openaiApiKey: "sk-test",
    openrouterApiKey: "or-test",
    anthropicApiKey: "",
    geminiApiKey: "",
    tinfoilApiKey: "",
    cortiApiKey: "",
    cleanupCloudBaseUrl: "",
    cleanupRemoteUrl: "",
    dictationAgentCloudBaseUrl: "",
    dictationAgentRemoteUrl: "",
    chatAgentCloudBaseUrl: "",
    chatAgentRemoteUrl: "",
    translationCloudBaseUrl: "",
    translationRemoteUrl: "",
    noteFormattingCloudBaseUrl: "",
    noteFormattingRemoteUrl: "",
    dictationAgentVisionCloudBaseUrl: "",
    ...scopeKeys(
      {
        mode: "cleanupMode",
        cloudMode: "cleanupCloudMode",
        provider: "cleanupProvider",
        model: "cleanupModel",
      },
      { mode: "providers", cloudMode: "byok", provider: "copilot", model: "claude-haiku-5.5" }
    ),
    ...scopeKeys(
      {
        mode: "dictationAgentMode",
        cloudMode: "dictationAgentCloudMode",
        provider: "dictationAgentProvider",
        model: "dictationAgentModel",
      },
      { mode: "providers", cloudMode: "byok", provider: "groq", model: groq[0] }
    ),
    ...scopeKeys(
      {
        mode: "chatAgentMode",
        cloudMode: "chatAgentCloudMode",
        provider: "chatAgentProvider",
        model: "chatAgentModel",
      },
      { mode: "providers", cloudMode: "byok", provider: "groq", model: groq[0] }
    ),
    ...scopeKeys(
      {
        mode: "translationMode",
        cloudMode: "translationCloudMode",
        provider: "translationProvider",
        model: "translationModel",
      },
      { mode: "openwhispr", cloudMode: "openwhispr" }
    ),
    ...scopeKeys(
      {
        mode: "noteFormattingMode",
        cloudMode: "noteFormattingCloudMode",
        provider: "noteFormattingProvider",
        model: "noteFormattingModel",
      },
      { mode: "providers", cloudMode: "" }
    ),
    ...scopeKeys(
      {
        mode: "dictationAgentVisionMode",
        cloudMode: "dictationAgentVisionCloudMode",
        provider: "dictationAgentVisionProvider",
        model: "dictationAgentVisionModel",
      },
      { mode: "providers", cloudMode: "openwhispr" }
    ),
  };
  // Every scope (but the vision override) on a local model.
  const allLocal = { ...user };
  for (const scope of SCOPES) {
    if (scope === "dictationAgentVision") continue;
    const keys = env.scopes.INFERENCE_SCOPES[scope].storeKeys;
    Object.assign(allLocal, {
      [keys.mode]: "local",
      [keys.cloudMode]: "byok",
      [keys.provider]: localProvider.id,
      [keys.model]: local[0],
    });
  }
  return { user, allLocal, groq, openai, local, localProvider: localProvider.id };
}

/** What the old editor rendered from: the policy-effective config (an optional scope's own model). */
function editorView(scope, policy) {
  const { store, scopes } = env;
  const effective = store.selectPolicyEffectiveSettings(store.useSettingsStore.getState(), policy);
  const config = store.selectResolvedLLMConfig(effective, scope);
  const definition = scopes.INFERENCE_SCOPES[scope];
  return definition.optional ? { ...config, model: effective[definition.storeKeys.model] } : config;
}

// The old editor's handlers, as they were before the picker (InferenceConfigEditor's
// handleModeSelect; ReasoningModelSelector's handleModelSelect and its panels' setModel).
const OLD = {
  modeCard(scope, mode, policy) {
    // The vision override offered one mode, so it had no mode cards.
    if (scope === "dictationAgentVision") return;
    const config = editorView(scope, policy);
    if (mode === config.mode) return;
    const patch = { mode, cloudMode: mode === "openwhispr" ? "openwhispr" : "byok" };
    if (!env.registry.isProviderValidForMode(config.provider, mode)) {
      patch.provider = "";
      patch.model = "";
    }
    env.store.setResolvedLLMConfig(scope, patch);
  },
  modelClick(scope, provider, model) {
    env.store.setResolvedLLMConfig(scope, { provider });
    env.store.setResolvedLLMConfig(scope, { model });
  },
  localClick(scope, model) {
    const provider = env.registry.modelRegistry.getModel(model).provider.id;
    env.store.setResolvedLLMConfig(scope, { provider });
    env.store.setResolvedLLMConfig(scope, { model });
  },
};

function pickerContext(scope, policy, overrides = {}) {
  const raw = env.store.useSettingsStore.getState();
  const config = editorView(scope, policy);
  return {
    policy,
    cloudDisabled: false,
    isSignedIn: raw.isSignedIn,
    allowedModes: scope === "dictationAgentVision" ? ["providers"] : undefined,
    keys: env.options.savedKeyPresence(raw),
    copilot: { signedIn: true, login: "octocat", models: COPILOT_MODELS },
    localModels: env.registry.modelRegistry
      .getAllProviders()[0]
      .models.slice(0, 2)
      .map((model) => ({ id: model.id, name: model.name })),
    current: {
      mode: config.mode,
      provider: config.provider,
      model: config.model,
      cloudBaseUrl: config.cloudBaseUrl,
      remoteUrl: config.remoteUrl,
    },
    managedDeployment: null,
    ...overrides,
  };
}

function commit(scope, pick, { policy = UNMANAGED, context = {}, deps = {} } = {}) {
  const calls = { signIn: 0, modes: [], setupModes: [] };
  const raw = env.store.useSettingsStore.getState();
  const ctx = pickerContext(scope, policy, context);
  const result = env.adapter.commitLlmSelection(scope, pick, {
    context: ctx,
    effectiveMode: ctx.current.mode,
    currentProvider: ctx.current.provider,
    enterpriseSetupMode: raw.enterpriseSetupMode,
    managedTakesOver: false,
    write: env.store.setResolvedLLMConfig,
    setEnterpriseSetupMode: (mode) => {
      calls.setupModes.push(mode);
      raw.setEnterpriseSetupMode(mode);
    },
    requestSignIn: () => {
      calls.signIn += 1;
    },
    onModeChange: (mode) => calls.modes.push(mode),
    ...deps,
  });
  return { result, calls };
}

/** Every scope's store keys plus every route a request resolves. */
function snapshot(policy = UNMANAGED) {
  const { store, scopes, agent, translation } = env;
  const raw = store.useSettingsStore.getState();
  const effective = store.selectPolicyEffectiveSettings(raw, policy);
  const keys = { enterpriseSetupMode: raw.enterpriseSetupMode };
  for (const scope of SCOPES) {
    for (const key of Object.values(scopes.INFERENCE_SCOPES[scope].storeKeys)) keys[key] = raw[key];
  }
  const routes = {
    resolved: Object.fromEntries(
      SCOPES.map((scope) => [scope, store.selectResolvedLLMConfig(effective, scope)])
    ),
    cleanupModel: store.getEffectiveCleanupModel(effective),
    cloudCleanup: store.selectIsCloudCleanupMode(effective),
    noteFormatting: store.selectResolvedNoteFormatting(effective),
    assistant: agent.resolveDictationAgentInference(effective, {
      isCloudAgent: store.selectIsCloudDictationAgentMode(effective),
    }),
    vision: agent.resolveDictationAgentVisionInference(effective, {
      isSignedIn: effective.isSignedIn,
    }),
    chat: agent.resolveChatStreamingInference(effective, {}),
    assistantPanel: agent.resolveChatStreamingInference(effective, {
      inferenceScope: "dictationAgent",
      hasScreenContext: true,
      isProviderImageWired: () => true,
    }),
    translation: translation.resolveDictationTranslationInference(effective, {
      isCloudTranslation: store.selectIsCloudTranslationMode(effective),
    }),
    localServer: store.selectLocalServerPrefs(raw, policy),
  };
  return { keys, routes };
}

const reset = (state) => env.store.useSettingsStore.setState(state);

/** Each kind of pick, as the old editor made it and as the picker makes it. */
function kinds(f) {
  return [
    {
      name: "OpenWhispr Cloud",
      offered: (scope) => scope !== "dictationAgentVision",
      old: (scope, policy) => OLD.modeCard(scope, "openwhispr", policy),
      pick: { mode: "openwhispr", provider: "", model: "" },
    },
    {
      name: "a GitHub Copilot model",
      offered: (scope) => COPILOT_SCOPES.has(scope),
      old: (scope, policy) => {
        OLD.modeCard(scope, "providers", policy);
        OLD.modelClick(scope, "copilot", "gpt-6-luna");
      },
      pick: { mode: "providers", provider: "copilot", model: "gpt-6-luna" },
    },
    {
      name: "a Groq model",
      offered: () => true,
      old: (scope, policy) => {
        OLD.modeCard(scope, "providers", policy);
        OLD.modelClick(scope, "groq", f.groq[1]);
      },
      pick: { mode: "providers", provider: "groq", model: f.groq[1] },
    },
    {
      name: "an OpenRouter model from the catalog search",
      offered: () => true,
      old: (scope, policy) => {
        OLD.modeCard(scope, "providers", policy);
        OLD.modelClick(scope, "openrouter", "google/gemini-3.5-flash-lite");
      },
      pick: { mode: "providers", provider: "openrouter", model: "google/gemini-3.5-flash-lite" },
    },
    {
      name: "a custom endpoint's model",
      offered: () => true,
      old: (scope, policy) => {
        OLD.modeCard(scope, "providers", policy);
        OLD.modelClick(scope, "custom", "my-model");
      },
      pick: { mode: "providers", provider: "custom", model: "my-model" },
    },
    {
      name: "a local model",
      offered: (scope) => scope !== "dictationAgentVision",
      old: (scope, policy) => {
        OLD.modeCard(scope, "local", policy);
        OLD.localClick(scope, f.local[1]);
      },
      pick: { mode: "local", provider: f.localProvider, model: f.local[1] },
    },
    {
      name: "a self-hosted server",
      offered: (scope) => scope !== "dictationAgentVision",
      old: (scope, policy) => OLD.modeCard(scope, "self-hosted", policy),
      pick: { mode: "self-hosted", provider: "", model: "", action: "configureSelfHosted" },
    },
    {
      name: "enterprise",
      offered: (scope) => scope !== "dictationAgentVision",
      old: (scope, policy) => OLD.modeCard(scope, "enterprise", policy),
      pick: { mode: "enterprise", provider: "", model: "", action: "configureEnterprise" },
    },
  ];
}

test("every pick leaves the store and every request route as the old editor did", async (t) => {
  await load(t);
  const f = fixtures(env);
  const policies = [
    ["unmanaged", UNMANAGED],
    [
      "managed",
      managedPolicy({
        allowedModes: ["providers", "local", "self-hosted"],
        allowedByokProviders: ["groq", "openai", "copilot", "custom", "openrouter"],
      }),
    ],
  ];
  let compared = 0;
  for (const [policyName, policy] of policies) {
    for (const [startName, start] of [
      ["the daily setup", f.user],
      ["everything local", f.allLocal],
    ]) {
      for (const scope of SCOPES) {
        for (const kind of kinds(f)) {
          if (!kind.offered(scope)) continue;
          const offered = env.options.pickAvailability(
            scope,
            kind.pick,
            pickerContext(scope, policy)
          );
          if (offered === null) continue; // policy hides it, as it hid the old mode or tab
          const label = `${policyName}, ${startName}, ${scope}: ${kind.name}`;

          reset(start);
          kind.old(scope, policy);
          const before = snapshot(policy);

          reset(start);
          const { result } = commit(scope, kind.pick, { policy });
          assert.equal(result.status, "committed", label);
          assert.deepEqual(snapshot(policy), before, label);
          compared += 1;
        }
      }
    }
  }
  assert.ok(compared >= 140, `${compared} comparisons`);
});

test("each pick is one write of mode, cloud mode, provider and model", async (t) => {
  await load(t);
  const f = fixtures(env);
  reset(f.user);
  const writes = [];
  const { result } = commit(
    "dictationCleanup",
    { mode: "local", provider: f.localProvider, model: f.local[0] },
    { deps: { write: (scope, patch) => writes.push([scope, patch]) } }
  );
  assert.equal(result.status, "committed");
  assert.deepEqual(writes, [
    [
      "dictationCleanup",
      { mode: "local", cloudMode: "byok", provider: f.localProvider, model: f.local[0] },
    ],
  ]);

  // Same mode: provider and model only, as the model list wrote them.
  writes.length = 0;
  commit(
    "dictationCleanup",
    { mode: "providers", provider: "groq", model: f.groq[0] },
    { deps: { write: (scope, patch) => writes.push([scope, patch]) } }
  );
  assert.deepEqual(writes, [["dictationCleanup", { provider: "groq", model: f.groq[0] }]]);
});

test("Cloud while signed out asks to sign in and writes nothing; Cloud off is refused", async (t) => {
  await load(t);
  const f = fixtures(env);
  for (const scope of SCOPES.filter((scope) => scope !== "dictationAgentVision")) {
    reset({ ...f.user, isSignedIn: false });
    const before = snapshot();
    const signedOut = commit(scope, { mode: "openwhispr", provider: "", model: "" });
    assert.equal(signedOut.result.status, "signIn", scope);
    assert.equal(signedOut.calls.signIn, 1, scope);
    assert.deepEqual(signedOut.calls.modes, []);
    assert.deepEqual(snapshot(), before, `${scope}: nothing written`);

    const off = commit(
      scope,
      { mode: "openwhispr", provider: "", model: "" },
      { context: { cloudDisabled: true } }
    );
    assert.equal(off.result.status, "refused", scope);
    assert.equal(off.result.reason.reasonKey, "modelPicker.reasons.cloudOff");
    assert.equal(off.calls.signIn, 0, "no sign-in while Cloud is off");
    assert.deepEqual(snapshot(), before);
  }
});

test("a pick that became invalid by commit time is refused and writes nothing", async (t) => {
  await load(t);
  const f = fixtures(env);
  const refused = (label, scope, pick, options, reasonKey) => {
    reset(f.user);
    const before = snapshot(options.policy);
    const { result, calls } = commit(scope, pick, options);
    assert.equal(result.status, "refused", label);
    assert.equal(result.reason?.reasonKey ?? null, reasonKey, label);
    assert.deepEqual(calls.modes, [], label);
    assert.deepEqual(snapshot(options.policy), before, `${label}: nothing written`);
  };
  const groqPick = { mode: "providers", provider: "groq", model: f.groq[1] };
  refused(
    "the key was removed",
    "chatIntelligence",
    groqPick,
    { context: { keys: {} } },
    "modelPicker.reasons.noKey"
  );
  refused(
    "policy now forbids the provider",
    "chatIntelligence",
    groqPick,
    {
      policy: managedPolicy({ allowedModes: ["providers"], allowedByokProviders: ["openai"] }),
    },
    null
  );
  refused(
    "policy now forbids the mode",
    "dictationCleanup",
    { mode: "local", provider: f.localProvider, model: f.local[0] },
    { policy: managedPolicy({ allowedModes: ["providers"], allowedByokProviders: ["groq"] }) },
    null
  );
  refused(
    "Copilot can't serve chat",
    "chatIntelligence",
    { mode: "providers", provider: "copilot", model: "gpt-6-luna" },
    {},
    "modelPicker.reasons.copilotScope"
  );
  refused(
    "Copilot signed out meanwhile",
    "dictationCleanup",
    { mode: "providers", provider: "copilot", model: "gpt-6-luna" },
    { context: { copilot: { signedIn: false, models: COPILOT_MODELS } } },
    "modelPicker.reasons.copilotSignedOut"
  );
  refused(
    "the Copilot sign-in is still being read",
    "dictationCleanup",
    { mode: "providers", provider: "copilot", model: "gpt-6-luna" },
    { context: { copilot: { signedIn: false, checking: true, models: COPILOT_MODELS } } },
    "reasoning.copilot.loading"
  );
  refused(
    "the local model was deleted",
    "dictationCleanup",
    { mode: "local", provider: f.localProvider, model: f.local[1] },
    { context: { localModels: [] } },
    null
  );
  refused(
    "a model the provider doesn't list",
    "dictationCleanup",
    { mode: "providers", provider: "openai", model: "not-a-model" },
    {},
    null
  );
  refused(
    "the vision override can't go local",
    "dictationAgentVision",
    { mode: "local", provider: f.localProvider, model: f.local[0] },
    {},
    null
  );
});

test("the mode-change callback fires only when the mode changes", async (t) => {
  await load(t);
  const f = fixtures(env);
  reset(f.user);
  const toLocal = commit("dictationCleanup", {
    mode: "local",
    provider: f.localProvider,
    model: f.local[0],
  });
  assert.deepEqual(toLocal.calls.modes, ["local"]);
  const sameMode = commit("dictationCleanup", {
    mode: "local",
    provider: f.localProvider,
    model: f.local[1],
  });
  assert.deepEqual(sameMode.calls.modes, []);
  assert.equal(sameMode.result.modeChanged, false);
});

test("note formatting keeps inheriting until a pick overrides it", async (t) => {
  await load(t);
  const f = fixtures(env);
  const { store } = env;
  reset(f.user);
  const before = snapshot();

  // Building the menu and the button, and reading the inherited fields, write nothing.
  const ctx = pickerContext("noteFormatting", UNMANAGED);
  env.options.buildModelPickerOptions("noteFormatting", ctx);
  env.options.describePickerSelection("noteFormatting", ctx);
  const effective = store.selectPolicyEffectiveSettings(
    store.useSettingsStore.getState(),
    UNMANAGED
  );
  const fields = env.options.noteFormattingFields(
    effective,
    store.selectResolvedLLMConfig(effective, "noteFormatting")
  );
  assert.deepEqual(
    fields.map((field) => [field.field, field.inherited]),
    [
      ["provider", true],
      ["model", true],
    ]
  );
  assert.deepEqual(snapshot(), before, "nothing materialized by opening");

  // Browsing (the custom endpoint's fields, OpenRouter's catalog, a link) writes nothing.
  for (const action of ["configureCustom", "searchOpenRouter", "link"]) {
    const { result } = commit("noteFormatting", {
      mode: "providers",
      provider: action === "searchOpenRouter" ? "openrouter" : "custom",
      model: "",
      action,
    });
    assert.equal(result.status, "browse", action);
  }
  assert.deepEqual(snapshot(), before);

  // Cleanup's change still reaches note formatting.
  commit("dictationCleanup", { mode: "providers", provider: "groq", model: f.groq[1] });
  assert.equal(
    store.selectResolvedNoteFormatting(store.useSettingsStore.getState()).model,
    f.groq[1]
  );
  assert.equal(store.useSettingsStore.getState().noteFormattingModel, "", "still inherited");

  // An explicit pick is note formatting's own.
  commit("noteFormatting", { mode: "providers", provider: "openai", model: f.openai[0] });
  const state = store.useSettingsStore.getState();
  assert.equal(state.noteFormattingProvider, "openai");
  assert.equal(state.noteFormattingModel, f.openai[0]);
});

test("the vision override writes its own pick only, and opening writes nothing", async (t) => {
  await load(t);
  const f = fixtures(env);
  const { store } = env;
  reset(f.user);
  const before = snapshot();
  const ctx = pickerContext("dictationAgentVision", UNMANAGED);
  assert.equal(ctx.current.model, "", "an unset override shows unset, not the assistant's model");
  env.options.buildModelPickerOptions("dictationAgentVision", ctx);
  assert.deepEqual(snapshot(), before);

  const { result } = commit("dictationAgentVision", {
    mode: "providers",
    provider: "openai",
    model: f.openai[0],
  });
  assert.deepEqual(result.patch, { provider: "openai", model: f.openai[0] });
  const state = store.useSettingsStore.getState();
  assert.equal(state.dictationAgentVisionProvider, "openai");
  assert.equal(state.dictationAgentVisionModel, f.openai[0]);
  assert.equal(state.dictationAgentProvider, "groq", "the assistant's own pick is untouched");
});

test("enterprise setup mode: the managed entry switches to managed, a pick it would override to manual", async (t) => {
  await load(t);
  const f = fixtures(env);
  const { store } = env;
  reset({ ...f.user, enterpriseSetupMode: "manual" });
  const before = snapshot();
  const managed = commit(
    "dictationCleanup",
    { mode: "enterprise", provider: "", model: "", action: "useManaged" },
    { context: { managedDeployment: { provider: "bedrock", model: "m" } } }
  );
  assert.equal(managed.result.status, "managed");
  assert.deepEqual(managed.calls.setupModes, ["managed"]);
  const after = snapshot();
  assert.equal(after.keys.enterpriseSetupMode, "managed");
  assert.deepEqual({ ...after.keys, enterpriseSetupMode: "manual" }, before.keys, "nothing else");

  // Without a managed deployment the entry isn't offered.
  reset({ ...f.user, enterpriseSetupMode: "manual" });
  const none = commit("dictationCleanup", {
    mode: "enterprise",
    provider: "",
    model: "",
    action: "useManaged",
  });
  assert.equal(none.result.status, "refused");
  assert.deepEqual(none.calls.setupModes, []);

  // A pick that a managed deployment would otherwise override sets manual.
  reset({ ...f.user, enterpriseSetupMode: "auto" });
  const manual = commit(
    "dictationCleanup",
    { mode: "enterprise", provider: "", model: "", action: "configureEnterprise" },
    { deps: { managedTakesOver: true } }
  );
  assert.equal(manual.result.status, "committed");
  assert.deepEqual(manual.calls.setupModes, ["manual"]);
  assert.equal(store.useSettingsStore.getState().cleanupMode, "enterprise");

  // Otherwise the (global) setup mode is left alone.
  reset({ ...f.user, enterpriseSetupMode: "auto" });
  const untouched = commit("dictationCleanup", {
    mode: "enterprise",
    provider: "",
    model: "",
    action: "configureEnterprise",
  });
  assert.deepEqual(untouched.calls.setupModes, []);
  assert.equal(store.useSettingsStore.getState().enterpriseSetupMode, "auto");
});

nodeTest("the language-model selection adapter", async (t) => {
  await load(t);
  for (const [name, fn] of subtests) await t.test(name, fn);
});
