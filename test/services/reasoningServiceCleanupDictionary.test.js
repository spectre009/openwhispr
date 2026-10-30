const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Cleanup's dictionary word set rides on the cleanup request
// (ReasoningConfig.cleanupDictionary): it replaces the full list in that
// request's prompt and in what OpenWhispr Cloud is given, never in a request
// with its own system prompt (translation, the assistant, a restyle), and the
// option itself never crosses IPC. Synthetic words only.

async function load(t, electronAPI) {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      uiLanguage: "en",
      isSignedIn: "true",
      customDictionary: JSON.stringify(["OpenWhispr", "gonestly", "Scout Web"]),
    },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cleanup-dictionary-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  return { service };
}

const SELECTION = {
  words: ["OpenWhispr", "Scout Web"],
  scope: { setting: "typedPinned", applied: "typedPinned", words: 2 },
};

test("a local cleanup's prompt carries the selected words, and only them", async (t) => {
  const calls = [];
  const { service } = await load(t, {
    processLocalReasoning: async (text, model, agentName, config) => {
      calls.push({ text, config });
      return { success: true, text: "Cleaned." };
    },
  });
  const dispatched = [];
  await service.processText("um hello", "local-model", null, {
    provider: "local",
    inferenceScope: "dictationCleanup",
    cleanupDictionary: SELECTION,
    onDispatch: (info) => dispatched.push(info),
  });
  const [{ config }] = calls;
  assert.ok(config.systemPrompt.endsWith("OpenWhispr, Scout Web"), config.systemPrompt.slice(-80));
  assert.ok(!config.systemPrompt.includes("gonestly"));
  assert.equal(config.cleanupDictionary, undefined, "never forwarded to a provider");
  assert.equal(dispatched[0].prompt.text, config.systemPrompt, "step history gets what was sent");

  // Without a selection the request is today's: the whole dictionary.
  await service.processText("um hello", "local-model", null, {
    provider: "local",
    inferenceScope: "dictationCleanup",
  });
  assert.ok(calls[1].config.systemPrompt.includes("gonestly"));
});

test("OpenWhispr Cloud's cleanup gets the selected words; a system-prompt request the full list", async (t) => {
  const sent = [];
  const { service } = await load(t, {
    cloudReason: async (text, opts) => {
      sent.push(opts);
      return { success: true, text: "Done.", model: "cloud-model" };
    },
  });
  await service.processText("um hello", "", null, {
    provider: "openwhispr",
    inferenceScope: "dictationCleanup",
    cleanupDictionary: SELECTION,
  });
  assert.deepEqual(sent[0].customDictionary, ["OpenWhispr", "Scout Web"]);
  assert.equal(sent[0].promptMode, "cleanup");

  // A restyle (or translation) spreads the cleanup config but has its own prompt.
  await service.processText("hello", "", null, {
    provider: "openwhispr",
    inferenceScope: "dictationCleanup",
    systemPrompt: "Restyle it.",
    cleanupDictionary: SELECTION,
  });
  assert.deepEqual(sent[1].customDictionary, ["OpenWhispr", "gonestly", "Scout Web"]);
  assert.equal(sent[1].cleanupDictionary, undefined);

  // None: an empty list, the glossary and triggers aside.
  await service.processText("um hello", "", null, {
    provider: "openwhispr",
    inferenceScope: "dictationCleanup",
    cleanupDictionary: { words: [], scope: { setting: "none", applied: "none", words: 0 } },
  });
  assert.deepEqual(sent[2].customDictionary, []);
});
