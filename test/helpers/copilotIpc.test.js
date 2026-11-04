const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCopilotReasoningHandler,
  registerCopilotIpc,
  deadlineFrom,
} = require("../../src/helpers/copilot/copilotIpc");
const { copilotProviderError } = require("../../src/helpers/copilot/copilotErrors");
const { captureLogger, flush } = require("./harness/copilotSdk");

function handlerWith(complete) {
  const calls = [];
  let rejected = 0;
  const handler = createCopilotReasoningHandler({
    runtime: {
      complete: async (args) => {
        calls.push(args);
        return complete(args);
      },
    },
    auth: { reportTokenRejected: () => (rejected += 1) },
  });
  return { handler, calls, rejectedCount: () => rejected };
}

const ok = async () => ({ text: "Clean text.", finishReason: "stop", reasoningEffort: "low" });

test("cleanup, note formatting and translation reach Copilot with the caller's settings", async () => {
  for (const scope of ["dictationCleanup", "noteFormatting", "dictationTranslation", undefined]) {
    const { handler, calls } = handlerWith(ok);
    const result = await handler({}, "um text", "claude-haiku-5.5", null, {
      inferenceScope: scope,
      systemPrompt: "Clean it.",
      disableThinking: true,
      maxTokens: 4096,
      requireCompleteOutput: true,
      timeoutMs: 30000,
    });
    assert.deepEqual(result, { success: true, text: "Clean text." });
    assert.deepEqual(calls[0], {
      model: "claude-haiku-5.5",
      system: "Clean it.",
      user: "um text",
      disableThinking: true,
      maxTokens: 4096,
      requireCompleteOutput: true,
      deadlineMs: 30000,
    });
  }
});

test("chat scopes, agent requests and screenshots are refused before the runtime", async () => {
  const cases = [
    { inferenceScope: "chatIntelligence" },
    { inferenceScope: "dictationAgent" },
    { inferenceScope: "dictationAgentVision" },
    { inferenceScope: "dictationCleanup", requiresAgent: true },
    { inferenceScope: "noteFormatting", screenContext: { data: "x", mediaType: "image/jpeg" } },
  ];
  for (const config of cases) {
    const { handler, calls } = handlerWith(ok);
    const result = await handler({}, "text", "claude-haiku-5.5", null, config);
    assert.equal(result.success, false, JSON.stringify(config));
    assert.equal(result.code, "PROVIDER_BAD_REQUEST");
    assert.equal(calls.length, 0);
  }
});

test("an empty reply is the cleanup empty-reply error", async () => {
  const { handler } = handlerWith(async () => ({ text: "  ", finishReason: "stop" }));
  const result = await handler({}, "text", "claude-haiku-5.5", null, {});
  assert.equal(result.success, false);
  assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.cleanupEmptyReply");
});

test("a rejected sign-in is classified and flagged for Settings", async () => {
  const { handler, rejectedCount } = handlerWith(async () => {
    throw Object.assign(new Error("Bad credentials"), {
      code: "COPILOT_SDK_ERROR",
      errorType: "authentication",
      statusCode: 401,
    });
  });
  const result = await handler({}, "text", "claude-haiku-5.5", null, {});
  assert.equal(result.code, "PROVIDER_AUTH_FAILED");
  assert.equal(result.messageKey, "providerErrors.copilot.authFailed");
  assert.equal(result.settingsTarget, "llms");
  assert.equal(rejectedCount(), 1);
});

