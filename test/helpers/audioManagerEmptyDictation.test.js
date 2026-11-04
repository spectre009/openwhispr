const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// A dictation that ends with no text: every provider's empty answer carries
// EMPTY_TRANSCRIPT and reads as silence, never a failure card; every way a
// dictation ends empty (the provider's answer, the speech gate's skip, an
// empty result) goes through "End empty dictations quietly" with the
// recording's length: a short one ends quietly with no History row (only
// what "Save discarded dictations" keeps), a longer one is the notice and
// keeps its failed row for Retry. One "Empty dictation" line each, no text.

const LOGS = "__emptyDictationLogs";
const ORIGIN = "https://res.cognitiveservices.azure.com";

const azureSettings = (overrides = {}) => ({
  useLocalWhisper: false,
  allowLocalFallback: false,
  cloudTranscriptionMode: "byok",
  transcriptionMode: "providers",
  cloudTranscriptionProvider: "azure-speech",
  cloudTranscriptionModel: "MAI-Transcribe-2",
  azureSpeechEndpoint: ORIGIN,
  azureSpeechApiKey: "az-key",
  preferredLanguage: "en",
  customDictionary: [],
  snippets: [],
  dataRetentionEnabled: true,
  audioRetentionDays: 30,
  saveDiscardedTranscriptions: false,
  quietEmptyDictationSeconds: 3,
  ...overrides,
});

async function load(t, settings) {
  globalThis[LOGS] = [];
  t.after(() => delete globalThis[LOGS]);
  // Azure Speech converts the recording to WAV through OfflineAudioContext.
  const originalContext = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    decodeAudioData() {
      const samples = new Float32Array(16);
      return Promise.resolve({
        sampleRate: 16000,
        numberOfChannels: 1,
        getChannelData: () => samples,
      });
    }
  };
  t.after(() => {
    if (originalContext === undefined) delete globalThis.OfflineAudioContext;
    else globalThis.OfflineAudioContext = originalContext;
  });
  return loadAudioManager(t, {
    cachePrefix: "openwhispr-empty-dictation-test-",
    settingsKey: "__emptyDictationSettings",
    settings,
    mockModules: {
      "/utils/logger": `export default {
        debug() {}, warn() {}, error() {}, logReasoning() {},
        info(message, data, scope) { globalThis.${LOGS}?.push({ message, data, scope }); },
      };`,
    },
  });
}

const recording = () => new Blob(["recording"], { type: "audio/webm" });

function pipelineManager(loaded, overrides = {}) {
  const events = {
    order: [],
    noAudio: [],
    errors: [],
    completions: [],
    failedSaves: [],
    discardedSaves: [],
  };
  const manager = loaded.createManager({
    isProcessing: true,
    _localSpeechGateState: null,
    _activeTranscriptionAbortController: null,
    translationRequested: false,
    voiceAgentRequested: false,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    lastAudioBlob: null,
    getAPIKey: async () => "test-key",
    processTranscription: async (text) => ({ text }),
    isReasoningAvailable: async () => false,
    onStateChange: (state) => events.order.push(state.isProcessing ? "processing" : "idle"),
    onNoAudio: (detail) => {
      events.order.push("no-audio");
      events.noAudio.push(detail);
    },
    onError: (report) => {
      events.order.push("error");
      events.errors.push(report);
    },
    onTranscriptionComplete: (result) => {
      events.order.push("complete");
      events.completions.push(result);
    },
    saveFailedTranscription: async (message, code, metadata) => {
      events.failedSaves.push({ message, code, durationSeconds: metadata?.durationSeconds });
    },
    saveDiscardedTranscription: async (blob, durationSeconds) => {
      events.discardedSaves.push({ size: blob.size, durationSeconds });
    },
    ...overrides,
  });
  return { manager, events };
}

async function run(manager, metadata) {
  const blob = recording();
  manager.lastAudioBlob = blob;
  await manager.processAudio(blob, metadata);
  return blob;
}

const emptyLines = () => globalThis[LOGS].filter((line) => line.message === "Empty dictation");

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

function answerAzureSpeech(t, answer = { durationMilliseconds: 1500, combinedPhrases: [] }) {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
}

test("Azure Speech's empty answer carries EMPTY_TRANSCRIPT and keeps its message", async (t) => {
  const loaded = await load(t, azureSettings());
  const { manager } = pipelineManager(loaded);
  answerAzureSpeech(t);
  const error = await rejection(manager.processWithOpenAIAPI(recording()));
  assert.equal(error.code, "EMPTY_TRANSCRIPT");
  assert.match(error.message, /^No text transcribed - audio may be too short, silent/);
});

