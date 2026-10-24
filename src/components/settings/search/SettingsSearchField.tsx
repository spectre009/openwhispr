import React from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "../../icons";
import { getCachedPlatform } from "../../../utils/platform";

interface SettingsSearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onClear: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** The results listbox, while it shows. */
  listId?: string;
  activeDescendant?: string;
}

/** The Settings nav's search field (Ctrl+F, or `/` outside a text field). */
export default function SettingsSearchField({
  value,
  onChange,
  onKeyDown,
  onClear,
  inputRef,
  listId,
  activeDescendant,
}: SettingsSearchFieldProps) {
  const { t } = useTranslation();
  const isMac = getCachedPlatform() === "darwin";
  const placeholder = t("settingsSearch.placeholderWithShortcut", {
    shortcut: isMac ? "⌘F" : "Ctrl+F",
  });

  return (
    <div className="px-2 pt-2">
      <label className="group flex h-8 items-center gap-2 rounded-md border border-border/70 bg-background px-2.5 transition-colors focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/25 dark:border-white/10 dark:bg-surface-1">
        <Search size={13} className="shrink-0 text-muted-foreground/70" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          dir="auto"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={t("settingsSearch.placeholder")}
          aria-keyshortcuts={isMac ? "Meta+F" : "Control+F"}
          role="combobox"
          aria-expanded={!!listId}
          aria-controls={listId}
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          // input-inline: the label draws the field, so the global input border and fill stay off.
          className="input-inline min-w-0 flex-1 text-ellipsis bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
        />
        {value && (
          <button
            type="button"
            onClick={onClear}
            aria-label={t("settingsSearch.clear")}
            title={t("settingsSearch.clear")}
            className="shrink-0 rounded-sm text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/30"
          >
            <X size={12} />
          </button>
        )}
      </label>
    </div>
  );
}
