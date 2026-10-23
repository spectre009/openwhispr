const test = require("node:test");
const assert = require("node:assert/strict");

// Style hotkeys (Stage 4) on the dictation slot: one builder makes the slot's
// key list (the dictation key, then each style's key), a key inside the slot
// is never bound twice, a style key is committed only after it registered and
// rolled back when it didn't, a backend that can't serve style keys refuses
// them with a reason, and the map persists as DICTATION_STYLE_KEYS. Electron's
// globalShortcut is a stub: nothing registers a real global hotkey.

const registered = new Map();
const refused = new Set();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        if (refused.has(accelerator) || registered.has(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        registered.delete(accelerator);
      },
      isRegistered(accelerator) {
        return registered.has(accelerator);
      },
      unregisterAll() {
        registered.clear();
      },
    },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
  },
};

const dotenv = require("dotenv");
const HotkeyManager = require("../../src/helpers/hotkeyManager.js");
const {
  buildDictationSlotKeys,
  canonicalHotkey,
  parseStyleKeyMap,
  serializeStyleKeyMap,
} = require("../../src/helpers/hotkeyList.js");
const { createStyleHotkeys } = require("../../src/helpers/styleHotkeys.js");

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const setPlatform = (value) =>
  Object.defineProperty(process, "platform", { value, configurable: true });

test.beforeEach(() => {
  registered.clear();
  refused.clear();
  setPlatform("win32");
});
test.after(() => Object.defineProperty(process, "platform", originalPlatform));

const TEAMS = "starter-teams";
const EMAIL = "starter-email";
const REQUIREMENTS = "starter-requirements";

// A dictation slot registered the way startup does it (env DICTATION_KEY).
function startSlot({ dictation = "Control+`", styleKeys = [] } = {}) {
  const manager = new HotkeyManager();
  const notified = [];
  manager.notifyActiveHotkey = () => {};
  manager.notifyHotkeyFailure = (hotkey, result) => notified.push({ hotkey, ...result });
  manager.setStyleKeys(new Map(styleKeys));
  const presses = [];
  const callback = (hotkey) => presses.push(hotkey);
  const result = manager.setupShortcuts(dictation, callback);
  return { manager, result, callback, presses, notified };
}

test("the slot builder lists the dictation keys first, then each style key, once", () => {
  const built = buildDictationSlotKeys("Control+`,F8", [
    ["Control+Alt+1", TEAMS],
    ["ctrl+`", EMAIL],
    ["Alt+Control+1", REQUIREMENTS],
    ["F21", REQUIREMENTS],
  ]);

  assert.deepEqual(built.keys, ["Control+`", "F8", "Control+Alt+1", "F21"]);
  assert.deepEqual(built.dictationKeys, ["Control+`", "F8"]);
  assert.deepEqual(
    built.duplicates.map((entry) => [entry.hotkey, entry.conflictsWith.kind]),
    [
      ["ctrl+`", "dictation"],
      ["Alt+Control+1", "style"],
    ],
    "a repeat in any spelling is left out; the dictation key wins"
  );
  assert.equal(canonicalHotkey("Shift+Ctrl+a"), canonicalHotkey("Control+Shift+A"));
  assert.equal(canonicalHotkey("CommandOrControl+1", "win32"), canonicalHotkey("Control+1"));
  assert.notEqual(canonicalHotkey("Control+1"), canonicalHotkey("Control+Alt+1"));
});

test("startup registers the style keys with the dictation slot, and each names its style", () => {
  const { manager, result, presses } = startSlot({
    styleKeys: [
      ["F21", TEAMS],
      ["Control+Alt+2", REQUIREMENTS],
    ],
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.hotkeys, ["Control+`"], "only the dictation key is reported as it");
  assert.equal(manager.getCurrentHotkey(), "Control+`");
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["Control+`", "F21", "Control+Alt+2"]);
  assert.deepEqual(manager.getDictationHotkeys(), ["Control+`"]);
  assert.equal(manager.getStyleIdForHotkey("F21"), TEAMS);
  assert.equal(manager.getStyleIdForHotkey("Control+Alt+2"), REQUIREMENTS);
  assert.equal(manager.getStyleIdForHotkey("Control+`"), null, "the dictation key names none");

  // Each registration passes the key that fired, which the press maps to a style.
  registered.get("F21")();
  registered.get("Control+`")();
  assert.deepEqual(presses, ["F21", "Control+`"]);

  // Hold watches every key of the slot through the native listener.
  assert.deepEqual(manager.getNativeListenerKeys("push"), ["Control+`", "F21", "Control+Alt+2"]);
  assert.deepEqual(manager.getNativeListenerKeys("tap"), []);
  assert.deepEqual(
    manager.getStyleKeyState().bindings.map((binding) => [binding.hotkey, binding.active]),
    [
      ["F21", true],
      ["Control+Alt+2", true],
    ]
  );
});

