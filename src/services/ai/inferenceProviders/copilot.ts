import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
import logger from "../../../utils/logger";
import { errorFromIpcResult } from "../../../helpers/ipcErrorFields";
import { getLlmRequestTimeoutSeconds } from "../../../helpers/llmRequestTimeout.js";
import { COPILOT_PROVIDER_ID } from "../../../config/copilot";

// GitHub Copilot runs in the main process (copilotRuntime.js), which holds the
// sign-in; the renderer sends text and gets text back. It can't take images,
// so supportsImages stays unset.
export const copilotProvider: InferenceProvider = {
  id: COPILOT_PROVIDER_ID,
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI?.processCopilotReasoning) {
      throw new Error("GitHub Copilot is not available in this environment");
    }

    logger.logReasoning("COPILOT_START", { model, agentName, textLength: text.length });
    const startTime = Date.now();

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName, config.toneStyle);
    const userContent = config.systemPrompt
      ? text
      : (ctx.wrapCleanupTranscript ?? wrapCleanupTranscript)(text);
    // Main owns the deadline (it aborts the runtime's turn), so it gets the
    // same per-scope budget the other providers enforce here.
    const timeoutMs = getLlmRequestTimeoutSeconds({ scope: config.inferenceScope }) * 1000;
    const result = await window.electronAPI.processCopilotReasoning(userContent, model, agentName, {
      ...config,
      systemPrompt,
      timeoutMs,
    });

    const processingTimeMs = Date.now() - startTime;

    if (!result?.success) {
      logger.logReasoning("COPILOT_ERROR", {
        model,
        processingTimeMs,
        error: result?.error,
        code: result?.code,
      });
      throw errorFromIpcResult(result);
    }

    const output = result.text ?? "";
    logger.logReasoning("COPILOT_SUCCESS", {
      model,
      processingTimeMs,
      resultLength: output.length,
    });
    return output;
  },
};
