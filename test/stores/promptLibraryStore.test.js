const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The prompt library as the settings store exposes it: migration at startup,
// the cache every reader uses, writes that re-read the stored record, the
// cross-window refresh, and the retired-default sweep routed through the record.

const fixtures = require("../helpers/retiredPromptFixtures.json");

async function setup(t, initialStorage = {}) {
  const listeners = [];
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", ...initialStorage },
    window: {
      // No preload: initializeSettings skips every IPC sync.
      electronAPI: undefined,
      addEventListener(type, listener) {
        if (type === "storage") listeners.push(listener);
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-prompt-library-store-" });
  // Each load evaluates the store afresh, like a newly opened window sharing
  // the same localStorage.
  const openWindow = async () => {
    vite.moduleGraph.invalidateAll();
    const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
    usePolicyStore.setState({ status: "unmanaged", policy: null });
    return settings;
  };
  return { storage, listeners, openWindow };
}

const record = (storage, kind = "cleanup") => JSON.parse(storage.getItem(`promptLibrary.${kind}`));

const names = (library) => library.entries.map((entry) => entry.name);

const until = async (predicate, label) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test("startup migrates each kind's override into its library", async (t) => {
  const { storage, openWindow } = await setup(t, {
    "customPrompt.cleanup": "Keep my words.",
    "customPrompt.translate": "",
  });

  const { useSettingsStore } = await openWindow();
  const state = useSettingsStore.getState();

  assert.equal(state.promptLibraries.cleanup.activeId, "migrated");
  assert.deepEqual(names(state.promptLibraries.cleanup), ["My prompt"]);
  assert.equal(state.promptLibraries.cleanup.entries[0].origin, "migrated");
  assert.equal(state.customPrompts.cleanup, "Keep my words.", "readers see the same prompt");
  for (const kind of ["dictationAgent", "translate", "chatAgent"]) {
    assert.equal(state.promptLibraries[kind].activeId, "default", kind);
    assert.deepEqual(state.promptLibraries[kind].entries, [], kind);
    assert.equal(state.customPrompts[kind], "", kind);
  }
  assert.deepEqual(record(storage), state.promptLibraries.cleanup);

  // A second start changes nothing.
  const before = storage.getItem("promptLibrary.cleanup");
  await openWindow();
  assert.equal(storage.getItem("promptLibrary.cleanup"), before);
});

test("legacy prompt keys still reach the library through the old migration", async (t) => {
  const { storage, openWindow } = await setup(t, {
    customUnifiedPrompt: JSON.stringify("One prompt for both."),
    agentSystemPrompt: "Chat like a pirate.",
  });

  const { useSettingsStore } = await openWindow();
  const { promptLibraries, customPrompts } = useSettingsStore.getState();

  for (const kind of ["cleanup", "dictationAgent"]) {
    assert.equal(promptLibraries[kind].entries[0].text, "One prompt for both.", kind);
    assert.equal(customPrompts[kind], "One prompt for both.", kind);
  }
  assert.equal(promptLibraries.chatAgent.entries[0].text, "Chat like a pirate.");
  assert.equal(storage.getItem("agentSystemPrompt"), null);
  assert.equal(storage.getItem("_promptsMigrated"), "1");
});

test("store actions keep the cache equal to the prompt in use", async (t) => {
  const { storage, openWindow } = await setup(t, { "customPrompt.cleanup": "Original." });
  const { useSettingsStore } = await openWindow();
  const store = () => useSettingsStore.getState();
  const assertCache = () => {
    const library = store().promptLibraries.cleanup;
    const active = library.entries.find((entry) => entry.id === library.activeId);
    const expected = active ? active.text : "";
    assert.equal(store().customPrompts.cleanup, expected, "store cache");
    assert.equal(storage.getItem("customPrompt.cleanup"), expected, "stored cache");
    assert.deepEqual(record(storage), library, "stored record");
  };

  const id = store().createPrompt("cleanup", { name: "Copy", text: "Original." });
  assert.ok(id);
  assertCache();
  assert.equal(store().savePrompt("cleanup", id, "Edited copy."), true);
  assertCache();
  assert.equal(store().renamePrompt("cleanup", id, "Without glossary"), true);
  assertCache();
  assert.equal(store().activatePrompt("cleanup", id), true);
  assert.equal(store().customPrompts.cleanup, "Edited copy.");
  assertCache();
  assert.equal(store().activatePrompt("cleanup", "default"), true);
  assert.equal(store().customPrompts.cleanup, "");
  assert.deepEqual(names(store().promptLibraries.cleanup), ["My prompt", "Without glossary"]);
  assertCache();
  assert.equal(store().activatePrompt("cleanup", id), true);
  assert.equal(store().deletePrompt("cleanup", id), true);
  assert.equal(store().promptLibraries.cleanup.activeId, "default");
  assertCache();
  assert.equal(
    store().savePrompt("cleanup", id, "Gone."),
    false,
    "a deleted prompt can't be saved"
  );
});

test("two windows writing in turn lose nothing, and a record event refreshes the other", async (t) => {
  const { storage, listeners, openWindow } = await setup(t, { "customPrompt.cleanup": "Mine." });
  const windowA = await openWindow();
  await windowA.initializeSettings();
  assert.equal(listeners.length, 1, "window A listens for storage events");
  const windowB = await openWindow();

  // B saves; A doesn't hear about it yet, so its copy of the library is stale.
  windowB.useSettingsStore.getState().createPrompt("cleanup", { name: "From B", text: "B." });
  assert.deepEqual(names(windowA.useSettingsStore.getState().promptLibraries.cleanup), [
    "My prompt",
  ]);

  // A's save is one read-modify-write of the stored record: B's entry survives.
  windowA.useSettingsStore.getState().createPrompt("cleanup", { name: "From A", text: "A." });
  assert.deepEqual(names(record(storage)), ["My prompt", "From B", "From A"]);
  assert.deepEqual(names(windowA.useSettingsStore.getState().promptLibraries.cleanup), [
    "My prompt",
    "From B",
    "From A",
  ]);

  // B switches prompts; the record's storage event updates A's library and cache.
  const fromA = record(storage).entries.find((entry) => entry.name === "From A");
  windowB.useSettingsStore.getState().activatePrompt("cleanup", fromA.id);
  for (const listener of listeners) {
    listener({
      key: "promptLibrary.cleanup",
      newValue: storage.getItem("promptLibrary.cleanup"),
      storageArea: globalThis.localStorage,
    });
  }
  const stateA = windowA.useSettingsStore.getState();
  assert.equal(stateA.promptLibraries.cleanup.activeId, fromA.id);
  assert.equal(stateA.customPrompts.cleanup, "A.");

  // Removals are ignored by the listener, which is why the library never removes keys.
  for (const listener of listeners) {
    listener({
      key: "promptLibrary.cleanup",
      newValue: null,
      storageArea: globalThis.localStorage,
    });
  }
  assert.equal(windowA.useSettingsStore.getState().promptLibraries.cleanup.activeId, fromA.id);
});

test("the startup sweep removes a migrated retired default through the record", async (t) => {
  const { storage, openWindow } = await setup(t, {
    "customPrompt.cleanup": fixtures.enPreHardeningCleanupPrompt,
  });

  const { useSettingsStore } = await openWindow();
  await until(
    () => useSettingsStore.getState().promptLibraries.cleanup.entries.length === 0,
    "the sweep"
  );

  const state = useSettingsStore.getState();
  assert.equal(state.promptLibraries.cleanup.activeId, "default");
  assert.equal(state.customPrompts.cleanup, "");
  assert.equal(storage.getItem("customPrompt.cleanup"), "", "written as empty, not removed");
  assert.equal(
    storage.getItem("customPrompt.cleanup.retired"),
    fixtures.enPreHardeningCleanupPrompt
  );
});

test("the startup sweep never deletes a retired default the user saved", async (t) => {
  const library = {
    version: 1,
    activeId: "u1",
    entries: [
      {
        id: "u1",
        name: "Old default I like",
        text: fixtures.enPreHardeningCleanupPrompt,
        updatedAt: 1,
        origin: "user",
      },
    ],
  };
  const { storage, openWindow } = await setup(t, {
    "promptLibrary.cleanup": JSON.stringify(library),
    "customPrompt.cleanup": fixtures.enPreHardeningCleanupPrompt,
  });

  const { useSettingsStore } = await openWindow();
  // Let the asynchronous sweep run to completion.
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(useSettingsStore.getState().promptLibraries.cleanup, library);
  assert.equal(storage.getItem("customPrompt.cleanup"), fixtures.enPreHardeningCleanupPrompt);
  assert.equal(storage.getItem("customPrompt.cleanup.retired"), null);
});
