const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The live GitHub Copilot list: applied to the registry only from a successful
// signed-in fetch, a saved pick reconciled only then, and the previous
// account's list dropped on sign-out.

const CATALOG = [
  {
    id: "claude-haiku-5.5",
    name: "Claude Haiku 5.5",
    supportsVision: true,
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    policyState: "enabled",
    inputPrice: 10,
    outputPrice: 50,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    supportsVision: true,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    policyState: "enabled",
    inputPrice: null,
    outputPrice: null,
  },
];

async function load(t, initialStorage = {}) {
  const calls = { list: [] };
  let listResult = { success: true, models: CATALOG };
  let broadcast = null;
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1", ...initialStorage },
    window: {
      electronAPI: {
        listCopilotModels: async (options) => {
          calls.list.push(options);
          return listResult;
        },
        getCopilotAuthStatus: async () => ({ configured: true, state: "signedOut", login: "" }),
        onCopilotAuthChanged: (callback) => {
          broadcast = callback;
          return () => {};
        },
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-copilot-models-test-" });
  const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const models = await vite.ssrLoadModule("/models/copilotModels.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const store = await vite.ssrLoadModule("/stores/copilotStore.ts");
  return {
    ...registry,
    ...models,
    ...store,
    useSettingsStore,
    vite,
    calls,
    setListResult: (result) => {
      listResult = result;
    },
    broadcast: (status) => broadcast(status),
  };
}

test("a signed-in fetch replaces the list and repoints only text scopes it no longer serves", async (t) => {
  const api = await load(t, {
    cleanupMode: "providers",
    cleanupProvider: "copilot",
    cleanupModel: "claude-sonnet-5.5",
    translationMode: "providers",
    translationProvider: "copilot",
    translationModel: "gpt-6-astra",
    chatAgentMode: "providers",
    chatAgentProvider: "copilot",
    chatAgentModel: "claude-sonnet-5.5",
  });

  const fresh = await api.refreshCopilotModels({ force: true });

  assert.deepEqual(api.calls.list, [{ refresh: true }]);
  assert.deepEqual(
    fresh.map((model) => model.id),
    ["claude-haiku-5.5", "gpt-6-astra"]
  );
  const [haiku, astra] = api.getCopilotModels();
  assert.equal(haiku.descriptionKey, "models.descriptions.cloud.copilot_claude_haiku_5_5");
  assert.equal(haiku.supportsThinking, true);
  assert.equal(haiku.supportsVision, undefined, "text-only here, whatever the catalog says");
  assert.equal(astra.descriptionKey, "models.descriptions.cloud.copilot_live");
  assert.equal(astra.supportsThinking, false);
  assert.ok(JSON.parse(localStorage.getItem("copilotModels")).models.length === 2);

  const state = api.useSettingsStore.getState();
  assert.equal(
    state.cleanupModel,
    "claude-haiku-5.5",
    "a model the plan dropped moves to the default"
  );
  assert.equal(state.translationModel, "gpt-6-astra", "a served live id stays");
  assert.equal(state.chatAgentModel, "claude-sonnet-5.5", "chat isn't Copilot's to repoint");

  // Fresh within the hour: no second trip to main.
  await api.refreshCopilotModels();
  assert.equal(api.calls.list.length, 1);
});

test("note formatting inheriting Copilot from cleanup gets a Copilot model", async (t) => {
  const api = await load(t, {
    cleanupMode: "providers",
    cleanupProvider: "copilot",
    cleanupModel: "claude-haiku-5.5",
    noteFormattingMode: "providers",
    noteFormattingProvider: "",
    noteFormattingModel: "openai/gpt-oss-120b",
  });

  await api.refreshCopilotModels({ force: true });

  const state = api.useSettingsStore.getState();
  assert.equal(state.noteFormattingProvider, "", "still follows cleanup's provider");
  assert.equal(state.noteFormattingModel, "claude-haiku-5.5");
});

test("switching cleanup to Copilot repoints note formatting at once, never a local pick", async (t) => {
  const api = await load(t, {
    cleanupMode: "providers",
    cleanupProvider: "openrouter",
    cleanupModel: "openai/gpt-4o-mini",
    noteFormattingMode: "providers",
    noteFormattingProvider: "",
    noteFormattingModel: "openai/gpt-oss-120b",
    translationMode: "local",
    translationProvider: "",
    translationModel: "qwen3-4b-q4_k_m",
    copilotModels: JSON.stringify({
      models: [
        { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", description: "" },
        { id: "gpt-6-astra", name: "GPT-6 Astra", description: "" },
      ],
      fetchedAt: Date.now(),
    }),
  });
  const { setResolvedLLMConfig } = await api.vite.ssrLoadModule("/stores/settingsStore.ts");

  setResolvedLLMConfig("dictationCleanup", { provider: "copilot", model: "gpt-6-astra" });
  setResolvedLLMConfig("dictationTranslation", { provider: "copilot" });

  const state = api.useSettingsStore.getState();
  assert.equal(state.cleanupModel, "gpt-6-astra");
  assert.equal(state.noteFormattingModel, "claude-haiku-5.5", "the inherited scope is repaired");
  assert.equal(state.translationModel, "qwen3-4b-q4_k_m", "local mode shares the slot");
  assert.equal(api.calls.list.length, 0, "no trip to main for it");
});

test("a list older than the hour never repoints on a settings change", async (t) => {
  const api = await load(t, {
    cleanupMode: "providers",
    cleanupProvider: "copilot",
    cleanupModel: "claude-haiku-5.5",
    noteFormattingMode: "providers",
    noteFormattingProvider: "",
    noteFormattingModel: "openai/gpt-oss-120b",
    copilotModels: JSON.stringify({
      models: [{ id: "claude-haiku-5.5", name: "Claude Haiku 5.5", description: "" }],
      fetchedAt: Date.now() - 2 * 60 * 60 * 1000,
    }),
  });

  api.useSettingsStore.getState().setAutoGenerateNoteTitle(false);

  assert.equal(api.useSettingsStore.getState().noteFormattingModel, "openai/gpt-oss-120b");
});

test("a failed fetch leaves the list and the saved pick alone", async (t) => {
  const api = await load(t, {
    cleanupMode: "providers",
    cleanupProvider: "copilot",
    cleanupModel: "gpt-5.6-terra",
  });
  api.setListResult({
    success: false,
    error: "GitHub Copilot is having problems right now.",
    code: "PROVIDER_UNAVAILABLE",
  });

  await assert.rejects(api.refreshCopilotModels({ force: true }), { code: "PROVIDER_UNAVAILABLE" });
  assert.deepEqual(
    api.getCopilotModels().map((model) => model.id),
    ["claude-haiku-5.5", "mai-code-2-flash", "gpt-6-luna", "claude-sonnet-5.5"]
  );
  assert.equal(api.useSettingsStore.getState().cleanupModel, "gpt-5.6-terra");
});

test("signing out restores the shipped list; a new sign-in refetches", async (t) => {
  const api = await load(t, {
    copilotModels: JSON.stringify({
      models: [{ id: "gpt-6-astra", name: "GPT-6 Astra", description: "" }],
      fetchedAt: Date.now(),
    }),
  });
  assert.deepEqual(
    api.getCopilotModels().map((model) => model.id),
    ["gpt-6-astra"],
    "the last account's list is shown until main answers"
  );

  // Main says nobody is signed in: the cached list was another session's.
  await api.syncCopilotAuthStatus();
  assert.equal(api.useCopilotStore.getState().loaded, true);
  assert.equal(localStorage.getItem("copilotModels"), null);
  assert.equal(api.getCopilotModels()[0].id, "claude-haiku-5.5");

  api.broadcast({ configured: true, state: "signedIn", login: "octocat" });
  assert.equal(api.useCopilotStore.getState().status.login, "octocat");
  assert.equal(api.isCopilotListFresh(), false, "the new account's list is fetched, not assumed");
  await api.refreshCopilotModels();
  assert.equal(api.calls.list.length, 1);
  assert.equal(api.getCopilotModels().length, 2);

  api.broadcast({ configured: true, state: "signedOut", login: "" });
  assert.equal(api.getCopilotModels()[0].id, "claude-haiku-5.5");
  assert.equal(localStorage.getItem("copilotModels"), null);
});
