const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// The Dictionary page's Stage A insight, rendered (happy-dom, stubbed
// preload): the usage column ("405 · speech 256 · fixed 149", its two-tone bar)
// and its ⓘ explainer, the "Speech misses it" chip, a word's chart (a
// tooltip on hover and on keyboard focus with the week's own bounds, a click
// that filters "Where it appeared" to that week as a removable chip), the
// dictations it appeared in by kind, with Load more and Show in History,
// "Speech writes it as" with the glossary rule it offers (anywhere only when
// safe) or "The glossary handles this", and what an owner change does to an
// answer still in flight. Synthetic words and text only.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const WORDS = ["Little Buddy", "Shawn", "worktree", "Kusto"];

// 13 weeks ending now, as main anchors them.
const WEEKS = Array.from({ length: 13 }, (_, k) => {
  const start = NOW - (13 - k) * 7 * DAY;
  const end = k === 12 ? NOW : NOW - (12 - k) * 7 * DAY;
  const busy = k === 10;
  return {
    start: new Date(Math.max(start, NOW - 90 * DAY)).toISOString(),
    end: new Date(end).toISOString(),
    heard: busy ? 5 : 0,
    written: busy ? 6 : 0,
    missedRows: busy ? 2 : 0,
    both: busy ? 4 : 0,
    changed: busy ? 1 : 0,
  };
});

const item = (id, extra = {}) => ({
  id,
  at: sqlTime(NOW - id * 3_600_000),
  app: "Teams.exe",
  kinds: ["fix"],
  speechWrote: "LittleBuddy",
  by: "glossary",
  snippet: {
    kind: "fix",
    before: "…can you ping ",
    match: "Little Buddy",
    after: " about the review…",
  },
  ...extra,
});

let occurrenceAnswer = null;
let variantsAnswer = null;

let dom;
const listeners = {};
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      getDictionary: async () => [...WORDS],
      getDictionaryEntries: async () =>
        WORDS.map((word) => ({ word, source: "manual", createdAt: sqlTime(NOW - 40 * DAY) })),
      getDictionaryPins: async () => [],
      listDictionarySuggestions: async () => ({ success: true, suggestions: [], dismissed: 0 }),
      getDictionaryWordUsage: async () => ({ available: true, days: 90, weeks: WEEKS }),
      getDictionaryWordEvidence: async () => ({ available: true, evidence: [] }),
      getDictionaryCleanupScopeCounts: async () => ({ available: true, days: 90, sets: [] }),
      getDictionaryWordOccurrences: async (word, options) =>
        occurrenceAnswer ? occurrenceAnswer(word, options) : defaultOccurrences(options),
      getDictionarySpeechVariants: async (word) =>
        variantsAnswer
          ? variantsAnswer(word)
          : {
              available: true,
              generation: 3,
              variants: [
                { spelling: "LittleBuddy", count: 107, keptInFinal: 0 },
                { spelling: "little", count: 9, keptInFinal: 40 },
                { spelling: "Littbuddy", count: 4, keptInFinal: 0 },
              ],
            },
      saveGlossaryRule: async (rule) => ({
        success: true,
        snapshot: { revision: 9, rules: [{ ...rule, id: "new", revision: 1 }] },
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
  proto.scrollIntoView = () => {};
});

test.after(async () => {
  await dom.close();
});

function defaultOccurrences(options) {
  const kind = options?.kind ?? null;
  const cursor = options?.cursor ?? null;
  if (cursor) {
    return {
      available: true,
      generation: 3,
      items: [
        item(9, {
          kinds: ["ok"],
          speechWrote: null,
          by: null,
          snippet: { kind: "ok", before: "", match: "Little Buddy", after: ", hi." },
        }),
      ],
      nextCursor: null,
      totals: { all: 3, ok: 2, fix: 2, chg: 1 },
    };
  }
  const items =
    kind === "chg"
      ? [
          item(5, {
            kinds: ["chg"],
            speechWrote: null,
            by: null,
            snippet: { kind: "chg", before: "", match: "little buddy", after: " said no" },
          }),
        ]
      : [item(1), item(2, { kinds: ["ok", "fix"], by: null, speechWrote: "Littbuddy", app: null })];
  return {
    available: true,
    generation: 3,
    items,
    nextCursor: kind ? null : { timestamp: sqlTime(NOW - 2 * 3_600_000), id: 2 },
    totals: { all: 3, ok: 2, fix: 2, chg: 1 },
  };
}

