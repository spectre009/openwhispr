import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";
import { CARD_SURFACE_CLASS } from "./ui/surfaces";
import { formatRelativeTime } from "../utils/dateFormatting";
import type { DictionarySuggestion } from "../types/electron";

// The Dictionary page's "Suggestions (N)": words auto-learn picked up from
// your edits (Suggest mode), each with what it replaced and in which app when
// this account's local History says so. Add puts a word in the dictionary as
// auto-learned; Dismiss means it's never suggested again. Main owns the inbox
// (local only, never synced); this lists it and follows its broadcast.

export default function DictionarySuggestions() {
  const { t, i18n } = useTranslation();
  const [suggestions, setSuggestions] = useState<DictionarySuggestion[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await window.electronAPI?.listDictionarySuggestions?.();
      setSuggestions(Array.isArray(result?.suggestions) ? result.suggestions : []);
    } catch {
      setSuggestions([]);
    }
  }, []);

  useEffect(() => {
    void load();
    return window.electronAPI?.onDictionarySuggestionsUpdated?.(() => void load());
  }, [load]);

  const act = useCallback(
    async (action: "accept" | "dismiss", ids: number[]) => {
      if (ids.length === 0) return;
      setBusy(true);
      try {
        if (action === "accept") await window.electronAPI?.acceptDictionarySuggestions?.(ids);
        else await window.electronAPI?.dismissDictionarySuggestions?.(ids);
      } finally {
        setBusy(false);
        void load();
      }
    },
    [load]
  );

  if (suggestions.length === 0) return null;

  return (
    <section
      aria-label={t("dictionary.suggestions.title", { count: suggestions.length })}
      className={cn(CARD_SURFACE_CLASS, "px-4 py-3 shadow-sm")}
      data-dictionary-suggestions
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-foreground/70">
          {t("dictionary.suggestions.title", { count: suggestions.length })}
        </h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void act(
              "accept",
              suggestions.map((s) => s.id)
            )
          }
        >
          {t("dictionary.suggestions.addAll")}
        </Button>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-foreground/45">
        {t("dictionary.suggestions.hint")}
      </p>
      <ul className="mt-2">
        {suggestions.map((suggestion) => {
          const evidence = suggestion.evidence[0];
          const when = formatRelativeTime(suggestion.updatedAt, t, i18n.language);
          return (
            <li
              key={suggestion.id}
              className="flex items-center gap-2 border-b border-foreground/4 py-2 last:border-b-0 dark:border-white/10"
            >
              <div className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-xs font-medium text-foreground/80">
                  {suggestion.word}
                </span>
                <span className="block truncate text-[11px] text-foreground/45">
                  {[
                    evidence
                      ? evidence.app
                        ? t("dictionary.suggestions.changedFromIn", {
                            replaced: evidence.replaced,
                            app: evidence.app,
                          })
                        : t("dictionary.suggestions.changedFrom", { replaced: evidence.replaced })
                      : t("dictionary.suggestions.learnedFromEdit"),
                    t("dictionary.suggestions.times", { count: suggestion.times }),
                    when,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <Button size="sm" disabled={busy} onClick={() => void act("accept", [suggestion.id])}>
                {t("dictionary.suggestions.add")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void act("dismiss", [suggestion.id])}
              >
                {t("dictionary.suggestions.dismiss")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
