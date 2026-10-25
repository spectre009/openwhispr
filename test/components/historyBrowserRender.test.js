const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// The History view rendered (happy-dom, stubbed preload): the paged list with
// its marks, the detail of a dictation with steps (each step compared with the
// text it received), one from before step history and a failed one, ↑/↓, the
// search and a filter going to main, "Open in History" for a row the list
// doesn't show, a new dictation arriving at the top, and the audio's object
// URL released with the selection. Dictated text never reaches the console.

const STT = "open the open whisper repo";
const GLOSSARY = "open the OpenWhispr repo";
const CLEANUP = "Open the OpenWhispr repo.";
const OLD_RAW = "lets meet at three on thursday";
const OLD_FINAL = "Let's meet at 3 on Thursday.";
const DICTATED = [STT, GLOSSARY, CLEANUP, OLD_RAW, OLD_FINAL];

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
  ...extra,
});

const ROWS = [
  listRow(103, {
    preview: CLEANUP,
    app: "Code.exe",
    marks: [
      { kind: "glossary", change: "changed" },
      { kind: "cleanup", change: "changed" },
      { kind: "finalize", change: "same" },
    ],
  }),
  listRow(102, { preview: OLD_FINAL }),
  listRow(101, { status: "failed", errorCode: "TIMEOUT", hasAudio: true, audioDurationMs: 4000 }),
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

const ITEMS = new Map([
  [
    103,
    {
      success: true,
      item: item(103, { text: CLEANUP, rawText: STT }),
      status: "captured",
      route: "cleanup",
      context: { targetApp: "Code.exe" },
      steps: [
        step("stt", STT, { provider: "groq", model: "whisper-large-v3", ms: 800 }),
        step("glossary", GLOSSARY, {
          ms: 1,
          detail: {
            revision: 1,
            rulesFired: [{ ruleId: "r1", from: "open whisper", to: "OpenWhispr", index: 9 }],
          },
        }),
        step("cleanup", CLEANUP, {
          provider: "copilot",
          model: "claude-haiku-5.5",
          ms: 1200,
          prompt: { source: "resolved", hash: "abc", entryId: "default", text: "PROMPT" },
        }),
        step("finalize", CLEANUP, { ms: 0 }),
      ],
    },
  ],
  [
    102,
    {
      success: true,
      item: item(102, { text: OLD_FINAL, rawText: OLD_RAW }),
      status: "none",
      route: null,
      context: null,
      steps: [],
    },
  ],
  [
    101,
    {
      success: true,
      item: item(101, {
        status: "failed",
        errorCode: "TIMEOUT",
        errorMessage: "The connection timed out.",
        hasAudio: true,
        audioDurationMs: 4000,
      }),
      status: "none",
      route: null,
      context: null,
      steps: [],
    },
  ],
  [
    555,
    {
      success: true,
      item: item(555, { text: "An old one, far down.", rawText: "an old one far down" }),
      status: "none",
      route: null,
      context: null,
      steps: [],
    },
  ],
]);

let dom;
let layoutWidth = 1200;
const listeners = {};
const requests = [];
let pages = [];
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      listHistory: async (request) => {
        requests.push(request);
        if (pages.length > 0) return { success: true, rows: pages.shift(), nextCursor: null };
        // Main's paging: the rows before the cursor, newest first.
        const { cursor, limit = 50 } = request;
        const rows = ROWS.filter(
          (row) =>
            !cursor ||
            row.timestamp < cursor.timestamp ||
            (row.timestamp === cursor.timestamp && row.id < cursor.id)
        );
        return { success: true, rows: rows.slice(0, limit), nextCursor: null };
      },
      getHistoryApps: async () => ({ success: true, apps: ["Code.exe"] }),
      getHistoryItem: async (id) => ITEMS.get(id) ?? { success: false, code: "NOT_FOUND" },
      getAudioBuffer: async () => new ArrayBuffer(8),
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
  // A laid-out window: wide enough for list and detail side by side, unless a
  // test narrows it.
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
});

test.after(async () => {
  await dom.close();
});

