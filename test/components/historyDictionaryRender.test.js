const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// History's Stage A dictionary, rendered (happy-dom, stubbed preload): the
// "Dictionary fixed" chip and "📖 n fixed" badge, the "Show in History" word
// as a removable chip, "Dictionary in this dictation" (kinds, what speech
// wrote, who fixed it, the glossary rule offer with its evidence, Open in
// Dictionary), the final text's underlines, the cleanup step's marked
// dictionary words, and what a dictionary or snippet change does to loaded
// pages (a dictionary filter starts over; otherwise only the badges are read
// again; a stale later page starts over). Synthetic text only.

const RAW = "littlebuddy ping ash varia about kusto";
const GLOSSED = "Little Buddy ping ash varia about kusto";
const FINAL = "Little Buddy, ping Aishwaria about Kusto.";

const row = (id, extra = {}) => ({
  id,
  timestamp: null,
  status: "completed",
  errorCode: null,
  preview: `Dictation ${id}`,
  hasAudio: false,
  audioDurationMs: null,
  routeKind: null,
  app: null,
  marks: null,
  rating: null,
  dictionaryFixes: 0,
  ...extra,
});

// 120 rows, newest first (one a minute); every third has a dictionary fix.
const stamp = (i) => {
  const minutes = 1200 - i;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `2026-10-24 ${hh}:${mm}:00`;
};
const ALL = Array.from({ length: 120 }, (_, i) =>
  row(500 - i, { timestamp: stamp(i), dictionaryFixes: i % 3 === 0 ? (i === 0 ? 2 : 1) : 0 })
);

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

const fixAt = (text, word) => ({
  start: text.indexOf(word),
  end: text.indexOf(word) + word.length,
});
const ITEM = {
  success: true,
  item: {
    id: 500,
    timestamp: "2026-10-24 10:59:00",
    status: "completed",
    text: FINAL,
    rawText: RAW,
    errorCode: null,
    errorMessage: null,
    hasAudio: false,
    audioDurationMs: null,
    routeKind: null,
    provider: null,
    model: null,
  },
  status: "captured",
  route: "cleanup",
  context: { targetApp: "Teams.exe" },
  steps: [
    step("stt", RAW),
    step("glossary", GLOSSED, {
      detail: {
        revision: 1,
        rulesFired: [{ ruleId: "r1", from: "littlebuddy", to: "Little Buddy", index: 0 }],
      },
    }),
    step("cleanup", FINAL),
  ],
  revision: "rev",
  owner: "tag",
  feedback: null,
  dictionaryAligned: true,
  dictionary: [
    {
      word: "Little Buddy",
      appearances: [
        {
          kind: "fix",
          ...fixAt(FINAL, "Little Buddy"),
          speechWrote: "littlebuddy",
          by: "glossary",
        },
      ],
    },
    {
      word: "Aishwaria",
      appearances: [
        { kind: "fix", ...fixAt(FINAL, "Aishwaria"), speechWrote: "ash varia", by: "cleanup" },
      ],
    },
    {
      word: "Kusto",
      appearances: [{ kind: "ok", ...fixAt(FINAL, "Kusto"), speechWrote: null, by: null }],
    },
  ],
};

let generation = 1;
const requests = [];
let dom;
const listeners = {};
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      listHistory: async (request) => {
        requests.push(request);
        const filters = request.filters ?? {};
        const dictionaryFiltered = filters.dictionaryFixed || filters.dictionaryWord;
        if (dictionaryFiltered && request.cursor && request.generation !== generation) {
          return { success: true, stale: true, rows: [], nextCursor: null, generation };
        }
        let rows = ALL;
        if (filters.dictionaryFixed)
          rows = rows.filter((candidate) => candidate.dictionaryFixes > 0);
        if (filters.dictionaryWord) rows = rows.filter((candidate) => candidate.id % 2 === 0);
        const { cursor, limit = 50 } = request;
        if (cursor) {
          rows = rows.filter(
            (candidate) =>
              candidate.timestamp < cursor.timestamp ||
              (candidate.timestamp === cursor.timestamp && candidate.id < cursor.id)
          );
        }
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          success: true,
          rows: page,
          nextCursor:
            rows.length > limit && last ? { timestamp: last.timestamp, id: last.id } : null,
          generation,
        };
      },
      getHistoryApps: async () => ({ success: true, apps: [] }),
      getHistoryItem: async (id) => (id === 500 ? ITEM : { success: false, code: "NOT_FOUND" }),
      getHistoryDictionaryFixes: async (ids) => ({
        success: true,
        generation,
        fixes: Object.fromEntries(ids.map((id) => [String(id), id === 500 ? 3 : 0])),
      }),
      getDictionarySpeechVariants: async (word, options) => ({
        available: true,
        generation,
        variants: [],
        requested:
          word === "Aishwaria"
            ? { spelling: options?.spelling, count: 3, keptInFinal: 0 }
            : { spelling: options?.spelling, count: 2, keptInFinal: 0 },
      }),
    },
    storage: { agentName: "Assistant" },
  });
  const api = dom.window.electronAPI;
  dom.window.electronAPI = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name === "string" && /^on[A-Z]/.test(name)) {
          return (callback) => {
            (listeners[name] ??= []).push(callback);
            return () => {
              listeners[name] = listeners[name].filter((entry) => entry !== callback);
            };
          };
        }
        return api[name];
      },
    }
  );
  const proto = dom.window.HTMLElement.prototype;
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => 1200 });
  proto.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 800,
    toJSON() {},
  });
  proto.scrollTo = () => {};
  proto.scrollIntoView = () => {};
});

