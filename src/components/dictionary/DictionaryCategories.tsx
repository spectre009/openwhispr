import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ArrowRight, ChevronLeft, Loader2, Sparkles, X } from "../icons";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { CARD_SURFACE_CLASS } from "../ui/surfaces";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { selectPolicyEffectiveSettings, useSettingsStore } from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { getProviderDisplayName } from "../../models/ModelRegistry";
import { useDictionarySourcesStore } from "../../stores/dictionarySourcesStore";
import { useDictionaryUsageStore } from "../../stores/dictionaryUsageStore";
import { useGlossaryStore } from "../../stores/glossaryStore";
import {
  setDictionaryCategories,
  useDictionaryCategoriesStore,
} from "../../stores/dictionaryCategoriesStore";
import {
  askCategoryReview,
  cancelCategoryReview,
  dismissCategoryProposal,
  markCategoryProposalsAccepted,
  useDictionaryCategoryReviewStore,
} from "../../stores/dictionaryCategoryReviewStore";
import {
  categoryReviewModelOptions,
  type ReviewModelOption,
} from "../../services/dictionaryCategoryReview";
import {
  buildDictionaryCategoryReviewRequest,
  type CategoryProposal,
} from "../../utils/dictionaryCategoryReview";
import {
  effectiveDictionaryCategory,
  type DictionaryCategory,
} from "../../utils/dictionaryCategories";
import { glossaryCanonicalTerms } from "../../utils/glossary";
import { estimateDictionaryTokens, selectCleanupDictionary } from "../../utils/snippets";
import { describeProviderError, openProviderSettings } from "../../utils/describeProviderError";
import {
  dictionaryCategoryFilterCounts,
  type DictionaryListItem,
} from "../../utils/dictionaryList";
import DictionaryCategoryPill from "./DictionaryCategoryPill";
import {
  CATEGORY_DOT_CLASS,
  CATEGORY_NAME_KEYS,
  CATEGORY_PILL_CLASS,
  categoryKey,
} from "./categoryStyles";
import type { CategoryKey } from "./categoryStyles";
import { CLEANUP_SET_KEYS } from "./dictionaryLabels";

// "Sort into categories" (the Dictionary page, in place of the list, like
// Tidy up; Esc or "Back to the list" returns): how many words each category
// has, the unsorted words with a pick each, and "Ask a model": one request
// to a configured model with only the words and each one's current category
// and who set it (services/dictionaryCategoryReview.ts). Its proposals show
// as current → proposed with the reason; Accept (one) and Accept all store
// them as the model's choice, Accept all never over a choice of yours, ✕
// dismisses for the session; nothing is stored without a click. The notes
// say what categories do (the cleanup prompt's grouping and word set, Tidy
// up) and link to the settings.

type Translate = (key: string, options?: Record<string, unknown>) => string;

const CARD_ORDER: readonly CategoryKey[] = ["people", "work", "everyday", "unsorted"];

const CARD_DESCRIPTION_KEYS: Record<CategoryKey, string> = {
  people: "dictionary.categories.cards.people",
  work: "dictionary.categories.cards.work",
  everyday: "dictionary.categories.cards.everyday",
  unsorted: "dictionary.categories.cards.unsorted",
};

const ROLE_KEYS = {
  cleanup: "dictionary.tidy.review.roles.cleanup",
  chat: "dictionary.tidy.review.roles.chat",
  assistant: "dictionary.tidy.review.roles.assistant",
} as const;

function providerLabel(provider: string, t: Translate): string {
  if (provider === "openwhispr") return t("settingsPage.aiModels.modes.openwhispr");
  if (provider === "local") return t("settingsPage.aiModels.modes.local");
  if (provider === "self-hosted") return t("settingsPage.aiModels.modes.selfHosted");
  return getProviderDisplayName(provider);
}

function optionLabel(option: ReviewModelOption, t: Translate): string {
  const roles = option.roles.map((role) => t(ROLE_KEYS[role])).join(" + ");
  return [roles, option.modelName, providerLabel(option.provider, t)].filter(Boolean).join(" · ");
}

/** A category as a still pill (no menu): "● Work terms". */
function CategoryTag({
  category,
  who,
}: {
  category: DictionaryCategory | null;
  who?: string | null;
}) {
  const { t } = useTranslation();
  const key = categoryKey(category);
  return (
    <span
      data-category-tag={key}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px]",
        CATEGORY_PILL_CLASS[key]
      )}
    >
      {category && (
        <span
          aria-hidden="true"
          className={cn("inline-block h-1.5 w-1.5 rounded-full", CATEGORY_DOT_CLASS[key])}
        />
      )}
      {t(CATEGORY_NAME_KEYS[key])}
      {who && <span className="text-[9.5px] text-muted-foreground">{who}</span>}
    </span>
  );
}

