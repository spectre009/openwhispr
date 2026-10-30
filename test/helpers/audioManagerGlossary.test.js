const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// The post-speech-to-text boundary wired into AudioManager: every dictation
// path applies the glossary exactly once, routes on the raw transcript, and
// sends the corrected one to models. Synthetic fixtures only.

const RULE = Object.freeze({
  id: "rule-little-buddy",
  canonical: "Little Buddy",
  enabled: true,
  revision: 1,
  apps: ["github.exe", "Code.exe", "WindowsTerminal.exe", "Obsidian.exe"],
  spellings: [
    { text: "littlebuddy", scope: "anywhere" },
    { text: "everybody", scope: "start" },
    { text: "every body", scope: "start" },
    { text: "buddy", scope: "start" },
    { text: "buddies", scope: "start" },
    { text: "little buddies", scope: "start" },
  ],
});
const RAW = "Hello, everybody. I need you to take a look at the build.";
const CORRECTED = "Hello, Little Buddy. I need you to take a look at the build.";

const unreachable = (name) => `
  export const ${name} = () => ({ reachable: false, model: "", displayProvider: "none", config: {} });
`;

const glossaryMocks = {
  "/stores/glossaryStore": `
    export const getGlossarySnapshot = () =>
      globalThis.__amGlossary ?? { revision: 0, rules: [] };
  `,
  "/stores/dictionarySourcesStore": `
    export const getLearnedDictionaryWords = () => new Set(globalThis.__amLearned ?? []);
    export const getPinnedDictionaryKeys = () => new Set(globalThis.__amPinned ?? []);
    export const isDictionarySourcesLoaded = () => true;
  `,
  "/glossaryTerms": `
    export const getGlossaryCanonicalTerms = () => globalThis.__amGlossaryTerms ?? [];
    export const setGlossaryCanonicalTerms = () => {};
  `,
  "/config/prompts": `
    export const resolvePrompt = () => "prompt";
    export const appendScreenContextSuffix = (prompt) => prompt;
    export const wrapCleanupTranscript = (text) => text;
    export const getCleanupSystemPrompt = () => "cleanup prompt";
  `,
};

function settingsStoreMock(key, { cleanupModel = null } = {}) {
  return `
    export const getSettings = () => globalThis.${key};
    export const getEffectiveCleanupModel = () => ${JSON.stringify(cleanupModel)};
    export const selectResolvedLLMConfig = () => ({
      mode: "providers", provider: "openai", model: ${JSON.stringify(cleanupModel)}
    });
    export const isCloudCleanupMode = () => false;
    export const isCloudDictationAgentMode = () => false;
    export const isCloudTranslationMode = () => false;
    export const useSettingsStore = { subscribe: () => () => {} };
  `;
}

function withGlossary(t, { rules = [RULE], terms = ["Little Buddy"], learned = [] } = {}) {
  globalThis.__amGlossary = { revision: 4, rules };
  globalThis.__amGlossaryTerms = terms;
  globalThis.__amLearned = learned;
  t.after(() => {
    delete globalThis.__amGlossary;
    delete globalThis.__amGlossaryTerms;
    delete globalThis.__amLearned;
  });
}

async function load(t, name, { settings = {}, mockModules = {}, cleanupModel = null } = {}) {
  const settingsKey = `__amGlossarySettings_${name.replace(/\W/g, "_")}`;
  return loadAudioManager(t, {
    cachePrefix: `openwhispr-am-glossary-${name}-`,
    settingsKey,
    settings: { preferredLanguage: "en", useCleanupModel: !!cleanupModel, ...settings },
    mockModules: {
      ...glossaryMocks,
      "/stores/settingsStore": settingsStoreMock(settingsKey, { cleanupModel }),
      "/dictationAgentInference": `
        ${unreachable("resolveDictationAgentInference")}
        export const resolveDictationAgentVisionInference = () => ({ active: false, model: "", config: {} });
      `,
      "/dictationTranslationInference": unreachable("resolveDictationTranslationInference"),
      ...mockModules,
    },
  });
}

