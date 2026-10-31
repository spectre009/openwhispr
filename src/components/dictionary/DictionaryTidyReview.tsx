import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ArrowRight, Check, Loader2, Sparkles } from "../icons";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { CARD_SURFACE_CLASS } from "../ui/surfaces";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { selectPolicyEffectiveSettings, useSettingsStore } from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { getProviderDisplayName } from "../../models/ModelRegistry";
import {
  askModelReview,
  cancelModelReview,
  keepTidyItem,
  useDictionaryTidyStore,
} from "../../stores/dictionaryTidyStore";
import {
  buildDictionaryReviewRequest,
  reviewSuggestionOps,
  type ReviewSuggestion,
} from "../../utils/dictionaryReview";
import { reviewModelOptions, type ReviewModelOption } from "../../services/dictionaryReview";
import { describeProviderError, openProviderSettings } from "../../utils/describeProviderError";
import type { DictionaryListItem } from "../../utils/dictionaryList";
import type { DictionaryTidyOp } from "../../types/electron";
import { approxTokens } from "./dictionaryLabels";

// Tidy up's last group: "Ask a model". A select of the configured models that
// can review the list (the Cleanup, Chat and Voice Assistant models,
// services/dictionaryReview.ts), what the request sends and its ≈ size before
// it goes, Cancel while it runs, and the validated suggestions as items to
// select or apply one by one. Nothing changes without a click.

type Translate = (key: string, options?: Record<string, unknown>) => string;

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

/** "Cleanup · Claude Haiku 5.5 · GitHub Copilot". */
function reviewOptionLabel(option: ReviewModelOption, t: Translate): string {
  const roles = option.roles.map((role) => t(ROLE_KEYS[role])).join(" + ");
  return [roles, option.modelName, providerLabel(option.provider, t)].filter(Boolean).join(" · ");
}

/** The model as the results name it: "Claude Haiku 5.5", or its provider. */
function reviewModelName(option: ReviewModelOption, t: Translate): string {
  return option.modelName || providerLabel(option.provider, t);
}

interface Props {
  items: readonly DictionaryListItem[];
  usageAvailable: boolean;
  protectedKeys: ReadonlySet<string>;
  /** The review's suggestions still about words in the dictionary, not kept. */
  suggestions: ReviewSuggestion[];
  liveWords: readonly string[];
  busy: boolean;
  isSelected: (id: string) => boolean;
  onSelect: (id: string, next: boolean) => void;
  onApply: (ops: DictionaryTidyOp[]) => void;
  onApplySelected: () => void;
}

