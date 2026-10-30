const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// Styles in AudioManager: a styled recording is its own intent (no wake word,
// no selection edit), runs in the post-transcription boundary's `run`, and is
// applied exactly once on every dictation path. Assistant and translation
// recordings never get one. Synthetic fixtures; the model calls are stubs.

const STYLE = Object.freeze({
  id: "starter-teams",
  name: "Teams chat",
  emoji: "💬",
  instruction:
    "When the message has two or more separate points, put each point on its own bullet.",
  runMode: "two-step",
  appGlossary: true,
  useVoice: false,
});

const RULE = Object.freeze({
  id: "rule-little-buddy",
  canonical: "Little Buddy",
  enabled: true,
  revision: 1,
  apps: ["Code.exe"],
  spellings: [{ text: "everybody", scope: "start" }],
});

const isRestyle = (config) => config?.systemPrompt?.startsWith("You restyle dictated text");

const mocks = (key, { agentReachable = false } = {}) => ({
  "/stores/glossaryStore": `
    export const getGlossarySnapshot = () => globalThis.__amStyleGlossary ?? { revision: 0, rules: [] };
  `,
  "/stores/dictionarySourcesStore": `
    export const getLearnedDictionaryWords = () => new Set();
    export const getPinnedDictionaryKeys = () => new Set();
    export const isDictionarySourcesLoaded = () => true;
  `,
  "/glossaryTerms": `
    export const getGlossaryCanonicalTerms = () => [];
    export const setGlossaryCanonicalTerms = () => {};
  `,
  "/config/prompts": `
    export const resolvePrompt = () => "prompt";
    export const appendScreenContextSuffix = (prompt) => prompt;
    export const wrapCleanupTranscript = (text) => text;
    export const getCleanupSystemPrompt = () => "cleanup prompt";
  `,
  "/stores/settingsStore": `
    export const getSettings = () => globalThis.${key};
    export const getEffectiveCleanupModel = () => globalThis.${key}.__cleanupModel ?? null;
    export const selectResolvedLLMConfig = () => ({
      mode: "providers", provider: "copilot", model: globalThis.${key}.__cleanupModel ?? null
    });
    export const isCloudCleanupMode = () => false;
    export const isCloudDictationAgentMode = () => false;
    export const isCloudTranslationMode = () => false;
    export const useSettingsStore = { subscribe: () => () => {} };
  `,
  "/dictationAgentInference": `
    export const resolveDictationAgentInference = () => ({
      reachable: ${agentReachable}, model: "agent-model", displayProvider: "openai",
      config: { provider: "openai" }
    });
    export const resolveDictationAgentVisionInference = () => ({ active: false, model: "", config: {} });
  `,
  "/dictationTranslationInference": `
    export const resolveDictationTranslationInference = () => ({
      reachable: !!globalThis.${key}.useDictationTranslation, model: "translate-model",
      displayProvider: "openai", config: { provider: "openai" }
    });
  `,
});

async function load(
  t,
  name,
  { settings = {}, cleanupModel = "cleanup-model", agentReachable } = {}
) {
  const settingsKey = `__amStyles_${name.replace(/\W/g, "_")}`;
  const loaded = await loadAudioManager(t, {
    cachePrefix: `openwhispr-am-styles-${name}-`,
    settingsKey,
    settings: {
      preferredLanguage: "en",
      useCleanupModel: true,
      cleanupMode: "providers",
      cleanupDisableThinking: true,
      __cleanupModel: cleanupModel,
      ...settings,
    },
    mockModules: mocks(settingsKey, { agentReachable }),
  });
  return loaded;
}

// A model stub: cleanup appends " [clean]", the restyle returns bullets.
function modelStub({ restyle, cleanup } = {}) {
  const calls = [];
  return {
    calls,
    processWithReasoningModel: async (text, model, _agent, config) => {
      const kind = isRestyle(config) ? "restyle" : config?.cleanupStyle ? "one-step" : "cleanup";
      // The restyle message wraps the text it restyles; record what it was given.
      const given =
        kind === "restyle" ? text.slice("<text>\n".length, text.indexOf("\n</text>")) : text;
      calls.push({ kind, text: given, message: text, model, config });
      config?.onDispatch?.({
        provider: "copilot",
        model: "claude-haiku-5.5",
        prompt: { source: "resolved", text: config?.systemPrompt ?? "cleanup prompt" },
      });
      if (kind === "restyle") return restyle ? restyle(text) : "- styled one\n- styled two";
      if (kind === "one-step") return "- one step";
      return cleanup ? cleanup(text) : `${text} [clean]`;
    },
  };
}

