// Tidy up's "Ask a model" at run time: which configured models can review the
// dictionary (the Cleanup, Chat and Voice Assistant models, each resolved as
// its own requests resolve it, listed only when reachable, one entry per
// provider · model), and the request itself: ReasoningService.processText with
// the review's own system prompt, that scope's provider and settings, logs
// redacted and a complete reply required. GitHub Copilot is offered only for
// the scopes it serves (copilotRequestRefusal): here, cleanup's.

import type { ReasoningConfig } from "./BaseReasoningService";
import type { InferenceScope } from "../config/inferenceScopes";
import { COPILOT_PROVIDER_ID, copilotRequestRefusal } from "../config/copilot";
import {
  getEffectiveCleanupModel,
  selectIsCloudChatAgentMode,
  selectIsCloudCleanupMode,
  selectIsCloudDictationAgentMode,
  selectResolvedLLMConfig,
  type SettingsState,
} from "../stores/settingsStore";
import { resolveDictationAgentInference } from "../helpers/dictationAgentInference";
import { resolveModeProvider, resolveModeReachability } from "../helpers/dictationRouting";
import { getCloudModel, getLocalModel, isProviderValidForMode } from "../models/ModelRegistry";
import { REVIEW_MAX_TOKENS, type ReviewRequest } from "../utils/dictionaryReview";

export type ReviewModelRole = "cleanup" | "chat" | "assistant";

export interface ReviewModelOption {
  /** provider · model (and endpoint): one entry each. */
  id: string;
  /** Which configured models it is, in order. */
  roles: ReviewModelRole[];
  /** The scope its request runs on (its first role's). */
  scope: InferenceScope;
  /** "openwhispr", "local", "self-hosted" or the provider's id. */
  provider: string;
  /** The model id; "" where the service picks it (OpenWhispr Cloud). */
  model: string;
  /** The model's display name, or its id. */
  modelName: string;
  request: { model: string; config: ReasoningConfig };
}

export type ProcessText = (
  text: string,
  model: string,
  agentName: string | null,
  config: ReasoningConfig
) => Promise<string>;

// Loaded on first use, as dictationStyles does.
const defaultProcess: ProcessText = async (text, model, agentName, config) => {
  const { default: ReasoningService } = await import("./ReasoningService");
  return ReasoningService.processText(text, model, agentName, config);
};

function modelName(provider: string, model: string): string {
  if (!model) return "";
  return getCloudModel(model, provider)?.name ?? getLocalModel(model)?.name ?? model;
}

interface Candidate {
  role: ReviewModelRole;
  scope: InferenceScope;
  reachable: boolean;
  /** The provider requests go to (undefined: processText decides, as for a dictation's cleanup). */
  dispatchProvider: string | undefined;
  displayProvider: string;
  model: string;
  endpoint: string;
  config: ReasoningConfig;
}

function cleanupCandidate(settings: SettingsState): Candidate {
  const cleanup = selectResolvedLLMConfig(settings, "dictationCleanup");
  const isCloud = selectIsCloudCleanupMode(settings);
  const mode = cleanup.mode;
  const stored = isProviderValidForMode(cleanup.provider, mode) ? cleanup.provider : undefined;
  const provider = resolveModeProvider({ isCloud, mode, provider: stored });
  const remoteUrl = settings.cleanupRemoteUrl?.trim() || "";
  const isSelfHosted = mode === "self-hosted" && !!remoteUrl;
  const model = getEffectiveCleanupModel(settings) || "";
  return {
    role: "cleanup",
    scope: "dictationCleanup",
    reachable: resolveModeReachability({
      mode,
      provider,
      model: cleanup.model,
      isCloud,
      isSelfHosted,
    }),
    dispatchProvider: provider,
    displayProvider: isCloud
      ? "openwhispr"
      : isSelfHosted
        ? "self-hosted"
        : provider || cleanup.provider || "",
    model,
    endpoint: isSelfHosted
      ? remoteUrl
      : provider === "custom"
        ? settings.cleanupCloudBaseUrl?.trim() || ""
        : "",
    // A dictation's cleanup route: processText picks the provider (and a
    // custom endpoint and key) from these settings, as it does for a dictation.
    config: {
      inferenceScope: "dictationCleanup",
      disableThinking: settings.cleanupDisableThinking,
    },
  };
}

