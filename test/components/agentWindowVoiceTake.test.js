const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

// The agent window's own voice take, mounted for real with its chat and voice
// hooks stood in for (as in agentWindowCards.test.js). It replaced the
// dictation window's assistant panel, which these behaviours belonged to:
// - a short take that heard nothing ends quietly (Settings › Dictation ›
//   Recognition › "End empty dictations quietly"), the pill back to idle;
// - the take's pill takes the floating icon's recording look, in the
//   assistant's color when "Color by mode" is on.
const MOCKS = {
  // As in agentWindowCards: the real one loads the reasoning stack, whose
  // timers would keep the test process alive after the last test.
  "/services/editSelectedText": `
    export async function editSelectedText() { return null; }
  `,
  "/useAgentChat": `
    export function useAgentChat() {
      return {
        messages: [], busy: false, conversationId: 1, forkOrigin: null, agentState: "idle",
        send: async () => true, cancel() {}, switchChat: async () => true, newChat() {},
        fork: async () => null, regenerate() {},
      };
    }
  `,
  "/useAgentVoice": `
    import { useSyncExternalStore } from "react";
    const listeners = new Set();
    let status = "idle";
    globalThis.__voice = {
      startedAt: null,
      set(next) { status = next; listeners.forEach((listener) => listener()); },
    };
    export function useAgentVoice(options) {
      globalThis.__voice.callbacks = options;
      const current = useSyncExternalStore(
        (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        () => status
      );
      return {
        status: current, opening: false, startedAt: globalThis.__voice.startedAt,
        readLevel: () => 0, streamingOnlyProvider: false,
        start: async () => "started", stop() {}, cancel() {},
      };
    }
  `,
  "/useReadAloud": `
    export function useReadAloud() {
      return { available: false, speakingId: null, toggle() {}, stop() {} };
    }
  `,
  "/lib/accountScopeMirror": `export function mirrorActiveAccountScope() { return () => {}; }`,
  "/notes/AssistantNoteUndoListener": `export default function Listener() { return null; }`,
};

async function mountWindow(t, settings = {}) {
  let root = null;
  t.after(() => root && React.act(async () => root.unmount()));
  const happyWindow = await installHappyDom(t);
  const main = { layouts: [], handlers: {} };
  const on = (name) => (callback) => {
    main.handlers[name] = callback;
    return () => {};
  };
  happyWindow.electronAPI = {
    agentWindowReady() {},
    agentWindowSetLayout: async (request) => {
      main.layouts.push(request);
      return true;
    },
    agentWindowHide: async () => true,
    agentWindowSetVoiceState: async () => true,
    captureSelectedText: async () => null,
    onAgentWindowHotkey: on("hotkey"),
    onAgentWindowOpen: on("open"),
    onAgentWindowCommand: on("command"),
    onAgentWindowDismiss: on("dismiss"),
    onCancelHotkeyPressed: on("cancel"),
  };
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-agent-window-voice-take-",
    mockModules: MOCKS,
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState(settings);
  const { default: AgentWindow } = await vite.ssrLoadModule("/components/agent/AgentWindow.tsx");
  const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  const { createRoot } = require("react-dom/client");
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  root = createRoot(host);
  await React.act(async () =>
    root.render(
      React.createElement(
        SettingsProvider,
        null,
        React.createElement(ToastProvider, null, React.createElement(AgentWindow))
      )
    )
  );
  const wait = (ms) => React.act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const settle = async () => {
    await wait(300);
    await wait(300);
  };
  // A spoken request: the hotkey opens the pill, the take records, then ends.
  const takeThatHeardNothing = async (durationMs) => {
    await React.act(async () => main.handlers.hotkey({ external: false }));
    await settle();
    await React.act(async () => globalThis.__voice.set("recording"));
    await React.act(async () => globalThis.__voice.set("transcribing"));
    await React.act(async () => globalThis.__voice.set("idle"));
    await React.act(async () => globalThis.__voice.callbacks.onEmpty({ durationMs }));
    await settle();
  };
  return { vite, host, main, settle, takeThatHeardNothing, happyWindow };
}

const NOTHING_HEARD = "Didn't catch that";

test("a short take that heard nothing ends quietly: no notice, the pill back to idle", async (t) => {
  const view = await mountWindow(t);
  view.happyWindow.localStorage.setItem("quietEmptyDictationSeconds", "3");
  await view.takeThatHeardNothing(900);
  assert.doesNotMatch(view.host.textContent, new RegExp(NOTHING_HEARD));
  assert.equal(view.main.layouts.at(-1)?.wide ?? false, false, "no wider window for a notice");
  assert.ok(view.host.querySelector('button[aria-label="Type instead"], button'), "pill controls");
});

// One window per test: each mount installs its own DOM and renderer.
test("a take at the threshold still says it heard nothing", async (t) => {
  const view = await mountWindow(t);
  view.happyWindow.localStorage.setItem("quietEmptyDictationSeconds", "3");
  await view.takeThatHeardNothing(3000);
  assert.match(view.host.textContent, new RegExp(NOTHING_HEARD));
});

test("with quiet ends off, a short take still says it heard nothing", async (t) => {
  const view = await mountWindow(t);
  view.happyWindow.localStorage.setItem("quietEmptyDictationSeconds", "0");
  await view.takeThatHeardNothing(400);
  assert.match(view.host.textContent, new RegExp(NOTHING_HEARD));
});

test("a take of unknown length still says it heard nothing", async (t) => {
  const view = await mountWindow(t);
  view.happyWindow.localStorage.setItem("quietEmptyDictationSeconds", "3");
  await view.takeThatHeardNothing(null);
  assert.match(view.host.textContent, new RegExp(NOTHING_HEARD));
});

test("the take's pill takes the recording look in the assistant's color", async (t) => {
  globalThis.__voice = { ...(globalThis.__voice || {}), startedAt: null };
  const view = await mountWindow(t, {
    recordingIndicatorStyle: "rec",
    recordingIndicatorColor: "red",
    recordingColorByMode: true,
    recordingAssistantColor: "purple",
  });
  const { resolveRecordingAccent } = await import("../../src/helpers/recordingIndicator.js");
  await React.act(async () => view.main.handlers.hotkey({ external: false }));
  await view.settle();
  globalThis.__voice.startedAt = Date.now() - 12_000;
  await React.act(async () => globalThis.__voice.set("recording"));
  await view.settle();
  const pill = view.host.querySelector(".agent-pill");
  assert.ok(pill, "the pill shows");
  assert.equal(pill.getAttribute("data-recording-style"), "rec");
  assert.match(
    pill.getAttribute("style") ?? "",
    new RegExp(resolveRecordingAccent("purple").replace("#", "#?"), "i"),
    "the assistant's color, not the dictation color"
  );
  assert.ok(view.host.querySelector(".agent-pill-rec-dot"));
  assert.match(view.host.querySelector(".agent-pill-elapsed")?.textContent ?? "", /^0:1[23]$/);
  assert.equal(view.main.layouts.at(-1)?.wide, true, "the time needs the wider window");

  await React.act(async () => globalThis.__voice.set("idle"));
  await view.settle();
  assert.equal(view.host.querySelector(".agent-pill")?.getAttribute("data-recording-style"), null);
});
