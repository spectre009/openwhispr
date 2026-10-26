const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeTrace } = require("../../src/helpers/stepHistory.js");
const { runPostTranscription } = require("../../src/helpers/postTranscription.ts");
const en = require("../../src/locales/en/translation.json");

// Why a step failed, as step history keeps it (helpers/stepFailure.js): built
// in the renderer from an allowlist and checked again in main with the same
// one. A provider's body, the dictation and any other parameter never reach
// the stored step. Synthetic text only.

async function load() {
  return import("../../src/helpers/stepFailure.js");
}

const DICTATED = "so tell Martha the merger closes on the 14th";
const BODY = '{"error":{"message":"insufficient_quota","org":"org-8f3k2"}}';

// What a classified provider error looks like when it reaches the boundary,
// with everything a careless copy could store.
const providerFailure = () =>
  Object.assign(new Error(`OpenAI said: ${DICTATED}`), {
    code: "PROVIDER_QUOTA_EXHAUSTED",
    messageKey: "providerErrors.quotaExhausted",
    messageParams: {
      provider: "OpenAI",
      model: "gpt-4.1-mini",
      error: DICTATED,
      region: "us-east-1",
    },
    settingsTarget: "llms",
    surface: "llm",
    status: 402,
    responseBody: BODY,
    technicalDetails: {
      provider: "OpenAI",
      status: 402,
      requestId: "req_9a8b7c",
      underlyingError: BODY,
    },
  });

test("a descriptor keeps the code, an allowed key, provider and model, and the settings section", async () => {
  const { failureDescriptor } = await load();
  assert.deepEqual(failureDescriptor(providerFailure()), {
    code: "PROVIDER_QUOTA_EXHAUSTED",
    messageKey: "providerErrors.quotaExhausted",
    messageParams: { provider: "OpenAI", model: "gpt-4.1-mini" },
    settingsTarget: "llms",
  });
});

test("anything unclassified says unknown, and nothing else gets through", async () => {
  const { failureDescriptor, UNKNOWN_FAILURE_CODE } = await load();
  assert.deepEqual(failureDescriptor(new Error(DICTATED)), { code: UNKNOWN_FAILURE_CODE });
  assert.deepEqual(failureDescriptor(null), { code: "unknown" });
  assert.deepEqual(failureDescriptor("Error"), { code: "unknown" });
  // A code that isn't a plain identifier, a key the card never renders, a
  // section Settings doesn't open, and parameters on an unknown key.
  assert.deepEqual(
    failureDescriptor({
      code: `PROVIDER ${DICTATED}`,
      messageKey: "reasoning.enterprise.errors.bedrock.unknown",
      messageParams: { provider: "AWS Bedrock", error: DICTATED },
      settingsTarget: "account",
    }),
    { code: "unknown" }
  );
  // Cloud's own codes are kept as codes, without a sentence.
  assert.deepEqual(failureDescriptor({ code: "AUTH_EXPIRED", message: "Session expired" }), {
    code: "AUTH_EXPIRED",
  });
  // Parameters are short single-line strings.
  const long = failureDescriptor({
    code: "PROVIDER_MODEL_NOT_FOUND",
    messageKey: "providerErrors.modelNotFound",
    messageParams: { provider: "Groq\n\u0007", model: "m".repeat(400) },
  });
  assert.equal(long.messageParams.provider, "Groq");
  assert.equal(long.messageParams.model.length, 100);
  assert.deepEqual(
    failureDescriptor({
      code: "PROVIDER_AUTH_FAILED",
      messageKey: "providerErrors.authFailed",
      messageParams: { provider: 42 },
    }),
    { code: "PROVIDER_AUTH_FAILED", messageKey: "providerErrors.authFailed" }
  );
});

