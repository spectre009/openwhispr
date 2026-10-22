import type { SettingsSectionType } from "./SettingsPage";

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

/** The section actually shown: an account section falls back once the switch is off. */
export function shownSettingsSection(
  section: SettingsSectionType,
  cloudDisabled: boolean
): SettingsSectionType {
  return cloudDisabled && ACCOUNT_SECTIONS.has(section)
    ? defaultSettingsSection(cloudDisabled)
    : section;
}
