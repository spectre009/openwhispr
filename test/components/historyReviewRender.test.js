const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// The History view's reviews rendered (happy-dom, stubbed preload): 👍 / 👎,
// "What went wrong?" with a chip per recorded step (a kind recorded twice
// shows twice), the review keys and the fields they stay out of, a draft kept
// across rows, Save sending the revision the form opened on, a dictation that
// changed under its review, a saved review, the Flagged filter, and the review
// hotkey's request (👎 preselected, Save & close, Esc). Dictated text and
// corrections never reach the console.

const STT = "open the open whisper repo";
const GLOSSARY = "open the OpenWhispr repo";
const CLEANUP = "Open the OpenWhispr repo.";
const OLD_FINAL = "Let's meet at 3 on Thursday.";
const CORRECTION = "Open the OpenWhispr repository.";
const NOTE = "it shortened the noun";
const DICTATED = [STT, GLOSSARY, CLEANUP, OLD_FINAL, CORRECTION, NOTE];

const ratings = new Map();
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
  rating: ratings.get(id) ?? null,
  ...extra,
});
const rows = () => [
  listRow(203, { preview: CLEANUP }),
  listRow(202, { preview: OLD_FINAL }),
  listRow(201, { status: "failed", errorCode: "TIMEOUT" }),
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

// Main's side: each row's version, and the owner's saved reviews.
const versions = new Map([
  [203, 1],
  [202, 1],
  [201, 1],
]);
const saved = new Map();
const ITEMS = {
  203: () => ({
    item: item(203, { text: CLEANUP, rawText: STT }),
    status: "captured",
    route: "cleanup",
    context: { targetApp: "Code.exe" },
    steps: [
      step("stt", STT),
      step("glossary", GLOSSARY),
      step("cleanup", "Open the OpenWhispr repo"),
      step("cleanup", CLEANUP),
      step("finalize", CLEANUP),
    ],
  }),
  202: () => ({
    item: item(202, { text: OLD_FINAL, rawText: "lets meet at three on thursday" }),
    status: "none",
    route: null,
    context: null,
    steps: [],
  }),
  201: () => ({
    item: item(201, { status: "failed", errorCode: "TIMEOUT" }),
    status: "none",
    route: null,
    context: null,
    steps: [],
  }),
};

let dom;
const listeners = {};
const listRequests = [];
const saves = [];
let saveReply = null;
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      listHistory: async (request) => {
        listRequests.push(request);
        const { cursor, limit = 50 } = request;
        const all = rows().filter(
          (row) => !request.filters?.flagged || ratings.get(row.id) === "bad"
        );
        const page = all.filter(
          (row) =>
            !cursor ||
            row.timestamp < cursor.timestamp ||
            (row.timestamp === cursor.timestamp && row.id < cursor.id)
        );
        return { success: true, rows: page.slice(0, limit), nextCursor: null };
      },
      getHistoryApps: async () => ({ success: true, apps: [] }),
      getHistoryItem: async (id) =>
        ITEMS[id]
          ? {
              success: true,
              ...ITEMS[id](),
              revision: `rev-${id}-${versions.get(id)}`,
              owner: "owner-a",
              feedback: saved.get(id) ?? null,
            }
          : { success: false, code: "NOT_FOUND" },
      saveHistoryFeedback: async (input) => {
        saves.push(input);
        if (saveReply) {
          const reply = saveReply;
          saveReply = null;
          return reply;
        }
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
        ratings.set(input.id, input.verdict);
        return { success: true, feedback };
      },
      deleteHistoryFeedback: async (id) => {
        saved.delete(id);
        ratings.delete(id);
        return { success: true, removed: true };
      },
      hideControlPanel: async () => undefined,
    },
  });
  // The preload's subscriptions, so the test can play main's broadcasts.
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
});

