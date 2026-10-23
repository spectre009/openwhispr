// Dictation comes first on the local model. llama-server serves one request
// at a time (localReasoningBridge refuses a second with LOCAL_MODEL_BUSY), so
// a background request that agreed to give way (`yieldToDictation`, the
// test set's runs) must never hold the model when a dictation needs it:
// - it never starts while a dictation is prepared, recorded or processed;
// - a dictation that starts aborts it by its request id, which frees the slot.
// Either way its caller gets YIELDED_TO_DICTATION and sends it again later.
// Other requests (a dictation's own cleanup, notes) are passed through as is.

const YIELDED_CODE = "YIELDED_TO_DICTATION";

function yieldedResult() {
  return { success: false, error: "Gave way to a dictation", code: YIELDED_CODE };
}

/**
 * - getBridge(): localReasoningBridge (processText, cancel), loaded on first use
 * - isDictationActive(): main's dictation lifecycle (windowManager)
 * - newRequestId(): an id for a yielding request that came without one
 */
function createLocalRequestYield({ getBridge, isDictationActive, newRequestId }) {
  const inFlight = new Set();

  return {
    /** process-local-reasoning: the IPC result for one request. */
    async run(text, modelId, config) {
      let yielding = null;
      try {
        const bridge = getBridge();
        let requestConfig = config;
        if (config?.yieldToDictation === true) {
          if (isDictationActive()) return yieldedResult();
          const requestId =
            typeof config.requestId === "string" && config.requestId
              ? config.requestId
              : newRequestId();
          requestConfig = { ...config, requestId };
          yielding = { requestId, yielded: false };
          inFlight.add(yielding);
        }
        const result = await bridge.processText(text, modelId, requestConfig);
        return { success: true, text: result };
      } catch (error) {
        if (yielding?.yielded) return yieldedResult();
        // code/details carry the machine-readable failure across to the
        // renderer, which owns the translation keys. Flattening to a bare
        // string is how llama.cpp JSON used to reach users (#2142).
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      } finally {
        if (yielding) inFlight.delete(yielding);
      }
    },

    /** A dictation started: abort every yielding request in flight. Returns how many. */
    yieldAll() {
      if (inFlight.size === 0) return 0;
      const bridge = getBridge();
      let aborted = 0;
      for (const request of inFlight) {
        if (request.yielded) continue;
        request.yielded = true;
        bridge.cancel(request.requestId);
        aborted += 1;
      }
      return aborted;
    },

    get inFlightCount() {
      return inFlight.size;
    },
  };
}

module.exports = { YIELDED_CODE, createLocalRequestYield };