type ProposalStatus = "pending" | "userKept" | "same" | "accepted";

interface ShownProposal {
  proposal: CategoryProposal;
  item: DictionaryListItem;
  status: ProposalStatus;
}

export interface DictionaryCategoriesProps {
  /** The list's items, with their effective categories. */
  items: readonly DictionaryListItem[];
  onClose: () => void;
  /** Opens Settings at a destination (`page#settingId`). */
  onOpenSettings?: (destination: string) => void;
}

export default function DictionaryCategories({
  items,
  onClose,
  onOpenSettings,
}: DictionaryCategoriesProps) {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ready = useDictionaryCategoriesStore((s) => s.ready);
  const review = useDictionaryCategoryReviewStore((s) => s.review);
  const dismissed = useDictionaryCategoryReviewStore((s) => s.dismissed);
  const accepted = useDictionaryCategoryReviewStore((s) => s.accepted);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const counts = useMemo(() => dictionaryCategoryFilterCounts(items), [items]);
  const unsorted = useMemo(() => items.filter((item) => item.category === null), [items]);
  const itemsByWord = useMemo(() => new Map(items.map((item) => [item.word, item])), [items]);

  // ─── Ask a model ───
  const policyState = usePolicySnapshot();
  const settings = useSettingsStore(
    useShallow((state) => selectPolicyEffectiveSettings(state, policyState))
  );
  const options = useMemo(() => categoryReviewModelOptions(settings), [settings]);
  const option = options.find((entry) => entry.id === chosen) ?? options[0] ?? null;
  const request = useMemo(
    () =>
      buildDictionaryCategoryReviewRequest({
        entries: items.map((item) => ({
          word: item.word,
          category: item.category,
          source: item.categorySource,
        })),
        uiLanguage: i18n.language,
      }),
    [items, i18n.language]
  );
  const running = review.status === "running";
  const error = review.status === "error" ? describeProviderError(review.error, t) : null;

  const ask = () => {
    if (!option || request.words.length === 0) return;
    setNotice(null);
    void askCategoryReview({
      option: {
        ...option,
        modelName: option.modelName || providerLabel(option.provider, t),
      },
      request,
    });
  };

  const shown = useMemo<ShownProposal[]>(() => {
    if (review.status !== "done") return [];
    const list: ShownProposal[] = [];
    for (const proposal of review.proposals) {
      if (dismissed.has(proposal.id)) continue;
      const item = itemsByWord.get(proposal.word);
      if (!item) continue;
      const same = item.category === proposal.category;
      const status: ProposalStatus =
        same && accepted.has(proposal.id)
          ? "accepted"
          : same
            ? "same"
            : item.categorySource === "user"
              ? "userKept"
              : "pending";
      list.push({ proposal, item, status });
    }
    return list;
  }, [review, dismissed, accepted, itemsByWord]);
  const acceptable = shown.filter((entry) => entry.status === "pending");

  const store = async (entries: readonly ShownProposal[]) => {
    if (entries.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await setDictionaryCategories(
        entries.map((entry) => ({
          word: entry.proposal.word,
          category: entry.proposal.category,
          source: "model" as const,
        }))
      );
      if (result.success) {
        markCategoryProposalsAccepted(entries.map((entry) => entry.proposal.id));
        setNotice(t("dictionary.categories.review.acceptedNotice", { count: result.changed }));
      } else {
        setNotice(t("dictionary.categories.setFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  const pick = (word: string, category: DictionaryCategory | null) => {
    void setDictionaryCategories([{ word, category, source: "user" }]).then((result) => {
      if (!result.success) setNotice(t("dictionary.categories.setFailed"));
    });
  };

  // ─── What categories do (the notes) ───
  const customDictionary = useSettingsStore((s) => s.customDictionary);
  const snippets = useSettingsStore((s) => s.snippets);
  const grouping = useSettingsStore((s) => s.cleanupDictionaryGrouping);
  const wordSet = useSettingsStore((s) => s.cleanupDictionaryWords);
  const learned = useDictionarySourcesStore((s) => s.learned);
  const sourcesLoaded = useDictionarySourcesStore((s) => s.loaded);
  const pinned = useDictionarySourcesStore((s) => s.pinned);
  const missed = useDictionaryUsageStore((s) => s.missed);
  const stored = useDictionaryCategoriesStore((s) => s.stored);
  const commonWords = useDictionaryCategoriesStore((s) => s.commonWords);
  const glossaryRules = useGlossaryStore((s) => s.rules);
  const savings = useMemo(() => {
    if (!ready) return null;
    const glossaryTerms = glossaryCanonicalTerms(glossaryRules);
    const sources = {
      learned: sourcesLoaded ? learned : null,
      pinned,
      missed,
      categories: (word: string) => effectiveDictionaryCategory(word, stored, commonWords).category,
    };
    const all = selectCleanupDictionary(
      { customDictionary, snippets, cleanupDictionaryWords: "all" },
      sources,
      glossaryTerms
    );
    const lean = selectCleanupDictionary(
      { customDictionary, snippets, cleanupDictionaryWords: "noEveryday" },
      sources,
      glossaryTerms
    );
    return {
      words: all.scope.words - lean.scope.words,
      tokens: estimateDictionaryTokens(all.words) - estimateDictionaryTokens(lean.words),
    };
  }, [
    ready,
    glossaryRules,
    sourcesLoaded,
    learned,
    pinned,
    missed,
    stored,
    commonWords,
    customDictionary,
    snippets,
  ]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // A select's or menu's popover is portalled: its Esc closes it, not this view.
    if (!containerRef.current?.contains(event.target as Node)) return;
    event.preventDefault();
    onClose();
  };

  const format = (n: number) => n.toLocaleString(i18n.language);

  return (
    <div
      ref={containerRef}
      data-dictionary-categories
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-semibold text-foreground focus:outline-none"
          >
            {t("dictionary.categories.title")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("dictionary.categories.subtitle")}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onClose} data-categories-close>
          <ChevronLeft size={12} className="rtl:-scale-x-100" />
          {t("dictionary.tidy.close")}
        </Button>
      </div>

      {!ready && (
        <p role="status" className="text-xs text-muted-foreground" data-categories-loading>
          {t("dictionary.categories.loading")}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4" data-categories-cards>
        {CARD_ORDER.map((key) => (
          <div
            key={key}
            data-category-card={key}
            className={cn(CARD_SURFACE_CLASS, "flex flex-col gap-1 px-3.5 py-3")}
          >
            <span>
              <CategoryTag category={key === "unsorted" ? null : key} />
            </span>
            <span
              className="text-[22px] font-semibold tabular-nums text-foreground"
              data-category-count
            >
              {format(counts[key])}
            </span>
            <span className="text-[11px] leading-snug text-muted-foreground">
              {t(CARD_DESCRIPTION_KEYS[key])}
            </span>
          </div>
        ))}
      </div>

      {/* ─── Ask a model ─── */}
      <section
        aria-labelledby="dictionary-categories-model"
        data-categories-review
        className={cn(CARD_SURFACE_CLASS, "flex flex-col gap-2 px-4 py-3")}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Sparkles size={13} aria-hidden="true" className="text-primary" />
          <div className="min-w-0 flex-1">
            <h3
              id="dictionary-categories-model"
              className="text-[13px] font-semibold text-foreground"
            >
              {t("dictionary.categories.review.title")}
            </h3>
            <p className="text-xs text-muted-foreground" data-categories-review-estimate>
              {t("dictionary.categories.review.estimate", {
                count: request.words.length,
                tokens: format(request.estimatedTokens),
              })}
            </p>
          </div>
          {options.length === 0 ? null : (
            <>
              <Select
                value={option?.id ?? ""}
                onValueChange={(value) => setChosen(value)}
                disabled={running}
              >
                <SelectTrigger
                  className="h-8 w-auto min-w-[14rem] max-w-full rounded-lg text-xs"
                  aria-label={t("dictionary.tidy.review.modelLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id} className="text-xs">
                      {optionLabel(entry, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {running ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-categories-review-cancel
                  onClick={cancelCategoryReview}
                >
                  {t("dictionary.tidy.review.cancel")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  data-categories-review-ask
                  disabled={!option || request.words.length === 0}
                  onClick={ask}
                >
                  {t("dictionary.categories.review.ask")}
                </Button>
              )}
            </>
          )}
        </div>
        {options.length === 0 && (
          <p className="text-xs text-muted-foreground" data-categories-review-none>
            {t("dictionary.tidy.review.noModels")}
          </p>
        )}
        {running && (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            {t("dictionary.tidy.review.running", { model: review.modelName })}
          </p>
        )}
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
            <span>{error.description || t("dictionary.categories.review.failed")}</span>
            {error.settingsTarget && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openProviderSettings(error.settingsTarget!)}
              >
                {t("providerErrors.openSettings")}
              </Button>
            )}
          </div>
        )}
        {review.status === "dropped" && (
          <p role="status" data-categories-review-dropped className="text-xs text-muted-foreground">
            {t(`dictionary.categories.review.${review.reason}`)}
          </p>
        )}
      </section>

      {/* ─── The model's proposals ─── */}
      {review.status === "done" && (
        <section
          aria-labelledby="dictionary-categories-proposals"
          data-categories-proposals
          className={cn(CARD_SURFACE_CLASS, "overflow-hidden")}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 bg-primary/[0.04] px-4 py-2.5 dark:border-white/8">
            <h3
              id="dictionary-categories-proposals"
              className="text-[13px] font-semibold text-foreground"
            >
              {t("dictionary.categories.review.proposalsTitle")}
            </h3>
            <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
              {review.kept === 0
                ? t("dictionary.categories.review.none", { model: review.modelName })
                : t("dictionary.categories.review.kept", {
                    count: review.kept,
                    model: review.modelName,
                    shown: shown.length,
                  })}
              {review.dropped > 0 &&
                ` ${t("dictionary.categories.review.dropped", { count: review.dropped })}`}
            </p>
            <Button
              size="sm"
              data-categories-accept-all
              disabled={busy || acceptable.length === 0}
              onClick={() => void store(acceptable)}
            >
              {t("dictionary.categories.review.acceptAll", { count: acceptable.length })}
            </Button>
          </div>
          {shown.length > 0 && (
            <ul>
              {shown.map((entry) => (
                <ProposalRow
                  key={entry.proposal.id}
                  entry={entry}
                  busy={busy}
                  onAccept={() => void store([entry])}
                  onDismiss={() => dismissCategoryProposal(entry.proposal.id)}
                />
              ))}
            </ul>
          )}
          {notice && (
            <p
              role="status"
              className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground dark:border-white/8"
            >
              {notice}
            </p>
          )}
        </section>
      )}

      {/* ─── The unsorted words, each with a pick ─── */}
      <section
        aria-labelledby="dictionary-categories-unsorted"
        data-categories-unsorted
        className={cn(CARD_SURFACE_CLASS, "overflow-hidden")}
      >
        <div className="border-b border-border/60 px-4 py-2.5 dark:border-white/8">
          <h3
            id="dictionary-categories-unsorted"
            className="text-[13px] font-semibold text-foreground"
          >
            {t("dictionary.categories.unsorted.title", { count: unsorted.length })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {unsorted.length === 0
              ? t("dictionary.categories.unsorted.none")
              : t("dictionary.categories.unsorted.hint")}
          </p>
        </div>
        {unsorted.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-2 px-4 py-3">
            {unsorted.map((item) => (
              <li
                key={item.word}
                data-categories-unsorted-word={item.word}
                className="flex items-center gap-1.5 text-xs"
              >
                <span dir="auto" className="font-medium text-foreground">
                  {item.word}
                </span>
                <DictionaryCategoryPill
                  word={item.word}
                  category={item.category}
                  source={item.categorySource}
                  onChange={pick}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ─── What categories do ─── */}
      <section
        aria-labelledby="dictionary-categories-notes"
        data-categories-notes
        className={cn(CARD_SURFACE_CLASS, "px-4 py-3")}
      >
        <h3
          id="dictionary-categories-notes"
          className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t("dictionary.categories.notes.title")}
        </h3>
        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">{t("dictionary.categories.notes.filterLabel")}</dt>
          <dd className="text-foreground/85">{t("dictionary.categories.notes.filter")}</dd>
          <dt className="text-muted-foreground">
            {t("dictionary.categories.notes.groupingLabel")}
          </dt>
          <dd className="text-foreground/85" data-categories-note-grouping>
            {t("dictionary.categories.notes.grouping")}{" "}
            <span className="text-muted-foreground">
              {t(
                grouping
                  ? "dictionary.categories.notes.groupingOn"
                  : "dictionary.categories.notes.groupingOff"
              )}
            </span>
            {onOpenSettings && (
              <>
                {" "}
                <button
                  type="button"
                  data-categories-open-grouping
                  onClick={() => onOpenSettings("cleanup#dictation.cleanup.dictionaryGrouping")}
                  className="text-primary hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  {t("dictionary.categories.notes.openSettings")}
                </button>
              </>
            )}
          </dd>
          <dt className="text-muted-foreground">{t("dictionary.categories.notes.wordSetLabel")}</dt>
          <dd className="text-foreground/85" data-categories-note-word-set>
            {savings
              ? t("dictionary.categories.notes.wordSet", {
                  count: savings.words,
                  tokens: format(savings.tokens),
                })
              : t("dictionary.categories.notes.wordSetUnavailable")}{" "}
            <span className="text-muted-foreground">
              {t("dictionary.categories.notes.wordSetNow", { set: t(CLEANUP_SET_KEYS[wordSet]) })}
            </span>
            {onOpenSettings && (
              <>
                {" "}
                <button
                  type="button"
                  data-categories-open-word-set
                  onClick={() => onOpenSettings("cleanup#dictation.cleanup.dictionaryWords")}
                  className="text-primary hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  {t("dictionary.categories.notes.openSettings")}
                </button>
              </>
            )}
          </dd>
          <dt className="text-muted-foreground">{t("dictionary.categories.notes.tidyLabel")}</dt>
          <dd className="text-foreground/85">{t("dictionary.categories.notes.tidy")}</dd>
        </dl>
        <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
          {t("dictionary.categories.notes.local")}
        </p>
      </section>
    </div>
  );
}

function ProposalRow({
  entry,
  busy,
  onAccept,
  onDismiss,
}: {
  entry: ShownProposal;
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const { proposal, item, status } = entry;
  const same = status === "same" || status === "accepted";
  const who =
    item.categorySource === "auto"
      ? t("dictionary.categories.source.auto")
      : item.categorySource === "user"
        ? t("dictionary.categories.source.user")
        : t("dictionary.categories.source.model");
  return (
    <li
      data-category-proposal={proposal.word}
      data-proposal-status={status}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-b border-border/50 px-4 py-2.5 text-xs last:border-b-0 sm:grid-cols-[minmax(7rem,0.8fr)_auto_auto_auto_minmax(0,1.6fr)_auto] dark:border-white/8"
    >
      <span dir="auto" className="min-w-0 truncate font-semibold text-foreground">
        {proposal.word}
      </span>
      <span className="hidden sm:inline">
        <CategoryTag category={item.category} who={item.category ? who : null} />
      </span>
      <span aria-hidden="true" className="hidden text-muted-foreground sm:inline">
        {same ? "=" : <ArrowRight size={11} className="rtl:-scale-x-100" />}
      </span>
      <span className="hidden sm:inline">
        <CategoryTag category={proposal.category} />
      </span>
      <p dir="auto" className="col-span-2 min-w-0 text-muted-foreground sm:col-span-1">
        <span className="sr-only">
          {t("dictionary.categories.review.change", {
            from: t(CATEGORY_NAME_KEYS[categoryKey(item.category)]),
            to: t(CATEGORY_NAME_KEYS[proposal.category]),
          })}{" "}
        </span>
        {proposal.reason}
      </p>
      <div className="col-start-2 row-start-1 flex flex-wrap items-center justify-end gap-1.5 sm:col-start-auto sm:row-start-auto">
        {status === "accepted" ? (
          <span className="text-[11px] text-success" data-proposal-tag>
            {t("dictionary.categories.review.accepted")}
          </span>
        ) : status === "same" ? (
          <span className="text-[11px] text-muted-foreground" data-proposal-tag>
            {t("dictionary.categories.review.noChange")}
          </span>
        ) : (
          <>
            {status === "userKept" && (
              <span className="text-[11px] text-muted-foreground" data-proposal-tag>
                {t("dictionary.categories.review.userKept")}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              data-proposal-accept
              aria-label={t("dictionary.categories.review.acceptLabel", {
                word: proposal.word,
                category: t(CATEGORY_NAME_KEYS[proposal.category]),
              })}
              onClick={onAccept}
            >
              {t("dictionary.categories.review.accept")}
            </Button>
          </>
        )}
        {status !== "accepted" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            data-proposal-dismiss
            aria-label={t("dictionary.categories.review.dismissLabel", { word: proposal.word })}
            onClick={onDismiss}
          >
            <X size={12} />
          </Button>
        )}
      </div>
    </li>
  );
}
