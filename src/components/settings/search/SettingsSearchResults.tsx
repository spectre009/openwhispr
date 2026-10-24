import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, ExternalLink, Info } from "../../icons";
import { cn } from "../../lib/utils";
import {
  highlightRanges,
  settingsSearchOptionId,
  type SettingsSearchEntry,
  type SettingsSearchOutcome,
} from "./match";

type IconComponent = React.ComponentType<{ className?: string }>;

interface SettingsSearchResultsProps {
  query: string;
  outcome: SettingsSearchOutcome;
  /** Index into `outcome.results` of the highlighted result. */
  highlighted: number;
  onHighlight: (index: number) => void;
  onOpen: (entry: SettingsSearchEntry) => void;
  /** The icon of a result's Settings page (or its nav group). */
  iconFor: (pageOrGroupId: string) => IconComponent | undefined;
  listId: string;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={index} className="rounded-[2px] bg-primary/15 text-inherit dark:bg-primary/25">
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * Settings search results, in place of the page while the query isn't empty:
 * grouped by nav item (Dictation, Voice Assistant, …), each with its
 * breadcrumb, description and current value.
 * A result behind a prerequisite says why and opens the prerequisite instead.
 */
export default function SettingsSearchResults({
  query,
  outcome,
  highlighted,
  onHighlight,
  onOpen,
  iconFor,
  listId,
}: SettingsSearchResultsProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();

  useEffect(() => {
    const option = listRef.current?.querySelector('[role="option"][aria-selected="true"]');
    option?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);

  if (outcome.results.length === 0) {
    return (
      <div data-settings-search-results="" className="pt-2">
        <h2 dir="auto" className="text-sm! font-semibold! leading-snug! text-foreground">
          {t("settingsSearch.noResultsTitle", { query: trimmed })}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("settingsSearch.noResultsHint")}</p>
      </div>
    );
  }

  let index = -1;
  return (
    <div data-settings-search-results="" className="pt-2">
      <h2 dir="auto" className="text-sm! font-semibold! leading-snug! text-foreground">
        {t("settingsSearch.resultsTitle", { query: trimmed })}
      </h2>
      <p className="mt-1 mb-4 text-xs text-muted-foreground">{t("settingsSearch.hint")}</p>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("settingsSearch.resultsLabel")}
        className="space-y-5"
      >
        {outcome.groups.map((group) => (
          <div key={group.id} role="group" aria-label={group.label}>
            <div className="mb-1.5 ps-2 text-[11px] font-medium text-muted-foreground/70">
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.results.map(({ entry }) => {
                index += 1;
                const position = index;
                const active = position === highlighted;
                const Icon =
                  entry.kind === "elsewhere"
                    ? ExternalLink
                    : (iconFor(entry.pageId ?? entry.groupId) ?? Info);
                const path = entry.path.length ? entry.path.join(" › ") : t("settingsModal.title");
                return (
                  <div
                    key={entry.id}
                    id={settingsSearchOptionId(listId, position)}
                    role="option"
                    aria-selected={active}
                    aria-disabled={entry.unavailable && !entry.unavailable.prerequisite}
                    data-setting-result={entry.id}
                    onMouseMove={() => {
                      if (!active) onHighlight(position);
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onOpen(entry)}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-100",
                      active
                        ? "border-border/70 bg-muted/60 dark:border-white/10 dark:bg-surface-2"
                        : "border-transparent hover:bg-muted/40 dark:hover:bg-surface-2/60"
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground dark:bg-surface-raised",
                        entry.unavailable && "opacity-60"
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        dir="auto"
                        className={cn(
                          "block text-[13px] font-medium leading-snug text-foreground",
                          entry.unavailable && "text-foreground/70"
                        )}
                      >
                        <Highlighted text={entry.title} query={trimmed} />
                      </span>
                      <span
                        dir="auto"
                        className="mt-0.5 block text-[11px] text-muted-foreground/70"
                      >
                        {path}
                      </span>
                      {entry.description && (
                        <span
                          dir="auto"
                          className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted-foreground"
                        >
                          {entry.description}
                        </span>
                      )}
                      {entry.unavailable && (
                        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-warning">
                          <span className="inline-flex items-start gap-1.5">
                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span dir="auto">{entry.unavailable.reason}</span>
                          </span>
                          {entry.unavailable.prerequisiteTitle && (
                            <span className="inline-flex items-center gap-1 font-medium text-primary">
                              {t("settingsSearch.goTo", {
                                setting: entry.unavailable.prerequisiteTitle,
                              })}
                              <ArrowRight className="h-3 w-3 rtl:rotate-180" aria-hidden="true" />
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    {entry.value && (
                      <span
                        dir="auto"
                        className="mt-0.5 max-w-[40%] shrink-0 truncate rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] text-muted-foreground dark:border-white/10 dark:bg-surface-1"
                        title={entry.value}
                      >
                        <Highlighted text={entry.value} query={trimmed} />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
