import type { SettingsSectionType } from "./SettingsPage";

// The old AI Models sidebar had four items (transcription, meetings,
// intelligence, agentMode) — they now collapse into two: speechToText + llms.
// Legacy deep-links land on the matching sub-tab via LEGACY_SUB_TAB.
// "dictationAgent" is a live deep-link (the Home GPU banner), not a legacy alias.
export const SECTION_ALIASES: Readonly<Record<string, SettingsSectionType>> = {
  aiModels: "llms",
  agentConfig: "llms",
  agentMode: "llms",
  dictationAgent: "llms",
  intelligence: "llms",
  meetings: "llms",
  prompts: "llms",
  transcription: "speechToText",
  uploadTranscription: "speechToText",
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
};

export const LEGACY_SUB_TAB: Readonly<Record<string, string>> = {
  transcription: "dictation",
  uploadTranscription: "upload",
  dictationAgent: "dictationAgent",
  meetings: "noteFormatting",
  intelligence: "dictationCleanup",
  agentMode: "chatIntelligence",
  agentConfig: "chatIntelligence",
  aiModels: "dictationCleanup",
  prompts: "dictationCleanup",
};

/** Sections that only exist for an OpenWhispr account. */
export const ACCOUNT_SECTIONS: ReadonlySet<SettingsSectionType> = new Set<SettingsSectionType>([
  "account",
  "plansBilling",
  "workspace",
]);

/** Where Settings opens when nothing more specific was asked for. */
export function defaultSettingsSection(cloudDisabled: boolean): SettingsSectionType {
  return cloudDisabled ? "general" : "account";
}

export function visibleSettingsSections<T extends { id: SettingsSectionType }>(
  items: T[],
  { isSignedIn, cloudDisabled }: { isSignedIn: boolean; cloudDisabled: boolean }
): T[] {
  return items.filter((item) => {
    if (cloudDisabled && ACCOUNT_SECTIONS.has(item.id)) return false;
    if (!isSignedIn && item.id === "workspace") return false;
    return true;
  });
}

/** A requested section (deep links and legacy names included), never a hidden one. */
export function resolveSettingsSection(
  section: string | undefined,
  aliases: Readonly<Record<string, SettingsSectionType>>,
  cloudDisabled: boolean
): SettingsSectionType {
  if (!section) return defaultSettingsSection(cloudDisabled);
  return shownSettingsSection((aliases[section] ?? section) as SettingsSectionType, cloudDisabled);
}

/** Where a deep link lands: its section (aliases resolved, never a hidden one) and legacy sub-tab. */
export function resolveSettingsDestination(
  section: string | undefined,
  cloudDisabled: boolean
): { section: SettingsSectionType; subTab?: string } {
  return {
    section: resolveSettingsSection(section, SECTION_ALIASES, cloudDisabled),
    subTab: section ? LEGACY_SUB_TAB[section] : undefined,
  };
}

/** The section actually shown: an account section falls back once the switch is off. */
export function shownSettingsSection(
  section: SettingsSectionType,
  cloudDisabled: boolean
): SettingsSectionType {
  return cloudDisabled && ACCOUNT_SECTIONS.has(section)
    ? defaultSettingsSection(cloudDisabled)
    : section;
}