// Renders the view as ControlPanel does, with recording stand-ins for its row actions.
async function mountHistory(t) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const consoleOutput = captureConsole(t);
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const h = React.createElement;
  const vite = await createRendererServer(t, {
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    // The test set's store loads the whole run pipeline, whose imports keep a
    // test process alive; the pin is all the view uses.
    mockModules: {
      "/stores/promptTestSetStore": `
        export const pins = [];
        export async function pinHistoryTestCase(id) {
          pins.push(id);
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
  const { pins } = await vite.ssrLoadModule("/stores/promptTestSetStore");
  const { requestHistoryItem, useHistoryViewStore } = await vite.ssrLoadModule(
    "/components/history/historyViewStore.ts"
  );
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ dataRetentionEnabled: true });

  const retries = [];
  const deletes = [];
  const settings = [];
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
  const listbox = () => doc.querySelector('[role="listbox"]');
  const view = {
    doc,
    win,
    act,
    consoleOutput,
    pins,
    retries,
    deletes,
    settings,
    requestHistoryItem,
    useHistoryViewStore,
    listbox,
    options: () => [...doc.querySelectorAll('[role="option"]')],
    selected: () => doc.querySelector('[role="option"][aria-selected="true"]'),
    button: (text) =>
      [...doc.querySelectorAll("button")].find(
        (candidate) => candidate.textContent.trim() === text
      ),
    key: (name) =>
      act(() =>
        listbox().dispatchEvent(
          new win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })
        )
      ),
  };
  await act(() =>
    root.render(
      h(
        ToastProvider,
        null,
        h(HistoryBrowser, {
          hotkey: "Control+`",
          onCopy: () => {},
          onDelete: (id) => deletes.push(id),
          onRetry: async (id, retryOptions) => {
            retries.push([id, retryOptions.routeKind]);
            retryOptions.onSettled();
          },
          onShowAudioInFolder: () => {},
          onOpenSettings: (destination) => settings.push(destination),
        })
      )
    )
  );
  return view;
}

