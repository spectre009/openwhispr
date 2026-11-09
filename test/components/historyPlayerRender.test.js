const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// The History player rendered (happy-dom, stubbed preload, a stand-in Audio):
// the audio read only on the first Play or Ctrl+Space, ±5 s and the seek bar
// (keys and pointer) clamped to the recording, "back 2 s on resume" only
// after a pause, speed cycled and kept, the keys anywhere in the History view
// (the correction and note included) but never while composing, under a
// dialog, in the list or with other modifiers, "From your cursor" and the
// edit marks placed through matched words only, the media keys, and the
// object URL released with the row. Dictated text never reaches the console.

const STT = "so the auto recovery works. the user closed it, you know. then it was lost";
const FINAL = "So the auto recovery works. The user closed it. Then it was lost.";
const CORRECTION = "So the auto recovery works. The user closed the file. Then it was lost.";
const DICTATED = [STT, FINAL, CORRECTION];

const listRow = (id, extra = {}) => ({
  id,
  timestamp: `2026-10-24 1${id % 10}:00:00`,
  status: "completed",
  errorCode: null,
  preview: FINAL,
  hasAudio: true,
  audioDurationMs: 74000,
  routeKind: null,
  app: null,
  marks: null,
  rating: null,
  ...extra,
});
const ROWS = [
  listRow(703),
  listRow(702, { audioDurationMs: null }),
  listRow(701, { hasAudio: false, audioDurationMs: null }),
];
const step = (kind, output) => ({
  kind,
  outcome: "ok",
  output,
  provider: null,
  model: null,
  ms: 10,
  errorCode: null,
  prompt: null,
  detail: null,
});
const item = (row) => ({
  success: true,
  item: {
    id: row.id,
    timestamp: "2026-10-24 12:00:00",
    status: "completed",
    text: FINAL,
    rawText: STT,
    errorCode: null,
    errorMessage: null,
    hasAudio: row.hasAudio,
    audioDurationMs: row.audioDurationMs,
    routeKind: null,
    provider: null,
    model: null,
  },
  status: "captured",
  route: "cleanup",
  context: { targetApp: "Code.exe" },
  steps: [step("stt", STT), step("cleanup", FINAL)],
  revision: `rev-${row.id}`,
  owner: "owner-a",
  feedback: null,
  dictionary: [],
  dictionaryAligned: true,
});

// The recording: currentTime moves only when the test moves it.
const audios = [];
class FakeAudio {
  constructor(src) {
    this.src = src;
    this.paused = true;
    this.currentTime = 0;
    this.duration = Number.POSITIVE_INFINITY;
    this.playbackRate = 1;
    this.handlers = {};
    audios.push(this);
  }
  addEventListener(name, handler) {
    (this.handlers[name] ??= []).push(handler);
  }
  emit(name) {
    for (const handler of this.handlers[name] ?? []) handler();
  }
  async play() {
    this.paused = false;
    this.emit("play");
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }
  removeAttribute() {
    this.src = "";
  }
  load() {}
}

let dom;
let lateAudio = false;
const updated = [];
const created = [];
const revoked = [];
const mediaHandlers = {};
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      listHistory: async ({ cursor }) => ({
        success: true,
        rows: cursor ? [] : ROWS,
        nextCursor: null,
      }),
      getHistoryApps: async () => ({ success: true, apps: [] }),
      getHistoryItem: async (id) => {
        // 704: a new dictation, its audio saved just after its row.
        if (id === 704) {
          return item(
            listRow(704, { hasAudio: lateAudio, audioDurationMs: lateAudio ? 74000 : null })
          );
        }
        const row = ROWS.find((candidate) => candidate.id === id);
        return row ? item(row) : { success: false, code: "NOT_FOUND" };
      },
      onTranscriptionUpdated: (callback) => {
        updated.push(callback);
        return () => updated.splice(updated.indexOf(callback), 1);
      },
      getAudioBuffer: async () => new ArrayBuffer(8),
      hideControlPanel: async () => undefined,
    },
  });
  // A 900 px view (the stacked layout); the player is the same in both.
  const proto = dom.window.HTMLElement.prototype;
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => 900 });
  proto.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 900,
    bottom: 800,
    width: 900,
    height: 800,
    toJSON() {},
  });
  proto.scrollTo = () => {};
  proto.scrollIntoView = () => {};
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.hasPointerCapture = () => false;
  Object.defineProperty(dom.window.navigator, "mediaSession", {
    configurable: true,
    value: {
      setActionHandler: (name, handler) => {
        mediaHandlers[name] = handler;
      },
    },
  });
  globalThis.Audio = FakeAudio;
  URL.createObjectURL = () => {
    created.push(`blob:audio-${created.length}`);
    return created.at(-1);
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
});

