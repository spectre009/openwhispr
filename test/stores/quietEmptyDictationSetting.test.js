const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// "End empty dictations quietly" (`quietEmptyDictationSeconds`) in the shared
// settings store: 3 s by default, one of Off, 2, 3, 5 or 10, written once,
// and followed by other windows through storage events, validated.

async function startWindow(t, { initialStorage = {}, storageListeners = [] } = {}) {
  const { storage } = installBrowserGlobals(t, {
    // As dictionarySettings.test.js starts a window: a stored dictionary
    // keeps initializeSettings from loading one after the test ends.
    initialStorage: { customDictionary: '["OpenWhispr"]', ...initialStorage },
    window: {
      addEventListener(type, listener) {
        if (type === "storage") storageListeners.push(listener);
      },
      electronAPI: {
        getOpenAIKey: async () => "",
        setDictionary: async () => {},
        setAutoLearnMode: () => {},
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-quiet-empty-test-",
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
  return { storage, useSettingsStore };
}

test("3 s by default", async (t) => {
  const fresh = await startWindow(t);
  assert.equal(fresh.useSettingsStore.getState().quietEmptyDictationSeconds, 3);
});

test("a stored Off is read back", async (t) => {
  const off = await startWindow(t, { initialStorage: { quietEmptyDictationSeconds: "0" } });
  assert.equal(off.useSettingsStore.getState().quietEmptyDictationSeconds, 0);
});

test("an unknown stored value reads as 3", async (t) => {
  const odd = await startWindow(t, { initialStorage: { quietEmptyDictationSeconds: "7" } });
  assert.equal(odd.useSettingsStore.getState().quietEmptyDictationSeconds, 3);
});

test("the setter writes the choice once and normalizes; other windows follow, validated", async (t) => {
  const storageListeners = [];
  const { storage, useSettingsStore } = await startWindow(t, { storageListeners });
  const { setQuietEmptyDictationSeconds } = useSettingsStore.getState();

  setQuietEmptyDictationSeconds(5);
  assert.equal(storage.getItem("quietEmptyDictationSeconds"), "5");
  assert.equal(useSettingsStore.getState().quietEmptyDictationSeconds, 5);
  setQuietEmptyDictationSeconds(0);
  assert.equal(useSettingsStore.getState().quietEmptyDictationSeconds, 0, "Off");
  setQuietEmptyDictationSeconds(42);
  assert.equal(useSettingsStore.getState().quietEmptyDictationSeconds, 3, "unknown: 3");

  const fromOtherWindow = (key, newValue) =>
    storageListeners.forEach((listener) => listener({ key, newValue, storageArea: storage }));
  fromOtherWindow("quietEmptyDictationSeconds", "10");
  assert.equal(useSettingsStore.getState().quietEmptyDictationSeconds, 10);
  fromOtherWindow("quietEmptyDictationSeconds", "soon");
  assert.equal(useSettingsStore.getState().quietEmptyDictationSeconds, 3);
});
