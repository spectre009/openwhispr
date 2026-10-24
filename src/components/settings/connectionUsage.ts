import {
  selectIsCloudDictationAgentMode,
  selectPolicyEffectiveSettings,
  selectResolvedLLMConfig,
  selectResolvedMeetingTranscription,
  selectResolvedUploadTranscription,
  type ResolvedLLMConfig,
  type SettingsState,
} from "../../stores/settingsStore";
import {
  isAgentAllowed,
  isModeAllowedByPolicy,
  isScreenContextAllowed,
  type PolicyDecisionSnapshot,
} from "../../stores/policyRules";
import { getManagedScopeResolution } from "../../stores/enterpriseIdentityStore";
import {
  resolveChatStreamingInference,
  resolveDictationAgentInference,
  resolveDictationAgentVisionInference,
} from "../../helpers/dictationAgentInference.js";
import { COPILOT_PROVIDER_ID, isCopilotScopeSupported } from "../../config/copilot";
import type { InferenceScope } from "../../config/inferenceScopes";
import type { InferenceMode } from "../../types/electron";
import type { ManagedEnterpriseScopeResolution } from "../../types/enterpriseIdentity";
import { noteFormattingInheritsCleanup } from "./featurePageStatus";
import type { SettingsPageId } from "./settingsPages";

/**
 * "Used by" on Settings › AI Connections & Local Models: which feature runs on
 * which connection right now, from the same resolvers the requests use
 * (policy-effective settings, selectResolvedLLMConfig with its fallback scopes
 * and managed enterprise overrides, the voice assistant's route and its Chat
 * fallback, the vision override, the speech-to-text contexts). Each use is
 * labelled so the page never implies a credential is safe to remove when it
 * isn't: configured (the feature's own pick), inherited (borrowed from
 * another feature's settings), fallback (another feature's route answers
 * while this one's can't) or off (the feature is switched off or can't run).
 *
 * Pure: the result carries ids, model ids and endpoint hosts only, never a
 * key, token or full URL.
 */

export type UsageFeature =
  | "cleanup"
  | "styles"
  | "assistant"
  | "assistantVision"
  | "translation"
  | "noteFormatting"
  | "chat"
  | "recognition"
  | "liveRecording"
  | "fileTranscription";

export type UsageKind = "configured" | "inherited" | "fallback" | "off";

export type UsageOffReason =
  /** The feature's switch is off. */
  | "disabled"
  /** The organization's policy turns it off. */
  | "policy"
  /** OpenWhispr Cloud is turned off in Privacy & Data. */
  | "cloudOff"
  /** OpenWhispr Cloud needs a sign-in. */
  | "signedOut"
  /** GitHub Copilot can't serve this feature (chat, the assistant). */
  | "unsupported"
  /** The organization's managed setup can't be loaded, so the feature fails closed. */
  | "managedUnavailable";

/** A local model's engine: GGUF language models, whisper.cpp, or sherpa-onnx (Parakeet, Cohere). */
export type LocalModelEngine = "llm" | "whisper" | "sherpa";

export type ConnectionRef =
  /** A shared API-key provider (one key for every feature). */
  | { type: "provider"; provider: string }
  | { type: "copilot" }
  | { type: "cloud" }
  | { type: "local"; engine: LocalModelEngine; model: string }
  /**
   * An OpenAI-compatible endpoint picked as the "Custom" provider: language
   * models keep a URL and key per feature, speech-to-text one key for all.
   */
  | { type: "custom"; host: string; model: string; secret: "feature" | "speechToText" }
  /** A server on the user's network (self-hosted mode), set per feature. */
  | { type: "selfHosted"; host: string; model: string }
  | { type: "enterprise"; provider: string; managed: boolean; model: string };

export interface FeatureUsage {
  feature: UsageFeature;
  kind: UsageKind;
  connection: ConnectionRef;
  /** Inherited: whose settings it borrows. Fallback: whose route answers. */
  from?: UsageFeature;
  offReason?: UsageOffReason;
  /** Where the feature picks its model: `<page>#<settingId>`. */
  edit: string;
}

/** The page each feature's name and model setting live on. */
export const USAGE_FEATURE_PAGES: Readonly<Record<UsageFeature, SettingsPageId>> = {
  cleanup: "cleanup",
  styles: "styles",
  assistant: "assistant",
  assistantVision: "assistant",
  translation: "translation",
  noteFormatting: "noteFormatting",
  chat: "chat",
  recognition: "recognition",
  liveRecording: "liveRecording",
  fileTranscription: "fileTranscription",
};