test("a style key that repeats a key inside the dictation slot is refused", () => {
  const { manager } = startSlot({ styleKeys: [["F21", TEAMS]] });

  const sameAsDictation = manager.setStyleKey(EMAIL, "Ctrl+`");
  assert.equal(sameAsDictation.success, false);
  assert.equal(sameAsDictation.reason, "style_key_duplicate");
  assert.match(sameAsDictation.error, /already the dictation hotkey/);

  const sameAsStyle = manager.setStyleKey(EMAIL, "F21");
  assert.equal(sameAsStyle.success, false);
  assert.equal(sameAsStyle.reason, "style_key_duplicate");
  assert.match(sameAsStyle.error, /another style's hotkey/);

  assert.deepEqual([...manager.getStyleKeys()], [["F21", TEAMS]], "nothing was committed");
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["Control+`", "F21"]);
});

test("the dictation hotkey can't take a style key, and other slots name it a style key", async () => {
  const { manager, callback } = startSlot({ styleKeys: [["F21", TEAMS]] });

  const update = await manager.updateHotkey("F21", callback);
  assert.equal(update.success, false);
  assert.equal(update.reason, "style_key_conflict");
  assert.deepEqual(manager.getDictationHotkeys(), ["Control+`"]);

  const voiceAgent = await manager.registerSlot("voiceAgent", "F21", () => {}, { atomic: true });
  assert.equal(voiceAgent.success, false);
  assert.equal(voiceAgent.reason, "slot_conflict");
  assert.equal(voiceAgent.conflictStyleId, TEAMS);
  assert.match(voiceAgent.error, /already a style hotkey/);

  // A style key taken by another slot is refused by the existing check too.
  await manager.registerSlot("translation", "F9", () => {}, { atomic: true });
  const clash = manager.setStyleKey(EMAIL, "F9");
  assert.equal(clash.success, false);
  assert.equal(clash.reason, "slot_conflict");
});

test("changing the dictation hotkey keeps the style keys registered after it", async () => {
  const { manager, callback } = startSlot({ styleKeys: [["F21", TEAMS]] });

  const update = await manager.updateHotkey("F8", callback);
  assert.equal(update.success, true);
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["F8", "F21"]);
  assert.equal(manager.getStyleIdForHotkey("F21"), TEAMS);
  assert.equal(registered.has("Control+`"), false);
});

test("a style key is committed only after it registered, and a failure rolls back", () => {
  const { manager } = startSlot({ styleKeys: [["F21", TEAMS]] });
  refused.add("Control+Alt+9");

  const moved = manager.setStyleKey(TEAMS, "Control+Alt+9");
  assert.equal(moved.success, false);
  assert.match(moved.error, /Could not register "Control\+Alt\+9"/);
  assert.deepEqual([...manager.getStyleKeys()], [["F21", TEAMS]], "the map is unchanged");
  assert.equal(registered.has("F21"), true, "the previous key is registered again");
  assert.equal(manager.getStyleIdForHotkey("F21"), TEAMS);
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["Control+`", "F21"]);

  // A first key that fails leaves nothing behind.
  const added = manager.setStyleKey(EMAIL, "Control+Alt+9");
  assert.equal(added.success, false);
  assert.equal(manager.getStyleKeys().has("Control+Alt+9"), false);

  // Moving to a free key releases the old one.
  const ok = manager.setStyleKey(TEAMS, "F22");
  assert.equal(ok.success, true);
  assert.deepEqual([...manager.getStyleKeys()], [["F22", TEAMS]]);
  assert.equal(registered.has("F21"), false);
  assert.equal(registered.has("F22"), true);
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["Control+`", "F22"]);
});