test.after(async () => {
  await dom.close();
});

const emit = (name, payload) => {
  for (const callback of listeners[name] ?? []) callback(payload);
};

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
  const { useGlossaryStore } = await vite.ssrLoadModule("/stores/glossaryStore.ts");
  const { useDictionaryTidyStore } = await vite.ssrLoadModule("/stores/dictionaryTidyStore.ts");
  const { OPEN_DICTIONARY_WORD_EVENT } = await vite.ssrLoadModule("/utils/openDictionaryWord.ts");
  useSettingsStore.setState({ dataRetentionEnabled: true });
  useGlossaryStore.setState({
    loaded: true,
    revision: 2,
    rules: [
      {
        id: "r1",
        canonical: "Little Buddy",
        spellings: [{ text: "littlebuddy", scope: "anywhere" }],
        apps: [],
        enabled: true,
        revision: 1,
      },
    ],
  });
  useDictionaryTidyStore.setState({ commonWords: new Set(["ash", "the"]) });
  const openedWords = [];
  dom.window.addEventListener(OPEN_DICTIONARY_WORD_EVENT, (event) =>
    openedWords.push(event.detail.word)
  );

  const doc = dom.window.document;
  const win = dom.window;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
    store.useHistoryViewStore.setState({
      query: "",
      filter: "all",
      app: null,
      dictionaryWord: null,
      selectedId: null,
    });
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
    80
  );
  return {
    doc,
    win,
    act,
    store,
    openedWords,
    consoleOutput,
    click: (target) =>
      act(() =>
        target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }))
      ),
    buttonIn: (scope, text) =>
      [...scope.querySelectorAll("button")].find((button) => button.textContent.trim() === text),
    options: () => [...doc.querySelectorAll('[role="option"]')],
  };
}

test(
  "the list's chip and badge, the card, underlines and the cleanup step's marks",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    const { doc } = v;
    // The badge on rows with dictionary fixes.
    const first = v.options()[0];
    assert.match(first.querySelector("[data-dictionary-fixes]").textContent, /📖2 fixed/);
    assert.equal(v.options()[1].querySelector("[data-dictionary-fixes]"), null);

    // The detail: underlines in the final text, named for the keyboard and screen readers.
    const final = doc.querySelector("[data-history-final-text]");
    assert.equal(
      final.textContent.startsWith(FINAL),
      true,
      "the text a selection copies is the text"
    );
    const marks = [...final.querySelectorAll("[data-dictionary-underline]")];
    assert.deepEqual(
      marks.map((mark) => [mark.textContent, mark.getAttribute("data-dictionary-underline")]),
      [
        ["Little Buddy", "fix"],
        ["Aishwaria", "fix"],
        ["Kusto", "ok"],
      ]
    );
    for (const mark of marks) {
      assert.equal(mark.getAttribute("tabindex"), "0");
      const described = doc.getElementById(mark.getAttribute("aria-describedby"));
      assert.match(
        described.textContent,
        mark.getAttribute("data-dictionary-underline") === "ok"
          ? /Dictionary word: speech got it/
          : /Dictionary word: fixed after speech/
      );
    }

    // The card.
    const card = doc.querySelector("[data-history-dictionary]");
    assert.match(card.textContent, /Dictionary in this dictation/);
    assert.match(card.textContent, /Your dictionary words, as the dictionary is now/);
    const word = (text) => card.querySelector(`[data-history-dictionary-word="${text}"]`);
    assert.match(
      word("Little Buddy").textContent,
      /Speech wrote littlebuddy, fixed after speech by the glossary/
    );
    assert.match(word("Little Buddy").textContent, /The glossary handles this/);
    assert.match(
      word("Aishwaria").textContent,
      /Speech wrote ash varia, fixed after speech by cleanup · 3 times/
    );
    assert.match(word("Kusto").textContent, /Speech got it/);
    assert.match(word("Kusto").textContent, /Speech wrote it; nothing changed it/);
    assert.equal(word("Kusto").querySelector("button")?.textContent.includes("glossary"), false);
    assert.match(card.textContent, /named only when this dictation's recorded steps show which/);

    // The glossary rule from what speech wrote, with its evidence.
    const calls = () =>
      dom.calls.filter(([name]) => name === "getDictionarySpeechVariants").map(([, args]) => args);
    assert.ok(
      calls().some(([w, options]) => w === "Aishwaria" && options.spelling === "ash varia")
    );
    await v.click(v.buttonIn(word("Aishwaria"), "Make a glossary rule"));
    const dialog = doc.querySelector('[role="dialog"]');
    assert.equal(dialog.querySelector("#glossary-canonical").value, "Aishwaria");
    assert.equal(dialog.querySelector('input[aria-label="Spelling"]').value, "ash varia");
    // Never kept as written, and not everyday words: anywhere, and it says why.
    assert.match(dialog.querySelector('[aria-label="Where it applies"]').textContent, /Anywhere/);
    assert.match(
      dialog.querySelector('[data-glossary-offer-notice="anywhere"]').textContent,
      /“ash varia” never stayed as written in your final text/
    );
    await v.click(v.buttonIn(dialog, "Cancel"));

    // Open in Dictionary.
    await v.click(v.buttonIn(word("Kusto"), "Open in Dictionary"));
    assert.deepEqual(v.openedWords, ["Kusto"]);

    // The cleanup step's changes mark the dictionary word it put in.
    const inserted = [...doc.querySelectorAll("ins[data-dictionary-insert]")].map(
      (node) => node.textContent
    );
    assert.ok(
      inserted.some((text) => text.includes("Aishwaria")),
      inserted.join(" | ")
    );
    assert.ok(!inserted.some((text) => text.includes("Kusto")), "speech got Kusto: not marked");

    // The chip asks main for rows with a fix.
    const chip = doc.querySelector('[data-history-filter="dictionaryFixed"]');
    assert.match(chip.textContent, /Dictionary fixed/);
    await v.click(chip);
    assert.equal(chip.getAttribute("aria-pressed"), "true");
    assert.equal(requests.at(-1).filters.dictionaryFixed, true);
    assert.ok(v.options().every((option) => option.querySelector("[data-dictionary-fixes]")));
    assert.deepEqual(v.consoleOutput.errors, []);
  }
);

