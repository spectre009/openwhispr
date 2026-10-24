const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// Dictation › Overview rendered (happy-dom, stubbed preload): each step of the
// strip opens its page (Dictionary leaves Settings), the "Last dictation" card
// reads the newest dictation's saved steps through the same IPC as History ›
// View steps and shows each of its states, and dictated text never reaches a
// log or any other preload call.

const STT_TEXT = "so um the meeting with little body is uh moved to thursday";
const GLOSSARY_TEXT = "so um the meeting with Little Buddy is uh moved to thursday";
const CLEANUP_TEXT = "The meeting with Little Buddy is moved to Thursday.";
const DICTATED = [STT_TEXT, GLOSSARY_TEXT, CLEANUP_TEXT, "little body", "moved to Thursday"];

const step = (kind, output, extra = {}) => ({
  kind,
  outcome: "ok",
  output,
  provider: null,
  model: null,
  ms: null,
  errorCode: null,
  prompt: null,
  detail: null,
  ...extra,
});

const replies = new Map([
  [
    42,
    {
      success: true,
      status: "captured",
      context: { targetApp: "Code.exe" },
      steps: [
        step("stt", STT_TEXT, { ms: 400 }),
        step("glossary", GLOSSARY_TEXT, {
          detail: {
            revision: 1,
            rulesFired: [{ ruleId: "r", from: "little body", to: "Little Buddy", index: 23 }],
          },
        }),
        step("cleanup", CLEANUP_TEXT, { model: "claude-haiku-4-5", ms: 700 }),
      ],
    },
  ],
  [43, { success: true, status: "none", steps: [] }],
  [44, { success: false }],
  [45, { success: true, status: "otherOwner", steps: [] }],
]);

let dom;
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      getLogLevel: async () => "trace",
      getHotkeyModeInfo: async () => ({
        isUsingNativeShortcut: false,
        isUsingHyprland: false,
        supportsPushToTalk: true,
        pushToTalkUnavailableReason: null,
      }),
      getTranscriptionSteps: async (id) => replies.get(id),
    },
    storage: { dictationKey: "Control+`", activationMode: "push" },
  });
});

test.after(async () => {
  await dom.close();
});

const row = (id) => ({
  id,
  text: CLEANUP_TEXT,
  raw_text: STT_TEXT,
  timestamp: "2026-10-24 07:00:00",
  created_at: "2026-10-24 07:00:00",
  has_audio: 0,
  audio_duration_ms: null,
  provider: null,
  model: null,
  status: "completed",
  error_message: null,
  error_code: null,
  client_transcription_id: `c-${id}`,
  cloud_id: null,
  sync_status: "pending",
  deleted_at: null,
});

