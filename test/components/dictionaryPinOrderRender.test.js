const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// The Dictionary page's pin order (Dictionary v2, Stage B), rendered
// (happy-dom, stubbed preload) on Azure Speech: "Always sent first" lists the
// pins in pin order with their ranks, then "Everything else" ordered by
// evidence or as added (the order control mirrors the setting both ways); a
// drop, Alt+↑/↓ and Move to top each reorder once through main,
// optimistically, announced to screen readers, and a refusal rolls back; a
// filter or a search shows the pins inline again; the word panel shows the
// pin's rank. And the Settings row writes the same setting. Synthetic words.

const WORDS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
const LEARNED = new Set(["Echo", "Foxtrot"]);
const DAY = 24 * 60 * 60 * 1000;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// Main's state: the pins in their order, and whether it refuses a reorder.
const main = { pins: ["charlie", "alpha", "echo"], refuse: false };

let dom;
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      getDictionary: async () => [...WORDS],
      getDictionaryEntries: async () =>
        WORDS.map((word, i) => ({
          word,
          source: LEARNED.has(word) ? "learned" : "manual",
          createdAt: sqlTime(Date.now() - (60 - i) * DAY),
        })),
      getDictionaryPins: async () => [...main.pins],
      listDictionarySuggestions: async () => ({ success: true, suggestions: [], dismissed: 0 }),
      getDictionaryWordUsage: async () => ({ available: false, reason: "history-off" }),
      getDictionaryWordEvidence: async () => ({ available: true, evidence: [] }),
      reorderDictionaryPins: async (keys) => {
        if (main.refuse) return { success: false, code: "MISMATCH", pins: [...main.pins] };
        main.pins = keys.map((key) => key.toLowerCase());
        return { success: true, changed: true, pins: [...main.pins] };
      },
    },
    storage: { agentName: "Assistant" },
  });
  const proto = dom.window.HTMLElement.prototype;
  proto.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 40,
      width: 1200,
      height: 40,
      toJSON() {},
    };
  };
  proto.scrollIntoView = () => {};
});

test.after(async () => {
  await dom.close();
});

