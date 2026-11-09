const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// The History detail's wide layout rendered (happy-dom, stubbed preload): when
// it's chosen (880 px of detail beside the list as it is; failed, other-owner
// and no-raw-text rows stay stacked), the reference tabs and "What speech
// heard"'s views, the end pane's final output or review form (the step chips,
// Save, Cancel, Ctrl+Enter, Esc), the list folding while reviewing (the
// user's own choice winning and kept), the divider, the review hotkey's flow,
// fixes from words selected in what speech heard, and click-to-play.

const STT = "so the auto recovery works. the user closed it, you know. then it was lost";
const FINAL = "So the auto recovery works. The user closed it. Then it was lost.";
const STT2 = "open the open whisper repo and ping little body. ping little body again";
const FINAL2 = "Open the OpenWhispr repo and ping Little Buddy. Ping little body again.";
const CORRECTION2 = "Open the OpenWhispr repo and ping Little Buddy. Ping little body again.";
const DICTATED = [STT, FINAL, STT2, FINAL2];

const listRow = (id, extra = {}) => ({
  id,
  timestamp: `2026-10-24 1${id % 10}:00:00`,
  status: "completed",
  errorCode: null,
  preview: `Dictation ${id}`,
  hasAudio: false,
  audioDurationMs: null,
  routeKind: null,
  app: null,
  marks: null,
  rating: null,
  ...extra,
});
const ROWS = [
  listRow(801, { hasAudio: true, audioDurationMs: 74000 }),
  listRow(802, { status: "failed", errorCode: "TIMEOUT" }),
  listRow(803),
  listRow(804),
  listRow(805, { hasAudio: true }),
  listRow(806, { hasAudio: true, audioDurationMs: 74000 }),
  listRow(807),
];
const step = (kind, output, extra = {}) => ({
  kind,
  outcome: "ok",
  output,
  provider: null,
  model: null,
  ms: 10,
  errorCode: null,
  prompt: null,
  detail: null,
  ...extra,
});
const span = (text, word) => ({ start: text.indexOf(word), end: text.indexOf(word) + word.length });
const item = (id, extra = {}) => {
  const row = ROWS.find((candidate) => candidate.id === id);
  return {
    id,
    timestamp: "2026-10-24 12:00:00",
    status: row.status,
    text: FINAL,
    rawText: STT,
    errorCode: row.errorCode,
    errorMessage: null,
    hasAudio: row.hasAudio,
    audioDurationMs: row.audioDurationMs,
    routeKind: null,
    provider: null,
    model: null,
    ...extra,
  };
};
const captured = (steps, extra = {}) => ({
  status: "captured",
  route: "cleanup",
  context: { targetApp: "Code.exe" },
  steps,
  ...extra,
});
const ITEMS = {
  801: () => ({
    item: item(801),
    ...captured([
      step("stt", STT),
      step("glossary", STT),
      step("cleanup", FINAL),
      step("finalize", FINAL),
    ]),
    dictionary: [
      { word: "recovery", appearances: [{ kind: "ok", ...span(FINAL, "recovery") }] },
      {
        word: "user",
        appearances: [{ kind: "fix", ...span(FINAL, "user"), speechWrote: "yuser", by: null }],
      },
    ],
  }),
  802: () => ({
    item: item(802, { text: "", rawText: null }),
    status: "none",
    route: null,
    context: null,
    steps: [],
  }),
  803: () => ({ item: item(803), status: "otherOwner", route: null, context: null, steps: [] }),
  804: () => ({
    item: item(804, { rawText: null }),
    status: "none",
    route: null,
    context: null,
    steps: [],
  }),
  805: () => ({
    item: item(805),
    status: "none",
    route: null,
    context: null,
    steps: [],
    dictionaryAligned: false,
  }),
  806: () => ({
    item: item(806),
    ...captured([step("stt", STT), step("translation", "Alors la récupération marche.")], {
      route: "translation",
      context: { targetApp: null, intents: { translation: true } },
    }),
  }),
  807: () => ({
    item: item(807, { text: FINAL2, rawText: STT2 }),
    ...captured([
      step("stt", STT2),
      step("glossary", "open the OpenWhispr repo and ping little body. ping little body again"),
      step("cleanup", FINAL2),
    ]),
  }),
};

