import {
  resolveSettingsDestination,
  type LocateSetting,
  type SavedLegacyTabs,
  type SettingsPageContext,
  type SettingsPageId,
} from "./settingsPages";

export type { LocateSetting } from "./settingsPages";

/**
 * A named request to show a Settings destination. The id makes each request
 * distinct, so asking again for the page Settings already went to still lands
 * there after the user moved elsewhere.
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

/** What Settings shows, and which request it last answered. */
export interface SettingsNavigation {
  page: SettingsPageId;
  /** The Workspace page's tab, when a destination named one. */
  subTab?: string;
  /** A setting to scroll to and flash once this navigation renders (search results). */
  settingId?: string;
  /** Bumps on every navigation, so a Workspace tab re-applies even when it's unchanged. */
  navigationId: number;
  requestId: number;
  /** Retired saved tabs not used yet; a bare `llms` / `speechToText` uses its one once. */
  savedTabs: SavedLegacyTabs;
}

export interface SettingsResolveOptions {
  ctx: SettingsPageContext;
  locateSetting?: LocateSetting;
}

function withoutUsedTab(
  savedTabs: SavedLegacyTabs,
  used: keyof SavedLegacyTabs | undefined
): SavedLegacyTabs {
  if (!used) return savedTabs;
  const rest = { ...savedTabs };
  delete rest[used];
  return rest;
}

function navigationTo(
  request: SettingsRequest | null,
  options: SettingsResolveOptions,
  savedTabs: SavedLegacyTabs,
  navigationId: number
): SettingsNavigation {
  const { usedSavedTab, ...destination } = resolveSettingsDestination(request?.section, {
    ...options,
    savedTabs,
  });
  return {
    ...destination,
    navigationId,
    requestId: request?.id ?? 0,
    savedTabs: withoutUsedTab(savedTabs, usedSavedTab),
  };
}

/** First mount: the request Settings was opened with, or the default page. */
export function initialSettingsNavigation(
  request: SettingsRequest | null,
  options: SettingsResolveOptions & { savedTabs?: SavedLegacyTabs }
): SettingsNavigation {
  return navigationTo(request, options, options.savedTabs ?? {}, 0);
}

/** A request Settings hasn't answered yet navigates; anything else keeps the page. */
export function applySettingsRequest(
  state: SettingsNavigation,
  request: SettingsRequest | null,
  options: SettingsResolveOptions
): SettingsNavigation {
  if (!request || request.id === state.requestId) return state;
  return navigationTo(request, options, state.savedTabs, state.navigationId + 1);
}

/**
 * The Settings nav, a link inside a page (e.g. Hotkeys → a style in Styles)
 * or a search result, which also names the setting to land on.
 */
export function navigateWithinSettings(
  state: SettingsNavigation,
  page: SettingsPageId,
  subTab?: string,
  settingId?: string
): SettingsNavigation {
  const next: SettingsNavigation = {
    page,
    navigationId: state.navigationId + 1,
    requestId: state.requestId,
    savedTabs: state.savedTabs,
  };
  if (subTab) next.subTab = subTab;
  if (settingId) next.settingId = settingId;
  return next;
}

/**
 * A named destination waits in main (it can outrace the listener on a cold
 * start); a bare request (the app menu's Settings item) keeps Settings where it is.
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
