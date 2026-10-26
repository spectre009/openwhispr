const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// processWithOpenAIAPI classifies BYOK transcription failures from the throw
// shapes production sees: main's classified reply for the request it sends
// (dictationTranscriptionRequest.js, served here over the mocked fetch by the
// harness bridge), and the { error } fields main serialises for proxied ones.
async function loadManager(t, settings, window = {}) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-provider-errors-test-",
    settingsKey: "__providerErrorsSettings",
    settings: { useLocalWhisper: false, allowLocalFallback: false, ...settings },
  });
  Object.assign(loaded.window.electronAPI, window);
  return loaded.createManager({
    isProcessing: true,
    _activeTranscriptionAbortController: null,
    getEffectiveSttLanguage: () => "auto",
    getAPIKey: async () => "test-key",
    getWhisperPrompt: () => null,
    getKeyterms: () => [],
    isDictionaryEcho: () => false,
    processTranscription: async (text) => ({ text }),
    isReasoningAvailable: async () => false,
  });
}

const selfHostedSettings = {
  cloudTranscriptionMode: "byok",
  // Self-hosted dictation leaves the provider setting at its default.
  cloudTranscriptionProvider: "openai",
  transcriptionMode: "self-hosted",
  remoteTranscriptionUrl: "https://stt.example.com/v1",
  remoteTranscriptionModel: "whisper-large-v3",
};

const recording = () => new Blob(["recording"], { type: "audio/webm" });

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected processWithOpenAIAPI to reject");
}

test("a self-hosted 404 blames the user's server, not OpenAI", async (t) => {
  const manager = await loadManager(t, selfHostedSettings);
  t.mock.method(globalThis, "fetch", async () => new Response("Not Found", { status: 404 }));

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_ERROR");
  assert.equal(error.messageKey, "providerErrors.selfHosted.unknown");
  assert.equal(error.message, "Your server returned an unexpected error.");
  assert.doesNotMatch(error.message, /OpenAI/);
});

test("main's network failure for a direct provider names that provider", async (t) => {
  const manager = await loadManager(t, { cloudTranscriptionProvider: "groq" });
  // What Electron's net.fetch rejects with: a plain Error naming the net error.
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("net::ERR_INTERNET_DISCONNECTED");
  });

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_UNREACHABLE");
  assert.equal(error.messageKey, "providerErrors.unreachable");
  assert.equal(error.messageParams.provider, "Groq");
  assert.equal(error.surface, "transcription");
});

test("a cancelled request stays an AbortError, with no card fields", async (t) => {
  const manager = await loadManager(t, { cloudTranscriptionProvider: "openai" });
  let requestSignal;
  t.mock.method(
    globalThis,
    "fetch",
    (_url, init) =>
      new Promise((_resolve, reject) => {
        requestSignal = init.signal;
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        );
        // The cancel the pill (or Esc) sends while the request waits in main.
        setImmediate(() => manager._activeTranscriptionAbortController.abort());
      })
  );

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(requestSignal.aborted, true, "the cancel reaches the request in main");
  assert.equal(error.name, "AbortError");
  assert.equal(error.code, 20);
  assert.equal(error.messageKey, undefined);
});

test("a proxied provider's net::ERR_* failure is classified with its display name", async (t) => {
  const manager = await loadManager(
    t,
    { cloudTranscriptionProvider: "mistral", cloudTranscriptionModel: "voxtral-mini-latest" },
    // What serializeIpcError returns for an unclassified net.fetch rejection.
    { proxyMistralTranscription: async () => ({ error: "net::ERR_INTERNET_DISCONNECTED" }) }
  );

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_UNREACHABLE");
  assert.equal(error.messageParams.provider, "Mistral");
  assert.equal(error.message, "Couldn't reach Mistral. Check your connection.");
});

test("a proxied provider's already-classified failure passes through unchanged", async (t) => {
  const manager = await loadManager(
    t,
    { cloudTranscriptionProvider: "mistral", cloudTranscriptionModel: "voxtral-mini-latest" },
    {
      proxyMistralTranscription: async () => ({
        error: "Mistral rejected your API key.",
        code: "PROVIDER_AUTH_FAILED",
        messageKey: "providerErrors.authFailed",
        messageParams: { provider: "Mistral" },
        settingsTarget: "speechToText",
        status: 401,
        surface: "transcription",
      }),
    }
  );

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_AUTH_FAILED");
  assert.equal(error.status, 401);
  assert.equal(error.settingsTarget, "speechToText");
});
