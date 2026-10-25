import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { stepKindLabel } from "../ui/transcriptionStepLabels";
import { ChevronDown, Loader2, Search, ThumbsDown, ThumbsUp, X } from "../icons";
import { formatDateGroup, normalizeDbDate } from "../../utils/dateFormatting";
import { useUiLocale } from "../../hooks/useUiLocale";
import type { HistoryListRow, HistoryStepChange, HistoryStepMark } from "../../types/electron";
import {
  setHistoryApp,
  setHistoryFilter,
  setHistoryQuery,
  useHistoryViewStore,
  type HistoryKindFilter,
} from "./historyViewStore";
import type { HistoryListState } from "./useHistoryList";

// The History list: search, filters, then every dictation by day, newest
// first, a page at a time. Only the rows in view are rendered. ↑/↓ move the
// selection while the list has focus; Enter opens the detail on a narrow layout.

const DAY_HEIGHT = 30;
const ROW_HEIGHT = 60;
const MORE_HEIGHT = 44;

type FlatItem =
  | { type: "day"; key: string; label: string }
  | { type: "row"; key: string; row: HistoryListRow; day: string }
  | { type: "more"; key: string; day: string };

const HEIGHT: Record<FlatItem["type"], number> = {
  day: DAY_HEIGHT,
  row: ROW_HEIGHT,
  more: MORE_HEIGHT,
};

const rowKey = (id: number) => `row-${id}`;

// Steps whose effect on the text a row marks; a finalize step only when it changed it.
const MARKED_KINDS = new Set(["glossary", "cleanup", "translation", "agent", "style"]);

const MARK_CLASS: Record<HistoryStepChange, string> = {
  changed: "border-primary/45 bg-primary/12 text-primary",
  same: "border-border/80 text-muted-foreground/70 dark:border-white/12",
  failed: "border-destructive/45 bg-destructive/10 text-destructive",
  fallback: "border-warning/50 bg-warning/10 text-warning",
  skipped: "border-border/80 text-muted-foreground/70 dark:border-white/12",
};

function visibleMarks(marks: HistoryStepMark[] | null): HistoryStepMark[] {
  return (marks ?? []).filter(
    (mark) =>
      mark.change !== null &&
      mark.change !== "skipped" &&
      (MARKED_KINDS.has(mark.kind) || (mark.kind === "finalize" && mark.change === "changed"))
  );
}

function Mark({ mark }: { mark: HistoryStepMark }) {
  const { t } = useTranslation();
  const change = mark.change as HistoryStepChange;
  const step = stepKindLabel(
    { kind: mark.kind, detail: mark.snippets ? { snippets: true } : null },
    t
  );
  const label = t(`historyView.marks.${change}`, { step });
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "grid h-4 min-w-[18px] place-items-center rounded border px-0.5 text-[9.5px] leading-none font-bold",
        MARK_CLASS[change]
      )}
    >
      {t(`historyView.marks.letters.${mark.snippets ? "snippets" : mark.kind}`)}
    </span>
  );
}

function Rating({ rating }: { rating: HistoryListRow["rating"] }) {
  const { t } = useTranslation();
  if (!rating) return null;
  const label = t(
    rating === "good" ? "historyView.review.ratedGood" : "historyView.review.ratedBad"
  );
  const Icon = rating === "good" ? ThumbsUp : ThumbsDown;
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "me-0.5 grid h-4 w-4 place-items-center",
        rating === "good" ? "text-success" : "text-destructive"
      )}
    >
      <Icon size={12} />
    </span>
  );
}

