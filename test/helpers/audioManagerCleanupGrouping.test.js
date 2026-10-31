const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Categories in the dictation cleanup paths (Dictionary v2, Stage C), with the
// real stores: "All words except everyday words" and "Group dictionary words
// by category" ride on the route's one snapshot (buildDictationCleanupConfig).
// OpenWhispr Cloud's cleanup (a dictation, streaming, the translation chain's
// cleanup step, History's Re-run cleanup) gets the flat list and never the
// grouping; a model's cleanup gets the grouped prompt; every cleanup step
// records the set it ran with; and before the categories are ready the set
// falls back to All and says so. Synthetic words only.

const RAW = "um ask dmitry about the kusto query";
const DICTIONARY = ["groq", "Dmitry", "PR", "Kusto", "the", "CED"];
const SNIPPETS = [{ trigger: "cal link", replacement: "https://cal.example" }];
const NO_EVERYDAY = ["groq", "Dmitry", "PR", "Kusto", "CED", "cal link"];
const SCOPE = { setting: "noEveryday", applied: "noEveryday", words: 5 };

test("categories reach every cleanup path: Cloud flat, a model grouped, the step's set recorded", async (t) => {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  t.after(() => delete navigator.onLine);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-cleanup-grouping-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
    },
  });
  await vite.ssrLoadModule("/i18n.ts");
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useDictionarySourcesStore } = await vite.ssrLoadModule(
    "/stores/dictionarySourcesStore.ts"
  );
  const { useDictionaryUsageStore } = await vite.ssrLoadModule("/stores/dictionaryUsageStore.ts");
  const { useDictionaryCategoriesStore } = await vite.ssrLoadModule(
    "/stores/dictionaryCategoriesStore.ts"
  );
  const { buildDictationCleanupConfig } = await vite.ssrLoadModule(
    "/helpers/dictationCleanupConfig.ts"
  );
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
    uiLanguage: "en",
    dataRetentionEnabled: true,
    customDictionary: DICTIONARY,
    snippets: SNIPPETS,
    cleanupDictionaryWords: "noEveryday",
    cleanupDictionaryGrouping: true,
  });
  useDictionarySourcesStore.setState({
    learned: new Set(),
    loaded: true,
    pinned: new Set(),
    pinsLoaded: true,
  });
  useDictionaryUsageStore.setState({ status: "unavailable", missed: null });
  const ready = {
    stored: new Map([["kusto", { category: "work", source: "model" }]]),
    storedLoaded: true,
    commonWords: new Set(["the"]),
    ready: true,
  };
  useDictionaryCategoriesStore.setState(ready);

  const reasoned = [];
  window.electronAPI.cloudReason = async (text, opts) => {
    reasoned.push(opts);
    return { success: true, text: "Ask Dmitry about the Kusto query.", model: "cloud-model" };
  };
  window.electronAPI.cloudTranscribe = async () => ({ success: true, text: RAW });
  window.electronAPI.cloudStreamingUsage = async () => ({ success: true });
  const local = [];
  window.electronAPI.processLocalReasoning = async (text, model, agentName, config) => {
    local.push(config);
    return { success: true, text: "Ask Dmitry about the Kusto query." };
  };
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
  const noGrouping = (opts) => {
    const json = JSON.stringify(opts);
    assert.equal(json.includes("groups"), false, "Cloud never gets the grouping");
    assert.equal(json.includes("cleanupDictionary"), false);
  };

  await t.test(
    "OpenWhispr Cloud dictation: the set's flat list, its scope on the step",
    async () => {
      reasoned.length = 0;
      const result = await createManager().processWithOpenWhisprCloud(new Blob(["audio"]));
      assert.deepEqual(reasoned[0].customDictionary, NO_EVERYDAY);
      noGrouping(reasoned[0]);
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
    assert.deepEqual(reasoned[0].customDictionary, NO_EVERYDAY);
    noGrouping(reasoned[0]);
    assert.deepEqual(cleanupStep(result.trace).detail, { dictionaryScope: SCOPE });
  });

  await t.test(
    "the translation chain's Cloud cleanup step reads the route's snapshot",
    async () => {
      reasoned.length = 0;
      const steps = [];
      const recordStep = async (kind, meta, fn) => {
        steps.push({ kind, meta });
        return fn(() => {});
      };
      const cleanupConfig = buildDictationCleanupConfig(useSettingsStore.getState());
      assert.ok(cleanupConfig.cleanupDictionary.groups, "the snapshot holds the grouping");
      const manager = Object.assign(createManager(), {
        processWithReasoningModel: async () => "Fragen Sie Dmitry.",
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
          cleanupConfig,
          model: "translate-model",
          config: { systemPrompt: "Translate everything." },
        },
        cleanup: { mode: "cloudReason" },
        recordStep,
      });
      assert.deepEqual(reasoned[0].customDictionary, cleanupConfig.cleanupDictionary.words);
      noGrouping(reasoned[0]);
      assert.deepEqual(steps[0].meta.detail, { dictionaryScope: SCOPE });
    }
  );

  await t.test(
    "a model's cleanup (batch): the snapshot rides the config; the prompt is grouped",
    async () => {
      useSettingsStore.setState({
        cleanupMode: "local",
        cleanupCloudMode: "byok",
        cleanupProvider: "qwen",
        cleanupModel: "qwen3.5-4b-q4_k_m",
      });
      try {
        const configs = [];
        const manager = Object.assign(createManager(), {
          processWithReasoningModel: async (text, model, agentName, config) => {
            configs.push(config);
            return service.processText(text, model, agentName, config);
          },
        });
        local.length = 0;
        const post = await manager.processTranscription(RAW, "openai");
        assert.deepEqual(configs[0].cleanupDictionary.words, NO_EVERYDAY);
        assert.deepEqual(
          configs[0].cleanupDictionary.groups.map((entry) => entry.group),
          ["people", "work", "other"]
        );
        assert.match(
          local[0].systemPrompt,
          /: People: Dmitry; Work terms: PR, Kusto, CED; Other: groq, cal link$/
        );
        assert.equal(JSON.stringify(local[0]).includes("cleanupDictionary"), false);
        assert.deepEqual(cleanupStep(post.trace).detail, { dictionaryScope: SCOPE });

        // History's Re-run cleanup on a model: the same grouped prompt and set.
        local.length = 0;
        let saved;
        window.electronAPI.updateTranscriptionText = async (id, text, rawText, options) => {
          saved = options.trace;
          return { success: true, transcription: { id, text } };
        };
        const outcome = await rerunAfterSpeechToText(
          {
            id: 8,
            rawText: RAW,
            routeKind: null,
            currentText: RAW,
            stt: { provider: "groq", model: "whisper", ms: null, reused: "stored" },
            targetApp: null,
            runId: "run-2",
          },
          { cleanupFailed: () => {}, styleNotApplied: () => {} }
        );
        assert.equal(outcome.status, "updated");
        assert.match(local[0].systemPrompt, /People: Dmitry; Work terms: PR, Kusto, CED/);
        assert.deepEqual(cleanupStep(saved).detail, { dictionaryScope: SCOPE });
      } finally {
        useSettingsStore.setState({
          cleanupMode: "openwhispr",
          cleanupCloudMode: "openwhispr",
          cleanupProvider: "",
          cleanupModel: "",
        });
      }
    }
  );

  await t.test("History's Re-run cleanup on Cloud: the flat list", async () => {
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
    assert.deepEqual(reasoned[0].customDictionary, NO_EVERYDAY);
    noGrouping(reasoned[0]);
    assert.deepEqual(cleanupStep(saved).detail, { dictionaryScope: SCOPE });
  });

  await t.test("before the categories are ready: All, flat, and the step says so", async () => {
    reasoned.length = 0;
    useDictionaryCategoriesStore.setState({ commonWords: null, ready: false });
    const result = await createManager().processWithOpenWhisprCloud(new Blob(["audio"]));
    assert.deepEqual(reasoned[0].customDictionary, [...DICTIONARY, "cal link"]);
    assert.deepEqual(cleanupStep(result.trace).detail, {
      dictionaryScope: { setting: "noEveryday", applied: "all", words: 6 },
    });
    useDictionaryCategoriesStore.setState(ready);
  });
});