async function mount(t) {
  main.pins = ["charlie", "alpha", "echo"];
  main.refuse = false;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const consoleOutput = captureConsole(t);
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const h = React.createElement;
  const vite = await createRendererServer(t, {
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "/services/SyncService.js": "export const syncService = { canSync: () => false };",
    },
  });
  await vite.ssrLoadModule("/i18n.ts");
  const { default: DictionaryView } = await vite.ssrLoadModule("/components/DictionaryView.tsx");
  const { default: DictionaryHintOrderSetting } = await vite.ssrLoadModule(
    "/components/settings/DictionaryHintOrderSetting.tsx"
  );
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useDictionarySourcesStore, refreshDictionarySources } = await vite.ssrLoadModule(
    "/stores/dictionarySourcesStore.ts"
  );
  const { useDictionaryUsageStore } = await vite.ssrLoadModule("/stores/dictionaryUsageStore.ts");
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");

  useSettingsStore.setState({
    customDictionary: [...WORDS],
    snippets: [],
    useLocalWhisper: false,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "azure-speech",
    cloudTranscriptionModel: "MAI-Transcribe-2",
    azureSpeechEndpoint: "https://res.cognitiveservices.azure.com",
    useCleanupModel: true,
    cleanupDictionaryWords: "all",
    dictionaryHintOrder: "evidence",
  });
  await refreshDictionarySources();
  // Delta is the typed word speech misses; Foxtrot the learned one used.
  useDictionaryUsageStore.setState({
    status: "ready",
    reason: null,
    words: [
      { word: "Delta", heard: 1, written: 7, missedRows: 5, bothRows: 1 },
      { word: "Bravo", heard: 0, written: 0, missedRows: 0, bothRows: 0 },
      { word: "Foxtrot", heard: 3, written: 3, missedRows: 0, bothRows: 3 },
    ],
    missed: new Set(["delta"]),
    perDay: 10,
  });

  const doc = dom.window.document;
  const win = dom.window;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  const act = async (fn, ms = 30) => {
    await React.act(async () => {
      await fn();
      await settle(ms);
    });
    await settle();
  };
  await act(
    () =>
      root.render(
        h(
          ToastProvider,
          null,
          h("div", null, h(DictionaryView), h("div", { "data-settings-row": "" }, h(DictionaryHintOrderSetting)))
        )
      ),
    60
  );
  const listbox = () => doc.querySelector("[data-dictionary-list]");
  const row = (word) => doc.querySelector(`[data-dictionary-row="${word}"]`);
  const section = (name) => doc.querySelector(`[data-dictionary-section="${name}"]`);
  const wordsIn = (scope) =>
    [...(scope?.querySelectorAll("[data-dictionary-row]") ?? [])].map((element) =>
      element.getAttribute("data-dictionary-row")
    );
  const key = (target, name, init = {}) =>
    act(() =>
      target.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })
      )
    );
  const click = (target, init = {}) =>
    act(() => target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, ...init })));
  // A drag event as a browser sends it (React reads the type, the data and clientY).
  const drag = (target, type, init = {}) =>
    act(() => {
      const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, "dataTransfer", { value: new win.DataTransfer() });
      target.dispatchEvent(event);
    });
  const callsFrom = dom.calls.length;
  const reorders = () =>
    dom.calls.slice(callsFrom).filter(([name]) => name === "reorderDictionaryPins");
  const announced = () => doc.querySelector("[data-dictionary-pin-announcer]").textContent;
  const typeSearch = (text) =>
    act(() => {
      const input = doc.querySelector('input[type="search"]');
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
      setter.call(input, text);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
  return {
    doc,
    win,
    act,
    listbox,
    row,
    section,
    wordsIn,
    key,
    click,
    drag,
    reorders,
    announced,
    typeSearch,
    consoleOutput,
    useSettingsStore,
    useDictionarySourcesStore,
  };
}

test(
  "Always sent first, then everything else by evidence; a filter or search shows pins inline",
  { timeout: 90000 },
  async (t) => {
    const view = await mount(t);
    const { doc, row, section, wordsIn } = view;

    const header = doc.querySelector("[data-dictionary-pins-header]");
    assert.match(header.textContent, /Always sent first/);
    assert.match(header.textContent, /\+ Pin a word/);
    assert.deepEqual(wordsIn(section("pinned")), ["Charlie", "Alpha", "Echo"]);
    assert.deepEqual(
      ["Charlie", "Alpha", "Echo"].map((word) => row(word).getAttribute("data-pin-rank")),
      ["1", "2", "3"]
    );
    assert.equal(row("Charlie").querySelector("[data-pin-rank-label]").textContent, "#1");
    assert.ok(row("Charlie").querySelector("[data-pin-grip]"), "a drag handle");
    assert.equal(row("Charlie").getAttribute("draggable"), "true");
    assert.match(row("Charlie").textContent, /Sent · #1/, "the request's rank");
    assert.match(row("Echo").textContent, /Sent · #3/, "a learned pin is still a pin");

    // Everything else: Delta (missed most) before Bravo (no evidence), then Foxtrot.
    const rest = section("rest");
    assert.match(rest.querySelector("[data-dictionary-rest-header]").textContent, /Everything else/);
    assert.match(
      rest.querySelector("[data-dictionary-order-description]").textContent,
      /words speech misses most first, never-used words last/
    );
    assert.deepEqual(wordsIn(rest), ["Delta", "Bravo", "Foxtrot"]);
    assert.match(row("Delta").textContent, /Sent · #4/);

    // A filter: one list again, pins inline.
    await view.click(doc.querySelector('[data-dictionary-filter="typed"]'));
    assert.equal(section("pinned"), null);
    assert.equal(doc.querySelector("[data-dictionary-pins-header]"), null);
    assert.equal(row("Charlie").getAttribute("data-pin-rank"), null, "no rank inline");
    await view.click(doc.querySelector('[data-dictionary-filter="all"]'));
    assert.ok(section("pinned"));
    await view.typeSearch("ha");
    assert.equal(section("pinned"), null, "a search too");
    assert.deepEqual(wordsIn(doc), ["Charlie", "Alpha"]);
    await view.typeSearch("");
    assert.ok(section("pinned"));

    // "+ Pin a word": the keyboard goes to the first word that isn't pinned.
    await view.click(doc.querySelector("[data-pin-a-word]"));
    await view.act(() => settle(40));
    assert.equal(doc.activeElement, view.listbox());
    assert.equal(view.listbox().getAttribute("aria-activedescendant"), row("Delta").id);
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test("drag and drop reorders once, optimistically; a refusal rolls back", { timeout: 90000 }, async (t) => {
  const view = await mount(t);
  const { row, section, wordsIn, drag, reorders } = view;

  await drag(row("Echo"), "dragstart");
  assert.equal(row("Echo").className.includes("opacity-45"), true, "the dragged row dims");
  await drag(row("Charlie"), "dragover", { clientY: 5 });
  assert.equal(row("Charlie").getAttribute("data-drop"), "before", "the drop line");
  await drag(row("Charlie"), "drop", { clientY: 5 });
  await drag(row("Echo"), "dragend");
  assert.equal(reorders().length, 1, "one reorder for the drop");
  assert.deepEqual(reorders()[0][1], [["echo", "charlie", "alpha"]]);
  assert.deepEqual(wordsIn(section("pinned")), ["Echo", "Charlie", "Alpha"]);
  assert.equal(row("Echo").getAttribute("data-pin-rank"), "1");
  assert.equal(row("Charlie").getAttribute("data-drop"), null, "the line goes");
  assert.equal(view.announced(), "Moved Echo to position 1");

  // Below the middle of a row: after it. Main refuses: back as main has it.
  main.refuse = true;
  await drag(row("Echo"), "dragstart");
  await drag(row("Alpha"), "dragover", { clientY: 35 });
  assert.equal(row("Alpha").getAttribute("data-drop"), "after");
  await drag(row("Alpha"), "drop", { clientY: 35 });
  await view.act(() => settle(40));
  assert.equal(reorders().length, 2);
  assert.deepEqual(reorders()[1][1], [["charlie", "alpha", "echo"]], "what was asked");
  assert.deepEqual(wordsIn(section("pinned")), ["Echo", "Charlie", "Alpha"], "rolled back");
  assert.deepEqual([...view.useDictionarySourcesStore.getState().pinned], main.pins);
  assert.equal(view.announced(), "Couldn't save the new order. The pins are back as they were.");

  // A word that isn't pinned can't be dropped in among them.
  main.refuse = false;
  await drag(row("Delta"), "dragstart");
  await drag(row("Charlie"), "drop");
  assert.equal(reorders().length, 2);
  assert.deepEqual(view.consoleOutput.errors, []);
});

test(
  "keyboard: Alt+↑/↓ move the focused pin, Move to top in its menu; the panel shows the rank",
  { timeout: 90000 },
  async (t) => {
    const view = await mount(t);
    const { doc, win, listbox, row, section, wordsIn, key, reorders } = view;

    await view.act(() => listbox().focus());
    await key(listbox(), "ArrowDown");
    assert.equal(listbox().getAttribute("aria-activedescendant"), row("Alpha").id);
    await key(listbox(), "ArrowUp", { altKey: true });
    assert.deepEqual(reorders().at(-1)[1], [["alpha", "charlie", "echo"]]);
    assert.deepEqual(wordsIn(section("pinned")), ["Alpha", "Charlie", "Echo"]);
    assert.equal(
      listbox().getAttribute("aria-activedescendant"),
      row("Alpha").id,
      "the moved word keeps the focus"
    );
    assert.equal(view.announced(), "Moved Alpha to position 1");
    await key(listbox(), "ArrowUp", { altKey: true });
    assert.equal(reorders().length, 1, "already first: nothing to move");
    await key(listbox(), "ArrowDown", { altKey: true });
    await key(listbox(), "ArrowDown", { altKey: true });
    assert.deepEqual(wordsIn(section("pinned")), ["Charlie", "Echo", "Alpha"]);
    assert.equal(reorders().length, 3);
    await key(listbox(), "ArrowDown", { altKey: true });
    assert.equal(reorders().length, 3, "already last");
    // Alt on a word that isn't pinned does nothing.
    await key(listbox(), "End");
    await key(listbox(), "ArrowUp", { altKey: true });
    assert.equal(reorders().length, 3);

    // The row menu's Move to top.
    await view.act(() =>
      doc
        .querySelector('[data-pin-menu="Alpha"]')
        .dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    );
    const top = doc.querySelector('[data-pin-move="top"]');
    assert.ok(top, "the menu is open");
    await view.act(() => top.click());
    assert.deepEqual(reorders().at(-1)[1], [["alpha", "charlie", "echo"]]);
    assert.deepEqual(wordsIn(section("pinned")), ["Alpha", "Charlie", "Echo"]);

    // The word's panel: where it goes, with its rank among the pins.
    await view.click(row("Echo"));
    const detail = doc.querySelector("[data-dictionary-detail]");
    assert.equal(
      detail.querySelector("[data-dictionary-pin-rank]").textContent,
      "Always sent first · #3"
    );
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test("the order control and the Settings row write one setting, each mirroring the other", { timeout: 90000 }, async (t) => {
  const view = await mount(t);
  const { doc, win, section, wordsIn, useSettingsStore } = view;
  const trigger = () => doc.querySelector("[data-dictionary-order]");
  const radio = (option) => doc.querySelector(`[data-dictionary-hint-order="${option}"]`);
  assert.equal(trigger().textContent.trim(), "by evidence");
  assert.equal(radio("evidence").getAttribute("aria-checked"), "true");

  await view.act(() =>
    trigger().dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  );
  const added = doc.querySelector('[data-dictionary-order-option="added"]');
  assert.match(added.textContent, /In the order they were added/);
  await view.act(() => added.click());
  assert.equal(useSettingsStore.getState().dictionaryHintOrder, "added");
  assert.equal(dom.window.localStorage.getItem("dictionaryHintOrder"), "added");
  assert.equal(trigger().textContent.trim(), "as added");
  assert.equal(radio("added").getAttribute("aria-checked"), "true", "Settings follows");
  assert.match(
    section("rest").querySelector("[data-dictionary-order-description]").textContent,
    /In the order they were added\./
  );
  assert.deepEqual(wordsIn(section("rest")), ["Bravo", "Delta", "Foxtrot"], "stored order");

  // The Settings row writes it back; the page follows.
  await view.click(radio("evidence"));
  assert.equal(useSettingsStore.getState().dictionaryHintOrder, "evidence");
  assert.equal(trigger().textContent.trim(), "by evidence");
  assert.deepEqual(wordsIn(section("rest")), ["Delta", "Bravo", "Foxtrot"]);
  assert.deepEqual(view.consoleOutput.errors, []);
});
