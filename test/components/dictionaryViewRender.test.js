const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// The Dictionary page rendered (happy-dom, stubbed preload) on Azure Speech
// with 207 words, so 6 are past the 199-phrase cap: the filter chips and
// their counts, send order's cut line, selection and the bulk bar, a word's
// detail beside the list (heard per week, where it goes, what it replaced
// with Open in History, similar words, rename and the merge it offers) and
// over it on a narrow window, unavailable counts said as such, Where it goes,
// and the suggestions' "Forget dismissed". Synthetic words only.

const PHRASES = Array.from({ length: 200 }, (_, i) => `Phrase${i}`);
const BASE_WORDS = ["OpenWhispr", "EngHub", "agents-shared", "agentsshared", "gonestly", "the"];
const DAY = 24 * 60 * 60 * 1000;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

let words = [...BASE_WORDS, ...PHRASES];
const LEARNED = new Set(["agents-shared", "agentsshared", "gonestly", "the", ...PHRASES]);
const entries = () =>
  words.map((word, i) => ({
    word,
    source: LEARNED.has(word) ? "learned" : "manual",
    createdAt: sqlTime(Date.now() - (word === "gonestly" ? 1 : 30 + i) * DAY),
  }));

let wordUsage = { available: false, reason: "history-off" };
const renames = [];
let renameAnswer = null;

let dom;
let layoutWidth = 1200;
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      getDictionary: async () => [...words],
      getDictionaryEntries: async () => entries(),
      getDictionaryPins: async () => ["openwhispr"],
      listDictionarySuggestions: async () => ({ success: true, suggestions: [], dismissed: 3 }),
      clearDismissedDictionarySuggestions: async () => ({ success: true, cleared: 3 }),
      getDictionaryWordUsage: async () => wordUsage,
      getDictionaryWordEvidence: async (word) =>
        word === "agents-shared"
          ? {
              available: true,
              evidence: [
                {
                  replaced: "agents shared",
                  app: "github.exe",
                  createdAt: sqlTime(Date.now() - 2 * DAY),
                  transcriptionId: 77,
                },
              ],
            }
          : { available: true, evidence: [] },
      getDictionaryCleanupScopeCounts: async () => ({
        available: true,
        days: 90,
        sets: [{ applied: "all", dictations: 120, avgWords: 206 }],
      }),
      renameDictionaryWord: async (from, to) => {
        renames.push([from, to]);
        if (renameAnswer) return renameAnswer;
        words = words.map((word) => (word === from ? to : word));
        return { success: true, changed: true, word: to };
      },
      mergeDictionaryWords: async (from, into) => {
        words = words.filter((word) => word !== from);
        return { success: true, word: into, source: "learned" };
      },
      setDictionarySource: async (list) => ({ success: true, changed: list.length }),
      applyDictionaryChanges: async ({ remove = [] }) => {
        words = words.filter((word) => !remove.includes(word));
        return { success: true, added: 0, removed: remove.length };
      },
      setDictionaryPin: async (word, pinned) => ({
        success: true,
        changed: true,
        pins: pinned ? ["openwhispr", word.toLowerCase()] : ["openwhispr"],
      }),
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
      right: layoutWidth,
      bottom: 800,
      width: layoutWidth,
      height: 800,
      toJSON() {},
    };
  };
  proto.scrollIntoView = () => {};
});

test.after(async () => {
  await dom.close();
});

