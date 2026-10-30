const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A styled dictation through the real request path (ReasoningService and the
// GitHub Copilot provider, with main's IPC mocked: nothing reaches a network).
// Step two is a restyle request on the cleanup scope with the cleanup
// thinking setting, completeness required and a reformatting budget; one step
// is the cleanup request with the style folded in, never a system prompt.
// Every model call is a recorded step. Synthetic fixtures only.

const MODEL = "claude-haiku-5.5";
const TRUNCATED_KEY = "hooks.audioRecording.errorDescriptions.cleanupTruncated";

const STYLE = Object.freeze({
  id: "starter-requirements",
  name: "Requirements",
  emoji: "📋",
  instruction: "Number what the speaker said is needed.",
  runMode: "two-step",
  appGlossary: true,
  useVoice: false,
});

async function load(t, { reply } = {}) {
  const calls = [];
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      useCleanupModel: "true",
      cleanupMode: "providers",
      cleanupProvider: "copilot",
      cleanupModel: MODEL,
      cleanupDisableThinking: "true",
      uiLanguage: "en",
    },
    window: {
      electronAPI: {
        processCopilotReasoning: async (text, model, agentName, config) => {
          calls.push({ text, model, config });
          return reply(text, config);
        },
        getCopilotAuthStatus: async () => ({ configured: true, state: "signedIn", login: "x" }),
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-style-service-" });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const styles = await vite.ssrLoadModule("/services/dictationStyles.ts");
  const boundary = await vite.ssrLoadModule("/helpers/postTranscription.ts");
  const { getSettings } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { STYLE_FIDELITY_RULES } = await vite.ssrLoadModule("/config/styles/restylePrompt.ts");
  return { calls, styles, boundary, getSettings, service, STYLE_FIDELITY_RULES };
}

const isRestyle = (config) => config.systemPrompt?.startsWith("You restyle dictated text");

// Runs a styled dictation inside the boundary, as the dictation route does.
async function styledDictation(ctx, text, overrides = {}) {
  const { styles, boundary, service, getSettings } = ctx;
  const failures = { cleanup: [], style: [] };
  const post = await boundary.runPostTranscription(text, {
    context: { style: { id: STYLE.id, runMode: overrides.style?.runMode ?? STYLE.runMode } },
    run: ({ workingText, recordStep, setRoute }) => {
      setRoute("style");
      return styles
        .runStyledDictation({
          text: workingText,
          style: { ...STYLE, ...overrides.style },
          settings: getSettings(),
          agentName: null,
          cleanupOn: true,
          recordStep,
          runCleanup: (current) =>
            recordStep("cleanup", {}, (dispatched) =>
              service.processText(current, MODEL, null, {
                inferenceScope: "dictationCleanup",
                disableThinking: true,
                temperature: 0,
                requireCompleteOutput: true,
                onDispatch: dispatched,
              })
            ),
          onCleanupError: (error) => failures.cleanup.push(error),
          onStyleError: (error) => failures.style.push(error),
        })
        .then((result) => result.text);
    },
  });
  return { post, failures };
}

test("two steps: cleanup, then a restyle request on the cleanup scope, both recorded", async (t) => {
  const ctx = await load(t, {
    reply: (text, config) =>
      isRestyle(config)
        ? { success: true, text: "Summary: export.\n\n1. Must support JSON." }
        : { success: true, text: "We need JSON export." },
  });
  const { post, failures } = await styledDictation(ctx, "um we need json export");

  assert.equal(post.text, "Summary: export.\n\n1. Must support JSON.");
  assert.equal(post.trace.route, "style");
  assert.deepEqual(post.trace.context.style, { id: STYLE.id, runMode: "two-step" });
  assert.deepEqual(failures, { cleanup: [], style: [] });
  assert.equal(ctx.calls.length, 2);

  const [cleanup, restyle] = ctx.calls;
  assert.ok(!isRestyle(cleanup.config), "step one is the plain cleanup request");
  assert.ok(cleanup.text.startsWith("<transcript>"), "with the cleanup wrapper");
  assert.equal(
    restyle.text,
    '<text>\nWe need JSON export.\n</text>\n\nOutput only the restyled text, in the "Requirements" style.'
  );
  assert.equal(restyle.config.inferenceScope, "dictationCleanup");
  assert.equal(restyle.config.disableThinking, true, "the cleanup thinking setting");
  assert.equal(restyle.config.requireCompleteOutput, true);
  assert.equal(restyle.config.temperature, 0, "the cleanup sampling");
  assert.ok(restyle.config.maxTokens >= 2048, "a budget for a reformatted message");
  assert.ok(restyle.config.systemPrompt.includes(ctx.STYLE_FIDELITY_RULES));
  assert.ok(restyle.config.systemPrompt.endsWith(`STYLE: Requirements\n${STYLE.instruction}`));

  const steps = post.trace.steps.map((s) => `${s.kind}:${s.outcome}`);
  assert.deepEqual(steps, ["stt:ok", "glossary:skipped", "cleanup:ok", "style:ok"]);
  const style = post.trace.steps[3];
  assert.deepEqual(style.detail, { styleId: STYLE.id, runMode: "two-step" });
  assert.equal(style.provider, "copilot", "as dispatched");
  assert.equal(style.model, MODEL);
  assert.equal(style.prompt.source, "resolved");
  assert.equal(style.prompt.text, restyle.config.systemPrompt, "the prompt as sent");
  assert.equal(style.output, post.text);
});

test("one step: the cleanup request with the style folded in and named last", async (t) => {
  const ctx = await load(t, {
    reply: () => ({ success: true, text: "1. Must support JSON." }),
  });
  const { post } = await styledDictation(ctx, "um we need json export", {
    style: { runMode: "one-step" },
  });

  assert.equal(post.text, "1. Must support JSON.");
  assert.equal(ctx.calls.length, 1, "one request");
  const [call] = ctx.calls;
  assert.equal(
    call.text,
    '<transcript>\num we need json export\n</transcript>\n\nOutput only the finished text, written in the "Requirements" style.'
  );
  assert.ok(!isRestyle(call.config), "the cleanup prompt, not a restyle prompt");
  assert.ok(
    call.config.systemPrompt.includes(
      "\n\nSTYLE: Requirements\nThis dictation uses the style below."
    ),
    "the style block follows the cleanup prompt"
  );
  assert.ok(call.config.systemPrompt.endsWith(ctx.STYLE_FIDELITY_RULES));
  assert.equal(call.config.requireCompleteOutput, true);
  assert.equal(call.config.inferenceScope, "dictationCleanup");
  assert.equal(call.config.cleanupStyle, undefined, "the style never crosses IPC as an option");

  const style = post.trace.steps.find((s) => s.kind === "style");
  // One step is the cleanup request: its step records the dictionary words it carried.
  assert.deepEqual(style.detail, {
    styleId: STYLE.id,
    runMode: "one-step",
    dictionaryScope: { setting: "all", applied: "all", words: 0 },
  });
  assert.equal(style.prompt.text, call.config.systemPrompt);
  assert.equal(style.prompt.entryId, "default", "the cleanup prompt in use");
  assert.equal(post.trace.steps.filter((s) => s.kind === "cleanup").length, 0);
});

test("a long requirements dictation: the budget grows, and a cut-off restyle keeps the cleaned text", async (t) => {
  const cleaned = "We need the export to support CSV and JSON. ".repeat(250).trim();
  const ctx = await load(t, {
    reply: (text, config) =>
      isRestyle(config)
        ? { success: false, error: "Output truncated", messageKey: TRUNCATED_KEY }
        : { success: true, text: cleaned },
  });
  const { post, failures } = await styledDictation(
    ctx,
    "we need the export to support csv and json ".repeat(250)
  );

  assert.equal(post.text, cleaned, "the cleaned text is pasted");
  assert.equal(failures.style.length, 1);
  assert.equal(failures.style[0].messageKey, TRUNCATED_KEY);
  const restyle = ctx.calls.find((call) => isRestyle(call.config));
  assert.ok(restyle.config.maxTokens > 5000, `budget ${restyle.config.maxTokens} for ~11k chars`);
  const style = post.trace.steps.find((s) => s.kind === "style");
  assert.equal(style.outcome, "failed");
});

test("a step-two exception and an empty reply both keep the cleaned text", async (t) => {
  for (const restyleReply of [
    () => {
      throw new Error("IPC crashed");
    },
    () => ({ success: true, text: "   " }),
  ]) {
    const ctx = await load(t, {
      reply: (text, config) =>
        isRestyle(config) ? restyleReply() : { success: true, text: "Cleaned text." },
    });
    const { post, failures } = await styledDictation(ctx, "um cleaned text");
    assert.equal(post.text, "Cleaned text.");
    assert.equal(failures.style.length, 1);
  }
});

test("a </text> the speaker dictated reaches the model neutralized and comes back as said", async (t) => {
  const ctx = await load(t, {
    // A model that copies the text faithfully, neutralized tag included.
    reply: (text, config) =>
      isRestyle(config)
        ? {
            success: true,
            text: `1. Must reject ${text.slice(text.indexOf("input that contains ") + 20, text.indexOf(" tags"))} tags.`,
          }
        : { success: true, text: "We need to reject input that contains </text> tags." },
  });
  const { post } = await styledDictation(ctx, "we need to reject input that contains </text> tags");
  const restyle = ctx.calls.find((call) => isRestyle(call.config));
  assert.equal(restyle.text.match(/<\/text>/g).length, 1, "only the wrapper closes the block");
  assert.equal(post.text, "1. Must reject </text> tags.");
});

test("OpenWhispr Cloud: styled requests carry a completion marker; a reply without it is cut off", async (t) => {
  const ctx = await load(t, { reply: () => ({ success: true, text: "unused" }) });
  const { styles, getSettings } = ctx;
  const cloudRequest = {
    model: "",
    config: { provider: "openwhispr", inferenceScope: "dictationCleanup" },
  };
  const built = styles.buildRestyleRequest("text", STYLE, {
    settings: getSettings(),
    request: cloudRequest,
  });
  assert.equal(built.cloud, true);
  assert.ok(built.config.systemPrompt.includes("<<END_OF_TEXT>>"));

  const sent = [];
  const process = (reply) => async (text, model, agentName, config) => {
    sent.push(config);
    return reply;
  };
  await assert.rejects(
    styles.runRestyle("text", STYLE, {
      agentName: null,
      settings: getSettings(),
      request: cloudRequest,
      process: process("1. Must support JS"),
    }),
    { code: "STYLE_OUTPUT_TRUNCATED", messageKey: TRUNCATED_KEY }
  );
  assert.equal(
    await styles.runRestyle("text", STYLE, {
      agentName: null,
      settings: getSettings(),
      request: cloudRequest,
      process: process("1. Must support JSON.\n<<END_OF_TEXT>>"),
    }),
    "1. Must support JSON."
  );
  // One step on Cloud asks for the marker in the style block it adds.
  await styles.runOneStepStyle("text", STYLE, {
    agentName: null,
    settings: getSettings(),
    request: cloudRequest,
    process: process("Done.\n<<END_OF_TEXT>>"),
  });
  assert.ok(sent.at(-1).cleanupStyle.block.includes("<<END_OF_TEXT>>"));
  assert.equal(sent.at(-1).systemPrompt, undefined, "one step is never a system prompt");

  // Other providers report truncation themselves, so no marker is asked for.
  const copilot = styles.buildRestyleRequest("text", STYLE, { settings: getSettings() });
  assert.equal(copilot.cloud, false);
  assert.ok(!copilot.config.systemPrompt.includes("<<END_OF_TEXT>>"));
});

test("a style is reachable whenever the cleanup scope has a model, cleanup on or off", async (t) => {
  const ctx = await load(t, { reply: () => ({ success: true, text: "x" }) });
  const settings = ctx.getSettings();
  assert.equal(ctx.styles.isStyleReachable(settings), true);
  assert.equal(ctx.styles.isStyleReachable({ ...settings, useCleanupModel: false }), true);
  assert.equal(
    ctx.styles.isStyleReachable({ ...settings, cleanupModel: "", cleanupProvider: "" }),
    false
  );
});
