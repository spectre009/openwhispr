const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// useAudioRecording's failure cards: every failure card stays until it is
// dismissed or the next dictation starts; Open Settings and Open in History
// leave it (and the recording it keeps for Retry) up; Open in History opens
// that dictation's own saved row; a card of an older dictation that settles
// after a newer one started never replaces the newer one's; and a cleanup
// failure rides on its dictation's paste-failure card, so both stay visible.

const kept = Object.freeze({
  blob: { size: 2048, type: "audio/webm" },
  metadata: { durationSeconds: 4.6 },
  translationRequested: false,
  style: null,
  rowId: Promise.resolve(41),
});

const authError = (extra = {}) => ({
  title: "Transcription Error",
  description: "Transcription failed: OpenAI rejected your API key.",
  code: "PROVIDER_AUTH_FAILED",
  messageKey: "providerErrors.authFailed",
  messageParams: { provider: "OpenAI" },
  surface: "transcription",
  settingsTarget: "speechToText",
  ...extra,
});

const cleanupFailure = Object.freeze({
  message: "Your GitHub Copilot account is out of credit.",
  surface: "llm",
  messageKey: "providerErrors.quotaExhausted",
  messageParams: { provider: "GitHub Copilot" },
  settingsTarget: "llms",
});

async function mount(t, extraOptions = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__cardsManager;
  });
  const toasts = [];
  const dismissed = [];
  const opened = [];
  const settings = [];
  const previewHides = [];
  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onStopDictation: noopDispose,
        hideDictationPreview: async () => {
          previewHides.push(true);
        },
        completeDictationPreview: async () => {},
        dictationLifecycleStateChanged: () => {},
        dictationDeliveryStateChanged: () => {},
        openHistoryItem: async (id) => {
          opened.push(id);
          return { opened: true, id };
        },
        openSettingsSection: async (section) => {
          settings.push(section);
          return { success: true };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-failure-cards-hook-",
    mockModules: {
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/utils/visualFrame": "export async function waitForVisualFrames() {}",
      "/helpers/audioManager": `export default class FakeAudioManager {
      constructor() { this.voiceAgentRequested=false; this.sttConfig={success:true}; this.starts=0; this.resends=[]; this.state={ isRecording:false, isProcessing:false }; this.pasteGate=null; this.pasteFailure=null; this.savedRowId=77; globalThis.__cardsManager=this; }
      setCallbacks(callbacks) { this.callbacks=callbacks; }
      getState() { return this.state; }
      shouldUseStreaming() { return false; }
      isSttConfigStale() { return false; }
      setVoiceAgentRequested(value) { this.voiceAgentRequested=value; }
      setAssistantSelectionContext() {}
      setTranslationRequested() {}
      async startRecording() { this.starts+=1; return true; }
      resendFailedRecording(recording) { this.resends.push(recording); return Promise.resolve(true); }
      async safePaste(text, options, { report } = {}) {
        if (this.pasteGate) await this.pasteGate;
        if (this.pasteFailure) { report(this.pasteFailure); return { pasted: false }; }
        return { pasted: true };
      }
      async saveTranscription(text, rawText, options) { options?.onRowSaved?.(this.savedRowId); return true; }
      cleanup() {}
    }`,
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useCleanupFailureStore } = await vite.ssrLoadModule("/stores/cleanupFailureStore.ts");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  useSettingsStore.setState({
    autoPasteEnabled: true,
    keepTranscriptionInClipboard: false,
    snippets: [],
    useLocalWhisper: true,
    pauseMediaOnDictation: false,
  });
  useCleanupFailureStore.setState({ pending: 0, lastMessage: "", lastFailure: null });
  let recording;
  const toast = (value) => toasts.push(value);
  const options = { dismissDictationError: () => dismissed.push(true), ...extraOptions };
  function Harness() {
    recording = useAudioRecording(toast, options);
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const manager = globalThis.__cardsManager;
  return {
    toasts,
    dismissed,
    opened,
    settings,
    previewHides,
    manager,
    useCleanupFailureStore,
    recording: () => recording,
    error: (error) => React.act(async () => manager.callbacks.onError(error)),
    complete: (result) =>
      React.act(async () =>
        manager.callbacks.onTranscriptionComplete({
          success: true,
          text: "Hello there.",
          rawText: "hello there",
          source: "local",
          ...result,
        })
      ),
  };
}

const action = (card, icon) => card.actions.find((candidate) => candidate.icon === icon);

test("a transcription failure card stays until dismissed: no timeout, a close button", async (t) => {
  const h = await mount(t);
  await h.error(authError({ keptRecording: kept, historyRowId: Promise.resolve(41) }));
  const card = h.toasts.at(-1);
  assert.equal(card.presentation, "dictation-error");
  assert.equal(card.duration, 0);
  assert.equal(card.dismissible, true);
  assert.equal(card.title, "Transcription failed");
  assert.equal(card.description, "OpenAI rejected your API key.");
});

test("an expired session's card stays too, as every failure's does", async (t) => {
  const h = await mount(t);
  await h.error({
    title: "Transcription Error",
    description: "Transcription failed: Session expired",
    code: "AUTH_EXPIRED",
  });
  assert.equal(h.toasts.at(-1).duration, 0);
});

test("Open Settings leaves the card and its kept recording, so Retry re-sends after the fix", async (t) => {
  const h = await mount(t);
  await h.error(authError({ keptRecording: kept, historyRowId: Promise.resolve(41) }));
  const card = h.toasts.at(-1);
  const settings = action(card, "settings");
  assert.equal(settings.dismissOnClick, false);
  await React.act(async () => settings.onClick());
  assert.deepEqual(h.settings, ["speechToText"]);
  // Back to the card after fixing the key: Retry re-sends the same recording.
  await React.act(async () => card.actions[0].onClick());
  assert.deepEqual(h.manager.resends, [kept]);
  assert.equal(h.manager.starts, 0);
});

test("Open in History opens the failed dictation's own row and leaves the card up", async (t) => {
  const h = await mount(t);
  let resolveRow;
  const rowId = new Promise((resolve) => {
    resolveRow = resolve;
  });
  await h.error(authError({ keptRecording: kept, historyRowId: rowId }));
  const open = action(h.toasts.at(-1), "history");
  assert.equal(open.label, "Open in History");
  assert.equal(open.dismissOnClick, false);
  const click = React.act(async () => open.onClick());
  resolveRow(41);
  await click;
  assert.deepEqual(h.opened, [41]);
  assert.equal(h.dismissed.length, 0);
});

test("no audio stays a short notice", async (t) => {
  const h = await mount(t);
  await React.act(async () => h.manager.callbacks.onNoAudio());
  const card = h.toasts.at(-1);
  assert.equal(card.duration, undefined);
  assert.equal(card.dismissible, undefined);
});

// "End empty dictations quietly": the audio manager says how an empty
// dictation ends (emptyDictation.js); the window shows it.
async function mountEmpty(t) {
  const quiet = [];
  const demo = [];
  const h = await mount(t, {
    onQuietEmptyDictation: (detail) => quiet.push(detail),
    onDemoEvent: (event) => demo.push(event),
  });
  return { ...h, quiet, demo };
}

test("a short empty dictation ends quietly: no card, the pill's spin-down", async (t) => {
  const h = await mountEmpty(t);
  assert.equal(h.recording().nothingHeardSeq, 0);
  await React.act(async () =>
    h.manager.callbacks.onNoAudio({ durationMs: 1538, outcome: "quiet" })
  );
  assert.deepEqual(h.toasts, [], "no card, no toast");
  assert.equal(h.recording().nothingHeardSeq, 1, "the pill plays its spin-down");
  assert.deepEqual(h.quiet, [{ recoverAssistant: false }]);
  assert.equal(h.previewHides.length, 1, "the preview hides");
  assert.deepEqual(
    h.demo.filter((event) => event.status === "error").map((event) => event.message),
    ["We didn’t catch that"],
    "the onboarding demo hears it as before"
  );
});

test("a longer empty dictation says \u201cWe didn\u2019t catch that\u201d for a moment", async (t) => {
  const h = await mountEmpty(t);
  await React.act(async () =>
    h.manager.callbacks.onNoAudio({ durationMs: 4600, outcome: "notice" })
  );
  const card = h.toasts.at(-1);
  assert.equal(card.title, "We didn’t catch that");
  assert.equal(card.description, "Check your microphone and try again.");
  assert.equal(card.presentation, "dictation-error");
  assert.equal(card.duration, undefined, "transient, never the persistent card");
  assert.equal(card.dismissible, undefined);
  assert.equal(h.recording().nothingHeardSeq, 0);
  assert.deepEqual(h.quiet, []);
  assert.equal(h.demo.filter((event) => event.status === "error").length, 1);
});

test("an empty result ends the same way, by what the audio manager decided", async (t) => {
  const h = await mountEmpty(t);
  await h.complete({
    text: "",
    rawText: "",
    emptyDictation: { durationMs: 1200, outcome: "quiet" },
  });
  assert.deepEqual(h.toasts, []);
  assert.equal(h.recording().nothingHeardSeq, 1);
  assert.equal(h.previewHides.length, 1);

  await h.complete({
    text: " ",
    rawText: "",
    emptyDictation: { durationMs: 6000, outcome: "notice" },
  });
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].title, "We didn’t catch that");
  assert.equal(h.recording().nothingHeardSeq, 1);

  // Without the manager's say (an unknown length), the notice.
  await h.complete({ text: "", rawText: "" });
  assert.equal(h.toasts.length, 2);
});

