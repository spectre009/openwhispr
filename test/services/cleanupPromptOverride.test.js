const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The cleanup override: a candidate prompt runs through the real cleanup
// request, exactly as a dictation would send it if that prompt were the one in
// use: same system prompt (assistant name, dictionary), transcript wrapper,
// sampling, completeness rule and output validation, and the same Cloud prompt
// routing. And running it never changes what is saved.

const AGENT = "Jarvis";
const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";
const DUPLICATE = `**Cleaned transcript:**\n${CLEAN}\n\n${CLEAN}`;
const CANDIDATE = "Tidy this dictation for {{agentName}}. Keep every word that matters.";
const OTHER_SAVED = "A different saved prompt that must not be used.";

const PROVIDERS = {
  copilot: {
    settings: { cleanupMode: "providers", cleanupProvider: "copilot", cleanupModel: "gpt-6-luna" },
    channel: "copilot",
  },
  "custom endpoint (OpenAI-compatible BYOK)": {
    settings: {
      cleanupMode: "providers",
      cleanupProvider: "custom",
      cleanupModel: "my-model",
      cleanupCloudBaseUrl: "https://cleanup.example.test/v1/chat/completions",
      cleanupCustomApiKey: "synthetic-key",
    },
    channel: "fetch",
  },
  openai: {
    settings: { cleanupMode: "providers", cleanupProvider: "openai", cleanupModel: "gpt-4.1-mini" },
    channel: "fetch",
  },
  groq: {
    settings: {
      cleanupMode: "providers",
      cleanupProvider: "groq",
      cleanupModel: "openai/gpt-oss-20b",
    },
    channel: "fetch",
  },
  gemini: {
    settings: {
      cleanupMode: "providers",
      cleanupProvider: "gemini",
      cleanupModel: "gemini-3.5-flash",
    },
    channel: "fetch",
  },
  anthropic: {
    settings: {
      cleanupMode: "providers",
      cleanupProvider: "anthropic",
      cleanupModel: "claude-haiku-4-5",
    },
    channel: "anthropic",
  },
  local: {
    settings: { cleanupMode: "local", cleanupProvider: "qwen", cleanupModel: "qwen3.5-4b-q4_k_m" },
    channel: "local",
  },
  "self-hosted (LAN)": {
    settings: {
      cleanupMode: "self-hosted",
      cleanupProvider: "",
      cleanupModel: "lan-model",
      cleanupRemoteUrl: "http://192.168.1.50:8080",
    },
    channel: "fetch",
  },
  "OpenWhispr Cloud": {
    settings: {
      isSignedIn: true,
      cleanupMode: "openwhispr",
      cleanupCloudMode: "openwhispr",
      cleanupProvider: "openwhispr",
      cleanupModel: "",
    },
    channel: "cloud",
  },
};

