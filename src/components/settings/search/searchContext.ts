import {
  MAX_TRANSLATION_TARGETS,
  selectPolicyEffectiveSettings,
  selectResolvedLLMConfig,
  selectResolvedMeetingTranscription,
  selectResolvedUploadTranscription,
  type ResolvedLLMConfig,
  type SettingsState,
} from "../../../stores/settingsStore";
import {
  isAgentAllowed,
  isModeAllowedByPolicy,
  isScreenContextAllowed,
  type PolicyDecisionSnapshot,
} from "../../../stores/policyRules";
import {
  enterpriseProviderName,
  getCloudModel,
  getLocalModel,
  getProviderDisplayName,
  getTranscriptionProvider,
  isEnterpriseProvider,
} from "../../../models/ModelRegistry";
import { formatHotkeyLabel, formatHotkeyListLabel, parseHotkeyList } from "../../../utils/hotkeys";
import { getLanguageLabel } from "../../../utils/languageSupport";
import { supportsLiveTranscriptionPreview } from "../../../utils/transcriptionPreview";
import {
  findStyle,
  type StyleHotkeyBinding,
  type StyleLibrary,
} from "../../../config/styles/library";
import type { Platform } from "../../../utils/platform";
import type { InferenceMode } from "../../../types/electron";
import type {
  SearchLlmScope,
  SettingsSearchContext,
  SettingsSearchValue,
  SettingsSearchValueKey,
} from "./types";
import type { Translate } from "./searchIndex";

export interface SettingsSearchEnvironment {
  isWayland: boolean | null;
  gpuCount: number | null;
}

export interface SettingsSearchContextInput {
  /** The raw store state; policy is applied here, as the editors apply it. */
  settings: SettingsState;
  policy: PolicyDecisionSnapshot;
  styleLibrary: StyleLibrary;
  styleBindings: readonly StyleHotkeyBinding[];
  platform: Platform;
  cloudDisabled: boolean;
  hasWorkspace: boolean;
  canManageWorkspace: boolean;
  canManageMembers: boolean;
  env: SettingsSearchEnvironment;
  agentName: string;
  t: Translate;
}

const LLM_SCOPES: readonly SearchLlmScope[] = [
  "dictationCleanup",
  "dictationAgent",
  "dictationAgentVision",
  "dictationTranslation",
  "noteFormatting",
  "chatIntelligence",
];

// Brand names: never translated.
const LOCAL_TRANSCRIPTION_NAMES: Record<string, string> = {
  whisper: "Whisper",
  nvidia: "NVIDIA Parakeet",
  cohere: "Cohere Transcribe",
};

const LLM_MODE_KEYS: Record<InferenceMode, string> = {
  openwhispr: "settingsPage.aiModels.modes.openwhispr",
  providers: "settingsPage.aiModels.modes.providers",
  local: "settingsPage.aiModels.modes.local",
  "self-hosted": "settingsPage.aiModels.modes.selfHosted",
  enterprise: "settingsPage.aiModels.modes.enterprise",
};

const STT_MODE_KEYS: Record<InferenceMode, string> = {
  openwhispr: "settingsPage.transcription.modes.openwhispr",
  providers: "settingsPage.transcription.modes.providers",
  local: "settingsPage.transcription.modes.local",
  "self-hosted": "settingsPage.transcription.modes.selfHosted",
  enterprise: "settingsPage.transcription.modes.enterprise",
};

const joinValue = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" · ");
const terms = (...parts: Array<string | undefined>) =>
  parts.filter((part): part is string => !!part);

/**
 * Provider and model of an LLM scope. Reads only mode, provider and model:
 * the resolved config also carries the scope's API key and endpoints, which
 * search must never show or match. Feature page headers show the same label.
 */
export function describeLlm(
  config: Pick<ResolvedLLMConfig, "mode" | "provider" | "model">,
  t: Translate
): SettingsSearchValue {
  const { mode, provider, model } = config;
  const modeLabel = t(LLM_MODE_KEYS[mode] ?? LLM_MODE_KEYS.providers);
  if (mode === "openwhispr") return { display: modeLabel, terms: ["openwhispr", "cloud"] };
  if (mode === "local") {
    const name = getLocalModel(model)?.name;
    return { display: joinValue(modeLabel, name || model), terms: terms(model, provider, "local") };
  }
  if (mode === "self-hosted") {
    return { display: joinValue(modeLabel, model), terms: terms(model, "self-hosted") };
  }
  const providerName =
    mode === "enterprise" && isEnterpriseProvider(provider)
      ? enterpriseProviderName(provider)
      : provider
        ? getProviderDisplayName(provider)
        : modeLabel;
  const modelName = model ? getCloudModel(model, provider)?.name || model : undefined;
  return { display: joinValue(providerName, modelName), terms: terms(provider, model, mode) };
}