test("runtime failures map to the provider errors every surface already shows", () => {
  const cases = [
    [{ code: "COPILOT_NOT_SIGNED_IN" }, "API_KEY_MISSING", "providerErrors.copilot.notSignedIn"],
    [{ code: "COPILOT_TIMEOUT" }, "PROVIDER_TIMEOUT", "providerErrors.timeout"],
    [
      { code: "COPILOT_MODEL_UNAVAILABLE" },
      "PROVIDER_MODEL_NOT_FOUND",
      "providerErrors.modelNotFound",
    ],
    [{ code: "COPILOT_RUNTIME_FAILED" }, "PROVIDER_UNAVAILABLE", "providerErrors.unavailable"],
    [
      { code: "COPILOT_SDK_ERROR", errorType: "policy" },
      "PROVIDER_ACCESS_DENIED",
      "providerErrors.copilot.accessDenied",
    ],
    [
      { code: "COPILOT_SDK_ERROR", errorType: "quota" },
      "PROVIDER_QUOTA_EXHAUSTED",
      "providerErrors.quotaExhausted",
    ],
    [
      { code: "COPILOT_SDK_ERROR", errorType: "rate_limit" },
      "PROVIDER_RATE_LIMITED",
      "providerErrors.rateLimited",
    ],
    [
      { code: "COPILOT_SDK_ERROR", statusCode: 503, message: "busy" },
      "PROVIDER_UNAVAILABLE",
      "providerErrors.unavailable",
    ],
    [
      { code: "COPILOT_SDK_ERROR", connectionLost: true },
      "PROVIDER_UNAVAILABLE",
      "providerErrors.unavailable",
    ],
  ];
  for (const [error, code, messageKey] of cases) {
    const classified = copilotProviderError(error, { model: "claude-haiku-5.5" });
    assert.equal(classified.code, code, JSON.stringify(error));
    assert.equal(classified.messageKey, messageKey, JSON.stringify(error));
    assert.equal(classified.messageParams.provider, "GitHub Copilot");
  }
  const truncated = copilotProviderError({ code: "COPILOT_TRUNCATED" });
  assert.equal(truncated.messageKey, "hooks.audioRecording.errorDescriptions.cleanupTruncated");
});

test("a GitHub token never survives into an error's details", () => {
  const classified = copilotProviderError({
    code: "COPILOT_SDK_ERROR",
    statusCode: 400,
    message: "rejected gho_abcdefghijklmnop and github_pat_11AAAAAAA",
  });
  assert.doesNotMatch(JSON.stringify(classified.technicalDetails), /gho_|github_pat_/);
});

test("the request deadline is bounded", () => {
  assert.equal(deadlineFrom({}), 60000);
  assert.equal(deadlineFrom({ timeoutMs: 10 }), 5000);
  assert.equal(deadlineFrom({ timeoutMs: 45000 }), 45000);
  assert.equal(deadlineFrom({ timeoutMs: 99999999 }), 600000);
});

const STEPS = Object.freeze({
  coldStart: false,
  acquireMs: 0,
  catalog: "fresh",
  catalogMs: 0,
  sessionMs: 120,
  sendMs: 900,
  closeMs: 12,
});
const USAGE = Object.freeze({ modelMs: 850, ttftMs: 410, inputTokens: 1200, outputTokens: 40 });

// A handler whose clock moves by `durationMs` while the runtime works.
function timedHandler(durationMs, complete) {
  let clock = 1000;
  const { logger, lines, named } = captureLogger();
  let rejected = 0;
  const handler = createCopilotReasoningHandler({
    runtime: {
      complete: async (args) => {
        clock += durationMs;
        return complete(args);
      },
    },
    auth: { reportTokenRejected: () => (rejected += 1) },
    logger,
    now: () => clock,
  });
  return { handler, lines, named };
}

const timedOk = async () => ({
  text: "Clean text.",
  finishReason: "stop",
  reasoningEffort: "low",
  timings: { ...STEPS },
  usage: { ...USAGE },
});

test("copilot-prewarm asks the runtime to prewarm and replies without waiting for it", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  let prewarms = 0;
  const runtime = {
    prewarm: () => {
      prewarms += 1;
      return new Promise(() => {});
    },
  };
  registerCopilotIpc({ ipcMain, copilot: { runtime, auth: {} } });
  assert.equal(handlers.get("copilot-prewarm")({}), undefined);
  await flush();
  assert.equal(prewarms, 1);

  // A failing prewarm stays quiet.
  runtime.prewarm = () => Promise.reject(new Error("boom"));
  assert.equal(handlers.get("copilot-prewarm")({}), undefined);
  await flush();
});

