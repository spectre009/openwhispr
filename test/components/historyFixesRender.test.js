const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// The History review's fixes rendered (happy-dom, stubbed preload): one
// suggestion box for the step a 👎 review names (a draft's or a saved one's),
// the actions that float over words selected in a step's text, the glossary's
// rule editor prefilled from the selection and the correction, a dictionary
// word to confirm, a test case pinned and its suggested checks saved only on
// confirm, and the blamed step highlighted. Nothing is saved before its
// editor's own Save, and dictated text never reaches the console.

const STT = "open the open whisper repo and ping little body";
const GLOSSARY = "open the OpenWhispr repo and ping little body";
const CLEANUP = "Open the OpenWhispr repo and ping little body.";
const CORRECTION = "Open the OpenWhispr repo and ping Little Buddy.";
const TEST_CORRECTION = "Open the OpenWhispr repository and ping Little Buddy.";
const STYLED = "Hi Sam, Thanks for the notes.";
const OLD_FINAL = "Let's meet at 3 on Thursday.";
const DICTATED = [STT, GLOSSARY, CLEANUP, CORRECTION, TEST_CORRECTION, STYLED, OLD_FINAL];

const listRow = (id, extra = {}) => ({
  id,
  timestamp: `2026-10-24 1${id % 10}:00:00`,
  status: "completed",
  errorCode: null,
  preview: null,
  hasAudio: false,
  audioDurationMs: null,
  routeKind: null,
  app: null,
  marks: null,
  rating: null,
  ...extra,
});
const ROWS = [
  listRow(303, { preview: CLEANUP }),
  listRow(302, { preview: STYLED, routeKind: "style:email" }),
  listRow(301, { preview: OLD_FINAL }),
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
const item = (id, extra = {}) => ({
  id,
  timestamp: "2026-10-24 12:00:00",
  status: "completed",
  text: "",
  rawText: null,
  errorCode: null,
  errorMessage: null,
  hasAudio: false,
  audioDurationMs: null,
  routeKind: null,
  provider: null,
  model: null,
  ...extra,
});
const RULE = {
  id: "r1",
  canonical: "OpenWhispr",
  spellings: [{ text: "open whisper", scope: "anywhere" }],
  apps: [],
  enabled: true,
  revision: 1,
};
const ITEMS = {
  303: () => ({
    item: item(303, { text: CLEANUP, rawText: STT }),
    status: "captured",
    route: "cleanup",
    context: { targetApp: "Code.exe" },
    steps: [
      step("stt", STT),
      step("glossary", GLOSSARY, {
        detail: {
          revision: 1,
          rulesFired: [{ ruleId: "r1", from: "open whisper", to: "OpenWhispr", index: 9 }],
        },
      }),
      step("cleanup", CLEANUP),
      step("finalize", CLEANUP),
    ],
  }),
  302: () => ({
    item: item(302, {
      text: STYLED,
      rawText: "hi sam thanks for the notes",
      routeKind: "style:email",
    }),
    status: "captured",
    route: "style",
    context: { targetApp: "OUTLOOK.EXE" },
    steps: [
      step("stt", "hi sam thanks for the notes"),
      step("cleanup", "Hi Sam, thanks for the notes."),
      step("style", STYLED, { detail: { styleId: "email", runMode: "two-step" } }),
    ],
  }),
  301: () => ({
    item: item(301, { text: OLD_FINAL, rawText: "lets meet at three on thursday" }),
    status: "none",
    route: null,
    context: null,
    steps: [],
  }),
};
const STYLE_CHECKS = { bulletsMin: null, bulletsMax: null, numberedMin: null, numberedMax: null };
const testCase = (extra = {}) => ({
  id: "case-1",
  target: "cleanup",
  label: null,
  rawText: STT,
  referenceText: CLEANUP,
  targetApp: "Code.exe",
  mustContain: [],
  mustNotContain: [],
  matchCase: false,
  styleChecks: STYLE_CHECKS,
  source: "history",
  sourceTranscriptionId: 303,
  durable: true,
  createdAt: "2026-10-24T12:00:00.000Z",
  updatedAt: "2026-10-24T12:00:00.000Z",
  ...extra,
});

let dom;
const saved = new Map();
let dictionary = [];
let pinReply = null;
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
              ...ITEMS[id](),
              revision: `rev-${id}`,
              owner: "owner-a",
              feedback: saved.get(id) ?? null,
            }
          : { success: false, code: "NOT_FOUND" },
      saveHistoryFeedback: async (input) => {
        const feedback = {
          revision: input.revision,
          verdict: input.verdict,
          stage: input.stage,
          expectedText: input.expectedText,
          note: input.note || null,
          createdAt: "2026-10-24T12:00:00.000Z",
          updatedAt: "2026-10-24T12:00:00.000Z",
        };
        saved.set(input.id, feedback);
        return { success: true, feedback };
      },
      hideControlPanel: async () => undefined,
      getGlossaryRules: async () => ({ revision: 1, rules: [RULE] }),
      saveGlossaryRule: async (rule) => ({
        success: true,
        snapshot: { revision: 2, rules: [RULE, { ...rule, id: "r2", revision: 1 }] },
      }),
      applyDictionaryChanges: async ({ add = [] }) => {
        dictionary = [...dictionary, ...add];
        return { success: true, added: add.length, removed: 0 };
      },
      getDictionary: async () => dictionary,
      setDictionary: async () => ({ success: true }),
      pinHistoryTestCase: async () => pinReply,
      updateTestCase: async (id, patch) => ({ success: true, case: testCase({ id, ...patch }) }),
    },
  });
  // A 900 px view: the list beside the detail, too narrow for the wide layout
  // even with the list folded, so the stacked layout is what's tested here.
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
  proto.hasPointerCapture = () => false;
  proto.releasePointerCapture = () => {};
});

