const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// File uploads on Azure Speech: the upload screen's own settings carry the key
// and the endpoint, whether Azure Speech was picked for File Transcription or
// inherited from Recognition, and the renderer's pre-flight fails closed
// without an endpoint. Main's branch is covered in retryTranscriptionHandler.

const ORIGIN = "https://res.cognitiveservices.azure.com";

function azureConfig(overrides = {}) {
  return {
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    parakeetModel: "",
    cohereModel: "",
    isOpenWhisprCloud: false,
    getApiKey: () => "az-key",
    cloudTranscriptionProvider: "azure-speech",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionModel: "MAI-Transcribe-2",
    language: "en",
    transcriptionMode: "providers",
    azureSpeechEndpoint: ORIGIN,
    ...overrides,
  };
}

test("uploads on Azure Speech: the key and endpoint reach main; no endpoint, no request", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-azure-speech-test-",
    mockModules: { "/lib/auth": "export const withSessionRefresh = (fn) => fn();" },
  });
  const { transcribeFile, getTranscriptionApiKey } = await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  );

  const calls = [];
  window.electronAPI.transcribeAudioFileByok = async (options) => {
    calls.push(options);
    return { success: true, text: "heard" };
  };

  for (const azureSpeechEndpoint of ["", "https://res.openai.azure.com", `${ORIGIN}/x`]) {
    const result = await transcribeFile("/tmp/a.m4a", azureConfig({ azureSpeechEndpoint }), false);
    assert.equal(result.success, false, azureSpeechEndpoint);
    assert.equal(result.code, "AZURE_SPEECH_ENDPOINT_INVALID", azureSpeechEndpoint);
    assert.equal(
      result.messageKey,
      "hooks.audioRecording.errorDescriptions.azureSpeechEndpointMissing"
    );
  }
  assert.equal(calls.length, 0, "fails closed before IPC");

  const result = await transcribeFile("/tmp/a.m4a", azureConfig(), false);
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "azure-speech");
  assert.equal(calls[0].apiKey, "az-key");
  assert.equal(calls[0].azureSpeechEndpoint, ORIGIN);
  assert.equal(calls[0].model, "MAI-Transcribe-2");

  assert.equal(getTranscriptionApiKey("azure-speech", { azureSpeechApiKey: "k" }), "k");
  assert.equal(getTranscriptionApiKey("azure-speech", {}), "");
});

test("File Transcription inherits Azure Speech from Recognition, with its model", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-azure-speech-inherit-test-",
  });
  const { useSettingsStore, selectResolvedUploadTranscription } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const { resolveFileTranscriptionRoute } = await vite.ssrLoadModule(
    "/services/fileTranscription.ts"
  );
  const state = {
    ...useSettingsStore.getState(),
    cloudTranscriptionProvider: "azure-speech",
    cloudTranscriptionModel: "MAI-Transcribe-2",
    uploadCloudTranscriptionProvider: "",
    uploadCloudTranscriptionModel: "",
    azureSpeechEndpoint: ORIGIN,
  };
  const upload = selectResolvedUploadTranscription(state);
  assert.equal(upload.cloudTranscriptionProvider, "azure-speech");
  assert.equal(upload.cloudTranscriptionModel, "MAI-Transcribe-2");

  // What UploadAudioView builds from it (plus the connection's endpoint) routes to Azure Speech.
  const route = resolveFileTranscriptionRoute(
    azureConfig({ ...upload, azureSpeechEndpoint: state.azureSpeechEndpoint })
  );
  assert.equal(route.transport, "azure-speech");
  assert.equal(route.sizeCapBytes, 250 * 1024 * 1024);
});

// The key's secret plumbing (hydration, refresh, saving through main) comes
// from BYOK_API_KEYS and is covered for every entry by settingsStoreApiKeyUpdates.
test("the store keeps the endpoint as a plain setting", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-store-azure-speech-test-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { BYOK_API_KEYS } = require("../../src/config/secretKeys");

  useSettingsStore.getState().setAzureSpeechEndpoint(ORIGIN);
  assert.equal(useSettingsStore.getState().azureSpeechEndpoint, ORIGIN);
  assert.equal(window.localStorage.getItem("azureSpeechEndpoint"), ORIGIN);
  assert.equal(useSettingsStore.getState().azureSpeechApiKey, "", "secrets hydrate from main");
  assert.deepEqual(
    BYOK_API_KEYS.find((entry) => entry.base === "azure-speech"),
    {
      base: "azure-speech",
      env: "AZURE_SPEECH_API_KEY",
      get: "getAzureSpeechKey",
      save: "saveAzureSpeechKey",
      storeKey: "azureSpeechApiKey",
    }
  );
});
