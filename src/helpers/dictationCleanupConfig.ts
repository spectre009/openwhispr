import { selectResolvedLLMConfig, type SettingsState } from "../stores/settingsStore";

/**
 * The request options of a dictation's cleanup call, shared by the dictation
 * route (ordinary cleanup and the translation chain's cleanup step) and by
 * prompt tests, so a test sends exactly what a dictation would.
 */
export function buildDictationCleanupConfig(settings: SettingsState) {
  const cleanup = selectResolvedLLMConfig(settings, "dictationCleanup");
  // Pin cleanup to 0 where supported; bridges otherwise default to 0.7 (local)
  // or 0.3 (Anthropic/enterprise). Zero does not guarantee determinism.
  // Direct Gemini owns its defaults (3: 1.0, older: 0); check mode to ignore stale providers.
  const temperature = cleanup.mode === "providers" && cleanup.provider === "gemini" ? undefined : 0;
  // A truncated reply must fail rather than replace the dictation with its first part:
  // the cleanup route pastes the raw transcript and the chain translates it, and both
  // raise the cleanup-failed toast (#2091).
  return {
    inferenceScope: "dictationCleanup" as const,
    disableThinking: settings.cleanupDisableThinking,
    temperature,
    requireCompleteOutput: true,
  };
}
