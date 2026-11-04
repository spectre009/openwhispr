const test = require("node:test");
const assert = require("node:assert/strict");

// "End empty dictations quietly": one rule for how a dictation that came back
// with no text ends, and the setting's choices. Length alone never decides
// that nothing was said, so Off and an unknown length are always the notice.

const load = () => import("../../src/utils/emptyDictation.js");

test("shorter than the threshold ends quietly; at or past it, the notice", async () => {
  const { emptyDictationOutcome } = await load();
  // The three empty dictations the user measured, at the default 3 s.
  for (const durationMs of [1395, 1538, 1587]) {
    assert.equal(emptyDictationOutcome({ durationMs, thresholdSeconds: 3 }), "quiet", durationMs);
  }
  assert.equal(emptyDictationOutcome({ durationMs: 0, thresholdSeconds: 3 }), "quiet");
  assert.equal(emptyDictationOutcome({ durationMs: 2999, thresholdSeconds: 3 }), "quiet");
  assert.equal(emptyDictationOutcome({ durationMs: 3000, thresholdSeconds: 3 }), "notice");
  assert.equal(emptyDictationOutcome({ durationMs: 4600, thresholdSeconds: 3 }), "notice");
});

test("every threshold the setting offers", async () => {
  const { emptyDictationOutcome } = await load();
  for (const thresholdSeconds of [2, 3, 5, 10]) {
    const edge = thresholdSeconds * 1000;
    assert.equal(emptyDictationOutcome({ durationMs: edge - 1, thresholdSeconds }), "quiet");
    assert.equal(emptyDictationOutcome({ durationMs: edge, thresholdSeconds }), "notice");
  }
  assert.equal(emptyDictationOutcome({ durationMs: 1538, thresholdSeconds: 2 }), "quiet");
  assert.equal(emptyDictationOutcome({ durationMs: 2500, thresholdSeconds: 2 }), "notice");
  assert.equal(emptyDictationOutcome({ durationMs: 9000, thresholdSeconds: 10 }), "quiet");
});

test("Off: every empty dictation says so", async () => {
  const { emptyDictationOutcome } = await load();
  assert.equal(emptyDictationOutcome({ durationMs: 400, thresholdSeconds: 0 }), "notice");
  assert.equal(emptyDictationOutcome({ durationMs: 0, thresholdSeconds: 0 }), "notice");
});

test("an unknown length is the notice", async () => {
  const { emptyDictationOutcome } = await load();
  for (const durationMs of [null, undefined, NaN, Infinity, -1, "1200"]) {
    assert.equal(
      emptyDictationOutcome({ durationMs, thresholdSeconds: 3 }),
      "notice",
      String(durationMs)
    );
  }
  for (const thresholdSeconds of [null, undefined, NaN, -2]) {
    assert.equal(
      emptyDictationOutcome({ durationMs: 500, thresholdSeconds }),
      "notice",
      String(thresholdSeconds)
    );
  }
});

test("the setting: 0 (Off), 2, 3, 5, 10; 3 by default and for anything else", async () => {
  const {
    QUIET_EMPTY_DICTATION_SECONDS,
    DEFAULT_QUIET_EMPTY_DICTATION_SECONDS,
    normalizeQuietEmptyDictationSeconds,
  } = await load();
  assert.deepEqual([...QUIET_EMPTY_DICTATION_SECONDS], [0, 2, 3, 5, 10]);
  assert.equal(DEFAULT_QUIET_EMPTY_DICTATION_SECONDS, 3);
  for (const value of QUIET_EMPTY_DICTATION_SECONDS) {
    assert.equal(normalizeQuietEmptyDictationSeconds(value), value);
    assert.equal(normalizeQuietEmptyDictationSeconds(String(value)), value);
  }
  for (const value of [undefined, null, "", " ", "abc", 1, 4, 2.5, -3, 60, "7", true, {}]) {
    assert.equal(normalizeQuietEmptyDictationSeconds(value), 3, JSON.stringify(value));
  }
});

test("an empty transcript error keeps its message and carries the code", async () => {
  const { EMPTY_TRANSCRIPT_CODE, emptyTranscriptError } = await load();
  assert.equal(EMPTY_TRANSCRIPT_CODE, "EMPTY_TRANSCRIPT");
  const error = emptyTranscriptError("No text transcribed - Mistral response was empty");
  assert.ok(error instanceof Error);
  assert.equal(error.message, "No text transcribed - Mistral response was empty");
  assert.equal(error.code, "EMPTY_TRANSCRIPT");
});