async function mount(t) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const consoleOutput = captureConsole(t);
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const h = React.createElement;
  const vite = await createRendererServer(t, {
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    // A write's cloud push: nothing to push to here.
    mockModules: {
      "/services/SyncService.js": "export const syncService = { canSync: () => false };",
    },
  });
  await vite.ssrLoadModule("/i18n.ts");
  const { default: DictionaryView } = await vite.ssrLoadModule("/components/DictionaryView.tsx");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useDictionarySourcesStore, refreshDictionarySources } = await vite.ssrLoadModule(
    "/stores/dictionarySourcesStore.ts"
  );
  const { useDictionaryUsageStore } = await vite.ssrLoadModule("/stores/dictionaryUsageStore.ts");
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  const { OPEN_HISTORY_ITEM_EVENT } = await vite.ssrLoadModule("/utils/openHistoryItem.ts");

  useSettingsStore.setState({
    customDictionary: [...words],
    snippets: [],
    useLocalWhisper: false,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "azure-speech",
    cloudTranscriptionModel: "MAI-Transcribe-2",
    azureSpeechEndpoint: "https://res.cognitiveservices.azure.com",
    useCleanupModel: true,
    cleanupDictionaryWords: "all",
    autoLearnMode: "suggest",
  });
  await refreshDictionarySources();
  useDictionaryUsageStore.setState({
    status: "ready",
    reason: null,
    words: [
      { word: "OpenWhispr", heard: 0, written: 6, missedRows: 6 },
      { word: "EngHub", heard: 5, written: 8, missedRows: 3 },
      { word: "the", heard: 2752, written: 2760, missedRows: 0 },
    ],
    missed: new Set(["openwhispr", "enghub"]),
    perDay: 40,
  });

  const opened = [];
  dom.window.addEventListener(OPEN_HISTORY_ITEM_EVENT, (event) => opened.push(event.detail.id));
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
  await act(() => root.render(h(ToastProvider, null, h(DictionaryView))), 60);
  const listbox = () => doc.querySelector("[data-dictionary-list]");
  const row = (word) => doc.querySelector(`[data-dictionary-row="${word}"]`);
  const buttonIn = (scope, text) =>
    [...scope.querySelectorAll("button")].find((button) => button.textContent.trim() === text);
  const key = (target, name, init = {}) =>
    act(() =>
      target.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })
      )
    );
  const click = (target, init = {}) =>
    act(() => target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, ...init })));
  return {
    doc,
    win,
    act,
    listbox,
    row,
    buttonIn,
    key,
    click,
    opened,
    consoleOutput,
    useSettingsStore,
    useDictionarySourcesStore,
    useDictionaryUsageStore,
  };
}