const baseManager = (overrides = {}) => ({
  voiceAgentRequested: false,
  translationRequested: false,
  translationApplied: false,
  pendingCleanupFailure: null,
  pendingAssistantConversation: null,
  pendingSelectionEdit: null,
  recordingTargetPromise: Promise.resolve({ exeName: "Code.exe" }),
  ...overrides,
});

const stepKinds = (trace) => trace.steps.map((step) => `${step.kind}:${step.outcome}`);

test("no model reachable: the early return still applies the glossary, once", async (t) => {
  withGlossary(t);
  const { createManager } = await load(t, "no-model");
  const manager = createManager(baseManager());

  const post = await manager.processTranscription(RAW, "local", undefined, {
    provider: "local-whisper",
    model: "base",
    ms: 120,
  });

  assert.equal(post.text, CORRECTED);
  assert.equal(post.trace.route, "none");
  assert.equal(post.trace.glossary.revision, 4);
  assert.equal(post.trace.glossary.rulesFired.length, 1);
  assert.equal(post.trace.context.targetApp, "Code.exe");
  assert.deepEqual(stepKinds(post.trace), ["stt:ok", "glossary:ok", "finalize:ok"]);
  assert.deepEqual(post.trace.steps[0], {
    kind: "stt",
    outcome: "ok",
    output: RAW,
    provider: "local-whisper",
    model: "base",
    ms: 120,
  });
});

test("the target app decides: Teams and an unknown app keep the opening", async (t) => {
  withGlossary(t);
  const { createManager } = await load(t, "target-apps");
  const teams = createManager(
    baseManager({ recordingTargetPromise: Promise.resolve({ exeName: "ms-teams.exe" }) })
  );
  const teamsInput = "Hello everybody, quick reminder that the all hands moved.";
  assert.equal((await teams.processTranscription(teamsInput, "local")).text, teamsInput);

  const unknown = createManager(baseManager({ recordingTargetPromise: null }));
  const unknownInput = "Hello, everybody. I need you to look at this.";
  const post = await unknown.processTranscription(unknownInput, "local");
  assert.equal(post.text, unknownInput);
  assert.equal(post.trace.context.targetApp, null);
  // "Anywhere" spellings still apply without a target app.
  assert.equal(
    (await unknown.processTranscription("So littlebuddy, check this.", "local")).text,
    "So Little Buddy, check this."
  );
});

test("a lost target-app reply never holds the dictation", async (t) => {
  withGlossary(t);
  const { createManager } = await load(t, "target-timeout");
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) =>
    originalSetTimeout(fn, Math.min(ms, 5), ...args)
  );
  const manager = createManager(baseManager({ recordingTargetPromise: new Promise(() => {}) }));
  const post = await manager.processTranscription(RAW, "local");
  assert.equal(post.text, RAW, "an unknown app gets no start-of-dictation corrections");
});

test("cleanup gets the corrected text, and a failed cleanup keeps it", async (t) => {
  withGlossary(t);
  const { createManager } = await load(t, "cleanup", { cleanupModel: "cleanup-model" });
  const inputs = [];
  const ok = createManager(
    baseManager({
      isReasoningAvailable: async () => true,
      processWithReasoningModel: async (text, model, _agent, config) => {
        inputs.push(text);
        config.onDispatch?.({ provider: "copilot", model: "claude-haiku-5.5" });
        return `${text} [clean]`;
      },
    })
  );
  const cleaned = await ok.processTranscription(RAW, "openai");
  assert.deepEqual(inputs, [CORRECTED]);
  assert.equal(cleaned.text, `${CORRECTED} [clean]`);
  assert.equal(cleaned.trace.route, "cleanup");
  const step = cleaned.trace.steps.find((s) => s.kind === "cleanup");
  assert.deepEqual(
    { outcome: step.outcome, provider: step.provider, model: step.model, output: step.output },
    {
      outcome: "ok",
      provider: "copilot",
      model: "claude-haiku-5.5",
      output: `${CORRECTED} [clean]`,
    }
  );

  const failing = createManager(
    baseManager({
      isReasoningAvailable: async () => true,
      processWithReasoningModel: async () => {
        throw Object.assign(new Error("rate limited"), { code: "PROVIDER_RATE_LIMITED" });
      },
    })
  );
  const fallback = await failing.processTranscription(RAW, "openai");
  assert.equal(fallback.text, CORRECTED, "the corrected text is the floor");
  assert.ok(failing.pendingCleanupFailure, "the cleanup-failed toast still fires");
  assert.deepEqual(stepKinds(fallback.trace), [
    "stt:ok",
    "glossary:ok",
    "cleanup:failed",
    "finalize:ok",
  ]);
});