class FakeAudio {
  constructor(src) {
    this.src = src;
    this.paused = true;
    this.currentTime = 0;
    this.duration = Number.POSITIVE_INFINITY;
    this.playbackRate = 1;
    this.handlers = {};
    FakeAudio.all.push(this);
  }
  addEventListener(name, handler) {
    (this.handlers[name] ??= []).push(handler);
  }
  async play() {
    this.paused = false;
    for (const handler of this.handlers.play ?? []) handler();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    for (const handler of this.handlers.pause ?? []) handler();
  }
  removeAttribute() {}
  load() {}
}
FakeAudio.all = [];

let dom;
let layoutWidth = 1400;
const saves = [];
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
      getHistoryItem: async (id) =>
        ITEMS[id]
          ? {
              success: true,
              dictionary: [],
              dictionaryAligned: true,
              ...ITEMS[id](),
              revision: `rev-${id}`,
              owner: "owner-a",
              feedback: null,
            }
          : { success: false, code: "NOT_FOUND" },
      saveHistoryFeedback: async (input) => {
        saves.push(input);
        return {
          success: true,
          feedback: {
            revision: input.revision,
            verdict: input.verdict,
            stage: input.stage,
            expectedText: input.expectedText,
            note: input.note || null,
            createdAt: "2026-10-24T12:00:00.000Z",
            updatedAt: "2026-10-24T12:00:00.000Z",
          },
        };
      },
      getAudioBuffer: async () => new ArrayBuffer(8),
      hideControlPanel: async () => undefined,
      getGlossaryRules: async () => ({ revision: 1, rules: [] }),
      getDictionary: async () => [],
      getDictionarySpeechVariants: async () => ({ available: false }),
    },
  });
  const proto = dom.window.HTMLElement.prototype;
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => layoutWidth });
  proto.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: layoutWidth,
    bottom: 800,
    width: layoutWidth,
    height: 800,
    toJSON() {},
  });
  proto.scrollTo = () => {};
  proto.scrollIntoView = () => {};
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.hasPointerCapture = () => false;
  globalThis.Audio = FakeAudio;
  URL.createObjectURL = () => "blob:audio";
  URL.revokeObjectURL = () => {};
});

test.after(async () => {
  delete globalThis.Audio;
  await dom.close();
});

const calls = (name) => dom.calls.filter(([called]) => called === name).map(([, args]) => args);

