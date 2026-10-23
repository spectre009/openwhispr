const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A style's one-step mode rides on the cleanup request (ReasoningConfig.
// cleanupStyle): the style block follows the cleanup prompt, the transcript's
// closing line names the style, and the option itself never crosses IPC.
// OpenWhispr Cloud builds its prompt on the server, so it gets the template
// (the built-in one when none is saved) with the block appended.

async function load(t, electronAPI) {
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", uiLanguage: "en", isSignedIn: "true" },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cleanup-style-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const prompts = await vite.ssrLoadModule("/config/prompts.ts");
  return { service, prompts };
}

const STYLE = { name: "Requirements", block: "STYLE: Requirements\nNumber the needs." };

test("a local cleanup with a style: the block follows the prompt, the style is named last", async (t) => {
  const calls = [];
  const { service } = await load(t, {
    processLocalReasoning: async (text, model, agentName, config) => {
      calls.push({ text, config });
      return { success: true, text: "1. Must support JSON." };
    },
  });
  const dispatched = [];
  const reply = await service.processText("um we need json", "local-model", null, {
    provider: "local",
    inferenceScope: "dictationCleanup",
    cleanupStyle: STYLE,
    onDispatch: (info) => dispatched.push(info),
  });

  assert.equal(reply, "1. Must support JSON.");
  const [{ text, config }] = calls;
  assert.equal(
    text,
    '<transcript>\num we need json\n</transcript>\n\nOutput only the finished text, written in the "Requirements" style.'
  );
  assert.ok(config.systemPrompt.endsWith(`\n\n${STYLE.block}`));
  assert.equal(config.cleanupStyle, undefined, "never forwarded to a provider");
  assert.equal(dispatched[0].prompt.text, config.systemPrompt, "step history gets what was sent");

  // Without a style the request is exactly today's cleanup request.
  await service.processText("um we need json", "local-model", null, {
    provider: "local",
    inferenceScope: "dictationCleanup",
  });
  assert.ok(calls[1].text.endsWith("Output only the cleaned transcript."));
  assert.ok(!calls[1].config.systemPrompt.includes(STYLE.block));
});

test("a request with its own system prompt ignores a style", async (t) => {
  const calls = [];
  const { service } = await load(t, {
    processLocalReasoning: async (text, model, agentName, config) => {
      calls.push({ text, config });
      return { success: true, text: "ok" };
    },
  });
  await service.processText("hello", "local-model", null, {
    provider: "local",
    inferenceScope: "dictationCleanup",
    systemPrompt: "Restyle it.",
    cleanupStyle: STYLE,
  });
  assert.equal(calls[0].text, "hello");
  assert.equal(calls[0].config.systemPrompt, "Restyle it.");
});

test("OpenWhispr Cloud gets the built-in prompt with the style block as its template", async (t) => {
  const sent = [];
  const { service, prompts } = await load(t, {
    cloudReason: async (text, opts) => {
      sent.push({ text, opts });
      return { success: true, text: "1. Must support JSON.", model: "cloud-model" };
    },
  });
  await service.processText("um we need json", "", null, {
    provider: "openwhispr",
    inferenceScope: "dictationCleanup",
    cleanupStyle: STYLE,
  });
  const [{ text, opts }] = sent;
  assert.equal(text, "um we need json", "Cloud wraps the transcript itself");
  assert.equal(opts.promptMode, "cleanup", "still Cloud's cleanup route");
  assert.equal(opts.systemPrompt, undefined);
  assert.equal(
    opts.customPrompt,
    `${prompts.getDefaultPromptText("cleanup", "en")}\n\n${STYLE.block}`
  );
});
