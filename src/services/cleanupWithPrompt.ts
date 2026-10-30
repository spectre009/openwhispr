import ReasoningService from "./ReasoningService";
import type { CleanupPromptInputs, ReasoningConfig } from "./BaseReasoningService";
import { getEffectiveCleanupModel, getSettings, type SettingsState } from "../stores/settingsStore";
import { buildDictationCleanupConfig } from "../helpers/dictationCleanupConfig";
import { selectCleanupDictionary } from "../utils/snippets";
import { resolveCleanupLanguage } from "../utils/chineseScript";
import type { CleanupPromptOverride } from "../config/prompts";

export type { CleanupPromptOverride } from "../config/prompts";
export type { CleanupPromptInputs } from "./BaseReasoningService";

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

/**
 * buildDictationCleanupRequest with its provider pinned. processText picks a
 * dictation's cleanup provider (and a custom endpoint and key) from live
 * settings at dispatch, so a run that sends many requests fixes them here,
 * exactly as processText would resolve them now: a settings change mid-run
 * then can't change where later requests go. The self-hosted server's URL
 * is the exception (pinning it would turn the request into an assistant
 * call), so a run checks it with `cleanupRouteKey` instead.
 */
export function pinDictationCleanupRequest(
  settings: SettingsState = getSettings()
): DictationCleanupRequest {
  const { model, config } = buildDictationCleanupRequest(settings);
  const provider =
    settings.cleanupMode === "openwhispr"
      ? "openwhispr"
      : settings.cleanupMode === "self-hosted"
        ? "lan"
        : settings.cleanupProvider || undefined;
  if (!provider) return { model, config };
  const isCustom = settings.cleanupMode === "providers" && provider === "custom";
  return {
    model,
    config: {
      ...config,
      provider,
      baseUrl: isCustom ? settings.cleanupCloudBaseUrl : undefined,
      customApiKey: isCustom ? settings.cleanupCustomApiKey : undefined,
    },
  };
}

/**
 * What decides where a cleanup request goes, as one comparable value. A run
 * compares it before every request, so a change that pinning can't cover
 * (the self-hosted URL) stops the run instead of sending elsewhere.
 */
export function cleanupRouteKey(settings: SettingsState = getSettings()): string {
  return JSON.stringify([
    settings.cleanupMode,
    settings.cleanupMode === "self-hosted" ? (settings.cleanupRemoteUrl || "").trim() : "",
  ]);
}

/**
 * The dictionary and languages a cleanup prompt is built with, read the way a
 * dictation reads them (cleanup's word set, BaseReasoningService's
 * languages), for a run to freeze.
 */
export function captureCleanupPromptInputs(
  settings: SettingsState = getSettings()
): CleanupPromptInputs {
  return {
    customDictionary: selectCleanupDictionary(settings).words,
    preferredLanguage: resolveCleanupLanguage(settings.preferredLanguage),
    uiLanguage: settings.uiLanguage || "en",
  };
}

export interface RunCleanupOptions {
  agentName: string | null;
  /** A request captured earlier (buildDictationCleanupRequest); built now when omitted. */
  request?: DictationCleanupRequest;
  onDispatch?: ReasoningConfig["onDispatch"];
  /** A prompt test: its text stays out of the request logs. */
  redactLogs?: boolean;
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
  { agentName, request, onDispatch, redactLogs }: RunCleanupOptions
): Promise<string> {
  const cleanupPrompt = captureCleanupPrompt(candidate);
  const { model, config } = request ?? buildDictationCleanupRequest();
  return ReasoningService.processText(text, model, agentName, {
    ...config,
    cleanupPrompt,
    ...(redactLogs ? { redactLogs: true } : {}),
    ...(onDispatch ? { onDispatch } : {}),
  });
}
