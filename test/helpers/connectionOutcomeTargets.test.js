const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONNECTION_FAILURE_CODES,
  PROVIDER_KEY_SLOTS,
  connectionFailureCode,
  descriptorSlot,
  endpointCheckRoute,
  endpointDescriptorId,
  featureForScope,
  isCancellation,
  llmOutcomeTarget,
  requestOutcomeOfFailure,
  transcriptionOutcomeTag,
  transcriptionOutcomeTarget,
} = require("../../src/helpers/connectionOutcomeTargets.js");
const { KIND_SLOTS } = require("../../src/helpers/connectionChecks.js");
const { providerError, providerHttpError } = require("../../src/helpers/providerHttpErrors.js");
const { finishCleanupOutput } = require("../../src/utils/cleanupOutput");

// "Last recorded use" on Settings › AI Connections: which of stage A's check
// descriptors a real request ran on, which feature it counts for, and which
// failures say something about the connection (a cancel, a yield, a missing
// key or a local check of the reply say nothing).

const AZURE = "https://littlebuddy.openai.azure.com";

test("language-model requests map to stage A's descriptor ids", () => {
  assert.deepEqual(llmOutcomeTarget({ provider: "groq" }), {
    id: "provider:groq",
    slot: "GROQ_API_KEY",
  });
  assert.deepEqual(llmOutcomeTarget({ provider: "openrouter" }), {
    id: "provider:openrouter",
    slot: "OPENROUTER_API_KEY",
  });
  assert.deepEqual(llmOutcomeTarget({ provider: "openwhispr" }), { id: "cloud", slot: null });
  assert.deepEqual(llmOutcomeTarget({ provider: "copilot" }), {
    id: "copilot",
    slot: "GITHUB_COPILOT_TOKEN",
  });
  assert.deepEqual(llmOutcomeTarget({ provider: "corti" }), {
    id: "corti:llm",
    slot: "CORTI_API_KEY",
  });
  // A feature's own endpoint: its route (Azure as the resource's v1 base) and its key slot.
  const custom = llmOutcomeTarget({
    provider: "custom",
    baseUrl: `${AZURE}/openai/deployments/gpt/chat/completions?api-version=2025-01-01`,
    slot: "CUSTOM_CLEANUP_API_KEY",
  });
  assert.equal(custom.slot, "CUSTOM_CLEANUP_API_KEY");
  assert.equal(
    custom.id,
    endpointDescriptorId("endpoint", `${AZURE}/openai/v1`, "CUSTOM_CLEANUP_API_KEY")
  );
  assert.match(custom.id, /^endpoint:[0-9a-f]{8}$/);
  assert.ok(!custom.id.includes("azure"), "the id never carries the URL");
  // Another slot is another descriptor; no slot, no descriptor.
  assert.notEqual(
    llmOutcomeTarget({ provider: "custom", baseUrl: AZURE, slot: "CHAT_AGENT_CUSTOM_API_KEY" }).id,
    custom.id
  );
  assert.equal(llmOutcomeTarget({ provider: "custom", baseUrl: AZURE }), null);
  assert.equal(llmOutcomeTarget({ provider: "custom", baseUrl: "not a url", slot: "X" }), null);
  // Self-hosted: the route only, http for a bare private host as stage A reads it.
  const lan = llmOutcomeTarget({ provider: "lan", lanUrl: "192.168.1.20:8080" });
  assert.deepEqual(lan, {
    id: endpointDescriptorId("selfHosted", endpointCheckRoute("192.168.1.20:8080", true), null),
    slot: null,
  });
  // Nothing stage A checks: local models, enterprise deployments, unknown ids.
  for (const provider of ["local", "bedrock", "azure", "vertex", "nope", undefined]) {
    assert.equal(llmOutcomeTarget({ provider }), null, String(provider));
  }
});