test(
  "the History view lists, details, searches and follows main",
  { timeout: 90000 },
  async (t) => {
    // The object URLs the player makes and releases.
    const created = [];
    const revoked = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => {
      created.push(`blob:audio-${created.length}`);
      return created.at(-1);
    };
    URL.revokeObjectURL = (url) => revoked.push(url);
    const paused = [];
    globalThis.Audio = class {
      constructor(src) {
        this.src = src;
        this.paused = true;
        this.listeners = {};
      }
      addEventListener(name, listener) {
        this.listeners[name] = listener;
      }
      async play() {
        this.paused = false;
        this.listeners.play?.();
      }
      pause() {
        this.paused = true;
        paused.push(this.src);
      }
      removeAttribute() {}
      load() {}
    };
    t.after(() => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      delete globalThis.Audio;
    });

    const {
      doc,
      win,
      act,
      consoleOutput,
      pins,
      retries,
      deletes,
      settings,
      requestHistoryItem,
      useHistoryViewStore,
      options,
      selected,
      button,
      key,
    } = await mountHistory(t);

    // The first page, newest first, the first row shown beside it.
    assert.deepEqual(requests[0], {
      cursor: null,
      limit: 50,
      query: "",
      filters: { failed: false, cleanupChanged: false, app: null, flagged: false },
    });
    assert.equal(options().length, 3);
    assert.equal(selected().id, "history-row-103");
    const marks = [...options()[0].querySelectorAll("[title]")].map((mark) => mark.title);
    assert.deepEqual(marks, ["Glossary changed the text", "Cleanup changed the text"]);
    assert.match(options()[0].textContent, /Code\.exe/);
    assert.match(options()[2].textContent, /Transcription failed/);

    // A dictation with steps: each step compared with the text it received.
    const detail = () => doc.body.textContent;
    assert.match(detail(), /in Code\.exe/);
    assert.match(detail(), /sent to Code\.exe/);
    const strip = doc.querySelector('ol[aria-label="Steps"]');
    assert.equal(strip.querySelectorAll("button").length, 4);
    const removed = [...doc.querySelectorAll("del")].map((node) => node.textContent);
    const added = [...doc.querySelectorAll("ins")].map((node) => node.textContent);
    assert.deepEqual(removed, ["open whisper"]);
    assert.deepEqual(added, ["OpenWhispr", "."]);
    assert.ok(doc.querySelector('[title="was “open”"]'), "a case-only change is soft");
    assert.match(detail(), /open whisper.*OpenWhispr/s, "the glossary rule that fired");
    assert.match(detail(), /Built-in prompt · Show prompt/);
    assert.match(detail(), /copilot · claude-haiku-5\.5 · 1200 ms/);

    // Home's own pin: the row goes to the test set by id.
    await act(() => button("Add to test set").click());
    assert.deepEqual(pins, [103]);

    // Text instead of changes.
    await act(() => button("Text").click());
    assert.equal(doc.querySelectorAll("del, ins").length, 0);
    await act(() => button("Changes").click());

    // ↓: a dictation from before step history: heard against the final output.
    await key("ArrowDown");
    assert.equal(selected().id, "history-row-102");
    assert.match(detail(), /Step details weren't recorded for this dictation\./);
    assert.match(detail(), /Heard/);
    assert.match(detail(), /app not recorded/);
    assert.doesNotMatch(detail(), /Cleanup changed the text/);
    assert.ok(doc.querySelectorAll("ins").length > 0, "what changed between heard and final");

    // ↓: a failed one, with its audio and Re-transcribe.
    await key("ArrowDown");
    assert.equal(selected().id, "history-row-101");
    assert.match(detail(), /The connection timed out\./);
    assert.match(detail(), /Error: TIMEOUT/);
    await act(() => button("Re-transcribe").click());
    assert.deepEqual(retries, [[101, null]]);
    const play = doc.querySelector('button[aria-label="Play the recording"]');
    await act(() => play.click());
    assert.deepEqual(created, ["blob:audio-0"]);
    assert.deepEqual(
      dom.calls.filter(([name]) => name === "getAudioBuffer").map(([, args]) => args),
      [[101]]
    );

    // ↑ back: the player goes, its audio stopped and released.
    await key("ArrowUp");
    assert.equal(selected().id, "history-row-102");
    assert.deepEqual(paused, ["blob:audio-0"]);
    assert.deepEqual(revoked, ["blob:audio-0"]);

    // Typing in the search moves nothing; main searches after a pause.
    const search = doc.querySelector('input[aria-label="Search dictations"]');
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
    await act(() => {
      setter.call(search, "meet");
      search.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await act(() =>
      search.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    );
    assert.equal(useHistoryViewStore.getState().selectedId, 102);
    await act(() => {}, 300);
    assert.equal(requests.at(-1).query, "meet");

    // A filter goes to main too.
    pages = [[ROWS[2]]];
    await act(() => button("Failed").click(), 300);
    assert.deepEqual(requests.at(-1).filters, {
      failed: true,
      cleanupChanged: false,
      app: null,
      flagged: false,
    });
    assert.equal(options().length, 1);

    // "Open in History" for a row the list doesn't show: the detail shows it,
    // the list keeps its filter.
    await act(() => requestHistoryItem(555));
    assert.match(detail(), /An old one, far down\./);
    assert.equal(options().length, 1);
    assert.equal(button("Failed").getAttribute("aria-pressed"), "true");

    // A new dictation: the first page again, at the top, the selection kept.
    pages = [[listRow(104, { status: "failed" }), ROWS[2]]];
    await act(
      () => listeners.onTranscriptionAdded.forEach((callback) => callback({ id: 104 })),
      300
    );
    assert.equal(requests.at(-1).cursor, null);
    assert.deepEqual(
      options().map((option) => option.id),
      ["history-row-104", "history-row-101"]
    );
    assert.equal(useHistoryViewStore.getState().selectedId, 555);

    // The shown dictation is deleted elsewhere: nothing stays selected on it.
    await act(() => listeners.onTranscriptionDeleted.forEach((callback) => callback({ id: 555 })));
    assert.notEqual(useHistoryViewStore.getState().selectedId, 555);

    // All: no filter again.
    await act(() => button("All").click(), 300);
    assert.deepEqual(requests.at(-1).filters, {
      failed: false,
      cleanupChanged: false,
      app: null,
      flagged: false,
    });

    // Item reads go by id only; dictated text never reaches the console.
    for (const [name, args] of dom.calls) {
      if (name === "getHistoryItem") assert.equal(typeof args[0], "number");
    }
    const printed = consoleOutput.lines.join("\n");
    for (const text of DICTATED) assert.ok(!printed.includes(text), `"${text}" was printed`);
    assert.deepEqual(consoleOutput.errors, [], "nothing logged an error");
    assert.deepEqual(deletes, []);
    assert.deepEqual(settings, []);
  }
);

test(
  "a narrow window shows the list, and the detail over it with Back",
  { timeout: 90000 },
  async (t) => {
    layoutWidth = 700;
    t.after(() => {
      layoutWidth = 1200;
    });
    const {
      doc,
      act,
      consoleOutput,
      requestHistoryItem,
      useHistoryViewStore,
      options,
      selected,
      button,
      key,
      listbox,
    } = await mountHistory(t);
    const back = () => button("Back to the list");
    const listCovered = () => listbox().closest("[inert]") !== null;

    // The list fills the view; nothing opens by itself.
    assert.equal(options().length, 3);
    assert.equal(selected(), null);
    assert.equal(back(), undefined);

    // ↓ moves without opening; Enter opens, over the list.
    await key("ArrowDown");
    assert.equal(selected().id, "history-row-103");
    assert.equal(back(), undefined);
    await key("Enter");
    assert.ok(back(), "the detail opened");
    assert.match(doc.body.textContent, /sent to Code\.exe/);
    assert.equal(listCovered(), true, "the list underneath can't be reached");

    // Back: the list again, the selection kept.
    await act(() => back().click());
    assert.equal(back(), undefined);
    assert.equal(listCovered(), false);
    assert.equal(selected().id, "history-row-103");

    // A click opens straight away, and so does "Open in History".
    await act(() => options()[1].click());
    assert.ok(back());
    assert.match(doc.body.textContent, /Step details weren't recorded for this dictation\./);
    await act(() => back().click());
    await act(() => requestHistoryItem(555));
    assert.ok(back());
    assert.equal(useHistoryViewStore.getState().selectedId, 555);
    assert.match(doc.body.textContent, /An old one, far down\./);
    assert.deepEqual(consoleOutput.errors, [], "nothing logged an error");
  }
);
