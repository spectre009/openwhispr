// The dictation error card's Retry re-sends the failed recording when a second
// try can fix the failure (our deadline or a provider timeout, an unreachable
// provider, a 5xx, a rate limit), instead of recording again. Auth, quota and
// configuration failures keep the record-again Retry and their settings link.
// Pure, so the rule is testable without the audio stack.

import { PROVIDER_ERROR_CODES } from "./providerHttpErrors.js";
import { TRANSCRIPTION_REQUEST_TIMEOUT_CODE } from "./transcriptionRequestDeadline.js";

export const RESENDABLE_ERROR_CODES = Object.freeze([
  PROVIDER_ERROR_CODES.TIMEOUT,
  PROVIDER_ERROR_CODES.UNREACHABLE,
  PROVIDER_ERROR_CODES.UNAVAILABLE,
  PROVIDER_ERROR_CODES.RATE_LIMITED,
  TRANSCRIPTION_REQUEST_TIMEOUT_CODE,
]);

const RESENDABLE = new Set(RESENDABLE_ERROR_CODES);

export const isResendableFailure = (error) => RESENDABLE.has(error?.code);

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