async function mountHistory(t, width = 1400) {
  layoutWidth = width;
  dom.window.localStorage.clear();
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
        export async function updateTestCase() { return { success: true }; }
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
  const { syncGlossaryRules } = await vite.ssrLoadModule("/stores/glossaryStore.ts");
  useSettingsStore.setState({ dataRetentionEnabled: true, customDictionary: [] });
  await syncGlossaryRules();

  const doc = dom.window.document;
  const win = dom.window;
  doc.getSelection().removeAllRanges();
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
    key: async (init, target = doc.body) => {
      const event = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      const modifier = event.getModifierState.bind(event);
      Object.defineProperty(event, "getModifierState", {
        configurable: true,
        value: (name) => (name === "AltGraph" ? false : modifier(name)),
      });
      await act(() => target.dispatchEvent(event));
      return event;
    },
    press: (key, target) => v.key({ key }, target),
    setValue: (field, value) => {
      const proto =
        field.tagName === "TEXTAREA"
          ? win.HTMLTextAreaElement.prototype
          : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(field, value);
      field.dispatchEvent(new win.Event("input", { bubbles: true }));
    },
    // Radix tabs activate on mousedown.
    tab: (name) =>
      act(() =>
        v
          .tabs()
          .find((tab) => tab.textContent.startsWith(name))
          .dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, button: 0 }))
      ),
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
    open: (id) => act(() => store.requestHistoryItem(id), 60),
    layout: () => doc.querySelector("[data-history-detail]")?.getAttribute("data-history-detail"),
    list: () =>
      doc.querySelector("[data-history-list-column]")?.getAttribute("data-history-list-column"),
    end: () => doc.querySelector('[data-history-pane="end"]'),
    start: () => doc.querySelector('[data-history-pane="start"]'),
    form: () => doc.querySelector("[data-review-form]"),
    chips: () => [...doc.querySelectorAll('[data-review-form] [role="radio"]')],
    tabs: () => [...doc.querySelectorAll('[role="tab"]')],
    selectedTab: () => doc.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    views: () =>
      [...doc.querySelectorAll('[data-heard-text] [role="radio"]')].map(
        (radio) => `${radio.textContent}${radio.getAttribute("aria-checked") === "true" ? "*" : ""}`
      ),
    heard: () => doc.querySelector("[data-heard-body]"),
    textarea: () => doc.querySelector("#history-review-expected"),
    button: (text, scope = doc) =>
      [...scope.querySelectorAll("button")].find((candidate) =>
        candidate.textContent.trim().startsWith(text)
      ),
    labelled: (label) => doc.querySelector(`button[aria-label="${label}"]`),
    listbox: () => doc.querySelector('[role="listbox"]'),
    selected: () => doc.querySelector('[role="option"][aria-selected="true"]'),
    toolbar: () => doc.querySelector("[data-selection-actions]"),
    dialog: () => doc.querySelector('[role="dialog"]'),
    // Selects text from (node, offset) to (node, offset) as a drag would.
    selectRange: async (startNode, startOffset, endNode, endOffset) => {
      const range = doc.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      await act(() => {
        const selection = doc.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
    },
    textNodes: (root) => {
      const nodes = [];
      const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      return nodes;
    },
  };
  await act(
    () =>
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
      ),
    60
  );
  return v;
}

const checkConsole = (v) => {
  const printed = v.consoleOutput.lines.join("\n");
  for (const text of DICTATED) assert.ok(!printed.includes(text), `"${text}" was printed`);
  assert.deepEqual(v.consoleOutput.errors, [], "nothing logged an error");
};

test(
  "chosen from 880 px of detail beside the list; failed, other-owner and no-raw-text rows stay stacked",
  { timeout: 120000 },
  async (t) => {
    let v = await mountHistory(t, 1260);
    assert.equal(v.selected().id, "history-row-801");
    assert.equal(v.layout(), "wide");
    assert.equal(v.list(), "list");
    // Header, player, strip, then the panes: the final output in the end pane.
    assert.ok(v.doc.querySelector("[data-history-player]"));
    assert.ok(v.doc.querySelector('ol[aria-label="Steps"]'));
    assert.ok(
      v.end().querySelector("[data-history-final-text]").textContent.startsWith(FINAL),
      "the final output, its dictionary words underlined"
    );
    assert.match(v.end().textContent, /sent to Code\.exe/);
    assert.ok(v.button("Something wrong? Correct it here", v.end()));
    await v.unmount();

    v = await mountHistory(t, 1259);
    assert.equal(v.layout(), "stacked");
    assert.ok(v.doc.querySelector("[data-history-dictionary]"), "the stacked dictionary card");
    await v.unmount();

    v = await mountHistory(t, 1400);
    const layouts = {};
    for (const id of [802, 803, 804, 805, 801]) {
      await v.open(id);
      layouts[id] = v.layout();
    }
    assert.deepEqual(layouts, {
      802: "stacked",
      803: "stacked",
      804: "stacked",
      805: "wide",
      801: "wide",
    });
    checkConsole(v);
  }
);

