const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Tidy up's Undo, kept items and model review, and "Sort into categories"'
// proposals, were made on one account's personal list; main writes an Undo
// into the active account's. When the lists start belonging to another
// account (main's account-scope broadcast), both start over, and a Tidy up
// apply in flight then keeps no Undo for the next account.

async function loadStores(t) {
  let scopeChanged = null;
  let applyRelease = null;
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", uiLanguage: "en" },
    window: {
      electronAPI: {
        getDatabaseAccountScope: async () => ({ accountId: "a", visibleAccountId: "a" }),
        onDatabaseAccountScopeChanged: (listener) => {
          scopeChanged = listener;
          return () => {};
        },
        applyDictionaryTidy: () =>
          new Promise((resolve) => {
            applyRelease = () =>
              resolve({
                success: true,
                results: [{ ok: true, removed: 1, undo: [{ restore: [] }] }],
              });
          }),
        getDictionary: async () => [],
        setDictionary: async () => ({ success: true }),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictionary-lists-owner-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      // A write's cloud push: nothing to push to here.
      "/services/SyncService.js": "export const syncService = { canSync: () => false };",
    },
  });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const tidy = await vite.ssrLoadModule("/stores/dictionaryTidyStore.ts");
  const categoryReview = await vite.ssrLoadModule("/stores/dictionaryCategoryReviewStore.ts");
  await settings.initializeSettings();
  // The scope read on startup, and the modules startup loads on its own,
  // settle before the first broadcast (and before the server closes).
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    settings,
    tidy,
    categoryReview,
    switchAccount: (id) => scopeChanged({ accountId: id, visibleAccountId: id }),
    releaseApply: () => applyRelease(),
  };
}

test("another account's lists start Tidy up and the category review over", async (t) => {
  const { settings, tidy, categoryReview, switchAccount, releaseApply } = await loadStores(t);
  const { useDictionaryTidyStore } = tidy;
  const { useDictionaryCategoryReviewStore } = categoryReview;
  useDictionaryTidyStore.setState({
    undo: [{ id: 1, steps: [{ restore: [] }], summary: null, merged: false }],
    kept: new Set(["item"]),
    keptSinceSummary: 1,
    summary: { removed: 1, merged: 0, changed: 0, added: 0, kept: 0, failed: 0, skipped: 0 },
    review: { status: "error", modelName: "GPT Test", error: new Error("x") },
  });
  useDictionaryCategoryReviewStore.setState({
    review: { status: "done", optionId: "o", modelName: "m", proposals: [], kept: 0, dropped: 0 },
    dismissed: new Set(["p1"]),
    accepted: new Set(["p2"]),
  });

  const before = settings.getListsOwnerRevision();
  switchAccount("b");
  assert.equal(settings.getListsOwnerRevision(), before + 1);
  const state = useDictionaryTidyStore.getState();
  assert.deepEqual(state.undo, []);
  assert.equal(state.summary, null);
  assert.equal(state.kept.size, 0);
  assert.equal(state.keptSinceSummary, 0);
  assert.deepEqual(state.review, { status: "idle" });
  const categories = useDictionaryCategoryReviewStore.getState();
  assert.deepEqual(categories.review, { status: "idle" });
  assert.equal(categories.dismissed.size, 0);
  assert.equal(categories.accepted.size, 0);

  // An apply that started under one account keeps no Undo for the next one.
  const applying = tidy.applyTidy([{ kind: "remove", words: ["gonestly"] }]);
  switchAccount("c");
  releaseApply();
  assert.equal(await applying, null);
  assert.deepEqual(useDictionaryTidyStore.getState().undo, []);
  assert.equal(useDictionaryTidyStore.getState().busy, false);
  // What the write starts on its own (the cloud push) settles before the server closes.
  await new Promise((resolve) => setTimeout(resolve, 500));
});