test.after(async () => {
  delete globalThis.Audio;
  await dom.close();
});

const calls = (name) => dom.calls.filter(([called]) => called === name).map(([, args]) => args);

async function mountHistory(t) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const consoleOutput = captureConsole(t);
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const h = React.createElement;
  const vite = await createRendererServer(t, {
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "/stores/promptTestSetStore": `
        export async function pinHistoryTestCase() { return { success: true, durable: true }; }
        export const storageNoticeKey = () => "promptStudio.testSet.storage.unavailable";
      `,
    },
  });
  await vite.ssrLoadModule("/i18n.ts");
  const { default: HistoryBrowser } = await vite.ssrLoadModule(
    "/components/history/HistoryBrowser.tsx"
  );
  const store = await vite.ssrLoadModule("/components/history/historyViewStore.ts");
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ dataRetentionEnabled: true });

  const doc = dom.window.document;
  const win = dom.window;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await React.act(async () => root.unmount());
    host.remove();
  };
  t.after(unmount);
  const act = async (fn, ms = 30) => {
    await React.act(async () => {
      await fn();
      await settle(ms);
    });
    await settle();
  };
  const v = {
    doc,
    win,
    act,
    store,
    unmount,
    consoleOutput,
    key: async (init, target = doc.body, patch = {}) => {
      const event = new win.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      // As Chromium: AltGr is its own modifier (happy-dom reports it with any Alt).
      const modifier = event.getModifierState.bind(event);
      Object.defineProperty(event, "getModifierState", {
        configurable: true,
        value: (name) => (name === "AltGraph" ? false : modifier(name)),
      });
      for (const [name, value] of Object.entries(patch)) {
        Object.defineProperty(event, name, { value });
      }
      await act(() => target.dispatchEvent(event));
      return event;
    },
    ctrlSpace: (target, extra = {}) =>
      v.key({ key: " ", code: "Space", ctrlKey: true, ...extra }, target),
    alt: (key, target, extra = {}) => v.key({ key, altKey: true, ...extra }, target),
    setValue: (field, value) => {
      const proto =
        field.tagName === "TEXTAREA"
          ? win.HTMLTextAreaElement.prototype
          : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(field, value);
      field.dispatchEvent(new win.Event("input", { bubbles: true }));
    },
    pointer: (type, target, clientX) =>
      act(() =>
        target.dispatchEvent(
          new win.PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            clientX,
          })
        )
      ),
    playButton: () =>
      doc.querySelector(
        '[data-history-player] button[aria-label="Play the recording"], [data-history-player] button[aria-label="Pause"]'
      ),
    button: (text) =>
      [...doc.querySelectorAll("button")].find((candidate) =>
        candidate.textContent.trim().startsWith(text)
      ),
    slider: () => doc.querySelector('[role="slider"]'),
    speed: () => doc.querySelector("[data-history-rate]"),
    textarea: () => doc.querySelector("#history-review-expected"),
    note: () => doc.querySelector('[data-review-form] input[aria-label="Note"]'),
    listbox: () => doc.querySelector('[role="listbox"]'),
    selected: () => doc.querySelector('[role="option"][aria-selected="true"]'),
    audio: () => audios.at(-1),
    // Lets the player's frame loop read the stand-in's time.
    advance: async (seconds) => {
      audios.at(-1).currentTime = seconds;
      await act(() => {}, 60);
    },
  };
  await act(() =>
    root.render(
      h(
        ToastProvider,
        null,
        h(HistoryBrowser, {
          hotkey: "Control+`",
          onCopy: () => {},
          onDelete: () => {},
          onRetry: async () => {},
          onShowAudioInFolder: () => {},
          onOpenSettings: () => {},
        })
      )
    )
  );
  return v;
}

const checkConsole = (v) => {
  const printed = v.consoleOutput.lines.join("\n");
  for (const text of DICTATED) assert.ok(!printed.includes(text), `"${text}" was printed`);
  assert.deepEqual(v.consoleOutput.errors, [], "nothing logged an error");
};