export default function DictionaryTidyReview({
  items,
  usageAvailable,
  protectedKeys,
  suggestions,
  liveWords,
  busy,
  isSelected,
  onSelect,
  onApply,
  onApplySelected,
}: Props) {
  const { t, i18n } = useTranslation();
  const review = useDictionaryTidyStore((s) => s.review);
  const policyState = usePolicySnapshot();
  const settings = useSettingsStore(
    useShallow((state) => selectPolicyEffectiveSettings(state, policyState))
  );
  const options = useMemo(() => reviewModelOptions(settings), [settings]);
  const [chosen, setChosen] = useState<string | null>(null);
  const option = options.find((entry) => entry.id === chosen) ?? options[0] ?? null;
  const request = useMemo(
    () =>
      buildDictionaryReviewRequest({
        words: items,
        usageAvailable,
        uiLanguage: i18n.language,
      }),
    [items, usageAvailable, i18n.language]
  );
  const running = review.status === "running";
  const selectedCount = suggestions.filter(
    (suggestion) => suggestion.action !== "keep" && isSelected(suggestion.id)
  ).length;

  const ask = () => {
    if (!option || request.words.length === 0) return;
    void askModelReview({
      option: { ...option, modelName: reviewModelName(option, t) },
      request,
      protectedKeys,
    });
  };

  const error = review.status === "error" ? describeProviderError(review.error, t) : null;

  return (
    <section
      aria-labelledby="dictionary-tidy-model"
      data-tidy-group="model"
      className={cn(CARD_SURFACE_CLASS, "overflow-hidden")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 bg-primary/[0.04] px-4 py-2.5 dark:border-white/8">
        <Sparkles size={13} aria-hidden="true" className="text-primary" />
        <h3 id="dictionary-tidy-model" className="text-[13px] font-semibold text-foreground">
          {t("dictionary.tidy.review.groupTitle")}
        </h3>
        <span className="rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">
          {t("dictionary.tidy.review.tag")}
        </span>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {review.status === "done"
            ? t("dictionary.tidy.review.groupWhy", { model: review.modelName })
            : t("dictionary.tidy.review.description")}
        </p>
        {selectedCount > 0 && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onApplySelected}>
            {t("dictionary.tidy.actions.apply", { count: selectedCount })}
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2 px-4 py-3">
        {options.length === 0 ? (
          <p data-tidy-review-none className="text-xs text-muted-foreground">
            {t("dictionary.tidy.review.noModels")}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
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
                    {reviewOptionLabel(entry, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {running ? (
              <>
                <span
                  role="status"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  {t("dictionary.tidy.review.running", { model: review.modelName })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  data-tidy-review-cancel
                  onClick={cancelModelReview}
                >
                  {t("dictionary.tidy.review.cancel")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                data-tidy-review-ask
                disabled={!option || request.words.length === 0}
                onClick={ask}
              >
                {t("dictionary.tidy.review.ask")}
              </Button>
            )}
          </div>
        )}
        {options.length > 0 && (
          <p data-tidy-review-estimate className="text-[11px] text-muted-foreground">
            {t("dictionary.tidy.review.estimate", {
              count: request.words.length,
              tokensText: approxTokens(t, request.estimatedTokens),
            })}
          </p>
        )}
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
            <span>{error.description || t("dictionary.tidy.review.failed")}</span>
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
          <p role="status" data-tidy-review-dropped className="text-xs text-muted-foreground">
            {t(`dictionary.tidy.review.${review.reason}`)}
          </p>
        )}
        {review.status === "done" && (
          <p role="status" className="text-xs text-muted-foreground">
            {review.kept === 0
              ? t("dictionary.tidy.review.none")
              : t("dictionary.tidy.review.kept", { count: review.kept })}
            {review.dropped > 0 &&
              ` ${t("dictionary.tidy.review.dropped", { count: review.dropped })}`}
          </p>
        )}
      </div>

      {suggestions.length > 0 && (
        <ul className="border-t border-border/60 dark:border-white/8">
          {suggestions.map((suggestion) => (
            <SuggestionRow
              key={suggestion.id}
              suggestion={suggestion}
              selected={isSelected(suggestion.id)}
              busy={busy}
              onSelect={(next) => onSelect(suggestion.id, next)}
              onApply={() => onApply(reviewSuggestionOps(suggestion, liveWords))}
              onKeep={() => keepTidyItem(suggestion.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SuggestionRow({
  suggestion,
  selected,
  busy,
  onSelect,
  onApply,
  onKeep,
}: {
  suggestion: ReviewSuggestion;
  selected: boolean;
  busy: boolean;
  onSelect: (next: boolean) => void;
  onApply: () => void;
  onKeep: () => void;
}) {
  const { t } = useTranslation();
  const label = suggestion.words.join(", ");
  const isKeep = suggestion.action === "keep";
  return (
    <li
      data-tidy-suggestion={suggestion.action}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 border-b border-border/50 px-4 py-2.5 text-xs last:border-b-0 sm:grid-cols-[auto_minmax(150px,0.8fr)_minmax(0,1.6fr)_auto] sm:items-center dark:border-white/8"
    >
      <span className="pt-0.5 sm:pt-0">
        {isKeep ? (
          <span className="block h-4 w-4" aria-hidden="true" />
        ) : (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={t("dictionary.tidy.actions.select", { word: label })}
            disabled={busy}
            onClick={() => onSelect(!selected)}
            className={cn(
              "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40",
              selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border-hover bg-background hover:border-foreground/40"
            )}
          >
            {selected && <Check size={11} strokeWidth={3} />}
          </button>
        )}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {suggestion.words.map((word, index) => (
          <span key={word} className="flex items-center gap-1">
            {index > 0 && <span className="text-muted-foreground">·</span>}
            <span dir="auto" className="font-semibold text-foreground">
              {word}
            </span>
          </span>
        ))}
        {suggestion.into && (
          <>
            <ArrowRight
              size={11}
              aria-hidden="true"
              className="shrink-0 text-muted-foreground rtl:-scale-x-100"
            />
            <span dir="auto" className="font-semibold text-success">
              {suggestion.into}
            </span>
          </>
        )}
      </div>
      <p dir="auto" className="col-start-2 min-w-0 text-muted-foreground sm:col-start-auto">
        {isKeep && (
          <span className="me-1.5 rounded-full bg-foreground/[0.06] px-1.5 text-[10.5px] text-foreground/80 dark:bg-white/10">
            {t("dictionary.tidy.review.keepTag")}
          </span>
        )}
        {suggestion.reason}
      </p>
      <div className="col-start-2 flex flex-wrap gap-1.5 sm:col-start-auto sm:justify-end">
        {!isKeep && (
          <Button
            size="sm"
            variant="outline"
            className={cn(
              suggestion.action === "remove" && "text-destructive hover:text-destructive"
            )}
            disabled={busy}
            onClick={onApply}
          >
            {t(`dictionary.tidy.review.actions.${suggestion.action}`)}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onKeep}>
          {isKeep ? t("dictionary.tidy.review.dismiss") : t("dictionary.tidy.actions.keep")}
        </Button>
      </div>
    </li>
  );
}