test("speech-to-text routes map to stage A's descriptor ids", () => {
  const settings = {
    cloudTranscriptionBaseUrl: `${AZURE}/openai/deployments/whisper/audio/transcriptions?api-version=2024-06-01`,
    remoteTranscriptionUrl: "http://10.0.0.5:9000/v1",
  };
  const batch = (provider) => ({ transport: "http-batch", provider });
  assert.equal(transcriptionOutcomeTarget(batch("openai"), settings).id, "provider:openai");
  assert.equal(transcriptionOutcomeTarget(batch("groq"), settings).id, "provider:groq");
  assert.deepEqual(transcriptionOutcomeTarget(batch("custom"), settings), {
    id: endpointDescriptorId("endpoint", `${AZURE}/openai/v1`, "CUSTOM_TRANSCRIPTION_API_KEY"),
    slot: "CUSTOM_TRANSCRIPTION_API_KEY",
  });
  assert.deepEqual(transcriptionOutcomeTarget(batch("self-hosted"), settings), {
    id: endpointDescriptorId("selfHosted", "http://10.0.0.5:9000/v1", null),
    slot: null,
  });
  assert.deepEqual(
    transcriptionOutcomeTarget({ transport: "azure-speech", provider: "azure-speech" }),
    { id: "provider:azure-speech", slot: "AZURE_SPEECH_API_KEY" }
  );
  assert.equal(
    transcriptionOutcomeTarget({ transport: "proxied", provider: "corti" }).id,
    "corti:stt"
  );
  assert.equal(transcriptionOutcomeTarget({ transport: "local" }), null);
  assert.equal(transcriptionOutcomeTarget({ transport: "managed", provider: "azure" }), null);
  assert.equal(transcriptionOutcomeTarget(null), null);
  assert.deepEqual(transcriptionOutcomeTag(batch("groq"), {}, "recognition"), {
    descriptorId: "provider:groq",
    slot: "GROQ_API_KEY",
    feature: "recognition",
  });
  assert.equal(transcriptionOutcomeTag({ transport: "local" }, {}, "recognition"), null);
});

test("each descriptor's fence slot is stage A's, and only endpoints take the request's", () => {
  for (const [provider, slot] of Object.entries(PROVIDER_KEY_SLOTS)) {
    assert.equal(KIND_SLOTS[provider], slot, `${provider} matches the checks`);
    assert.equal(descriptorSlot(`provider:${provider}`, "SOMETHING_ELSE"), slot);
  }
  assert.equal(descriptorSlot("corti:llm"), KIND_SLOTS["corti-llm"]);
  assert.equal(descriptorSlot("corti:stt"), KIND_SLOTS["corti-stt"]);
  assert.equal(descriptorSlot("copilot"), KIND_SLOTS.copilot);
  assert.equal(descriptorSlot("custom"), KIND_SLOTS.custom);
  assert.equal(descriptorSlot("cloud"), null);
  assert.equal(descriptorSlot("selfHosted:0a1b2c3d"), null);
  assert.equal(
    descriptorSlot("endpoint:0a1b2c3d", "TRANSLATION_CUSTOM_API_KEY"),
    "TRANSLATION_CUSTOM_API_KEY"
  );
  // Not ids stage A builds, or a slot that isn't a feature's.
  for (const [id, slot] of [
    ["endpoint:0a1b2c3d", "OPENAI_API_KEY"],
    ["endpoint:0a1b2c3d", null],
    ["endpoint:https://x", "CUSTOM_CLEANUP_API_KEY"],
    ["provider:nope", null],
    ["provider:__proto__", null],
    ["constructor", null],
    [42, null],
  ]) {
    assert.equal(descriptorSlot(id, slot), undefined, `${id} ${slot}`);
  }
});

test("features: by scope, the assistant's vision requests as the assistant", () => {
  assert.equal(featureForScope("dictationCleanup"), "cleanup");
  assert.equal(featureForScope("dictationAgent"), "assistant");
  assert.equal(featureForScope("dictationAgentVision"), "assistant");
  assert.equal(featureForScope("noteFormatting"), "noteFormatting");
  assert.equal(featureForScope("chatIntelligence"), "chat");
  assert.equal(featureForScope("dictationTranslation"), "translation");
  assert.equal(featureForScope("transcription"), null);
  assert.equal(featureForScope(undefined), null);
});