/** Where each feature's model is picked ("Edit in <feature>"). Styles run on Cleanup's model. */
export const USAGE_EDIT_DESTINATIONS: Readonly<Record<UsageFeature, string>> = {
  cleanup: "cleanup#dictation.cleanup.model",
  styles: "cleanup#dictation.cleanup.model",
  assistant: "assistant#assistant.model",
  assistantVision: "assistant#assistant.visionOverride",
  translation: "translation#translation.model",
  noteFormatting: "noteFormatting#notes.formatting.model",
  chat: "chat#chat.model",
  recognition: "recognition#dictation.stt.engine",
  liveRecording: "liveRecording#notes.recording.engine",
  fileTranscription: "fileTranscription#notes.upload.engine",
};

const FEATURE_ORDER: readonly UsageFeature[] = [
  "recognition",
  "cleanup",
  "styles",
  "assistant",
  "assistantVision",
  "translation",
  "chat",
  "liveRecording",
  "fileTranscription",
  "noteFormatting",
];

export interface ConnectionUsageInput {
  /** The raw store state; policy is applied here, as the editors apply it. */
  settings: SettingsState;
  policy: PolicyDecisionSnapshot;
  /** The "OpenWhispr account & Cloud" switch is off. */
  cloudDisabled: boolean;
  /** At least one style can be picked (Styles run on Cleanup's model, even with Cleanup off). */
  stylesInUse: boolean;
}

/**
 * The host of an endpoint URL (`host:port`), never its path, query or
 * credentials; empty when it isn't a URL. Bare `host:port` values are read as http.
 */
export function endpointHost(url: string | undefined | null): string {
  const raw = url?.trim();
  if (!raw) return "";
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return parsed.host;
  } catch {
    return "";
  }
}

/** One key per connection, for grouping ("provider:openai", "local:llm:qwen3-4b", …). */
export function connectionKey(connection: ConnectionRef): string {
  switch (connection.type) {
    case "provider":
      return `provider:${connection.provider}`;
    case "local":
      return `local:${connection.engine}:${connection.model}`;
    case "custom":
      return `custom:${connection.secret}:${connection.host}`;
    case "selfHosted":
      return `selfHosted:${connection.host}`;
    case "enterprise":
      return `enterprise:${connection.provider}`;
    default:
      return connection.type;
  }
}

/** True for uses that would break if the connection went away (anything but off). */
export function isActiveUsage(usage: FeatureUsage): boolean {
  return usage.kind !== "off";
}

type Routed = { connection: ConnectionRef; offReason?: UsageOffReason };

function cloudReason(effective: SettingsState, cloudDisabled: boolean): UsageOffReason | undefined {
  if (cloudDisabled) return "cloudOff";
  return effective.isSignedIn ? undefined : "signedOut";
}

/** What an LLM scope's resolved config connects to. Null: nothing picked yet. */
function llmRoute(
  scope: InferenceScope,
  config: Pick<ResolvedLLMConfig, "mode" | "provider" | "model" | "cloudBaseUrl" | "remoteUrl">,
  effective: SettingsState,
  cloudDisabled: boolean
): Routed | null {
  const model = config.model?.trim() ?? "";
  switch (config.mode) {
    case "openwhispr":
      return { connection: { type: "cloud" }, offReason: cloudReason(effective, cloudDisabled) };
    case "local":
      return model ? { connection: { type: "local", engine: "llm", model } } : null;
    case "self-hosted":
      return { connection: { type: "selfHosted", host: endpointHost(config.remoteUrl), model } };
    case "enterprise": {
      const managed = getManagedScopeResolution(scope, effective.enterpriseSetupMode);
      if (managed.kind === "error") {
        return {
          connection: { type: "enterprise", provider: "", managed: true, model: "" },
          offReason: "managedUnavailable",
        };
      }
      const provider = config.provider?.trim();
      if (!provider) return null;
      return {
        connection: { type: "enterprise", provider, managed: managed.kind === "managed", model },
      };
    }
    default: {
      const provider = config.provider?.trim();
      if (!provider) return null;
      if (provider === "custom") {
        return {
          connection: {
            type: "custom",
            host: endpointHost(config.cloudBaseUrl),
            model,
            secret: "feature",
          },
        };
      }
      if (provider === COPILOT_PROVIDER_ID) {
        return {
          connection: { type: "copilot" },
          offReason: isCopilotScopeSupported(scope) ? undefined : "unsupported",
        };
      }
      return { connection: { type: "provider", provider } };
    }
  }
}