test("routing reads the raw transcript: a correction never invokes the agent", async (t) => {
  withGlossary(t);
  const { createManager, window } = await load(t, "routing", {
    settings: { useDictationAgent: true },
    mockModules: {
      "/dictationAgentInference": `
        export const resolveDictationAgentInference = () => ({
          reachable: true, model: "agent-model", displayProvider: "openai",
          config: { provider: "openai" }
        });
        export const resolveDictationAgentVisionInference = () => ({ active: false, model: "", config: {} });
      `,
    },
  });
  window.localStorage.setItem("agentName", "Little Buddy");
  const agentInputs = [];
  const manager = createManager(
    baseManager({
      isReasoningAvailable: async () => true,
      processAgentCommand: async (text) => {
        agentInputs.push(text);
        return "agent reply";
      },
    })
  );

  const post = await manager.processTranscription(RAW, "openai");
  assert.equal(post.text, CORRECTED);
  assert.deepEqual(agentInputs, [], "the glossary's 'Little Buddy' must not wake the agent");
  assert.equal(post.trace.context.intents.wakeWord, false);
  assert.notEqual(post.trace.route, "agent");

  // Said out loud, the name still routes to the agent, with the text as said.
  const said = await manager.processTranscription("Little Buddy, summarize the build.", "openai");
  assert.equal(said.trace.context.intents.wakeWord, true);
  assert.equal(said.trace.route, "agent");
  assert.deepEqual(agentInputs, ["Little Buddy, summarize the build."]);
  assert.equal(said.text, "agent reply");
});

