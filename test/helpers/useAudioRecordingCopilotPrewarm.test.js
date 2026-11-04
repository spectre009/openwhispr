const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A recording's start asks the AudioManager to prewarm Copilot exactly once,
// with the recording's kind and style, and never waits for it: the prewarm
// below never settles, and the microphone still opens.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = { success: true };
    globalThis.__prewarmManager = this;
  }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  getState() { return { isRecording: false, isProcessing: false, isStreaming: false }; }
  isSttConfigStale() { return false; }
  setSttConfig() {}
  shouldUseStreaming() { return false; }
  prepareMicCapture() {}
  setVoiceAgentRequested() {}
  setAssistantSelectionContext() {}
  setTranslationRequested() {}
  setRecordingStyle() {}
  beginStepHistoryRun() { globalThis.__prewarmEvents.push("stepHistory"); }
  beginCopilotPrewarm(options) {
    globalThis.__prewarmEvents.push({ prewarm: { ...options } });
    return new Promise(() => {});
  }
  async startRecording() { globalThis.__prewarmEvents.push("startRecording"); return true; }
  cleanup() {}
}
`;

test("a recording start prewarms Copilot once, beside the step-history run, without waiting", async (t) => {
  let root = null;
  let start = null;
  let toggleTranslation = null;
  globalThis.__prewarmEvents = [];
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__prewarmManager;
    delete globalThis.__prewarmEvents;
  });

  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: (handler) => {
          toggleTranslation = handler;
          return () => {};
        },
        onStartDictation: (handler) => {
          start = handler;
          return () => {};
        },
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        captureDictationTarget: async () => {},
        completeDictationPreview: async () => {},
        hideDictationPreview: async () => {},
        dictationLifecycleStateChanged: () => {},
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-copilot-prewarm-hook-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  function Harness() {
    useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  const press = async (trigger) => {
    globalThis.__prewarmEvents = [];
    await React.act(async () => {
      trigger();
      // Two bounded visual-frame waits precede the mic open in the start path.
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    return globalThis.__prewarmEvents;
  };

  const dictation = await press(() => start({}));
  assert.deepEqual(dictation, [
    "stepHistory",
    { prewarm: { voiceAgentRequested: false, translationRequested: false, style: null } },
    "startRecording",
  ]);

  // A translation toggle starts a translation recording: the fake still reports idle.
  const translation = await press(() => toggleTranslation({}));
  const prewarms = translation.filter((event) => event.prewarm);
  assert.equal(prewarms.length, 1);
  assert.deepEqual(prewarms[0].prewarm, {
    voiceAgentRequested: false,
    translationRequested: true,
    style: null,
  });
  assert.ok(translation.includes("startRecording"));
});