test.after(async () => {
  await dom.close();
});

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
        export async function pinHistoryTestCase() {
          return { success: true, durable: true };
        }
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
  const press = (key, { target = doc.body, ctrlKey = false } = {}) =>
    act(() =>
      target.dispatchEvent(
        new win.KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true })
      )
    );
  const setValue = (field, value) => {
    const proto =
      field.tagName === "TEXTAREA"
        ? win.HTMLTextAreaElement.prototype
        : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(field, value);
    field.dispatchEvent(new win.Event("input", { bubbles: true }));
  };
  const view = {
    doc,
    win,
    act,
    press,
    setValue,
    store,
    consoleOutput,
    form: () => doc.querySelector("[data-review-form]"),
    chips: () => [...doc.querySelectorAll('[data-review-form] [role="radio"]')],
    textarea: () => doc.querySelector("#history-review-expected"),
    note: () => doc.querySelector('[data-review-form] input[aria-label="Note"]'),
    rate: (verdict) =>
      doc.querySelector(
        `button[aria-label="${verdict === "good" ? "Mark as good" : "Mark as bad"}"]`
      ),
    button: (text) =>
      [...doc.querySelectorAll("button")].find(
        (candidate) => candidate.textContent.trim() === text
      ),
    buttonStarting: (text) =>
      [...doc.querySelectorAll("button")].find((candidate) =>
        candidate.textContent.trim().startsWith(text)
      ),
    listbox: () => doc.querySelector('[role="listbox"]'),
    selected: () => doc.querySelector('[role="option"][aria-selected="true"]'),
    text: () => doc.body.textContent,
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
  return view;
}

const calls = (name) => dom.calls.filter(([called]) => called === name).map(([, args]) => args);

test(
  "the review form: chips from the recorded steps, keys outside fields, a kept draft, the revision saved",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    assert.equal(v.selected().id, "history-row-203");
    assert.equal(v.rate("good").getAttribute("aria-pressed"), "false");
    assert.equal(v.rate("bad").getAttribute("aria-pressed"), "false");
    assert.equal(v.form(), null, "nothing open before 👎");

    // B opens What went wrong?, nothing saved yet.
    await v.press("b");
    assert.ok(v.form());
    assert.equal(v.rate("bad").getAttribute("aria-pressed"), "true");
    assert.deepEqual(
      v.chips().map((chip) => chip.textContent),
      [
        "1Speech-to-Text",
        "2Glossary",
        "3Cleanup",
        "4Cleanup",
        "5Final touches",
        "6Delivery",
        "0Not sure",
      ]
    );
    assert.equal(v.textarea().value, CLEANUP, "starts as the final output");
    assert.deepEqual(saves, []);

    // A digit picks a chip; again, it's unpicked.
    await v.press("4");
    assert.deepEqual(
      v.chips().map((chip) => chip.getAttribute("aria-checked")),
      ["false", "false", "false", "true", "false", "false", "false"]
    );
    await v.press("0");
    await v.press("0");
    await v.press("4");

    // Typing in the fields never triggers a key.
    await v.act(() => v.setValue(v.textarea(), CORRECTION));
    await v.press("g", { target: v.textarea() });
    await v.press("2", { target: v.textarea() });
    await v.act(() => v.setValue(v.note(), NOTE));
    await v.press("b", { target: v.note() });
    assert.deepEqual(saves, []);
    assert.equal(v.chips()[3].getAttribute("aria-checked"), "true");

    // Another row and back: the draft is where it was.
    await v.press("ArrowDown", { target: v.listbox() });
    assert.equal(v.selected().id, "history-row-202");
    assert.equal(v.form(), null);
    await v.press("ArrowUp", { target: v.listbox() });
    assert.equal(v.selected().id, "history-row-203");
    assert.equal(v.textarea().value, CORRECTION);
    assert.equal(v.note().value, NOTE);
    assert.equal(v.chips()[3].getAttribute("aria-checked"), "true");

    // Ctrl+Enter in the correction saves, with the revision the form opened on.
    await v.press("Enter", { target: v.textarea(), ctrlKey: true });
    assert.deepEqual(saves, [
      {
        id: 203,
        revision: "rev-203-1",
        verdict: "bad",
        stage: { kind: "cleanup", seq: 3 },
        expectedText: CORRECTION,
        note: NOTE,
      },
    ]);
    assert.equal(v.form(), null);
    assert.match(v.text(), /You flagged this dictation\./);
    assert.match(v.text(), /Step you think got it wrong: Cleanup/);
    assert.ok(v.text().includes(CORRECTION));
    assert.equal(calls("hideControlPanel").length, 0, "the panel stays open");

    // Edit reopens it with what was saved; Esc closes an unchanged form.
    await v.act(() => v.button("Edit").click());
    assert.equal(v.textarea().value, CORRECTION);
    await v.press("Escape");
    assert.equal(v.form(), null);
    assert.equal(v.doc.querySelector('[role="dialog"]'), null, "nothing changed, nothing asked");

    // Delete review asks first: it had a correction.
    await v.act(() => v.button("Delete review").click());
    const dialog = v.doc.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /Delete this review\?/);
    const confirm = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Delete review"
    );
    await v.act(() => confirm.click());
    assert.deepEqual(calls("deleteHistoryFeedback"), [[203]]);
    assert.doesNotMatch(v.text(), /You flagged this dictation\./);

    const printed = v.consoleOutput.lines.join("\n");
    for (const text of DICTATED) assert.ok(!printed.includes(text), `"${text}" was printed`);
    assert.deepEqual(v.consoleOutput.errors, [], "nothing logged an error");
  }
);

