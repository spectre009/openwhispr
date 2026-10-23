const test = require("node:test");
const assert = require("node:assert/strict");

// A styled dictation's trace: the boundary records the style the recording
// carried (and never scans it for the wake word), honours a style's switch
// for the glossary's app-scoped corrections, and records the style step with
// its style and run mode. Main stores all of it as step history.

const loadBoundary = () => import("../../src/helpers/postTranscription.ts");
const { normalizeTrace } = require("../../src/helpers/stepHistory.js");

const RULE = {
  id: "rule-little-buddy",
  canonical: "Little Buddy",
  enabled: true,
  revision: 1,
  apps: ["Code.exe"],
  spellings: [{ text: "everybody", scope: "start" }],
};

test("a styled recording records its style and never looks for the wake word", async () => {
  const { runPostTranscription, traceStyle } = await loadBoundary();
  let scanned = 0;
  const { trace } = await runPostTranscription("Little Buddy, the build is green.", {
    context: { style: { id: "starter-teams", runMode: "two-step" } },
    detectWakeWord: () => {
      scanned += 1;
      return true;
    },
    run: async ({ workingText, recordStep, setRoute }) => {
      setRoute("style");
      return recordStep(
        "style",
        { detail: { styleId: "starter-teams", runMode: "two-step" } },
        async (dispatched) => {
          dispatched({
            provider: "copilot",
            model: "claude-haiku-5.5",
            prompt: { source: "resolved", text: "You restyle dictated text…" },
          });
          return `- ${workingText}`;
        }
      );
    },
  });
  assert.equal(scanned, 0);
  assert.equal(trace.context.intents.wakeWord, false);
  assert.deepEqual(trace.context.style, { id: "starter-teams", runMode: "two-step" });
  assert.deepEqual(traceStyle(trace), { id: "starter-teams", runMode: "two-step" });
  assert.equal(trace.route, "style");
  const style = trace.steps.find((s) => s.kind === "style");
  assert.deepEqual(
    {
      outcome: style.outcome,
      provider: style.provider,
      model: style.model,
      detail: style.detail,
      prompt: style.prompt,
    },
    {
      outcome: "ok",
      provider: "copilot",
      model: "claude-haiku-5.5",
      detail: { styleId: "starter-teams", runMode: "two-step" },
      prompt: { source: "resolved", text: "You restyle dictated text…" },
    }
  );
});

test("assistant and translation recordings carry no style, whatever they were given", async () => {
  const { runPostTranscription, traceStyle } = await loadBoundary();
  for (const context of [
    { voiceAgentRequested: true, style: { id: "starter-teams", runMode: "two-step" } },
    { translationRequested: true, style: { id: "starter-teams", runMode: "two-step" } },
  ]) {
    const { trace } = await runPostTranscription("hello", { context });
    assert.equal(traceStyle(trace), null);
    assert.equal(trace.context.style, undefined);
  }
});

test("a style can switch the app-scoped glossary corrections off", async () => {
  const { runPostTranscription } = await loadBoundary();
  const glossary = { revision: 3, rules: [RULE] };
  const on = await runPostTranscription("Hello everybody, quick one.", {
    context: { targetApp: "Code.exe", style: { id: "s", runMode: "two-step" } },
    glossary,
  });
  const off = await runPostTranscription("Hello everybody, quick one.", {
    context: {
      targetApp: "Code.exe",
      style: { id: "s", runMode: "two-step" },
      appScopedGlossary: false,
    },
    glossary,
  });
  assert.equal(on.trace.workingText, "Hello Little Buddy, quick one.");
  assert.equal(off.trace.workingText, "Hello everybody, quick one.");
  assert.equal(off.trace.context.targetApp, "Code.exe", "the app is still recorded");
});

test("main stores the style route, the recording's style and each style step's detail", async () => {
  const { runPostTranscription } = await loadBoundary();
  const { trace } = await runPostTranscription("we need json", {
    context: { style: { id: "starter-requirements", runMode: "one-step" } },
    run: async ({ workingText, recordStep, setRoute }) => {
      setRoute("style");
      return recordStep(
        "style",
        { detail: { styleId: "starter-requirements", runMode: "one-step" } },
        async () => `1. Must support ${workingText}.`
      );
    },
  });
  const stored = normalizeTrace(trace);
  assert.equal(stored.route, "style");
  assert.deepEqual(stored.context.style, { id: "starter-requirements", runMode: "one-step" });
  const style = stored.steps.find((s) => s.kind === "style");
  assert.deepEqual(style.detail, { styleId: "starter-requirements", runMode: "one-step" });

  // Version 1 traces without a style are stored exactly as before.
  const plain = normalizeTrace((await runPostTranscription("hi")).trace);
  assert.equal("style" in plain.context, false);
  // An unknown run mode is kept as unknown, never guessed.
  const odd = normalizeTrace({
    ...trace,
    steps: [{ kind: "style", outcome: "ok", detail: { styleId: "x", runMode: "three-step" } }],
  });
  assert.deepEqual(odd.steps[0].detail, { styleId: "x", runMode: null });
});