test(
  "the reference tabs, what speech heard's views, and the dictionary tab",
  { timeout: 120000 },
  async (t) => {
    const v = await mountHistory(t);
    assert.ok(v.doc.querySelector('[role="tablist"]'));
    assert.deepEqual(
      v.tabs().map((tab) => tab.textContent),
      ["What speech heard", "Steps", "Dictionary (2)"]
    );
    assert.equal(v.selectedTab(), "What speech heard");
    assert.equal(v.heard().textContent, STT);
    assert.deepEqual(v.views(), ["As heard*", "Changes after speech"]);

    // Changes after speech: what speech wrote stays, struck where it changed; added text is marked.
    await v.act(() => v.button("Changes after speech").click());
    assert.deepEqual(v.views(), ["As heard", "Changes after speech*"]);
    assert.ok(v.heard().querySelector("[data-heard-removed]"));
    const added = [...v.heard().querySelectorAll("ins[data-diff-mark]")];
    assert.ok(added.length > 0);
    const heardOnly = v
      .textNodes(v.heard())
      .filter((node) => !node.parentElement.closest("[data-diff-mark]"))
      .map((node) => node.nodeValue)
      .join("");
    assert.equal(heardOnly, STT);

    // With a draft: "Speech → your correction", live (after a pause) while typing.
    await v.press("b");
    assert.deepEqual(v.views(), ["As heard", "Changes after speech*", "Speech → your correction"]);
    await v.act(() => v.button("Speech → your correction").click());
    await v.act(
      () => v.setValue(v.textarea(), "So the auto recovery works. The user closed the file."),
      400
    );
    assert.ok(
      [...v.heard().querySelectorAll("ins[data-diff-mark]")].some((node) =>
        node.textContent.includes("file")
      )
    );
    await v.act(() => v.setValue(v.textarea(), FINAL), 300);
    await v.press("Escape");
    assert.equal(v.form(), null);
    assert.deepEqual(v.views(), ["As heard*", "Changes after speech"], "back to what fits");

    // A strip node opens the Steps tab at its card.
    await v.act(() => v.labelled("Go to Cleanup").click());
    assert.equal(v.selectedTab(), "Steps");
    assert.equal(v.start().querySelectorAll("[data-step-output]").length, 4);
    assert.equal(v.doc.activeElement.tagName, "SECTION");
    assert.match(v.doc.activeElement.textContent, /Cleanup/);

    // The dictionary tab: the chips.
    await v.tab("Dictionary");
    assert.equal(v.selectedTab(), "Dictionary (2)");
    assert.deepEqual(
      [...v.start().querySelectorAll("[data-history-dictionary-chip]")].map((chip) =>
        chip.getAttribute("data-history-dictionary-chip")
      ),
      ["recovery", "user"]
    );
    assert.match(v.start().textContent, /Underlined in the final output/);

    // Too long to compare: the tab stays, without a count.
    await v.open(805);
    assert.deepEqual(
      v.tabs().map((tab) => tab.textContent),
      ["What speech heard", "Steps", "Dictionary"]
    );
    assert.equal(v.selectedTab(), "Dictionary");
    assert.match(v.start().textContent, /too long to compare word by word/);

    // No dictionary words: no tab, and what speech heard shows instead.
    await v.open(806);
    assert.deepEqual(
      v.tabs().map((tab) => tab.textContent),
      ["What speech heard", "Steps"]
    );
    assert.equal(v.selectedTab(), "What speech heard");
    checkConsole(v);
  }
);

