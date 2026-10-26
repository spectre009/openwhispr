// Why a dictation step failed, as step history keeps it. ESM like
// providerHttpErrors.js: the renderer's post-speech-to-text boundary builds a
// failed step's descriptor here, and main re-validates it with the same
// allowlist (stepHistory.js, via require(esm)) before the step is stored.
//
// A descriptor carries no provider text and no dictated text, only:
// - code: the error's own code when it is a plain identifier, else "unknown";
// - messageKey: one of the locale keys the error card already renders;
// - messageParams: `provider` and `model` only, short strings;
// - settingsTarget: a section isProviderSettingsTarget accepts.
// Anything else on the error (its message, the provider's body, technical
// details, other params) is dropped. Pure, so both sides apply one rule.

import { PROVIDER_ERROR_MESSAGE_KEYS, isProviderSettingsTarget } from "./providerHttpErrors.js";

export const UNKNOWN_FAILURE_CODE = "unknown";

const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PARAM_NAMES = Object.freeze(["provider", "model"]);
const MAX_PARAM_CHARS = 100;

// Keys a failed model step can carry besides the provider errors': rejected
// or empty replies, the local model's own (localInferenceError.ts), Cloud's
// sign-in and the enterprise sentences that take no parameter (the ones
// naming a region, a token count or quoting the error are left out).
const STEP_MESSAGE_KEYS = Object.freeze([
  "hooks.audioRecording.errorDescriptions.cleanupTruncated",
  "hooks.audioRecording.errorDescriptions.cleanupDuplicated",
  "hooks.audioRecording.errorDescriptions.cleanupEmptyReply",
  "hooks.audioRecording.errorDescriptions.sessionExpired",
  "hooks.audioRecording.errorDescriptions.offline",
  "models.errors.localServerUnavailable",
  "models.errors.localModelBusy",
  "models.errors.contextTooLargeGeneric",
  "reasoning.enterprise.errors.bedrock.temporaryAccessExpired",
  "reasoning.enterprise.errors.bedrock.ssoExpired",
  "reasoning.enterprise.errors.bedrock.credentialsRejected",
  "reasoning.enterprise.errors.bedrock.notConfigured",
  "reasoning.enterprise.errors.bedrock.serviceUnavailable",
  "reasoning.enterprise.errors.bedrock.throttled",
  "reasoning.enterprise.errors.bedrock.timeout",
  "reasoning.enterprise.errors.bedrock.network",
]);

/** Every message key a stored failure may name. */
export const FAILURE_MESSAGE_KEYS = Object.freeze([
  ...PROVIDER_ERROR_MESSAGE_KEYS,
  ...STEP_MESSAGE_KEYS,
]);
const ALLOWED_MESSAGE_KEYS = new Set(FAILURE_MESSAGE_KEYS);

// The steps whose failure a History row flags ("Cleanup failed", "Style not
// applied", "Translation failed") and the Failed filter lists: one that threw,
// or one whose blank reply was ignored. A skipped translation, or one that
// changed nothing, is not a failure. database.js applies the same rule in SQL.
export const STEP_FAILURE_KINDS = Object.freeze(["cleanup", "style", "translation"]);
export const STEP_FAILURE_OUTCOMES = Object.freeze(["failed", "fallback"]);

// Re-run cleanup carries the stored speech-to-text step over: "stored" when it
// came from the dictation's own step, "unknown" when the dictation had none.
export const STT_REUSED_VALUES = Object.freeze(["stored", "unknown"]);

function safeCode(value) {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : null;
}

function safeParam(value) {
  if (typeof value !== "string") return null;
  const text = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  })
    .join("")
    .trim();
  return text ? text.slice(0, MAX_PARAM_CHARS) : null;
}

/**
 * The allowlisted descriptor of a failure: from an error the renderer caught,
 * or a stored descriptor being re-validated. Always has a `code`.
 *
 * @param {unknown} source
 * @returns {{ code: string, messageKey?: string,
 *   messageParams?: { provider?: string, model?: string },
 *   settingsTarget?: "speechToText" | "llms" }}
 */
export function failureDescriptor(source) {
  const input = source && typeof source === "object" ? source : {};
  const descriptor = { code: safeCode(input.code) ?? UNKNOWN_FAILURE_CODE };
  if (typeof input.messageKey === "string" && ALLOWED_MESSAGE_KEYS.has(input.messageKey)) {
    descriptor.messageKey = input.messageKey;
    const given =
      input.messageParams && typeof input.messageParams === "object" ? input.messageParams : {};
    const params = {};
    for (const name of PARAM_NAMES) {
      const value = safeParam(given[name]);
      if (value) params[name] = value;
    }
    if (Object.keys(params).length > 0) descriptor.messageParams = params;
  }
  if (isProviderSettingsTarget(input.settingsTarget)) {
    descriptor.settingsTarget = input.settingsTarget;
  }
  return descriptor;
}

/** A stored or received descriptor, re-validated; null when there is none. */
export function normalizeFailureDescriptor(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? failureDescriptor(value)
    : null;
}

/** The allowlisted reused marker of a carried-over speech-to-text step, or null. */
export function normalizeReusedMarker(value) {
  return STT_REUSED_VALUES.includes(value) ? value : null;
}

/** Whether a step's failure is one a History row flags. */
export function isFlaggedStepFailure(step) {
  return (
    !!step && STEP_FAILURE_KINDS.includes(step.kind) && STEP_FAILURE_OUTCOMES.includes(step.outcome)
  );
}

/** The kind of the first flagged failure among a dictation's steps, or null. */
export function failedStepKind(steps) {
  if (!Array.isArray(steps)) return null;
  const step = steps.find(isFlaggedStepFailure);
  return step ? step.kind : null;
}
