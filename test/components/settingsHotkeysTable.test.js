const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { installSettingsDom, captureConsole, settle } = require("../lib/settingsDomHarness");

// Settings › Hotkeys as one table, rendered in the real Settings (happy-dom,
// stubbed preload): every hotkey anchor search lands on is there once, the
// activation mode sits above the table and hides under a native shortcut as
// before, style rows show each style's key or why it has none (and a refused
// key's reason, the Ctrl+1 warning), and "Edit style" opens that style.

const STYLE = (id, name, emoji, enabled, extra = {}) => ({
  id,
  name,
  emoji,
  instruction: `Write it as ${name}.`,
  enabled,
  runMode: "two-step",
  appGlossary: true,
  examples: [],
  useVoice: false,
  hotkey: null,
  origin: "starter",
  updatedAt: 1,
  ...extra,
});

const LIBRARY = {
  version: 1,
  dictationStyleId: "plain",
  seededStarters: ["starter-teams", "starter-requirements", "starter-email"],
  styles: [
    STYLE("starter-teams", "Teams chat", "💬", true, { hotkey: "Control+1" }),
    STYLE("starter-requirements", "Requirements", "📋", false),
    STYLE("starter-email", "Email", "✉️", true),
  ],
};

let native = false;
let dom;
test.before(async () => {
  dom = await installSettingsDom({
    api: {
      getPlatform: () => "win32",
      getHotkeyModeInfo: async () => ({
        isUsingNativeShortcut: native,
        isUsingHyprland: false,
        supportsPushToTalk: !native,
        pushToTalkUnavailableReason: null,
      }),
    },
    storage: {
      dictationKey: "Control+`",
      activationMode: "push",
      voiceAgentKey: "Control+Alt+Space",
      dictationStyles: JSON.stringify(LIBRARY),
    },
  });
});

test.after(async () => {
  await dom.close();
});

async function mount(t) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const h = React.createElement;
  const vite = await createRendererServer(t, {
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  await vite.ssrLoadModule("/i18n.ts");
  const { default: SettingsModal } = await vite.ssrLoadModule("/components/SettingsModal.tsx");
  const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");
  const styleStore = await vite.ssrLoadModule("/stores/styleStore.ts");
  const { SETTINGS_SEARCH_DESCRIPTORS } = await vite.ssrLoadModule(
    "/components/settings/search/registry.ts"
  );
  const { default: reasoningService } = await vite.ssrLoadModule("/services/ReasoningService.ts");
  t.after(() => reasoningService.destroy());
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};

  const doc = dom.window.document;
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
  await act(() =>
    root.render(
      h(
        ToastProvider,
        null,
        h(
          SettingsProvider,
          null,
          h(SettingsModal, {
            open: true,
            request: { section: "hotkeys", id: 1 },
            onRequestClose: () => true,
            railItems: [],
            activeView: "home",
            onSelectView: () => {},
            onOpenSearch: () => {},
            onOpenElsewhere: () => {},
          })
        )
      )
    )
  );
  const page = () => doc.querySelector('[data-settings-page-id="hotkeys"]');
  const anchors = (id) => page().querySelectorAll(`[data-setting-id="${id}"]`);
  const hotkeyRows = () =>
    [...page().querySelectorAll("[data-hotkey-row]")].map((row) =>
      row.getAttribute("data-hotkey-row")
    );
  const row = (id) => page().querySelector(`[data-hotkey-row="${id}"]`);
  const descriptors = SETTINGS_SEARCH_DESCRIPTORS.filter(
    (descriptor) => descriptor.kind === "setting" && descriptor.location?.page === "hotkeys"
  );
  return { doc, act, page, anchors, hotkeyRows, row, descriptors, styleStore };
}

