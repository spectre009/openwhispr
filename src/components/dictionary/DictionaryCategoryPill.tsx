import { useEffect, useRef } from "react";
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
// arrows move, Enter picks, Esc closes. In a list row it isn't a tab stop (the
// listbox is one): the list opens it with C on the focused row (`open`,
// `onOpenChange`, the checked option focused) and takes focus back when it
// closes (`onCloseFocus`), so the row stays the list's active one; the mouse
// opens it too. In the panel it's a regular button.

export interface DictionaryCategoryPillProps {
  word: string;
  category: DictionaryCategory | null;
  source: DictionaryCategorySource;
  onChange: (word: string, category: DictionaryCategory | null) => void;
  variant?: "row" | "panel";
  disabled?: boolean;
  /** The menu's open state, when the owner controls it (a list row). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Opened from the keyboard: the checked option takes focus once the menu shows. */
  focusCheckedOnOpen?: boolean;
  /** Where focus goes when the menu closes (Radix's default, the pill, otherwise). */
  onCloseFocus?: () => void;
}

// How long the menu may take to mount and take focus before the checked option is focused anyway.
const FOCUS_CHECKED_TRIES = 10;

export default function DictionaryCategoryPill({
  word,
  category,
  source,
  onChange,
  variant = "panel",
  disabled = false,
  open,
  onOpenChange,
  focusCheckedOnOpen = false,
  onCloseFocus,
}: DictionaryCategoryPillProps) {
  const { t } = useTranslation();
  const commonWords = useDictionaryCategoriesStore((s) => s.commonWords);
  const contentRef = useRef<HTMLDivElement>(null);
  const key = categoryKey(category);
  const name = t(CATEGORY_NAME_KEYS[key]);
  const who = t(CATEGORY_SOURCE_KEYS[source]);
  const auto = classifyDictionaryWord(word, commonWords);
  const value = source === "auto" ? "auto" : (category ?? "auto");
  const row = variant === "row";

  // Radix focuses the menu's first option when the keyboard opens it; from
  // the list's C, the current choice is the one to start from.
  useEffect(() => {
    if (!open || !focusCheckedOnOpen) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const focusChecked = () => {
      const content = contentRef.current;
      const checked = content?.querySelector<HTMLElement>(
        '[role="menuitemradio"][aria-checked="true"]'
      );
      const settled = !!content && content.contains(document.activeElement);
      if (checked && (settled || tries >= FOCUS_CHECKED_TRIES)) {
        checked.focus({ preventScroll: true });
        return;
      }
      tries += 1;
      if (tries <= FOCUS_CHECKED_TRIES) timer = setTimeout(focusChecked, 16);
    };
    timer = setTimeout(focusChecked, 0);
    return () => clearTimeout(timer);
  }, [open, focusCheckedOnOpen]);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          tabIndex={row ? -1 : undefined}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={t("dictionary.categories.pill.label", { word, category: name, who })}
          title={t(
            row ? "dictionary.categories.pill.titleRow" : "dictionary.categories.pill.title",
            {
              category: name,
              who,
            }
          )}
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
        ref={contentRef}
        align="start"
        className="min-w-48"
        onClick={(event) => event.stopPropagation()}
        // Esc closes the menu only, not the panel or view the pill sits in.
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
        onCloseAutoFocus={(event) => {
          if (!onCloseFocus) return;
          event.preventDefault();
          onCloseFocus();
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