const baseManager = (overrides = {}) => ({
  voiceAgentRequested: false,
  translationRequested: false,
  translationApplied: false,
  recordingStyle: STYLE,
  pendingCleanupFailure: null,
  pendingAssistantConversation: null,
  pendingSelectionEdit: null,
  recordingTargetPromise: Promise.resolve({ exeName: "Code.exe" }),
  isReasoningAvailable: async () => true,
  notifyTranslationFallback: () => {},
  ...overrides,
});

const kinds = (trace) => trace.steps.map((step) => `${step.kind}:${step.outcome}`);

test("a styled recording: cleanup, then the restyle, recorded as a style step", async (t) => {
  const { createManager } = await load(t, "two-step");
  const model = modelStub();
  const fallbacks = [];
  const manager = createManager(
    baseManager({ ...model, onStyleFallback: (event) => fallbacks.push(event) })
  );

  const post = await manager.processTranscription("um two points here", "openai");
  assert.equal(post.text, "- styled one\n- styled two");
  assert.deepEqual(
    model.calls.map((c) => [c.kind, c.text]),
    [
      ["cleanup", "um two points here"],
      ["restyle", "um two points here [clean]"],
    ]
  );
  assert.equal(post.trace.route, "style");
  assert.deepEqual(post.trace.context.style, { id: STYLE.id, runMode: "two-step" });
  assert.deepEqual(kinds(post.trace), [
    "stt:ok",
    "glossary:skipped",
    "cleanup:ok",
    "style:ok",
    "finalize:ok",
  ]);
  const style = post.trace.steps.find((s) => s.kind === "style");
  assert.deepEqual(style.detail, { styleId: STYLE.id, runMode: "two-step" });
  // Two steps: the cleanup step records the word set its request carried; the
  // restyle has its own system prompt and no dictionary of its own.
  const cleanupStep = post.trace.steps.find((s) => s.kind === "cleanup");
  assert.deepEqual(
    cleanupStep.detail.dictionaryScope,
    model.calls[0].config.cleanupDictionary.scope
  );
  assert.equal(style.provider, "copilot");
  assert.equal(style.prompt.text, model.calls[1].config.systemPrompt);
  const restyle = model.calls[1].config;
  assert.equal(restyle.inferenceScope, "dictationCleanup");
  assert.equal(restyle.disableThinking, true);
  assert.equal(restyle.requireCompleteOutput, true);
  assert.deepEqual(fallbacks, []);
});

test("one step: a single request carrying the style, no plain cleanup", async (t) => {
  const { createManager } = await load(t, "one-step");
  const model = modelStub();
  const manager = createManager(
    baseManager({ ...model, recordingStyle: { ...STYLE, runMode: "one-step" } })
  );
  const post = await manager.processTranscription("um two points", "openai");
  assert.equal(post.text, "- one step");
  assert.deepEqual(
    model.calls.map((c) => c.kind),
    ["one-step"]
  );
  assert.equal(model.calls[0].config.systemPrompt, undefined, "never a system prompt");
  assert.equal(model.calls[0].config.cleanupStyle.name, "Teams chat");
  // One step is the cleanup request: its dictionary word set is decided once,
  // and the style step records the very selection the request carried.
  const detail = post.trace.steps.find((s) => s.kind === "style").detail;
  assert.deepEqual(detail, {
    styleId: STYLE.id,
    runMode: "one-step",
    dictionaryScope: model.calls[0].config.cleanupDictionary.scope,
  });
  assert.equal(detail.dictionaryScope.setting, "all");
  assert.equal(detail.dictionaryScope.applied, "all");
});

test("intent: a styled recording never wakes the assistant or edits a selection", async (t) => {
  const { createManager, window } = await load(t, "wake-word", {
    settings: { useDictationAgent: true },
    agentReachable: true,
  });
  window.localStorage.setItem("agentName", "Little Buddy");
  const model = modelStub();
  const agent = [];
  const manager = createManager(
    baseManager({
      ...model,
      processAgentCommand: async (text) => {
        agent.push(text);
        return "agent reply";
      },
      consumeSelectionCapture: () => {
        throw new Error("a styled recording must not read the selection");
      },
    })
  );

  const post = await manager.processTranscription("Little Buddy, the build is green.", "openai");
  assert.deepEqual(agent, [], "the wake word is never scanned");
  assert.equal(post.trace.context.intents.wakeWord, false);
  assert.equal(post.trace.route, "style");
  assert.equal(post.text, "- styled one\n- styled two");

  // The same words without a style still wake the assistant.
  const plain = createManager(
    baseManager({ ...model, recordingStyle: null, processAgentCommand: async () => "agent reply" })
  );
  const unstyled = await plain.processTranscription("Little Buddy, the build is green.", "openai");
  assert.equal(unstyled.trace.route, "agent");
});

