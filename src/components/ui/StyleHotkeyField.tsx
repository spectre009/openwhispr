import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { HotkeyInput } from "./HotkeyInput";
import { AlertTriangle, Info } from "../icons";
import { formatHotkeyListLabel } from "../../utils/hotkeys";
import { validateHotkeyForSlot } from "../../utils/hotkeyValidation";
import {
  COMMON_APP_SHORTCUT_WARNINGS,
  commonAppShortcut,
  styleHotkeyConflicts,
} from "../../utils/styleHotkeys";
import { getPlatform } from "../../utils/platform";
import { hotkeyEligibleStyleIds, type DictationStyle } from "../../config/styles/library";
import { setStyleHotkey, useStyleStore } from "../../stores/styleStore";
import { useSettingsStore } from "../../stores/settingsStore";

// A style's own hotkey (Stage 4): an extra key on the dictation slot that
// dictates in this style, in the dictation hotkey's activation mode. Saved
// through main right away (main registers it first and keeps it only if that
// worked), so it is not part of the editor's draft.

export default function StyleHotkeyField({ style }: { style: DictationStyle }) {
  const { t } = useTranslation();
  const { library, hotkeys } = useStyleStore(
    useShallow((s) => ({ library: s.library, hotkeys: s.hotkeys }))
  );
  const { dictationKey, voiceAgentKey, translationKey, meetingKey } = useSettingsStore(
    useShallow((s) => ({
      dictationKey: s.dictationKey,
      voiceAgentKey: s.voiceAgentKey,
      translationKey: s.translationKey,
      meetingKey: s.meetingKey,
    }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const platform = getPlatform();

  const binding = hotkeys.bindings.find((entry) => entry.styleId === style.id);
  const value = binding?.hotkey ?? "";
  const eligible = hotkeyEligibleStyleIds(library).includes(style.id);
  const warning = value ? commonAppShortcut(value, platform) : null;
  const disabled = saving || !hotkeys.supported || (!eligible && !value);

  const validate = (hotkey: string) =>
    validateHotkeyForSlot(
      hotkey,
      {
        "settingsPage.general.hotkey.title": dictationKey,
        "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey,
        "settingsPage.general.translationHotkey.title": translationKey,
        "settingsPage.general.meetingHotkey.title": meetingKey,
      },
      t,
      styleHotkeyConflicts(hotkeys.bindings, library, t, style.id)
    );

  const commit = async (hotkey: string | null) => {
    setSaving(true);
    setError(null);
    const result = await setStyleHotkey(style.id, hotkey);
    setSaving(false);
    if (!result.success) {
      setError(result.message || t("hooks.hotkeyRegistration.errors.couldNotRegister"));
    }
  };

  return (
    <div className="px-5 py-4 space-y-2">
      <p className="text-xs font-medium text-foreground">{t("styles.hotkey.label")}</p>
      <HotkeyInput
        value={value}
        onChange={(hotkey) => void commit(hotkey)}
        onClear={value ? () => void commit(null) : undefined}
        validate={validate}
        disabled={disabled}
      />
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        {t("styles.hotkey.description", { hotkey: formatHotkeyListLabel(dictationKey) })}
      </p>
      {!hotkeys.supported && hotkeys.unsupportedReason && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {hotkeys.unsupportedReason}
        </p>
      )}
      {hotkeys.supported && !eligible && !value && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {t("styles.hotkey.needsOn")}
        </p>
      )}
      {binding && !binding.active && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {t("styles.hotkey.inactive", { reason: binding.error ?? "" })}
        </p>
      )}
      {warning && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {t(COMMON_APP_SHORTCUT_WARNINGS[warning])}
        </p>
      )}
      {error && (
        <p dir="auto" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