test("a short empty Azure Speech dictation ends quietly: no card, no row", async (t) => {
  const loaded = await load(t, azureSettings());
  const { manager, events } = pipelineManager(loaded);
  answerAzureSpeech(t);

  await run(manager, { durationSeconds: 1.538 });

  assert.deepEqual(events.order, ["idle", "no-audio"]);
  assert.deepEqual(events.noAudio, [{ durationMs: 1538, outcome: "quiet" }]);
  assert.deepEqual(events.errors, []);
  assert.deepEqual(events.failedSaves, [], "no failed row");
  assert.deepEqual(events.discardedSaves, [], "Save discarded dictations is off");
  assert.equal(manager.lastAudioBlob, null, "nothing kept for a later save");
  assert.deepEqual(emptyLines(), [
    {
      message: "Empty dictation",
      data: {
        durationMs: 1538,
        thresholdSeconds: 3,
        outcome: "quiet",
        source: "provider",
        code: "EMPTY_TRANSCRIPT",
      },
      scope: "audio",
    },
  ]);
});

test("a quiet one is kept only as a discarded dictation, as a cancel would be", async (t) => {
  const loaded = await load(t, azureSettings({ saveDiscardedTranscriptions: true }));
  const { manager, events } = pipelineManager(loaded);
  answerAzureSpeech(t);

  const blob = await run(manager, { durationSeconds: 1.538 });

  assert.deepEqual(events.failedSaves, []);
  assert.deepEqual(events.discardedSaves, [{ size: blob.size, durationSeconds: 1.538 }]);

  // Under a second, nothing, as for a cancelled recording.
  const short = pipelineManager(loaded);
  await run(short.manager, { durationSeconds: 0.6 });
  assert.deepEqual(short.events.discardedSaves, []);
});

test("a longer empty dictation is the notice and keeps its failed row for Retry", async (t) => {
  const loaded = await load(t, azureSettings());
  const { manager, events } = pipelineManager(loaded);
  answerAzureSpeech(t);

  await run(manager, { durationSeconds: 4.6 });

  assert.deepEqual(events.order, ["idle", "no-audio"]);
  assert.deepEqual(events.noAudio, [{ durationMs: 4600, outcome: "notice" }]);
  assert.deepEqual(events.errors, [], "never the persistent error card");
  assert.equal(events.failedSaves.length, 1);
  assert.equal(events.failedSaves[0].code, "EMPTY_TRANSCRIPT");
  assert.deepEqual(events.discardedSaves, []);
  assert.equal(emptyLines()[0].data.outcome, "notice");
});

test("Off, or an unknown length: the notice, whatever the length", async (t) => {
  const loaded = await load(t, azureSettings({ quietEmptyDictationSeconds: 0 }));
  answerAzureSpeech(t);
  const off = pipelineManager(loaded);
  await run(off.manager, { durationSeconds: 0.4 });
  assert.deepEqual(off.events.noAudio, [{ durationMs: 400, outcome: "notice" }]);
  assert.equal(off.events.failedSaves.length, 1);

  loaded.setSettings(azureSettings({ quietEmptyDictationSeconds: "nonsense" }));
  const unknown = pipelineManager(loaded);
  await run(unknown.manager, {});
  assert.deepEqual(unknown.events.noAudio, [{ durationMs: null, outcome: "notice" }]);
  assert.equal(emptyLines().at(-1).data.thresholdSeconds, 3, "an unknown setting reads as 3");
});

test("an OpenAI-compatible empty answer is silence too, and skips the local fallback", async (t) => {
  const loaded = await load(t, {
    useLocalWhisper: false,
    allowLocalFallback: true,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "groq",
    dataRetentionEnabled: true,
    audioRetentionDays: 30,
  });
  let localCalls = 0;
  loaded.window.electronAPI.transcribeLocalWhisper = async () => {
    localCalls += 1;
    return { success: true, text: "Thank you." };
  };
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ text: "  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  const { manager, events } = pipelineManager(loaded, {
    getEffectiveSttLanguage: () => "auto",
    getWhisperPrompt: () => null,
    getKeyterms: () => [],
    isDictionaryEcho: () => false,
  });

  const error = await rejection(manager.processWithOpenAIAPI(recording()));
  assert.equal(error.code, "EMPTY_TRANSCRIPT");
  assert.equal(localCalls, 0, "Whisper on silence invents words");

  await run(manager, { durationSeconds: 1.2 });
  assert.deepEqual(events.noAudio, [{ durationMs: 1200, outcome: "quiet" }]);
  assert.deepEqual(events.errors, []);
  assert.equal(localCalls, 0);
});

test("an HTTP error stays a failure card", async (t) => {
  const loaded = await load(t, azureSettings());
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ error: { code: "401" } }), { status: 401 })
  );
  const { manager, events } = pipelineManager(loaded, { getActiveRecordingStyle: () => null });
  await run(manager, { durationSeconds: 1.2 });
  assert.deepEqual(events.noAudio, []);
  assert.equal(events.errors.length, 1);
  assert.notEqual(events.errors[0].code, "EMPTY_TRANSCRIPT");
  assert.deepEqual(emptyLines(), []);
});