test(
  "the end pane: the final output, then the review form with its step chips; Save, Cancel, Ctrl+Enter, Esc",
  { timeout: 120000 },
  async (t) => {
    const v = await mountHistory(t);
    saves.length = 0;
    await v.act(() => v.button("Something wrong? Correct it here", v.end()).click());
    assert.ok(v.end().querySelector("[data-review-form]"), "the form fills the end pane");
    assert.equal(v.end().querySelector("[data-history-final-text]"), null);
    assert.equal(v.textarea().value, FINAL);
    assert.deepEqual(
      v.chips().map((chip) => chip.textContent),
      ["1Speech-to-Text", "2Glossary", "3Cleanup", "4Final touches", "5Delivery", "0Not sure"]
    );
    assert.match(v.end().textContent, /What should it have said\?/);
    assert.match(
      v.end().querySelector("[data-estimated-position]").textContent,
      /Estimated position/
    );
    assert.equal(v.heard().textContent, STT, "what speech heard stays beside it");

    // Digits pick a chip; the strip shows the flagged step and still jumps to it.
    await v.press("3");
    assert.equal(v.chips()[2].getAttribute("aria-checked"), "true");
    assert.deepEqual(
      [...v.doc.querySelectorAll("li[data-blamed]")].map((node) => node.textContent),
      ["Cleanup" + "changed10 ms"]
    );
    assert.equal(v.end().querySelector("[data-fix-suggestion]").dataset.fixSuggestion, "cleanup");
    await v.act(() => v.labelled("Go to Cleanup, the step you flagged").click());
    assert.equal(v.selectedTab(), "Steps");
    assert.equal(v.chips()[2].getAttribute("aria-checked"), "true", "the strip doesn't pick");
    await v.tab("What speech heard");

    // Ctrl+Enter in the correction saves, as today.
    await v.key({ key: "Enter", ctrlKey: true }, v.textarea());
    assert.deepEqual(saves.at(-1), {
      id: 801,
      revision: "rev-801",
      verdict: "bad",
      stage: { kind: "cleanup", seq: 2 },
      expectedText: FINAL,
      note: "",
    });
    assert.equal(v.form(), null);
    assert.ok(v.end().querySelector("[data-history-final-text]"));
    assert.match(v.end().textContent, /You flagged this dictation\./);

    // Edit, then Esc (nothing changed): closed; Cancel too.
    await v.act(() => v.button("Edit", v.end()).click());
    assert.ok(v.end().querySelector("[data-review-form]"));
    await v.press("Escape");
    assert.equal(v.form(), null);
    await v.press("b");
    await v.act(() => v.button("Cancel", v.end()).click());
    assert.equal(v.form(), null);
    assert.equal(saves.length, 1);
    checkConsole(v);
  }
);

test(
  "the list folds while reviewing and comes back; the user's own choice wins and is kept",
  { timeout: 120000 },
  async (t) => {
    const v = await mountHistory(t, 1100);
    assert.equal(v.layout(), "stacked", "720 px beside the list");
    assert.equal(v.list(), "list");

    await v.press("b");
    assert.equal(v.list(), "rail");
    assert.equal(v.layout(), "wide");
    assert.ok(v.end().querySelector("[data-review-form]"));
    await v.press("Escape");
    assert.equal(v.list(), "list");
    assert.equal(v.layout(), "stacked");

    // Shown again while reviewing: kept shown (and remembered), the draft as it was.
    await v.press("b");
    await v.act(() => v.setValue(v.textarea(), "So the auto recovery works."));
    await v.act(() => v.labelled("Show the list").click());
    assert.equal(v.list(), "list");
    assert.equal(v.win.localStorage.getItem("historyView.listChoice"), "expanded");
    assert.equal(v.layout(), "stacked");
    assert.equal(v.textarea().value, "So the auto recovery works.");
    await v.act(() => v.setValue(v.textarea(), FINAL));
    await v.press("Escape");
    await v.press("b");
    assert.equal(v.list(), "list", "no fold any more");
    await v.press("Escape");

    // Collapsed by hand: a rail even while browsing, and the room makes it wide.
    await v.act(() => v.labelled("Collapse the list").click());
    assert.equal(v.list(), "rail");
    assert.equal(v.win.localStorage.getItem("historyView.listChoice"), "collapsed");
    assert.equal(v.layout(), "wide");
    assert.equal(v.doc.activeElement, v.labelled("Show the list"), "focus stays on the toggle");
    // Shown again while browsing: back to folding by itself.
    await v.act(() => v.labelled("Show the list").click());
    assert.equal(v.list(), "list");
    assert.equal(v.win.localStorage.getItem("historyView.listChoice"), null);
    await v.press("b");
    assert.equal(v.list(), "rail");
    await v.press("Escape");

    // ↑/↓ still move through the list.
    await v.press("ArrowDown", v.listbox());
    assert.equal(v.selected().id, "history-row-802");
    checkConsole(v);
  }
);

