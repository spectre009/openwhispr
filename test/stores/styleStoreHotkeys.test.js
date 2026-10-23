const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Style hotkeys (Stage 4) in the renderer. Main owns the bindings; the style
// record's `hotkey` mirrors them. Each window takes main's view at load and on
// every broadcast, and a change that leaves a style unable to hold a key
// (deleted, switched off), here or in another window, asks main to release it.
// window.electronAPI is a fake main.

const RECORD_KEY = "dictationStyles";
const TEAMS = "starter-teams";
const EMAIL = "starter-email";

const style = (id, name, extra = {}) => ({
  id,
  name,
  emoji: "",
  instruction: `Write it as ${name}.`,
  enabled: true,
  runMode: "two-step",
  appGlossary: true,
  examples: [],
  useVoice: false,
  hotkey: null,
  origin: "user",
  updatedAt: 1,
  ...extra,
});

const recordWith = (styles) =>
  JSON.stringify({ version: 1, dictationStyleId: "plain", seededStarters: [], styles });

const stateOf = (bindings, extra = {}) => ({
  bindings: bindings.map(([hotkey, styleId]) => ({ hotkey, styleId, active: true, error: null })),
  supported: true,
  unsupportedReason: null,
  ...extra,
});

const until = async (predicate, label) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
};

// A fake main: its bindings, what the windows asked of it, and its broadcast.
function fakeMain(initial) {
  const main = {
    state: stateOf(initial),
    syncCalls: [],
    setCalls: [],
    broadcast: null,
    refuse: null,
  };
  main.api = {
    getStyleHotkeys: async () => main.state,
    setStyleHotkey: async (styleId, hotkey) => {
      main.setCalls.push([styleId, hotkey]);
      if (main.refuse) return { success: false, message: main.refuse, ...main.state };
      const rest = main.state.bindings
        .filter((b) => b.styleId !== styleId)
        .map((b) => [b.hotkey, b.styleId]);
      main.state = stateOf(hotkey ? [...rest, [hotkey, styleId]] : rest);
      return { success: true, ...main.state };
    },
    syncStyleHotkeyStyles: async (styleIds) => {
      main.syncCalls.push([...styleIds]);
      main.state = stateOf(
        main.state.bindings
          .filter((b) => styleIds.includes(b.styleId))
          .map((b) => [b.hotkey, b.styleId])
      );
      return { success: true, ...main.state };
    },
    onStyleHotkeysChanged: (callback) => {
      main.broadcast = callback;
      return () => {};
    },
  };
  return main;
}