test(
  "the list: chips with counts, send order's cut line, selection and the bulk bar",
  { timeout: 90000 },
  async (t) => {
    const view = await mount(t);
    const { doc, listbox, row, buttonIn, key, click } = view;

    // 206 user words (the assistant's name isn't one); the chips count the whole list.
    const chip = (id) => doc.querySelector(`[data-dictionary-filter="${id}"]`);
    const count = (id) => Number(chip(id).querySelector("span").textContent);
    assert.equal(count("all"), 206);
    assert.equal(count("typed"), 2);
    assert.equal(count("learned"), 204);
    assert.equal(count("pinned"), 1);
    assert.equal(count("notSent"), 7, "past the 199-phrase cap");
    assert.equal(count("addedThisWeek"), 1);
    assert.equal(count("neverHeard"), 203, "neither heard nor written in 90 days");

    // Send order: pinned first, then typed; the line where Azure Speech stops.
    const rows = () => [...doc.querySelectorAll("[data-dictionary-row]")];
    assert.equal(rows()[0].getAttribute("data-dictionary-row"), "OpenWhispr");
    assert.match(rows()[0].textContent, /Sent · #1/);
    const cut = doc.querySelector('[data-dictionary-divider="notSent"]');
    assert.match(cut.textContent, /Not sent beyond here · 7 words aren't sent/);
    const afterCut = rows().slice(rows().length - 7);
    assert.ok(afterCut.every((element) => element.getAttribute("data-coverage") === "notSent"));
    assert.match(row("OpenWhispr").textContent, /heard 0 · written 6/);
    assert.match(row("gonestly").textContent, /added 1d/);

    // A filter, then search.
    await click(chip("notSent"));
    assert.equal(rows().length, 7);
    assert.equal(doc.querySelector("[data-dictionary-divider]"), null, "nothing sent above");
    await click(chip("all"));
    const search = doc.querySelector('input[type="search"]');
    await view.act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        view.win.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(search, "AGENTS");
      search.dispatchEvent(new view.win.Event("input", { bubbles: true }));
    });
    assert.deepEqual(
      rows().map((element) => element.getAttribute("data-dictionary-row")),
      ["agents-shared", "agentsshared"]
    );

    // Space selects the focused row; Shift-click selects a range.
    await view.act(() => listbox().focus());
    await key(listbox(), "ArrowDown");
    assert.equal(listbox().getAttribute("aria-activedescendant"), rows()[1].id);
    await key(listbox(), " ");
    assert.equal(rows()[1].getAttribute("aria-selected"), "true");
    let bar = doc.querySelector("[data-dictionary-bulk]");
    assert.match(bar.textContent, /1 selected/);
    await view.act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        view.win.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(search, "");
      search.dispatchEvent(new view.win.Event("input", { bubbles: true }));
    });
    await click(row("gonestly").querySelector("span[aria-hidden]"), { shiftKey: true });
    bar = doc.querySelector("[data-dictionary-bulk]");
    assert.match(bar.textContent, /2 selected/, "agentsshared through gonestly");

    // Mark typed sends only learned words; Remove asks first.
    await click(buttonIn(bar, "Mark typed"));
    const sourceCall = dom.calls.filter(([name]) => name === "setDictionarySource").at(-1);
    assert.deepEqual(sourceCall[1], [["agentsshared", "gonestly"], "manual"]);
    await click(buttonIn(bar, "Remove"));
    const dialog = doc.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /Remove 2 words\?/);
    await click(buttonIn(dialog, "Remove"), {});
    await view.act(() => settle(60));
    const removeCall = dom.calls.filter(([name]) => name === "applyDictionaryChanges").at(-1);
    assert.deepEqual(removeCall[1][0].remove, ["agentsshared", "gonestly"]);
    assert.equal(doc.querySelector("[data-dictionary-bulk]"), null, "the selection went with them");

    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test(
  "a word's detail: its sections, Open in History, similar words, rename and merge",
  { timeout: 90000 },
  async (t) => {
    words = [...BASE_WORDS, ...PHRASES];
    layoutWidth = 1200;
    const view = await mount(t);
    const { doc, listbox, row, buttonIn, key, click } = view;
    const detail = () => doc.querySelector("[data-dictionary-detail]");

    // Counts unavailable for this word: said so, never zeros.
    await click(row("agents-shared"));
    assert.ok(detail(), "beside the list");
    assert.equal(detail().closest("aside").parentElement.querySelector("[inert]"), null);
    assert.match(
      detail().textContent,
      /Heard and written are counted from local History, which is off\./
    );
    assert.match(detail().textContent, /Where it goes/);
    assert.match(detail().textContent, /Sent, likely read · #\d+ in send order/);
    assert.match(detail().textContent, /Yes, with all words/);
    assert.match(detail().textContent, /You changed “agents shared” to it in github\.exe/);
    await click(buttonIn(detail(), "Open in History"));
    assert.deepEqual(view.opened, [77]);
    const similar = detail().querySelector("[data-dictionary-similar]");
    assert.match(similar.textContent, /agentsshared/);
    assert.match(similar.textContent, /Same word, other spelling/);

    // A similar word opens; Esc closes and focus returns to the list.
    await click(buttonIn(similar, "agentsshared"));
    assert.match(detail().querySelector("h2").textContent, /agentsshared/);
    await key(detail(), "Escape");
    assert.equal(detail(), null);
    await view.act(() => settle(40));
    assert.equal(doc.activeElement, listbox());
    assert.match(listbox().getAttribute("aria-activedescendant"), /dictionary-row/);

    // Counts available: the weekly chart.
    wordUsage = {
      available: true,
      days: 90,
      weeks: Array.from({ length: 13 }, (_, i) => ({
        start: new Date(Date.now() - (13 - i) * 7 * DAY).toISOString(),
        heard: i % 3,
        written: i % 4,
        missedRows: 0,
      })),
    };
    await key(listbox(), "Home");
    await key(listbox(), "Enter");
    assert.ok(detail().querySelector("[data-dictionary-usage-chart]"));
    assert.match(detail().textContent, /heard 0 · written 6/);
    assert.match(detail().textContent, /Speech often misses it/);

    // Rename in place; a clash offers a merge.
    await click(buttonIn(detail(), "Edit spelling"));
    const input = detail().querySelector("input");
    await view.act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        view.win.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(input, "OpenWhisper");
      input.dispatchEvent(new view.win.Event("input", { bubbles: true }));
    });
    await key(input, "Enter");
    await view.act(() => settle(60));
    assert.deepEqual(renames.at(-1), ["OpenWhispr", "OpenWhisper"]);
    assert.match(detail().querySelector("h2").textContent, /OpenWhisper/, "the detail follows");

    renameAnswer = { success: false, code: "EXISTS", existing: "EngHub" };
    await click(buttonIn(detail(), "Edit spelling"));
    const again = detail().querySelector("input");
    await view.act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        view.win.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(again, "enghub");
      again.dispatchEvent(new view.win.Event("input", { bubbles: true }));
    });
    await key(again, "Enter");
    await view.act(() => settle(60));
    const merge = doc.querySelector('[role="dialog"]');
    assert.match(merge.textContent, /“EngHub” is already in your dictionary/);
    await click(buttonIn(merge, "Merge"));
    await view.act(() => settle(60));
    assert.deepEqual(dom.calls.filter(([name]) => name === "mergeDictionaryWords").at(-1)[1], [
      "OpenWhisper",
      "EngHub",
    ]);
    renameAnswer = null;
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test(
  "narrow: the detail opens over the list, which goes inert; unavailable counts",
  { timeout: 90000 },
  async (t) => {
    words = [...BASE_WORDS, ...PHRASES];
    layoutWidth = 700;
    wordUsage = { available: false, reason: "history-off" };
    const view = await mount(t);
    const { doc, row, click, key } = view;
    await view.act(() =>
      view.useDictionaryUsageStore.setState({
        status: "unavailable",
        reason: "history-off",
        words: [],
        missed: null,
        perDay: null,
      })
    );
    // Without counts: no Never heard chip, and "—" for heard/written.
    assert.equal(doc.querySelector('[data-dictionary-filter="neverHeard"]'), null);
    assert.match(row("EngHub").textContent, /—/);

    await click(row("EngHub"));
    const detail = doc.querySelector("[data-dictionary-detail]");
    assert.ok(detail.querySelector("[data-usage-unavailable]"));
    assert.equal(
      doc.querySelector("[data-dictionary-scroller]").hasAttribute("inert"),
      true,
      "the list behind is inert"
    );
    await key(detail, "Escape");
    assert.equal(doc.querySelector("[data-dictionary-detail]"), null);
    assert.equal(doc.querySelector("[data-dictionary-scroller]").hasAttribute("inert"), false);
    layoutWidth = 1200;
  }
);