test("a finished request logs its steps and usage", async () => {
  const { handler, named } = timedHandler(1200, timedOk);
  const result = await handler({}, "um text", "claude-haiku-5.5", null, {
    inferenceScope: "dictationCleanup",
  });
  assert.deepEqual(result, { success: true, text: "Clean text." });
  const [finished] = named("Copilot request finished");
  assert.equal(finished.level, "debug");
  assert.equal(finished.scope, "copilot");
  assert.deepEqual(finished.meta, {
    model: "claude-haiku-5.5",
    scope: "dictationCleanup",
    effort: "low",
    finishReason: "stop",
    ms: 1200,
    steps: STEPS,
    usage: USAGE,
  });
  assert.equal(named("Slow Copilot request").length, 0);
});

test("a request of 6000 ms or more also warns as slow, with the same fields", async () => {
  for (const [ms, slow] of [
    [5999, false],
    [6000, true],
    [10800, true],
  ]) {
    const { handler, named } = timedHandler(ms, timedOk);
    await handler({}, "text", "claude-haiku-5.5", null, { inferenceScope: "dictationCleanup" });
    const warnings = named("Slow Copilot request");
    assert.equal(warnings.length, slow ? 1 : 0, String(ms));
    if (slow) {
      assert.equal(warnings[0].level, "warn");
      assert.deepEqual(warnings[0].meta, named("Copilot request finished")[0].meta);
      assert.equal(warnings[0].meta.model, "claude-haiku-5.5");
      assert.equal(warnings[0].meta.scope, "dictationCleanup");
      assert.equal(warnings[0].meta.ms, ms);
    }
  }
});

test("a failed request logs the steps it got through, and nothing new crosses IPC", async () => {
  const partial = { coldStart: true, acquireMs: 3000, catalog: "fetched", catalogMs: 2000 };
  const { handler, named } = timedHandler(7000, async () => {
    throw Object.assign(new Error("Copilot took longer than 60000 ms"), {
      code: "COPILOT_TIMEOUT",
      copilotTimings: partial,
    });
  });
  const result = await handler({}, "text", "claude-haiku-5.5", null, {});
  assert.equal(result.success, false);
  assert.equal(result.code, "PROVIDER_TIMEOUT");
  assert.equal(JSON.stringify(result).includes("acquireMs"), false);
  const [failed] = named("Copilot request failed");
  assert.equal(failed.level, "warn");
  assert.deepEqual(failed.meta.steps, partial);
  assert.equal(failed.meta.ms, 7000);
  assert.equal(named("Slow Copilot request").length, 0);

  // An empty reply fails after the runtime finished: its steps still log.
  const empty = timedHandler(800, async () => ({ ...(await timedOk()), text: " " }));
  const emptyResult = await empty.handler({}, "text", "claude-haiku-5.5", null, {});
  assert.equal(emptyResult.success, false);
  assert.equal(JSON.stringify(emptyResult).includes("sessionMs"), false);
  assert.deepEqual(empty.named("Copilot request failed")[0].meta.steps, STEPS);
});

test("no prompt or reply text reaches any Copilot log line", async () => {
  const config = { inferenceScope: "dictationCleanup", systemPrompt: "SYSTEM-CANARY-4471" };
  const reply = timedHandler(7000, async () => ({
    ...(await timedOk()),
    text: "REPLY-CANARY-4471",
  }));
  await reply.handler({}, "USER-CANARY-4471", "claude-haiku-5.5", null, config);
  const failure = timedHandler(7000, async () => {
    throw Object.assign(new Error("echo USER-CANARY-4471"), {
      code: "COPILOT_SDK_ERROR",
      copilotTimings: { ...STEPS },
    });
  });
  await failure.handler({}, "USER-CANARY-4471", "claude-haiku-5.5", null, config);
  const logged = JSON.stringify([...reply.lines, ...failure.lines]);
  assert.equal(reply.lines.length, 2);
  assert.equal(failure.lines.length, 1);
  assert.doesNotMatch(logged, /CANARY/);
});
