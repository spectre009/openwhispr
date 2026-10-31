import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Pencil, Trash2, Wand2, X } from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../lib/utils";
import { formatRelativeTime, formatShortDate } from "../../utils/dateFormatting";
import { requestOpenHistoryItem } from "../../utils/openHistoryItem";
import { similarWordsFor, type SimilarReason } from "../../utils/dictionarySimilar";
import { isSpeechMissed } from "../../helpers/dictionaryUsage.js";
import type { DictionaryListItem } from "../../utils/dictionaryList";
import type {
  DictionarySpeechVariant,
  DictionaryUsageWeek,
  DictionarySuggestionEvidence,
} from "../../types/electron";
import type { DictionaryCoverage } from "./useDictionaryCoverage";
import { COVERAGE_DOT_CLASS } from "./coverageStyles";
import {
  APPEARANCE_KIND_TEXT,
  usageParts,
  usageUnavailableKey,
  type CleanupInclusion,
} from "./dictionaryLabels";
import DictionaryUsageHistogram from "./DictionaryUsageHistogram";
import type { UsageWeekRange } from "./usageWeeks";
import DictionaryUsageExplainer from "./DictionaryUsageExplainer";
import DictionaryWordOccurrences from "./DictionaryWordOccurrences";
import DictionarySpeechVariants from "./DictionarySpeechVariants";
import DictionaryCategoryPill from "./DictionaryCategoryPill";
import type { DictionaryCategory } from "../../utils/dictionaryCategories";

// One dictionary word in full (the Dictionary page's side panel, or an
// overlay on a narrow window): when it was added and by whom, how often it
// was used over 90 days of local History and per week (speech got it, fixed
// after speech, changed after speech; a week's bar lists its dictations),
// what speech writes instead (with a glossary rule offered where it's safe),
// where it appeared (each dictation, opening in History), where it's sent
// (the speech model, cleanup, chat), what it replaced when auto-learn picked
// it up (this account's evidence), similar words, and its actions. Counts and
// History's own text come from main; nothing is logged. Everything read from
// History is read again when History, the dictionary or a snippet changes,
// and dropped when the owner or History's policy does.

export interface DictionaryWordDetailProps {
  item: DictionaryListItem;
  coverage: DictionaryCoverage;
  cleanup: CleanupInclusion;
  /** Every listed word, for similar words. */
  words: readonly string[];
  itemsByWord: ReadonlyMap<string, DictionaryListItem>;
  /** Why usage isn't available ("history-off", …), or null when it is. */
  usageUnavailableReason: string | null;
  overlay: boolean;
  onClose: () => void;
  onOpenWord: (word: string) => void;
  onRename: (from: string, to: string) => Promise<boolean>;
  onRemove: (word: string) => void;
  onSetPinned: (word: string, pinned: boolean) => void;
  onMarkTyped: (word: string) => void;
  /** A category picked from the panel's pill (null: back to automatic). */
  onSetCategory: (word: string, category: DictionaryCategory | null) => void;
  /** The rule editor for this word; from a speech variant, with that spelling and its evidence. */
  onMakeGlossaryRule: (word: string, variant?: DictionarySpeechVariant) => void;
}

const HISTORY_REFRESH_MS = 1_000;

const SIMILAR_REASON_KEYS: Record<SimilarReason, string> = {
  variant: "dictionary.detail.similar.variant",
  plural: "dictionary.detail.similar.plural",
  near: "dictionary.detail.similar.near",
};

function Card({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/60 bg-card/40 px-3 py-2.5 dark:border-white/10">
      <div className="mb-1.5 flex items-center gap-1.5">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground/85">{children}</span>
    </div>
  );
}

type UsageState =
  | { status: "loading" }
  | { status: "unavailable"; reason: string | null }
  | { status: "ready"; weeks: DictionaryUsageWeek[] };

type EvidenceState =
  | { status: "loading" }
  | { status: "unavailable"; reason: string | null }
  | { status: "ready"; evidence: DictionarySuggestionEvidence[] };

/**
 * Keys that make the panel read History again: `refresh` when History, the
 * dictionary or a snippet changed (debounced), `reset` when the owner or
 * History's policy did (everything shown is dropped at once).
 */
