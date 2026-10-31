const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// Categories on the Dictionary page (Dictionary v2, Stage C), rendered in
// happy-dom with a stubbed preload that plays main's stored choices: the
// category column's pill and its menu (a pick is the user's, Automatic
// removes it), the category chips with counts, the bulk bar's Set category,
// the word panel's pill and cleanup line, "Sort into categories" (the cards,
// the unsorted words' picks, Ask a model with its request canary, the
// proposals, Accept, Accept all keeping a choice of yours, ✕, Esc) and the
// cleanup settings mirrored in "Where it goes". Synthetic words only.

const DAY = 24 * 60 * 60 * 1000;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const CANARY = "qxzcanary";

const WORDS = ["Dmitry", "Kusto", "PR", "the", "groq", "worktree", "EngHub", "Janitorial"];
const STORED = [
  { key: "kusto", category: "work", source: "model" },
  { key: "enghub", category: "people", source: "user" },
];

let main;
let copilotReply = null;
const copilotCalls = [];

function resetMain() {
  main = { categories: new Map(STORED.map((row) => [row.key, row])) };
}
resetMain();

function storedList() {
  return [...main.categories.values()].sort((a, b) => a.key.localeCompare(b.key));
}

let dom;
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      getDictionary: async () => [...WORDS],
      getDictionaryEntries: async () =>
        WORDS.map((word) => ({ word, source: "manual", createdAt: sqlTime(Date.now() - 9 * DAY) })),
      getDictionaryPins: async () => [],
      getDictionaryCategories: async () => storedList(),
      setDictionaryCategories: async (items) => {
        let changed = 0;
        const results = items.map((item) => {
          const key = item.word.trim().toLowerCase();
          if (!WORDS.some((word) => word.toLowerCase() === key)) {
            return { ok: false, code: "NOT_IN_DICTIONARY" };
          }
          if (item.category === null) {
            if (main.categories.delete(key)) changed += 1;
          } else {
            main.categories.set(key, { key, category: item.category, source: item.source });
            changed += 1;
          }
          return { ok: true };
        });
        return { success: true, changed, results, categories: storedList() };
      },
      // Never part of a category review: History, evidence, suggestions.
      listDictionarySuggestions: async () => ({
        success: true,
        suggestions: [
          {
            id: 1,
            word: `${CANARY}suggested`,
            times: 2,
            createdAt: sqlTime(Date.now()),
            updatedAt: sqlTime(Date.now()),
            evidence: [{ replaced: `${CANARY}replaced`, app: `${CANARY}.exe`, transcriptionId: 3 }],
          },
        ],
        dismissed: 0,
      }),
      getDictionaryTidyInputs: async () => ({
        available: true,
        days: 90,
        rows: 10,
        frequentTokens: [{ token: `${CANARY}token`, rows: 9 }],
        adjacency: [],
      }),
      getCopilotAuthStatus: async () => ({ configured: true, state: "signedIn", login: "x" }),
      processCopilotReasoning: async (text, model, agentName, config) => {
        copilotCalls.push({ text, model, agentName, config });
        return copilotReply
          ? copilotReply(text, config)
          : { success: true, text: '{"proposals":[]}' };
      },
    },
    storage: { agentName: "Assistant", _llmScopeKeysMigrated: "1" },
  });
  const proto = dom.window.HTMLElement.prototype;
  proto.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      width: 1200,
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
  resetMain();
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
  const { useDictionaryCategoriesStore, loadDictionaryCategoryWords } = await vite.ssrLoadModule(
    "/stores/dictionaryCategoriesStore.ts"
  );
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");

  useSettingsStore.setState({
    customDictionary: [...WORDS],
    snippets: [],
    useLocalWhisper: false,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-4o-transcribe",
    useCleanupModel: true,
    cleanupMode: "providers",
    cleanupProvider: "copilot",
    cleanupModel: "claude-haiku-5.5",
    cleanupDictionaryWords: "all",
    cleanupDictionaryGrouping: false,
    autoLearnMode: "suggest",
    uiLanguage: "en",
  });
  await refreshDictionarySources();
  useDictionaryUsageStore.setState({
    status: "unavailable",
    reason: "history-off",
    words: [],
    missed: null,
    perDay: null,
  });
  await loadDictionaryCategoryWords();

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
  const opened = [];
  await act(
    () =>
      root.render(
        h(ToastProvider, null, h(DictionaryView, { onOpenSettings: (to) => opened.push(to) }))
      ),
    120
  );
  await act(() => settle(60), 60);
  const until = async (done, ms = 15000) => {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await act(() => settle(50), 50);
  };
  await until(() => useDictionaryCategoriesStore.getState().ready);
  assert.equal(useDictionaryCategoriesStore.getState().ready, true, "categories ready");
  const click = (target, init = {}) =>
    act(() => target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, ...init })));
  const key = (target, name, init = {}) =>
    act(() =>
      target.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })
      )
    );
  const openMenu = (trigger) => key(trigger, "Enter");
  const row = (word) => doc.querySelector(`[data-dictionary-row="${word}"]`);
  const pill = (scope, word) => scope.querySelector(`[data-category-pill="${word}"]`);
  const rows = () =>
    [...doc.querySelectorAll("[data-dictionary-row]")].map((el) =>
      el.getAttribute("data-dictionary-row")
    );
  const sets = () => dom.calls.filter(([name]) => name === "setDictionaryCategories");
  return {
    vite,
    doc,
    win,
    act,
    click,
    key,
    openMenu,
    row,
    pill,
    rows,
    sets,
    until,
    opened,
    consoleOutput,
    useSettingsStore,
    useDictionaryCategoriesStore,
  };
}