test(
  "the audio loads on the first Play or Ctrl+Space, and goes with the row",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    assert.equal(v.selected().id, "history-row-703");
    assert.ok(v.doc.querySelector("[data-history-player]"));
    assert.deepEqual(calls("getAudioBuffer"), [], "nothing read before Play");

    // Ctrl+Space anywhere in the view: loaded, then playing; again, paused.
    await v.ctrlSpace();
    assert.deepEqual(calls("getAudioBuffer"), [[703]]);
    assert.equal(audios.length, 1);
    assert.equal(v.audio().paused, false);
    assert.equal(v.playButton().getAttribute("aria-label"), "Pause");
    await v.ctrlSpace();
    assert.equal(v.audio().paused, true);
    assert.equal(calls("getAudioBuffer").length, 1, "read once");

    // The media keys while it has audio.
    assert.equal(typeof mediaHandlers.play, "function");
    await v.act(() => mediaHandlers.play());
    assert.equal(v.audio().paused, false);
    await v.act(() => mediaHandlers.pause());
    assert.equal(v.audio().paused, true);

    // Another row: stopped, released, the media keys let go.
    await v.key({ key: "ArrowDown" }, v.listbox());
    assert.equal(v.selected().id, "history-row-702");
    assert.deepEqual(revoked, ["blob:audio-0"]);
    assert.equal(mediaHandlers.play, null);
    assert.equal(mediaHandlers.pause, null);

    // Play there: its own audio, read on that first Play.
    await v.act(() => v.playButton().click());
    assert.deepEqual(calls("getAudioBuffer").at(-1), [702]);
    assert.equal(audios.length, 2);
    assert.equal(v.audio().paused, false);

    // A row without audio has no player; the last one is released.
    await v.key({ key: "ArrowDown" }, v.listbox());
    assert.equal(v.doc.querySelector("[data-history-player]"), null);
    assert.deepEqual(revoked, ["blob:audio-0", "blob:audio-1"]);
    checkConsole(v);
  }
);

test(
  "back 2 s after a pause only, never after a seek, and it can be switched off",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    await v.act(() => v.playButton().click());
    await v.advance(20);
    assert.equal(v.slider().getAttribute("aria-valuenow"), "20");

    await v.act(() => v.playButton().click());
    assert.equal(v.audio().paused, true);
    await v.act(() => v.playButton().click());
    assert.equal(v.audio().currentTime, 18, "resumed 2 s earlier");

    // A seek after the pause: from where it was put.
    await v.act(() => v.playButton().click());
    await v.key({ key: "ArrowRight" }, v.slider());
    assert.equal(v.audio().currentTime, 23);
    await v.act(() => v.playButton().click());
    assert.equal(v.audio().currentTime, 23);

    // Switched off (and kept): a resume picks up where it paused.
    const toggle = v.doc.querySelector('[data-history-player] input[type="checkbox"]');
    assert.equal(toggle.checked, true, "on by default");
    await v.act(() => toggle.click());
    assert.equal(v.win.localStorage.getItem("historyView.backOnResume"), "false");
    await v.advance(30);
    await v.act(() => v.playButton().click());
    await v.act(() => v.playButton().click());
    assert.equal(v.audio().currentTime, 30);
    await v.act(() => toggle.click());
    assert.equal(v.win.localStorage.getItem("historyView.backOnResume"), "true");
    checkConsole(v);
  }
);

test(
  "the seek bar: keys, the pointer, ±5 s, all within the recording",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    const readsBefore = calls("getAudioBuffer").length;
    const slider = v.slider();
    assert.equal(slider.getAttribute("dir"), "ltr");
    assert.equal(slider.getAttribute("tabindex"), "0");
    assert.equal(slider.getAttribute("aria-valuemax"), "74");

    // Before anything is loaded: the pointer seeks, nothing is read.
    await v.pointer("pointerdown", slider, 450);
    assert.equal(slider.getAttribute("aria-valuenow"), "37");
    await v.pointer("pointermove", slider, 225);
    assert.equal(slider.getAttribute("aria-valuenow"), "19");
    await v.pointer("pointerup", slider, 225);
    await v.pointer("pointermove", slider, 900);
    assert.equal(slider.getAttribute("aria-valuenow"), "19", "not dragging any more");
    assert.equal(calls("getAudioBuffer").length, readsBefore, "nothing read");
    // Play starts there.
    await v.act(() => v.playButton().click());
    assert.equal(v.audio().currentTime, 18.5);

    await v.key({ key: "Home" }, slider);
    assert.equal(v.audio().currentTime, 0);
    await v.key({ key: "ArrowRight" }, slider);
    assert.equal(v.audio().currentTime, 5);
    await v.key({ key: "ArrowLeft" }, slider);
    await v.key({ key: "ArrowLeft" }, slider);
    assert.equal(v.audio().currentTime, 0, "not before the start");
    await v.key({ key: "End" }, slider);
    assert.equal(v.audio().currentTime, 74);
    await v.act(() => v.button("+5").click());
    assert.equal(v.audio().currentTime, 74, "not past the end");
    await v.act(() => v.button("−5").click());
    assert.equal(v.audio().currentTime, 69);
    assert.equal(slider.getAttribute("aria-valuetext"), "1:09 of 1:14");
    await v.alt("ArrowLeft");
    assert.equal(v.audio().currentTime, 64);
    await v.alt("ArrowRight");
    assert.equal(v.audio().currentTime, 69);
    checkConsole(v);
  }
);

