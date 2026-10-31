const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// Dictation through Azure Speech (MAI-Transcribe-2): the window converts the
// recording to WAV, builds the `definition` (the translation-aware locale, the
// dictionary as a phrase list) and parses the answer; main sends it with the
// deadline, retry and cancel (served here over a mocked fetch by the harness
// bridge, so main's endpoint check runs too). Synthetic audio and words only.

const ORIGIN = "https://res.cognitiveservices.azure.com";
const TRANSCRIBE_URL = `${ORIGIN}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`;

const baseSettings = (overrides = {}) => ({
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
  ...overrides,
});

async function loadManager(t, settings, overrides = {}, { decode } = {}) {
  const originalContext = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    decodeAudioData() {
      if (decode) return decode();
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
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-azure-speech-dictation-test-",
    settingsKey: "__azureSpeechDictationSettings",
    settings,
  });
  return {
    ...loaded,
    manager: loaded.createManager({
      isProcessing: true,
      _activeTranscriptionAbortController: null,
      translationRequested: false,
      processTranscription: async (text) => ({ text }),
      isReasoningAvailable: async () => false,
      ...overrides,
    }),
  };
}

function captureRequests(t, respond = () => ({ combinedPhrases: [{ text: "Heard." }] })) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: String(url), init });
    const answer = await respond(init);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return requests;
}

const recording = () => new Blob(["recording"], { type: "audio/webm" });
const definitionOf = (request) => JSON.parse(request.init.body.get("definition"));

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the dictation to fail");
}

test("language en, 205 dictionary entries: the key header, `audio` and the definition", async (t) => {
  const words = Array.from({ length: 205 }, (_, index) => `Term${index}`);
  const { manager } = await loadManager(t, baseSettings({ customDictionary: words }));
  const requests = captureRequests(t);

  const result = await manager.processWithOpenAIAPI(recording(), { durationSeconds: 3 });

  assert.equal(result.success, true);
  assert.equal(result.text, "Heard.");
  assert.equal(result.source, "azure-speech");
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, TRANSCRIBE_URL);
  assert.deepEqual(request.init.headers, { "Ocp-Apim-Subscription-Key": "az-key" });
  assert.deepEqual([...request.init.body.keys()], ["audio", "definition"]);
  const audio = request.init.body.get("audio");
  assert.equal(audio.type, "audio/wav", "WebM is converted: MAI takes WAV, MP3 or FLAC");
  assert.equal(audio.name, "audio.wav");
  assert.equal(await audio.slice(0, 4).text(), "RIFF");
  assert.deepEqual(definitionOf(request), {
    locales: ["en"],
    enhancedMode: { enabled: true, model: "MAI-Transcribe-2" },
    phraseList: { phrases: words.slice(0, 199) },
  });
  assert.equal(request.init.body.get("model"), null, "no OpenAI-style fields");
  assert.equal(request.init.body.get("prompt"), null);
});

// The field saves as typed until it's left, so a Foundry value can be stored
// unconverted: dictation still sends to the documented host, never services.ai.
for (const azureSpeechEndpoint of [
  "https://res.services.ai.azure.com",
  "https://res.services.ai.azure.com/api/projects/proj-1",
]) {
  test(`a stored, unconverted Foundry endpoint goes to the cognitiveservices host: ${azureSpeechEndpoint}`, async (t) => {
    const { manager } = await loadManager(t, baseSettings({ azureSpeechEndpoint }));
    const requests = captureRequests(t);
    const result = await manager.processWithOpenAIAPI(recording());
    assert.equal(result.success, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, TRANSCRIBE_URL);
    assert.deepEqual(requests[0].init.headers, { "Ocp-Apim-Subscription-Key": "az-key" });
  });
}

test("Auto with no dictionary: the model only", async (t) => {
  const { manager } = await loadManager(t, baseSettings({ preferredLanguage: "auto" }));
  const requests = captureRequests(t);
  await manager.processWithOpenAIAPI(recording());
  assert.deepEqual(definitionOf(requests[0]), {
    enhancedMode: { enabled: true, model: "MAI-Transcribe-2" },
  });
});

test("a translation dictation from Auto never sends the preferred language", async (t) => {
  const { manager } = await loadManager(
    t,
    baseSettings({
      preferredLanguage: "en",
      translationSourceLanguage: "auto",
      translationTargetLanguage: "de",
    }),
    { translationRequested: true }
  );
  const requests = captureRequests(t);
  await manager.processWithOpenAIAPI(recording());
  assert.deepEqual(definitionOf(requests[0]), {
    enhancedMode: { enabled: true, model: "MAI-Transcribe-2" },
  });
});

test("aliases and unlisted languages: Norwegian is nb, Welsh auto-detects", async (t) => {
  const { manager, setSettings } = await loadManager(t, baseSettings({ preferredLanguage: "no" }));
  const requests = captureRequests(t);
  await manager.processWithOpenAIAPI(recording());
  assert.deepEqual(definitionOf(requests[0]).locales, ["nb"]);
  setSettings(baseSettings({ preferredLanguage: "cy" }));
  await manager.processWithOpenAIAPI(recording());
  assert.equal("locales" in definitionOf(requests[1]), false);
});

