import type { SettingsSectionType } from "../SettingsPage";
import { resolveSettingsDestination } from "../settingsSections";

/**
 * A named request to show a Settings destination. The id makes each request
 * distinct, so asking again for the section Settings already went to still
 * lands there after the user moved elsewhere.
 */
export interface SettingsRequest {
  section: string;
  id: number;
}

export function nextSettingsRequest(
  previous: SettingsRequest | null,
  section: string
): SettingsRequest {
  return { section, id: (previous?.id ?? 0) + 1 };
}

/** Where a setting id lives, from the search registry (kept out of this module). */
export type LocateSetting = (
  settingId: string
) => { section: SettingsSectionType; subTab?: string } | undefined;

/** What Settings shows, and which request it last answered. */
export interface SettingsNavigation {
  section: SettingsSectionType;
  /** Legacy deep links land on a sub-tab of their section. */
  subTab?: string;
  /** A setting to scroll to and flash once this navigation renders (search results). */
  settingId?: string;
  /** Bumps on every navigation, so a sub-tab re-applies even when it's unchanged. */
  navigationId: number;
  requestId: number;
}

/** First mount: the request Settings was opened with, or the default section. */
export function initialSettingsNavigation(
  request: SettingsRequest | null,
  cloudDisabled: boolean,
  locateSetting?: LocateSetting
): SettingsNavigation {
  const destination = resolveSettingsDestination(request?.section, cloudDisabled, locateSetting);
  return { ...destination, navigationId: 0, requestId: request?.id ?? 0 };
}

/** A request Settings hasn't answered yet navigates; anything else keeps the page. */
export function applySettingsRequest(
  state: SettingsNavigation,
  request: SettingsRequest | null,
  cloudDisabled: boolean,
  locateSetting?: LocateSetting
): SettingsNavigation {
  if (!request || request.id === state.requestId) return state;
  const destination = resolveSettingsDestination(request.section, cloudDisabled, locateSetting);
  return { ...destination, navigationId: state.navigationId + 1, requestId: request.id };
}

/**
 * The Settings nav, a link inside a section (e.g. Hotkeys → a style in Style
 * Studio) or a search result, which also names the setting to land on.
 */
export function navigateWithinSettings(
  state: SettingsNavigation,
  section: SettingsSectionType,
  subTab?: string,
  settingId?: string
): SettingsNavigation {
  const next: SettingsNavigation = {
    section,
    subTab,
    navigationId: state.navigationId + 1,
    requestId: state.requestId,
  };
  if (settingId) next.settingId = settingId;
  return next;
}

/**
 * A named section waits in main (it can outrace the listener on a cold start);
 * a bare request (the app menu's Settings item) keeps Settings where it is.
 */
export async function drainPendingSettingsSection(
  readPending: () => Promise<string | null | undefined> | undefined,
  openSettings: (section?: string) => void,
  showAnyway: boolean
): Promise<void> {
  const section = await readPending();
  if (section) openSettings(section);
  else if (showAnyway) openSettings();
}