test("the divider: ←/→, Home/End and dragging, 30–70%, kept", { timeout: 120000 }, async (t) => {
  const v = await mountHistory(t);
  const divider = () => v.doc.querySelector('[role="separator"][data-history-divider]');
  const ratio = () => Number(divider().getAttribute("aria-valuenow"));
  assert.equal(ratio(), 50);
  assert.equal(divider().getAttribute("aria-valuemin"), "30");
  assert.equal(divider().getAttribute("aria-valuemax"), "70");
  for (let i = 0; i < 6; i += 1) await v.press("ArrowRight", divider());
  assert.equal(ratio(), 70);
  assert.equal(v.win.localStorage.getItem("historyView.split"), "0.7");
  assert.match(v.start().style.flex, /^0\.7 1 0/);
  await v.press("ArrowLeft", divider());
  assert.equal(ratio(), 65);
  await v.press("Home", divider());
  assert.equal(ratio(), 30);
  await v.press("End", divider());
  assert.equal(ratio(), 70);

  await v.pointer("pointerdown", divider(), 700);
  await v.pointer("pointermove", divider(), 560);
  assert.equal(ratio(), 40);
  assert.equal(v.win.localStorage.getItem("historyView.split"), "0.7", "kept on release");
  await v.pointer("pointermove", divider(), 10);
  assert.equal(ratio(), 30);
  await v.pointer("pointerup", divider(), 10);
  assert.equal(v.win.localStorage.getItem("historyView.split"), "0.3");
  checkConsole(v);
});

test(
  "the review hotkey in the wide layout: folded, the first chip focused, Save & close stops playback",
  { timeout: 120000 },
  async (t) => {
    const v = await mountHistory(t, 1100);
    saves.length = 0;
    const hides = () => calls("hideControlPanel").length;
    const hidden = hides();
    await v.key({ key: " ", code: "Space", ctrlKey: true });
    const audio = FakeAudio.all.at(-1);
    assert.equal(audio.paused, false);

    await v.act(() => v.store.requestHistoryReview({ requestId: 1, id: 801 }), 120);
    assert.match(v.doc.body.textContent, /Your last dictation, opened to review it\./);
    assert.equal(v.list(), "rail");
    assert.equal(v.layout(), "wide");
    assert.equal(v.doc.activeElement, v.chips()[0], "the first step chip has focus");
    assert.equal(audio.paused, false, "playback goes on through the layout change");
    assert.ok(v.button("Save & close", v.end()));

    await v.press("1", v.doc.activeElement);
    await v.key({ key: "Enter", ctrlKey: true }, v.doc.activeElement);
    assert.deepEqual(saves.at(-1).stage, { kind: "stt", seq: 0 });
    assert.equal(hides(), hidden + 1);
    assert.equal(audio.paused, true, "stopped before the panel hides");

    // Esc in an unchanged hotkey review: hidden, nothing saved.
    await v.act(() => v.store.requestHistoryReview({ requestId: 2, id: 801 }), 120);
    assert.ok(v.form());
    await v.press("Escape", v.doc.activeElement);
    assert.equal(v.form(), null);
    assert.equal(hides(), hidden + 2);
    assert.equal(saves.length, 1);
    checkConsole(v);
  }
);

