import { findSettingDescriptor } from "./registry";
import { settingDestination } from "../settingsPages";
import type { ElsewhereLocation, SettingsLocation } from "./types";
import type { SettingsSearchEntry } from "./match";

export type SettingsSearchAction =
  | { kind: "navigate"; location: SettingsLocation; settingId?: string; destination: string }
  | { kind: "elsewhere"; location: ElsewhereLocation }
  | { kind: "none" };

/**
 * What opening a result does: go to its page (and land on the setting), open
 * the app page it names, or, when it can't be reached now, go to what has to
 * change first. Never a hidden page, and never a setting change.
 */
export function settingsSearchAction(
  entry: Pick<SettingsSearchEntry, "id" | "unavailable">
): SettingsSearchAction {
  const targetId = entry.unavailable ? entry.unavailable.prerequisite : entry.id;
  const descriptor = findSettingDescriptor(targetId);
  if (!descriptor) return { kind: "none" };
  if (descriptor.kind === "elsewhere") {
    return descriptor.elsewhere
      ? { kind: "elsewhere", location: descriptor.elsewhere }
      : { kind: "none" };
  }
  if (!descriptor.location) return { kind: "none" };
  return {
    kind: "navigate",
    location: descriptor.location,
    settingId: descriptor.kind === "setting" ? descriptor.id : undefined,
    destination: settingDestination(descriptor.id),
  };
}
