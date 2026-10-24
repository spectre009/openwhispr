import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangle } from "../icons";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { COMMON_APP_SHORTCUT_WARNINGS, commonAppShortcut } from "../../utils/styleHotkeys";
import { getPlatform } from "../../utils/platform";
import { findStyle, type StyleHotkeyBinding } from "../../config/styles/library";
import { useStyleStore } from "../../stores/styleStore";
import {
  HotkeyFeatureLink,
  HotkeyKbd,
  HotkeyStatePill,
  HotkeyTableGroup,
  HotkeyTableRow,
} from "../settings/HotkeyTable";

// Settings → Hotkeys → the style hotkeys (Stage 4), as rows of the hotkeys
// table: one per style, read-only, each linking to its style in Styles, where
// keys are set. A key whose style is gone is listed too, and a key that isn't
// live (or a backend that refuses style keys) says why, as before.

export default function StyleHotkeysList({
  onOpenStyle,
  modeLabel,
}: {
  /** Opens Styles on a style, or on the styles list when null. */
  onOpenStyle: (styleId: string | null) => void;
  /** The dictation hotkey's activation mode (Hold/Tap), which style keys follow; null when hidden. */
  modeLabel: string | null;
}) {
  const { t } = useTranslation();
  const { library, hotkeys } = useStyleStore(
    useShallow((s) => ({ library: s.library, hotkeys: s.hotkeys }))
  );
  const platform = getPlatform();
  const how = modeLabel
    ? t("settingsHotkeys.how.followsDictation", { mode: modeLabel })
    : t("settingsHotkeys.how.likeDictation");
  // Keys whose style was deleted (main releases them; listed until it has).
  const orphans = hotkeys.bindings.filter((binding) => !findStyle(library, binding.styleId));

  const keyNotes = (binding: StyleHotkeyBinding) => {
    const warning = commonAppShortcut(binding.hotkey, platform);
    return (
      <>
        {!binding.active && (
          <p className="mt-1 flex items-start gap-1.5 text-[11px] text-warning">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            {t("styles.hotkey.inactive", { reason: binding.error ?? "" })}
          </p>
        )}
        {warning && (
          <p className="mt-1 flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            {t(COMMON_APP_SHORTCUT_WARNINGS[warning])}
          </p>
        )}
      </>
    );
  };

  return (
    <HotkeyTableGroup data-setting-id="hotkeys.styles">
      {(library.styles.length === 0 || !hotkeys.supported) && (
        <HotkeyTableRow
          rowId="styles"
          action={t("settingsPage.general.styleHotkeys.title")}
          description={t("settingsPage.general.styleHotkeys.description")}
          actions={
            <HotkeyFeatureLink
              label={t("settingsPage.general.styleHotkeys.openStyles")}
              onClick={() => onOpenStyle(null)}
            />
          }
        >
          {!hotkeys.supported ? (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground @2xl:pt-1">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              {hotkeys.unsupportedReason}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground @2xl:pt-1">
              {t("settingsPage.general.styleHotkeys.empty")}
            </p>
          )}
        </HotkeyTableRow>
      )}
      {library.styles.map((style) => {
        const binding = hotkeys.bindings.find((entry) => entry.styleId === style.id);
        const name = `${style.emoji ? `${style.emoji} ` : ""}${style.name}`;
        return (
          <HotkeyTableRow
            key={style.id}
            rowId={`style:${style.id}`}
            action={t("settingsHotkeys.styleRow", { style: name })}
            description={t("settingsHotkeys.styleRowDescription")}
            how={binding && style.enabled ? how : "—"}
            actions={
              <HotkeyFeatureLink
                label={t("settingsHotkeys.editStyle")}
                title={t("settingsPage.general.styleHotkeys.openStyle", { name: style.name })}
                onClick={() => onOpenStyle(style.id)}
              />
            }
          >
            <div className="flex flex-wrap items-center gap-1.5 @2xl:pt-0.5">
              {binding && <HotkeyKbd>{formatHotkeyLabel(binding.hotkey)}</HotkeyKbd>}
              {!style.enabled ? (
                <HotkeyStatePill>{t("settingsHotkeys.styleOff")}</HotkeyStatePill>
              ) : (
                !binding && <HotkeyStatePill>{t("settingsHotkeys.notSet")}</HotkeyStatePill>
              )}
            </div>
            {binding && keyNotes(binding)}
          </HotkeyTableRow>
        );
      })}
      {orphans.map((binding) => (
        <HotkeyTableRow
          key={binding.hotkey}
          rowId={`style-key:${binding.hotkey}`}
          action={t("settingsHotkeys.styleRow", { style: t("styles.hotkey.unknownStyle") })}
          how="—"
          actions={
            <HotkeyFeatureLink
              label={t("settingsPage.general.styleHotkeys.openStyles")}
              onClick={() => onOpenStyle(null)}
            />
          }
        >
          <div className="@2xl:pt-0.5">
            <HotkeyKbd>{formatHotkeyLabel(binding.hotkey)}</HotkeyKbd>
          </div>
          {keyNotes(binding)}
        </HotkeyTableRow>
      ))}
    </HotkeyTableGroup>
  );
}