const emit = (name, payload) => {
  for (const callback of listeners[name] ?? []) callback(payload);
};

async function mount(t) {
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
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { refreshDictionarySources } = await vite.ssrLoadModule(
    "/stores/dictionarySourcesStore.ts"
  );
  const { useDictionaryUsageStore } = await vite.ssrLoadModule("/stores/dictionaryUsageStore.ts");
  const { useGlossaryStore } = await vite.ssrLoadModule("/stores/glossaryStore.ts");
  const { useDictionaryTidyStore } = await vite.ssrLoadModule("/stores/dictionaryTidyStore.ts");
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  const { OPEN_HISTORY_ITEM_EVENT, OPEN_HISTORY_WORD_EVENT } = await vite.ssrLoadModule(
    "/utils/openHistoryItem.ts"
  );
  useSettingsStore.setState({
    customDictionary: [...WORDS],
    snippets: [],
    useLocalWhisper: false,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "azure-speech",
    cloudTranscriptionModel: "MAI-Transcribe-2",
    useCleanupModel: true,
    cleanupDictionaryWords: "all",
  });
  await refreshDictionarySources();
  useDictionaryUsageStore.setState({
    status: "ready",
    reason: null,
    words: [
      { word: "Little Buddy", heard: 258, written: 405, missedRows: 149, bothRows: 256 },
      { word: "Shawn", heard: 3, written: 14, missedRows: 11, bothRows: 3 },
      { word: "Kusto", heard: 42, written: 44, missedRows: 2, bothRows: 42 },
    ],
    missed: new Set(["little buddy", "shawn", "kusto"]),
    perDay: 40,
  });
  useGlossaryStore.setState({
    loaded: true,
    revision: 4,
    rules: [
      {
        id: "r1",
        canonical: "Little Buddy",
        spellings: [{ text: "littbuddy", scope: "anywhere" }],
        apps: [],
        enabled: true,
        revision: 1,
      },
    ],
  });
  useDictionaryTidyStore.setState({ commonWords: new Set(["little", "buddy", "work", "tree"]) });

  const opened = [];
  const openedWords = [];
  dom.window.addEventListener(OPEN_HISTORY_ITEM_EVENT, (event) => opened.push(event.detail.id));
  dom.window.addEventListener(OPEN_HISTORY_WORD_EVENT, (event) =>
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
  });
  const act = async (fn, ms = 30) => {
    await React.act(async () => {
      await fn();
      await settle(ms);
    });
    await settle();
  };
  await act(() => root.render(h(ToastProvider, null, h(DictionaryView))), 60);
  const fire = (target, type, Ctor = win.MouseEvent, init = {}) =>
    act(() => target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init })));
  return {
    doc,
    win,
    act,
    vite,
    opened,
    openedWords,
    consoleOutput,
    useGlossaryStore,
    row: (word) => doc.querySelector(`[data-dictionary-row="${word}"]`),
    detail: () => doc.querySelector("[data-dictionary-detail]"),
    click: (target) => fire(target, "click"),
    fire,
    buttonIn: (scope, text) =>
      [...scope.querySelectorAll("button")].find((button) => button.textContent.trim() === text),
    calls: (name) => dom.calls.filter(([called]) => called === name).map(([, args]) => args),
  };
}

test(
  "the usage column, its explainer and the Speech misses it chip",
  { timeout: 90000 },
  async (t) => {
    const v = await mount(t);
    const { doc } = v;
    const usage = v.row("Little Buddy").querySelector("[data-dictionary-usage]");
    assert.match(usage.textContent, /405 · speech 256 · fixed 149/);
    assert.match(
      usage.getAttribute("title"),
      /405 dictations: speech got it 256, fixed after speech 149, changed after speech 2/
    );
    const bar = usage.querySelectorAll("span[aria-hidden] > span");
    assert.equal(bar.length, 2, "two tones");
    assert.equal(bar[0].style.width, "63%", "speech got it, green");
    assert.equal(bar[1].style.width, "37%", "fixed after speech, amber");
    assert.match(v.row("worktree").textContent, /not used/);

    const chip = doc.querySelector('[data-dictionary-filter="speechMisses"]');
    assert.match(chip.textContent, /Speech misses it\s*3/);
    await v.click(chip);
    assert.deepEqual(
      [...doc.querySelectorAll("[data-dictionary-row]")].map((row) =>
        row.getAttribute("data-dictionary-row")
      ),
      ["Little Buddy", "Shawn", "Kusto"]
    );
    assert.match(
      doc.querySelector('[data-dictionary-filter="neverHeard"]').textContent,
      /Never used/
    );

    // The ⓘ: a button the keyboard reaches, opening the explainer.
    const info = doc.querySelector("[data-dictionary-list-header] [data-dictionary-usage-info]");
    assert.equal(info.tagName, "BUTTON");
    assert.equal(info.getAttribute("aria-label"), "What these numbers mean");
    assert.equal(info.closest("[aria-hidden]"), null, "not hidden from assistive tech");
    await v.click(info);
    const explainer = doc.querySelector("[data-dictionary-usage-explainer]");
    assert.ok(explainer, "the popover opened");
    assert.match(explainer.textContent, /What “used”, “speech got it” and “fixed” mean/);
    assert.match(explainer.textContent, /Speech got it\(was “heard”\)/);
    assert.match(explainer.textContent, /Fixed after speech/);
    assert.match(explainer.textContent, /Changed after speech/);
    assert.deepEqual(v.consoleOutput.errors, []);
  }
);

