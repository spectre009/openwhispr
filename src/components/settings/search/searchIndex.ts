import type { SettingDescriptor, SettingsSearchContext } from "./types";
import { subTabLabelKey } from "./types";
import { findSettingDescriptor, settingAvailability } from "./registry";
import { SETTINGS_ELSEWHERE_ORDER, SETTINGS_PAGES, settingsPageTrail } from "../settingsPages";
import type { SettingsSearchEntry } from "./match";

/** i18next's `t`, narrowed to what the index needs. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

const ELSEWHERE_GROUP = "elsewhere";

/**
 * The breadcrumb under a result's title, from the nav tree: the parent, the
 * page, the Workspace tab and the block ("Dictation › Cleanup"). A page's own
 * entry shows only its parent; a parent's entry shows nothing.
 */
function pathOf(descriptor: SettingDescriptor, t: Translate): string[] {
  if (descriptor.kind === "elsewhere") {
    return descriptor.elsewhere?.view === "integrations" ? [t("sidebar.integrations")] : [];
  }
  const location = descriptor.location;
  if (!location) return [];
  const trail = settingsPageTrail(location.page);
  const parent = trail.parentTitleKey ? [t(trail.parentTitleKey)] : [];
  if (descriptor.kind === "page") {
    return descriptor.titleKey === trail.titleKey ? parent : [];
  }
  const pageTitle = t(trail.titleKey);
  const path = [...parent, pageTitle];
  if (location.subTab) path.push(t(subTabLabelKey(location.subTab)));
  // A block named like its page (Notifications on Notifications) isn't repeated.
  if (descriptor.groupKey && descriptor.groupKey !== trail.titleKey) {
    const group = t(descriptor.groupKey, {});
    if (group !== pageTitle) path.push(group);
  }
  return path;
}

/**
 * Turns the registry into what the matcher searches, for one UI language and
 * one state of the settings: translated and English titles, the breadcrumb,
 * aliases, allowlisted values and, for what can't be opened now, the reason.
 * Results group by their top-level nav item (Dictation, Voice Assistant, …) in
 * nav order. Rebuilt when the language or the context changes.
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

    const page = descriptor.kind === "elsewhere" ? undefined : descriptor.location?.page;
    const trail = page ? settingsPageTrail(page) : undefined;

    let unavailable: SettingsSearchEntry["unavailable"];
    if (availability !== true) {
      const prerequisite = findSettingDescriptor(availability.prerequisite);
      const prerequisiteTitle = prerequisite ? t(prerequisite.titleKey, vars) : undefined;
      const prerequisitePage = prerequisite?.location
        ? t(SETTINGS_PAGES[prerequisite.location.page].titleKey, vars)
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
      pageId: page,
      groupId: trail ? trail.topId : ELSEWHERE_GROUP,
      groupLabel: trail ? t(trail.topTitleKey) : t("settingsSearch.groups.elsewhere"),
      groupOrder: trail ? trail.topOrder : SETTINGS_ELSEWHERE_ORDER,
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
