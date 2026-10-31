const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// Tidy up rendered on the Dictionary page (happy-dom, stubbed preload): the
// toolbar's count, the groups with what starts selected (auto-learned,
// unpinned words only), Apply in one batch through main, Undo and its refusal,
// the History-unavailable state, Esc, and "Ask a model": its request carries
// the dictionary's words and nothing else (a canary in every other source the
// page holds), a stale reply is dropped and Cancel discards a late one.
// Synthetic words only.

const DAY = 24 * 60 * 60 * 1000;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const CANARY = "qxzcanary";

// word, source, heard, written, missed, age in days
const FIXTURE = [
  ["OpenWhispr", "manual", 0, 6, 6, 90],
  ["the", "learned", 2752, 2760, 0, 60],
  ["What", "learned", 877, 880, 0, 60],
  ["gonestly", "learned", 0, 0, 0, 40],
  ["aessions", "learned", 0, 1, 0, 60],
  ["approverl", "learned", 0, 0, 0, 60],
  ["approver", "manual", 3, 5, 2, 60],
  ["then...ahh", "learned", 0, 0, 0, 60],
  ["8/5", "learned", 0, 0, 0, 60],
  ["agents-shared", "learned", 4, 10, 6, 60],
  ["agentsshared", "learned", 0, 1, 1, 60],
  ["Little", "learned", 280, 300, 20, 60],
  ["Buddy", "learned", 293, 293, 0, 60],
  ["soon", "learned", 0, 0, 0, 60],
  ["model", "manual", 30, 30, 0, 60],
];
const SOURCE = new Map(FIXTURE.map(([word, source]) => [word, source]));
const AGE = new Map(FIXTURE.map(([word, , , , , age]) => [word, age]));
const USAGE = FIXTURE.map(([word, , heard, written, missedRows]) => ({
  word,
  heard,
  written,
  missedRows,
}));

let words = FIXTURE.map(([word]) => word);
let tidyInputs = {
  available: true,
  days: 90,
  rows: 4326,
  frequentTokens: [
    { token: "honestly", rows: 12 },
    { token: "sessions", rows: 169 },
    { token: `${CANARY}token`, rows: 50 },
  ],
  adjacency: [
    { a: "Little", b: "Buddy", together: 255, rarerRows: 293 },
    { a: `${CANARY}a`, b: `${CANARY}b`, together: 9, rarerRows: 9 },
  ],
};
let undoAnswer = null;
let snapshot = null;
let copilotReply = null;
const copilotCalls = [];

function applyOps(ops) {
  snapshot = [...words];
  const results = ops.map((op) => {
    const restore = (word) => ({
      word,
      source: SOURCE.get(word) ?? "manual",
      createdAt: sqlTime(Date.now() - (AGE.get(word) ?? 1) * DAY),
      pinned: false,
    });
    switch (op.kind) {
      case "remove": {
        const gone = op.words.filter((word) => words.includes(word));
        words = words.filter((word) => !gone.includes(word));
        return {
          ok: true,
          kind: "remove",
          removed: gone.length,
          undo: [{ restore: gone.map(restore) }],
        };
      }
      case "merge":
        words = words.filter((word) => word !== op.from);
        return {
          ok: true,
          kind: "merge",
          merged: 1,
          undo: [{ restore: [restore(op.from)], into: [op.into] }],
        };
      case "respell":
        if (words.includes(op.to)) {
          words = words.filter((word) => word !== op.from);
          return {
            ok: true,
            kind: "respell",
            merged: 1,
            undo: [{ restore: [restore(op.from)], into: [op.to] }],
          };
        }
        words = words.map((word) => (word === op.from ? op.to : word));
        return {
          ok: true,
          kind: "respell",
          renamed: 1,
          undo: [{ rename: { from: op.to, to: op.from } }],
        };
      case "add-phrase":
        words = [...words.filter((word) => !op.parts.includes(word)), op.phrase];
        return {
          ok: true,
          kind: "add-phrase",
          added: 1,
          removed: op.parts.length,
          undo: [{ restore: op.parts.map(restore), remove: [op.phrase], expect: [op.phrase] }],
        };
      default:
        return { ok: false, kind: null, code: "INVALID_OP" };
    }
  });
  return { success: true, results };
}

