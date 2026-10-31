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
import { cn } from "../lib/utils";
import { useDictionaryCategoriesStore } from "../../stores/dictionaryCategoriesStore";
import {
  DICTIONARY_CATEGORIES,
  classifyDictionaryWord,
  isDictionaryCategory,
  type DictionaryCategory,
  type DictionaryCategorySource,
} from "../../utils/dictionaryCategories";
import {
  CATEGORY_DOT_CLASS,
  CATEGORY_NAME_KEYS,
  CATEGORY_PILL_CLASS,
  CATEGORY_SOURCE_KEYS,
  categoryKey,
} from "./categoryStyles";

// A word's category as a pill ("● People auto ▾"): a dot and the name (or
// "Unsorted"), who decided it (auto, you, model), and a menu to pick People,
// Work terms or Everyday words (stored as the user's choice) or Automatic
// (the stored choice removed). A Radix menu: Enter, Space or ↓ opens it,
// arrows move, Enter picks, Esc closes. In a list row it's a mouse target
// like the row's other controls (the list's keyboard path is the word panel
// and the bulk bar's Set category); in the panel it's a regular button.

export interface DictionaryCategoryPillProps {
  word: string;
  category: DictionaryCategory | null;
  source: DictionaryCategorySource;
  onChange: (word: string, category: DictionaryCategory | null) => void;
  variant?: "row" | "panel";
  disabled?: boolean;
}

export default function DictionaryCategoryPill({
  word,
  category,
  source,
  onChange,
  variant = "panel",
  disabled = false,
}: DictionaryCategoryPillProps) {
  const { t } = useTranslation();
  const commonWords = useDictionaryCategoriesStore((s) => s.commonWords);
  const key = categoryKey(category);
  const name = t(CATEGORY_NAME_KEYS[key]);
  const who = t(CATEGORY_SOURCE_KEYS[source]);
  const auto = classifyDictionaryWord(word, commonWords);
  const value = source === "auto" ? "auto" : (category ?? "auto");
  const row = variant === "row";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          tabIndex={row ? -1 : undefined}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={t("dictionary.categories.pill.label", { word, category: name, who })}
          title={t("dictionary.categories.pill.title", { category: name, who })}
          data-category-pill={word}
          data-category={key}
          data-category-source={source}
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-px transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60",
            row ? "text-[10.5px]" : "text-[11px]",
            CATEGORY_PILL_CLASS[key]
          )}
        >
          {category && (
            <span
              aria-hidden="true"
              className={cn(
                "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                CATEGORY_DOT_CLASS[key]
              )}
            />
          )}
          <span className="truncate">{name}</span>
          {category && (
            <span aria-hidden="true" className="text-[9.5px] text-muted-foreground">
              {who}
            </span>
          )}
          <ChevronDown size={10} aria-hidden="true" className="shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-48"
        onClick={(event) => event.stopPropagation()}
        // Esc closes the menu only, not the panel or view the pill sits in.
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("dictionary.categories.pill.menuTitle", { word })}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next === value) return;
            onChange(word, isDictionaryCategory(next) ? next : null);
          }}
        >
          {DICTIONARY_CATEGORIES.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              data-category-option={option}
              className="text-xs"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "me-1.5 inline-block h-1.5 w-1.5 rounded-full",
                  CATEGORY_DOT_CLASS[option]
                )}
              />
              {t(CATEGORY_NAME_KEYS[option])}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="auto" data-category-option="auto" className="text-xs">
            {t("dictionary.categories.pill.automatic", {
              category: t(CATEGORY_NAME_KEYS[categoryKey(auto)]),
            })}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
