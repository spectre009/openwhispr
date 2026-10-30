const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const {
  migrateAutoLearnMode,
  normalizeAutoLearnMode,
} = require("../../src/utils/autoLearnMode.ts");

// The two Dictionary settings in the shared settings store: "Learn from your
// corrections" (migrated once from the on/off switch, synced to main at
// startup and on change) and "Dictionary words in the cleanup prompt". Both
// follow other windows through storage events, validated.

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("the one-time migration: on becomes Suggest, off stays Off, only while the new key is absent", () => {
  for (const [legacy, expected] of [
    ["true", "suggest"],
    ["false", "off"],
    [null, "suggest"],
  ]) {
    const storage = memoryStorage(legacy === null ? {} : { autoLearnCorrections: legacy });
    migrateAutoLearnMode(storage);
    assert.equal(storage.getItem("autoLearnMode"), expected, String(legacy));
    assert.equal(storage.getItem("autoLearnCorrections"), legacy, "the old key stays");
  }
  const chosen = memoryStorage({ autoLearnMode: "add", autoLearnCorrections: "false" });
  migrateAutoLearnMode(chosen);
  assert.equal(chosen.getItem("autoLearnMode"), "add", "never runs twice");
  assert.equal(normalizeAutoLearnMode("bogus"), "suggest");
});

async function startWindow(t, { initialStorage = {}, storageListeners = [], synced = [] } = {}) {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { customDictionary: '["OpenWhispr"]', ...initialStorage },
    window: {
      addEventListener(type, listener) {
        if (type === "storage") storageListeners.push(listener);
      },
      electronAPI: {
        getOpenAIKey: async () => "",
        setDictionary: async () => {},
        setAutoLearnMode: (mode) => synced.push(mode),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-dictionary-test-",
  });
  const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  try {
    await initializeSettings();
  } finally {
    const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
    await i18n.changeLanguage("en");
  }
  return { storage, useSettingsStore, storageListeners, synced };
}

test("a saved 'on' switch opens as Suggest, and main hears the mode at startup", async (t) => {
  const { storage, useSettingsStore, synced } = await startWindow(t, {
    initialStorage: { autoLearnCorrections: "true" },
  });
  assert.equal(useSettingsStore.getState().autoLearnMode, "suggest");
  assert.equal(storage.getItem("autoLearnMode"), "suggest");
  assert.deepEqual(synced, ["suggest"], "main watches nothing until this sync");
  assert.equal(useSettingsStore.getState().cleanupDictionaryWords, "all", "today's behaviour");
});

test("a change syncs main once; another window follows the storage event, validated", async (t) => {
  const storageListeners = [];
  const { storage, useSettingsStore, synced } = await startWindow(t, {
    initialStorage: { autoLearnCorrections: "false" },
    storageListeners,
  });
  assert.equal(useSettingsStore.getState().autoLearnMode, "off");
  synced.length = 0;
  useSettingsStore.getState().setAutoLearnMode("add");
  useSettingsStore.getState().setAutoLearnMode("add");
  assert.deepEqual(synced, ["add"]);
  assert.equal(storage.getItem("autoLearnMode"), "add");

  // The other window: the storage event arrives with what this one wrote.
  const fromOtherWindow = (key, newValue) =>
    storageListeners.forEach((listener) => listener({ key, newValue, storageArea: storage }));
  fromOtherWindow("autoLearnMode", "off");
  assert.equal(useSettingsStore.getState().autoLearnMode, "off");
  fromOtherWindow("autoLearnMode", "true");
  assert.equal(useSettingsStore.getState().autoLearnMode, "suggest", "unknown reads as Suggest");
  assert.deepEqual(synced, ["add"], "a storage event never re-syncs main");

  useSettingsStore.getState().setCleanupDictionaryWords("typedPinned");
  assert.equal(storage.getItem("cleanupDictionaryWords"), "typedPinned");
  fromOtherWindow("cleanupDictionaryWords", "typedPinnedMissed");
  assert.equal(useSettingsStore.getState().cleanupDictionaryWords, "typedPinnedMissed");
  fromOtherWindow("cleanupDictionaryWords", "most");
  assert.equal(useSettingsStore.getState().cleanupDictionaryWords, "all");
});
