import type { TFunction } from "i18next";
import { normalizeHotkey, type Platform } from "./hotkeyValidator";
import type { NamedHotkey } from "./hotkeyValidation";
import { findStyle, type StyleHotkeyBinding, type StyleLibrary } from "../config/styles/library";

// Style hotkeys (Stage 4) in Settings: the conflict list other hotkey fields
// check against, and the warning for keys other apps commonly use.

export type CommonAppShortcut = "ctrlDigit" | "vscodeTerminal";

/** i18n key of each common-shortcut warning. */
export const COMMON_APP_SHORTCUT_WARNINGS: Record<CommonAppShortcut, string> = {
  ctrlDigit: "styles.hotkey.warnCtrlDigit",
  vscodeTerminal: "styles.hotkey.warnVsCodeTerminal",
};

/**
 * A key other apps commonly use, or null: Ctrl+1 to Ctrl+9 (Teams' views,
 * browser tabs) and Ctrl+Shift+` (VS Code's new terminal). Only a warning.
 */
export function commonAppShortcut(hotkey: string, platform: Platform): CommonAppShortcut | null {
  if (!hotkey) return null;
  const normalized = normalizeHotkey(hotkey, platform);
  if (/^Control\+[1-9]$/.test(normalized)) return "ctrlDigit";
  if (normalized === "Control+Shift+`") return "vscodeTerminal";
  return null;
}

/**
 * Every style key as a named conflict ("the Teams chat style"), except the
 * style being edited, for the hotkey fields' conflict checks.
 */
export function styleHotkeyConflicts(
  bindings: readonly Pick<StyleHotkeyBinding, "hotkey" | "styleId">[],
  library: StyleLibrary,
  t: TFunction,
  excludeStyleId?: string
): NamedHotkey[] {
  return bindings
    .filter((binding) => binding.styleId !== excludeStyleId)
    .map((binding) => {
      const style = findStyle(library, binding.styleId);
      const label = style
        ? t("styles.hotkey.conflictLabel", {
            name: `${style.emoji ? `${style.emoji} ` : ""}${style.name}`,
          })
        : t("styles.hotkey.conflictLabelUnknown");
      return { hotkey: binding.hotkey, label };
    });
}
