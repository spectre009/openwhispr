const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RECORDING_RETENTION_DAY_OPTIONS,
  TRANSCRIPT_RETENTION_DAY_OPTIONS,
  effectiveRecordingRetentionDays,
  recordingRetentionChoices,
  recordingSweepDays,
  transcriptRetentionChoices,
} = require("../../src/utils/retentionPeriods.js");

// How long recordings and transcripts are kept (utils/retentionPeriods.js):
// each list, the organization's cap, and the rule that a recording never
// outlives its transcript, in the UI's value and main's sweep alike.

test("recordings: Off, then 1 day to 1 year; transcripts: Forever, then 1 year down to 1 day", () => {
  assert.deepEqual([...RECORDING_RETENTION_DAY_OPTIONS], [1, 7, 14, 30, 60, 90, 180, 365]);
  assert.deepEqual([...TRANSCRIPT_RETENTION_DAY_OPTIONS], [365, 180, 90, 60, 30, 14, 7, 1]);
  assert.deepEqual(
    recordingRetentionChoices(30).map((choice) => choice.days),
    [0, 1, 7, 14, 30, 60, 90, 180, 365]
  );
  assert.ok(
    recordingRetentionChoices(30).every((choice) => !choice.disabled),
    "no cap"
  );
  assert.deepEqual(transcriptRetentionChoices(0), [0, 365, 180, 90, 60, 30, 14, 7, 1]);
});

test("an organization's cap disables the longer options and shows an off-list value in force", () => {
  const capped = recordingRetentionChoices(45, 45);
  assert.deepEqual(
    capped.map(({ days, disabled }) => [days, disabled]),
    [
      [0, false],
      [1, false],
      [7, false],
      [14, false],
      [30, false],
      [45, false],
      [60, true],
      [90, true],
      [180, true],
      [365, true],
    ]
  );
  // A cap on the list adds nothing; Off is never disabled.
  const atNinety = recordingRetentionChoices(90, 90);
  assert.equal(atNinety.length, 9);
  assert.deepEqual(
    atNinety.filter((choice) => choice.disabled).map((choice) => choice.days),
    [180, 365]
  );
  // A transcript value off the list (an old hand edit) still shows.
  assert.deepEqual(transcriptRetentionChoices(45), [0, 365, 180, 90, 60, 45, 30, 14, 7, 1]);
});

test("a recording is never kept longer than its transcript", () => {
  assert.equal(effectiveRecordingRetentionDays(365, 0), 365, "transcripts forever");
  assert.equal(effectiveRecordingRetentionDays(365, 30), 30, "the shorter transcript wins");
  assert.equal(effectiveRecordingRetentionDays(7, 30), 7);
  assert.equal(effectiveRecordingRetentionDays(0, 30), 0, "Off stays off");
  assert.equal(effectiveRecordingRetentionDays("90", "14"), 14, "stored strings count");
  assert.equal(effectiveRecordingRetentionDays(-3, 30), 0);
});

test("main's sweep deletes files at the shorter limit, recordings Off included", () => {
  assert.equal(recordingSweepDays(180, 30), 30);
  assert.equal(recordingSweepDays(30, 180), 30);
  assert.equal(recordingSweepDays(90, 0), 90, "transcripts forever: the recording limit");
  assert.equal(recordingSweepDays(0, 14), 14, "files kept from before go with their transcripts");
  assert.equal(recordingSweepDays(0, 0), 0, "nothing to sweep");
});
