import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangle, ChevronRight } from "../icons";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { COMMON_APP_SHORTCUT_WARNINGS, commonAppShortcut } from "../../utils/styleHotkeys";
import { getPlatform } from "../../utils/platform";
import { findStyle } from "../../config/styles/library";
import { useStyleStore } from "../../stores/styleStore";

// Settings → Hotkeys → Style hotkeys (Stage 4): a read-only list of the keys
// styles have, each linking to its style in Style Studio, where keys are set.

export default function StyleHotkeysList({
  onOpenStyle,
}: {
  /** Opens Style Studio on a style, or on the styles list when null. */
  onOpenStyle: (styleId: string | null) => void;
}) {
  const { t } = useTranslation();
  const { library, hotkeys } = useStyleStore(
    useShallow((s) => ({ library: s.library, hotkeys: s.hotkeys }))
  );
  const platform = getPlatform();

  if (!hotkeys.supported && hotkeys.bindings.length === 0) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        {hotkeys.unsupportedReason}
      </p>
    );
  }

  if (hotkeys.bindings.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.general.styleHotkeys.empty")}
        </p>
        <button
          type="button"
          onClick={() => onOpenStyle(null)}
          className="text-xs text-primary hover:underline"
        >
          {t("settingsPage.general.styleHotkeys.openStyles")}
        </button>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border/60 dark:divide-border-subtle">
      {hotkeys.bindings.map((binding) => {
        const style = findStyle(library, binding.styleId);
        const warning = commonAppShortcut(binding.hotkey, platform);
        return (
          <li key={binding.hotkey} className="py-2 first:pt-0 last:pb-0">
            <button
              type="button"
              onClick={() => onOpenStyle(binding.styleId)}
              className="group flex w-full items-center gap-3 text-start"
              aria-label={t("settingsPage.general.styleHotkeys.openStyle", {
                name: style?.name ?? t("styles.hotkey.unknownStyle"),
              })}
            >
              <kbd
                dir="ltr"
                className="shrink-0 rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-foreground"
              >
                {formatHotkeyLabel(binding.hotkey)}
              </kbd>
              <span dir="auto" className="min-w-0 flex-1 truncate text-xs text-foreground">
                {style
                  ? `${style.emoji ? `${style.emoji} ` : ""}${style.name}`
                  : t("styles.hotkey.unknownStyle")}
              </span>
              <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground group-hover:text-foreground rtl:rotate-180" />
            </button>
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
          </li>
        );
      })}
    </ul>
  );
}