test(
  "chips count each category and filter the list; a row's pill picks and resets a category",
  { timeout: 90000 },
  async (t) => {
    const view = await mount(t);
    const { doc } = view;
    const chip = (option) => doc.querySelector(`[data-dictionary-category-filter="${option}"]`);
    assert.match(chip("all").textContent, /All8/);
    assert.match(chip("people").textContent, /People3/);
    assert.match(chip("work").textContent, /Work terms2/);
    assert.match(chip("everyday").textContent, /Everyday words1/);
    assert.match(chip("unsorted").textContent, /Unsorted2/);

    await view.click(chip("people"));
    assert.equal(chip("people").getAttribute("aria-pressed"), "true");
    assert.deepEqual(view.rows().sort(), ["Dmitry", "EngHub", "Janitorial"]);
    await view.click(chip("unsorted"));
    assert.deepEqual(view.rows().sort(), ["groq", "worktree"]);
    await view.click(chip("all"));
    assert.equal(view.rows().length, 8);

    // The pill: category and who decided it.
    const dmitry = () => view.pill(view.row("Dmitry"), "Dmitry");
    assert.equal(dmitry().getAttribute("data-category"), "people");
    assert.equal(dmitry().getAttribute("data-category-source"), "auto");
    assert.match(dmitry().textContent, /People\s*auto/);
    assert.equal(
      view.pill(view.row("Kusto"), "Kusto").getAttribute("data-category-source"),
      "model"
    );
    assert.match(view.pill(view.row("EngHub"), "EngHub").textContent, /People\s*you/);
    assert.match(view.pill(view.row("groq"), "groq").textContent, /Unsorted/);
    assert.match(view.row("Dmitry").getAttribute("aria-label"), /, People$/);

    // Its menu: a pick is the user's choice.
    await view.openMenu(dmitry());
    const work = doc.querySelector('[data-category-option="work"]');
    assert.ok(work, "the menu is open");
    assert.match(
      doc.querySelector('[data-category-option="auto"]').textContent,
      /Automatic \(People\)/
    );
    await view.act(() => work.click(), 60);
    assert.deepEqual(view.sets().at(-1)[1][0], [
      { word: "Dmitry", category: "work", source: "user" },
    ]);
    assert.equal(dmitry().getAttribute("data-category"), "work");
    assert.equal(dmitry().getAttribute("data-category-source"), "user");
    assert.equal(doc.querySelector("[data-dictionary-detail]"), null, "the row didn't open");

    // Automatic removes the stored choice: back to the rules.
    await view.openMenu(dmitry());
    await view.act(() => doc.querySelector('[data-category-option="auto"]').click(), 60);
    assert.deepEqual(view.sets().at(-1)[1][0], [
      { word: "Dmitry", category: null, source: "user" },
    ]);
    assert.equal(dmitry().getAttribute("data-category"), "people");
    assert.equal(dmitry().getAttribute("data-category-source"), "auto");
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test(
  "the bulk bar's Set category stores the user's choice for the selection",
  { timeout: 90000 },
  async (t) => {
    const view = await mount(t);
    const { doc } = view;
    const check = (word) => view.row(word).querySelector('span[aria-hidden="true"]');
    await view.click(check("groq"));
    await view.click(check("worktree"));
    const trigger = doc.querySelector("[data-bulk-set-category]");
    assert.ok(trigger, "the bulk bar shows");
    await view.openMenu(trigger);
    await view.act(() => doc.querySelector('[data-bulk-category="work"]').click(), 80);
    assert.deepEqual(view.sets().at(-1)[1][0], [
      { word: "groq", category: "work", source: "user" },
      { word: "worktree", category: "work", source: "user" },
    ]);
    assert.match(
      doc.querySelector('[data-dictionary-category-filter="unsorted"]').textContent,
      /Unsorted0/
    );
    assert.match(doc.body.textContent, /2 words set to Work terms/);

    // Automatic for the selection.
    await view.openMenu(doc.querySelector("[data-bulk-set-category]"));
    await view.act(() => doc.querySelector('[data-bulk-category="auto"]').click(), 80);
    assert.deepEqual(
      view
        .sets()
        .at(-1)[1][0]
        .map((item) => item.category),
      [null, null]
    );
    assert.match(
      doc.querySelector('[data-dictionary-category-filter="unsorted"]').textContent,
      /Unsorted2/
    );
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test(
  "the word panel: its pill, and the cleanup line for the set and the grouping",
  { timeout: 90000 },
  async (t) => {
    const view = await mount(t);
    const { doc } = view;
    await view.click(view.row("Kusto"));
    const panel = () => doc.querySelector("[data-dictionary-detail]");
    const panelPill = () =>
      panel().querySelector("[data-dictionary-detail-category] [data-category-pill]");
    assert.match(panelPill().textContent, /Work terms\s*model/);
    assert.equal(panelPill().getAttribute("tabindex"), null, "a regular button in the panel");
    assert.match(
      panel().querySelector("[data-dictionary-detail-cleanup]").textContent,
      /Yes, with all words/
    );

    // The panel's menu.
    await view.openMenu(panelPill());
    await view.act(() => doc.querySelector('[data-category-option="people"]').click(), 60);
    assert.deepEqual(view.sets().at(-1)[1][0], [
      { word: "Kusto", category: "people", source: "user" },
    ]);
    assert.match(panelPill().textContent, /People\s*you/);

    // Esc in the pill's menu closes the menu, not the panel.
    await view.openMenu(panelPill());
    const menuItem = doc.querySelector('[data-category-option="work"]');
    assert.ok(menuItem, "the menu is open");
    await view.key(menuItem, "Escape");
    await view.act(() => settle(40), 40);
    assert.equal(doc.querySelector('[data-category-option="work"]'), null, "the menu closed");
    assert.ok(panel(), "Esc in the menu didn't close the panel");

    // "All words except everyday words": an everyday word stays out; others say why they go.
    await view.act(() => view.useSettingsStore.setState({ cleanupDictionaryWords: "noEveryday" }));
    await view.click(view.row("the"));
    assert.equal(
      panel().querySelector("[data-dictionary-detail-cleanup]").textContent,
      "No: “All words except everyday words” leaves out everyday words"
    );
    await view.click(view.row("PR"));
    assert.equal(
      panel().querySelector("[data-dictionary-detail-cleanup]").textContent,
      "Yes: not an everyday word (“All words except everyday words”)"
    );
    // Grouping on: the group it's listed under.
    await view.act(() => view.useSettingsStore.setState({ cleanupDictionaryGrouping: true }));
    assert.equal(
      panel().querySelector("[data-dictionary-detail-group]").textContent,
      "Listed under “Work terms”"
    );
    await view.click(view.row("groq"));
    assert.equal(
      panel().querySelector("[data-dictionary-detail-group]").textContent,
      "Listed under “Other”"
    );
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test(
  "Sort into categories: cards, unsorted picks, Ask a model, Accept, Accept all keeping your choice, ✕, Esc",
  { timeout: 90000 },
  async (t) => {
    copilotCalls.length = 0;
    copilotReply = () => ({
      success: true,
      text:
        "```json\n" +
        JSON.stringify({
          proposals: [
            { word: "Kusto", category: "work", reason: "A query language" },
            { word: "Janitorial", category: "everyday", reason: "An ordinary word" },
            { word: "EngHub", category: "work", reason: "An internal site" },
            { word: "groq", category: "work", reason: "An inference provider" },
            { word: "Nonexistent", category: "work", reason: "Not sent" },
            { word: "PR", category: "products", reason: "Unknown category" },
          ],
        }) +
        "\n```",
    });
    const view = await mount(t);
    const { default: service } = await view.vite.ssrLoadModule("/services/ReasoningService.ts");
    t.after(() => service.destroy());
    const { doc } = view;
    const button = doc.querySelector("[data-categories-open]");
    assert.equal(button.querySelector("[data-categories-unsorted-count]").textContent, "2");
    assert.equal(button.getAttribute("aria-label"), "Sort into categories, 2 unsorted words");
    await view.click(button);
    const sortView = () => doc.querySelector("[data-dictionary-categories]");
    assert.ok(sortView(), "the view replaces the list");
    assert.equal(doc.querySelector("[data-dictionary-list]"), null);
    assert.equal(doc.activeElement, sortView().querySelector("h2"), "focus moves in");

    const count = (key) =>
      sortView().querySelector(`[data-category-card="${key}"] [data-category-count]`).textContent;
    assert.deepEqual(["people", "work", "everyday", "unsorted"].map(count), ["3", "2", "1", "2"]);
    assert.deepEqual(
      [...sortView().querySelectorAll("[data-categories-unsorted-word]")].map((el) =>
        el.getAttribute("data-categories-unsorted-word")
      ),
      ["groq", "worktree"]
    );
    // A pick from the unsorted list is the user's.
    await view.openMenu(view.pill(sortView(), "worktree"));
    await view.act(() => doc.querySelector('[data-category-option="work"]').click(), 60);
    assert.deepEqual(view.sets().at(-1)[1][0], [
      { word: "worktree", category: "work", source: "user" },
    ]);
    assert.equal(sortView().querySelector('[data-categories-unsorted-word="worktree"]'), null);
    assert.equal(count("unsorted"), "1");

    // The notes say what's true now and link to the settings.
    assert.match(
      sortView().querySelector("[data-categories-note-word-set]").textContent,
      /leaves out 1 word .*Now: All words\./
    );
    await view.click(sortView().querySelector("[data-categories-open-grouping]"));
    assert.deepEqual(view.opened, ["cleanup#dictation.cleanup.dictionaryGrouping"]);

    // Ask a model: what it sends, before and after.
    const review = () => sortView().querySelector("[data-categories-review]");
    assert.match(
      review().querySelector("[data-categories-review-estimate]").textContent,
      /Sends your 8 words and their current category, never your dictations\. One request, ≈ [\d,]+ tokens\./
    );
    assert.match(review().textContent, /Cleanup · Claude Haiku 5\.5 · GitHub Copilot/);
    await view.click(review().querySelector("[data-categories-review-ask]"));
    await view.until(() => !review().querySelector("[data-categories-review-cancel]"));
    assert.equal(copilotCalls.length, 1);
    const [call] = copilotCalls;
    assert.equal(JSON.stringify(call).includes(CANARY), false, "only the words and categories");
    assert.deepEqual(call.text.split("\n"), [
      "Columns: word, category, set by",
      '["Dmitry","people","auto"]',
      '["Kusto","work","model"]',
      '["PR","work","auto"]',
      '["the","everyday","auto"]',
      '["groq","unsorted","auto"]',
      '["worktree","work","user"]',
      '["EngHub","people","user"]',
      '["Janitorial","people","auto"]',
    ]);
    assert.match(call.config.systemPrompt, /^You sort the custom dictionary of a dictation app/);
    assert.equal(call.config.redactLogs, true);
    assert.equal(call.config.requireCompleteOutput, true);

    // The proposals: current → proposed, with what each would do.
    const proposals = () => sortView().querySelector("[data-categories-proposals]");
    const status = (word) =>
      proposals()
        .querySelector(`[data-category-proposal="${word}"]`)
        ?.getAttribute("data-proposal-status") ?? null;
    assert.deepEqual(["Kusto", "Janitorial", "EngHub", "groq"].map(status), [
      "same",
      "pending",
      "userKept",
      "pending",
    ]);
    assert.match(proposals().textContent, /4 from Claude Haiku 5\.5 · 4 shown 2 were dropped/);
    assert.match(
      proposals().querySelector('[data-category-proposal="EngHub"]').textContent,
      /Your choice kept/
    );
    assert.match(
      proposals().querySelector('[data-category-proposal="Kusto"]').textContent,
      /No change/
    );
    const before = view.sets().length;
    assert.equal(before, view.sets().length, "nothing stored without a click");

    // Accept one: stored as the model's.
    await view.click(
      proposals().querySelector('[data-category-proposal="Janitorial"] [data-proposal-accept]'),
      {}
    );
    await view.act(() => settle(60), 60);
    assert.deepEqual(view.sets().at(-1)[1][0], [
      { word: "Janitorial", category: "everyday", source: "model" },
    ]);
    assert.equal(status("Janitorial"), "accepted");

    // ✕ dismisses for the session.
    await view.click(
      proposals().querySelector('[data-category-proposal="Kusto"] [data-proposal-dismiss]')
    );
    assert.equal(status("Kusto"), null);

    // Accept all: never over a choice of yours.
    const acceptAll = proposals().querySelector("[data-categories-accept-all]");
    assert.equal(acceptAll.textContent, "Accept all (1)");
    await view.click(acceptAll);
    await view.act(() => settle(60), 60);
    assert.deepEqual(view.sets().at(-1)[1][0], [
      { word: "groq", category: "work", source: "model" },
    ]);
    assert.equal(status("groq"), "accepted");
    assert.equal(status("EngHub"), "userKept", "your choice kept");
    assert.equal(main.categories.get("enghub").category, "people");

    // Esc returns to the list, focus on the button.
    await view.key(sortView().querySelector("h2"), "Escape");
    await view.act(() => settle(40), 40);
    assert.equal(sortView(), null);
    assert.ok(doc.querySelector("[data-dictionary-list]"));
    assert.equal(doc.activeElement, doc.querySelector("[data-categories-open]"));
    copilotReply = null;
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test(
  "the cleanup settings, mirrored in Where it goes: the new word set and the grouping",
  { timeout: 90000 },
  async (t) => {
    const view = await mount(t);
    const { doc } = view;
    const where = doc.querySelector("[data-dictionary-where]");
    const toggle = [...where.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-expanded")
    );
    await view.click(toggle);
    const details = doc.querySelector("[data-dictionary-where-details]");
    const option = details.querySelector('[data-cleanup-dictionary="noEveryday"]');
    assert.match(option.textContent, /All words except everyday words7 words · ≈ \d+ tokens/);
    await view.click(option);
    assert.equal(view.useSettingsStore.getState().cleanupDictionaryWords, "noEveryday");
    assert.equal(dom.window.localStorage.getItem("cleanupDictionaryWords"), "noEveryday");

    const grouping = details.querySelector("[data-cleanup-dictionary-grouping]");
    assert.match(grouping.textContent, /Group dictionary words by category/);
    assert.match(grouping.textContent, /Not used with OpenWhispr Cloud/);
    const swatch = grouping.querySelector('[role="switch"]');
    assert.equal(swatch.getAttribute("aria-checked"), "false");
    await view.click(swatch);
    assert.equal(view.useSettingsStore.getState().cleanupDictionaryGrouping, true);
    assert.equal(dom.window.localStorage.getItem("cleanupDictionaryGrouping"), "true");
    assert.equal(
      grouping.querySelector("[data-cleanup-grouping-counts]").textContent,
      "People 3 · Work terms 2 · Other 2"
    );
    assert.match(where.textContent, /grouped by category/);
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);