test(
  "G saves good at once, the list shows it, and Flagged asks main",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    saves.length = 0;
    await v.press("ArrowDown", { target: v.listbox() });
    assert.equal(v.selected().id, "history-row-202");

    // A dictation from before step history: Delivery and Not sure only.
    await v.press("b");
    assert.deepEqual(
      v.chips().map((chip) => chip.textContent),
      ["1Delivery", "0Not sure"]
    );
    // G with an unchanged draft: good, at once.
    await v.press("g");
    assert.deepEqual(saves, [
      {
        id: 202,
        revision: "rev-202-1",
        verdict: "good",
        stage: null,
        expectedText: null,
        note: null,
      },
    ]);
    assert.equal(v.form(), null);
    assert.equal(v.rate("good").getAttribute("aria-pressed"), "true");

    // Main says the review changed: the row is re-read with its rating.
    await v.act(() =>
      listeners.onHistoryFeedbackChanged.forEach((callback) => callback({ id: 202 }))
    );
    assert.ok(v.selected().querySelector('[aria-label="Marked good"]'));

    // 👍 again takes it back.
    await v.act(() => v.rate("good").click());
    assert.deepEqual(calls("deleteHistoryFeedback").at(-1), [202]);
    assert.equal(v.rate("good").getAttribute("aria-pressed"), "false");

    // A failed dictation can be reviewed; its correction starts empty.
    await v.press("ArrowDown", { target: v.listbox() });
    assert.equal(v.selected().id, "history-row-201");
    await v.press("b");
    assert.equal(v.textarea().value, "");

    // Flagged goes to main and lists what was marked bad.
    ratings.set(203, "bad");
    await v.act(() => v.buttonStarting("Flagged").click(), 300);
    assert.equal(listRequests.at(-1).filters.flagged, true);
    assert.deepEqual(
      [...v.doc.querySelectorAll('[role="option"]')].map((option) => option.id),
      ["history-row-203"]
    );
    assert.ok(v.doc.querySelector('#history-row-203 [aria-label="Marked bad"]'));
    await v.act(() => v.button("All").click(), 300);
    ratings.clear();
    assert.deepEqual(v.consoleOutput.errors, [], "nothing logged an error");
  }
);

test(
  "a dictation that changed under its review: the draft goes, with a notice",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    saves.length = 0;
    v.store.useHistoryViewStore.setState({ drafts: {} });
    await v.act(() => v.store.requestHistoryItem(203));

    // Saving finds a newer version: nothing kept, the dictation re-read.
    await v.press("b");
    await v.act(() => v.setValue(v.textarea(), CORRECTION));
    versions.set(203, 2);
    saveReply = { success: false, code: "STALE" };
    const reads = calls("getHistoryItem").length;
    await v.press("Enter", { target: v.textarea(), ctrlKey: true });
    assert.equal(saves.at(-1).revision, "rev-203-1");
    assert.ok(calls("getHistoryItem").length > reads, "re-read");
    assert.match(v.text(), /This dictation changed since you opened the review/);
    assert.equal(v.form(), null);

    // A retry while a draft is open: a new version, the draft dropped.
    await v.press("b");
    await v.act(() => v.setValue(v.textarea(), CORRECTION));
    versions.set(203, 3);
    await v.act(() =>
      listeners.onTranscriptionUpdated.forEach((callback) => callback({ id: 203 }))
    );
    assert.equal(v.form(), null);
    assert.match(v.text(), /This dictation changed, so your unsaved review of it was discarded\./);

    // With history off, the form says why it can't be kept.
    await v.press("b");
    saveReply = { success: false, code: "HISTORY_OFF", reason: "history-off" };
    await v.act(() => v.buttonStarting("Save").click());
    assert.match(v.text(), /Reviews are kept only while local history is on\./);
    assert.ok(v.form(), "the draft stays");
    await v.press("Escape");
    assert.deepEqual(v.consoleOutput.errors, [], "nothing logged an error");
  }
);