test(
  "Show in History's word, a removable chip; dictionary and snippet changes over loaded pages",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    const { doc, store } = v;
    // Without a dictionary filter: a dictionary change re-reads the badges, nothing reloads.
    const listed = requests.length;
    await v.act(() => emit("onDictionaryUpdated", []), 60);
    assert.equal(requests.length, listed, "the list stays");
    const fixesCall = dom.calls.filter(([name]) => name === "getHistoryDictionaryFixes").at(-1);
    assert.equal(fixesCall[1][0].length, 50, "the loaded rows' badges");
    assert.match(v.options()[0].querySelector("[data-dictionary-fixes]").textContent, /3 fixed/);

    // "Show in History": only that word's rows, shown as a chip.
    await v.act(() => store.showHistoryForDictionaryWord("Kusto"), 60);
    assert.equal(requests.at(-1).filters.dictionaryWord, "Kusto");
    assert.equal(requests.at(-1).cursor, null);
    const wordChip = doc.querySelector("[data-history-word-filter]");
    assert.match(wordChip.textContent, /With “Kusto”/);

    const scroll = async () => {
      const listbox = doc.querySelector('[role="listbox"]');
      listbox.scrollTop = 0;
      await v.act(() => listbox.dispatchEvent(new v.win.Event("scroll")), 30);
      // Near the end of 50 loaded rows (60 px each, an 800 px view).
      listbox.scrollTop = 2600;
      await v.act(() => listbox.dispatchEvent(new v.win.Event("scroll")), 60);
    };
    // The generation moves before the next page is asked for: that page is
    // stale, and the list starts over from the first page.
    generation = 2;
    const staleFrom = requests.length;
    await scroll();
    const after = requests.slice(staleFrom);
    const stalePage = after.findIndex((request) => request.cursor !== null);
    assert.ok(stalePage >= 0, "the later page was asked for");
    assert.equal(after[stalePage].generation, 1, "with the first page's generation");
    assert.ok(
      after.slice(stalePage + 1).some((request) => request.cursor === null),
      "then the first page again"
    );

    // Several pages loaded, then a snippet changes: the list starts over.
    await scroll();
    assert.ok(
      requests.filter((request) => request.cursor && request.generation === 2).length >= 1,
      "a later page under the new generation"
    );
    const before = requests.length;
    await v.act(() => emit("onSnippetsUpdated", []), 60);
    const restarted = requests.slice(before);
    assert.ok(restarted.length >= 1);
    assert.equal(restarted[0].cursor, null, "from the first page");
    assert.equal(restarted[0].filters.dictionaryWord, "Kusto");

    // The chip's ✕ clears the word.
    await v.click(doc.querySelector("[data-history-word-filter] button"));
    assert.equal(store.useHistoryViewStore.getState().dictionaryWord, null);
    assert.equal(requests.at(-1).filters.dictionaryWord, undefined);
    assert.deepEqual(v.consoleOutput.errors, []);
  }
);
