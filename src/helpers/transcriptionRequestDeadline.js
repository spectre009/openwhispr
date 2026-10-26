// The client deadline of one batch transcription request (OpenAI, Groq, a
// custom endpoint or a self-hosted server). Pure ESM shared by main
// (require(esm)) and the tests, like providerHttpErrors.js.
//
// A deadline covers the whole exchange, from sending to the last byte of the
// answer: a processing budget sized from real dictation latencies (p99 5.2 s,
// slowest 8.2 s for a 203 s clip), plus the time the upload itself takes on a
// slow uplink, so a slow connection is never mistaken for a dead one.

import { isPrivateHost } from "../config/customConnection.js";

export const TRANSCRIPTION_REQUEST_TIMEOUT_CODE = "TRANSCRIPTION_REQUEST_TIMEOUT";

// Per attempt, hosted endpoints: [first attempt, retry].
const HOSTED_BASE_MS = [10_000, 15_000];
const HOSTED_PER_AUDIO_SECOND_MS = [500, 1_000];
// Local and self-hosted servers can run slower than real time on a CPU.
const LOCAL_BASE_MS = 60_000;
const LOCAL_PER_AUDIO_SECOND_MS = 3_000;
// The upload allowance: the bytes actually sent at 512 kbit/s.
export const UPLOAD_BYTES_PER_SECOND = 64_000;
// Without a known length the recording is read as low-bitrate speech (16
// kbit/s Opus), which overestimates it: a longer deadline, never a false one.
const UNKNOWN_DURATION_BYTES_PER_AUDIO_SECOND = 2_000;
export const TRANSCRIPTION_REQUEST_CEILING_MS = 15 * 60 * 1000;
// A streamed answer that stops sending for this long has stalled.
export const TRANSCRIPTION_STREAM_IDLE_MS = 15_000;

/**
 * Whether a transcription endpoint gets the local budget: the self-hosted
 * route, or a host on this machine or the local network (localhost, private
 * and link-local addresses, `.local`, Tailscale).
 * @param {string} endpoint
 * @param {{ selfHosted?: boolean }} [options]
 */
export function isLocalTranscriptionEndpoint(endpoint, { selfHosted = false } = {}) {
  if (selfHosted) return true;
  try {
    return isPrivateHost(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/**
 * Milliseconds one attempt may take.
 * @param {{ bytesSent: number, audioSeconds?: number | null, local?: boolean, attempt?: number }} request
 *   `attempt` is 1 for the first request and 2 for the retry.
 */
export function transcriptionRequestDeadlineMs({
  bytesSent,
  audioSeconds = null,
  local = false,
  attempt = 1,
}) {
  const bytes = Number.isFinite(bytesSent) && bytesSent > 0 ? bytesSent : 0;
  const seconds =
    Number.isFinite(audioSeconds) && audioSeconds > 0
      ? audioSeconds
      : bytes / UNKNOWN_DURATION_BYTES_PER_AUDIO_SECOND;
  const uploadMs = (bytes / UPLOAD_BYTES_PER_SECOND) * 1000;
  const retry = attempt > 1 ? 1 : 0;
  const processingMs = local
    ? LOCAL_BASE_MS + seconds * LOCAL_PER_AUDIO_SECOND_MS
    : HOSTED_BASE_MS[retry] + seconds * HOSTED_PER_AUDIO_SECOND_MS[retry];
  return Math.min(TRANSCRIPTION_REQUEST_CEILING_MS, Math.ceil(processingMs + uploadMs));
}

/** The marker a request raises when its client deadline expires; classified as PROVIDER_TIMEOUT. */
export function transcriptionRequestTimeoutError({ attempt, deadlineMs } = {}) {
  return Object.assign(
    new Error(`Transcription request timed out after ${Math.round((deadlineMs || 0) / 1000)}s`),
    { code: TRANSCRIPTION_REQUEST_TIMEOUT_CODE, attempt, deadlineMs }
  );
}
