// Turns a copilotRuntime failure into the classified provider error every
// language-model surface already shows (providerHttpErrors.js), so a Copilot
// failure reads like any other provider's, in Copilot's own words where a
// sign-in differs from an API key.
const {
  PROVIDER_ERROR_CODES: C,
  providerError,
  providerHttpError,
} = require("../providerHttpErrors");

const PROVIDER = "GitHub Copilot";
const PROVIDER_ID = "copilot";
const TRUNCATED_MESSAGE_KEY = "hooks.audioRecording.errorDescriptions.cleanupTruncated";

// The runtime's session.error categories (errorType).
const CODE_BY_ERROR_TYPE = {
  authentication: C.AUTH_FAILED,
  authorization: C.ACCESS_DENIED,
  policy: C.ACCESS_DENIED,
  quota: C.QUOTA_EXHAUSTED,
  rate_limit: C.RATE_LIMITED,
  context_limit: C.PAYLOAD_TOO_LARGE,
};

function ctx(model, technicalDetails) {
  return {
    provider: PROVIDER,
    providerId: PROVIDER_ID,
    surface: "llm",
    ...(model ? { model } : {}),
    ...(technicalDetails ? { technicalDetails } : {}),
  };
}

function copilotProviderError(error, { model } = {}) {
  switch (error?.code) {
    case "COPILOT_NOT_SIGNED_IN":
      return providerError(C.KEY_MISSING, ctx(model));
    case "COPILOT_TIMEOUT":
      return providerError(C.TIMEOUT, ctx(model));
    case "COPILOT_MODEL_UNAVAILABLE":
      return providerError(C.MODEL_NOT_FOUND, ctx(model));
    case "COPILOT_RUNTIME_FAILED":
      return providerError(C.UNAVAILABLE, ctx(model, { underlyingError: "runtime_failed" }));
    case "COPILOT_TRUNCATED":
      return Object.assign(new Error("GitHub Copilot's reply was cut off"), {
        code: "COPILOT_TRUNCATED",
        messageKey: TRUNCATED_MESSAGE_KEY,
      });
    case "COPILOT_SCOPE_REFUSED":
      return providerError(C.BAD_REQUEST, ctx(model, { underlyingError: error.reason }));
    case "COPILOT_SDK_ERROR": {
      const type = String(error.errorType || "").toLowerCase();
      const technicalDetails = {
        ...(error.errorType ? { errorType: error.errorType } : {}),
        ...(error.errorCode ? { errorCode: error.errorCode } : {}),
      };
      if (CODE_BY_ERROR_TYPE[type]) {
        return providerError(CODE_BY_ERROR_TYPE[type], ctx(model, technicalDetails));
      }
      if (typeof error.statusCode === "number") {
        return providerHttpError({
          ...ctx(model),
          status: error.statusCode,
          body: error.message,
        });
      }
      if (error.connectionLost) {
        return providerError(C.UNAVAILABLE, ctx(model, { underlyingError: "runtime_stopped" }));
      }
      return providerError(C.ERROR, ctx(model, technicalDetails));
    }
    default:
      return providerError(C.ERROR, ctx(model));
  }
}

module.exports = { copilotProviderError, COPILOT_PROVIDER_LABEL: PROVIDER };