let dom;
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      getDictionary: async () => [...words],
      getDictionaryEntries: async () =>
        words.map((word) => ({
          word,
          source: SOURCE.get(word) ?? "manual",
          createdAt: sqlTime(Date.now() - (AGE.get(word) ?? 1) * DAY),
        })),
      getDictionaryPins: async () => ["openwhispr"],
      // What a learned word replaced, and where: never part of a model request.
      listDictionarySuggestions: async () => ({
        success: true,
        suggestions: [
          {
            id: 1,
            word: "Scout",
            times: 2,
            createdAt: sqlTime(Date.now()),
            updatedAt: sqlTime(Date.now()),
            evidence: [
              {
                replaced: `${CANARY}replaced`,
                app: `${CANARY}app.exe`,
                createdAt: sqlTime(Date.now()),
                transcriptionId: 7,
              },
            ],
          },
        ],
        dismissed: 0,
      }),
      getDictionaryWordEvidence: async () => ({
        available: true,
        evidence: [
          { replaced: `${CANARY}evidence`, app: "x.exe", createdAt: "", transcriptionId: 1 },
        ],
      }),
      getDictionaryTidyInputs: async () => tidyInputs,
      applyDictionaryTidy: async (ops) => applyOps(ops),
      undoDictionaryTidy: async () => {
        if (undoAnswer) return undoAnswer;
        if (snapshot) words = snapshot;
        snapshot = null;
        return { success: true, steps: 1 };
      },
      getCopilotAuthStatus: async () => ({ configured: true, state: "signedIn", login: "x" }),
      processCopilotReasoning: async (text, model, agentName, config) => {
        copilotCalls.push({ text, model, agentName, config });
        return copilotReply
          ? copilotReply(text, config)
          : { success: true, text: '{"suggestions":[]}' };
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

async function mount(t, { usage = true } = {}) {
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
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");

  useSettingsStore.setState({
    customDictionary: [...words],
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
    autoLearnMode: "suggest",
    uiLanguage: "en",
  });
  await refreshDictionarySources();
  useDictionaryUsageStore.setState(
    usage
      ? {
          status: "ready",
          reason: null,
          words: USAGE,
          missed: new Set(["openwhispr"]),
          perDay: 40,
        }
      : { status: "unavailable", reason: "history-off", words: [], missed: null, perDay: null }
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
  await act(() => root.render(h(ToastProvider, null, h(DictionaryView))), 120);
  await act(() => settle(60), 60);
  const buttonIn = (scope, text) =>
    [...scope.querySelectorAll("button")].find((button) => button.textContent.trim() === text);
  const click = (target, init = {}) =>
    act(() => target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, ...init })));
  const key = (target, name) =>
    act(() =>
      target.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })
      )
    );
  const group = (kind) => doc.querySelector(`[data-tidy-group="${kind}"]`);
  const items = (kind) =>
    [...(group(kind)?.querySelectorAll("[data-tidy-item]") ?? [])].map((element) => ({
      element,
      words: element.getAttribute("data-tidy-item").split(":").slice(1).join(":").split("\n"),
      checked: element.querySelector('[role="checkbox"]')?.getAttribute("aria-checked") === "true",
    }));
  return {
    vite,
    doc,
    win,
    act,
    buttonIn,
    click,
    key,
    group,
    items,
    consoleOutput,
    useSettingsStore,
    useDictionaryUsageStore,
  };
}

const openTidy = async (view) => {
  const button = view.doc.querySelector("[data-tidy-open]");
  await view.click(button);
  await view.act(() => settle(60), 60);
  return view.doc.querySelector("[data-dictionary-tidy]");
};