interface TranscriptionChoice {
  mode: InferenceMode;
  provider: string;
  model: string;
  baseUrl: string;
  localProvider: string;
  localModel: string;
  remoteUrl: string;
  remoteModel: string;
}

function localTranscriptionModel(
  provider: string,
  models: { whisper: string; parakeet: string; cohere: string }
): string {
  if (provider === "nvidia") return models.parakeet;
  if (provider === "cohere") return models.cohere;
  return models.whisper;
}

/**
 * Whether a live-recording or upload pick borrows dictation's value: an unset
 * provider, custom base URL or local model falls back to Recognition's
 * (selectResolvedMeetingTranscription, selectResolvedUploadTranscription).
 */
function transcriptionInherits(
  choice: Pick<TranscriptionChoice, "mode" | "provider">,
  own: { provider: string; baseUrl: string; localModel: string },
  dictationProvider: string
): boolean {
  if (choice.mode === "providers") {
    if (!own.provider?.trim()) return choice.provider === dictationProvider;
    return choice.provider === "custom" && !own.baseUrl?.trim();
  }
  if (choice.mode === "local") return !own.localModel?.trim();
  return false;
}

/** What a speech-to-text context connects to. Managed enterprise STT outranks every personal lane. */
function transcriptionRoute(
  choice: TranscriptionChoice,
  managed: ManagedEnterpriseScopeResolution | null,
  effective: SettingsState,
  cloudDisabled: boolean
): Routed | null {
  if (managed?.kind === "managed") {
    return {
      connection: {
        type: "enterprise",
        provider: managed.provider,
        managed: true,
        model: managed.model,
      },
    };
  }
  if (managed?.kind === "error") {
    return {
      connection: { type: "enterprise", provider: "", managed: true, model: "" },
      offReason: "managedUnavailable",
    };
  }
  switch (choice.mode) {
    case "openwhispr":
      return { connection: { type: "cloud" }, offReason: cloudReason(effective, cloudDisabled) };
    case "local": {
      const model = choice.localModel?.trim();
      if (!model) return null;
      const engine: LocalModelEngine = choice.localProvider === "whisper" ? "whisper" : "sherpa";
      return { connection: { type: "local", engine, model } };
    }
    case "self-hosted":
      return {
        connection: {
          type: "selfHosted",
          host: endpointHost(choice.remoteUrl),
          model: choice.remoteModel?.trim() ?? "",
        },
      };
    case "enterprise":
      // Enterprise speech-to-text only runs through a managed deployment.
      return {
        connection: { type: "enterprise", provider: "", managed: true, model: "" },
        offReason: "managedUnavailable",
      };
    default: {
      const provider = choice.provider?.trim();
      if (!provider) return null;
      if (provider === "custom") {
        return {
          connection: {
            type: "custom",
            host: endpointHost(choice.baseUrl),
            model: choice.model?.trim() ?? "",
            secret: "speechToText",
          },
        };
      }
      return { connection: { type: "provider", provider } };
    }
  }
}

