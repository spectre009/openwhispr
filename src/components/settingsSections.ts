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
  cloudDisabled: boolean,
  locateSetting?: (
    settingId: string
  ) => { section: SettingsSectionType; subTab?: string } | undefined
): { section: SettingsSectionType; subTab?: string; settingId?: string } {
  const { name, settingId } = parseSettingsDestination(section);
  // A known setting id names its own place (search moves settings by moving that).
  const located = settingId ? locateSetting?.(settingId) : undefined;
  const destination = located
    ? { section: shownSettingsSection(located.section, cloudDisabled), subTab: located.subTab }
    : {
        section: resolveSettingsSection(name, SECTION_ALIASES, cloudDisabled),
        subTab: name ? LEGACY_SUB_TAB[name] : undefined,
      };
  return settingId ? { ...destination, settingId } : destination;
}

/**
 * A destination string: a section or legacy name (`llms`, `meetings`), a
 * setting (`#dictation.cleanup.model`), or both (`general#preferences.theme`,
 * the section being the fallback when the id is unknown).
 */
export function parseSettingsDestination(destination: string | undefined): {
  name?: string;
  settingId?: string;
} {
  if (!destination) return {};
  const hash = destination.indexOf("#");
  if (hash < 0) return { name: destination };
  const name = destination.slice(0, hash) || undefined;
  const settingId = destination.slice(hash + 1) || undefined;
  return settingId ? { name, settingId } : { name };
}

/** The destination string that opens Settings at a setting (see parseSettingsDestination). */
export function settingDestination(settingId: string, section?: string): string {
  return `${section ?? ""}#${settingId}`;
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