test(
  "a word's chart: tooltips on hover and focus, a week's click filters the list with a chip",
  { timeout: 90000 },
  async (t) => {
    const v = await mount(t);
    await v.click(v.row("Little Buddy"));
    const detail = v.detail();
    assert.match(
      detail.textContent,
      /405 dictations · speech got it 256 · fixed after speech 149 · changed after speech 2/
    );
    const bars = [...detail.querySelectorAll("[data-usage-week]")];
    assert.equal(bars.length, 13);
    assert.ok(bars.every((bar) => bar.tagName === "BUTTON"));
    const busy = bars[10];
    const fmt = (iso) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
    const range = `${fmt(WEEKS[10].start)} – ${fmt(new Date(Date.parse(WEEKS[10].end) - 1).toISOString())}`;
    assert.equal(
      busy.getAttribute("aria-label"),
      `Week of ${range}: used 6, speech got it 4, fixed after speech 2, changed after speech 1`
    );

    // Hover shows the tooltip; leaving hides it.
    await v.fire(busy, "mouseover");
    await v.fire(busy, "mouseenter", v.win.MouseEvent, { bubbles: false });
    let tip = detail.querySelector("[data-usage-tooltip]");
    assert.ok(tip, "on hover");
    assert.match(tip.textContent, new RegExp(`Week of ${range}`));
    assert.match(tip.textContent, /Used6Speech got it4Fixed after speech2Changed after speech1/);
    assert.match(tip.textContent, /Click to list these dictations/);
    await v.fire(busy, "mouseout");
    await v.fire(busy, "mouseleave", v.win.MouseEvent, { bubbles: false });
    assert.equal(detail.querySelector("[data-usage-tooltip]"), null);
    // Keyboard focus shows it too.
    await v.act(() => bars[3].focus());
    tip = detail.querySelector("[data-usage-tooltip]");
    assert.ok(tip, "on focus");
    assert.match(tip.textContent, /Used0/);

    // A click lists that week, with its own bounds, as a removable chip.
    const before = v.calls("getDictionaryWordOccurrences").length;
    await v.click(busy);
    assert.equal(busy.getAttribute("aria-pressed"), "true");
    const call = v.calls("getDictionaryWordOccurrences").at(-1);
    assert.ok(v.calls("getDictionaryWordOccurrences").length > before);
    assert.deepEqual(call[1].range, { start: WEEKS[10].start, end: WEEKS[10].end });
    const chip = detail.querySelector("[data-occurrences-week]");
    assert.match(chip.textContent, new RegExp(`Week of ${range}`));
    await v.click(chip.querySelector("button"));
    assert.equal(detail.querySelector("[data-occurrences-week]"), null);
    assert.equal(v.calls("getDictionaryWordOccurrences").at(-1)[1].range, null);
    assert.equal(busy.getAttribute("aria-pressed"), "false");
    assert.deepEqual(v.consoleOutput.errors, []);
  }
);

