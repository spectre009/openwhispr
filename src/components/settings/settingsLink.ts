import { createContext, useContext } from "react";

/**
 * Opens a Settings destination (`<page>`, `<page>#<settingId>`, `#<settingId>`)
 * from inside a Settings page: SettingsModal navigates, then lands on and
 * flashes the setting, as a search result does. Null outside Settings
 * (onboarding reuses the same pickers), where such links hide.
 */
export type OpenSettingsLink = (destination: string) => void;

export const SettingsLinkContext = createContext<OpenSettingsLink | null>(null);

export function useOpenSettingsLink(): OpenSettingsLink | null {
  return useContext(SettingsLinkContext);
}
