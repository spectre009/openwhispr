// A dictation that ends with no text: how it ends (Settings › Dictation ›
// Recognition › "End empty dictations quietly", `quietEmptyDictationSeconds`).
// Pure and dependency-free, so the audio manager, the settings store, main's
// connection outcomes and the tests share one rule.

// The provider answered, but with no text. Classified like silence
// (transcriptionFailureOutcome.js), never as a failure.
export const EMPTY_TRANSCRIPT_CODE = "EMPTY_TRANSCRIPT";

/** A provider's successful answer with no text, keeping its English message for the logs. */
export function emptyTranscriptError(message) {
  return Object.assign(new Error(message), { code: EMPTY_TRANSCRIPT_CODE });
}

// 0 is Off: every empty dictation says "We didn't catch that".
export const QUIET_EMPTY_DICTATION_SECONDS = Object.freeze([0, 2, 3, 5, 10]);
export const DEFAULT_QUIET_EMPTY_DICTATION_SECONDS = 3;

/** A stored value as one of the choices; anything else reads as the default. */
export function normalizeQuietEmptyDictationSeconds(value) {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return QUIET_EMPTY_DICTATION_SECONDS.includes(seconds)
    ? seconds
    : DEFAULT_QUIET_EMPTY_DICTATION_SECONDS;
}

/**
 * "quiet" (no card, nothing saved, the pill's spin-down) when the dictation
 * is known to be shorter than the threshold, else "notice" ("We didn't catch
 * that"). Off and an unknown length are always the notice, since length alone
 * never decides that nothing was said.
 */
export function emptyDictationOutcome({ durationMs, thresholdSeconds }) {
  if (!Number.isFinite(thresholdSeconds) || thresholdSeconds <= 0) return "notice";
  if (!Number.isFinite(durationMs) || durationMs < 0) return "notice";
  return durationMs < thresholdSeconds * 1000 ? "quiet" : "notice";
}
