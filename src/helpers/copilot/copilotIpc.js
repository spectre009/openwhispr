// IPC for the GitHub Copilot provider. The renderer starts and cancels sign-in,
// lists models and sends text-only requests; the token never crosses.
const { ipcErrorFields } = require("../ipcErrorFields");
const { copilotRequestRefusal } = require("../../config/copilot");
const { copilotProviderError } = require("./copilotErrors");

const DEFAULT_DEADLINE_MS = 60000;
const MIN_DEADLINE_MS = 5000;
const MAX_DEADLINE_MS = 10 * 60 * 1000;
const EMPTY_REPLY_MESSAGE_KEY = "hooks.audioRecording.errorDescriptions.cleanupEmptyReply";

function deadlineFrom(config) {
  const requested = Number(config?.timeoutMs);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_DEADLINE_MS;
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, requested));
}

function createCopilotReasoningHandler({ runtime, auth, logger = null }) {
  const log = (level, message, meta) => logger?.[level]?.(message, meta, "copilot");

  return async function processCopilotReasoning(_event, text, model, _agentName, config) {
    const startedAt = Date.now();
    try {
      const refusal = copilotRequestRefusal({
        scope: config?.inferenceScope,
        requiresAgent: config?.requiresAgent === true,
        hasImage: !!config?.screenContext,
      });
      if (refusal) {
        throw Object.assign(new Error(`GitHub Copilot can't serve this request (${refusal})`), {
          code: "COPILOT_SCOPE_REFUSED",
          reason: refusal,
        });
      }
      const result = await runtime.complete({
        model,
        system: typeof config?.systemPrompt === "string" ? config.systemPrompt : "",
        user: typeof text === "string" ? text : "",
        disableThinking: config?.disableThinking === true,
        maxTokens: Number.isFinite(config?.maxTokens) ? config.maxTokens : undefined,
        requireCompleteOutput: config?.requireCompleteOutput === true,
        deadlineMs: deadlineFrom(config),
      });
      if (!result.text.trim()) {
        throw Object.assign(new Error("GitHub Copilot returned an empty reply"), {
          messageKey: EMPTY_REPLY_MESSAGE_KEY,
        });
      }
      log("debug", "Copilot request finished", {
        model,
        scope: config?.inferenceScope,
        effort: result.reasoningEffort,
        finishReason: result.finishReason,
        ms: Date.now() - startedAt,
      });
      return { success: true, text: result.text };
    } catch (error) {
      const classified = error?.messageKey ? error : copilotProviderError(error, { model });
      if (classified?.code === "PROVIDER_AUTH_FAILED") auth.reportTokenRejected();
      log("warn", "Copilot request failed", {
        model,
        scope: config?.inferenceScope,
        code: classified?.code,
        source: error?.code,
        errorType: error?.errorType,
        statusCode: error?.statusCode,
        ms: Date.now() - startedAt,
      });
      return { success: false, ...ipcErrorFields(classified) };
    }
  };
}

function registerCopilotIpc({ ipcMain, copilot, logger = null }) {
  const { runtime, auth } = copilot;

  ipcMain.handle("copilot-auth-status", () => auth.getStatus());
  ipcMain.handle("copilot-auth-start", () => auth.start());
  ipcMain.handle("copilot-auth-cancel", (_event, flowId) => auth.cancel(flowId));
  ipcMain.handle("copilot-auth-retry", (_event, flowId) => auth.retry(flowId));
  ipcMain.handle("copilot-sign-out", () => auth.signOut());

  ipcMain.handle("copilot-list-models", async (_event, options) => {
    try {
      const models = await runtime.listModels({ refresh: options?.refresh === true });
      return { success: true, models };
    } catch (error) {
      const classified = copilotProviderError(error);
      if (classified?.code === "PROVIDER_AUTH_FAILED") auth.reportTokenRejected();
      return { success: false, ...ipcErrorFields(classified) };
    }
  });

  ipcMain.handle(
    "process-copilot-reasoning",
    createCopilotReasoningHandler({ runtime, auth, logger })
  );
}

module.exports = { registerCopilotIpc, createCopilotReasoningHandler, deadlineFrom };