test(
  "words selected in what speech heard start the same fixes as in the speech-to-text card",
  { timeout: 120000 },
  async (t) => {
    const v = await mountHistory(t);
    await v.open(807);
    await v.press("b");
    await v.act(() => v.setValue(v.textarea(), CORRECTION2));
    await v.press("1");
    const box = () => v.end().querySelector("[data-fix-suggestion]");
    assert.equal(box().dataset.fixSuggestion, "recognition");
    assert.match(box().textContent, /Select the words it got wrong in What speech heard/);
    const boxGlossary = v.button("Glossary correction from selection…", box());
    assert.equal(boxGlossary.disabled, true);
    assert.equal(boxGlossary.title, "Select the words in What speech heard first");
    assert.equal(v.heard().getAttribute("data-step-output"), "0");

    // A phrase heard twice: each selection is read where it is.
    const occurrence = async (n) => {
      const nodes = v.textNodes(v.heard());
      const little = nodes.filter((node) => node.nodeValue === "little")[n];
      const body = nodes.filter((node) => node.nodeValue === "body." || node.nodeValue === "body")[
        n
      ];
      await v.selectRange(little, 0, body, 4);
    };
    await occurrence(0);
    assert.ok(v.toolbar(), "the floating actions");
    assert.ok(v.start().contains(v.toolbar()));
    await v.act(() => v.button("Dictionary word…", v.toolbar()).click());
    assert.equal(v.dialog().querySelector("input").value, "Little Buddy");
    await v.act(() => v.button("Cancel", v.dialog()).click());
    await occurrence(1);
    await v.act(() => v.button("Dictionary word…", v.toolbar()).click());
    assert.equal(
      v.dialog().querySelector("input").value,
      "little body",
      "the second one, unchanged"
    );
    await v.act(() => v.button("Cancel", v.dialog()).click());
    await occurrence(1);
    await v.act(() => v.button("Glossary correction…", v.toolbar()).click());
    assert.equal(v.dialog().querySelector('input[aria-label="Spelling"]').value, "little body");
    await v.act(() => v.button("Cancel", v.dialog()).click());
    assert.deepEqual(calls("saveGlossaryRule"), [], "nothing saved");

    // Another view clears the selection; across a replacement, only what speech wrote is read.
    await occurrence(0);
    assert.ok(v.toolbar());
    await v.act(() => v.button("Changes after speech").click());
    assert.equal(v.toolbar(), null);
    const nodes = v.textNodes(v.heard());
    const the = nodes.find((node) => node.nodeValue === "the");
    const replacement = nodes.find((node) => node.nodeValue === "OpenWhispr");
    assert.ok(replacement.parentElement.closest("[data-diff-mark]"), "added text is marked");
    await v.selectRange(the, 0, replacement, "OpenWhispr".length);
    await v.act(() => v.button("Dictionary word…", v.toolbar()).click());
    assert.equal(v.dialog().querySelector("input").value, "the OpenWhispr");
    await v.act(() => v.button("Cancel", v.dialog()).click());

    // Not sure: no fixes.
    await v.press("0");
    assert.equal(box(), null);
    assert.equal(v.toolbar(), null);
    checkConsole(v);
  }
);

test(
  "a word click plays from about there and its sentence is tinted; nothing is placed for a translation",
  { timeout: 120000 },
  async (t) => {
    const v = await mountHistory(t);
    const reads = calls("getAudioBuffer").length;
    const word = v.heard().querySelector(`[data-heard-at="${STT.indexOf("user")}"]`);
    assert.equal(word.textContent, "user");
    assert.equal(v.heard().querySelector("[data-now]"), null, "nothing tinted before playing");
    await v.act(() => word.click());
    assert.equal(calls("getAudioBuffer").length, reads + 1, "loaded by the click");
    const audio = FakeAudio.all.at(-1);
    assert.equal(audio.paused, false);
    assert.equal(audio.currentTime, STT.indexOf("user") - 0.3);
    assert.deepEqual(
      [...v.heard().querySelectorAll("[data-now]")].map((node) => node.textContent).join(" "),
      "the user closed it, you know."
    );

    // A translation: the line stays, but nothing in the correction is placed.
    await v.open(806);
    await v.press("b");
    await v.act(() => v.setValue(v.textarea(), "Alors la récupération ne marche pas."), 400);
    assert.ok(v.doc.querySelector("[data-estimated-position]"));
    assert.equal(v.doc.querySelector("[data-from-cursor]"), null);
    assert.equal(v.doc.querySelectorAll("[data-edit-mark]").length, 0);
    await v.act(() => v.setValue(v.textarea(), "Alors la récupération marche."));
    await v.press("Escape");

    // Without a known length: words aren't clickable.
    await v.open(805);
    const before = calls("getAudioBuffer").length;
    await v.act(() => v.heard().querySelector("[data-heard-at]").click());
    assert.equal(calls("getAudioBuffer").length, before);
    checkConsole(v);
  }
);
