const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// "Dictionary words in the cleanup prompt" through every dictation cleanup
// path, with the real stores: ordinary cleanup (a model and OpenWhispr
// Cloud), the translation chain's cleanup step, a streaming dictation's
// cleanup, and History's Re-run cleanup. Each request carries the selection
// it was built with, and its cleanup step records that selection's scope;
// translation and the assistant keep the full list. Synthetic words only.

const RAW = "um ask open whisper about gonestly";
const DICTIONARY = ["OpenWhispr", "gonestly", "Scout Web", "EngHub"];
const TYPED_PINNED = ["OpenWhispr", "Scout Web", "cal link"];
const SCOPE = { setting: "typedPinned", applied: "typedPinned", words: 2 };

test("the cleanup word set reaches every cleanup request, and its step", async (t) => {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  t.after(() => delete navigator.onLine);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-cleanup-dictionary-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
    },
  });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useDictionarySourcesStore } = await vite.ssrLoadModule(
    "/stores/dictionarySourcesStore.ts"
  );
  const { useDictionaryUsageStore } = await vite.ssrLoadModule("/stores/dictionaryUsageStore.ts");
  const { rerunAfterSpeechToText } = await vite.ssrLoadModule("/services/historyRerun.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  useSettingsStore.setState({
    isSignedIn: true,
    useCleanupModel: true,
    cleanupMode: "openwhispr",
    cleanupCloudMode: "openwhispr",
    useDictationAgent: false,
    customPrompts: { cleanup: "" },
    preferredLanguage: "en",
    dataRetentionEnabled: true,
    customDictionary: DICTIONARY,
    snippets: [{ trigger: "cal link", replacement: "https://cal.example" }],
    cleanupDictionaryWords: "typedPinned",
  });
  useDictionarySourcesStore.setState({
    learned: new Set(["gonestly", "scout web", "enghub"]),
    loaded: true,
    pinned: new Set(["scout web"]),
    pinsLoaded: true,
  });
  useDictionaryUsageStore.setState({ status: "unavailable", missed: null });

  const reasoned = [];
  window.electronAPI.cloudReason = async (text, opts) => {
    reasoned.push(opts);
    return { success: true, text: "Ask OpenWhispr about it.", model: "cloud-model" };
  };
  window.electronAPI.cloudTranscribe = async () => ({ success: true, text: RAW });
  window.electronAPI.cloudStreamingUsage = async () => ({ success: true });
  const createManager = () =>
    Object.assign(Object.create(AudioManager.prototype), {
      voiceAgentRequested: false,
      translationRequested: false,
      pendingCleanupFailure: null,
      getEffectiveSttLanguage: () => "en",
      getWhisperPrompt: () => null,
      isDictionaryEcho: () => false,
      isReasoningAvailable: async () => true,
      finalizeChineseScript: async (text) => text,
    });
  const cleanupStep = (trace) => trace.steps.find((step) => step.kind === "cleanup");

  await t.test(
    "OpenWhispr Cloud dictation: the selected words, the scope on its step",
    async () => {
      reasoned.length = 0;
      const result = await createManager().processWithOpenWhisprCloud(new Blob(["audio"]));
      assert.deepEqual(reasoned[0].customDictionary, TYPED_PINNED);
      assert.deepEqual(cleanupStep(result.trace).detail, { dictionaryScope: SCOPE });
    }
  );

  await t.test("streaming dictation's Cloud cleanup", async () => {
    reasoned.length = 0;
    let result;
    const manager = Object.assign(createManager(), {
      streamingFinalText: RAW,
      streamingCleanupFns: [],
      micRecovery: { stop() {} },
      finishStreamingFallbackSegment: async () => {},
      mergeRecordedSegments: async () => null,
      awaitStreamingTextSettled: async () => {},
      getStreamingProvider: () => ({
        awaitsFinalTranscript: true,
        stop: async () => ({ success: true }),
      }),
      getStreamingProviderName: () => "openwhispr",
      shouldUseStreaming: () => false,
      onTranscriptionComplete: (value) => {
        result = value;
      },
    });
    await manager._finalizeStreamingRecording(null);
    assert.deepEqual(reasoned[0].customDictionary, TYPED_PINNED);
    assert.deepEqual(cleanupStep(result.trace).detail, { dictionaryScope: SCOPE });
  });

  await t.test("a model's cleanup (batch): the selection rides the request config", async () => {
    useSettingsStore.setState({
      cleanupMode: "providers",
      cleanupCloudMode: "byok",
      cleanupProvider: "openai",
      cleanupModel: "gpt-test",
    });
    try {
      const configs = [];
      const manager = Object.assign(createManager(), {
        processWithReasoningModel: async (text, model, agentName, config) => {
          configs.push(config);
          config.onDispatch?.({ provider: "openai", model });
          return "Ask OpenWhispr about it.";
        },
      });
      const post = await manager.processTranscription(RAW, "openai");
      assert.deepEqual(configs[0].cleanupDictionary.words, TYPED_PINNED);
      assert.deepEqual(cleanupStep(post.trace).detail, { dictionaryScope: SCOPE });
    } finally {
      useSettingsStore.setState({ cleanupMode: "openwhispr", cleanupCloudMode: "openwhispr" });
    }
  });

  await t.test(
    "the translation chain's cleanup follows the set; the translation doesn't",
    async () => {
      reasoned.length = 0;
      const steps = [];
      const recordStep = async (kind, meta, fn) => {
        steps.push({ kind, meta });
        return fn(() => {});
      };
      let translateConfig;
      const manager = Object.assign(createManager(), {
        processWithReasoningModel: async (text, model, agentName, config) => {
          translateConfig = config;
          return "Fragen Sie OpenWhispr.";
        },
      });
      await manager.runTranslationChain({
        text: RAW,
        settings: {
          ...useSettingsStore.getState(),
          translationSourceLanguage: "en",
          translationTargetLanguage: "de",
        },
        route: {
          cleanupReachable: true,
          model: "translate-model",
          config: { systemPrompt: "Translate everything. Dictionary: OpenWhispr, gonestly" },
        },
        cleanup: { mode: "cloudReason" },
        recordStep,
      });
      assert.deepEqual(reasoned[0].customDictionary, TYPED_PINNED);
      assert.deepEqual(steps[0], {
        kind: "cleanup",
        meta: {
          provider: "openwhispr",
          prompt: { source: "server" },
          detail: { dictionaryScope: SCOPE },
        },
      });
      assert.equal(steps[1].kind, "translation");
      assert.equal(translateConfig.cleanupDictionary, undefined, "translation keeps its own list");
    }
  );

  await t.test("History's Re-run cleanup records the set on its cleanup step", async () => {
    reasoned.length = 0;
    let saved;
    window.electronAPI.updateTranscriptionText = async (id, text, rawText, options) => {
      saved = options.trace;
      return { success: true, transcription: { id, text } };
    };
    const outcome = await rerunAfterSpeechToText(
      {
        id: 7,
        rawText: RAW,
        routeKind: null,
        currentText: RAW,
        stt: { provider: "groq", model: "whisper", ms: null, reused: "stored" },
        targetApp: null,
        runId: "run-1",
      },
      { cleanupFailed: () => {}, styleNotApplied: () => {} }
    );
    assert.equal(outcome.status, "updated");
    assert.deepEqual(reasoned[0].customDictionary, TYPED_PINNED);
    assert.deepEqual(cleanupStep(saved).detail, { dictionaryScope: SCOPE });
  });

  await t.test("'words speech misses' without counts sends All, and the step says so", async () => {
    reasoned.length = 0;
    useSettingsStore.setState({ cleanupDictionaryWords: "typedPinnedMissed" });
    const result = await createManager().processWithOpenWhisprCloud(new Blob(["audio"]));
    assert.deepEqual(reasoned[0].customDictionary, [...DICTIONARY, "cal link"]);
    assert.deepEqual(cleanupStep(result.trace).detail, {
      dictionaryScope: { setting: "typedPinnedMissed", applied: "all", words: 4 },
    });
    // With counts, the learned words speech misses join the typed and pinned ones.
    reasoned.length = 0;
    useDictionaryUsageStore.setState({ status: "ready", missed: new Set(["enghub"]) });
    await createManager().processWithOpenWhisprCloud(new Blob(["audio"]));
    assert.deepEqual(reasoned[0].customDictionary, [
      "OpenWhispr",
      "Scout Web",
      "EngHub",
      "cal link",
    ]);
  });
});