/** Every feature's current use of a connection, in nav order. */
export function computeConnectionUsage(input: ConnectionUsageInput): FeatureUsage[] {
  const { policy, cloudDisabled, stylesInUse } = input;
  const effective = selectPolicyEffectiveSettings(input.settings, policy);
  const agentAllowed = isAgentAllowed(policy);
  const usages: FeatureUsage[] = [];

  const add = (
    feature: UsageFeature,
    routed: Routed | null,
    {
      kind = "configured",
      from,
      off,
    }: { kind?: UsageKind; from?: UsageFeature; off?: UsageOffReason } = {}
  ) => {
    if (!routed) return;
    const offReason = off ?? routed.offReason;
    usages.push({
      feature,
      kind: offReason ? "off" : kind,
      connection: routed.connection,
      ...(from ? { from } : {}),
      ...(offReason ? { offReason } : {}),
      edit: USAGE_EDIT_DESTINATIONS[feature],
    });
  };
  const llm = (scope: InferenceScope) => selectResolvedLLMConfig(effective, scope);
  const route = (scope: InferenceScope, config: ResolvedLLMConfig = llm(scope)) =>
    llmRoute(scope, config, effective, cloudDisabled);

  // ── Speech-to-text ─────────────────────────────────────────────────────────
  const managedTranscription = getManagedScopeResolution(
    "transcription",
    effective.enterpriseTranscriptionSetupMode
  );
  add(
    "recognition",
    transcriptionRoute(
      {
        mode: effective.transcriptionMode,
        provider: effective.cloudTranscriptionProvider,
        model: effective.cloudTranscriptionModel,
        baseUrl: effective.cloudTranscriptionBaseUrl,
        localProvider: effective.localTranscriptionProvider,
        localModel: localTranscriptionModel(effective.localTranscriptionProvider, {
          whisper: effective.whisperModel,
          parakeet: effective.parakeetModel,
          cohere: effective.cohereModel,
        }),
        remoteUrl: effective.remoteTranscriptionUrl,
        remoteModel: effective.remoteTranscriptionModel,
      },
      managedTranscription,
      effective,
      cloudDisabled
    )
  );
  const inheritsRecognition = (inherits: boolean, routed: Routed | null) =>
    inherits && routed?.connection.type !== "enterprise"
      ? ({ kind: "inherited", from: "recognition" } as const)
      : {};

  // Live recording streams through its own lanes; managed STT doesn't apply there.
  const meeting = selectResolvedMeetingTranscription(effective);
  const meetingChoice: TranscriptionChoice = {
    mode: meeting.transcriptionMode,
    provider: meeting.cloudTranscriptionProvider,
    model: meeting.cloudTranscriptionModel,
    baseUrl: meeting.cloudTranscriptionBaseUrl,
    localProvider: meeting.localTranscriptionProvider,
    localModel: localTranscriptionModel(meeting.localTranscriptionProvider, {
      whisper: meeting.whisperModel,
      parakeet: meeting.parakeetModel,
      cohere: meeting.cohereModel,
    }),
    remoteUrl: meeting.remoteTranscriptionUrl,
    remoteModel: "",
  };
  const meetingRoute = transcriptionRoute(meetingChoice, null, effective, cloudDisabled);
  add(
    "liveRecording",
    meetingRoute,
    inheritsRecognition(
      transcriptionInherits(
        meetingChoice,
        {
          provider: effective.meetingCloudTranscriptionProvider,
          baseUrl: effective.meetingCloudTranscriptionBaseUrl,
          localModel: localTranscriptionModel(meeting.localTranscriptionProvider, {
            whisper: effective.meetingWhisperModel,
            parakeet: effective.meetingParakeetModel,
            cohere: effective.meetingCohereModel,
          }),
        },
        effective.cloudTranscriptionProvider
      ),
      meetingRoute
    )
  );
  const upload = selectResolvedUploadTranscription(effective);
  const uploadChoice: TranscriptionChoice = {
    mode: upload.transcriptionMode,
    provider: upload.cloudTranscriptionProvider,
    model: upload.cloudTranscriptionModel,
    baseUrl: upload.cloudTranscriptionBaseUrl,
    localProvider: upload.localTranscriptionProvider,
    localModel: localTranscriptionModel(upload.localTranscriptionProvider, {
      whisper: upload.whisperModel,
      parakeet: upload.parakeetModel,
      cohere: upload.cohereModel,
    }),
    remoteUrl: upload.remoteTranscriptionUrl,
    remoteModel: upload.remoteTranscriptionModel,
  };
  const uploadRoute = transcriptionRoute(
    uploadChoice,
    managedTranscription,
    effective,
    cloudDisabled
  );
  add(
    "fileTranscription",
    uploadRoute,
    inheritsRecognition(
      transcriptionInherits(
        uploadChoice,
        {
          provider: effective.uploadCloudTranscriptionProvider,
          baseUrl: effective.uploadCloudTranscriptionBaseUrl,
          localModel: localTranscriptionModel(upload.localTranscriptionProvider, {
            whisper: effective.uploadWhisperModel,
            parakeet: effective.uploadParakeetModel,
            cohere: effective.uploadCohereModel,
          }),
        },
        effective.cloudTranscriptionProvider
      ),
      uploadRoute
    )
  );

  // ── Cleanup and Styles ─────────────────────────────────────────────────────
  const cleanup = route("dictationCleanup");
  add("cleanup", cleanup, { off: effective.useCleanupModel ? undefined : "disabled" });
  // A style runs on Cleanup's model whether or not Cleanup itself is on.
  if (stylesInUse) add("styles", cleanup, { kind: "inherited", from: "cleanup" });

  // ── Voice assistant (and its screen-context model) ─────────────────────────
  const assistantOff: UsageOffReason | undefined = !agentAllowed
    ? "policy"
    : effective.useDictationAgent
      ? undefined
      : "disabled";
  const agent = resolveDictationAgentInference(effective, {
    isCloudAgent: selectIsCloudDictationAgentMode(effective),
  });
  if (assistantOff || agent.reachable) {
    add("assistant", route("dictationAgent"), { off: assistantOff });
  } else {
    // On, but its own pick can't run (no model): the assistant panel answers
    // through Chat, as resolveChatStreamingInference routes it.
    const panel = resolveChatStreamingInference(effective, { inferenceScope: "dictationAgent" });
    if (panel.config.scope === "chatIntelligence") {
      add("assistant", route("chatIntelligence", panel.config), {
        kind: "fallback",
        from: "chat",
      });
    } else {
      add("assistant", route("dictationAgent"));
    }
  }

  // The vision override counts once the user picked its own model; until then
  // screenshots ride the assistant's own route (listed above). API-key providers only.
  const raw = input.settings;
  if (raw.useDictationAgentVisionModel && raw.dictationAgentVisionModel?.trim()) {
    const visionConfig = llm("dictationAgentVision");
    const vision = resolveDictationAgentVisionInference(effective, {
      isSignedIn: !!effective.isSignedIn,
    });
    const screenContextOn = effective.voiceAgentScreenContext && isScreenContextAllowed(policy);
    // A policy that forbids the pick leaves the override inert (its model cleared).
    const policyBlocks =
      !isModeAllowedByPolicy(policy, "llm", "providers") ||
      !effective.dictationAgentVisionModel?.trim();
    const visionOff: UsageOffReason | undefined =
      assistantOff ?? (policyBlocks ? "policy" : !screenContextOn ? "disabled" : undefined);
    if (visionConfig.mode === "providers" && (vision.active || visionOff)) {
      const inherits = !effective.dictationAgentVisionProvider?.trim();
      add("assistantVision", route("dictationAgentVision", visionConfig), {
        kind: inherits ? "inherited" : "configured",
        from: inherits ? "assistant" : undefined,
        off: visionOff,
      });
    }
  }

  // ── Translation, Chat ──────────────────────────────────────────────────────
  add("translation", route("dictationTranslation"), {
    off: effective.useDictationTranslation ? undefined : "disabled",
  });
  add("chat", route("chatIntelligence"), { off: agentAllowed ? undefined : "policy" });

  // ── Note formatting: each unset field it needs comes from Cleanup ───────────
  const inheritsCleanup = noteFormattingInheritsCleanup(effective);
  add("noteFormatting", route("noteFormatting"), {
    kind: inheritsCleanup ? "inherited" : "configured",
    from: inheritsCleanup ? "cleanup" : undefined,
  });

  return usages.sort((a, b) => FEATURE_ORDER.indexOf(a.feature) - FEATURE_ORDER.indexOf(b.feature));
}

