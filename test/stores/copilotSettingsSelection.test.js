const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// GitHub Copilot's models come from the signed-in plan, so a saved pick can be
// an id the shipped list doesn't carry; and Copilot serves only text scopes, so
// no policy fallback may land a chat or assistant scope on it.

const LIVE_LIST = [
  { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", description: "" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", description: "" },
];

const managedPolicy = (allowedByokProviders, allowedModes = ["openwhispr", "providers"]) => ({
  status: "managed",
  appVersion: "1.10.3",
  policy: {
    version: 1,
    transcription: { allowedModes: ["openwhispr"], allowedByokProviders: [] },
    llm: { allowedModes, allowedByokProviders, allowedEnterpriseProviders: [] },
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

async function loadStore(t, initialStorage, cachePrefix) {
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1", ...initialStorage },
  });
  const vite = await createRendererServer(t, { cachePrefix });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  return vite.ssrLoadModule("/stores/settingsStore.ts");
}

test("a live-catalog Copilot pick survives a provider round trip and the startup sweep", async (t) => {
  const { useSettingsStore, reconcileRetiredCloudModelSelections } = await loadStore(
    t,
    {
      copilotModels: JSON.stringify({ models: LIVE_LIST, fetchedAt: Date.now() }),
      cleanupMode: "providers",
      cleanupProvider: "copilot",
      cleanupModel: "gpt-5.6-terra",
      noteFormattingMode: "providers",
      noteFormattingProvider: "copilot",
      noteFormattingModel: "gpt-5.6-terra",
    },
    "openwhispr-copilot-live-pick-test-"
  );
  const state = () => useSettingsStore.getState();

  reconcileRetiredCloudModelSelections();
  assert.equal(state().cleanupModel, "gpt-5.6-terra", "not reset before the live list loads");

  state().switchReasoningProvider("dictationCleanup", "openai", "gpt-5.2");
  assert.equal(state().cleanupModel, "gpt-5.2");
  state().switchReasoningProvider("dictationCleanup", "copilot", "claude-haiku-5.5");
  assert.equal(state().cleanupModel, "gpt-5.6-terra", "the live id is Copilot's own");

  // Reselecting Copilot keeps an id from the shipped list too.
  useSettingsStore.setState({ noteFormattingModel: "mai-code-2-flash" });
  state().switchReasoningProvider("noteFormatting", "copilot", "claude-haiku-5.5");
  assert.equal(state().noteFormattingModel, "mai-code-2-flash");
});

test("an id Copilot never listed is kept until a live list says otherwise, but not remembered", async (t) => {
  const { useSettingsStore, reconcileRetiredCloudModelSelections } = await loadStore(
    t,
    { cleanupMode: "providers", cleanupProvider: "copilot", cleanupModel: "gpt-5.6-terra" },
    "openwhispr-copilot-foreign-pick-test-"
  );
  const state = () => useSettingsStore.getState();

  // No live list this session yet: the startup sweep can't tell retired from unloaded.
  reconcileRetiredCloudModelSelections();
  assert.equal(state().cleanupModel, "gpt-5.6-terra");

  state().switchReasoningProvider("dictationCleanup", "openai", "gpt-5.2");
  state().switchReasoningProvider("dictationCleanup", "copilot", "claude-haiku-5.5");
  assert.equal(state().cleanupModel, "claude-haiku-5.5", "falls back to Copilot's default");
});

test("policy never puts a chat or assistant scope on Copilot", async (t) => {
  const { useSettingsStore, selectPolicyEffectiveSettings, llmPolicyProviderIds } = await loadStore(
    t,
    {
      cleanupMode: "providers",
      cleanupProvider: "anthropic",
      cleanupModel: "claude-sonnet-5",
      chatAgentMode: "providers",
      chatAgentProvider: "anthropic",
      chatAgentModel: "claude-sonnet-5",
      dictationAgentMode: "providers",
      dictationAgentProvider: "anthropic",
      dictationAgentModel: "claude-sonnet-5",
      translationMode: "providers",
      translationProvider: "anthropic",
      translationModel: "claude-sonnet-5",
    },
    "openwhispr-copilot-policy-scope-test-"
  );

  assert.ok(llmPolicyProviderIds("dictationCleanup").includes("copilot"));
  assert.ok(llmPolicyProviderIds("noteFormatting").includes("copilot"));
  assert.ok(llmPolicyProviderIds("dictationTranslation").includes("copilot"));
  for (const scope of ["chatIntelligence", "dictationAgent", "dictationAgentVision"]) {
    assert.ok(!llmPolicyProviderIds(scope).includes("copilot"), scope);
  }

  // Copilot is the only BYOK provider the org allows: text scopes move onto
  // it, while chat and the assistant move to a mode that can serve them.
  const effective = selectPolicyEffectiveSettings(
    useSettingsStore.getState(),
    managedPolicy(["copilot"])
  );
  assert.equal(effective.cleanupProvider, "copilot");
  assert.equal(effective.cleanupModel, "claude-haiku-5.5");
  assert.equal(effective.translationProvider, "copilot");
  assert.notEqual(effective.chatAgentProvider, "copilot");
  assert.equal(effective.chatAgentMode, "openwhispr");
  assert.notEqual(effective.dictationAgentProvider, "copilot");
  assert.equal(effective.dictationAgentMode, "openwhispr");
});

test("a stale Copilot pick on a chat or assistant scope is unconfigured under policy", async (t) => {
  const { useSettingsStore, selectPolicyEffectiveSettings, selectResolvedLLMConfig } =
    await loadStore(
      t,
      {
        chatAgentMode: "providers",
        chatAgentProvider: "copilot",
        chatAgentModel: "claude-haiku-5.5",
        dictationAgentMode: "providers",
        dictationAgentProvider: "copilot",
        dictationAgentModel: "claude-haiku-5.5",
        dictationAgentVisionMode: "providers",
        dictationAgentVisionModel: "claude-haiku-5.5",
      },
      "openwhispr-copilot-policy-stale-test-"
    );

  const raw = useSettingsStore.getState();
  const effective = selectPolicyEffectiveSettings(raw, managedPolicy(["copilot", "openai"]));

  for (const scope of ["chatIntelligence", "dictationAgent", "dictationAgentVision"]) {
    const config = selectResolvedLLMConfig(effective, scope);
    assert.equal(config.provider, "", `${scope} provider`);
    assert.equal(config.model, "", `${scope} model`);
  }
  assert.equal(raw.chatAgentProvider, "copilot", "the saved preference is untouched");
});
