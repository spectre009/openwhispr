// How long recordings and transcripts are kept (Settings › Storage ›
// Recordings, Privacy & Data). Pure, so the renderer's lists and main's
// retention sweep follow the same rule: a recording never outlives its
// transcript. Days: 0 means "not saved" for recordings and "forever" for
// transcripts.

export const RECORDING_RETENTION_DAY_OPTIONS = Object.freeze([1, 7, 14, 30, 60, 90, 180, 365]);
export const TRANSCRIPT_RETENTION_DAY_OPTIONS = Object.freeze([365, 180, 90, 60, 30, 14, 7, 1]);

const wholeDays = (value) => {
  const days = Math.trunc(Number(value));
  return Number.isFinite(days) && days > 0 ? days : 0;
};

/** How long a new recording is kept: its own setting, cut to its transcript's when that's shorter. */
export function effectiveRecordingRetentionDays(recordingDays, transcriptDays) {
  const recording = wholeDays(recordingDays);
  const transcript = wholeDays(transcriptDays);
  if (recording === 0) return 0;
  return transcript > 0 ? Math.min(recording, transcript) : recording;
}

/**
 * The age past which main's sweep deletes recording files (0: no sweep). The
 * shorter of the two limits, so a file whose transcript has expired goes too,
 * even with recordings Off (files kept from before stay with their transcripts).
 */
export function recordingSweepDays(recordingDays, transcriptDays) {
  const recording = wholeDays(recordingDays);
  const transcript = wholeDays(transcriptDays);
  if (recording > 0 && transcript > 0) return Math.min(recording, transcript);
  return recording || transcript;
}

/**
 * "Keep recordings for": Off, then the list in order, plus the value in force
 * when it's off the list (an organization's cap); options above the cap are
 * disabled.
 */
export function recordingRetentionChoices(currentDays, capDays = null) {
  const current = wholeDays(currentDays);
  const days = [...RECORDING_RETENTION_DAY_OPTIONS];
  if (current > 0 && !days.includes(current)) days.push(current);
  days.sort((a, b) => a - b);
  return [
    { days: 0, disabled: false },
    ...days.map((value) => ({
      days: value,
      disabled: typeof capDays === "number" && value > capDays,
    })),
  ];
}

/** "Keep transcripts for": Forever, then the list longest first, plus an off-list value in force. */
export function transcriptRetentionChoices(currentDays) {
  const current = wholeDays(currentDays);
  const days = [...TRANSCRIPT_RETENTION_DAY_OPTIONS];
  if (current > 0 && !days.includes(current)) days.push(current);
  days.sort((a, b) => b - a);
  return [0, ...days];
}
