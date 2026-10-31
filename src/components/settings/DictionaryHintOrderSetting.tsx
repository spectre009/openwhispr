import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDictionaryUsageStore } from "../../stores/dictionaryUsageStore";
import { DICTIONARY_HINT_ORDERS, type DictionaryHintOrder } from "../../utils/dictionaryHintOrder";

// Settings › Dictation › Recognition › "Dictionary order for speech-to-text"
// (`dictionaryHintOrder`): how the words that aren't pinned are ordered in
// the speech model's word list. Pinned words always go first, in the order
// set on the Dictionary page; order only decides which words fit a request's
// cap. The Dictionary page's "Order: by evidence ▾" writes the same setting.

const HINT_KEYS: Record<DictionaryHintOrder, string> = {
  evidence: "settingsPage.dictionaryOrder.options.evidenceHint",
  added: "settingsPage.dictionaryOrder.options.addedHint",
};

export default function DictionaryHintOrderSetting() {
  const { t } = useTranslation();
  const order = useSettingsStore((s) => s.dictionaryHintOrder);
  const setOrder = useSettingsStore((s) => s.setDictionaryHintOrder);
  const usageReady = useDictionaryUsageStore((s) => s.status === "ready");
  const label = t("settingsPage.dictionaryOrder.title");

  return (
    <div>
      <p className="text-xs font-medium text-foreground">{label}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
        {t("settingsPage.dictionaryOrder.description")}
      </p>
      <div
        role="radiogroup"
        aria-label={label}
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {DICTIONARY_HINT_ORDERS.map((option) => {
          const selected = option === order;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              data-dictionary-hint-order={option}
              onClick={() => setOrder(option)}
              className={`rounded-md border px-3 py-2 text-start transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                selected
                  ? "border-primary bg-primary/10"
                  : "border-border/70 bg-surface-1/60 hover:border-border-hover"
              }`}
            >
              <span className="block text-xs font-semibold text-foreground">
                {t(`settingsPage.dictionaryOrder.options.${option}`)}
              </span>
              <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                {t(HINT_KEYS[option])}
              </span>
            </button>
          );
        })}
      </div>
      {order === "evidence" && !usageReady && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {t("settingsPage.dictionaryOrder.unavailable")}
        </p>
      )}
    </div>
  );
}