test("a translation recording corrects its source side before cleanup", async (t) => {
  withGlossary(t);
  const { createManager } = await load(t, "translation", {
    cleanupModel: "cleanup-model",
    settings: {
      useDictationTranslation: true,
      translationSourceLanguage: "en",
      translationTargetLanguage: "es",
    },
    mockModules: {
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: true, model: "translate-model", displayProvider: "openai",
          config: { provider: "openai" }
        });
      `,
    },
  });
  const calls = [];
  const manager = createManager(
    baseManager({
      translationRequested: true,
      isReasoningAvailable: async () => true,
      notifyTranslationFallback: () => {},
      processWithReasoningModel: async (text, model) => {
        calls.push([model, text]);
        return model === "cleanup-model" ? `${text} [clean]` : "Hola, Little Buddy. [es]";
      },
    })
  );

  const post = await manager.processTranscription(RAW, "openai");
  assert.deepEqual(calls, [
    ["cleanup-model", CORRECTED],
    ["translate-model", `${CORRECTED} [clean]`],
  ]);
  assert.equal(post.text, "Hola, Little Buddy. [es]");
  assert.equal(post.trace.route, "translation");
  assert.equal(post.trace.context.intents.translation, true);
  assert.deepEqual(stepKinds(post.trace), [
    "stt:ok",
    "glossary:ok",
    "cleanup:ok",
    "translation:ok",
    "finalize:ok",
  ]);
});

function streamingManager(AudioManager, overrides = {}) {
  return Object.assign(Object.create(AudioManager.prototype), {
    ...baseManager(),
    isRecording: true,
    isProcessing: false,
    isStreaming: true,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    recordingStartTime: Date.now() - 5000,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _streamingSessionGeneration: 7,
    _activeStreamingSessionId: 7,
    _streamingMicSwapPromise: null,
    streamingFinalText: "",
    streamingPartialText: "",
    streamingCleanupFns: [],
    streamingProcessor: null,
    streamingSource: null,
    streamingAnalyser: null,
    streamingAudioContext: null,
    streamingStream: null,
    streamingFallbackRecorder: null,
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => null,
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      finalize() {},
      stop: async () => ({ success: true }),
    }),
    getStreamingProviderName: () => "deepgram",
    shouldUseStreaming: () => false,
    isRecordingAllowedByPolicy: () => true,
    onStateChange() {},
    ...overrides,
  });
}

function countBoundaryCalls(manager) {
  const original = manager.postTranscribe;
  const counter = { calls: 0 };
  manager.postTranscribe = function (...args) {
    counter.calls += 1;
    return original.apply(this, args);
  };
  return counter;
}

test("streamed text gets exactly one boundary, with the stream as its STT step", async (t) => {
  withGlossary(t);
  const { AudioManager, window } = await load(t, "streamed", {
    settings: { useLocalWhisper: false, cloudTranscriptionMode: "byok" },
  });
  window.electronAPI.cloudStreamingUsage = async () => ({ success: true });
  window.dispatchEvent = () => {};
  const completions = [];
  const manager = streamingManager(AudioManager, {
    streamingFinalText: RAW,
    onTranscriptionComplete: (result) => completions.push(result),
  });
  const counter = countBoundaryCalls(manager);

  assert.equal(await manager.stopStreamingRecording(), true);
  assert.equal(counter.calls, 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].text, CORRECTED);
  assert.equal(completions[0].rawText, RAW);
  assert.equal(completions[0].trace.steps[0].provider, "deepgram");
  assert.equal(completions[0].trace.glossary.rulesFired.length, 1);
});

test("the streaming→batch fallback applies the boundary exactly once", async (t) => {
  withGlossary(t);
  const { AudioManager, window } = await load(t, "stream-fallback", {
    settings: { useLocalWhisper: false, cloudTranscriptionMode: "byok" },
  });
  window.dispatchEvent = () => {};
  const completions = [];
  let batchTrace = null;
  const manager = streamingManager(AudioManager, {
    streamingFinalText: "",
    mergeRecordedSegments: async () => new Blob([new Uint8Array(100)]),
    onTranscriptionComplete: (result) => completions.push(result),
    // The batch path runs its own boundary, as processWithOpenAIAPI does.
    async processWithOpenAIAPI(_blob, _metadata, wasCancelled) {
      const post = await this.processTranscription(RAW, "openai", wasCancelled, {
        provider: "groq",
        model: "whisper-large-v3",
      });
      batchTrace = post.trace;
      return { success: true, text: post.text, rawText: RAW, source: "openai", trace: post.trace };
    },
  });
  const counter = countBoundaryCalls(manager);

  assert.equal(await manager.stopStreamingRecording(), true);
  assert.equal(counter.calls, 1, "the stream must not run a second boundary over the batch text");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].text, CORRECTED);
  assert.equal(completions[0].rawText, RAW);
  assert.strictEqual(completions[0].trace, batchTrace);
  assert.equal(batchTrace.glossary.rulesFired.length, 1);
});

// Groq-sized fixture: typed words, a canonical glossary term and ~150 learned words.
const LEARNED = Array.from({ length: 150 }, (_, i) => `LearnedTerm${String(i).padStart(3, "0")}`);
const MANUAL = ["OpenWhispr", "Supabase", "Gizmo Labs"];
const DICTIONARY = [...LEARNED.slice(0, 50), ...MANUAL, ...LEARNED.slice(50)];
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

function captureFetch(t, respond) {
  const originalFetch = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (_endpoint, init) => {
    const prompt = init.body.get("prompt");
    prompts.push(prompt);
    const text = respond(prompt);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ text }),
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return prompts;
}

async function loadGroq(t, name) {
  withGlossary(t, { learned: LEARNED.map((w) => w.toLowerCase()) });
  const loaded = await load(t, name, {
    settings: {
      useLocalWhisper: false,
      allowLocalFallback: false,
      cloudTranscriptionProvider: "groq",
      customDictionary: DICTIONARY,
    },
  });
  return loaded.createManager(
    baseManager({
      getTranscriptionModel: () => "whisper-large-v3",
      getTranscriptionEndpoint: () => GROQ_ENDPOINT,
      getAPIKey: async () => "test-key",
      shouldStreamTranscription: () => false,
      isReasoningAvailable: async () => false,
    })
  );
}

test("Groq gets the priority hint list: typed and canonical terms in the read tail", async (t) => {
  const manager = await loadGroq(t, "groq-prompt");
  const prompts = captureFetch(t, () => RAW);
  const audio = new Blob([new ArrayBuffer(8)], { type: "audio/webm" });

  const result = await manager.processWithOpenAIAPI(audio, {});
  assert.equal(result.text, CORRECTED);
  assert.ok(result.trace, "the batch result carries its trace");
  assert.equal(prompts.length, 1);
  const prompt = prompts[0];
  assert.ok(prompt.length <= 890, `Groq caps prompts at 896 chars; sent ${prompt.length}`);
  const tail = prompt.slice(-550);
  for (const term of [...MANUAL, "Little Buddy"]) {
    assert.ok(tail.includes(term), `${term} must sit in the tail Whisper reads`);
  }
  for (const alias of ["everybody", "buddies", "littlebuddy"]) {
    assert.ok(!prompt.toLowerCase().split(", ").includes(alias), `${alias} leaked into hints`);
  }
});

test("an echo of the exact capped prompt is discarded as a dictionary echo", async (t) => {
  const manager = await loadGroq(t, "groq-echo");
  captureFetch(t, (prompt) => prompt);
  const audio = new Blob([new ArrayBuffer(8)], { type: "audio/webm" });
  await assert.rejects(
    manager.processWithOpenAIAPI(audio, {}),
    (error) => error.code === "DICTIONARY_ECHO"
  );
});

test("a proxied echo is measured against the bias the payload carried", async (t) => {
  withGlossary(t, { learned: LEARNED.map((w) => w.toLowerCase()) });
  const { createManager, window } = await load(t, "mistral-echo", {
    settings: {
      useLocalWhisper: false,
      allowLocalFallback: false,
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "mistral",
      customDictionary: DICTIONARY,
    },
  });
  const payloads = [];
  // Mistral keeps the first 100 words of the list; this echoes exactly those.
  window.electronAPI.proxyMistralTranscription = async (payload) => {
    payloads.push(payload);
    return { text: payload.contextBias.join(", ") };
  };
  const manager = createManager(
    baseManager({
      getTranscriptionModel: () => "voxtral-mini-latest",
      getAPIKey: async () => "test-key",
      isReasoningAvailable: async () => false,
    })
  );
  const audio = new Blob([new ArrayBuffer(8)], { type: "audio/webm" });
  await assert.rejects(
    manager.processWithOpenAIAPI(audio, {}),
    (error) => error.code === "DICTIONARY_ECHO"
  );
  const [{ contextBias }] = payloads;
  assert.equal(contextBias.length, 100, "the list is longer than Mistral keeps");
  // Priority-first for a head-reading channel: typed words, then the canonical term.
  assert.deepEqual(contextBias.slice(0, 6), [
    "OpenWhispr",
    "Supabase",
    "Gizmo",
    "Labs",
    "Little",
    "Buddy",
  ]);
});

test("keyterm channels get the list priority-first, with canonical terms and no spellings", async (t) => {
  withGlossary(t, { learned: ["learnedterm000"] });
  const { createManager } = await load(t, "keyterms", {
    settings: {
      customDictionary: ["LearnedTerm000", "OpenWhispr"],
      snippets: [{ trigger: "cal link", replacement: "x" }],
    },
  });
  assert.deepEqual(createManager(baseManager()).getKeyterms(), [
    "OpenWhispr",
    "Little Buddy",
    "LearnedTerm000",
  ]);
});