async function setup(t, { styles, bindings }) {
  const main = fakeMain(bindings);
  const storageListeners = [];
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { [RECORD_KEY]: recordWith(styles) },
    window: {
      electronAPI: main.api,
      addEventListener(type, listener) {
        if (type === "storage") storageListeners.push(listener);
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-style-hotkeys-store-" });
  const store = await vite.ssrLoadModule("/stores/styleStore.ts");
  const record = () => JSON.parse(storage.getItem(RECORD_KEY));
  const hotkeyOf = (id) => record().styles.find((s) => s.id === id)?.hotkey ?? null;
  return { main, store, storage, storageListeners, record, hotkeyOf };
}

test("a window takes main's bindings at load and mirrors them into the record", async (t) => {
  const { store, hotkeyOf } = await setup(t, {
    styles: [style(TEAMS, "Teams chat", { hotkey: "F9" }), style(EMAIL, "Email")],
    bindings: [["F21", TEAMS]],
  });

  await until(() => hotkeyOf(TEAMS) === "F21", "the mirror");
  assert.equal(hotkeyOf(EMAIL), null);
  assert.deepEqual(store.useStyleStore.getState().hotkeys.bindings, [
    { hotkey: "F21", styleId: TEAMS, active: true, error: null },
  ]);
  const library = store.useStyleStore.getState().library;
  assert.equal(library.styles.find((s) => s.id === TEAMS).updatedAt, 1, "not a user edit");
});

test("main's broadcast rewrites the mirror; a refusal leaves it as it was", async (t) => {
  const { main, store, hotkeyOf } = await setup(t, {
    styles: [style(TEAMS, "Teams chat"), style(EMAIL, "Email")],
    bindings: [],
  });
  await until(() => main.broadcast, "the listener");

  main.broadcast(stateOf([["Control+Alt+1", EMAIL]]));
  assert.equal(hotkeyOf(EMAIL), "Control+Alt+1");

  const ok = await store.setStyleHotkey(TEAMS, "F21");
  assert.deepEqual(ok, { success: true, message: undefined });
  assert.equal(hotkeyOf(TEAMS), "F21");

  main.refuse = '"F22" is already another style\'s hotkey.';
  const refused = await store.setStyleHotkey(TEAMS, "F22");
  assert.equal(refused.success, false);
  assert.equal(refused.message, main.refuse);
  assert.equal(hotkeyOf(TEAMS), "F21", "the record keeps main's committed key");
});

test("deleting or switching off a style asks main to release its key", async (t) => {
  const { main, store, hotkeyOf } = await setup(t, {
    styles: [style(TEAMS, "Teams chat"), style(EMAIL, "Email")],
    bindings: [
      ["F21", TEAMS],
      ["F22", EMAIL],
    ],
  });
  await until(() => hotkeyOf(EMAIL) === "F22", "the mirror");

  assert.equal(store.saveStyle(EMAIL, { enabled: false }), true);
  await until(() => main.syncCalls.length === 1, "the release");
  assert.deepEqual(main.syncCalls[0], [TEAMS]);
  await until(() => hotkeyOf(EMAIL) === null, "the mirror after the release");

  assert.equal(store.deleteStyle(TEAMS), true);
  await until(() => main.syncCalls.length === 2, "the second release");
  assert.deepEqual(main.syncCalls[1], []);
  assert.deepEqual(store.useStyleStore.getState().hotkeys.bindings, []);

  // A rename keeps the key: the binding is by id.
  main.broadcast(stateOf([]));
  const calls = main.syncCalls.length;
  store.createStyle({ name: "Notes", instruction: "Short notes.", id: "my-notes" });
  await store.setStyleHotkey("my-notes", "F23");
  assert.equal(store.saveStyle("my-notes", { name: "Meeting notes" }), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(main.syncCalls.length, calls, "nothing to release");
  assert.equal(hotkeyOf("my-notes"), "F23");
});

test("another window's change releases the key too", async (t) => {
  const { main, storage, storageListeners, hotkeyOf } = await setup(t, {
    styles: [style(TEAMS, "Teams chat"), style(EMAIL, "Email")],
    bindings: [["F21", TEAMS]],
  });
  await until(() => hotkeyOf(TEAMS) === "F21", "the mirror");

  // Another window switched Teams chat off.
  const next = recordWith([
    style(TEAMS, "Teams chat", { enabled: false, hotkey: "F21" }),
    style(EMAIL, "Email"),
  ]);
  storage.setItem(RECORD_KEY, next);
  for (const listener of storageListeners) {
    listener({ storageArea: globalThis.localStorage, key: RECORD_KEY, newValue: next });
  }

  await until(() => main.syncCalls.length === 1, "the release");
  assert.deepEqual(main.syncCalls[0], [EMAIL]);
  await until(() => hotkeyOf(TEAMS) === null, "the mirror after the release");
});

test("the style hotkey helpers: common-shortcut warnings and named conflicts", async () => {
  const { commonAppShortcut, styleHotkeyConflicts } =
    await import("../../src/utils/styleHotkeys.ts");
  for (const key of ["Control+1", "Ctrl+5", "CommandOrControl+9"]) {
    assert.equal(commonAppShortcut(key, "win32"), "ctrlDigit", key);
  }
  assert.equal(commonAppShortcut("Control+Shift+`", "win32"), "vscodeTerminal");
  assert.equal(commonAppShortcut("Shift+Control+`", "win32"), "vscodeTerminal");
  for (const key of ["Control+Alt+1", "Control+0", "F21", "Control+`", ""]) {
    assert.equal(commonAppShortcut(key, "win32"), null, key);
  }

  const { createEmptyStyleLibrary } = await import("../../src/config/styles/library.ts");
  const library = createEmptyStyleLibrary();
  library.styles.push(style(TEAMS, "Teams chat", { emoji: "💬" }));
  const t = (key, values) => `${key}${values ? JSON.stringify(values) : ""}`;
  const bindings = [
    { hotkey: "F21", styleId: TEAMS },
    { hotkey: "F22", styleId: "gone" },
  ];
  assert.deepEqual(styleHotkeyConflicts(bindings, library, t), [
    { hotkey: "F21", label: 'styles.hotkey.conflictLabel{"name":"💬 Teams chat"}' },
    { hotkey: "F22", label: "styles.hotkey.conflictLabelUnknown" },
  ]);
  assert.deepEqual(
    styleHotkeyConflicts(bindings, library, t, TEAMS).map((entry) => entry.hotkey),
    ["F22"],
    "the style being edited is not its own conflict"
  );
});

test("the record's mirror and the eligible styles, as pure functions", async () => {
  const {
    applyStyleHotkeyBindings,
    createEmptyStyleLibrary,
    hotkeyEligibleStyleIds,
    orphanedStyleHotkeys,
  } = await import("../../src/config/styles/library.ts");
  const library = createEmptyStyleLibrary();
  library.styles.push(
    style(TEAMS, "Teams chat", { hotkey: "F9" }),
    style(EMAIL, "Email", { enabled: false }),
    style("empty", "Empty", { instruction: "  " })
  );

  assert.deepEqual(hotkeyEligibleStyleIds(library), [TEAMS]);
  assert.deepEqual(
    orphanedStyleHotkeys(library, [{ styleId: TEAMS }, { styleId: EMAIL }, { styleId: "gone" }]),
    [EMAIL, "gone"]
  );
  assert.equal(applyStyleHotkeyBindings(library, [{ hotkey: "F21", styleId: TEAMS }]), true);
  assert.equal(library.styles[0].hotkey, "F21");
  assert.equal(applyStyleHotkeyBindings(library, [{ hotkey: "F21", styleId: TEAMS }]), false);
  assert.equal(applyStyleHotkeyBindings(library, []), true);
  assert.equal(library.styles[0].hotkey, null);
});