interface TranscriptionChoice {
  mode: InferenceMode;
  cloudProvider: string;
  cloudModel: string;
  localProvider: string;
  localModel: string;
  remoteModel?: string;
}

function describeTranscription(choice: TranscriptionChoice, t: Translate): SettingsSearchValue {
  const modeLabel = t(STT_MODE_KEYS[choice.mode] ?? STT_MODE_KEYS.providers);
  switch (choice.mode) {
    case "openwhispr":
    case "enterprise":
      return { display: modeLabel, terms: [choice.mode] };
    case "local": {
      const name = LOCAL_TRANSCRIPTION_NAMES[choice.localProvider] ?? choice.localProvider;
      return {
        display: joinValue(name, choice.localModel),
        terms: terms(choice.localProvider, choice.localModel, "local"),
      };
    }
    case "self-hosted":
      return {
        display: joinValue(modeLabel, choice.remoteModel),
        terms: terms(choice.remoteModel, "self-hosted"),
      };
    default: {
      const provider = getTranscriptionProvider(choice.cloudProvider);
      const modelName =
        provider?.models.find((model) => model.id === choice.cloudModel)?.name || choice.cloudModel;
      return {
        display: joinValue(provider?.name || choice.cloudProvider, modelName),
        terms: terms(choice.cloudProvider, choice.cloudModel),
      };
    }
  }
}

function localModelFor(
  provider: string,
  models: { whisper: string; parakeet: string; cohere: string }
) {
  if (provider === "nvidia") return models.parakeet;
  if (provider === "cohere") return models.cohere;
  return models.whisper;
}

function hotkeyValue(value: string | undefined | null): SettingsSearchValue | undefined {
  const list = parseHotkeyList(value);
  if (list.length === 0) return undefined;
  return { display: formatHotkeyListLabel(value), terms: list };
}