test("a proxied provider's empty answer carries the code", async (t) => {
  const loaded = await load(t, {
    useLocalWhisper: false,
    allowLocalFallback: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "mistral",
    cloudTranscriptionModel: "voxtral-mini-latest",
  });
  loaded.window.electronAPI.proxyMistralTranscription = async () => ({ text: "" });
  const { manager } = pipelineManager(loaded, {
    getEffectiveSttLanguage: () => "auto",
    getWhisperPrompt: () => null,
    getKeyterms: () => [],
  });
  const error = await rejection(manager.processWithOpenAIAPI(recording()));
  assert.equal(error.code, "EMPTY_TRANSCRIPT");
  assert.equal(error.message, "No text transcribed - Mistral response was empty");
});

test("the local engines' empty result carries the code and skips the cloud fallback", async (t) => {
  const loaded = await load(t, {
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    allowOpenAIFallback: true,
    cloudTranscriptionProvider: "openai",
  });
  loaded.window.electronAPI.transcribeLocalWhisper = async () => ({
    success: true,
    text: "hello",
  });
  let fallbacks = 0;
  const { manager } = pipelineManager(loaded, {
    getEffectiveSttLanguage: () => "en",
    getWhisperPrompt: () => null,
    getCustomDictionaryPrompt: () => null,
    processTranscription: async () => ({ text: null }),
    processWithOpenAIAPI: async () => {
      fallbacks += 1;
      return { success: true, text: "fallback" };
    },
  });

  const whisper = await rejection(manager.processWithLocalWhisper(recording(), "base", {}));
  assert.equal(whisper.code, "EMPTY_TRANSCRIPT");
  assert.equal(whisper.message, "No text transcribed");

  const parakeet = await rejection(
    manager.processWithLocalParakeet(recording(), "parakeet-tdt-0.6b-v3", { streamedText: "hi" })
  );
  assert.equal(parakeet.code, "EMPTY_TRANSCRIPT");
  assert.equal(fallbacks, 0);
});

const silentGate = () => ({
  peakRms: 0.00123456,
  peakAmplitude: 0.0098765,
  windowCount: 12,
  speechWindowCount: 0,
  consecutiveSpeechWindows: 0,
  maxConsecutiveSpeechWindows: 0,
});

test("the speech gate's skip goes through the same rule, with the gate's measurements", async (t) => {
  const loaded = await load(t, azureSettings());
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response("{}", { status: 200 });
  });

  const short = pipelineManager(loaded, { _localSpeechGateState: silentGate() });
  await run(short.manager, { durationSeconds: 1.2 });
  assert.equal(requests, 0, "no request");
  assert.deepEqual(short.events.completions, [
    { success: true, text: "", emptyDictation: { durationMs: 1200, outcome: "quiet" } },
  ]);
  assert.deepEqual(short.events.noAudio, []);
  assert.deepEqual(emptyLines().at(-1).data, {
    durationMs: 1200,
    thresholdSeconds: 3,
    outcome: "quiet",
    source: "gate",
    code: null,
    gateReason: "silence",
    peakRms: 0.0012,
    peakAmplitude: 0.0099,
    speechWindowCount: 0,
    maxConsecutiveSpeechWindows: 0,
  });

  const long = pipelineManager(loaded, { _localSpeechGateState: silentGate() });
  await run(long.manager, { durationSeconds: 6 });
  assert.deepEqual(long.events.completions[0].emptyDictation, {
    durationMs: 6000,
    outcome: "notice",
  });
});

test("a successful but empty result goes through the same rule", async (t) => {
  const loaded = await load(t, {
    ...azureSettings(),
    cloudTranscriptionMode: "openwhispr",
    isSignedIn: true,
    saveDiscardedTranscriptions: true,
  });
  const empty = async () => ({ success: true, text: "", source: "openai" });

  const short = pipelineManager(loaded, { processWithOpenWhisprCloud: empty });
  const blob = await run(short.manager, { durationSeconds: 1.4 });
  assert.equal(short.events.completions.length, 1);
  assert.deepEqual(short.events.completions[0].emptyDictation, {
    durationMs: 1400,
    outcome: "quiet",
  });
  assert.deepEqual(short.events.discardedSaves, [{ size: blob.size, durationSeconds: 1.4 }]);
  assert.equal(emptyLines().at(-1).data.source, "result");

  const long = pipelineManager(loaded, { processWithOpenWhisprCloud: empty });
  await run(long.manager, { durationSeconds: 3.5 });
  assert.equal(long.events.completions[0].emptyDictation.outcome, "notice");
  assert.deepEqual(long.events.discardedSaves, []);
});

test("a result with text never goes through it", async (t) => {
  const loaded = await load(t, {
    ...azureSettings(),
    cloudTranscriptionMode: "openwhispr",
    isSignedIn: true,
  });
  const { manager, events } = pipelineManager(loaded, {
    processWithOpenWhisprCloud: async () => ({ success: true, text: "Hi.", source: "openai" }),
  });
  await run(manager, { durationSeconds: 0.36 });
  assert.equal(events.completions[0].emptyDictation, undefined);
  assert.deepEqual(emptyLines(), []);
});
