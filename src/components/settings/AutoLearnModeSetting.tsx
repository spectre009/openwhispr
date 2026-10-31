import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import type { AutoLearnMode } from "../../types/electron";
import { AUTO_LEARN_MODES } from "../../utils/autoLearnMode";

// Settings › Dictation › Output › "Learn from your corrections": Suggest
// (learned words wait on the Dictionary page), Add directly (as before) or
// Off. The store tells main (setAutoLearnMode); other windows follow its
// storage event. The Dictionary's suggestions mirror it (`compact`).

const MODE_LABEL_KEYS: Record<AutoLearnMode, string> = {
  suggest: "settingsPage.dictionary.autoLearnModes.suggest",
  add: "settingsPage.dictionary.autoLearnModes.add",
  off: "settingsPage.dictionary.autoLearnModes.off",
};

export default function AutoLearnModeSetting({ compact = false }: { compact?: boolean } = {}) {
  const { t } = useTranslation();
  const mode = useSettingsStore((s) => s.autoLearnMode);
  const setMode = useSettingsStore((s) => s.setAutoLearnMode);
  const label = t("settingsPage.dictionary.autoLearnTitle");

  const options = (
    <div
      role="radiogroup"
      aria-label={label}
      className={`${compact ? "" : "mt-3 "}inline-flex flex-wrap gap-1 rounded-md border border-border/70 bg-surface-1/60 p-0.5`}
    >
      {AUTO_LEARN_MODES.map((option) => {
        const selected = option === mode;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            data-auto-learn-mode={option}
            onClick={() => setMode(option)}
            className={`rounded-sm px-3 py-1 text-xs transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
              selected
                ? "bg-primary/15 font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(MODE_LABEL_KEYS[option])}
          </button>
        );
      })}
    </div>
  );

  // The Dictionary page's mirror: the label and the choices on one line.
  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        {options}
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs font-medium text-foreground">{label}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
        {t("settingsPage.dictionary.autoLearnDescription")}
      </p>
      {options}
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        {t("settingsPage.dictionary.autoLearnModeHint")}
      </p>
    </div>
  );
}