test(
  "the review hotkey: 👎 preselected, Save & close, Esc closes, a draft elsewhere asked about",
  { timeout: 90000 },
  async (t) => {
    const v = await mountHistory(t);
    saves.length = 0;
    v.store.useHistoryViewStore.setState({ drafts: {} });
    const hides = () => calls("hideControlPanel").length;

    await v.act(() => v.store.requestHistoryReview({ requestId: 1, id: 203 }), 100);
    assert.equal(v.selected().id, "history-row-203");
    assert.match(v.text(), /Your last dictation, opened to review it\./);
    assert.ok(v.form());
    assert.equal(v.rate("bad").getAttribute("aria-pressed"), "true");
    assert.equal(v.doc.activeElement, v.chips()[0], "the first step chip has focus");
    assert.ok(v.buttonStarting("Save & close"));
    // Above the steps, not after them.
    const steps = v.doc.querySelector('ol[aria-label="Steps"]');
    assert.ok(v.form().compareDocumentPosition(steps) & v.win.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.deepEqual(saves, [], "a draft, not a review");

    await v.press("3", { target: v.doc.activeElement });
    await v.press("Enter", { target: v.doc.activeElement, ctrlKey: true });
    assert.deepEqual(saves.at(-1).stage, { kind: "cleanup", seq: 2 });
    assert.equal(hides(), 1, "Save & close hides the panel");
    assert.match(v.text(), /You flagged this dictation\./);
    assert.doesNotMatch(v.text(), /Your last dictation, opened to review it\./);

    // Esc in an unchanged hotkey review: discarded, the panel hidden, nothing saved.
    const saveCount = saves.length;
    await v.act(() => v.store.requestHistoryReview({ requestId: 2, id: 202 }), 100);
    assert.ok(v.form());
    await v.press("Escape", { target: v.doc.activeElement });
    assert.equal(v.form(), null);
    assert.equal(hides(), 2);
    assert.equal(saves.length, saveCount);

    // Esc after a change asks first.
    await v.act(() => v.store.requestHistoryReview({ requestId: 3, id: 202 }), 100);
    await v.act(() => v.setValue(v.note(), NOTE));
    await v.act(() => v.note().blur());
    await v.press("Escape");
    let dialog = v.doc.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /Discard your review\?/);
    await v.act(() =>
      [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Discard").click()
    );
    assert.equal(hides(), 3);
    assert.equal(v.form(), null);

    // A changed draft on the shown row: asked before switching, and kept.
    await v.press("b");
    await v.act(() => v.setValue(v.note(), NOTE));
    await v.act(() => v.store.requestHistoryReview({ requestId: 4, id: 201 }), 100);
    dialog = v.doc.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /Open your last dictation\?/);
    await v.act(() =>
      [...dialog.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Open last dictation")
        .click()
    );
    assert.equal(v.selected().id, "history-row-201");
    assert.ok(
      Object.values(v.store.useHistoryViewStore.getState().drafts).some(
        (draft) => draft.id === 202 && draft.note === NOTE
      ),
      "the other draft is kept"
    );
    await v.press("Escape");

    // Nothing to open: History with no selection, and a notice.
    await v.act(() => v.store.requestHistoryReview({ requestId: 5, id: null }), 100);
    assert.equal(v.selected(), null);
    assert.match(v.text(), /Couldn't find your last dictation's details\./);

    const printed = v.consoleOutput.lines.join("\n");
    for (const text of DICTATED) assert.ok(!printed.includes(text), `"${text}" was printed`);
    assert.deepEqual(v.consoleOutput.errors, [], "nothing logged an error");
  }
);
