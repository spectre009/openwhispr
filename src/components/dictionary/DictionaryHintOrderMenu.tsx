import { useTranslation } from "react-i18next";
import { ChevronDown } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  DICTIONARY_HINT_ORDERS,
  normalizeDictionaryHintOrder,
} from "../../utils/dictionaryHintOrder";

// "Order: by evidence ▾" in the Dictionary's "Everything else" header: the
// same setting as Settings › Dictation › Recognition › "Dictionary order for
// speech-to-text" (`dictionaryHintOrder`), written to the same store, so
// either place shows the other's choice.

export default function DictionaryHintOrderMenu() {
  const { t } = useTranslation();
  const order = useSettingsStore((s) => s.dictionaryHintOrder);
  const setOrder = useSettingsStore((s) => s.setDictionaryHintOrder);
  return (
    <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
      <span aria-hidden="true">{t("dictionary.order.label")}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-dictionary-order={order}
            aria-label={t("dictionary.order.menuLabel", {
              order: t(`dictionary.order.options.${order}`),
            })}
            className="inline-flex items-center gap-0.5 rounded text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {t(`dictionary.order.options.${order}`)}
            <ChevronDown size={11} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-72">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {t("dictionary.order.menuHint")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={order}
            onValueChange={(value) => setOrder(normalizeDictionaryHintOrder(value))}
          >
            {DICTIONARY_HINT_ORDERS.map((option) => (
              <DropdownMenuRadioItem
                key={option}
                value={option}
                data-dictionary-order-option={option}
                className="text-xs"
              >
                {t(`settingsPage.dictionaryOrder.options.${option}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