test("a deleted or switched-off style releases its key", () => {
  const { manager } = startSlot({
    styleKeys: [
      ["F21", TEAMS],
      ["F22", EMAIL],
    ],
  });

  assert.deepEqual(manager.syncStyleKeys([TEAMS, EMAIL]), { success: true, changed: false });
  assert.deepEqual(manager.syncStyleKeys([EMAIL]), { success: true, changed: true });
  assert.deepEqual([...manager.getStyleKeys()], [["F22", EMAIL]]);
  assert.equal(registered.has("F21"), false);
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["Control+`", "F22"]);

  assert.deepEqual(manager.setStyleKey(EMAIL, null), { success: true, changed: true });
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["Control+`"]);
});

for (const [backend, setup, pattern] of [
  ["GNOME", (m) => (m.useGnome = true), /GNOME, KDE and Hyprland/],
  ["KDE", (m) => (m.useKDE = true), /GNOME, KDE and Hyprland/],
  ["Hyprland", (m) => (m.useHyprland = true), /GNOME, KDE and Hyprland/],
  ["macOS", () => setPlatform("darwin"), /macOS/],
  ["Linux", () => setPlatform("linux"), /Linux/],
]) {
  test(`${backend} refuses a style key with a reason instead of dropping it`, () => {
    const { manager } = startSlot({ styleKeys: [] });
    setup(manager);

    const result = manager.setStyleKey(TEAMS, "F21");
    assert.equal(result.success, false);
    assert.match(result.error, pattern);
    assert.equal(manager.getStyleKeys().size, 0);
    assert.equal(registered.has("F21"), false);
    const state = manager.getStyleKeyState();
    assert.equal(state.supported, false);
    assert.match(state.unsupportedReason, pattern);
  });
}

test("a committed key the backend can't serve stays listed as inactive, with its reason", () => {
  setPlatform("linux");
  const { manager, result } = startSlot({ dictation: "F8", styleKeys: [["F21", TEAMS]] });

  assert.equal(result.success, true, "the dictation key still registers");
  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["F8"]);
  assert.equal(manager.getStyleIdForHotkey("F21"), null);
  const [binding] = manager.getStyleKeyState().bindings;
  assert.equal(binding.hotkey, "F21");
  assert.equal(binding.active, false);
  assert.match(binding.error, /Linux/);
});

test("a fallback dictation key that repeats a style key wins, and the style key says why", () => {
  const { manager } = startSlot({ dictation: "F21", styleKeys: [["F21", TEAMS]] });

  assert.deepEqual(manager.getSlotHotkeys("dictation"), ["F21"]);
  assert.equal(manager.getStyleIdForHotkey("F21"), null, "the press is the dictation key's");
  const [binding] = manager.getStyleKeyState().bindings;
  assert.equal(binding.active, false);
  assert.match(binding.error, /already the dictation hotkey/);
});