test(
  "where it appeared: kinds, snippets with what speech wrote, paging, Open and Show in History",
  { timeout: 90000 },
  async (t) => {
    const v = await mount(t);
    await v.click(v.row("Little Buddy"));
    const box = () => v.detail().querySelector("[data-dictionary-occurrences]");
    const segment = (kind) => box().querySelector(`[data-occurrence-segment="${kind}"]`);
    assert.match(segment("all").textContent, /All\s*3/);
    assert.match(segment("fix").textContent, /Fixed after speech\s*2/);
    assert.match(segment("ok").textContent, /Speech got it\s*2/);
    assert.match(segment("chg").textContent, /Changed\s*1/);
    const rows = () => [...box().querySelectorAll("[data-occurrence]")];
    assert.equal(rows().length, 2);
    const first = rows()[0];
    assert.match(first.textContent, /Teams\.exe/);
    assert.match(first.textContent, /by the glossary/);
    assert.equal(first.querySelector("del[data-speech-wrote]").textContent, "LittleBuddy");
    assert.equal(first.querySelector("mark").textContent, "Little Buddy");
    assert.match(first.textContent, /…can you ping LittleBuddy Little Buddy about the review…/);
    const mixed = rows()[1];
    assert.ok(
      mixed.querySelector('[data-kind-tag="ok"]') && mixed.querySelector('[data-kind-tag="fix"]')
    );

    // Open in History; Load more with the cursor; a kind.
    await v.click(first);
    assert.deepEqual(v.opened, [1]);
    await v.click(box().querySelector("[data-occurrences-more]"));
    assert.deepEqual(v.calls("getDictionaryWordOccurrences").at(-1)[1].cursor, {
      timestamp: sqlTime(NOW - 2 * 3_600_000),
      id: 2,
    });
    assert.equal(rows().length, 3);
    assert.equal(box().querySelector("[data-occurrences-more]"), null, "the end");
    await v.click(segment("chg"));
    assert.equal(segment("chg").getAttribute("aria-checked"), "true");
    assert.equal(v.calls("getDictionaryWordOccurrences").at(-1)[1].kind, "chg");
    assert.equal(rows().length, 1);
    assert.equal(
      rows()[0].querySelector('mark[data-occurrence-match="chg"]').textContent,
      "little buddy"
    );

    // Show in History (no count) asks History for this word.
    const show = box().querySelector("[data-show-in-history]");
    assert.equal(show.textContent.trim(), "Show in History");
    await v.click(show);
    assert.deepEqual(v.openedWords, ["Little Buddy"]);

    // Unavailable: says why, as the usage column does.
    occurrenceAnswer = () => ({ available: false, reason: "history-off" });
    await v.click(v.row("Kusto"));
    assert.match(
      v.detail().querySelector("[data-occurrences-unavailable]").textContent,
      /Usage is counted from local History, which is off\./
    );
    occurrenceAnswer = null;
    assert.deepEqual(v.consoleOutput.errors, []);
  }
);