async function setup(t) {
  const requests = [];
  let reply = DUPLICATE;
  const ipc = (channel) => async (text, model, agentName, config) => {
    requests.push({ channel, text, model, agentName, config });
    return { success: true, text: reply };
  };
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1" },
    window: {
      electronAPI: {
        processCopilotReasoning: ipc("copilot"),
        processLocalReasoning: ipc("local"),
        processAnthropicReasoning: ipc("anthropic"),
        cloudReason: async (text, opts) => {
          requests.push({ channel: "cloud", text, opts });
          return { success: true, text: reply, model: "cloud-model", provider: "openwhispr" };
        },
        getOpenAIKey: async () => "synthetic-openai-key",
        getGroqKey: async () => "synthetic-groq-key",
        getGeminiKey: async () => "synthetic-gemini-key",
        getCleanupCustomKey: async () => "synthetic-key",
      },
    },
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || "GET") !== "POST") {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    requests.push({ channel: "fetch", url: String(url), body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: reply }] }],
        choices: [{ message: { content: reply }, finish_reason: "stop" }],
        candidates: [{ content: { parts: [{ text: reply }] }, finishReason: "STOP" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cleanup-override-",
    mockModules: {
      // audioManager's own graph; the cleanup path under test is real.
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  const settingsModule = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const override = await vite.ssrLoadModule("/services/cleanupWithPrompt.ts");
  const audio = await vite.ssrLoadModule("/helpers/audioManager.js");
  const { wrapCleanupTranscript } = await vite.ssrLoadModule("/config/prompts.ts");

  const { useSettingsStore, getSettings, getEffectiveCleanupModel } = settingsModule;
  useSettingsStore.setState({
    useCleanupModel: true,
    useDictationAgent: false,
    customDictionary: ["Kubernetes", "Shafranov"],
    preferredLanguage: "en",
    uiLanguage: "en",
  });

  // What a dictation does today: the route's cleanup config and the effective
  // model, through the same call the batch path makes.
  const manager = Object.create(audio.default.prototype);
  const dictate = async () => {
    const route = audio.resolveReasoningRoute(RAW, getSettings(), AGENT, false, false);
    assert.equal(route.kind, "cleanup");
    return manager.processWithReasoningModel(RAW, getEffectiveCleanupModel(), AGENT, {
      ...route.config,
    });
  };

  // Puts `text` in use through the library ("" = Default).
  const saveInUse = (text) => {
    const store = useSettingsStore.getState();
    if (!text) {
      store.activatePrompt("cleanup", "default");
      return;
    }
    const existing = store.promptLibraries.cleanup.entries.find((entry) => entry.text === text);
    const id = existing?.id ?? store.createPrompt("cleanup", { name: "Saved", text });
    useSettingsStore.getState().activatePrompt("cleanup", id);
  };

  const outcome = async (run) => {
    const before = requests.length;
    let result;
    try {
      result = { text: await run() };
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      result = { code: error.code };
    }
    assert.equal(requests.length, before + 1, "exactly one request was dispatched");
    return { request: requests[requests.length - 1], result };
  };

  return {
    storage,
    service,
    override,
    useSettingsStore,
    getSettings,
    dictate,
    saveInUse,
    outcome,
    wrapCleanupTranscript,
    setReply: (next) => {
      reply = next;
    },
  };
}

// Shapes that identify a cleanup request on each channel.
function systemPromptOf(request) {
  if (request.channel === "fetch") {
    const body = request.body;
    if (body.systemInstruction) return body.systemInstruction.parts[0].text;
    const messages = body.messages ?? body.input;
    return messages.find((message) => message.role === "system").content;
  }
  return request.config.systemPrompt;
}

function userContentOf(request) {
  if (request.channel === "fetch") {
    const body = request.body;
    if (body.contents) return body.contents[0].parts[0].text;
    const messages = body.messages ?? body.input;
    return messages.find((message) => message.role === "user").content;
  }
  return request.text;
}

for (const [name, provider] of Object.entries(PROVIDERS)) {
  test(`${name}: a candidate runs as the cleanup request a dictation would send`, async (t) => {
    const ctx = await setup(t);
    ctx.useSettingsStore.setState(provider.settings);

    for (const candidate of [
      { label: "built-in default", saved: "", override: { mode: "builtin" } },
      { label: "custom prompt", saved: CANDIDATE, override: { mode: "text", text: CANDIDATE } },
    ]) {
      // The prompt in use, as a dictation sends it.
      ctx.saveInUse(candidate.saved);
      const active = await ctx.outcome(() => ctx.dictate());

      // Another prompt in use; the candidate rides on the request instead.
      ctx.saveInUse(OTHER_SAVED);
      const dispatched = [];
      const tested = await ctx.outcome(() =>
        ctx.override.runCleanupWithPrompt(RAW, candidate.override, {
          agentName: AGENT,
          onDispatch: (info) => dispatched.push(info),
        })
      );

      // Same request, apart from how long a dictation waits for a busy local
      // model before it fails (#3112's busyWaitMs, dictation's scheduling only:
      // a test-set run gives the model up to a dictation instead).
      const withoutBusyWait = (request) => {
        if (!request?.config || !("busyWaitMs" in request.config)) return request;
        const config = { ...request.config };
        delete config.busyWaitMs;
        return { ...request, config };
      };
      assert.deepEqual(
        withoutBusyWait(tested.request),
        withoutBusyWait(active.request),
        `${candidate.label}: same request`
      );
      assert.deepEqual(tested.result, active.result, `${candidate.label}: same validation`);
      assert.equal(dispatched.length, 1, "the provenance hook still fires");

      // Step history: the prompt reference is the system prompt as sent, and
      // Cloud, which builds its own on the server, is never reconstructed.
      const { prompt } = dispatched[0];
      assert.equal(prompt.entryId, candidate.saved ? null : "default");
      if (provider.channel === "cloud") {
        assert.equal(prompt.source, "server");
        assert.equal("text" in prompt, false);
      } else {
        assert.equal(prompt.source, "resolved");
        assert.equal(prompt.text, systemPromptOf(tested.request), "exactly what was sent");
      }

      if (provider.channel === "cloud") {
        const opts = active.request.opts;
        assert.equal(opts.promptMode, "cleanup");
        assert.equal(opts.purpose, "cleanup");
        assert.equal(opts.systemPrompt, undefined, "Cloud picks its prompt from customPrompt");
        assert.equal(opts.customPrompt, candidate.saved || undefined);
        assert.deepEqual(opts.customDictionary.slice(0, 2), ["Kubernetes", "Shafranov"]);
        assert.equal(active.request.text, RAW);
      } else {
        const systemPrompt = systemPromptOf(active.request);
        assert.ok(systemPrompt.includes("Kubernetes"), "dictionary suffix applied");
        assert.ok(!systemPrompt.includes(OTHER_SAVED), "the saved prompt is not used");
        if (candidate.saved) {
          assert.ok(
            systemPrompt.startsWith("Tidy this dictation for Jarvis."),
            "assistant name substituted"
          );
        } else {
          assert.ok(!systemPrompt.includes("Tidy this dictation"));
        }
        assert.equal(userContentOf(active.request), ctx.wrapCleanupTranscript(RAW), "wrapped");
      }

      // Only the built-in prompt's output is checked for a repeated transcript.
      if (candidate.saved) {
        assert.equal(active.result.text, DUPLICATE);
      } else {
        assert.equal(active.result.code, "CLEANUP_OUTPUT_INVALID");
      }
    }
  });
}

test("a dictation's prompt reference names the library entry in use", async (t) => {
  const ctx = await setup(t);
  ctx.setReply(CLEAN);
  ctx.useSettingsStore.setState(PROVIDERS.openai.settings);

  const dispatchFor = async () => {
    const dispatched = [];
    const { model, config } = ctx.override.buildDictationCleanupRequest();
    const sent = await ctx.outcome(() =>
      ctx.service.processText(RAW, model, AGENT, {
        ...config,
        onDispatch: (info) => dispatched.push(info),
      })
    );
    assert.equal(dispatched.length, 1);
    return { prompt: dispatched[0].prompt, sent: systemPromptOf(sent.request) };
  };

  ctx.saveInUse(CANDIDATE);
  const saved = await dispatchFor();
  assert.equal(saved.prompt.entryId, ctx.getSettings().promptLibraries.cleanup.activeId);
  assert.notEqual(saved.prompt.entryId, "default");
  assert.equal(saved.prompt.text, saved.sent);
  assert.ok(saved.prompt.text.startsWith("Tidy this dictation for Jarvis."));

  ctx.saveInUse("");
  const builtIn = await dispatchFor();
  assert.equal(builtIn.prompt.entryId, "default");
  assert.equal(builtIn.prompt.text, builtIn.sent);
});

test("cleanup sampling and completeness survive the override", async (t) => {
  const ctx = await setup(t);
  ctx.setReply(CLEAN);

  ctx.useSettingsStore.setState(PROVIDERS.local.settings);
  ctx.saveInUse(OTHER_SAVED);
  const local = await ctx.outcome(() =>
    ctx.override.runCleanupWithPrompt(RAW, { mode: "text", text: CANDIDATE }, { agentName: AGENT })
  );
  assert.equal(local.request.config.temperature, 0, "pinned like a dictation's cleanup");
  assert.equal(local.request.config.requireCompleteOutput, true);
  assert.equal(local.request.config.inferenceScope, "dictationCleanup");
  assert.equal(local.request.config.cleanupPrompt, undefined, "the override never crosses IPC");

  ctx.useSettingsStore.setState(PROVIDERS.groq.settings);
  const groq = await ctx.outcome(() =>
    ctx.override.runCleanupWithPrompt(RAW, { mode: "builtin" }, { agentName: AGENT })
  );
  assert.equal(groq.request.body.temperature, 0);
});

test("inherit uses the prompt in use when the run starts", async (t) => {
  const ctx = await setup(t);
  ctx.setReply(CLEAN);
  ctx.useSettingsStore.setState(PROVIDERS.copilot.settings);
  ctx.saveInUse(CANDIDATE);

  const captured = ctx.override.captureCleanupPrompt({ mode: "inherit" });
  assert.deepEqual(captured, { mode: "text", text: CANDIDATE });
  ctx.saveInUse("");
  assert.deepEqual(ctx.override.captureCleanupPrompt({ mode: "inherit" }), { mode: "builtin" });

  // A run captured earlier keeps its prompt after the saved one changes.
  const { request } = await ctx.outcome(() =>
    ctx.override.runCleanupWithPrompt(RAW, captured, { agentName: AGENT })
  );
  assert.ok(request.config.systemPrompt.startsWith("Tidy this dictation for Jarvis."));
});

test("running a candidate never touches the saved prompts", async (t) => {
  const ctx = await setup(t);
  ctx.setReply(CLEAN);
  ctx.useSettingsStore.setState(PROVIDERS.copilot.settings);
  ctx.saveInUse(OTHER_SAVED);

  const writes = [];
  const setItem = ctx.storage.setItem;
  ctx.storage.setItem = (key, value) => {
    writes.push(key);
    setItem(key, value);
  };
  t.after(() => {
    ctx.storage.setItem = setItem;
  });
  const before = {
    customPrompts: ctx.useSettingsStore.getState().customPrompts,
    promptLibraries: ctx.useSettingsStore.getState().promptLibraries,
    cache: ctx.storage.getItem("customPrompt.cleanup"),
    record: ctx.storage.getItem("promptLibrary.cleanup"),
  };

  for (const candidate of [
    { mode: "builtin" },
    { mode: "text", text: CANDIDATE },
    { mode: "inherit" },
  ]) {
    await ctx.override.runCleanupWithPrompt(RAW, candidate, { agentName: AGENT });
  }

  assert.deepEqual(
    writes.filter((key) => key.startsWith("customPrompt.") || key.startsWith("promptLibrary.")),
    []
  );
  assert.equal(ctx.useSettingsStore.getState().customPrompts, before.customPrompts);
  assert.equal(ctx.useSettingsStore.getState().promptLibraries, before.promptLibraries);
  assert.equal(ctx.storage.getItem("customPrompt.cleanup"), before.cache);
  assert.equal(ctx.storage.getItem("promptLibrary.cleanup"), before.record);
});

test("an explicit system prompt still wins over the cleanup override", async (t) => {
  const ctx = await setup(t);
  ctx.setReply(DUPLICATE);
  ctx.useSettingsStore.setState(PROVIDERS.copilot.settings);

  const { request, result } = await ctx.outcome(() =>
    ctx.service.processText(RAW, "gpt-6-luna", AGENT, {
      provider: "copilot",
      inferenceScope: "dictationTranslation",
      systemPrompt: "Translate to French.",
      cleanupPrompt: { mode: "text", text: CANDIDATE },
    })
  );
  assert.equal(request.config.systemPrompt, "Translate to French.");
  assert.equal(request.text, RAW, "not wrapped: it isn't a cleanup request");
  assert.equal(result.text, DUPLICATE, "and not validated as one");
});
