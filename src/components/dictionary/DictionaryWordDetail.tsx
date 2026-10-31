import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Pencil, Trash2, Wand2, X } from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../lib/utils";
import { formatRelativeTime, formatShortDate, normalizeDbDate } from "../../utils/dateFormatting";
import { requestOpenHistoryItem } from "../../utils/openHistoryItem";
import { similarWordsFor, type SimilarReason } from "../../utils/dictionarySimilar";
import { isSpeechMissed } from "../../helpers/dictionaryUsage.js";
import type { DictionaryListItem } from "../../utils/dictionaryList";
import type { DictionaryUsageWeek, DictionarySuggestionEvidence } from "../../types/electron";
import type { DictionaryCoverage } from "./useDictionaryCoverage";
import { COVERAGE_DOT_CLASS } from "./coverageStyles";
import { usageUnavailableKey, type CleanupInclusion } from "./dictionaryLabels";

// One dictionary word in full (the Dictionary page's side panel, or an
// overlay on a narrow window): when it was added and by whom, heard and
// written per week over 90 days of local History, where it's sent (the speech
// model, cleanup, chat), what it replaced when auto-learn picked it up (this
// account's evidence, each with Open in History), similar words in the
// dictionary, and its actions. Counts come from main; nothing is logged.

export interface DictionaryWordDetailProps {
  item: DictionaryListItem;
  coverage: DictionaryCoverage;
  cleanup: CleanupInclusion;
  /** Every listed word, for similar words. */
  words: readonly string[];
  itemsByWord: ReadonlyMap<string, DictionaryListItem>;
  /** Why heard/written isn't available ("history-off", …), or null when it is. */
  usageUnavailableReason: string | null;
  overlay: boolean;
  onClose: () => void;
  onOpenWord: (word: string) => void;
  onRename: (from: string, to: string) => Promise<boolean>;
  onRemove: (word: string) => void;
  onSetPinned: (word: string, pinned: boolean) => void;
  onMarkTyped: (word: string) => void;
  onMakeGlossaryRule: (word: string) => void;
}

const SIMILAR_REASON_KEYS: Record<SimilarReason, string> = {
  variant: "dictionary.detail.similar.variant",
  plural: "dictionary.detail.similar.plural",
  near: "dictionary.detail.similar.near",
};

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border/60 bg-card/40 px-3 py-2.5 dark:border-white/10">
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
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

function UsageBars({ weeks }: { weeks: DictionaryUsageWeek[] }) {
  const { t, i18n } = useTranslation();
  const max = Math.max(1, ...weeks.map((week) => Math.max(week.heard, week.written)));
  const month = (iso: string) =>
    normalizeDbDate(iso).toLocaleDateString(i18n.language, { month: "short" });
  const heard = weeks.reduce((sum, week) => sum + week.heard, 0);
  const written = weeks.reduce((sum, week) => sum + week.written, 0);
  return (
    <div>
      <div
        role="img"
        aria-label={t("dictionary.detail.usage.chartLabel", { heard, written })}
        className="flex h-12 items-end gap-[3px]"
        data-dictionary-usage-chart
      >
        {weeks.map((week) => (
          <div key={week.start} className="flex h-full flex-1 items-end gap-px">
            <span
              className="block flex-1 rounded-t-sm bg-primary/60"
              style={{ height: `${(week.heard / max) * 100}%` }}
            />
            <span
              className="block flex-1 rounded-t-sm bg-foreground/25"
              style={{ height: `${(week.written / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-muted-foreground" aria-hidden>
        <span>{weeks.length > 0 ? month(weeks[0].start) : ""}</span>
        <span>{weeks.length > 6 ? month(weeks[Math.floor(weeks.length / 2)].start) : ""}</span>
        <span>{weeks.length > 0 ? month(weeks[weeks.length - 1].start) : ""}</span>
      </div>
      <div className="mt-1 flex gap-3 text-[10.5px] text-muted-foreground" aria-hidden>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-primary/60" />
          {t("dictionary.detail.usage.heardLegend")}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-foreground/25" />
          {t("dictionary.detail.usage.writtenLegend")}
        </span>
      </div>
    </div>
  );
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
  onMakeGlossaryRule,
}: DictionaryWordDetailProps) {
  const { t, i18n } = useTranslation();
  const word = item.word;
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [evidence, setEvidence] = useState<EvidenceState>({ status: "loading" });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(word);
  const [saving, setSaving] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setEditing(false);
    setDraft(word);
  }, [word]);

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
  }, [word, item.usage?.heard, item.usage?.written]);

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
        <Card title={t("dictionary.detail.usage.title")}>
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
              {counts && (
                <Row label={t("dictionary.detail.usage.last90")}>
                  {t("dictionary.detail.usage.totals", {
                    heard: counts.heard,
                    written: counts.written,
                  })}
                </Row>
              )}
              {usage.status === "ready" && <UsageBars weeks={usage.weeks} />}
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
          </Row>
          <Row label={t("dictionary.detail.where.cleanupLabel")}>
            {t(cleanup.key, cleanup.params)}
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
                          ? t("dictionary.list.heardWritten", {
                              heard: other.usage.heard,
                              written: other.usage.written,
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
