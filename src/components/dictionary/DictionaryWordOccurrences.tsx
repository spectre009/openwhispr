import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, X } from "../icons";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { normalizeDbDate } from "../../utils/dateFormatting";
import { requestOpenHistoryForWord, requestOpenHistoryItem } from "../../utils/openHistoryItem";
import type {
  DictionaryAppearanceKind,
  DictionaryOccurrence,
  DictionaryOccurrencesResult,
  HistoryCursor,
} from "../../types/electron";
import {
  APPEARANCE_KIND_KEYS,
  APPEARANCE_KIND_TEXT,
  FIXED_BY_KEYS,
  usageUnavailableKey,
} from "./dictionaryLabels";
import { formatWeekRange, type UsageWeekRange } from "./usageWeeks";

// "Where it appeared" (the word panel): the dictations of the last 90 days
// with the word, newest first, a page at a time (dictionary-word-occurrences):
// All, Fixed after speech, Speech got it or Changed, with how many dictations
// have each (a mixed one counts in each), optionally one histogram week. Each
// row shows its date, app, kinds, who fixed it when the recorded steps say,
// and its text around the word, with what speech wrote struck through; it
// opens in History. "Show in History" opens History filtered to the word.
// Answers to an older request (another word, kind, week, or a refresh after
// History, the dictionary, the owner or the policy changed) are dropped.

type Segment = "all" | DictionaryAppearanceKind;
const SEGMENTS: readonly Segment[] = ["all", "fix", "ok", "chg"];
const PAGE = 20;

type Ready = Extract<DictionaryOccurrencesResult, { available: true }>;
type State =
  | { status: "loading" }
  | { status: "unavailable"; reason: string | null }
  | {
      status: "ready";
      items: DictionaryOccurrence[];
      nextCursor: HistoryCursor | null;
      totals: Ready["totals"];
      unaligned: number;
      loadingMore: boolean;
      moreFailed: boolean;
    };

const MARK_CLASS: Record<DictionaryAppearanceKind, string> = {
  ok: "bg-success/20",
  fix: "bg-warning/25",
  chg: "bg-destructive/15",
};

export function KindTag({ kind }: { kind: DictionaryAppearanceKind }) {
  const { t } = useTranslation();
  return (
    <span
      data-kind-tag={kind}
      className={cn("inline-flex items-center gap-1 text-[11px]", APPEARANCE_KIND_TEXT[kind])}
    >
      <span aria-hidden>{kind === "ok" ? "✓" : kind === "fix" ? "✎" : "↺"}</span>
      {t(APPEARANCE_KIND_KEYS[kind])}
    </span>
  );
}