test.after(async () => {
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
    // The test set's store, minus the runner (its services keep timers alive):
    // the same IPC calls and storage notices.
    mockModules: {
      "/stores/promptTestSetStore": `
        const NOTICE = {
          "history-off": "promptStudio.testSet.storage.historyOff",
          "policy-off": "promptStudio.testSet.storage.policyOff",
          pending: "promptStudio.testSet.storage.pending",
          unavailable: "promptStudio.testSet.storage.unavailable",
        };
        export const storageNoticeKey = (reason) => NOTICE[reason ?? "unavailable"] ?? NOTICE.unavailable;
        const write = async (call) => (await call()) ?? { success: false, code: "FAILED" };
        export const pinHistoryTestCase = (id) =>
          write(() => window.electronAPI.pinHistoryTestCase(id));
        export const updateTestCase = (id, patch) =>
          write(() => window.electronAPI.updateTestCase(id, patch));
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
  const { useStyleStore } = await vite.ssrLoadModule("/stores/styleStore.ts");
  useSettingsStore.setState({ dataRetentionEnabled: true, customDictionary: [] });
  dictionary = [];
  await syncGlossaryRules();

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
  const copies = [];
  const settings = [];
  const v = {
    doc,
    win,
    act,
    store,
    consoleOutput,
    copies,
    settings,
    useSettingsStore,
    useStyleStore,
    press: (key, { target = doc.body, ctrlKey = false } = {}) =>
      act(() =>
        target.dispatchEvent(
          new win.KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true })
        )
      ),
    setValue: (field, value) => {
      const proto =
        field.tagName === "TEXTAREA"
          ? win.HTMLTextAreaElement.prototype
          : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(field, value);
      field.dispatchEvent(new win.Event("input", { bubbles: true }));
    },
    form: () => doc.querySelector("[data-review-form]"),
    box: () => doc.querySelector("[data-fix-suggestion]"),
    toolbar: () => doc.querySelector("[data-selection-actions]"),
    dialog: () => doc.querySelector('[role="dialog"]'),
    textarea: () => doc.querySelector("#history-review-expected"),
    within: (scope, text) =>
      [...(scope ?? doc).querySelectorAll("button")].find(
        (candidate) => candidate.textContent.trim() === text
      ),
    starting: (scope, text) =>
      [...(scope ?? doc).querySelectorAll("button")].find((candidate) =>
        candidate.textContent.trim().startsWith(text)
      ),
    // What's highlighted: each node's tag and first words.
    blamed: () =>
      [...doc.querySelectorAll("[data-blamed]")].map((node) => {
        const walker = doc.createTreeWalker(node, win.NodeFilter.SHOW_TEXT);
        let text = "";
        while (!text.trim() && walker.nextNode()) text = walker.currentNode.nodeValue;
        return `${node.tagName.toLowerCase()}:${text.trim()}`;
      }),
    // Selects `part` of a step's shown text, as a user dragging over it.
    select: async (index, part) => {
      const holder = doc.querySelector(`[data-step-output="${index}"]`);
      assert.ok(holder, `step ${index} shows its text`);
      const walker = doc.createTreeWalker(holder, win.NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.nodeValue.indexOf(part);
        if (at < 0) continue;
        const range = doc.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + part.length);
        await act(() => {
          const selection = doc.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        });
        return;
      }
      assert.fail(`"${part}" isn't one text node in step ${index}`);
    },
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
    unselect: () => act(() => doc.getSelection().removeAllRanges()),
  };
  await act(() =>
    root.render(
      h(
        ToastProvider,
        null,
        h(HistoryBrowser, {
          hotkey: "Control+`",
          onCopy: (text) => copies.push(text),
          onDelete: () => {},
          onRetry: async () => {},
          onShowAudioInFolder: () => {},
          onOpenSettings: (destination) => settings.push(destination),
        })
      )
    )
  );
  return v;
}

