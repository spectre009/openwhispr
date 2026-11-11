const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { deferred } = require("../helpers/harness/deferred");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// The agent window ends a short empty take quietly, so a take heard as
// nothing says how long it recorded; while it records it says since when (the
// pill's recording time).
test("an empty take reports how long it recorded, and its start while recording", async (t) => {
  let root;
  const originalRecorder = globalThis.MediaRecorder;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    if (originalRecorder === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = originalRecorder;
    delete globalThis.__voiceDraftEmptySettings;
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        saveTempAudio: async () => ({ path: "/tmp/voice.webm" }),
        deleteTempAudio: async () => {},
        transcribeAudioFile: async () => ({ success: true, text: "  " }),
      },
    },
  });
  const container = installHookDom(t);
  installMicCaptureGlobals(t);
  globalThis.MediaRecorder = class {
    start() {}
    stop() {
      this.ondataavailable({ data: new Blob(["voice"], { type: "audio/webm" }) });
      this.onstop();
    }
  };
  const settings = {
    isSignedIn: false,
    useLocalWhisper: true,
    whisperModel: "base",
    localTranscriptionProvider: "whisper",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionModel: "whisper-1",
    preferredLanguage: "en",
    transcriptionMode: "providers",
  };
  globalThis.__voiceDraftEmptySettings = settings;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-draft-empty-",
    mockModules: {
      "/hooks/useAuth": "export const useAuth = () => ({ isSignedIn: false });",
      "/hooks/useSettings":
        "export const useSettings = () => globalThis.__voiceDraftEmptySettings;",
      "/stores/settingsStore":
        "export const useSettingsStore = (selector) => selector(globalThis.__voiceDraftEmptySettings);",
      "./managedTranscription":
        "export const getManagedTranscriptionResolution = () => null; export const isManagedTranscriptionActive = () => false;",
      "/models/ModelRegistry":
        'export const getTranscriptionProviders = () => [{ id: "openai", baseUrl: "https://api.openai.com/v1" }];',
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { useVoiceDraft } = await vite.ssrLoadModule("/components/chat/useVoiceDraft.ts");
  let voice;
  const empty = deferred();
  function Harness() {
    voice = useVoiceDraft({
      onTranscript: () => empty.reject(new Error("a transcript")),
      onError: (message) => empty.reject(new Error(message)),
      onEmpty: (take) => empty.resolve(take),
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.equal(voice.startedAt, null);
  const before = Date.now();
  await React.act(async () => voice.start());
  assert.equal(voice.status, "recording");
  assert.ok(voice.startedAt >= before && voice.startedAt <= Date.now(), "since when it records");
  await new Promise((resolve) => setTimeout(resolve, 40));
  let take;
  await React.act(async () => {
    voice.stop();
    take = await empty.promise;
  });
  assert.ok(Number.isFinite(take.durationMs), "the length is known");
  assert.ok(take.durationMs >= 30 && take.durationMs < 5000, `recorded ${take.durationMs} ms`);
  assert.equal(voice.startedAt, null, "no start once the take ends");
});