test("a quiet voice command tells the assistant panel its thinking is over", async (t) => {
  const h = await mountEmpty(t);
  h.manager.voiceAgentRequested = true;
  await React.act(async () => h.manager.callbacks.onNoAudio({ durationMs: 900, outcome: "quiet" }));
  assert.deepEqual(h.quiet, [{ recoverAssistant: true }]);
  assert.deepEqual(h.toasts, []);
});

test("a cleanup failure rides on its dictation's paste-failure card, so both show", async (t) => {
  const h = await mount(t);
  h.manager.pasteFailure = {
    title: "Paste Error",
    code: "PASTE_FAILED",
    description: "Couldn't paste into this app.",
  };
  await h.complete({ cleanupFailure });
  const card = h.toasts.at(-1);
  assert.equal(card.title, "Couldn't paste automatically");
  assert.match(card.description, /Couldn't paste into this app\./);
  assert.match(
    card.description,
    /AI cleanup also failed: Your GitHub Copilot account is out of credit\./
  );
  assert.equal(card.duration, 0);
  assert.ok(action(card, "settings"), "the cleanup failure's Open Settings");
  const open = action(card, "history");
  assert.ok(open, "Open in History");
  await React.act(async () => open.onClick());
  assert.deepEqual(h.opened, [77], "the row this dictation was saved to");
  assert.equal(h.useCleanupFailureStore.getState().pending, 0, "no second card replaces it");
});

test("a cleanup failure after a paste that landed goes to the cleanup card with its own row", async (t) => {
  const h = await mount(t);
  await h.complete({ cleanupFailure });
  const { pending, lastFailure } = h.useCleanupFailureStore.getState();
  assert.equal(pending, 1);
  assert.equal(lastFailure.dictation.isCurrent(), true);
  assert.equal(await lastFailure.dictation.rowId, 77);
});

test("a late card of an older dictation never replaces the newer dictation's", async (t) => {
  const h = await mount(t);
  let releasePaste;
  h.manager.pasteGate = new Promise((resolve) => {
    releasePaste = resolve;
  });
  h.manager.pasteFailure = { title: "Paste Error", code: "PASTE_FAILED", description: "x" };
  let first;
  await React.act(async () => {
    first = h.manager.callbacks.onTranscriptionComplete({
      success: true,
      text: "Hello there.",
      rawText: "hello there",
      source: "local",
      cleanupFailure,
    });
  });
  // The next dictation starts while the old paste is still waiting.
  await React.act(async () => h.recording().startRecording());
  assert.equal(h.manager.starts, 1);
  const shownBefore = h.toasts.length;
  releasePaste();
  await React.act(async () => first);
  assert.equal(h.toasts.length, shownBefore, "the old paste failure stays off the pill");
  assert.equal(h.useCleanupFailureStore.getState().pending, 0, "and so does its cleanup card");

  // A cleanup card recorded before the next dictation started is dropped by
  // the listener once that dictation is no longer the newest.
  h.manager.pasteGate = null;
  h.manager.pasteFailure = null;
  await h.complete({ cleanupFailure });
  const { lastFailure } = h.useCleanupFailureStore.getState();
  assert.equal(lastFailure.dictation.isCurrent(), true);
  await React.act(async () => h.recording().startRecording());
  assert.equal(lastFailure.dictation.isCurrent(), false);
});