test(
  "speed: the button cycles, Alt+↑/↓ step within the range, and it's kept",
  { timeout: 90000 },
  async (t) => {
    let v = await mountHistory(t);
    assert.equal(v.speed().textContent, "1×");
    const cycle = [];
    for (let i = 0; i < 4; i += 1) {
      await v.act(() => v.speed().click());
      cycle.push(v.speed().textContent);
    }
    assert.deepEqual(cycle, ["1.25×", "1.5×", "0.75×", "1×"]);
    for (let i = 0; i < 3; i += 1) await v.alt("ArrowUp");
    assert.equal(v.speed().textContent, "1.5×");
    for (let i = 0; i < 4; i += 1) await v.alt("ArrowDown");
    assert.equal(v.speed().textContent, "0.75×");
    assert.equal(v.win.localStorage.getItem("historyView.playbackRate"), "0.75");
    await v.act(() => v.playButton().click());
    assert.equal(v.audio().playbackRate, 0.75);
    await v.alt("ArrowUp");
    assert.equal(v.audio().playbackRate, 1, "changed while playing");

    // A new window reads it back.
    await v.unmount();
    v = await mountHistory(t);
    assert.equal(v.speed().textContent, "1×");
    await v.alt("ArrowDown");
    await v.unmount();
    v = await mountHistory(t);
    assert.equal(v.speed().textContent, "0.75×");
    v.win.localStorage.removeItem("historyView.playbackRate");
    checkConsole(v);
  }
);

test(
  "keys: exact modifiers, never while composing, under a dialog, in the list or held down; in the review's fields too",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    const readsBefore = calls("getAudioBuffer").length;
    const reads = () => calls("getAudioBuffer").length - readsBefore;

    await v.ctrlSpace(v.doc.body, { isComposing: true });
    await v.key({ key: " ", code: "Space", ctrlKey: true }, v.doc.body, { keyCode: 229 });
    await v.ctrlSpace(v.doc.body, { shiftKey: true });
    await v.ctrlSpace(v.doc.body, { altKey: true });
    await v.ctrlSpace(v.doc.body, { repeat: true });
    await v.ctrlSpace(v.listbox());
    const dialog = v.doc.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    v.doc.body.appendChild(dialog);
    await v.ctrlSpace();
    dialog.remove();
    assert.equal(reads(), 0, "none of them played");

    await v.ctrlSpace();
    assert.equal(v.audio().paused, false);
    await v.advance(30);
    const altGraph = await v.key({ key: "ArrowLeft", altKey: true }, v.doc.body, {
      getModifierState: (name) => name === "AltGraph",
    });
    assert.equal(altGraph.defaultPrevented, false);
    await v.key({ key: "ArrowLeft", altKey: true, ctrlKey: true });
    await v.key({ key: "ArrowLeft", altKey: true, shiftKey: true });
    assert.equal(v.audio().currentTime, 30, "no skip with other modifiers");

    // In the review's correction and note: the keys still work, the letters stay text.
    await v.key({ key: "b" });
    const skipped = await v.alt("ArrowLeft", v.textarea());
    assert.equal(skipped.defaultPrevented, true);
    assert.equal(v.audio().currentTime, 25);
    await v.ctrlSpace(v.textarea());
    assert.equal(v.audio().paused, true);
    await v.ctrlSpace(v.note());
    assert.equal(v.audio().paused, false);
    await v.alt("ArrowUp", v.note());
    assert.equal(v.speed().textContent, "1.25×");
    await v.alt("ArrowDown", v.textarea());
    assert.equal(v.speed().textContent, "1×");
    assert.ok(v.doc.querySelector("[data-review-form]"), "the review stays open");
    checkConsole(v);
  }
);