test("intent: translation and assistant recordings never get a style", async (t) => {
  const { createManager } = await load(t, "precedence", {
    settings: {
      useDictationTranslation: true,
      translationSourceLanguage: "en",
      translationTargetLanguage: "es",
    },
  });
  const model = modelStub();
  const translating = createManager(
    baseManager({ ...model, translationRequested: true, notifyTranslationFallback: () => {} })
  );
  const translated = await translating.processTranscription("hello there", "openai");
  assert.equal(translated.trace.route, "translation");
  assert.equal(translated.trace.context.style, undefined);
  assert.ok(model.calls.every((c) => c.kind !== "restyle"));
  assert.equal(translating.getRecordingRouteKind(), "translation");

  const assistant = createManager(
    baseManager({
      ...model,
      voiceAgentRequested: true,
      consumeScreenContext: async () => null,
      processAgentCommand: async () => "agent reply",
    })
  );
  const commanded = await assistant.processTranscription("open the notes", "openai");
  assert.equal(commanded.trace.route, "agent");
  assert.equal(commanded.trace.context.style, undefined);
  assert.equal(assistant.getRecordingRouteKind(), null);
});

test("fallbacks: a failed restyle pastes the cleaned text and says so", async (t) => {
  const { createManager } = await load(t, "restyle-fails");
  const model = modelStub({
    restyle: () => {
      throw Object.assign(new Error("timed out"), { code: "PROVIDER_TIMEOUT" });
    },
  });
  const fallbacks = [];
  const manager = createManager(
    baseManager({ ...model, onStyleFallback: (event) => fallbacks.push(event) })
  );
  const post = await manager.processTranscription("um the build", "openai");
  assert.equal(post.text, "um the build [clean]");
  assert.deepEqual(fallbacks, [
    {
      reason: "failed",
      style: { id: STYLE.id, name: "Teams chat", emoji: "💬" },
    },
  ]);
  assert.equal(post.trace.steps.find((s) => s.kind === "style").outcome, "failed");
});

test("fallbacks: a failed cleanup restyles the corrected transcript", async (t) => {
  const { createManager } = await load(t, "cleanup-fails");
  const model = modelStub({
    cleanup: () => {
      throw Object.assign(new Error("rate limited"), { code: "PROVIDER_RATE_LIMITED" });
    },
  });
  const manager = createManager(baseManager({ ...model }));
  const post = await manager.processTranscription("um the build", "openai");
  assert.deepEqual(
    model.calls.map((c) => [c.kind, c.text]),
    [
      ["cleanup", "um the build"],
      ["restyle", "um the build"],
    ]
  );
  assert.equal(post.text, "- styled one\n- styled two");
  assert.ok(manager.pendingCleanupFailure, "the cleanup-failed notice still fires");
});

test("cleanup off: the style still runs, restyling the corrected transcript", async (t) => {
  const { createManager } = await load(t, "cleanup-off", { settings: { useCleanupModel: false } });
  const model = modelStub();
  const manager = createManager(baseManager({ ...model }));
  const post = await manager.processTranscription("um the build", "openai");
  assert.deepEqual(
    model.calls.map((c) => c.kind),
    ["restyle"]
  );
  assert.equal(post.text, "- styled one\n- styled two");
});

test("no model for the cleanup scope keeps today's text, with the notice", async (t) => {
  const { createManager } = await load(t, "no-model", { cleanupModel: null });
  const model = modelStub();
  const fallbacks = [];
  const manager = createManager(
    baseManager({ ...model, onStyleFallback: (event) => fallbacks.push(event) })
  );
  const post = await manager.processTranscription("um the build", "openai");
  assert.equal(post.text, "um the build");
  assert.equal(post.trace.route, "none");
  assert.deepEqual(model.calls, []);
  assert.equal(fallbacks[0].reason, "unreachable");
});