function useHistoryRefresh(): { refresh: number; reset: number } {
  const [refresh, setRefresh] = useState(0);
  const [reset, setReset] = useState(0);
  useEffect(() => {
    const api = window.electronAPI;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setRefresh((n) => n + 1);
      }, HISTORY_REFRESH_MS);
    };
    const now = () => setRefresh((n) => n + 1);
    const disposers = [
      api?.onTranscriptionAdded?.(soon),
      api?.onTranscriptionUpdated?.(soon),
      api?.onTranscriptionDeleted?.(now),
      api?.onTranscriptionsCleared?.(now),
      api?.onDictionaryUpdated?.(now),
      api?.onSnippetsUpdated?.(now),
      api?.onDictionaryHistoryChanged?.(() => setReset((n) => n + 1)),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      disposers.forEach((dispose) => dispose?.());
    };
  }, []);
  return { refresh, reset };
}

export default function DictionaryWordDetail({
  item,
  coverage,
  cleanup,
  words,
  itemsByWord,
  usageUnavailableReason,
  overlay,
  onClose,
  onOpenWord,
  onRename,
  onRemove,
  onSetPinned,
  onMarkTyped,
  onSetCategory,
  onMakeGlossaryRule,
}: DictionaryWordDetailProps) {
  const { t, i18n } = useTranslation();
  const word = item.word;
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [evidence, setEvidence] = useState<EvidenceState>({ status: "loading" });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(word);
  const [saving, setSaving] = useState(false);
  // A histogram week whose dictations "Where it appeared" lists.
  const [week, setWeek] = useState<UsageWeekRange | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { refresh, reset } = useHistoryRefresh();

  useEffect(() => {
    setEditing(false);
    setDraft(word);
    setWeek(null);
  }, [word]);

  // Another owner or policy: the week's bounds came from the old counts.
  useEffect(() => {
    setWeek(null);
  }, [reset]);

  // Over the list on a narrow window: focus moves in.
  useEffect(() => {
    if (overlay) closeRef.current?.focus();
  }, [overlay, word]);

  useEffect(() => {
    let cancelled = false;
    setUsage({ status: "loading" });
    setEvidence({ status: "loading" });
    const api = window.electronAPI;
    void (async () => {
      try {
        const result = await api?.getDictionaryWordUsage?.(word);
        if (cancelled) return;
        if (result?.available) setUsage({ status: "ready", weeks: result.weeks ?? [] });
        else {
          setUsage({
            status: "unavailable",
            reason: (result && "reason" in result && result.reason) || null,
          });
        }
      } catch {
        if (!cancelled) setUsage({ status: "unavailable", reason: null });
      }
    })();
    void (async () => {
      try {
        const result = await api?.getDictionaryWordEvidence?.(word);
        if (cancelled) return;
        if (result?.available) setEvidence({ status: "ready", evidence: result.evidence ?? [] });
        else setEvidence({ status: "unavailable", reason: result?.reason ?? null });
      } catch {
        if (!cancelled) setEvidence({ status: "unavailable", reason: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [word, item.usage?.heard, item.usage?.written, refresh, reset]);

  const similar = useMemo(() => similarWordsFor(word, words), [word, words]);

  const added = item.createdAt
    ? t("dictionary.detail.added", { when: formatShortDate(item.createdAt, i18n.language) })
    : t("dictionary.detail.addedUnknown");

  const speech = (() => {
    if (!coverage.budget.unit) return t("dictionary.detail.where.speechNone");
    if (item.coverage === "notSent" || item.rank == null) {
      return t("dictionary.detail.where.speechNotSent");
    }
    return t(`dictionary.detail.where.speech.${item.coverage}`, { rank: item.rank });
  })();

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === word) {
      setEditing(false);
      setDraft(word);
      return;
    }
    setSaving(true);
    try {
      if (await onRename(word, next)) setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const counts = item.usage;
  const missed = counts ? isSpeechMissed(counts) : false;
  const parts = counts ? usageParts(counts) : null;

  return (
    <div
      role="region"
      aria-label={t("dictionary.detail.label", { word })}
      data-dictionary-detail
      className="flex h-full min-h-0 flex-col bg-background"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !editing) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="shrink-0 border-b border-border/70 px-4 pt-4 pb-3 dark:border-white/10">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {editing ? (
              <Input
                dir="auto"
                autoFocus
                value={draft}
                aria-label={t("dictionary.detail.renameLabel", { word })}
                disabled={saving}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commit();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setEditing(false);
                    setDraft(word);
                  }
                }}
                className="h-9 text-base"
              />
            ) : (
              <h2
                dir="auto"
                className="flex items-center gap-2 break-words text-lg font-semibold text-foreground"
              >
                {item.pinned && (
                  <span className="text-sm text-primary" aria-hidden>
                    ★
                  </span>
                )}
                <span className="min-w-0 break-all">{word}</span>
              </h2>
            )}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span
                className={cn(
                  "rounded-full border px-1.5 py-px text-[10.5px]",
                  item.source === "manual"
                    ? "border-border text-foreground/80"
                    : "border-border/60 text-muted-foreground"
                )}
              >
                {t(
                  item.source === "manual" ? "dictionary.source.typed" : "dictionary.source.learned"
                )}
              </span>
              <span data-dictionary-detail-category>
                <DictionaryCategoryPill
                  word={word}
                  category={item.category}
                  source={item.categorySource}
                  onChange={onSetCategory}
                />
              </span>
              {item.pinned && <span>{t("dictionary.detail.pinned")}</span>}
              <span>{added}</span>
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("dictionary.detail.close")}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <Card title={t("dictionary.detail.usage.title")} aside={<DictionaryUsageExplainer />}>
          {usage.status === "unavailable" || usageUnavailableReason ? (
            <p className="text-xs leading-relaxed text-muted-foreground" data-usage-unavailable>
              {t(
                usageUnavailableKey(
                  usage.status === "unavailable" ? usage.reason : usageUnavailableReason
                )
              )}
            </p>
          ) : (
            <>
              {parts && (
                <p className="text-[13px] text-foreground/90" data-usage-totals>
                  <b className="font-semibold">
                    {t("dictionary.detail.usage.dictations", { count: parts.used })}
                  </b>
                  {" · "}
                  <span className={APPEARANCE_KIND_TEXT.ok}>
                    {t("dictionary.detail.usage.okCount", { count: parts.ok })}
                  </span>
                  {" · "}
                  <span className={APPEARANCE_KIND_TEXT.fix}>
                    {t("dictionary.detail.usage.fixCount", { count: parts.fix })}
                  </span>
                  {parts.chg > 0 && (
                    <>
                      {" · "}
                      <span className={APPEARANCE_KIND_TEXT.chg}>
                        {t("dictionary.detail.usage.chgCount", { count: parts.chg })}
                      </span>
                    </>
                  )}
                </p>
              )}
              {usage.status === "ready" && (
                <div className="mt-2">
                  <DictionaryUsageHistogram
                    weeks={usage.weeks}
                    selected={week?.start ?? null}
                    onSelect={setWeek}
                  />
                </div>
              )}
              {counts && counts.heard === 0 && counts.written === 0 && (
                <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                  {t("dictionary.detail.usage.never")}
                </p>
              )}
              {missed && (
                <p className="mt-1.5 text-[11px] leading-snug text-warning">
                  {t("dictionary.detail.usage.missed", { count: counts?.missedRows ?? 0 })}
                </p>
              )}
              <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">
                {t("dictionary.detail.usage.note")}
              </p>
            </>
          )}
        </Card>

        <Card title={t("dictionary.variants.title")}>
          <DictionarySpeechVariants
            key={`${word}\u0000${reset}`}
            word={word}
            refreshKey={refresh}
            onMakeRule={(variant) => onMakeGlossaryRule(word, variant)}
          />
        </Card>

        <Card title={t("dictionary.occurrences.title")}>
          <DictionaryWordOccurrences
            key={`${word}\u0000${reset}`}
            word={word}
            week={week}
            onClearWeek={() => setWeek(null)}
            refreshKey={refresh}
          />
        </Card>

        <Card title={t("dictionary.detail.where.title")}>
          <Row label={t("dictionary.detail.where.speechLabel")}>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  COVERAGE_DOT_CLASS[item.coverage]
                )}
              />
              {speech}
            </span>
            {item.pinned && item.pinRank != null && (
              <span className="mt-0.5 block text-primary" data-dictionary-pin-rank>
                {t("dictionary.detail.where.pinnedRank", { rank: item.pinRank })}
              </span>
            )}
          </Row>
          <Row label={t("dictionary.detail.where.cleanupLabel")}>
            <span data-dictionary-detail-cleanup>{t(cleanup.key, cleanup.params)}</span>
            {cleanup.grouped && (
              <span className="mt-0.5 block text-muted-foreground" data-dictionary-detail-group>
                {cleanup.grouped}
              </span>
            )}
          </Row>
          <Row label={t("dictionary.detail.where.chatLabel")}>
            {t("dictionary.detail.where.chatAlways")}
          </Row>
        </Card>

        <Card title={t("dictionary.detail.replaced.title")}>
          {evidence.status === "loading" ? null : evidence.status === "unavailable" ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("dictionary.detail.replaced.unavailable")}
            </p>
          ) : evidence.evidence.length === 0 ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("dictionary.detail.replaced.none")}
            </p>
          ) : (
            <ul className="space-y-1.5" data-dictionary-evidence>
              {evidence.evidence.map((row, index) => (
                <li
                  key={`${row.transcriptionId}-${index}`}
                  className="flex items-start gap-2 text-xs"
                >
                  <span className="min-w-0 flex-1 text-foreground/80">
                    {row.app
                      ? t("dictionary.detail.replaced.changedIn", {
                          replaced: row.replaced,
                          app: row.app,
                        })
                      : t("dictionary.detail.replaced.changed", { replaced: row.replaced })}
                    <span className="text-muted-foreground">
                      {" · "}
                      {formatRelativeTime(row.createdAt, t, i18n.language)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => requestOpenHistoryItem(row.transcriptionId)}
                    className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline focus-visible:underline focus-visible:outline-none"
                  >
                    {t("dictionary.detail.replaced.openInHistory")}
                    <ExternalLink size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t("dictionary.detail.similar.title")}>
          {similar.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("dictionary.detail.similar.none")}</p>
          ) : (
            <ul className="space-y-1" data-dictionary-similar>
              {similar.map((entry) => {
                const other = itemsByWord.get(entry.word);
                return (
                  <li key={entry.word} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <button
                      type="button"
                      dir="auto"
                      onClick={() => onOpenWord(entry.word)}
                      className="max-w-full truncate font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none"
                    >
                      {entry.word}
                    </button>
                    <span className="min-w-0 text-muted-foreground">
                      {[
                        t(SIMILAR_REASON_KEYS[entry.reason]),
                        other
                          ? t(
                              other.source === "manual"
                                ? "dictionary.source.typed"
                                : "dictionary.source.learned"
                            )
                          : null,
                        other?.usage
                          ? t("dictionary.list.usageShort", {
                              used: usageParts(other.usage).used,
                              ok: usageParts(other.usage).ok,
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border/70 px-4 py-3 dark:border-white/10">
        <Button size="sm" variant="outline" onClick={() => onSetPinned(word, !item.pinned)}>
          <span aria-hidden>{item.pinned ? "★" : "☆"}</span>
          {t(item.pinned ? "dictionary.detail.unpin" : "dictionary.detail.pin")}
        </Button>
        {item.source === "learned" && (
          <Button size="sm" variant="outline" onClick={() => onMarkTyped(word)}>
            {t("dictionary.actions.markTyped")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => (editing ? void commit() : setEditing(true))}
          disabled={saving}
        >
          <Pencil size={12} />
          {t(editing ? "dictionary.detail.saveSpelling" : "dictionary.detail.edit")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onMakeGlossaryRule(word)}>
          <Wand2 size={12} />
          {t("dictionary.detail.glossaryRule")}
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => onRemove(word)}
        >
          <Trash2 size={12} />
          {t("dictionary.actions.remove")}
        </Button>
      </div>
    </div>
  );
}
