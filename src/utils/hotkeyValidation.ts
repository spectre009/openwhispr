import type { TFunction } from "i18next";
import { getValidationMessage, normalizeHotkey } from "./hotkeyValidator";
import { parseHotkeyList } from "./hotkeys";
import { getPlatform } from "./platform";

/** A hotkey held by something that isn't a settings slot (a style), already named. */
export interface NamedHotkey {
  hotkey: string;
  label: string;
}

export function validateHotkeyForSlot(
  hotkey: string,
  excludeSlots: Record<string, string>,
  t: TFunction,
  namedConflicts: readonly NamedHotkey[] = []
): string | null {
  const platform = getPlatform();
  const formatError = getValidationMessage(hotkey, platform);
  if (formatError) return formatError;

  const normalized = normalizeHotkey(hotkey, platform);

  // A slot's value may be a comma-separated hotkey list (#936) — conflict if
  // the candidate matches any entry.
  for (const [labelKey, otherValue] of Object.entries(excludeSlots)) {
    const conflicts = parseHotkeyList(otherValue).some(
      (other) => normalizeHotkey(other, platform) === normalized
    );
    if (conflicts) {
      return t("hotkey.errors.slotConflict", { slot: t(labelKey) });
    }
  }

  // Style hotkeys (Stage 4) share the dictation slot, so they come named.
  for (const { hotkey: other, label } of namedConflicts) {
    if (normalizeHotkey(other, platform) === normalized) {
      return t("hotkey.errors.slotConflict", { slot: label });
    }
  }

  return null;
}