test("Where it goes and the suggestions' mirror", { timeout: 90000 }, async (t) => {
  words = [...BASE_WORDS, ...PHRASES];
  const view = await mount(t);
  const { doc, buttonIn, click } = view;
  const where = doc.querySelector("[data-dictionary-where]");
  const speech = where.querySelector('[data-where-cell="speech"]');
  assert.match(speech.textContent, /Speech-to-text · Azure Speech/);
  assert.match(speech.textContent, /199 of 199 phrases/);
  assert.match(speech.textContent, /7 aren't sent/);
  const cleanup = where.querySelector('[data-where-cell="cleanup"]');
  assert.match(cleanup.textContent, /≈ \d+ tokens every cleanup/);
  assert.match(cleanup.textContent, /Sends: All words/);
  assert.match(cleanup.textContent, /tokens a month/);

  await click(buttonIn(where, "Where it goes"));
  const details = doc.querySelector("[data-dictionary-where-details]");
  assert.ok(details.querySelector('[data-cleanup-dictionary="typedPinned"]'), "the setting");
  await view.act(() => settle(40));
  assert.match(
    details.querySelector("[data-dictionary-scope-counts]").textContent,
    /All words120 dictations · 206\.0 words on average/
  );

  // The suggestions: nothing waiting, the auto-learn mirror and Forget dismissed.
  const suggestions = doc.querySelector('[data-dictionary-suggestions="empty"]');
  assert.ok(suggestions.querySelector('[data-auto-learn-mode="suggest"]'));
  await click(suggestions.querySelector("[data-forget-dismissed]"));
  assert.ok(dom.calls.some(([name]) => name === "clearDismissedDictionarySuggestions"));
  assert.deepEqual(view.consoleOutput.errors, []);
});
