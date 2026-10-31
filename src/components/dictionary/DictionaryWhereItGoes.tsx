import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "../icons";
import { cn } from "../lib/utils";
import { CARD_SURFACE_CLASS } from "../ui/surfaces";
import CleanupDictionaryWordsSetting from "../settings/CleanupDictionaryWordsSetting";
import CleanupDictionaryGroupingSetting from "../settings/CleanupDictionaryGroupingSetting";
import { getSettings, useSettingsStore } from "../../stores/settingsStore";
import { useDictionarySourcesStore } from "../../stores/dictionarySourcesStore";
import { useDictionaryUsageStore } from "../../stores/dictionaryUsageStore";
import { useDictionaryCategoriesStore } from "../../stores/dictionaryCategoriesStore";
import { useGlossaryStore } from "../../stores/glossaryStore";
import { glossaryCanonicalTerms } from "../../utils/glossary";
import { effectiveDictionaryCategory } from "../../utils/dictionaryCategories";
import {
  CLEANUP_DICTIONARY_SETTINGS,
  estimateDictionaryTokens,
  getDictionaryHintWords,
  selectCleanupDictionary,
  type CleanupDictionarySetting,
} from "../../utils/snippets";
import type { CleanupScopeCount } from "../../types/electron";
import type { DictionaryCoverage } from "./useDictionaryCoverage";
import {
  CLEANUP_SET_KEYS,
  approxTokens,
  speechBudgetText,
  speechSetupName,
} from "./dictionaryLabels";

// The Dictionary page's "Where it goes": what the dictionary costs each place
// it's sent. A strip of three (speech-to-text, the cleanup prompt, chat and
// the assistant) that opens into the details: the speech model's budget and
// cut, cleanup's word set (the setting, mirrored) with every set's size, a
// monthly estimate from your dictation pace and how past cleanups ran with
// each set, and chat's full list. Every token count is an estimate (≈
// characters ÷ 4).

function useCleanupNumbers() {
  const customDictionary = useSettingsStore((s) => s.customDictionary);
  const snippets = useSettingsStore((s) => s.snippets);
  const setting = useSettingsStore((s) => s.cleanupDictionaryWords);
  const grouping = useSettingsStore((s) => s.cleanupDictionaryGrouping);
  const cleanupOn = useSettingsStore((s) => s.useCleanupModel);
  const learned = useDictionarySourcesStore((s) => s.learned);
  const sourcesLoaded = useDictionarySourcesStore((s) => s.loaded);
  const pinned = useDictionarySourcesStore((s) => s.pinned);
  const missed = useDictionaryUsageStore((s) => s.missed);
  const perDay = useDictionaryUsageStore((s) => s.perDay);
  const categoriesReady = useDictionaryCategoriesStore((s) => s.ready);
  const storedCategories = useDictionaryCategoriesStore((s) => s.stored);
  const commonWords = useDictionaryCategoriesStore((s) => s.commonWords);
  const glossaryRules = useGlossaryStore((s) => s.rules);
  return useMemo(() => {
    const glossaryTerms = glossaryCanonicalTerms(glossaryRules);
    const sources = {
      learned: sourcesLoaded ? learned : null,
      pinned,
      missed,
      categories: categoriesReady
        ? (word: string) =>
            effectiveDictionaryCategory(word, storedCategories, commonWords).category
        : null,
    };
    const settings = {
      customDictionary,
      snippets,
      cleanupDictionaryWords: setting,
      cleanupDictionaryGrouping: grouping,
    };
    const current = selectCleanupDictionary(settings, sources, glossaryTerms);
    const tokens = estimateDictionaryTokens(current.words);
    const chatWords = getDictionaryHintWords({ customDictionary, snippets }, glossaryTerms);
    return {
      setting,
      applied: current.scope.applied,
      grouped: !!current.groups,
      words: current.scope.words,
      tokens,
      monthly: perDay != null && perDay > 0 ? Math.round(tokens * perDay * 30) : null,
      chatTokens: estimateDictionaryTokens(chatWords),
      chatWords: customDictionary.length,
      cleanupOn: cleanupOn === true && getSettings().useCleanupModel === true,
    };
  }, [
    customDictionary,
    snippets,
    setting,
    grouping,
    cleanupOn,
    learned,
    sourcesLoaded,
    pinned,
    missed,
    perDay,
    categoriesReady,
    storedCategories,
    commonWords,
    glossaryRules,
  ]);
}