test("a failed step stores no provider body, no dictated text, no other parameter", async () => {
  const { trace } = await runPostTranscription(DICTATED, {
    run: async ({ recordStep }) => {
      try {
        await recordStep("cleanup", {}, async (dispatched) => {
          dispatched({ provider: "openai", model: "gpt-4.1-mini" });
          throw providerFailure();
        });
      } catch {
        // The corrected transcript is the floor.
      }
      return null;
    },
  });
  // What the renderer sends.
  const sent = trace.steps.find((step) => step.kind === "cleanup");
  assert.equal(sent.outcome, "failed");
  assert.deepEqual(sent.detail, {
    failure: {
      code: "PROVIDER_QUOTA_EXHAUSTED",
      messageKey: "providerErrors.quotaExhausted",
      messageParams: { provider: "OpenAI", model: "gpt-4.1-mini" },
      settingsTarget: "llms",
    },
  });
  // What main stores, after validating it again.
  const stored = normalizeTrace(trace).steps.find((step) => step.kind === "cleanup");
  assert.deepEqual(stored.detail, sent.detail);
  assert.equal(stored.output, null);
  const json = JSON.stringify(stored);
  for (const leak of [DICTATED, "insufficient_quota", "org-8f3k2", "req_9a8b7c", "us-east-1"]) {
    assert.ok(!json.includes(leak), `the stored step must not contain ${leak}`);
  }
});

test("main checks a received descriptor with the same allowlist", () => {
  const tampered = normalizeTrace({
    version: 1,
    context: { targetApp: null, intents: {} },
    steps: [
      { kind: "stt", outcome: "ok", output: "hi", detail: { reused: "stored", extra: DICTATED } },
      {
        kind: "cleanup",
        outcome: "failed",
        output: null,
        errorCode: "PROVIDER_AUTH_FAILED",
        detail: {
          failure: {
            code: "PROVIDER_AUTH_FAILED",
            messageKey: "providerErrors.authFailed",
            messageParams: { provider: "OpenAI", body: BODY },
            settingsTarget: "llms",
            message: DICTATED,
            technicalDetails: { underlyingError: BODY },
          },
          note: DICTATED,
        },
      },
      {
        kind: "style",
        outcome: "fallback",
        output: "",
        detail: { styleId: "teams", runMode: "one-step", failure: { code: "x y" } },
      },
      // A step that succeeded never carries a failure.
      { kind: "translation", outcome: "ok", output: "salut", detail: { failure: { code: "X" } } },
      // Only a speech-to-text step is ever marked reused.
      { kind: "cleanup", outcome: "skipped", output: "hi", detail: { reused: "stored" } },
    ],
  });
  assert.deepEqual(
    tampered.steps.map((step) => step.detail),
    [
      { reused: "stored" },
      {
        failure: {
          code: "PROVIDER_AUTH_FAILED",
          messageKey: "providerErrors.authFailed",
          messageParams: { provider: "OpenAI" },
          settingsTarget: "llms",
        },
      },
      { styleId: "teams", runMode: "one-step", failure: { code: "unknown" } },
      null,
      null,
    ]
  );
  assert.equal(
    normalizeTrace({
      version: 1,
      steps: [{ kind: "stt", outcome: "ok", output: "hi", detail: { reused: "invented" } }],
    }).steps[0].detail,
    null
  );
});

test("every message key a failure may name is one the locales have", async () => {
  const { FAILURE_MESSAGE_KEYS } = await load();
  const lookup = (key) => key.split(".").reduce((node, part) => node?.[part], en);
  for (const key of FAILURE_MESSAGE_KEYS) {
    const value = lookup(key);
    assert.equal(typeof value, "string", key);
    // Only provider and model are ever kept, so a key may need no other value.
    for (const [, name] of value.matchAll(/\{\{(\w+)\}\}/g)) {
      assert.ok(["provider", "model"].includes(name), `${key} interpolates ${name}`);
    }
  }
});

test("a History row flags a failed or ignored cleanup, style or translation step", async () => {
  const { failedStepKind, isFlaggedStepFailure, normalizeReusedMarker } = await load();
  assert.equal(failedStepKind([{ kind: "cleanup", outcome: "failed" }]), "cleanup");
  assert.equal(
    failedStepKind([
      { kind: "cleanup", outcome: "ok" },
      { kind: "translation", outcome: "fallback" },
      { kind: "style", outcome: "failed" },
    ]),
    "translation"
  );
  for (const step of [
    { kind: "translation", outcome: "skipped" },
    { kind: "translation", outcome: "ok" },
    { kind: "agent", outcome: "failed" },
    { kind: "finalize", outcome: "failed" },
    { kind: "stt", outcome: "failed" },
  ]) {
    assert.equal(isFlaggedStepFailure(step), false, JSON.stringify(step));
  }
  assert.equal(failedStepKind(null), null);
  assert.equal(normalizeReusedMarker("stored"), "stored");
  assert.equal(normalizeReusedMarker("unknown"), "unknown");
  assert.equal(normalizeReusedMarker("yes"), null);
});