test(
  "From your cursor, Alt+Enter and the edit marks go through matched words; the estimated line",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    // Sentence starts are ticked (estimated), the first excepted.
    assert.equal(v.doc.querySelectorAll("[data-sentence-tick]").length, 2);

    await v.key({ key: "b" });
    const line = () => v.doc.querySelector("[data-estimated-position]");
    assert.match(line().textContent, /Estimated position/);
    assert.match(line().textContent, /Press play or Ctrl\+Space/);
    assert.equal(line().getAttribute("aria-live"), null, "not a live region");

    // The correction differs at "the file": one mark, at "closed" (the word before it).
    await v.act(() => v.setValue(v.textarea(), CORRECTION), 600);
    const marks = () => [...v.doc.querySelectorAll("[data-edit-mark]")];
    assert.deepEqual(
      marks().map((mark) => mark.getAttribute("data-edit-mark")),
      [String(STT.indexOf("closed")) + ".00"]
    );

    // The caret in "file": that sentence, from its estimated start.
    const field = v.textarea();
    const fromCursor = () => v.doc.querySelector("[data-from-cursor] button");
    await v.act(() => {
      field.setSelectionRange(CORRECTION.indexOf("file") + 1, CORRECTION.indexOf("file") + 1);
      field.dispatchEvent(new v.win.Event("keyup", { bubbles: true }));
    });
    const start = STT.indexOf("the user");
    assert.equal(fromCursor().disabled, false);
    assert.match(fromCursor().textContent, /From your cursor\s*· 0:28/);
    assert.equal(start, 28);

    // Alt+Enter while typing: loaded and playing from there, never rewound.
    const event = await v.alt("Enter", field);
    assert.equal(event.defaultPrevented, true);
    assert.equal(v.audio().currentTime, 28);
    assert.equal(v.audio().paused, false);
    assert.match(line().textContent, /the user closed it, you know\./);
    await v.act(() => v.playButton().click());
    await v.act(() => fromCursor().click());
    assert.equal(v.audio().currentTime, 28, "the button too, without the 2 s");

    // A mark plays from a second before it.
    await v.pointer("pointerdown", marks()[0], 0);
    assert.equal(v.audio().currentTime, STT.indexOf("closed") - 1);

    // A sentence nothing matched: no place, so the button says why and Alt+Enter does nothing.
    const unmatched = "So the auto recovery works. Brand new words. Then it was lost.";
    await v.act(() => v.setValue(field, unmatched), 600);
    await v.act(() => {
      field.setSelectionRange(unmatched.indexOf("new"), unmatched.indexOf("new"));
      field.dispatchEvent(new v.win.Event("keyup", { bubbles: true }));
    });
    assert.equal(fromCursor().disabled, true);
    assert.match(
      v.doc.querySelector("[data-from-cursor]").textContent,
      /Can't tell where this sentence was said/
    );
    await v.key({ key: "Home" }, v.slider());
    await v.alt("Enter", field);
    assert.equal(v.audio().currentTime, 0);
    assert.deepEqual(marks(), [], "no anchor, no mark");

    // An emptied correction: neither.
    await v.act(() => v.setValue(field, ""), 600);
    assert.equal(v.doc.querySelector("[data-from-cursor]"), null);
    assert.deepEqual(marks(), []);
    checkConsole(v);
  }
);

test(
  "without a known length: the controls stay, nothing is placed in the text",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    await v.key({ key: "ArrowDown" }, v.listbox());
    assert.equal(v.selected().id, "history-row-702");
    assert.equal(v.doc.querySelectorAll("[data-sentence-tick]").length, 0);
    await v.key({ key: "b" });
    await v.act(() => v.setValue(v.textarea(), CORRECTION), 600);
    assert.equal(v.doc.querySelector("[data-estimated-position]"), null);
    assert.equal(v.doc.querySelector("[data-from-cursor]"), null);
    assert.equal(v.doc.querySelectorAll("[data-edit-mark]").length, 0);
    await v.act(() => v.playButton().click());
    assert.equal(v.audio().paused, false);
    await v.alt("ArrowRight");
    assert.equal(v.audio().currentTime, 5, "no length: only the start bounds it");
    await v.key({ key: "Escape" });
    checkConsole(v);
  }
);

test(
  "a dictation whose audio is saved after it's shown gets its player then",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    await v.act(() => v.store.requestHistoryItem(704), 60);
    assert.equal(v.doc.querySelector("[data-history-player]"), null);
    lateAudio = true;
    await v.act(() => updated.forEach((callback) => callback({ id: 704 })), 60);
    assert.ok(v.doc.querySelector("[data-history-player]"));
    assert.equal(v.slider().getAttribute("aria-valuemax"), "74");
    await v.ctrlSpace();
    assert.deepEqual(calls("getAudioBuffer").at(-1), [704]);
    assert.equal(v.audio().paused, false);
    checkConsole(v);
  }
);