test(
  "speech writes it as: a rule offered with its risk, or the glossary already handles it",
  { timeout: 90000 },
  async (t) => {
    const v = await mount(t);
    await v.click(v.row("Little Buddy"));
    const list = () => v.detail().querySelector("[data-speech-variants]");
    const variant = (spelling) => list().querySelector(`[data-speech-variant="${spelling}"]`);
    assert.match(variant("LittleBuddy").textContent, /LittleBuddy107 dictations/);
    assert.match(
      variant("LittleBuddy").textContent,
      /Never stayed as written in your final text\./
    );
    assert.match(variant("little").textContent, /“little” also stayed as written in 40 dictations/);
    assert.ok(variant("Littbuddy").querySelector("[data-glossary-handles]"), "rule r1 has it");
    assert.match(variant("Littbuddy").textContent, /The glossary handles this/);

    // Safe: never kept, not an everyday word → added to the rule that writes the word, anywhere.
    await v.click(v.buttonIn(variant("LittleBuddy"), "Make a glossary rule"));
    let dialog = v.doc.querySelector('[role="dialog"]');
    assert.equal(dialog.querySelector("#glossary-canonical").value, "Little Buddy");
    const spellings = () =>
      [...dialog.querySelectorAll('input[aria-label="Spelling"]')].map((input) => input.value);
    assert.deepEqual(spellings(), ["littbuddy", "LittleBuddy"]);
    const scopes = () =>
      [...dialog.querySelectorAll('[aria-label="Where it applies"]')].map(
        (node) => node.textContent
      );
    assert.deepEqual(scopes(), ["Anywhere", "Anywhere"]);
    assert.match(
      dialog.querySelector('[data-glossary-offer-notice="anywhere"]').textContent,
      /“LittleBuddy” was added to the glossary rule that already writes this word\. “LittleBuddy” never stayed as written/
    );
    await v.click(v.buttonIn(dialog, "Cancel"));
    assert.deepEqual(v.calls("saveGlossaryRule"), [], "nothing saved");

    // Kept as written 40 times: start of dictation, with the notice.
    await v.click(v.buttonIn(variant("little"), "Make a glossary rule"));
    dialog = v.doc.querySelector('[role="dialog"]');
    assert.deepEqual(scopes(), ["Anywhere", "Start of dictation"]);
    assert.match(
      dialog.querySelector('[data-glossary-offer-notice="kept"]').textContent,
      /also stayed as written in 40 of your dictations, so it starts as a start-of-dictation spelling, in apps you pick/
    );
    await v.click(v.buttonIn(dialog, "Cancel"));

    // The glossary changed: the variants are read again.
    const reads = v.calls("getDictionarySpeechVariants").length;
    await v.act(() => v.useGlossaryStore.setState({ revision: 5 }));
    assert.equal(v.calls("getDictionarySpeechVariants").length, reads + 1);

    // A rule disabled, edited and deleted after the variants were read.
    const handles = (spelling) => !!variant(spelling).querySelector("[data-glossary-handles]");
    const r1 = (extra) => ({
      id: "r1",
      canonical: "Little Buddy",
      spellings: [{ text: "littbuddy", scope: "anywhere" }],
      apps: [],
      enabled: true,
      revision: 2,
      ...extra,
    });
    await v.act(() =>
      v.useGlossaryStore.setState({ revision: 6, rules: [r1({ enabled: false })] })
    );
    assert.equal(handles("Littbuddy"), false, "disabled: offered again");
    await v.act(() =>
      v.useGlossaryStore.setState({
        revision: 7,
        rules: [
          r1({
            spellings: [
              { text: "littbuddy", scope: "anywhere" },
              { text: "LittleBuddy", scope: "anywhere" },
            ],
          }),
        ],
      })
    );
    assert.equal(handles("Littbuddy"), true);
    assert.equal(handles("LittleBuddy"), true, "edited to write it too");
    await v.act(() => v.useGlossaryStore.setState({ revision: 8, rules: [] }));
    assert.equal(handles("Littbuddy"), false, "deleted");
    assert.equal(handles("LittleBuddy"), false);
    assert.equal(v.calls("getDictionarySpeechVariants").length, reads + 4);
    assert.deepEqual(v.consoleOutput.errors, []);
  }
);

test(
  "an owner change drops what was shown and an answer still in flight",
  { timeout: 90000 },
  async (t) => {
    const v = await mount(t);
    await v.click(v.row("Little Buddy"));
    const rows = () => [...v.detail().querySelectorAll("[data-occurrence]")];
    assert.equal(rows().length, 2);
    // The next answer is held; the owner changes meanwhile.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    occurrenceAnswer = () => held;
    await v.act(() => emit("onTranscriptionDeleted", { id: 1 }));
    await v.act(() => settle(30));
    occurrenceAnswer = () => ({
      available: true,
      generation: 4,
      items: [
        item(7, {
          snippet: { kind: "fix", before: "", match: "Little Buddy", after: " (new owner)" },
        }),
      ],
      nextCursor: null,
      totals: { all: 1, ok: 0, fix: 1, chg: 0 },
    });
    await v.act(() => emit("onDictionaryHistoryChanged", { reason: "owner" }), 60);
    assert.deepEqual(
      rows().map((row) => row.getAttribute("data-occurrence")),
      ["7"]
    );
    // The old answer arrives late: dropped.
    await v.act(() => release(defaultOccurrences({})), 60);
    assert.deepEqual(
      rows().map((row) => row.getAttribute("data-occurrence")),
      ["7"]
    );
    occurrenceAnswer = null;
    assert.deepEqual(v.consoleOutput.errors, []);
  }
);

test(
  "Open in Dictionary: History's request opens that word's panel",
  { timeout: 90000 },
  async (t) => {
    const v = await mount(t);
    const { setDictionaryWordRequest, useDictionaryWordRequest } = await v.vite.ssrLoadModule(
      "/utils/openDictionaryWord.ts"
    );
    assert.equal(v.detail(), null);
    // By key: History names the word as the dictionary had it.
    await v.act(() => setDictionaryWordRequest("kusto"), 60);
    assert.match(v.detail().querySelector("h2").textContent, /Kusto/);
    assert.equal(useDictionaryWordRequest.getState().word, null, "taken");
    assert.deepEqual(v.consoleOutput.errors, []);
  }
);