test(
  "the toolbar counts what starts selected; the groups and their preselection",
  { timeout: 90000 },
  async (t) => {
    words = FIXTURE.map(([word]) => word);
    const view = await mount(t);
    const button = view.doc.querySelector("[data-tidy-open]");
    assert.match(button.textContent, /Tidy up9/);
    assert.equal(button.getAttribute("aria-label"), "Tidy up, 9 suggestions selected");

    const tidy = await openTidy(view);
    assert.ok(tidy, "Tidy up replaces the list");
    assert.equal(view.doc.querySelector("[data-dictionary-list]"), null);
    assert.match(tidy.querySelector("h2").textContent, /words need a look/);
    assert.equal(view.doc.activeElement, tidy.querySelector("h2"), "focus moves in");

    const summary = (kind) => view.items(kind).map((item) => [item.words.join("+"), item.checked]);
    assert.deepEqual(summary("variants"), [["agents-shared+agentsshared", true]]);
    assert.deepEqual(summary("ordinary"), [
      ["the", true],
      ["What", true],
      ["model", false],
    ]);
    assert.deepEqual(summary("typos"), [
      ["gonestly", true],
      ["aessions", true],
      ["approverl", true],
    ]);
    assert.deepEqual(summary("fragments"), [
      ["then...ahh", true],
      ["8/5", true],
    ]);
    assert.deepEqual(summary("splitPhrases"), [["Little+Buddy", true]]);
    assert.match(view.group("splitPhrases").textContent, /Little Buddy/);
    // Never heard is informational, collapsed, never preselected.
    const never = view.group("neverHeard");
    assert.equal(never.querySelector("[aria-expanded]").getAttribute("aria-expanded"), "false");
    await view.click(never.querySelector("[aria-expanded]"));
    assert.ok(view.items("neverHeard").length >= 1);
    assert.ok(view.items("neverHeard").every((item) => !item.checked));

    // A keep-one item's spellings, each with its counts and source.
    const variant = view.items("variants")[0].element;
    const radios = [...variant.querySelectorAll('[role="radio"]')];
    assert.deepEqual(
      radios.map((radio) => radio.getAttribute("aria-checked")),
      ["true", "false"]
    );
    assert.match(radios[0].textContent, /agents-shared.*heard 4 · written 10 · Auto-learned/);

    // Esc goes back to the list, and focus to the button.
    await view.key(tidy.querySelector("h2"), "Escape");
    assert.equal(view.doc.querySelector("[data-dictionary-tidy]"), null);
    assert.ok(view.doc.querySelector("[data-dictionary-list]"));
    await view.act(() => settle(40));
    assert.equal(view.doc.activeElement, view.doc.querySelector("[data-tidy-open]"));
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test(
  "Apply sends one batch; Undo reverses it; a refused Undo says why",
  { timeout: 90000 },
  async (t) => {
    words = FIXTURE.map(([word]) => word);
    undoAnswer = null;
    const view = await mount(t);
    const tidy = await openTidy(view);
    const apply = tidy.querySelector("[data-tidy-apply]");
    assert.equal(apply.textContent.trim(), "Apply 9 selected");
    await view.click(apply);
    await view.act(() => settle(80), 80);

    const batches = dom.calls.filter(([name]) => name === "applyDictionaryTidy");
    assert.equal(batches.length, 1, "one IPC batch");
    assert.deepEqual(batches[0][1][0], [
      { kind: "merge", from: "agentsshared", into: "agents-shared" },
      { kind: "add-phrase", phrase: "Little Buddy", parts: ["Little", "Buddy"] },
      { kind: "remove", words: ["the"] },
      { kind: "remove", words: ["What"] },
      { kind: "remove", words: ["gonestly"] },
      { kind: "remove", words: ["aessions"] },
      { kind: "respell", from: "approverl", to: "approver" },
      { kind: "remove", words: ["then...ahh"] },
      { kind: "remove", words: ["8/5"] },
    ]);
    const footer = view.doc.querySelector("[data-tidy-footer]");
    assert.match(footer.textContent, /Removed 8 · Merged 2 · Added 1/);
    assert.match(
      footer.textContent,
      /Undo after a merge doesn't bring back what the word replaced/
    );
    assert.ok(view.useSettingsStore.getState().customDictionary.includes("Little Buddy"));
    assert.equal(view.items("typos").length, 0, "applied items leave");

    await view.click(view.buttonIn(footer, "Undo"));
    await view.act(() => settle(80), 80);
    const undos = dom.calls.filter(([name]) => name === "undoDictionaryTidy");
    assert.equal(undos.length, 1);
    assert.equal(undos[0][1][0].length, 9, "every applied choice's steps, in one Undo");
    assert.ok(view.useSettingsStore.getState().customDictionary.includes("gonestly"));
    assert.equal(view.items("typos").length, 3, "the words are back");

    // One item on its own, then an Undo refused because the word changed since.
    undoAnswer = { success: false, code: "EDITED", word: "gonestly" };
    const gonestly = view.items("typos").find((item) => item.words[0] === "gonestly").element;
    await view.click(view.buttonIn(gonestly, "Remove"));
    await view.act(() => settle(80), 80);
    assert.match(view.doc.querySelector("[data-tidy-footer]").textContent, /Removed 1/);
    await view.click(view.buttonIn(view.doc.querySelector("[data-tidy-footer]"), "Undo"));
    await view.act(() => settle(80), 80);
    assert.match(
      view.doc.querySelector("[data-tidy-footer]").textContent,
      /Can't undo: “gonestly” was changed since\./
    );
    assert.match(view.doc.querySelector("[data-tidy-footer]").textContent, /Undo all \(1\)/);
    undoAnswer = null;

    // Keep: the item leaves for the session and counts in the next summary.
    const what = view.items("ordinary").find((item) => item.words[0] === "What");
    if (what) {
      await view.click(view.buttonIn(what.element, "Keep"));
      assert.equal(
        view.items("ordinary").some((item) => item.words[0] === "What"),
        false
      );
      assert.match(
        view.doc.querySelector("[data-tidy-footer]").textContent,
        /Show 1 kept suggestion again/
      );
    }
    // Counts and codes only: no word reaches a log line.
    assert.equal(
      view.consoleOutput.lines.some((line) =>
        /gonestly|approverl|aessions|Little Buddy/.test(line)
      ),
      false
    );
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test(
  "without this account's History: those checks say why; the rest still run",
  { timeout: 90000 },
  async (t) => {
    words = FIXTURE.map(([word]) => word);
    const saved = tidyInputs;
    tidyInputs = { available: false, reason: "history-off" };
    t.after(() => {
      tidyInputs = saved;
    });
    const view = await mount(t, { usage: false });
    const tidy = await openTidy(view);
    assert.match(tidy.textContent, /using your dictionary only/);
    for (const kind of ["typos", "splitPhrases", "neverHeard"]) {
      const section = view.group(kind);
      if (section.querySelector("[aria-expanded]").getAttribute("aria-expanded") === "false") {
        await view.click(section.querySelector("[aria-expanded]"));
      }
      assert.match(
        view.group(kind).querySelector("[data-tidy-unavailable]").textContent,
        /Needs this account's local History · Heard and written are counted from local History, which is off\./
      );
      assert.equal(view.items(kind).length, 0);
    }
    assert.ok(view.group("ordinary").querySelector("[data-tidy-partial]"));
    assert.deepEqual(
      view.items("ordinary").map((item) => item.words[0]),
      ["the", "What"],
      "only auto-learn's everyday words: 0/0 is never “speech gets it right”"
    );
    assert.equal(view.items("fragments").length, 2);
    assert.equal(view.items("variants").length, 1);
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);

test(
  "Ask a model: only the words go; suggestions validated; stale and cancelled replies dropped",
  { timeout: 90000 },
  async (t) => {
    words = FIXTURE.map(([word]) => word);
    copilotCalls.length = 0;
    copilotReply = () => ({
      success: true,
      text:
        "```json\n" +
        JSON.stringify({
          suggestions: [
            { action: "respell", words: ["approver"], into: "Approver", reason: "A role name." },
            { action: "remove", words: ["soon"], reason: "An ordinary word." },
            { action: "remove", words: ["kubectl"], reason: "Not in the list." },
            { action: "keep", words: ["model"], reason: "A word you use for AI models." },
          ],
        }) +
        "\n```",
    });
    const view = await mount(t);
    // The review loads ReasoningService, whose key cache keeps a timer: stop it after.
    const { default: service } = await view.vite.ssrLoadModule("/services/ReasoningService.ts");
    t.after(() => service.destroy());
    const tidy = await openTidy(view);
    const review = view.group("model");
    const appliedBefore = dom.calls.filter(([name]) => name === "applyDictionaryTidy").length;
    assert.match(
      review.querySelector("[data-tidy-review-estimate]").textContent,
      /Sends your 15 words with their source and counts, never your dictations\. One request, ≈ [\d,]+ tokens\./
    );
    assert.match(review.textContent, /Cleanup · Claude Haiku 5\.5 · GitHub Copilot/);
    await view.click(review.querySelector("[data-tidy-review-ask]"));
    // The request path loads on first use.
    const until = async (done, ms = 15000) => {
      const end = Date.now() + ms;
      while (!done() && Date.now() < end) await view.act(() => settle(50), 50);
    };
    await until(() => !view.group("model").querySelector("[data-tidy-review-cancel]"));

    assert.equal(copilotCalls.length, 1);
    const [call] = copilotCalls;
    const sent = JSON.stringify(call);
    assert.equal(sent.includes(CANARY), false, "no History token, evidence or app in the request");
    const lines = call.text.split("\n");
    assert.equal(lines[0], "Columns: word, source, pinned, heard, written, missed");
    assert.deepEqual(JSON.parse(lines[1]), ["OpenWhispr", "typed", 1, 0, 6, 6]);
    assert.equal(lines.length, FIXTURE.length + 1);
    assert.match(call.config.systemPrompt, /^You review the custom dictionary of a dictation app/);
    assert.equal(call.config.redactLogs, true);
    assert.equal(call.config.requireCompleteOutput, true);
    assert.equal(call.config.inferenceScope, "dictationCleanup");

    const rows = () =>
      [...view.group("model").querySelectorAll("[data-tidy-suggestion]")].map((row) =>
        row.getAttribute("data-tidy-suggestion")
      );
    assert.deepEqual(rows(), ["respell", "remove", "keep"]);
    assert.match(view.group("model").textContent, /3 suggestions\. 1 was dropped/);
    assert.match(view.group("model").textContent, /From Claude Haiku 5\.5\./);
    // Nothing applied without a click.
    const applies = () => dom.calls.filter(([name]) => name === "applyDictionaryTidy").length;
    assert.equal(applies(), appliedBefore);
    const respell = view.group("model").querySelector('[data-tidy-suggestion="respell"]');
    await view.click(view.buttonIn(respell, "Change"));
    await view.act(() => settle(80), 80);
    assert.deepEqual(dom.calls.filter(([name]) => name === "applyDictionaryTidy").at(-1)[1][0], [
      { kind: "respell", from: "approver", to: "Approver" },
    ]);

    // Stale: the dictionary changes while the model works.
    let release;
    copilotReply = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            success: true,
            text: JSON.stringify({
              suggestions: [{ action: "remove", words: ["soon"], reason: "x" }],
            }),
          });
      });
    await view.click(view.group("model").querySelector("[data-tidy-review-ask]"));
    assert.ok(
      view.group("model").querySelector("[data-tidy-review-cancel]"),
      "Cancel while it runs"
    );
    await view.act(() => {
      words = words.filter((word) => word !== "8/5");
      view.useSettingsStore.setState({ customDictionary: [...words] });
    });
    await view.act(async () => release(), 80);
    assert.match(
      view.group("model").querySelector("[data-tidy-review-dropped]").textContent,
      /Your dictionary changed while the model was working/
    );

    // Cancel: a late reply is discarded.
    copilotReply = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            success: true,
            text: JSON.stringify({
              suggestions: [{ action: "remove", words: ["soon"], reason: "x" }],
            }),
          });
      });
    await view.click(view.group("model").querySelector("[data-tidy-review-ask]"));
    await view.click(view.group("model").querySelector("[data-tidy-review-cancel]"));
    await view.act(async () => release(), 80);
    assert.deepEqual(rows(), []);
    assert.ok(view.group("model").querySelector("[data-tidy-review-ask]"));
    copilotReply = null;
    assert.ok(tidy.isConnected);
    assert.deepEqual(view.consoleOutput.errors, []);
  }
);