function OccurrenceRow({ item }: { item: DictionaryOccurrence }) {
  const { t, i18n } = useTranslation();
  const date = item.at ? normalizeDbDate(item.at) : null;
  const when =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleString(i18n.language, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : null;
  const { snippet } = item;
  return (
    <li className="border-t border-border/50 first:border-t-0 dark:border-white/8">
      <button
        type="button"
        onClick={() => requestOpenHistoryItem(item.id)}
        data-occurrence={item.id}
        className="block w-full rounded-md px-1 py-2 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:hover:bg-white/4"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {when && <span>{when}</span>}
          {item.app && (
            <span dir="ltr" className="truncate">
              {item.app}
            </span>
          )}
          {item.kinds.map((kind) => (
            <KindTag key={kind} kind={kind} />
          ))}
          {item.by && <span data-fixed-by={item.by}>{t(FIXED_BY_KEYS[item.by])}</span>}
          <span className="ms-auto inline-flex items-center gap-1 text-primary">
            {t("dictionary.occurrences.open")}
            <ExternalLink size={10} />
          </span>
        </span>
        <span dir="auto" className="mt-1 block text-[12.5px] leading-snug text-foreground/85">
          {snippet.before}
          {snippet.kind === "fix" && item.speechWrote && (
            <>
              <del data-speech-wrote className="text-destructive/80 decoration-destructive/60">
                {item.speechWrote}
              </del>{" "}
            </>
          )}
          <mark
            data-occurrence-match={snippet.kind}
            className={cn("rounded-[3px] px-0.5 text-foreground", MARK_CLASS[snippet.kind])}
          >
            {snippet.match}
          </mark>
          {snippet.after}
        </span>
      </button>
    </li>
  );
}

export default function DictionaryWordOccurrences({
  word,
  week,
  onClearWeek,
  refreshKey,
}: {
  word: string;
  /** A histogram week, or every week. */
  week: UsageWeekRange | null;
  onClearWeek: () => void;
  /** Bumped when History, the dictionary, the owner or the policy changed: read again. */
  refreshKey: number;
}) {
  const { t, i18n } = useTranslation();
  const [segment, setSegment] = useState<Segment>("all");
  const [state, setState] = useState<State>({ status: "loading" });
  // Bumped by every new first page: answers to an older one are dropped.
  const generation = useRef(0);
  const latest = useRef(state);
  latest.current = state;

  const request = useCallback(
    (cursor: HistoryCursor | null) => {
      const read = window.electronAPI?.getDictionaryWordOccurrences;
      if (!read) return Promise.resolve(null);
      return read(word, {
        kind: segment === "all" ? null : segment,
        range: week ? { start: week.start, end: week.end } : null,
        cursor,
        limit: PAGE,
      });
    },
    [word, segment, week]
  );

  useEffect(() => {
    const current = ++generation.current;
    setState({ status: "loading" });
    request(null).then(
      (result) => {
        if (current !== generation.current) return;
        if (result?.available) {
          setState({
            status: "ready",
            items: result.items ?? [],
            nextCursor: result.nextCursor ?? null,
            totals: result.totals,
            unaligned: result.unaligned ?? 0,
            loadingMore: false,
            moreFailed: false,
          });
        } else {
          setState({
            status: "unavailable",
            reason: (result && "reason" in result && result.reason) || null,
          });
        }
      },
      () => {
        if (current === generation.current) setState({ status: "unavailable", reason: null });
      }
    );
  }, [request, refreshKey]);

  const loadMore = () => {
    const now = latest.current;
    if (now.status !== "ready" || !now.nextCursor || now.loadingMore) return;
    const current = generation.current;
    setState({ ...now, loadingMore: true, moreFailed: false });
    request(now.nextCursor).then(
      (result) => {
        if (current !== generation.current) return;
        setState((previous) => {
          if (previous.status !== "ready") return previous;
          if (!result?.available) return { ...previous, loadingMore: false, moreFailed: true };
          const ids = new Set(previous.items.map((item) => item.id));
          return {
            ...previous,
            items: [...previous.items, ...(result.items ?? []).filter((item) => !ids.has(item.id))],
            nextCursor: result.nextCursor ?? null,
            totals: result.totals,
            loadingMore: false,
          };
        });
      },
      () => {
        if (current !== generation.current) return;
        setState((previous) =>
          previous.status === "ready"
            ? { ...previous, loadingMore: false, moreFailed: true }
            : previous
        );
      }
    );
  };

  const segmentLabel = (value: Segment) =>
    value === "all"
      ? t("dictionary.occurrences.segments.all")
      : value === "chg"
        ? t("dictionary.occurrences.segments.chg")
        : t(APPEARANCE_KIND_KEYS[value]);

  return (
    <div data-dictionary-occurrences>
      {state.status === "unavailable" ? (
        <p className="text-xs leading-relaxed text-muted-foreground" data-occurrences-unavailable>
          {t(usageUnavailableKey(state.reason))}
        </p>
      ) : (
        <>
          <div
            role="radiogroup"
            aria-label={t("dictionary.occurrences.segmentsLabel")}
            className="inline-flex flex-wrap gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5 dark:border-white/10 dark:bg-white/3"
          >
            {SEGMENTS.map((value) => {
              const count = state.status === "ready" ? state.totals[value] : null;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={segment === value}
                  data-occurrence-segment={value}
                  onClick={() => setSegment(value)}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    segment === value
                      ? "bg-background text-foreground shadow-sm dark:bg-white/10"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {segmentLabel(value)}
                  {count !== null && <span className="ms-1 tabular-nums opacity-75">{count}</span>}
                </button>
              );
            })}
          </div>
          {week && (
            <div className="mt-2">
              <span
                data-occurrences-week
                className="inline-flex items-center gap-1.5 rounded-full border border-primary/60 bg-primary/10 py-0.5 ps-2 pe-1 text-[11.5px] text-foreground"
              >
                {t("dictionary.detail.usage.weekOf", {
                  range: formatWeekRange(week, i18n.language),
                })}
                <button
                  type="button"
                  onClick={onClearWeek}
                  aria-label={t("dictionary.occurrences.clearWeek")}
                  className="grid size-4 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <X size={10} />
                </button>
              </span>
            </div>
          )}
          {state.status === "loading" ? (
            <div className="flex justify-center py-3">
              <Loader2 size={14} className="animate-spin text-muted-foreground" />
            </div>
          ) : state.items.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">{t("dictionary.occurrences.none")}</p>
          ) : (
            <ul className="mt-1.5" data-occurrence-list>
              {state.items.map((item) => (
                <OccurrenceRow key={item.id} item={item} />
              ))}
            </ul>
          )}
          {state.status === "ready" && (state.nextCursor || state.moreFailed) && (
            <div className="mt-1 flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={state.loadingMore}
                onClick={loadMore}
                data-occurrences-more
              >
                {state.loadingMore && <Loader2 size={12} className="animate-spin" />}
                {t(state.moreFailed ? "common.retry" : "dictionary.occurrences.more")}
              </Button>
            </div>
          )}
          {state.status === "ready" && state.unaligned > 0 && (
            <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">
              {t("dictionary.occurrences.unaligned", { count: state.unaligned })}
            </p>
          )}
        </>
      )}
      <button
        type="button"
        onClick={() => requestOpenHistoryForWord(word)}
        data-show-in-history
        className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline focus-visible:underline focus-visible:outline-none"
      >
        {t("dictionary.occurrences.showInHistory")}
        <ExternalLink size={11} />
      </button>
    </div>
  );
}
