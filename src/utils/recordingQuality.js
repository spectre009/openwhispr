// How new dictations are recorded (Settings › Storage › Recordings). Pure and
// dependency-free like logText.js, so the renderer's recorders, main's merge of
// recovered segments and the tests share one table. Capture is unchanged
// (stereo, #472): only the encoder's bitrate follows the setting.

export const RECORDING_QUALITIES = Object.freeze(["smaller", "balanced", "original"]);
export const DEFAULT_RECORDING_QUALITY = "original";
export const RECOMMENDED_RECORDING_QUALITY = "smaller";

// What each dictation MediaRecorder is asked for. Original passes no options,
// so Chromium keeps its own default (Opus, about 128 kbps), as before.
const RECORDER_BITS_PER_SECOND = Object.freeze({
  smaller: 32000,
  balanced: 64000,
  original: null,
});

// FFmpeg's bitrate when the segments of a recovered recording (a microphone
// swap, a streaming fallback, a crash) are merged into one file, 16 kHz mono as
// always. Original keeps the 64k that merge has always used.
const MERGE_BITRATE = Object.freeze({ smaller: "32k", balanced: "64k", original: "64k" });

// Size of a minute of recording. Original is measured (945 KB a minute over
// 1,054 recordings); the others follow their bitrate.
export const RECORDING_KB_PER_MINUTE = Object.freeze({
  smaller: 240,
  balanced: 480,
  original: 945,
});

/** A stored value as one of the three qualities; anything else is the default. */
export function normalizeRecordingQuality(value) {
  return RECORDING_QUALITIES.includes(value) ? value : DEFAULT_RECORDING_QUALITY;
}

/** MediaRecorder options for a quality, or null to construct it without any. */
export function recorderOptionsFor(quality) {
  const bitsPerSecond = RECORDER_BITS_PER_SECOND[normalizeRecordingQuality(quality)];
  return bitsPerSecond ? { audioBitsPerSecond: bitsPerSecond } : null;
}

/** FFmpeg's `-b:a` for merging a recording made at this quality. */
export function mergeBitrateFor(quality) {
  return MERGE_BITRATE[normalizeRecordingQuality(quality)];
}

/** Bytes a minute of recording takes at this quality (KB as formatBytes counts them). */
export function recordingBytesPerMinute(quality) {
  return RECORDING_KB_PER_MINUTE[normalizeRecordingQuality(quality)] * 1024;
}

/**
 * Roughly how much `days` of recordings take at `minutesPerDay`: an estimate,
 * 0 when either is unknown or zero.
 */
export function estimateRecordingBytes({ minutesPerDay, days, quality }) {
  if (!(minutesPerDay > 0) || !(days > 0)) return 0;
  return Math.round(minutesPerDay * days * recordingBytesPerMinute(quality));
}
