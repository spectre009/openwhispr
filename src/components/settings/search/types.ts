import type { IntegrationsSection } from "../../integrations/integrationsSections";
import type { Platform } from "../../../utils/platform";
import type { SettingsLocation } from "../settingsPages";

export type { SettingsLocation } from "../settingsPages";

/** The Workspace page's tabs, which a location may name (WorkspaceSection holds the real list). */
export const WORKSPACE_SUB_TABS: readonly string[] = ["general", "members", "teams", "developer"];

/** The i18n key of a Workspace tab's label. */
export function subTabLabelKey(subTab: string): string {
  return `settingsPage.workspace.tab.${subTab}`;
}

/** LLM scopes a search value or availability rule can name. */
export type SearchLlmScope =
  | "dictationCleanup"
  | "dictationAgent"
  | "dictationAgentVision"
  | "dictationTranslation"
  | "noteFormatting"
  | "chatIntelligence";

/**
 * The only current values search shows or matches. Each is computed by
 * `buildSettingsSearchContext` from resolved settings; secrets (API keys,
 * tokens) and endpoints never are.
 */
export type SettingsSearchValueKey =
  | "theme"
  | "uiLanguage"
  | "transcriptionLanguage"
  | "activationMode"
  | "agentName"
  | "translationTargets"
  | "hotkey.dictation"
  | "hotkey.assistant"
  | "hotkey.translation"
  | "hotkey.meeting"
  | "hotkey.review"
  | "hotkey.styles"
  | "stt.dictation"
  | "stt.noteRecording"
  | "stt.upload"
  | `llm.${SearchLlmScope}`;

export interface SettingsSearchValue {
  /** Shown in the result's value pill. */
  display: string;
  /** Also matched, not shown: model ids, English names, codes. */
  terms?: string[];
}

/** Parent toggles and modes a setting row only renders under. */
export interface SettingsSearchToggles {
  cleanup: boolean;
  assistant: boolean;
  /** Screen context as the assistant sees it: on and allowed by policy. */
  screenContext: boolean;
  visionModel: boolean;
  translation: boolean;
  noteFiles: boolean;
  colorByMode: boolean;
  /** The transcription language is auto-detect (the Chinese script row). */
  autoLanguage: boolean;
  /** Dictation runs on a local Whisper model (the VAD block). */
  localWhisper: boolean;
  /** The dictation engine streams text (the live preview row). */
  transcriptionPreview: boolean;
}

/** What availability rules and values read. Built from the stores, never holding secrets. */
export interface SettingsSearchContext {
  platform: Platform;
  cloudDisabled: boolean;
  isSignedIn: boolean;
  agentAllowed: boolean;
  screenContextAllowed: boolean;
  /** The assistant's vision override needs API-key providers allowed by policy. */
  visionOverrideAllowed: boolean;
  /** Linux + Wayland; null until known. */
  isWayland: boolean | null;
  /** NVIDIA GPUs found; null until known. The GPU pickers need two or more. */
  gpuCount: number | null;
  /** Owner or admin of the active workspace (its Developer tab). */
  canManageWorkspace: boolean;
  on: SettingsSearchToggles;
  /** LLM scopes that run on a local model now (keep-model-loaded only shows then). */
  localLlm: Partial<Record<SearchLlmScope, boolean>>;
  values: Partial<Record<SettingsSearchValueKey, SettingsSearchValue>>;
  /** Interpolation for titles and descriptions ({{agentName}}, {{hotkey}}, {{max}}). */
  interpolation: Record<string, string | number>;
}

/** An app page outside Settings that search finds, or a Settings link opens. */
export interface ElsewhereLocation {
  view: "dictionary" | "integrations" | "history";
  integrationsSection?: IntegrationsSection;
}

export interface SettingUnavailable {
  /** i18n key; interpolated with the prerequisite's {{setting}} title and {{page}}. */
  reason: string;
  /** Descriptor id of what has to change first; the result links there. */
  prerequisite?: string;
}

/** True, a reason it can't be reached now, or null when it shouldn't be listed at all. */
export type SettingAvailability = true | SettingUnavailable | null;

export type SettingDescriptorKind = "setting" | "page" | "elsewhere";

export interface SettingDescriptor {
  /** Stable and scope-qualified ("dictation.cleanup.model"); search destinations use it. */
  id: string;
  kind: SettingDescriptorKind;
  /** The page it lives on (and Workspace tab); moving a setting moves only this. */
  location?: SettingsLocation;
  /** For `elsewhere`: the app page it opens. */
  elsewhere?: ElsewhereLocation;
  /** `data-setting-id` to land on. Settings default to their id; pages have none. */
  anchor?: string;
  /** A stable parent's anchor, used while `anchor` isn't rendered in the current state. */
  fallbackAnchor?: string;
  titleKey: string;
  descriptionKey?: string;
  /** The block heading between the page and the setting, for the breadcrumb. */
  groupKey?: string;
  /** English technical synonyms ("push to talk", "api key"); matched in every language. */
  aliases?: readonly string[];
  /** Localized synonyms, matched in the UI language and in English. */
  aliasKeys?: readonly string[];
  available?: (ctx: SettingsSearchContext) => SettingAvailability;
  /** What has to open before the anchor shows. Never a setting change. */
  reveal?: { expand?: readonly string[] };
  value?: SettingsSearchValueKey;
}