function Row({
  row,
  selected,
  time,
  onPick,
}: {
  row: HistoryListRow;
  selected: boolean;
  time: string;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const failed = row.status === "failed";
  const failedLabel = t("controlPanel.history.transcriptionFailed");
  return (
    <div
      id={`history-row-${row.id}`}
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={cn(
        "flex h-full cursor-pointer flex-col justify-center gap-1 border-s-[3px] px-3.5 transition-colors duration-100",
        selected
          ? "border-s-primary bg-muted/80 dark:bg-white/8"
          : "border-s-transparent hover:bg-muted/40 dark:hover:bg-white/4"
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span className="shrink-0 tabular-nums">{time}</span>
        {row.app && (
          <span
            dir="ltr"
            className="min-w-0 truncate rounded-sm bg-muted px-1.5 text-[11px] text-foreground/75 dark:bg-white/8"
          >
            {row.app}
          </span>
        )}
        <span className="ms-auto flex shrink-0 items-center gap-0.5">
          <Rating rating={row.rating ?? null} />
          {failed ? (
            <span
              title={failedLabel}
              aria-label={failedLabel}
              className={cn(
                "grid h-4 min-w-[18px] place-items-center rounded border text-[9.5px] leading-none font-bold",
                MARK_CLASS.failed
              )}
            >
              !
            </span>
          ) : (
            visibleMarks(row.marks).map((mark, index) => <Mark key={index} mark={mark} />)
          )}
        </span>
      </div>
      <p
        dir="auto"
        className={cn(
          "truncate text-sm",
          failed
            ? "text-destructive"
            : row.preview
              ? "text-foreground"
              : "italic text-muted-foreground"
        )}
      >
        {failed ? failedLabel : row.preview || t("historyView.list.noText")}
      </p>
    </div>
  );
}

function SearchField() {
  const { t } = useTranslation();
  const query = useHistoryViewStore((state) => state.query);
  return (
    <div className="relative">
      <Search
        size={14}
        className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <input
        dir="auto"
        type="text"
        value={query}
        onChange={(event) => setHistoryQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.preventDefault();
            event.stopPropagation();
            setHistoryQuery("");
          }
        }}
        placeholder={t("historyView.search.placeholder")}
        aria-label={t("historyView.search.label")}
        className="h-8 w-full rounded-md border border-border/70 bg-input ps-8 pe-7 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-border-hover focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/10 dark:border-border-subtle/60 dark:bg-surface-1"
      />
      {query && (
        <button
          type="button"
          onClick={() => setHistoryQuery("")}
          aria-label={t("historyView.search.clear")}
          className="absolute end-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

const chipClass = (active: boolean) =>
  cn(
    "inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
    active
      ? "border-primary/60 bg-primary/10 text-foreground"
      : "border-border/70 text-muted-foreground hover:text-foreground dark:border-white/10"
  );

function AppFilter() {
  const { t } = useTranslation();
  const app = useHistoryViewStore((state) => state.app);
  const [apps, setApps] = useState<string[] | null>(null);
  const loadApps = () => {
    const read = window.electronAPI?.getHistoryApps;
    if (!read) {
      setApps([]);
      return;
    }
    read().then(
      (reply) => setApps(reply?.success ? reply.apps : []),
      () => setApps([])
    );
  };
  const choices = apps && app && !apps.includes(app) ? [app, ...apps] : apps;
  return (
    <DropdownMenu onOpenChange={(open) => open && loadApps()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipClass(!!app)}>
          {app ? (
            <BidiInterpolatedText
              text={t("historyView.filters.appSelected", { app: BIDI_VALUE_TOKEN })}
              value={app}
            />
          ) : (
            t("historyView.filters.app")
          )}
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        <DropdownMenuRadioGroup
          value={app ?? ""}
          onValueChange={(value) => setHistoryApp(value || null)}
        >
          <DropdownMenuRadioItem value="">{t("historyView.filters.anyApp")}</DropdownMenuRadioItem>
          {choices?.map((choice) => (
            <DropdownMenuRadioItem key={choice} value={choice}>
              <span dir="ltr">{choice}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {choices === null ? (
          <DropdownMenuItem disabled>
            <Loader2 size={12} className="animate-spin" />
          </DropdownMenuItem>
        ) : (
          choices.length === 0 && (
            <DropdownMenuItem disabled>{t("historyView.filters.noApps")}</DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterChips() {
  const { t } = useTranslation();
  const filter = useHistoryViewStore((state) => state.filter);
  const app = useHistoryViewStore((state) => state.app);
  const chip = (value: HistoryKindFilter, label: string, icon?: ReactNode) => {
    const active = filter === value && (value !== "all" || !app);
    return (
      <button
        type="button"
        aria-pressed={active}
        onClick={() => setHistoryFilter(value)}
        className={chipClass(active)}
      >
        {icon}
        {label}
      </button>
    );
  };
  return (
    <div
      role="group"
      aria-label={t("historyView.filters.label")}
      className="flex flex-wrap items-center gap-1.5"
    >
      {chip("all", t("historyView.filters.all"))}
      {chip("flagged", t("historyView.filters.flagged"), <ThumbsDown size={11} />)}
      {chip("failed", t("historyView.filters.failed"))}
      {chip("cleanupChanged", t("historyView.filters.cleanupChanged"))}
      <AppFilter />
    </div>
  );
}

interface HistoryListProps {
  list: HistoryListState & { reload: () => void; loadMore: (retry?: boolean) => void };
  selectedId: number | null;
  /** A row was picked; `open` shows its detail (narrow layouts). */
  onSelect: (id: number, open: boolean) => void;
  narrow: boolean;
  /** Bumped by "Open in History": bring the selected row into view when it's loaded. */
  revealRequest: number;
  /** Changes with the search and filters, which start the list over at the top. */
  criteriaKey: string;
  criteriaActive: boolean;
  onClearCriteria: () => void;
  historyOn: boolean;
  onOpenPrivacy: () => void;
}

export default function HistoryList({
  list,
  selectedId,
  onSelect,
  narrow,
  revealRequest,
  criteriaKey,
  criteriaActive,
  onClearCriteria,
  historyOn,
  onOpenPrivacy,
}: HistoryListProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { rows, nextCursor, status, loadingMore, moreFailed, loadMore, reload } = list;

  const flat = useMemo(() => {
    const items: FlatItem[] = [];
    let dayKey: string | null = null;
    let label = "";
    for (const row of rows) {
      const date = row.timestamp ? normalizeDbDate(row.timestamp) : null;
      const valid = !!date && !Number.isNaN(date.getTime());
      const key = valid ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : "unknown";
      if (key !== dayKey) {
        dayKey = key;
        label = valid ? formatDateGroup(date, t, locale) : "";
        items.push({ type: "day", key: `day-${key}`, label });
      }
      items.push({ type: "row", key: rowKey(row.id), row, day: label });
    }
    if (nextCursor || loadingMore || moreFailed)
      items.push({ type: "more", key: "more", day: label });
    return items;
  }, [rows, nextCursor, loadingMore, moreFailed, t, locale]);

  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale]
  );
  const formatTime = (timestamp: string | null) => {
    const date = timestamp ? normalizeDbDate(timestamp) : null;
    return date && !Number.isNaN(date.getTime()) ? timeFormat.format(date) : "";
  };

  const estimateSize = useCallback((index: number) => HEIGHT[flat[index].type], [flat]);
  const getItemKey = useCallback((index: number) => flat[index].key, [flat]);
  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: 8,
    // The day pinned over the top of the list covers the first row's height of it.
    scrollPaddingStart: DAY_HEIGHT,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // A new search or filter starts at the top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [criteriaKey]);

  // Rows added or removed above the ones in view (a new dictation) keep the
  // view where it is, unless it's at the very top, where new rows should show.
  const layout = useRef<{ keys: string[]; starts: number[] } | null>(null);
  useLayoutEffect(() => {
    const keys = flat.map((item) => item.key);
    const starts: number[] = [];
    let offset = 0;
    for (const item of flat) {
      starts.push(offset);
      offset += HEIGHT[item.type];
    }
    const previous = layout.current;
    layout.current = { keys, starts };
    const scroller = scrollRef.current;
    if (!previous || !scroller || scroller.scrollTop <= 0) return;
    const top = scroller.scrollTop;
    let anchor = -1;
    for (let index = 0; index < previous.starts.length; index += 1) {
      if (previous.starts[index] > top) break;
      anchor = index;
    }
    if (anchor < 0) return;
    const now = keys.indexOf(previous.keys[anchor]);
    if (now >= 0 && starts[now] !== previous.starts[anchor]) {
      scroller.scrollTop = starts[now] + (top - previous.starts[anchor]);
    }
  }, [flat]);

  // Near the end of what's loaded: the next page.
  const lastIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  useEffect(() => {
    if (lastIndex >= 0 && lastIndex >= flat.length - 8) loadMore();
  }, [lastIndex, flat.length, loadMore]);

  // "Open in History", or coming back to the view: the selected row, when it's loaded.
  const revealed = useRef(-1);
  useEffect(() => {
    if (revealed.current === revealRequest || status !== "ready") return;
    revealed.current = revealRequest;
    if (selectedId === null) return;
    const index = flat.findIndex((item) => item.key === rowKey(selectedId));
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [revealRequest, status, selectedId, flat, virtualizer]);

  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const move = (index: number) => {
    const id = rowIds[index];
    onSelect(id, false);
    const flatIndex = flat.findIndex((item) => item.key === rowKey(id));
    if (flatIndex >= 0) virtualizer.scrollToIndex(flatIndex, { align: "auto" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Only the list itself: never while typing in a field or composing text.
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || rowIds.length === 0) return;
    const index = selectedId === null ? -1 : rowIds.indexOf(selectedId);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(index < 0 ? 0 : Math.min(rowIds.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(index < 0 ? 0 : Math.max(0, index - 1));
    } else if (event.key === "Enter" && narrow && index >= 0) {
      event.preventDefault();
      onSelect(rowIds[index], true);
    }
  };

  const pick = (id: number) => {
    onSelect(id, narrow);
    scrollRef.current?.focus({ preventScroll: true });
  };

  const stickyIndex = virtualizer.range?.startIndex ?? 0;
  const stickyItem = flat[stickyIndex];
  const stickyLabel = stickyItem
    ? stickyItem.type === "day"
      ? stickyItem.label
      : stickyItem.day
    : "";
  const selectedShown =
    selectedId !== null &&
    virtualItems.some((item) => flat[item.index]?.key === rowKey(selectedId));

  let content;
  if (rows.length === 0 && status === "loading") {
    content = (
      <div className="flex justify-center pt-10">
        <Loader2 size={16} className="animate-spin text-primary" />
      </div>
    );
  } else if (rows.length === 0 && status === "error") {
    content = (
      <div className="flex flex-col items-center gap-2 px-6 pt-10 text-center">
        <p className="text-sm text-muted-foreground">
          {t("controlPanel.history.couldNotLoadTitle")}
        </p>
        <Button variant="outline" size="sm" onClick={reload}>
          {t("common.retry")}
        </Button>
      </div>
    );
  } else if (rows.length === 0) {
    content = (
      <div className="flex flex-col items-center px-6 pt-10 text-center">
        <p className="text-sm font-medium text-foreground">
          {t(criteriaActive ? "historyView.empty.noResults" : "historyView.empty.noDictations")}
        </p>
        {criteriaActive && (
          <>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("historyView.empty.noResultsDescription")}
            </p>
            <Button variant="outline" size="sm" className="mt-3" onClick={onClearCriteria}>
              {t("historyView.empty.clearFilters")}
            </Button>
          </>
        )}
      </div>
    );
  } else {
    content = (
      <div
        ref={scrollRef}
        role="listbox"
        tabIndex={0}
        aria-label={t("historyView.list.label")}
        aria-busy={status === "loading" || undefined}
        aria-activedescendant={selectedShown ? `history-row-${selectedId}` : undefined}
        onKeyDown={onKeyDown}
        className={cn(
          "h-full overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30",
          status === "loading" && "opacity-60"
        )}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none sticky top-0 z-10 -mb-[30px] flex h-[30px] items-end bg-background px-3.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80"
        >
          {stickyLabel}
        </div>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualItem) => {
            const item = flat[virtualItem.index];
            if (!item) return null;
            return (
              <div
                key={virtualItem.key}
                className="absolute inset-x-0 top-0"
                style={{
                  height: virtualItem.size,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                {item.type === "day" ? (
                  <div
                    role="presentation"
                    className="flex h-full items-end px-3.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80"
                  >
                    {item.label}
                  </div>
                ) : item.type === "row" ? (
                  <Row
                    row={item.row}
                    selected={item.row.id === selectedId}
                    time={formatTime(item.row.timestamp)}
                    onPick={() => pick(item.row.id)}
                  />
                ) : (
                  <div
                    role="presentation"
                    className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"
                  >
                    {moreFailed ? (
                      <>
                        <span>{t("historyView.list.moreFailed")}</span>
                        <button
                          type="button"
                          onClick={() => loadMore(true)}
                          className="text-primary hover:underline"
                        >
                          {t("common.retry")}
                        </button>
                      </>
                    ) : (
                      <>
                        <Loader2 size={12} className="animate-spin" />
                        {t("historyView.list.loadingMore")}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border/70 px-3.5 pt-3 pb-2.5 dark:border-white/10">
        <SearchField />
        <FilterChips />
      </div>
      {!historyOn && (
        <div className="mx-3.5 mt-2.5 shrink-0 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-300/90">
          {t("historyView.historyOff.message")}{" "}
          <button type="button" onClick={onOpenPrivacy} className="font-medium underline">
            {t("historyView.historyOff.link")}
          </button>
        </div>
      )}
      {status === "error" && rows.length > 0 && (
        <div className="mx-3.5 mt-2.5 flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
          <span>{t("controlPanel.history.couldNotLoadTitle")}</span>
          <button type="button" onClick={reload} className="text-primary hover:underline">
            {t("common.retry")}
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">{content}</div>
    </div>
  );
}
