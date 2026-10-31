const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// "Group dictionary words by category" (Dictionary v2, Stage C): the cleanup
// request's one snapshot (ReasoningConfig.cleanupDictionary, `{ words,
// scope, groups? }`) is built into the grouped suffix inside the request's
// own provider context, on every direct provider; OpenWhispr Cloud only ever
// gets the flat list; nothing of it crosses IPC; a one-step style carries it
// and a restyle doesn't; the prompt test set freezes it; and with grouping
// off every prompt is byte for byte what it was. Synthetic words only.

const AGENT = "Jarvis";
const RAW = "um ask dmitry about the kusto query";
const CLEAN = "Ask Dmitry about the Kusto query.";
const DICTIONARY = ["groq", "Dmitry", "PR", "Kusto", "the", "CED", "worktree"];
const SNIPPETS = [{ trigger: "cal link", replacement: "https://cal.example" }];
// The flat list a cleanup prompt carries today: the words, then the trigger.
const FLAT = [...DICTIONARY, "cal link"];
// Kusto is a stored choice (work, the model's); the rest are the rules'.
const GROUPED_TAIL =
  "People: Dmitry; Work terms: PR, Kusto, CED; Everyday words: the; Other: groq, worktree, cal link";

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
  const ipc = (channel) => async (text, model, agentName, config) => {
    requests.push({ channel, text, model, agentName, config });
    return { success: true, text: CLEAN };
  };
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1" },
    window: {
      electronAPI: {
        processCopilotReasoning: ipc("copilot"),
        processLocalReasoning: ipc("local"),
        processAnthropicReasoning: ipc("anthropic"),
        cloudReason: async (text, opts) => {
          requests.push({ channel: "cloud", text, opts });
          return { success: true, text: CLEAN, model: "cloud-model", provider: "openwhispr" };
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
        output: [{ type: "message", content: [{ type: "output_text", text: CLEAN }] }],
        choices: [{ message: { content: CLEAN }, finish_reason: "stop" }],
        candidates: [{ content: { parts: [{ text: CLEAN }] }, finishReason: "STOP" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cleanup-grouping-",
    mockModules: {
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  await vite.ssrLoadModule("/i18n.ts");
  const settingsModule = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  const { useDictionaryCategoriesStore } = await vite.ssrLoadModule(
    "/stores/dictionaryCategoriesStore.ts"
  );
  const { useDictionarySourcesStore } = await vite.ssrLoadModule(
    "/stores/dictionarySourcesStore.ts"
  );
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const cleanupWithPrompt = await vite.ssrLoadModule("/services/cleanupWithPrompt.ts");
  const styles = await vite.ssrLoadModule("/services/dictationStyles.ts");
  const audio = await vite.ssrLoadModule("/helpers/audioManager.js");
  const prompts = await vite.ssrLoadModule("/config/prompts.ts");
  const { getLanguageInstruction } = await vite.ssrLoadModule("/utils/languageSupport.ts");
  const { resolveCleanupLanguage } = await vite.ssrLoadModule("/utils/chineseScript.js");
  const { en } = await vite.ssrLoadModule("/locales/prompts.ts");

  const { useSettingsStore, getSettings, getEffectiveCleanupModel } = settingsModule;
  useSettingsStore.setState({
    useCleanupModel: true,
    useDictationAgent: false,
    customDictionary: [...DICTIONARY],
    snippets: SNIPPETS,
    preferredLanguage: "en",
    uiLanguage: "en",
    cleanupDictionaryWords: "all",
    cleanupDictionaryGrouping: false,
  });
  useDictionarySourcesStore.setState({ learned: new Set(), loaded: true, pinned: new Set() });
  useDictionaryCategoriesStore.setState({
    stored: new Map([["kusto", { category: "work", source: "model" }]]),
    storedLoaded: true,
    commonWords: new Set(["the", "little", "ideas"]),
    ready: true,
  });

  // A dictation's cleanup, through the route the batch path takes.
  const manager = Object.create(audio.default.prototype);
  const dictate = async () => {
    const route = audio.resolveReasoningRoute(RAW, getSettings(), AGENT, false, false);
    assert.equal(route.kind, "cleanup");
    return manager.processWithReasoningModel(RAW, getEffectiveCleanupModel(), AGENT, {
      ...route.config,
    });
  };
  const last = () => requests[requests.length - 1];
  const sent = async (run) => {
    const before = requests.length;
    try {
      await run();
    } catch (error) {
      // A reply the path rejects (Cloud's style marker) still sent its request.
      if (error.code === "ERR_ASSERTION") throw error;
    }
    assert.equal(requests.length, before + 1, "one request");
    return last();
  };

  // Today's prompt, built the way it was before grouping existed: the
  // built-in prompt with the assistant's name, the language line, then the
  // dictionary sentence and the words joined by ", ".
  const todaysPrompt = (words) => {
    let prompt = prompts.getDefaultPromptText("cleanup", "en").replace(/\{\{agentName\}\}/g, AGENT);
    const instruction = getLanguageInstruction(resolveCleanupLanguage("en"));
    if (instruction) prompt += "\n\n" + instruction;
    return prompt + en.dictionarySuffix + words.join(", ");
  };

  return {
    requests,
    service,
    cleanupWithPrompt,
    styles,
    useSettingsStore,
    useDictionaryCategoriesStore,
    getSettings,
    dictate,
    sent,
    todaysPrompt,
    wrap: prompts.wrapCleanupTranscript,
  };
}

function systemPromptOf(request) {
  if (request.channel === "fetch") {
    const body = request.body;
    if (body.systemInstruction) return body.systemInstruction.parts[0].text;
    const messages = body.messages ?? body.input;
    return messages.find((message) => message.role === "system").content;
  }
  return request.config.systemPrompt;
}

// Nothing of the snapshot crosses IPC or reaches a provider's request.
function assertNoSnapshot(request) {
  const payload = JSON.stringify(request.config ?? request.opts ?? request.body);
  for (const key of ["cleanupDictionary", "promptInputs", '"groups"', "dictionaryGroup"]) {
    assert.equal(payload.includes(key), false, `${key} never leaves processText`);
  }
}

for (const [name, provider] of Object.entries(PROVIDERS)) {
  test(`${name}: grouping off is today's prompt byte for byte; on, the grouped list (Cloud: flat)`, async (t) => {
    const ctx = await setup(t);
    ctx.useSettingsStore.setState(provider.settings);

    // Off: the dictation's request, and a request carrying today's snapshot
    // shape (no groups), are both today's prompt.
    const off = await ctx.sent(() => ctx.dictate());
    const oldShape = await ctx.sent(() =>
      ctx.service.processText(RAW, ctx.getSettings().cleanupModel, AGENT, {
        ...ctx.cleanupWithPrompt.buildDictationCleanupRequest().config,
        cleanupDictionary: {
          words: [...FLAT],
          scope: { setting: "all", applied: "all", words: DICTIONARY.length },
        },
      })
    );
    if (provider.channel === "cloud") {
      assert.deepEqual(off.opts.customDictionary, FLAT);
      assert.deepEqual(oldShape.opts, off.opts);
    } else {
      assert.equal(systemPromptOf(off), ctx.todaysPrompt(FLAT), "byte for byte");
      assert.equal(systemPromptOf(oldShape), systemPromptOf(off));
    }
    assertNoSnapshot(off);

    // On: the same sentence, then the words by category; Cloud the flat list.
    ctx.useSettingsStore.setState({ cleanupDictionaryGrouping: true });
    const on = await ctx.sent(() => ctx.dictate());
    if (provider.channel === "cloud") {
      assert.deepEqual(on.opts.customDictionary, FLAT, "Cloud never gets the grouping");
      assert.deepEqual(on.opts, off.opts);
    } else {
      const expected = ctx.todaysPrompt([]) + GROUPED_TAIL;
      assert.equal(systemPromptOf(on), expected);
      assert.ok(systemPromptOf(on).startsWith(ctx.todaysPrompt([])), "the sentence is unchanged");
    }
    assertNoSnapshot(on);
  });
}

test("the grouped labels follow the UI language (prompts namespace)", async (t) => {
  const ctx = await setup(t);
  ctx.useSettingsStore.setState({
    ...PROVIDERS.local.settings,
    cleanupDictionaryGrouping: true,
    uiLanguage: "de",
  });
  const request = await ctx.sent(() => ctx.dictate());
  assert.match(
    systemPromptOf(request),
    /Personen: Dmitry; Arbeitsbegriffe: PR, Kusto, CED; Alltagswörter: the; Sonstige: groq, worktree, cal link$/
  );
});

test("categories not ready: the list stays flat even with grouping on", async (t) => {
  const ctx = await setup(t);
  ctx.useSettingsStore.setState({ ...PROVIDERS.copilot.settings, cleanupDictionaryGrouping: true });
  ctx.useDictionaryCategoriesStore.setState({ commonWords: null, ready: false });
  const request = await ctx.sent(() => ctx.dictate());
  assert.equal(systemPromptOf(request), ctx.todaysPrompt(FLAT));
});

test("styles: one step carries the grouped list; a two-step restyle has its own prompt", async (t) => {
  const ctx = await setup(t);
  ctx.useSettingsStore.setState({ ...PROVIDERS.copilot.settings, cleanupDictionaryGrouping: true });
  const style = { id: "s1", name: "Teams", instruction: "Write it as a short chat message." };

  const oneStep = await ctx.sent(() =>
    ctx.styles.runOneStepStyle(RAW, style, { agentName: AGENT })
  );
  const prompt = systemPromptOf(oneStep);
  assert.ok(prompt.startsWith(ctx.todaysPrompt([]) + GROUPED_TAIL), "cleanup's grouped prompt");
  assert.match(prompt, /short chat message/, "then the style block");
  assertNoSnapshot(oneStep);

  const restyle = await ctx.sent(() => ctx.styles.runRestyle(CLEAN, style, { agentName: AGENT }));
  assert.equal(systemPromptOf(restyle).includes("Custom Dictionary"), false, "no dictionary");
  assertNoSnapshot(restyle);

  // OpenWhispr Cloud's one step: the flat list.
  ctx.useSettingsStore.setState(PROVIDERS["OpenWhispr Cloud"].settings);
  const cloud = await ctx.sent(() => ctx.styles.runOneStepStyle(RAW, style, { agentName: AGENT }));
  assert.deepEqual(cloud.opts.customDictionary, FLAT);
  assertNoSnapshot(cloud);
});

test("the prompt test set freezes the grouping with its inputs; Cloud gets the frozen flat list", async (t) => {
  const ctx = await setup(t);
  ctx.useSettingsStore.setState({ ...PROVIDERS.copilot.settings, cleanupDictionaryGrouping: true });
  const inputs = ctx.cleanupWithPrompt.captureCleanupPromptInputs(ctx.getSettings());
  assert.deepEqual(inputs.customDictionary, FLAT);
  assert.deepEqual(
    inputs.groups.map((entry) => entry.group),
    ["people", "work", "everyday", "other"]
  );
  const request = ctx.cleanupWithPrompt.pinDictationCleanupRequest(ctx.getSettings());

  // A category and the setting change mid-run: later requests send the frozen prompt.
  ctx.useDictionaryCategoriesStore.setState({
    stored: new Map([["groq", { category: "work", source: "user" }]]),
  });
  ctx.useSettingsStore.setState({ cleanupDictionaryGrouping: false });
  const frozen = await ctx.sent(() =>
    ctx.service.processText(RAW, request.model, AGENT, {
      ...request.config,
      promptInputs: inputs,
      cleanupPrompt: { mode: "builtin" },
      redactLogs: true,
    })
  );
  assert.equal(systemPromptOf(frozen), ctx.todaysPrompt([]) + GROUPED_TAIL);
  assertNoSnapshot(frozen);

  ctx.useSettingsStore.setState(PROVIDERS["OpenWhispr Cloud"].settings);
  const cloudRequest = ctx.cleanupWithPrompt.pinDictationCleanupRequest(ctx.getSettings());
  const cloud = await ctx.sent(() =>
    ctx.service.processText(RAW, cloudRequest.model, AGENT, {
      ...cloudRequest.config,
      promptInputs: inputs,
    })
  );
  assert.deepEqual(cloud.opts.customDictionary, FLAT);
  assertNoSnapshot(cloud);

  // Grouping off at capture: no groups, and today's prompt.
  const flatInputs = ctx.cleanupWithPrompt.captureCleanupPromptInputs(ctx.getSettings());
  assert.equal("groups" in flatInputs, false);
});

test("Prompt Studio's cleanup Test sends the grouped prompt a dictation would", async (t) => {
  const ctx = await setup(t);
  ctx.useSettingsStore.setState({ ...PROVIDERS.local.settings, cleanupDictionaryGrouping: true });
  const dictation = await ctx.sent(() => ctx.dictate());
  const tested = await ctx.sent(() =>
    ctx.cleanupWithPrompt.runCleanupWithPrompt(RAW, { mode: "builtin" }, { agentName: AGENT })
  );
  assert.equal(systemPromptOf(tested), systemPromptOf(dictation));
  assert.equal(systemPromptOf(tested), ctx.todaysPrompt([]) + GROUPED_TAIL);
  assertNoSnapshot(tested);
});

test("a system-prompt request (translation, the assistant) ignores the snapshot and keeps the full list", async (t) => {
  const ctx = await setup(t);
  ctx.useSettingsStore.setState({
    ...PROVIDERS.copilot.settings,
    cleanupDictionaryGrouping: true,
    cleanupDictionaryWords: "noEveryday",
  });
  const config = ctx.cleanupWithPrompt.buildDictationCleanupRequest().config;
  assert.ok(config.cleanupDictionary.groups, "the snapshot has groups");
  const translation = await ctx.sent(() =>
    ctx.service.processText(RAW, "gpt-6-luna", AGENT, {
      ...config,
      inferenceScope: "dictationTranslation",
      systemPrompt: "Translate to French.",
    })
  );
  assert.equal(translation.config.systemPrompt, "Translate to French.");
  assertNoSnapshot(translation);
});