function chatCandidate(settings: SettingsState): Candidate {
  const chat = selectResolvedLLMConfig(settings, "chatIntelligence");
  const isCloud = selectIsCloudChatAgentMode(settings);
  const mode = chat.mode;
  const stored = isProviderValidForMode(chat.provider, mode) ? chat.provider : undefined;
  const provider = resolveModeProvider({ isCloud, mode, provider: stored });
  const remoteUrl = chat.remoteUrl?.trim() || "";
  const isSelfHosted = mode === "self-hosted" && !!remoteUrl;
  const isCustom = mode === "providers" && provider === "custom";
  const model = isCloud ? "" : chat.model?.trim() || "";
  return {
    role: "chat",
    scope: "chatIntelligence",
    reachable: resolveModeReachability({
      mode,
      provider,
      model: chat.model,
      isCloud,
      isSelfHosted,
    }),
    dispatchProvider: provider,
    displayProvider: isCloud ? "openwhispr" : isSelfHosted ? "self-hosted" : provider || "",
    model,
    endpoint: isSelfHosted ? remoteUrl : isCustom ? chat.cloudBaseUrl?.trim() || "" : "",
    config: {
      inferenceScope: "chatIntelligence",
      provider,
      lanUrl: isSelfHosted ? remoteUrl : undefined,
      baseUrl: isCustom ? chat.cloudBaseUrl || undefined : undefined,
      customApiKey: isCustom || isSelfHosted ? chat.customApiKey || undefined : undefined,
      disableThinking: chat.disableThinking,
    },
  };
}

function assistantCandidate(settings: SettingsState): Candidate {
  const isCloud = selectIsCloudDictationAgentMode(settings);
  const agent = resolveDictationAgentInference(settings, { isCloudAgent: isCloud });
  const provider = agent.config.provider;
  return {
    role: "assistant",
    scope: "dictationAgent",
    reachable: agent.reachable,
    dispatchProvider: provider,
    displayProvider: isCloud
      ? "openwhispr"
      : agent.config.lanUrl
        ? "self-hosted"
        : provider || agent.displayProvider || "",
    model: isCloud ? "" : agent.model,
    endpoint: agent.config.lanUrl || agent.config.baseUrl || "",
    config: { ...agent.config },
  };
}

/**
 * The models a review can run on now: the Cleanup, Chat and Voice Assistant
 * models that are reachable, one per provider · model (the first role's scope
 * wins), GitHub Copilot only where it serves the scope. Cleanup's first.
 */
export function reviewModelOptions(settings: SettingsState): ReviewModelOption[] {
  const options: ReviewModelOption[] = [];
  for (const candidate of [
    cleanupCandidate(settings),
    chatCandidate(settings),
    assistantCandidate(settings),
  ]) {
    if (!candidate.reachable) continue;
    if (
      candidate.dispatchProvider === COPILOT_PROVIDER_ID &&
      copilotRequestRefusal({ scope: candidate.scope })
    ) {
      continue;
    }
    const id = [candidate.displayProvider, candidate.model, candidate.endpoint].join("·");
    const existing = options.find((option) => option.id === id);
    if (existing) {
      existing.roles.push(candidate.role);
      continue;
    }
    options.push({
      id,
      roles: [candidate.role],
      scope: candidate.scope,
      provider: candidate.displayProvider,
      model: candidate.model,
      modelName: modelName(
        candidate.dispatchProvider ?? candidate.displayProvider,
        candidate.model
      ),
      request: { model: candidate.model, config: candidate.config },
    });
  }
  return options;
}

export interface RunReviewOptions {
  /** Tags a local request so cancelDictionaryReview can abort it. */
  requestId?: string;
  /** The call that sends it; ReasoningService.processText by default. */
  process?: ProcessText;
}

/**
 * Sends the review: its system prompt and the entries, on the option's scope
 * and provider, logs redacted, a complete reply required, giving way to a
 * dictation on a local model. Resolves the model's reply as text.
 */
export function runDictionaryReview(
  option: ReviewModelOption,
  request: Pick<ReviewRequest, "systemPrompt" | "text">,
  { requestId, process = defaultProcess }: RunReviewOptions = {}
): Promise<string> {
  const config = option.request.config;
  // Direct Gemini owns its sampling defaults, as for a dictation's cleanup.
  const gemini = option.provider === "gemini";
  return process(request.text, option.request.model, null, {
    ...config,
    systemPrompt: request.systemPrompt,
    maxTokens: REVIEW_MAX_TOKENS,
    ...(gemini ? {} : { temperature: 0 }),
    redactLogs: true,
    requireCompleteOutput: true,
    yieldToDictation: true,
    ...(requestId ? { requestId } : {}),
  });
}

/** Frees a local model's slot from a review that was cancelled; other routes finish and are discarded. */
export function cancelDictionaryReview(requestId: string | null | undefined): void {
  if (!requestId || typeof window === "undefined") return;
  try {
    void window.electronAPI?.cancelLocalReasoning?.(requestId)?.catch?.(() => {});
  } catch {
    // Nothing to cancel.
  }
}
