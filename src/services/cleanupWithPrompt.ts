import ReasoningService from "./ReasoningService";
import type { ReasoningConfig } from "./BaseReasoningService";
import { getEffectiveCleanupModel, getSettings, type SettingsState } from "../stores/settingsStore";
import { buildDictationCleanupConfig } from "../helpers/dictationCleanupConfig";
import type { CleanupPromptOverride } from "../config/prompts";

export type { CleanupPromptOverride } from "../config/prompts";

/**
 * Fixes which cleanup prompt a run uses at the moment it starts: "inherit"
 * becomes the prompt saved right now (a later switch in any window doesn't
 * change the run), and builtin/text pass through unchanged.
 */
export function captureCleanupPrompt(
  candidate: CleanupPromptOverride,
  savedTemplate: string = getSettings().customPrompts.cleanup
): Exclude<CleanupPromptOverride, { mode: "inherit" }> {
  if (candidate.mode === "builtin") return { mode: "builtin" };
  if (candidate.mode === "text") return { mode: "text", text: candidate.text };
  return savedTemplate ? { mode: "text", text: savedTemplate } : { mode: "builtin" };
}

export interface DictationCleanupRequest {
  /** "" on OpenWhispr Cloud, which picks its own model. */
  model: string;
  config: ReasoningConfig;
}

/** The model and options a dictation's cleanup call would use with these settings. */
export function buildDictationCleanupRequest(
  settings: SettingsState = getSettings()
): DictationCleanupRequest {
  return {
    model: getEffectiveCleanupModel(settings),
    config: buildDictationCleanupConfig(settings),
  };
}

export interface RunCleanupOptions {
  agentName: string | null;
  /** A request captured earlier (buildDictationCleanupRequest); built now when omitted. */
  request?: DictationCleanupRequest;
  onDispatch?: ReasoningConfig["onDispatch"];
}

/**
 * Runs `text` through the real cleanup request with `candidate` as its prompt,
 * without touching saved settings: the same provider, model, substitutions
 * (assistant name, language, dictionary), transcript wrapper, temperature,
 * completeness rule and output validation as a dictation with that prompt
 * saved. The candidate and the request are both captured when the call starts.
 */
export async function runCleanupWithPrompt(
  text: string,
  candidate: CleanupPromptOverride,
  { agentName, request, onDispatch }: RunCleanupOptions
): Promise<string> {
  const cleanupPrompt = captureCleanupPrompt(candidate);
  const { model, config } = request ?? buildDictationCleanupRequest();
  return ReasoningService.processText(text, model, agentName, {
    ...config,
    cleanupPrompt,
    ...(onDispatch ? { onDispatch } : {}),
  });
}
