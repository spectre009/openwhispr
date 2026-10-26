// The dictation error card's Retry re-sends the failed recording after any
// failure that kept it, instead of recording again: a timeout or an
// unreachable provider, and auth, quota, configuration and model failures too,
// since the user may have fixed the cause meanwhile (the card's Open Settings
// leaves it up). The re-send uses the settings in force when Retry is pressed;
// a cause still there fails again with the same card. Never for: silence or
// no audio (nothing worth sending), a cancel, a voice-assistant recording, a
// selection edit, or a failure to deliver text already transcribed. Pure, so
// the rule is testable without the audio stack.

import { DICTIONARY_ECHO_CODE } from "../utils/dictionaryEchoFilter.js";

export const NOT_RESENDABLE_ERROR_CODES = Object.freeze([
  // A cancel is the user's choice.
  "TRANSCRIPTION_CANCELLED",
  "REASON_CANCELLED",
  // Silence: the card says no audio; recording again is the fix.
  "NO_SPEECH_DETECTED",
  DICTIONARY_ECHO_CODE,
  // Delivery only: the text was transcribed, the paste didn't land.
  "PASTE_FAILED",
  "ACCESSIBILITY_PERMISSION_REQUIRED",
]);

const NOT_RESENDABLE = new Set(NOT_RESENDABLE_ERROR_CODES);

export const isResendableFailure = (error) =>
  !!error &&
  typeof error === "object" &&
  error.name !== "AbortError" &&
  error.selectionEditFatal !== true &&
  error.message !== "No audio detected" &&
  !NOT_RESENDABLE.has(error.code);

/**
 * What the dictation window keeps of a failed recording for its card's Retry,
 * or null when Retry records again: the failure isn't resendable, local
 * history or recordings are off (nothing is kept), the recording was for the
 * voice assistant, or there is no audio. `rowId` resolves the failed History
 * row's id (null when none was saved).
 */
export function keptRecordingFor({
  error,
  blob,
  metadata = {},
  retention,
  voiceAgentRequested = false,
  translationRequested = false,
  style = null,
  rowId,
}) {
  if (!isResendableFailure(error)) return null;
  if (!retention?.dataRetentionEnabled || !(retention.audioRetentionDays > 0)) return null;
  if (voiceAgentRequested || !blob || !(blob.size > 0)) return null;
  return Object.freeze({
    blob,
    metadata: {
      durationSeconds: metadata.durationSeconds ?? null,
      ...(metadata.analyticsOccurredAt
        ? { analyticsOccurredAt: metadata.analyticsOccurredAt }
        : {}),
      ...(metadata.salvagedRecording ? { salvagedRecording: true } : {}),
      ...(metadata.rawWav ? { rawWav: metadata.rawWav } : {}),
    },
    translationRequested: translationRequested === true,
    style: translationRequested ? null : style,
    rowId: Promise.resolve(rowId).catch(() => null),
  });
}
