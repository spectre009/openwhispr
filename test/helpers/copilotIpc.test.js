const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCopilotReasoningHandler,
  deadlineFrom,
} = require("../../src/helpers/copilot/copilotIpc");
const { copilotProviderError } = require("../../src/helpers/copilot/copilotErrors");

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
