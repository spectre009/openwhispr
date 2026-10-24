import type { SettingDescriptor, SettingsSearchContext } from "./types";
import { SETTINGS_SECTION_ORDER, subTabLabelKey } from "./types";
import { findSettingDescriptor, settingAvailability } from "./registry";
import type { SettingsSearchEntry } from "./match";

/** i18next's `t`, narrowed to what the index needs. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

const ELSEWHERE_GROUP = "elsewhere";

function sectionLabel(t: Translate, section: string): string {
  return t(`settingsModal.sections.${section}.label`);
}

/** The breadcrumb under a result's title. */
function pathOf(descriptor: SettingDescriptor, t: Translate): string[] {
  if (descriptor.kind === "elsewhere") {
    return descriptor.elsewhere?.view === "integrations" ? [t("sidebar.integrations")] : [];
  }
  const location = descriptor.location;
  if (!location) return [];
  if (descriptor.kind === "page") return location.subTab ? [sectionLabel(t, location.section)] : [];
  const path = [sectionLabel(t, location.section)];
  if (location.subTab) path.push(t(subTabLabelKey(location.section, location.subTab)));
  if (descriptor.groupKey) path.push(t(descriptor.groupKey, {}));
  return path;
}

/**
 * Turns the registry into what the matcher searches, for one UI language and
 * one state of the settings: translated and English titles, the breadcrumb,
 * aliases, allowlisted values and, for what can't be opened now, the reason.
 * Rebuilt when the language or the context changes.
 */
export function buildSettingsSearchIndex({
  descriptors,
  ctx,
  t,
  tEn,
}: {
  descriptors: readonly SettingDescriptor[];
  ctx: SettingsSearchContext;
  t: Translate;
  /** The same lookups in English. */
  tEn: Translate;
}): SettingsSearchEntry[] {
  const vars = ctx.interpolation;
  const entries: SettingsSearchEntry[] = [];
  descriptors.forEach((descriptor, order) => {
    const availability = settingAvailability(descriptor, ctx);
    if (availability === null) return;

    const section = descriptor.location?.section;
    const groupId = descriptor.kind === "elsewhere" || !section ? ELSEWHERE_GROUP : section;
    const groupOrder =
      groupId === ELSEWHERE_GROUP
        ? SETTINGS_SECTION_ORDER.length
        : SETTINGS_SECTION_ORDER.indexOf(groupId as (typeof SETTINGS_SECTION_ORDER)[number]);

    let unavailable: SettingsSearchEntry["unavailable"];
    if (availability !== true) {
      const prerequisite = findSettingDescriptor(availability.prerequisite);
      const prerequisiteTitle = prerequisite ? t(prerequisite.titleKey, vars) : undefined;
      const prerequisitePage = prerequisite?.location
        ? sectionLabel(t, prerequisite.location.section)
        : "";
      unavailable = {
        reason: t(availability.reason, {
          setting: prerequisiteTitle ?? "",
          page: prerequisitePage,
        }),
        prerequisite: prerequisite?.id,
        prerequisiteTitle,
      };
    }

    const value = descriptor.value ? ctx.values[descriptor.value] : undefined;
    entries.push({
      id: descriptor.id,
      kind: descriptor.kind,
      groupId,
      groupLabel:
        groupId === ELSEWHERE_GROUP
          ? t("settingsSearch.groups.elsewhere")
          : sectionLabel(t, groupId),
      groupOrder,
      order,
      title: t(descriptor.titleKey, vars),
      titleEn: tEn(descriptor.titleKey, vars),
      description: descriptor.descriptionKey ? t(descriptor.descriptionKey, vars) : "",
      path: pathOf(descriptor, t),
      aliases: [
        ...(descriptor.aliases ?? []),
        ...(descriptor.aliasKeys ?? []).flatMap((key) => [t(key), tEn(key)]),
      ],
      value: value?.display || undefined,
      valueTerms: value?.terms,
      unavailable,
    });
  });
  return entries;
}