test(
  "every hotkey sits in one table, with the activation mode above it",
  { timeout: 90000 },
  async (t) => {
    const consoleOutput = captureConsole(t);
    native = false;
    const s = await mount(t);
    await s.act(() =>
      s.styleStore.applyStyleHotkeyState(
        {
          bindings: [
            {
              hotkey: "Control+1",
              styleId: "starter-teams",
              active: false,
              error: "Another app owns this key",
            },
          ],
          supported: true,
          unsupportedReason: null,
        },
        { releaseOrphans: false }
      )
    );

    // Search lands on each of these: every hotkeys descriptor's anchor renders once.
    assert.deepEqual(s.descriptors.map((descriptor) => descriptor.anchor).sort(), [
      "hotkeys.activationMode",
      "hotkeys.assistant",
      "hotkeys.cancel",
      "hotkeys.dictation",
      "hotkeys.meeting",
      "hotkeys.meetingLayout",
      "hotkeys.review",
      "hotkeys.styles",
      "hotkeys.translation",
    ]);
    for (const descriptor of s.descriptors) {
      assert.equal(s.anchors(descriptor.anchor).length, 1, descriptor.anchor);
    }

    // One table: Action · Hotkey · How, rows in the mockup's order.
    const table = s.page().querySelector('[role="table"]');
    assert.ok(table);
    assert.deepEqual(
      [...table.querySelectorAll('[role="columnheader"]')].map((cell) => cell.textContent),
      ["Action", "Hotkey", "How", "Actions"]
    );
    assert.deepEqual(s.hotkeyRows(), [
      "dictation",
      "style:starter-teams",
      "style:starter-requirements",
      "style:starter-email",
      "assistant",
      "translation",
      "review",
      "meeting",
      "cancel",
    ]);
    // The activation mode is above the table, not in it.
    const activation = s.anchors("hotkeys.activationMode")[0];
    assert.equal(table.contains(activation), false);
    assert.ok(
      activation.compareDocumentPosition(table) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING
    );
    // Rows keep today's controls: the editable hotkey fields, and the meeting layout select.
    for (const id of ["dictation", "assistant", "translation", "review", "meeting"]) {
      assert.ok(
        s
          .row(id)
          .querySelector('[role="button"][aria-label="Press a key combination to set hotkey"]'),
        `${id} keeps its hotkey field`
      );
    }
    assert.ok(s.row("meeting").contains(s.anchors("hotkeys.meetingLayout")[0]));
    assert.match(s.row("dictation").textContent, /Add another hotkey/);
    assert.match(s.row("dictation").textContent, /Hold/);
    assert.match(s.row("assistant").textContent, /Tap/);
    assert.match(s.row("cancel").textContent, /Esc/);
    assert.match(s.row("cancel").textContent, /While recording/);
    // Review last dictation: a tap slot with no default key, linking to History.
    assert.match(s.row("review").textContent, /Review Last Dictation Hotkey/);
    assert.match(s.row("review").textContent, /Tap/);
    assert.match(s.row("review").textContent, /History/);

    // Style rows: the key, a refusal's reason and the common-shortcut warning, as before.
    const teams = s.row("style:starter-teams");
    assert.match(teams.textContent, /Style: 💬 Teams chat/);
    assert.equal(teams.querySelector("kbd").textContent, "Ctrl+1");
    assert.match(teams.textContent, /Not working: Another app owns this key/);
    assert.match(teams.textContent, /Ctrl\+1 to Ctrl\+9 are shortcuts in many apps/);
    assert.match(teams.textContent, /Hold, like dictation/);
    assert.match(s.row("style:starter-requirements").textContent, /Style off/);
    assert.match(s.row("style:starter-email").textContent, /Not set/);

    // Wide pages (Overview, Styles, Hotkeys) widen the content; the others keep the reading width.
    const width = () =>
      s.doc
        .querySelector("[data-settings-content-width]")
        .getAttribute("data-settings-content-width");
    assert.equal(width(), "wide");
    assert.match(
      s.doc.querySelector("[data-settings-content-width]").className,
      /max-w-\[1240px\]/
    );

    // Edit style opens that style in Styles.
    const edit = s.row("style:starter-email").querySelector('button[title="Open Email in Styles"]');
    await s.act(() => edit.click(), 150);
    const styles = s.doc.querySelector('[data-settings-page-id="styles"]');
    assert.ok(styles && !styles.classList.contains("hidden"), "Styles shows");
    assert.equal(
      styles.querySelector("[data-style-detail]").getAttribute("data-style-detail"),
      "starter-email"
    );
    assert.equal(width(), "wide");
    await s.act(() => s.doc.querySelector('[data-settings-nav="app"]').click());
    assert.equal(width(), "reading");
    assert.match(s.doc.querySelector("[data-settings-content-width]").className, /max-w-\[920px\]/);

    assert.deepEqual(consoleOutput.errors, [], "nothing logged an error");
  }
);

test(
  "under a native shortcut the activation mode hides; refused style keys say why",
  { timeout: 90000 },
  async (t) => {
    const consoleOutput = captureConsole(t);
    native = true;
    const s = await mount(t);
    await s.act(() =>
      s.styleStore.applyStyleHotkeyState(
        {
          bindings: [],
          supported: false,
          unsupportedReason: "Style hotkeys need the native key listener",
        },
        { releaseOrphans: false }
      )
    );

    assert.equal(s.anchors("hotkeys.activationMode").length, 0, "hidden, as before");
    // Its search result falls back to the dictation row, which is there.
    const activation = s.descriptors.find(
      (descriptor) => descriptor.id === "hotkeys.activationMode"
    );
    assert.equal(s.anchors(activation.fallbackAnchor).length, 1);
    assert.match(s.row("dictation").textContent, /—/, "no mode to show");
    assert.match(s.row("styles").textContent, /Style hotkeys need the native key listener/);
    assert.match(s.row("style:starter-teams").textContent, /Like dictation|—/);
    for (const descriptor of s.descriptors) {
      if (descriptor.id === "hotkeys.activationMode") continue;
      assert.equal(s.anchors(descriptor.anchor).length, 1, descriptor.anchor);
    }

    assert.deepEqual(consoleOutput.errors, [], "nothing logged an error");
  }
);