test("a one-phrase dictionary whose dictation equals the phrase is kept", async (t) => {
  const { manager } = await loadManager(t, baseSettings({ customDictionary: ["OpenWhispr"] }));
  const requests = captureRequests(t, () => ({ combinedPhrases: [{ text: "OpenWhispr" }] }));
  const result = await manager.processWithOpenAIAPI(recording());
  assert.equal(result.text, "OpenWhispr", "a phrase list is a bias, not a prompt it echoes");
  assert.deepEqual(definitionOf(requests[0]).phraseList, { phrases: ["OpenWhispr"] });
});

test("an empty answer (silence) takes the same path as any provider's", async (t) => {
  const { manager } = await loadManager(t, baseSettings());
  captureRequests(t, () => ({ durationMilliseconds: 3000, combinedPhrases: [] }));
  const error = await rejection(manager.processWithOpenAIAPI(recording()));
  assert.match(error.message, /^No text transcribed/);
});

test("a recording that can't be converted fails, never uploading WebM", async (t) => {
  const { manager } = await loadManager(
    t,
    baseSettings(),
    {},
    {
      decode: () => Promise.reject(new Error("Unable to decode audio data")),
    }
  );
  const requests = captureRequests(t);
  const error = await rejection(manager.processWithOpenAIAPI(recording()));
  assert.equal(error.code, "AZURE_SPEECH_CONVERSION_FAILED");
  assert.equal(
    error.messageKey,
    "hooks.audioRecording.errorDescriptions.azureSpeechConversionFailed"
  );
  assert.equal(requests.length, 0);
});

test("over the cap after conversion: a worded error, nothing sent", async (t) => {
  const { manager, AudioManager } = await loadManager(t, baseSettings(), {
    resolveBatchRoute(...args) {
      const route = AudioManager.prototype.resolveBatchRoute.apply(this, args);
      return { ...route, sizeCapBytes: 10 };
    },
  });
  const requests = captureRequests(t);
  const error = await rejection(manager.processWithOpenAIAPI(recording()));
  assert.equal(error.code, "PROVIDER_PAYLOAD_TOO_LARGE");
  assert.equal(error.messageParams.provider, "Azure Speech");
  assert.equal(requests.length, 0);
});

test("a wrong endpoint's 404 reads as the endpoint, with Open Settings", async (t) => {
  const { manager } = await loadManager(t, baseSettings());
  captureRequests(
    t,
    () =>
      new Response(JSON.stringify({ error: { code: "404", message: "Resource not found" } }), {
        status: 404,
        headers: { "content-type": "application/json", "apim-request-id": "apim-1" },
      })
  );
  const error = await rejection(manager.processWithOpenAIAPI(recording()));
  assert.equal(error.code, "AZURE_SPEECH_ENDPOINT_INVALID");
  assert.equal(error.messageKey, "providerErrors.azureSpeech.endpointNotFound");
  assert.equal(error.settingsTarget, "speechToText");
  assert.equal(error.technicalDetails.requestId, "apim-1");
  assert.doesNotMatch(error.message, /MAI-Transcribe-2|Resource not found/);
});

test("without an endpoint the route fails closed; without a key, nothing is sent", async (t) => {
  const { manager, setSettings } = await loadManager(t, baseSettings({ azureSpeechEndpoint: "" }));
  const requests = captureRequests(t);
  const noEndpoint = await rejection(manager.processWithOpenAIAPI(recording()));
  assert.equal(noEndpoint.code, "AZURE_SPEECH_ENDPOINT_INVALID");
  assert.equal(
    noEndpoint.messageKey,
    "hooks.audioRecording.errorDescriptions.azureSpeechEndpointMissing"
  );
  assert.equal(noEndpoint.settingsTarget, "speechToText");

  setSettings(baseSettings({ azureSpeechApiKey: "" }));
  const noKey = await rejection(manager.processWithOpenAIAPI(recording()));
  assert.equal(noKey.code, "API_KEY_MISSING");
  assert.deepEqual(noKey.messageParams, { provider: "Azure Speech" });
  assert.equal(requests.length, 0);
});

test("Esc cancels the request in main: an AbortError, no card", async (t) => {
  const { manager } = await loadManager(t, baseSettings());
  let started;
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  captureRequests(t, (init) => {
    started();
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError"))
      )
    );
  });
  const pending = manager.processWithOpenAIAPI(recording());
  await requestStarted;
  assert.ok(manager._activeTranscriptionAbortController, "the request is cancellable");
  manager._activeTranscriptionAbortController.abort();
  const error = await rejection(pending);
  assert.equal(error.name, "AbortError");
  assert.equal(error.messageKey, undefined);
  assert.equal(manager._activeTranscriptionAbortController, null);
});
