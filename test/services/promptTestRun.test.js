const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A test-set run end to end in the renderer: the store captures prompt A (in
// use) and B, pins the provider and freezes the prompt's dictionary and the
// glossary when it starts, then sends real cleanup requests (the providers'
// own code, with fetch and IPC mocked) one at a time. It never writes a
// setting, keeps its text out of the request logs, gives the local model up
// to a dictation, and an account change cancels it and clears its results.
// Synthetic text only; no request leaves the process.

const AGENT = "Jarvis";
const IN_USE = "In-use prompt for {{agentName}}. Keep every word that matters.";
const CANDIDATE = "Candidate prompt for {{agentName}}. Remove fillers only.";
const OTHER = "A prompt switched to mid-run that must not be used.";
const SECRET_WORD = "quarterly";

const LITTLE_BUDDY = {
  id: "rule-little-buddy",
  canonical: "Little Buddy",
  enabled: true,
  revision: 1,
  apps: ["Code.exe"],
  spellings: [{ text: "everybody", scope: "start" }],
};

const GROQ = {
  useCleanupModel: true,
  cleanupMode: "providers",
  cleanupProvider: "groq",
  cleanupModel: "openai/gpt-oss-20b",
};
const LOCAL = {
  useCleanupModel: true,
  cleanupMode: "local",
  cleanupProvider: "qwen",
  cleanupModel: "qwen3.5-4b-q4_k_m",
};

function runCase(id, rawText, extra = {}) {
  return {
    id,
    label: id,
    rawText,
    targetApp: null,
    referenceText: null,
    source: "test",
    sourceTranscriptionId: null,
    mustContain: [],
    mustNotContain: [],
    matchCase: false,
    ...extra,
  };
}

const CASES = [
  runCase("app", "hello everybody can you check the build", { targetApp: "Code.exe" }),
  runCase("secret", `um send the ${SECRET_WORD} numbers to Maria by friday`),
];

async function setup(t, settings) {
  const fetches = [];
  const localCalls = [];
  const logs = [];
  const lifecycleListeners = [];
  const caseListeners = [];
  const state = {
    list: { success: true, owner: "account:a", durable: true, reason: null, cases: [] },
    fetchReply: (n) => `Cleaned reply ${n} for ${SECRET_WORD} review.`,
    onFetch: null,
    local: async () => ({ success: true, text: "Locally cleaned." }),
  };

  const { storage } = installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1" },
    window: {
      electronAPI: {
        getLogLevel: async () => "debug",
        log: async (entry) => {
          logs.push(entry);
        },
        listTestCases: async () => state.list,
        onTestCasesChanged: (callback) => {
          caseListeners.push(callback);
          return () => {};
        },
        getGlossaryRules: async () => ({ revision: 3, rules: [LITTLE_BUDDY] }),
        onGlossaryRulesUpdated: () => () => {},
        getDictationLifecycle: async () => ({ state: "idle", inputKind: "dictation" }),
        onDictationLifecycleChanged: (callback) => {
          lifecycleListeners.push(callback);
          return () => {};
        },
        processLocalReasoning: async (text, model, agentName, config) => {
          localCalls.push({ text, model, agentName, config });
          return state.local(localCalls.length);
        },
        cancelLocalReasoning: async () => {},
        getGroqKey: async () => "synthetic-groq-key",
        getOpenAIKey: async () => "synthetic-openai-key",
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
    fetches.push({ url: String(url), body: JSON.parse(init.body) });
    if (state.onFetch) await state.onFetch(fetches.length);
    const reply = state.fetchReply(fetches.length);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-prompt-test-run-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { useSettingsStore, getSettings } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const store = await vite.ssrLoadModule("/stores/promptTestSetStore.ts");
  const cleanup = await vite.ssrLoadModule("/services/cleanupWithPrompt.ts");
  const runner = await vite.ssrLoadModule("/services/promptTestRunner.ts");
  const chat = await vite.ssrLoadModule("/services/ai/chatRequestBody.ts");
  const { wrapCleanupTranscript } = await vite.ssrLoadModule("/config/prompts.ts");

  useSettingsStore.setState({
    ...settings,
    useDictationAgent: false,
    customDictionary: ["Kubernetes"],
    preferredLanguage: "en",
    uiLanguage: "en",
  });
  const settingsApi = useSettingsStore.getState();
  const inUseId = settingsApi.createPrompt("cleanup", { name: "In use", text: IN_USE });
  useSettingsStore.getState().activatePrompt("cleanup", inUseId);

  // Writes to saved prompts or settings from here on.
  const writes = [];
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    writes.push(key);
    setItem(key, value);
  };
  t.after(() => {
    storage.setItem = setItem;
  });

  const start = () =>
    store.startTestRun({
      cases: CASES,
      promptB: { mode: "text", text: CANDIDATE },
      names: { a: "In use", b: "Candidate" },
      agentName: AGENT,
      destination: { provider: "test", model: "test" },
    });

  return {
    state,
    fetches,
    localCalls,
    logs,
    writes,
    lifecycleListeners,
    caseListeners,
    store,
    cleanup,
    runner,
    chat,
    useSettingsStore,
    getSettings,
    wrapCleanupTranscript,
    start,
  };
}

const systemOf = (fetch) => fetch.body.messages.find((m) => m.role === "system").content;
const userOf = (fetch) => fetch.body.messages.find((m) => m.role === "user").content;

test("a run sends A and B as real cleanup requests, fixed when it starts", async (t) => {
  const ctx = await setup(t, GROQ);
  ctx.store.setRepetitions(1);
  // Mid-run, the provider, model, dictionary and prompt in use all change.
  ctx.state.onFetch = (n) => {
    if (n !== 1) return;
    ctx.useSettingsStore.setState({
      cleanupProvider: "openai",
      cleanupModel: "gpt-4.1-mini",
      customDictionary: ["Changed"],
    });
    const otherId = ctx.useSettingsStore
      .getState()
      .createPrompt("cleanup", { name: "Other", text: OTHER });
    ctx.useSettingsStore.getState().activatePrompt("cleanup", otherId);
  };

  assert.deepEqual(await ctx.start(), { started: true });
  const run = ctx.store.usePromptTestSetStore.getState().run;
  assert.equal(run.progress.phase, "finished");
  assert.equal(run.progress.stopReason, null);
  assert.equal(ctx.fetches.length, 4);

  for (const [index, fetch] of ctx.fetches.entries()) {
    assert.ok(fetch.url.includes("api.groq.com"), "the provider pinned at the start");
    assert.equal(fetch.body.model, "openai/gpt-oss-20b");
    assert.equal(fetch.body.temperature, 0, "cleanup sampling");
    const system = systemOf(fetch);
    const side = index % 2 === 0 ? "A" : "B";
    assert.ok(
      system.startsWith(
        side === "A" ? "In-use prompt for Jarvis." : "Candidate prompt for Jarvis."
      ),
      `${side}: its own prompt, substituted`
    );
    assert.ok(system.includes("Kubernetes"), "the dictionary frozen at the start");
    assert.ok(!system.includes("Changed"));
    assert.ok(!system.includes(OTHER));
  }
  assert.equal(
    userOf(ctx.fetches[0]),
    ctx.wrapCleanupTranscript("hello Little Buddy can you check the build"),
    "the glossary-corrected input in the transcript wrapper"
  );
  assert.equal(
    userOf(ctx.fetches[2]),
    ctx.wrapCleanupTranscript(`um send the ${SECRET_WORD} numbers to Maria by friday`)
  );

  const [app] = run.progress.results;
  assert.equal(app.input.raw, "hello everybody can you check the build");
  assert.equal(app.input.corrected, "hello Little Buddy can you check the build");
  assert.deepEqual(
    app.runs.A.map((r) => r.status),
    ["completed"]
  );
});

test("a run writes no setting and keeps its text out of the request log", async (t) => {
  const ctx = await setup(t, GROQ);
  ctx.store.setRepetitions(2);
  const before = {
    customPrompts: ctx.useSettingsStore.getState().customPrompts,
    promptLibraries: ctx.useSettingsStore.getState().promptLibraries,
  };

  await ctx.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.fetches.length, 8);
  assert.deepEqual(
    ctx.writes.filter((key) => !key.startsWith("promptTestSet.")),
    [],
    "nothing saved changes"
  );
  assert.equal(ctx.useSettingsStore.getState().customPrompts, before.customPrompts);
  assert.equal(ctx.useSettingsStore.getState().promptLibraries, before.promptLibraries);

  const reasoning = ctx.logs.filter((entry) => entry.scope === "reasoning");
  assert.ok(
    reasoning.some((entry) => entry.message === "GROQ_REQUEST"),
    "requests are logged"
  );
  const logged = JSON.stringify(ctx.logs);
  assert.equal(logged.includes(SECRET_WORD), false, "no input or reply text in the log");
  assert.equal(logged.includes("Little Buddy can you"), false);
  assert.ok(
    reasoning
      .filter((entry) => entry.message === "GROQ_REQUEST")
      .every((entry) => entry.meta.textRedacted === true && !("requestBody" in entry.meta))
  );

  // Control: the same request without the tag logs the input's size (not the
  // body), with no text since "Include dictated text" is off.
  ctx.logs.length = 0;
  await ctx.cleanup.runCleanupWithPrompt("short", { mode: "builtin" }, { agentName: AGENT });
  await new Promise((resolve) => setImmediate(resolve));
  const request = ctx.logs.find((entry) => entry.message === "GROQ_REQUEST");
  assert.ok(request && !("requestBody" in request.meta));
  assert.deepEqual(request.meta.input, { chars: 5, words: 1 });
});

test("an account change cancels the run and clears its results", async (t) => {
  const ctx = await setup(t, GROQ);
  ctx.store.setRepetitions(1);
  let release;
  ctx.state.onFetch = (n) =>
    n === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;

  ctx.store.followTestCases();
  await new Promise((resolve) => setImmediate(resolve));
  const running = ctx.start();
  for (let i = 0; i < 100 && ctx.fetches.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(ctx.fetches.length, 1);
  assert.ok(ctx.store.usePromptTestSetStore.getState().run, "results show while it runs");

  // Main tells every window the owner changed.
  ctx.state.list = { ...ctx.state.list, owner: "account:b" };
  for (const listener of ctx.caseListeners) listener({ owner: "account:b", reason: "owner" });
  assert.equal(ctx.store.usePromptTestSetStore.getState().run, null, "results cleared at once");

  release();
  await running;
  assert.equal(ctx.fetches.length, 1, "no request after the change");
  assert.equal(ctx.store.usePromptTestSetStore.getState().run, null);
  assert.equal(ctx.store.isTestRunActive(), false);
});

test("on the local model a test request gives way to a dictation and is sent again after it", async (t) => {
  const ctx = await setup(t, LOCAL);
  ctx.store.setRepetitions(1);
  const phases = new Set();
  const unsubscribe = ctx.store.usePromptTestSetStore.subscribe((s) => {
    if (s.run) phases.add(s.run.progress.phase);
  });
  t.after(unsubscribe);
  ctx.state.local = async (n) => {
    if (n !== 2) return { success: true, text: "Locally cleaned." };
    // Main aborted it because a recording started; the dictation then ends.
    for (const listener of ctx.lifecycleListeners) {
      listener({ state: "recording", inputKind: "dictation" });
    }
    setTimeout(() => {
      for (const listener of ctx.lifecycleListeners) {
        listener({ state: "idle", inputKind: "dictation" });
      }
    }, 20);
    return { success: false, error: "Gave way to a dictation", code: "YIELDED_TO_DICTATION" };
  };

  await ctx.start();
  const run = ctx.store.usePromptTestSetStore.getState().run;

  assert.equal(run.progress.stopReason, null);
  assert.equal(ctx.localCalls.length, 5, "four requests, one of them sent twice");
  assert.ok(phases.has("pausedForDictation"));
  assert.deepEqual(
    run.progress.results.flatMap((r) => [...r.runs.A, ...r.runs.B].map((o) => o.status)),
    ["completed", "completed", "completed", "completed"]
  );
  const ids = new Set();
  for (const call of ctx.localCalls) {
    assert.equal(call.config.yieldToDictation, true);
    assert.equal(call.config.redactLogs, true);
    assert.match(call.config.requestId, /^prompt-test-/);
    ids.add(call.config.requestId);
    assert.equal(call.config.cleanupPrompt, undefined, "resolved, never sent over IPC");
    assert.equal(call.config.promptInputs, undefined);
    assert.equal(call.config.temperature, 0);
    assert.equal(call.config.requireCompleteOutput, true);
  }
  assert.equal(ids.size, 5, "the resent request has a new id");
  assert.equal(ctx.localCalls[2].text, ctx.localCalls[1].text, "the same request again");
  assert.deepEqual(
    ctx.writes.filter((key) => !key.startsWith("promptTestSet.")),
    []
  );
});

test("the runner reads the same empty and cut-off reply keys every provider sets", async (t) => {
  const ctx = await setup(t, GROQ);
  assert.equal(ctx.runner.EMPTY_REPLY_MESSAGE_KEY, ctx.chat.EMPTY_OUTPUT_MESSAGE_KEY);
  assert.equal(ctx.runner.TRUNCATED_REPLY_MESSAGE_KEY, ctx.chat.TRUNCATED_OUTPUT_MESSAGE_KEY);
});
