const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// useAudioRecording's side of two things: the error card's Retry re-sends a
// kept recording (one at a time, inert once its card is gone or replaced), and
// the global Esc is the owner's: held for processing only after 8 s, and a
// press then cancels that processing, never anything else.

const kept = Object.freeze({
  blob: { size: 2048, type: "audio/webm" },
  metadata: { durationSeconds: 4.6 },
  translationRequested: false,
  style: Object.freeze({ id: "teams", name: "Teams chat", emoji: "💬" }),
  rowId: Promise.resolve(41),
});

const timeoutError = (extra = {}) => ({
  title: "Transcription Error",
  description: "Transcription failed: OpenAI took too long to respond.",
  code: "PROVIDER_TIMEOUT",
  messageKey: "providerErrors.timeout",
  messageParams: { provider: "OpenAI" },
  surface: "transcription",
  ...extra,
});

async function mount(t, { mockTimers = false } = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__resendManager;
  });
  const toasts = [];
  const dismissed = [];
  const hotkeyCalls = [];
  let cancelProcessingPress = null;
  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onStopDictation: noopDispose,
        onCancelProcessingHotkeyPressed: (callback) => {
          cancelProcessingPress = callback;
          return () => {
            cancelProcessingPress = null;
          };
        },
        registerCancelHotkey: async (key, options) => {
          hotkeyCalls.push(`register:${key}:${options?.purpose}`);
          return { success: true };
        },
        unregisterCancelHotkey: async () => {
          hotkeyCalls.push("unregister");
          return { success: true };
        },
        hideDictationPreview: async () => {},
        completeDictationPreview: async () => {},
        dictationLifecycleStateChanged: async () => true,
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-resend-hook-",
    mockModules: {
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/utils/visualFrame": "export async function waitForVisualFrames() {}",
      "/helpers/audioManager": `export default class FakeAudioManager {
      constructor() { this.voiceAgentRequested=false; this.sttConfig={success:true}; this.starts=0; this.resends=[]; this.cancels=0; this.state={ isRecording:false, isProcessing:false }; globalThis.__resendManager=this; }
      setCallbacks(callbacks) { this.callbacks=callbacks; }
      getState() { return this.state; }
      shouldUseStreaming() { return false; }
      isSttConfigStale() { return false; }
      setVoiceAgentRequested(value) { this.voiceAgentRequested=value; }
      setAssistantSelectionContext() {}
      setTranslationRequested() {}
      async startRecording() { this.starts+=1; return true; }
      resendFailedRecording(recording) { this.resends.push(recording); return this.resendResult ?? Promise.resolve(true); }
      cancelProcessing() { this.cancels+=1; return true; }
      async saveTranscription() { return true; }
      cleanup() {}
    }`,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  useSettingsStore.setState({
    autoPasteEnabled: false,
    keepTranscriptionInClipboard: false,
    snippets: [],
    useLocalWhisper: true,
    pauseMediaOnDictation: false,
  });
  if (mockTimers) t.mock.timers.enable({ apis: ["setTimeout"] });
  let recording;
  const toast = (value) => toasts.push(value);
  const options = { dismissDictationError: () => dismissed.push(true) };
  function Harness() {
    recording = useAudioRecording(toast, options);
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const manager = globalThis.__resendManager;
  return {
    toasts,
    dismissed,
    hotkeyCalls,
    manager,
    recording: () => recording,
    pressEscForProcessing: () => cancelProcessingPress?.(),
    error: (error) => React.act(async () => manager.callbacks.onError(error)),
    state: (state) =>
      React.act(async () => {
        manager.state = state;
        manager.callbacks.onStateChange(state);
      }),
  };
}

test("Retry on a kept recording re-sends it once, dismissing its own card first", async (t) => {
  const h = await mount(t);
  await h.error(timeoutError({ keptRecording: kept }));
  const card = h.toasts.at(-1);
  assert.equal(card.presentation, "dictation-error");
  assert.equal(typeof card.onRemoved, "function");
  const retry = card.actions[0];
  assert.equal(retry.icon, "retry");

  await React.act(async () => retry.onClick());
  assert.deepEqual(h.manager.resends, [kept]);
  assert.equal(h.dismissed.length, 1);
  assert.equal(h.manager.starts, 0, "Retry re-sends rather than recording again");

  await React.act(async () => retry.onClick());
  assert.equal(h.manager.resends.length, 1, "the card is inert once its Retry ran");
  assert.equal(h.dismissed.length, 1);
});

test("a second click while the re-send is pending is ignored", async (t) => {
  const h = await mount(t);
  let finish;
  h.manager.resendResult = new Promise((resolve) => {
    finish = resolve;
  });
  await h.error(timeoutError({ keptRecording: kept }));
  const retry = h.toasts.at(-1).actions[0];
  let first;
  await React.act(async () => {
    first = retry.onClick();
  });
  await React.act(async () => retry.onClick());
  assert.equal(h.manager.resends.length, 1);
  finish(true);
  await React.act(async () => first);
});

test("a newer card makes the old Retry inert; one without a recording records again", async (t) => {
  const h = await mount(t);
  await h.error(timeoutError({ keptRecording: kept }));
  const old = h.toasts.at(-1);
  await h.error(
    timeoutError({ code: "PROVIDER_AUTH_FAILED", messageKey: "providerErrors.authFailed" })
  );
  const newer = h.toasts.at(-1);

  await React.act(async () => old.actions[0].onClick());
  assert.equal(h.manager.resends.length, 0);
  assert.equal(h.manager.starts, 0);

  await React.act(async () => newer.actions[0].onClick());
  assert.equal(h.manager.resends.length, 0);
  assert.equal(h.manager.starts, 1, "a failure Retry can't fix records again, as before");
});

test("the kept recording is released when its card goes", async (t) => {
  const h = await mount(t);
  await h.error(timeoutError({ keptRecording: kept }));
  const card = h.toasts.at(-1);
  card.onRemoved();
  await React.act(async () => card.actions[0].onClick());
  assert.equal(h.manager.resends.length, 0);
});

test("Retry waits for the pipeline: never while another dictation records or processes", async (t) => {
  const h = await mount(t);
  await h.error(timeoutError({ keptRecording: kept }));
  h.manager.state = { isRecording: false, isProcessing: true };
  await React.act(async () => h.toasts.at(-1).actions[0].onClick());
  assert.equal(h.manager.resends.length, 0);
  assert.equal(h.dismissed.length, 0, "the card stays for a later try");
});

test("Esc holds for processing only after 8 s, shows the hint, and cancels only then", async (t) => {
  const h = await mount(t, { mockTimers: true });
  await h.state({ isRecording: false, isProcessing: true });
  assert.deepEqual(h.hotkeyCalls, []);
  h.pressEscForProcessing();
  assert.equal(h.manager.cancels, 0, "a press Esc isn't held for does nothing");
  assert.equal(h.recording().slowProcessingHint, false);

  await React.act(async () => {
    t.mock.timers.tick(8000);
  });
  assert.deepEqual(h.hotkeyCalls, ["register:Escape:processing"]);
  assert.equal(h.recording().slowProcessingHint, true);

  h.pressEscForProcessing();
  assert.equal(h.manager.cancels, 1);

  await h.state({ isRecording: false, isProcessing: false });
  assert.deepEqual(h.hotkeyCalls, ["register:Escape:processing", "unregister"]);
  assert.equal(h.recording().slowProcessingHint, false);
  h.pressEscForProcessing();
  assert.equal(h.manager.cancels, 1, "released on settle");
});

test("a dictation that settles within 8 s never takes Esc from other apps", async (t) => {
  const h = await mount(t, { mockTimers: true });
  await h.state({ isRecording: false, isProcessing: true });
  await React.act(async () => {
    t.mock.timers.tick(7999);
  });
  await h.state({ isRecording: false, isProcessing: false });
  await React.act(async () => {
    t.mock.timers.tick(10_000);
  });
  assert.deepEqual(h.hotkeyCalls, []);
  assert.equal(h.recording().slowProcessingHint, false);
});