test(
  "the overview opens each step's page and shows the last dictation's states",
  { timeout: 90000 },
  async (t) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const consoleOutput = captureConsole(t);
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const h = React.createElement;
    const vite = await createRendererServer(t, {
      resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    });
    await vite.ssrLoadModule("/i18n.ts");
    const { default: DictationOverview } = await vite.ssrLoadModule(
      "/components/settings/DictationOverview.tsx"
    );
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const { addTranscription } = await vite.ssrLoadModule("/stores/transcriptionStore.ts");
    const { SettingsLinkContext } = await vite.ssrLoadModule(
      "/components/settings/settingsLink.ts"
    );
    const { OPEN_HISTORY_ITEM_EVENT } = await vite.ssrLoadModule("/utils/openHistoryItem.ts");

    const navigations = [];
    const elsewhere = [];
    const links = [];
    const opened = [];
    dom.window.addEventListener(OPEN_HISTORY_ITEM_EVENT, (event) => opened.push(event.detail.id));

    useSettingsStore.setState({ dataRetentionEnabled: true, useCleanupModel: true });

    const doc = dom.window.document;
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const root = createRoot(host);
    t.after(async () => {
      await React.act(async () => root.unmount());
      host.remove();
    });
    const act = async (fn) => {
      await React.act(async () => {
        await fn();
        await settle();
      });
      await settle();
    };
    await act(() =>
      root.render(
        h(
          SettingsLinkContext.Provider,
          { value: (destination) => links.push(destination) },
          h(DictationOverview, {
            autoLearnCorrections: true,
            onNavigate: (page) => navigations.push(page),
            onOpenElsewhere: (location) => elsewhere.push(location),
          })
        )
      )
    );

    const card = () => doc.querySelector("[data-last-dictation]");
    const state = () => card().getAttribute("data-last-dictation");
    const node = (id) => doc.querySelector(`[data-overview-node="${id}"]`);

    // The strip: six steps; each but Personality is a button that opens its page.
    assert.ok(doc.querySelector('[data-setting-id="dictation.overview.pipeline"]'));
    assert.equal(doc.querySelectorAll("[data-overview-node]").length, 6);
    for (const [id, page] of [
      ["recognition", "recognition"],
      ["cleanup", "cleanup"],
      ["style", "styles"],
      ["output", "output"],
    ]) {
      assert.equal(node(id).tagName, "BUTTON", id);
      await act(() => node(id).click());
      assert.equal(navigations.at(-1), page, id);
    }
    await act(() => node("dictionary").click());
    assert.deepEqual(elsewhere, [{ view: "dictionary" }], "Dictionary leaves Settings");
    assert.equal(node("personality").tagName, "DIV");
    assert.equal(node("personality").getAttribute("aria-disabled"), "true");
    assert.match(node("personality").textContent, /Planned/);
    assert.match(node("output").textContent, /Auto-learn from corrections: On/);

    // The hotkeys card: the dictation hotkey and its mode, linking to the Hotkeys page.
    const hotkeys = doc.querySelector("[data-overview-hotkeys]");
    assert.match(hotkeys.textContent, /Ctrl\+`/);
    assert.match(hotkeys.textContent, /Hold/);
    const allHotkeys = [...hotkeys.querySelectorAll("button")].find((button) =>
      /All hotkeys/.test(button.textContent)
    );
    await act(() => allHotkeys.click());
    assert.equal(navigations.at(-1), "hotkeys");

    // No dictation yet.
    assert.equal(state(), "none");
    assert.match(card().textContent, /No dictations yet/);

    // History off: steps aren't saved; the link opens the switch.
    await act(() => useSettingsStore.setState({ dataRetentionEnabled: false }));
    assert.equal(state(), "historyOff");
    const privacyLink = [...card().querySelectorAll("button")].find((button) =>
      /Privacy & Data/.test(button.textContent)
    );
    await act(() => privacyLink.click());
    assert.deepEqual(links, ["privacyData#privacy.history"]);
    await act(() => addTranscription(row(42)));
    assert.equal(state(), "historyOff", "nothing is read while history is off");
    assert.ok(!dom.calls.some(([name]) => name === "getTranscriptionSteps"));

    // Captured: the steps side by side, named as View steps names them.
    await act(() => useSettingsStore.setState({ dataRetentionEnabled: true }));
    assert.equal(state(), "captured");
    const columns = [...card().querySelectorAll("[data-step-column]")];
    assert.deepEqual(
      columns.map((column) => column.querySelector("span").textContent),
      ["Speech-to-Text", "Glossary", "Cleanup", "Pasted"]
    );
    assert.equal(columns[1].querySelector("del").textContent, "little body");
    assert.equal(columns[1].querySelector("ins").textContent, "Little Buddy");
    assert.match(columns[2].textContent, /The meeting with Little Buddy is moved to Thursday\./);
    assert.match(columns[3].textContent, /App: Code\.exe · 1\.1 s in total/);
    const openInHistory = [...card().parentElement.querySelectorAll("button")].find((button) =>
      /Open in History/.test(button.textContent)
    );
    await act(() => openInHistory.click());
    assert.deepEqual(opened, [42]);

    // A newer row without steps, then one that fails to load, then another owner's.
    await act(() => addTranscription(row(43)));
    assert.equal(state(), "notCaptured");
    assert.match(card().textContent, /Steps not captured/);
    await act(() => addTranscription(row(44)));
    assert.equal(state(), "failed");
    assert.match(card().textContent, /Couldn't load the steps/);
    await act(() => addTranscription(row(45)));
    assert.equal(state(), "otherOwner");

    // Each row was read once, by id only.
    assert.deepEqual(
      dom.calls.filter(([name]) => name === "getTranscriptionSteps").map(([, args]) => args),
      [[42], [43], [44], [45]]
    );
    // Dictated text never reaches a preload call (logs included) or the console.
    const sent = JSON.stringify(dom.calls);
    const printed = consoleOutput.lines.join("\n");
    for (const text of DICTATED) {
      assert.ok(!sent.includes(text), `"${text}" was passed to the preload`);
      assert.ok(!printed.includes(text), `"${text}" was printed`);
    }
    assert.deepEqual(consoleOutput.errors, [], "nothing logged an error");
  }
);