test("DICTATION_STYLE_KEYS round-trips through .env, and bad entries are skipped", () => {
  const map = new Map([
    ["Control+`", TEAMS],
    ["Control+,", EMAIL],
    ["Control+Shift+#", REQUIREMENTS],
  ]);
  const value = serializeStyleKeyMap(map);
  assert.doesNotMatch(value, /#/, "an unquoted .env value would end at #");

  const parsed = dotenv.parse(`DICTATION_STYLE_KEYS=${value}\nOTHER=1\n`);
  assert.deepEqual([...parseStyleKeyMap(parsed.DICTATION_STYLE_KEYS)], [...map]);

  assert.equal(serializeStyleKeyMap(new Map()), "", "an empty map leaves the line out");
  const messy = JSON.stringify({
    F21: TEAMS,
    F22: TEAMS, // a style keeps its first key
    F23: "plain",
    F24: 7,
    "F1,F2": EMAIL,
    "": EMAIL,
    "Control+Alt+3": "bad id!",
  });
  assert.deepEqual([...parseStyleKeyMap(messy)], [["F21", TEAMS]]);
  assert.deepEqual([...parseStyleKeyMap("not json")], []);
  assert.deepEqual([...parseStyleKeyMap("[1,2]")], []);
});

// --- The service: one change at a time, .env after registration, rollback ----

function makeService({ styleKeys = [], saveFails = false } = {}) {
  const slot = startSlot({ styleKeys });
  const saved = [];
  const broadcasts = [];
  let reconciles = 0;
  const environmentManager = {
    value: serializeStyleKeyMap(new Map(styleKeys)),
    getDictationStyleKeys() {
      return this.value;
    },
    async saveDictationStyleKeys(value) {
      if (saveFails) throw new Error("disk full");
      this.value = value;
      saved.push(value);
      return { success: true };
    },
  };
  const service = createStyleHotkeys({
    hotkeyManager: slot.manager,
    environmentManager,
    reconcileNativeKeyListeners: () => reconciles++,
    broadcast: (channel, state) => broadcasts.push({ channel, state }),
    logger: { warn() {}, debug() {} },
  });
  return { ...slot, service, saved, broadcasts, environmentManager, reconciles: () => reconciles };
}

test("binding a key writes .env after it registered and tells every window", async () => {
  const { service, saved, broadcasts, manager, reconciles } = makeService();

  const result = await service.set(TEAMS, "F21");
  assert.equal(result.success, true);
  assert.deepEqual(result.bindings, [{ hotkey: "F21", styleId: TEAMS, active: true, error: null }]);
  assert.deepEqual(saved, [JSON.stringify({ F21: TEAMS })]);
  assert.equal(broadcasts.at(-1).channel, "style-hotkeys-changed");
  assert.equal(manager.getStyleIdForHotkey("F21"), TEAMS);
  assert.ok(reconciles() > 0, "the native listeners follow the slot");

  const refusedResult = await service.set(EMAIL, "F21");
  assert.equal(refusedResult.success, false);
  assert.match(refusedResult.message, /another style's hotkey/);
  assert.equal(saved.length, 1, "a refusal writes nothing");
});

test("changes run one at a time, in order", async () => {
  const { service, saved } = makeService();
  await Promise.all([
    service.set(TEAMS, "F21"),
    service.set(EMAIL, "F21"),
    service.set(EMAIL, "F22"),
  ]);
  assert.deepEqual(saved, [
    JSON.stringify({ F21: TEAMS }),
    JSON.stringify({ F21: TEAMS, F22: EMAIL }),
  ]);
});

test("a failed .env write puts the previous key back, registration included", async () => {
  const { service, manager } = makeService({ styleKeys: [["F21", TEAMS]], saveFails: true });

  const result = await service.set(TEAMS, "F22");
  assert.equal(result.success, false);
  assert.equal(result.reason, "save_failed");
  assert.deepEqual([...manager.getStyleKeys()], [["F21", TEAMS]]);
  assert.equal(registered.has("F21"), true);
  assert.equal(registered.has("F22"), false);
  assert.equal(manager.getStyleIdForHotkey("F21"), TEAMS);
});

test("syncing the eligible styles releases the others and persists the rest", async () => {
  const { service, saved, manager } = makeService({
    styleKeys: [
      ["F21", TEAMS],
      ["F22", EMAIL],
    ],
  });
  const result = await service.syncStyles([EMAIL, "not valid!"]);
  assert.equal(result.success, true);
  assert.deepEqual(saved, [JSON.stringify({ F22: EMAIL })]);
  assert.equal(manager.getStyleIdForHotkey("F21"), null);

  const unchanged = await service.syncStyles([EMAIL]);
  assert.equal(unchanged.success, true);
  assert.equal(saved.length, 1, "nothing to release writes nothing");
});

test("boot reports every committed key that isn't live, so none is silently dropped", async () => {
  refused.add("F22");
  const { service, notified } = makeService({
    styleKeys: [
      ["F21", TEAMS],
      ["F22", EMAIL],
    ],
  });

  const state = await service.finishBoot();
  assert.deepEqual(
    state.bindings.map((binding) => [binding.hotkey, binding.active]),
    [
      ["F21", true],
      ["F22", false],
    ]
  );
  assert.equal(notified.length, 1);
  assert.equal(notified[0].hotkey, "F22");
  assert.match(notified[0].error, /Style hotkey "F22" isn't working/);
});

test("an activation-mode change re-runs the builder and retries a key that failed", async () => {
  refused.add("F22");
  const { service, manager, broadcasts } = makeService({ styleKeys: [["F22", EMAIL]] });
  assert.equal(manager.getStyleIdForHotkey("F22"), null);

  refused.delete("F22");
  const before = broadcasts.length;
  const state = await service.revalidate();
  assert.equal(state.bindings[0].active, true);
  assert.equal(manager.getStyleIdForHotkey("F22"), EMAIL);
  assert.equal(broadcasts.length, before + 1, "the windows hear about the change");

  await service.revalidate();
  assert.equal(broadcasts.length, before + 1, "no change, no broadcast");
});