test("only the connection's own failures are recorded", () => {
  const ctx = { provider: "Groq", surface: "llm" };
  // A provider's answer, classified.
  assert.equal(
    connectionFailureCode(providerHttpError({ ...ctx, status: 401, body: "bad key" })),
    "PROVIDER_AUTH_FAILED"
  );
  assert.equal(
    connectionFailureCode(providerHttpError({ ...ctx, status: 429, body: "" })),
    "PROVIDER_RATE_LIMITED"
  );
  assert.equal(connectionFailureCode(providerError("PROVIDER_TIMEOUT", ctx)), "PROVIDER_TIMEOUT");
  assert.equal(
    connectionFailureCode({ code: "AZURE_SPEECH_ENDPOINT_INVALID" }),
    "AZURE_SPEECH_ENDPOINT_INVALID"
  );
  // OpenWhispr Cloud's own codes, in the providers' words.
  assert.equal(connectionFailureCode({ code: "AUTH_EXPIRED" }), "PROVIDER_AUTH_FAILED");
  assert.equal(connectionFailureCode({ code: "LIMIT_REACHED" }), "PROVIDER_QUOTA_EXHAUSTED");
  assert.equal(connectionFailureCode({ code: "SERVER_ERROR" }), "PROVIDER_UNAVAILABLE");
  // Network failures nobody classified yet.
  assert.equal(
    connectionFailureCode(new Error("net::ERR_INTERNET_DISCONNECTED")),
    "PROVIDER_UNREACHABLE"
  );
  assert.equal(
    connectionFailureCode(new DOMException("timed out", "TimeoutError")),
    "PROVIDER_TIMEOUT"
  );

  // Cancels, a newer request, giving way to a dictation.
  for (const stopped of [
    new DOMException("Transcription cancelled", "AbortError"),
    { code: "TRANSCRIPTION_CANCELLED" },
    { code: "REASON_CANCELLED" },
    { code: "UPLOAD_CANCELLED" },
    { code: "COPILOT_CANCELLED" },
    { code: "YIELDED_TO_DICTATION" },
    Object.assign(new Error("Request cancelled"), { status: 499 }),
  ]) {
    assert.ok(isCancellation(stopped));
    assert.equal(connectionFailureCode(stopped), null, JSON.stringify(stopped));
  }
  // Nothing was sent: a missing key or sign-in.
  assert.equal(connectionFailureCode(providerError("API_KEY_MISSING", ctx)), null);
  // A local check of the reply: a repeated transcript, a cut-off or empty answer.
  let repeated;
  try {
    const said = "please send the quarterly report to the whole team today";
    finishCleanupOutput(said, `${said}\n\n${said}`);
  } catch (error) {
    repeated = error;
  }
  assert.equal(repeated?.code, "CLEANUP_OUTPUT_INVALID", "the repeated-transcript check rejects");
  assert.equal(connectionFailureCode(repeated), null);
  assert.equal(
    connectionFailureCode({ code: "LLM_OUTPUT_TRUNCATED", messageKey: "x.truncated" }),
    null
  );
  assert.equal(connectionFailureCode({ code: "COPILOT_TRUNCATED", messageKey: "x" }), null);
  assert.equal(connectionFailureCode(new Error("Invalid response structure from Groq API")), null);
  // A tool's or a delivery's failure, a policy refusal: not the connection's.
  assert.equal(connectionFailureCode({ code: "POLICY_RESTRICTED", messageKey: "x" }), null);
  assert.equal(connectionFailureCode(new Error("Paste failed")), null);
  assert.equal(connectionFailureCode(null), null);
  assert.equal(connectionFailureCode("PROVIDER_AUTH_FAILED"), null);

  // The service answered about the content: the connection worked.
  assert.deepEqual(requestOutcomeOfFailure({ code: "NO_SPEECH_DETECTED" }), {
    ok: true,
    code: "OK",
  });
  // An answer with no text is an answer too.
  assert.deepEqual(requestOutcomeOfFailure({ code: "EMPTY_TRANSCRIPT" }), {
    ok: true,
    code: "OK",
  });
  assert.deepEqual(requestOutcomeOfFailure({ code: "PROVIDER_UNAVAILABLE" }), {
    ok: false,
    code: "PROVIDER_UNAVAILABLE",
  });
  assert.equal(requestOutcomeOfFailure({ code: "REASON_CANCELLED" }), null);
  for (const code of CONNECTION_FAILURE_CODES) assert.match(code, /^[A-Z][A-Z0-9_]+$/);
});