test(
  "speech-to-text and glossary: fixes from selected words, the rule editor prefilled, saved only on Save",
  { timeout: 120000 },
  async (t) => {
    const v = await mountHistory(t);
    assert.equal(
      v.doc.querySelector('[role="option"][aria-selected="true"]').id,
      "history-row-303"
    );

    // 👎 with no step picked: no box, nothing highlighted.
    await v.press("b");
    assert.ok(v.form());
    assert.equal(v.box(), null);
    assert.deepEqual(v.blamed(), []);

    // The correction first (typing moves the selection into the field), then the step.
    await v.act(() => v.setValue(v.textarea(), CORRECTION));
    await v.press("1");
    assert.equal(v.box().dataset.fixSuggestion, "recognition");
    assert.match(v.box().textContent, /Speech-to-text may have heard it wrong/);
    assert.match(v.box().textContent, /Select the words it got wrong in a step below/);
    const boxGlossary = v.within(v.box(), "Glossary correction from selection…");
    assert.equal(boxGlossary.disabled, true, "nothing selected yet");
    // The rule that fired is offered too.
    assert.ok(v.within(v.box(), "Edit rule"));

    // The blamed step is highlighted, node and card.
    assert.deepEqual(v.blamed(), ["li:Speech-to-Text", "section:Speech-to-Text"]);
    assert.ok(
      v.doc.querySelector('button[aria-label="Go to Speech-to-Text, the step you flagged"]')
    );
    assert.match(v.doc.querySelector("section[data-blamed]").textContent, /You flagged this step/);

    // Selecting words in a later step's text offers nothing; in the blamed one, the two fixes.
    assert.equal(v.toolbar(), null);
    await v.select(2, "ping");
    assert.equal(v.toolbar(), null, "Cleanup's text is after the blamed step");
    await v.select(0, "little body");
    assert.ok(v.toolbar());
    assert.equal(v.within(v.box(), "Glossary correction from selection…").disabled, false);
    await v.unselect();
    assert.equal(v.toolbar(), null);

    // Glossary: the selection is the spelling (anywhere), the correction's words the canonical form.
    await v.select(0, "little body");
    await v.act(() => v.within(v.toolbar(), "Glossary correction…").click());
    let dialog = v.dialog();
    assert.match(dialog.textContent, /New correction/);
    assert.equal(dialog.querySelector("#glossary-canonical").value, "Little Buddy");
    const spelling = () => dialog.querySelector('input[aria-label="Spelling"]');
    assert.equal(spelling().value, "little body");
    assert.match(dialog.querySelector('[aria-label="Where it applies"]').textContent, /Anywhere/);
    assert.equal(dialog.querySelector("#glossary-app").value, "");
    assert.deepEqual(calls("saveGlossaryRule"), [], "nothing saved before Save");
    await v.act(() => v.within(dialog, "Save").click());
    assert.deepEqual(calls("saveGlossaryRule"), [
      [
        {
          canonical: "Little Buddy",
          spellings: [{ text: "little body", scope: "anywhere" }],
          apps: [],
          enabled: true,
        },
      ],
    ]);
    assert.equal(v.dialog(), null);

    // Words the correction left as they were: no canonical form to suggest; Cancel saves nothing.
    await v.select(0, "ping");
    await v.act(() => v.within(v.toolbar(), "Glossary correction…").click());
    dialog = v.dialog();
    assert.equal(dialog.querySelector("#glossary-canonical").value, "");
    assert.equal(spelling().value, "ping");
    await v.act(() => v.within(dialog, "Cancel").click());
    assert.equal(calls("saveGlossaryRule").length, 1);

    // A spelling a rule already has opens that rule, with a notice.
    await v.select(0, "open whisper");
    await v.act(() => v.within(v.toolbar(), "Glossary correction…").click());
    dialog = v.dialog();
    assert.match(dialog.textContent, /Edit correction/);
    assert.equal(dialog.querySelector("#glossary-canonical").value, "OpenWhispr");
    assert.match(
      dialog.textContent,
      /A correction already has the spelling “open whisper”, so it's opened here instead\./
    );
    await v.act(() => v.within(dialog, "Cancel").click());
    assert.equal(calls("saveGlossaryRule").length, 1);

    // Dictionary: the word speech-to-text should have written, to confirm; added once, as typed words are.
    await v.select(0, "little body");
    await v.act(() => v.within(v.toolbar(), "Dictionary word…").click());
    dialog = v.dialog();
    const word = () => v.dialog().querySelector("input");
    assert.equal(word().value, "Little Buddy");
    assert.match(dialog.textContent, /Dictionary words sync with your account/);
    assert.deepEqual(calls("applyDictionaryChanges"), []);
    await v.act(() => v.within(dialog, "Add word").click(), 60);
    // The second argument is whose lists the window shows (#2924); unknown in this harness.
  assert.deepEqual(calls("applyDictionaryChanges"), [
    [{ add: ["Little Buddy"], remove: [] }, undefined],
  ]);
    assert.equal(v.dialog(), null);
    assert.deepEqual(v.useSettingsStore.getState().customDictionary, ["Little Buddy"]);

    // A word already in the dictionary says so and can't be added again.
    await v.select(0, "little body");
    await v.act(() => v.within(v.toolbar(), "Dictionary word…").click());
    dialog = v.dialog();
    assert.match(dialog.textContent, /It's already in your dictionary\./);
    assert.equal(v.within(dialog, "Add word").disabled, true);
    await v.act(() => v.setValue(word(), "little BUDDY"));
    assert.equal(v.within(v.dialog(), "Add word").disabled, true, "in any case");
    await v.act(() => v.within(v.dialog(), "Cancel").click());
    assert.equal(calls("applyDictionaryChanges").length, 1);

    // Glossary blamed: its card and the ones before it offer fixes; Edit rule opens the rule.
    await v.press("2");
    assert.equal(v.box().dataset.fixSuggestion, "glossary");
    assert.match(v.box().textContent, /A glossary correction may have changed it/);
    assert.deepEqual(v.blamed(), ["li:Glossary", "section:Glossary"]);
    await v.select(1, "ping little body");
    assert.ok(v.toolbar());
    await v.select(2, "ping");
    assert.equal(v.toolbar(), null);
    await v.act(() => v.within(v.box(), "Edit rule").click());
    dialog = v.dialog();
    assert.match(dialog.textContent, /Edit correction/);
    assert.equal(dialog.querySelector("#glossary-canonical").value, "OpenWhispr");
    assert.doesNotMatch(dialog.textContent, /already has the spelling/);
    await v.act(() => v.within(dialog, "Cancel").click());

    // A selection across what the glossary deleted reads only the step's own text.
    const holder = v.doc.querySelector('[data-step-output="1"]');
    const texts = [];
    const walker = v.doc.createTreeWalker(holder, v.win.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node);
    const first = texts.find((node) => node.nodeValue.includes("the "));
    const inserted = texts.find((node) => node.nodeValue === "OpenWhispr");
    assert.ok(
      texts.some((node) => node.nodeValue === "open whisper"),
      "the deletion is shown"
    );
    await v.selectRange(first, first.nodeValue.indexOf("the"), inserted, "OpenWhispr".length);
    await v.act(() => v.within(v.toolbar(), "Dictionary word…").click());
    assert.equal(word().value, "the OpenWhispr");
    await v.act(() => v.within(v.dialog(), "Cancel").click());

    // Not sure: no box, nothing highlighted.
    await v.press("0");
    assert.equal(v.box(), null);
    assert.deepEqual(v.blamed(), []);

    assert.deepEqual(calls("saveHistoryFeedback"), [], "the review itself wasn't saved");
    const printed = v.consoleOutput.lines.join("\n");
    for (const text of DICTATED) assert.ok(!printed.includes(text), `"${text}" was printed`);
    assert.deepEqual(v.consoleOutput.errors, [], "nothing logged an error");
  }
);

test(
  "cleanup and style: the test set pin, then its checks saved only on confirm",
  { timeout: 120000 },
  async (t) => {
    const v = await mountHistory(t);
    v.store.useHistoryViewStore.setState({ drafts: {} });
    await v.press("b");
    await v.act(() => v.setValue(v.textarea(), TEST_CORRECTION));
    await v.press("3");
    assert.equal(v.box().dataset.fixSuggestion, "cleanup");
    assert.match(v.box().textContent, /Cleanup may have changed what you said/);
    assert.match(
      v.box().textContent,
      /Checks are literal, so the case catches the problem only through the words you choose\./
    );
    assert.deepEqual(v.blamed(), ["li:Cleanup", "section:Cleanup"]);
    assert.equal(v.toolbar(), null);

    await v.act(() => v.within(v.box(), "Open Prompt Studio").click());
    assert.deepEqual(v.settings, ["cleanup#dictation.cleanup.prompt"]);

    // The pin is the existing one; the dialog shows the case beside the correction.
    pinReply = { success: true, duplicate: false, durable: true, reason: null, case: testCase() };
    await v.act(() => v.within(v.box(), "Add to the test set…").click(), 60);
    assert.deepEqual(calls("pinHistoryTestCase"), [[303]]);
    let dialog = v.dialog();
    assert.match(dialog.textContent, /Added to the test set/);
    assert.match(dialog.textContent, /Test set: Cleanup/);
    for (const text of [STT, CLEANUP, TEST_CORRECTION])
      assert.ok(dialog.textContent.includes(text));
    const checks = () =>
      [...v.dialog().querySelectorAll("fieldset")].map((fieldset) =>
        [...fieldset.querySelectorAll('input[aria-label="Check text"]')].map((input) => [
          input.value,
          input.previousElementSibling.getAttribute("aria-checked"),
        ])
      );
    assert.deepEqual(checks(), [
      [
        ["repository and", "true"],
        ["Little Buddy", "true"],
      ],
      [
        ["repo and", "true"],
        ["little body", "true"],
      ],
    ]);
    assert.deepEqual(calls("updateTestCase"), [], "nothing saved before Save checks");

    // Untick one, edit one, remove one; then save.
    const [contain, notContain] = v.dialog().querySelectorAll("fieldset");
    await v.act(() => contain.querySelector('[role="checkbox"]').click());
    await v.act(() =>
      v.setValue(notContain.querySelectorAll('input[aria-label="Check text"]')[1], "little body.")
    );
    await v.act(() => notContain.querySelector('button[aria-label="Remove this check"]').click());
    await v.act(() => v.dialog().querySelector('[role="switch"]').click());
    await v.act(() => v.within(v.dialog(), "Save checks").click(), 60);
    assert.deepEqual(calls("updateTestCase"), [
      [
        "case-1",
        {
          label: null,
          targetApp: "Code.exe",
          mustContain: ["Little Buddy"],
          mustNotContain: ["little body."],
          matchCase: true,
          styleChecks: STYLE_CHECKS,
        },
      ],
    ]);
    assert.equal(v.dialog(), null);

    // Already a case: that one opens, its checks ticked, the suggestions offered unticked.
    pinReply = {
      success: true,
      duplicate: true,
      durable: true,
      reason: null,
      case: testCase({ mustContain: ["Little Buddy"], mustNotContain: ["OpenWhisper"] }),
    };
    await v.act(() => v.within(v.box(), "Add to the test set…").click(), 60);
    dialog = v.dialog();
    assert.match(dialog.textContent, /Already in the test set/);
    assert.deepEqual(checks(), [
      [
        ["Little Buddy", "true"],
        ["repository and", "false"],
      ],
      [
        ["OpenWhisper", "true"],
        ["repo and", "false"],
        ["little body", "false"],
      ],
    ]);
    // Cancel keeps its checks as they were.
    await v.act(() => v.within(dialog, "Cancel").click());
    assert.equal(calls("updateTestCase").length, 1);

    // Kept for this session only: the existing notice says why.
    pinReply = {
      success: true,
      duplicate: false,
      durable: false,
      reason: "history-off",
      case: testCase({ durable: false }),
    };
    await v.act(() => v.within(v.box(), "Add to the test set…").click(), 60);
    assert.match(v.dialog().textContent, /Added to the test set for this session only/);
    assert.match(v.dialog().textContent, /Local history is off/);
    await v.act(() => v.within(v.dialog(), "Cancel").click());

    // A failed pin opens nothing.
    pinReply = { success: false, code: "NO_RAW_TEXT" };
    await v.act(() => v.within(v.box(), "Add to the test set…").click(), 60);
    assert.equal(v.dialog(), null);
    assert.equal(calls("updateTestCase").length, 1);

    // A styled dictation (the draft above is kept): Edit style opens Styles on that style.
    await v.act(() => v.store.requestHistoryItem(302));
    await v.press("b");
    await v.press("3");
    assert.equal(v.box().dataset.fixSuggestion, "style");
    assert.match(v.box().textContent, /The style may have gone too far/);
    assert.ok(v.within(v.box(), "Add to the test set…"));
    await v.act(() => v.within(v.box(), "Edit style").click());
    assert.equal(v.useStyleStore.getState().focusStyleId, "email");
    assert.equal(v.settings.at(-1), "styles");

    const printed = v.consoleOutput.lines.join("\n");
    for (const text of DICTATED) assert.ok(!printed.includes(text), `"${text}" was printed`);
    assert.deepEqual(v.consoleOutput.errors, [], "nothing logged an error");
  }
);

test(
  "delivery: copy again and the final output highlighted, for a draft and a saved review",
  { timeout: 120000 },
  async (t) => {
    const v = await mountHistory(t);
    v.store.useHistoryViewStore.setState({ drafts: {} });
    await v.act(() => v.store.requestHistoryItem(303));
    await v.press("b");
    await v.press("5");
    assert.equal(v.box().dataset.fixSuggestion, "delivery");
    assert.match(v.box().textContent, /The text may not have arrived right/);
    assert.deepEqual(v.blamed(), ["li:Final output", "section:Final output"]);
    await v.act(() => v.within(v.box(), "Copy text again").click());
    assert.deepEqual(v.copies, [CLEANUP]);

    // Saved, the review keeps its suggestion and the highlight.
    await v.press("Enter", { target: v.textarea(), ctrlKey: true });
    assert.equal(v.form(), null);
    assert.match(v.doc.body.textContent, /You flagged this dictation\./);
    assert.equal(v.box().dataset.fixSuggestion, "delivery");
    assert.deepEqual(v.blamed(), ["li:Final output", "section:Final output"]);

    // A dictation from before step history: Delivery highlights its final output.
    await v.act(() => v.store.requestHistoryItem(301));
    await v.press("b");
    await v.press("1");
    assert.equal(v.box().dataset.fixSuggestion, "delivery");
    assert.deepEqual(v.blamed(), ["section:Final output"]);
    await v.press("0");
    assert.equal(v.box(), null);
    assert.deepEqual(v.blamed(), []);
    await v.press("Escape");

    const printed = v.consoleOutput.lines.join("\n");
    for (const text of DICTATED) assert.ok(!printed.includes(text), `"${text}" was printed`);
    assert.deepEqual(v.consoleOutput.errors, [], "nothing logged an error");
  }
);