/** The uses of one connection (by `connectionKey`), active ones first. */
export function usagesOf(usages: readonly FeatureUsage[], key: string): FeatureUsage[] {
  const own = usages.filter((usage) => connectionKey(usage.connection) === key);
  return [...own.filter(isActiveUsage), ...own.filter((usage) => !isActiveUsage(usage))];
}

/** Uses of a shared provider's key, Copilot's sign-in or OpenWhispr Cloud. */
export function usagesOfProvider(
  usages: readonly FeatureUsage[],
  provider: string
): FeatureUsage[] {
  if (provider === COPILOT_PROVIDER_ID) return usagesOf(usages, "copilot");
  if (provider === "cloud") return usagesOf(usages, "cloud");
  return usagesOf(usages, `provider:${provider}`);
}

/** Uses of a downloaded local model. */
export function usagesOfLocalModel(
  usages: readonly FeatureUsage[],
  engine: LocalModelEngine,
  model: string
): FeatureUsage[] {
  return usagesOf(usages, `local:${engine}:${model}`);
}

/** The per-feature custom and self-hosted endpoints, for their own summary. */
export function endpointUsages(usages: readonly FeatureUsage[]): FeatureUsage[] {
  return usages.filter(
    (usage) => usage.connection.type === "custom" || usage.connection.type === "selfHosted"
  );
}

/** Uses of enterprise providers (managed deployments and personal setups). */
export function enterpriseUsages(usages: readonly FeatureUsage[]): FeatureUsage[] {
  return usages.filter((usage) => usage.connection.type === "enterprise");
}
