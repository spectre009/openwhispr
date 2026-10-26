const test = require("node:test");
const assert = require("node:assert/strict");

// Which failures the error card's Retry re-sends, and what the dictation
// window keeps for it: nothing when history or recordings are off.

async function load() {
  return import("../../src/helpers/failedRecordingRetry.js");
}

const kept = { dataRetentionEnabled: true, audioRetentionDays: 30 };
const blob = { size: 4096, type: "audio/webm" };

test("a second try can fix a timeout, an unreachable provider, a 5xx or a rate limit", async () => {
  const { isResendableFailure, RESENDABLE_ERROR_CODES } = await load();
  for (const code of [
    "PROVIDER_TIMEOUT",
    "PROVIDER_UNREACHABLE",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_RATE_LIMITED",
    "TRANSCRIPTION_REQUEST_TIMEOUT",
  ]) {
    assert.equal(isResendableFailure({ code }), true, code);
    assert.ok(RESENDABLE_ERROR_CODES.includes(code));
  }
  for (const code of [
    "PROVIDER_AUTH_FAILED",
    "PROVIDER_QUOTA_EXHAUSTED",
    "PROVIDER_MODEL_NOT_FOUND",
    "PROVIDER_NO_RESPONSE",
    "API_KEY_MISSING",
    "CUSTOM_ENDPOINT_INVALID",
    "SERVER_ERROR",
    undefined,
  ]) {
    assert.equal(isResendableFailure({ code }), false, String(code));
  }
});

test("a resendable failure keeps the recording, its intent and its row", async () => {
  const { keptRecordingFor } = await load();
  const style = Object.freeze({ id: "teams", name: "Teams chat", emoji: "💬" });
  const recording = keptRecordingFor({
    error: { code: "PROVIDER_TIMEOUT" },
    blob,
    metadata: {
      durationSeconds: 4.6,
      analyticsOccurredAt: "2026-10-26T17:46:30.000Z",
      streamedText: "never kept",
      rawWav: { size: 10 },
    },
    retention: kept,
    style,
    rowId: Promise.resolve(41),
  });
  assert.equal(recording.blob, blob);
  assert.deepEqual(recording.metadata, {
    durationSeconds: 4.6,
    analyticsOccurredAt: "2026-10-26T17:46:30.000Z",
    rawWav: { size: 10 },
  });
  assert.equal(recording.translationRequested, false);
  assert.equal(recording.style, style);
  assert.equal(await recording.rowId, 41);
  assert.equal(Object.isFrozen(recording), true);

  const translation = keptRecordingFor({
    error: { code: "PROVIDER_UNAVAILABLE" },
    blob,
    retention: kept,
    translationRequested: true,
    style,
    rowId: null,
  });
  assert.equal(translation.translationRequested, true);
  assert.equal(translation.style, null, "a translation never carries a style");
  assert.equal(await translation.rowId, null);
});

test("nothing is kept without history and recordings, for the assistant, or without audio", async () => {
  const { keptRecordingFor } = await load();
  const base = { error: { code: "PROVIDER_TIMEOUT" }, blob, retention: kept, rowId: 1 };
  assert.ok(keptRecordingFor(base));
  for (const retention of [
    { dataRetentionEnabled: false, audioRetentionDays: 30 },
    { dataRetentionEnabled: true, audioRetentionDays: 0 },
    null,
  ]) {
    assert.equal(keptRecordingFor({ ...base, retention }), null);
  }
  assert.equal(keptRecordingFor({ ...base, voiceAgentRequested: true }), null);
  assert.equal(keptRecordingFor({ ...base, blob: { size: 0 } }), null);
  assert.equal(keptRecordingFor({ ...base, error: { code: "PROVIDER_AUTH_FAILED" } }), null);
});