function Meter({ used, limit }: { used: number; limit: number | null }) {
  if (!limit) return null;
  const share = Math.max(0, Math.min(1, used / limit));
  return (
    <div
      aria-hidden="true"
      className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/8 dark:bg-white/10"
    >
      <div
        className={cn("h-full rounded-full", share >= 1 ? "bg-warning" : "bg-success")}
        style={{ width: `${share * 100}%` }}
      />
    </div>
  );
}

function ScopeCounts() {
  const { t, i18n } = useTranslation();
  const [result, setResult] = useState<
    | { status: "loading" }
    | { status: "unavailable" }
    | { status: "ready"; days: number; sets: CleanupScopeCount[] }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const answer = await window.electronAPI?.getDictionaryCleanupScopeCounts?.();
        if (cancelled) return;
        if (answer?.available) {
          setResult({ status: "ready", days: answer.days, sets: answer.sets ?? [] });
        } else setResult({ status: "unavailable" });
      } catch {
        if (!cancelled) setResult({ status: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const format = (n: number) => new Intl.NumberFormat(i18n.language).format(n);
  // An average always shows one decimal, so "1.0 words" reads correctly.
  const formatAverage = (n: number) =>
    new Intl.NumberFormat(i18n.language, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(n);
  return (
    <div data-dictionary-scope-counts>
      <p className="text-xs font-medium text-foreground/80">
        {t("dictionary.where.cleanup.compareTitle")}
      </p>
      {result.status === "loading" ? null : result.status === "unavailable" ? (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {t("dictionary.where.cleanup.compareUnavailable")}
        </p>
      ) : result.sets.length === 0 ? (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {t("dictionary.where.cleanup.compareEmpty", { days: result.days })}
        </p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {result.sets.map((set) => (
            <li
              key={set.applied}
              className="flex items-baseline justify-between gap-3 text-[11.5px] text-foreground/75"
            >
              <span>
                {CLEANUP_DICTIONARY_SETTINGS.includes(set.applied as CleanupDictionarySetting)
                  ? t(CLEANUP_SET_KEYS[set.applied as CleanupDictionarySetting])
                  : set.applied}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {t("dictionary.where.cleanup.compareRow", {
                  count: set.dictations,
                  words: formatAverage(set.avgWords),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {result.status === "ready" && result.sets.length > 0 && (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {t("dictionary.where.cleanup.compareNote", { days: result.days })}
        </p>
      )}
    </div>
  );
}

interface DictionaryWhereItGoesProps {
  coverage: DictionaryCoverage;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Shows the list in send order (the strip's "Send order" link). */
  onShowSendOrder: () => void;
}

export default function DictionaryWhereItGoes({
  coverage,
  expanded,
  onExpandedChange,
  onShowSendOrder,
}: DictionaryWhereItGoesProps) {
  const { t, i18n } = useTranslation();
  const cleanup = useCleanupNumbers();
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const format = (n: number) => number.format(n);

  const setupName = speechSetupName(coverage.label, t);
  const budgetText = speechBudgetText(coverage, t, format);
  const readText =
    coverage.budget.readChars != null
      ? t("dictionary.where.speech.reads", { chars: format(coverage.budget.readChars) })
      : null;
  const cutText =
    coverage.notSent > 0 ? t("dictionary.where.speech.cut", { count: coverage.notSent }) : null;
  const setName = t(CLEANUP_SET_KEYS[cleanup.applied]);

  const cell = "min-w-0 px-4 py-3";
  const cellLabel = "text-[11px] text-muted-foreground";
  const cellValue = "mt-1 text-sm font-semibold text-foreground tabular-nums";
  const cellSub = "mt-1 text-[11px] leading-snug text-muted-foreground";

  return (
    <section
      aria-label={t("dictionary.where.title")}
      data-dictionary-where
      className={cn(CARD_SURFACE_CLASS, "overflow-hidden shadow-sm")}
    >
      <div className="grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-3 sm:divide-x sm:divide-y-0 rtl:sm:divide-x-reverse dark:divide-white/10">
        <div className={cell} data-where-cell="speech">
          <p className={cellLabel}>{t("dictionary.where.speech.label", { setup: setupName })}</p>
          <p className={cellValue}>{budgetText ?? t("dictionary.where.speech.noneShort")}</p>
          <Meter used={coverage.budget.used} limit={coverage.budget.limit} />
          <p className={cellSub}>
            {[cutText, readText].filter(Boolean).join(" · ")}
            {coverage.budget.unit && (
              <>
                {(cutText || readText) && " · "}
                <button
                  type="button"
                  onClick={onShowSendOrder}
                  className="text-primary hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  {t("dictionary.where.speech.sendOrder")}
                </button>
              </>
            )}
          </p>
        </div>
        <div className={cell} data-where-cell="cleanup">
          <p className={cellLabel}>{t("dictionary.where.cleanup.label")}</p>
          <p className={cellValue}>
            {cleanup.cleanupOn
              ? t("dictionary.where.cleanup.tokens", {
                  tokensText: approxTokens(t, cleanup.tokens),
                })
              : t("dictionary.where.cleanup.off")}
          </p>
          <p className={cellSub}>
            {[
              t("dictionary.where.cleanup.sends", { set: setName }),
              cleanup.grouped ? t("dictionary.where.cleanup.grouped") : null,
              cleanup.cleanupOn && cleanup.monthly != null
                ? t("dictionary.where.cleanup.monthly", {
                    tokensText: approxTokens(t, cleanup.monthly, { compact: true }),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className={cell} data-where-cell="chat">
          <p className={cellLabel}>{t("dictionary.where.chat.label")}</p>
          <p className={cellValue}>
            {t("dictionary.where.chat.tokens", { tokensText: approxTokens(t, cleanup.chatTokens) })}
          </p>
          <p className={cellSub}>
            {t("dictionary.where.chat.allWords", { count: cleanup.chatWords })}
          </p>
        </div>
      </div>

      <div className="border-t border-border/60 dark:border-white/10">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
          className="flex w-full items-center justify-between gap-2 px-4 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:bg-foreground/5 focus-visible:outline-none"
        >
          <span>{t(expanded ? "dictionary.where.hide" : "dictionary.where.show")}</span>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {expanded && (
        <div
          data-dictionary-where-details
          className="space-y-4 border-t border-border/60 px-4 py-4 dark:border-white/10"
        >
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t("dictionary.where.title")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("dictionary.where.description")}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-border/60 p-3 dark:border-white/10">
              <h4 className="text-xs font-semibold text-foreground">
                {t("dictionary.where.speech.title")}
              </h4>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {coverage.budget.unit
                  ? t("dictionary.where.speech.channel", {
                      setup: setupName,
                      channel: t(`dictionary.where.speech.channels.${coverage.budget.unit}`),
                    })
                  : setupName}
              </p>
              <p className="mt-2 text-base font-semibold tabular-nums text-foreground">
                {budgetText ?? t("dictionary.where.speech.noneShort")}
              </p>
              <Meter used={coverage.budget.used} limit={coverage.budget.limit} />
              <ul className="mt-2 list-disc space-y-1 ps-4 text-[11.5px] leading-snug text-muted-foreground">
                {coverage.budget.unit ? (
                  <>
                    <li>{t("dictionary.where.speech.bias")}</li>
                    <li>{t("dictionary.where.speech.order")}</li>
                    {readText && <li>{t("dictionary.where.speech.tail")}</li>}
                    {cutText && <li>{cutText}</li>}
                  </>
                ) : (
                  <li>{t("dictionary.where.speech.none")}</li>
                )}
                <li>{t("dictionary.where.speech.estimate")}</li>
              </ul>
            </div>
            <div className="rounded-xl border border-border/60 p-3 dark:border-white/10">
              <h4 className="text-xs font-semibold text-foreground">
                {t("dictionary.where.cleanup.title")}
              </h4>
              <p className="mt-2 text-base font-semibold tabular-nums text-foreground">
                {cleanup.cleanupOn
                  ? t("dictionary.where.cleanup.tokens", {
                      tokensText: approxTokens(t, cleanup.tokens),
                    })
                  : t("dictionary.where.cleanup.off")}
              </p>
              {cleanup.cleanupOn && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {cleanup.monthly != null
                    ? t("dictionary.where.cleanup.monthlyDetail", {
                        tokensText: approxTokens(t, cleanup.monthly, { compact: true }),
                      })
                    : t("dictionary.where.cleanup.monthlyUnavailable")}
                </p>
              )}
              <div className="mt-3">
                <CleanupDictionaryWordsSetting />
              </div>
              <div className="mt-3">
                <CleanupDictionaryGroupingSetting />
              </div>
              <div className="mt-3">
                <ScopeCounts />
              </div>
            </div>
            <div className="rounded-xl border border-border/60 p-3 dark:border-white/10">
              <h4 className="text-xs font-semibold text-foreground">
                {t("dictionary.where.chat.title")}
              </h4>
              <p className="mt-2 text-base font-semibold tabular-nums text-foreground">
                {t("dictionary.where.chat.tokensDetail", {
                  tokensText: approxTokens(t, cleanup.chatTokens),
                })}
              </p>
              <ul className="mt-2 list-disc space-y-1 ps-4 text-[11.5px] leading-snug text-muted-foreground">
                <li>{t("dictionary.where.chat.sameList")}</li>
                <li>{t("dictionary.where.chat.snippets")}</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