test("a style can switch the glossary's app-scoped corrections off", async (t) => {
  globalThis.__amStyleGlossary = { revision: 2, rules: [RULE] };
  t.after(() => delete globalThis.__amStyleGlossary);
  const { createManager } = await load(t, "app-glossary");
  const cleanupInputs = [];
  const model = modelStub({ cleanup: (text) => (cleanupInputs.push(text), text) });

  const on = createManager(baseManager({ ...model }));
  await on.processTranscription("Hello everybody, quick one.", "openai");
  const off = createManager(
    baseManager({ ...model, recordingStyle: { ...STYLE, appGlossary: false } })
  );
  const post = await off.processTranscription("Hello everybody, quick one.", "openai");

  assert.deepEqual(cleanupInputs, [
    "Hello Little Buddy, quick one.",
    "Hello everybody, quick one.",
  ]);
  assert.equal(post.trace.context.targetApp, "Code.exe", "the app is still recorded");
});

test("history: the row's route kind is style:<id>, taken from the trace", async (t) => {
  const { createManager, window } = await load(t, "route-kind", {
    settings: { dataRetentionEnabled: true, audioRetentionDays: 0 },
  });
  const saved = [];
  window.electronAPI.recordAnalyticsEvent = async () => ({ success: true });
  window.electronAPI.saveTranscription = async (text, raw, options) => {
    saved.push(options);
    return { id: 1 };
  };
  const model = modelStub();
  const manager = createManager(baseManager({ ...model, lastAudioMetadata: {} }));
  const post = await manager.processTranscription("um the build", "openai");

  // Another recording may have started (and changed the style) before the save.
  manager.setRecordingStyle(null);
  await manager.saveTranscription(post.text, "um the build", { trace: post.trace });
  assert.equal(saved[0].routeKind, "style:starter-teams");

  // Failed rows of a styled recording keep the style, for a retry.
  manager.setRecordingStyle(STYLE);
  assert.equal(manager.getRecordingRouteKind(), "style:starter-teams");
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

function countCalls(manager, method) {
  const original = manager[method];
  const counter = { calls: 0 };
  manager[method] = function (...args) {
    counter.calls += 1;
    return original.apply(this, args);
  };
  return counter;
}

test("streaming applies the style exactly once", async (t) => {
  const { AudioManager, window } = await load(t, "streaming", {
    settings: { useLocalWhisper: false, cloudTranscriptionMode: "byok", cleanupCloudMode: "byok" },
  });
  window.electronAPI.cloudStreamingUsage = async () => ({ success: true });
  window.dispatchEvent = () => {};
  const completions = [];
  const model = modelStub();
  const manager = streamingManager(AudioManager, {
    ...model,
    streamingFinalText: "um two points",
    onTranscriptionComplete: (result) => completions.push(result),
  });
  const boundary = countCalls(manager, "postTranscribe");
  const route = countCalls(manager, "runStyleRoute");

  assert.equal(await manager.stopStreamingRecording(), true);
  assert.equal(boundary.calls, 1);
  assert.equal(route.calls, 1);
  assert.equal(model.calls.filter((c) => c.kind === "restyle").length, 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].text, "- styled one\n- styled two");
  assert.equal(completions[0].rawText, "um two points");
});

test("the streaming→batch fallback applies the style exactly once", async (t) => {
  const { AudioManager, window } = await load(t, "stream-fallback", {
    settings: { useLocalWhisper: false, cloudTranscriptionMode: "byok", cleanupCloudMode: "byok" },
  });
  window.dispatchEvent = () => {};
  const completions = [];
  const model = modelStub();
  const manager = streamingManager(AudioManager, {
    ...model,
    streamingFinalText: "",
    mergeRecordedSegments: async () => new Blob([new Uint8Array(100)]),
    onTranscriptionComplete: (result) => completions.push(result),
    async processWithOpenAIAPI(_blob, _metadata, wasCancelled) {
      const post = await this.processTranscription("um two points", "openai", wasCancelled);
      return {
        success: true,
        text: post.text,
        rawText: "um two points",
        source: "openai",
        trace: post.trace,
      };
    },
  });
  const route = countCalls(manager, "runStyleRoute");

  assert.equal(await manager.stopStreamingRecording(), true);
  assert.equal(route.calls, 1, "the stream must not restyle the batch result again");
  assert.equal(model.calls.filter((c) => c.kind === "restyle").length, 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].text, "- styled one\n- styled two");
});