function nativeLanguageName(code: string): string | undefined {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Everything settings search needs to know about the current state: which
 * rows render (parent toggles, platform, policy) and the allowlisted values
 * (resolved provider · model per feature, engines, hotkeys, language, theme).
 * Values come from policy-effective settings, the way the editors show them.
 */
export function buildSettingsSearchContext(
  input: SettingsSearchContextInput
): SettingsSearchContext {
  const { settings, policy, t } = input;
  const effective = selectPolicyEffectiveSettings(settings, policy);
  const agentAllowed = isAgentAllowed(policy);
  const screenContextAllowed = isScreenContextAllowed(policy);

  const llm = Object.fromEntries(
    LLM_SCOPES.map((scope) => [scope, selectResolvedLLMConfig(effective, scope)])
  ) as Record<SearchLlmScope, ResolvedLLMConfig>;

  const dictationModels = {
    whisper: effective.whisperModel,
    parakeet: effective.parakeetModel,
    cohere: effective.cohereModel,
  };
  const meeting = selectResolvedMeetingTranscription(effective);
  const upload = selectResolvedUploadTranscription(effective);

  const values: Partial<Record<SettingsSearchValueKey, SettingsSearchValue>> = {};
  for (const scope of LLM_SCOPES) values[`llm.${scope}`] = describeLlm(llm[scope], t);

  values["stt.dictation"] = describeTranscription(
    {
      mode: effective.transcriptionMode,
      cloudProvider: effective.cloudTranscriptionProvider,
      cloudModel: effective.cloudTranscriptionModel,
      localProvider: effective.localTranscriptionProvider,
      localModel: localModelFor(effective.localTranscriptionProvider, dictationModels),
      remoteModel: effective.remoteTranscriptionModel,
    },
    t
  );
  values["stt.noteRecording"] = describeTranscription(
    {
      mode: meeting.transcriptionMode,
      cloudProvider: meeting.cloudTranscriptionProvider,
      cloudModel: meeting.cloudTranscriptionModel,
      localProvider: meeting.localTranscriptionProvider,
      localModel: localModelFor(meeting.localTranscriptionProvider, {
        whisper: meeting.whisperModel,
        parakeet: meeting.parakeetModel,
        cohere: meeting.cohereModel,
      }),
    },
    t
  );
  values["stt.upload"] = describeTranscription(
    {
      mode: upload.transcriptionMode,
      cloudProvider: upload.cloudTranscriptionProvider,
      cloudModel: upload.cloudTranscriptionModel,
      localProvider: upload.localTranscriptionProvider,
      localModel: localModelFor(upload.localTranscriptionProvider, {
        whisper: upload.whisperModel,
        parakeet: upload.parakeetModel,
        cohere: upload.cohereModel,
      }),
      remoteModel: upload.remoteTranscriptionModel,
    },
    t
  );

  // The dictation hotkey falls back to the platform default when unset.
  values["hotkey.dictation"] = {
    display: formatHotkeyListLabel(settings.dictationKey),
    terms: parseHotkeyList(settings.dictationKey),
  };
  const assistantKey = hotkeyValue(settings.voiceAgentKey);
  if (assistantKey) values["hotkey.assistant"] = assistantKey;
  const translationKey = hotkeyValue(settings.translationKey);
  if (translationKey) values["hotkey.translation"] = translationKey;
  const meetingKey = hotkeyValue(settings.meetingKey);
  if (meetingKey) values["hotkey.meeting"] = meetingKey;
  const reviewKey = hotkeyValue(settings.reviewKey);
  if (reviewKey) values["hotkey.review"] = reviewKey;
  const styleKeys = input.styleBindings.map((binding) => {
    const style = findStyle(input.styleLibrary, binding.styleId);
    return { label: formatHotkeyLabel(binding.hotkey), name: style?.name ?? "" };
  });
  if (styleKeys.length > 0) {
    values["hotkey.styles"] = {
      display: styleKeys.map(({ label, name }) => (name ? `${name}: ${label}` : label)).join(" · "),
    };
  }

  values.activationMode = {
    display: t(settings.activationMode === "push" ? "common.hold" : "common.tap"),
    terms: settings.activationMode === "push" ? ["push", "hold"] : ["tap", "toggle"],
  };
  const themeKey =
    settings.theme === "dark" ? "dark" : settings.theme === "light" ? "light" : "auto";
  values.theme = {
    display: t(`settingsPage.general.appearance.${themeKey}`),
    terms: [themeKey],
  };
  values.uiLanguage = {
    display: nativeLanguageName(settings.uiLanguage) || getLanguageLabel(settings.uiLanguage),
    terms: terms(getLanguageLabel(settings.uiLanguage), settings.uiLanguage),
  };
  values.transcriptionLanguage = {
    display: getLanguageLabel(settings.preferredLanguage),
    terms: terms(settings.preferredLanguage),
  };
  if (input.agentName) values.agentName = { display: input.agentName };
  if (settings.translationTargets.length > 0) {
    values.translationTargets = {
      display: settings.translationTargets.map(getLanguageLabel).join(", "),
      terms: [...settings.translationTargets],
    };
  }

  const selectedCloudModelStreams = Boolean(
    getTranscriptionProvider(effective.cloudTranscriptionProvider)?.models.some(
      (model) => model.id === effective.cloudTranscriptionModel && model.streaming
    )
  );

  return {
    platform: input.platform,
    cloudDisabled: input.cloudDisabled,
    isSignedIn: settings.isSignedIn,
    agentAllowed,
    screenContextAllowed,
    visionOverrideAllowed: isModeAllowedByPolicy(policy, "llm", "providers"),
    isWayland: input.platform === "linux" ? input.env.isWayland : false,
    gpuCount: input.env.gpuCount,
    hasWorkspace: input.hasWorkspace,
    canManageWorkspace: input.canManageWorkspace,
    canManageMembers: input.canManageMembers,
    on: {
      cleanup: effective.useCleanupModel,
      assistant: effective.useDictationAgent,
      screenContext: effective.voiceAgentScreenContext && screenContextAllowed,
      visionModel: effective.useDictationAgentVisionModel,
      translation: effective.useDictationTranslation,
      noteFiles: settings.noteFilesEnabled,
      colorByMode: settings.recordingColorByMode,
      autoLanguage: settings.preferredLanguage === "auto",
      localWhisper:
        settings.transcriptionMode === "local" && settings.localTranscriptionProvider === "whisper",
      transcriptionPreview: supportsLiveTranscriptionPreview(
        effective.transcriptionMode,
        selectedCloudModelStreams
      ),
    },
    localLlm: Object.fromEntries(
      LLM_SCOPES.map((scope) => [scope, llm[scope].mode === "local"])
    ) as Partial<Record<SearchLlmScope, boolean>>,
    values,
    interpolation: {
      agentName: input.agentName,
      hotkey: values["hotkey.dictation"]?.display ?? "",
      max: MAX_TRANSLATION_TARGETS,
    },
  };
}
