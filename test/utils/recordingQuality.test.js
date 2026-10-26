const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_RECORDING_QUALITY,
  RECOMMENDED_RECORDING_QUALITY,
  RECORDING_KB_PER_MINUTE,
  RECORDING_QUALITIES,
  estimateRecordingBytes,
  mergeBitrateFor,
  normalizeRecordingQuality,
  recorderOptionsFor,
  recordingBytesPerMinute,
} = require("../../src/utils/recordingQuality.js");

// Recording quality (utils/recordingQuality.js): one table for the recorders'
// bitrate, the merge of recovered recordings and the sizes the UI shows.

test("three qualities, Original by default and Smaller recommended", () => {
  assert.deepEqual([...RECORDING_QUALITIES], ["smaller", "balanced", "original"]);
  assert.equal(DEFAULT_RECORDING_QUALITY, "original");
  assert.equal(RECOMMENDED_RECORDING_QUALITY, "smaller");
  for (const value of [undefined, null, "", "high", 32]) {
    assert.equal(normalizeRecordingQuality(value), "original", String(value));
  }
});

test("Smaller and Balanced set the Opus bitrate; Original asks for nothing", () => {
  assert.deepEqual(recorderOptionsFor("smaller"), { audioBitsPerSecond: 32000 });
  assert.deepEqual(recorderOptionsFor("balanced"), { audioBitsPerSecond: 64000 });
  assert.equal(recorderOptionsFor("original"), null);
  assert.equal(recorderOptionsFor("unknown"), null);
});

test("a recovered recording merges at its quality: 32k, 64k, and Original keeps 64k", () => {
  assert.equal(mergeBitrateFor("smaller"), "32k");
  assert.equal(mergeBitrateFor("balanced"), "64k");
  assert.equal(mergeBitrateFor("original"), "64k");
  assert.equal(mergeBitrateFor(undefined), "64k");
});

test("sizes a minute and the estimate at a pace", () => {
  assert.deepEqual({ ...RECORDING_KB_PER_MINUTE }, { smaller: 240, balanced: 480, original: 945 });
  assert.equal(recordingBytesPerMinute("smaller"), 240 * 1024);
  // 14 minutes a day for 30 days at Smaller: about 98 MB.
  assert.equal(
    estimateRecordingBytes({ minutesPerDay: 14, days: 30, quality: "smaller" }),
    14 * 30 * 240 * 1024
  );
  assert.equal(estimateRecordingBytes({ minutesPerDay: 0, days: 30, quality: "smaller" }), 0);
  assert.equal(estimateRecordingBytes({ minutesPerDay: 5, days: 0, quality: "original" }), 0);
  assert.equal(estimateRecordingBytes({ minutesPerDay: null, days: 30, quality: "original" }), 0);
});
