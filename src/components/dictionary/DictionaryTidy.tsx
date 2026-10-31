import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check, ChevronRight, Undo2, X } from "../icons";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { CARD_SURFACE_CLASS } from "../ui/surfaces";
import { formatRelativeTime } from "../../utils/dateFormatting";
import {
  TIDY_GROUP_ORDER,
  planTidyBatch,
  tidyItemOps,
  tidyWordCount,
  type TidyChoice,
  type TidyGroup,
  type TidyGroupKind,
  type TidyItem,
} from "../../utils/dictionaryTidy";
import { reviewSuggestionOps } from "../../utils/dictionaryReview";
import {
  applyTidy,
  keepTidyItem,
  restoreKeptTidyItems,
  undoAllTidy,
  undoLastTidy,
  useDictionaryTidyStore,
  type TidySummary,
} from "../../stores/dictionaryTidyStore";
import type { DictionaryListItem } from "../../utils/dictionaryList";
import type { DictionaryTidyOp } from "../../types/electron";
import type { DictionaryTidyModel } from "./useDictionaryTidy";
import DictionaryTidyReview from "./DictionaryTidyReview";
import { usageParts, usageUnavailableKey } from "./dictionaryLabels";

// Tidy up (the Dictionary page, in place of the list): what the checks on
// this computer found, in groups (dictionaryTidy.ts), each item selectable
// with its own actions; "Ask a model" at the bottom; and a footer that applies
// the selection in one batch through main, with Undo for the session. Only
// auto-learned, unpinned words start selected; nothing changes until a click.
// Esc goes back to the list.

type Translate = (key: string, options?: Record<string, unknown>) => string;

const GROUP_KEYS: Record<TidyGroupKind, string> = {
  variants: "dictionary.tidy.groups.variants",
  plurals: "dictionary.tidy.groups.plurals",
  ordinary: "dictionary.tidy.groups.ordinary",
  typos: "dictionary.tidy.groups.typos",
  fragments: "dictionary.tidy.groups.fragments",
  splitPhrases: "dictionary.tidy.groups.splitPhrases",
  neverHeard: "dictionary.tidy.groups.neverHeard",
};

const REFUSAL_KEYS: Record<string, string> = {
  EDITED: "dictionary.tidy.undo.refused.edited",
  EXISTS: "dictionary.tidy.undo.refused.exists",
  INTO_GONE: "dictionary.tidy.undo.refused.intoGone",
};

function tidySummaryText(summary: TidySummary, t: Translate): string {
  const parts: string[] = [];
  if (summary.removed) parts.push(t("dictionary.tidy.summary.removed", { count: summary.removed }));
  if (summary.merged) parts.push(t("dictionary.tidy.summary.merged", { count: summary.merged }));
  if (summary.changed) parts.push(t("dictionary.tidy.summary.changed", { count: summary.changed }));
  if (summary.added) parts.push(t("dictionary.tidy.summary.added", { count: summary.added }));
  if (summary.kept) parts.push(t("dictionary.tidy.summary.kept", { count: summary.kept }));
  if (summary.failed) parts.push(t("dictionary.tidy.summary.failed", { count: summary.failed }));
  if (summary.skipped) {
    parts.push(t("dictionary.tidy.summary.skipped", { count: summary.skipped }));
  }
  return parts.length > 0 ? parts.join(" · ") : t("dictionary.tidy.summary.nothing");
}

function Checkbox({
  checked,
  label,
  onChange,
  disabled,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border-hover bg-background hover:border-foreground/40"
      )}
    >
      {checked && <Check size={11} strokeWidth={3} />}
    </button>
  );
}

function Word({ children }: { children: ReactNode }) {
  return (
    <span dir="auto" className="font-semibold text-foreground">
      {children}
    </span>
  );
}

function Arrow() {
  return (
    <ArrowRight
      size={11}
      aria-hidden="true"
      className="shrink-0 text-muted-foreground rtl:-scale-x-100"
    />
  );
}

interface ItemRowProps {
  item: TidyItem;
  selected: boolean;
  choice: TidyChoice;
  info: Map<string, DictionaryListItem>;
  busy: boolean;
  onSelect: (next: boolean) => void;
  onChoice: (choice: TidyChoice) => void;
  onApply: (ops: DictionaryTidyOp[]) => void;
  onKeep: () => void;
}

function TidyItemRow({
  item,
  selected,
  choice,
  info,
  busy,
  onSelect,
  onChoice,
  onApply,
  onKeep,
}: ItemRowProps) {
  const { t, i18n } = useTranslation();
  const reason = t(item.reason.key, {
    ...item.reason.params,
    ...(item.reason.key === "dictionary.tidy.reasons.neverHeard"
      ? {
          when: formatRelativeTime(String(item.reason.params?.createdAt ?? ""), t, i18n.language),
        }
      : {}),
  });
  const keep = item.locked
    ? (item.keep ?? null)
    : choice.keep !== undefined
      ? choice.keep
      : (item.keep ?? null);
  const label = item.words.join(", ");

  let words: ReactNode;
  let actions: ReactNode;
  const keepButton = (
    <Button size="sm" variant="ghost" disabled={busy} onClick={onKeep}>
      {item.action === "keep-one"
        ? item.words.length === 2
          ? t("dictionary.tidy.actions.keepBoth")
          : t("dictionary.tidy.actions.keepAll")
        : t("dictionary.tidy.actions.keep")}
    </Button>
  );
  const removeButton = (
    <Button
      size="sm"
      variant="outline"
      className="text-destructive hover:text-destructive"
      disabled={busy}
      onClick={() => onApply([{ kind: "remove", words: [...item.words] }])}
    >
      {t("dictionary.tidy.actions.remove")}
    </Button>
  );

  switch (item.action) {
    case "keep-one":
      words = (
        <span className="flex flex-wrap items-center gap-1">
          {item.words.map((word, index) => (
            <span key={word} className="flex items-center gap-1">
              {index > 0 && <span className="text-muted-foreground">·</span>}
              <Word>{word}</Word>
            </span>
          ))}
        </span>
      );
      actions = (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || tidyItemOps(item, { keep }).length === 0}
            onClick={() => onApply(tidyItemOps(item, { keep }))}
          >
            {keep === null
              ? t("dictionary.tidy.actions.removeAll")
              : t("dictionary.tidy.actions.keepOne")}
          </Button>
          {keepButton}
        </>
      );
      break;
    case "respell":
      words = (
        <span className="flex flex-wrap items-center gap-1">
          <Word>{item.words[0]}</Word>
          <Arrow />
          <span dir="auto" className="font-semibold text-success">
            {item.to}
          </span>
        </span>
      );
      actions = (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onApply(tidyItemOps(item))}
          >
            {t("dictionary.tidy.actions.change")}
          </Button>
          {removeButton}
          {keepButton}
        </>
      );
      break;
    case "add-phrase":
      words = (
        <span className="flex flex-wrap items-center gap-1">
          <Word>{item.words[0]}</Word>
          <span className="text-muted-foreground">+</span>
          <Word>{item.words[1]}</Word>
          <Arrow />
          <span dir="auto" className="font-semibold text-success">
            {item.phrase}
          </span>
        </span>
      );
      actions = (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onApply(tidyItemOps(item))}
          >
            {item.phraseExists
              ? t("dictionary.tidy.actions.removeParts")
              : t("dictionary.tidy.actions.addPhrase", { phrase: item.phrase })}
          </Button>
          {keepButton}
        </>
      );
      break;
    default:
      words = <Word>{item.words[0]}</Word>;
      actions = (
        <>
          {removeButton}
          {item.to && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onApply(tidyItemOps(item, { respell: true }))}
            >
              {t("dictionary.tidy.actions.changeTo", { word: item.to })}
            </Button>
          )}
          {keepButton}
        </>
      );
  }

  return (
    <li
      data-tidy-item={item.id}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 border-b border-border/50 px-4 py-2.5 text-xs last:border-b-0 sm:grid-cols-[auto_minmax(150px,0.8fr)_minmax(0,1.6fr)_auto] sm:items-center dark:border-white/8"
    >
      <span className="pt-0.5 sm:pt-0">
        <Checkbox
          checked={selected}
          onChange={onSelect}
          disabled={busy}
          label={t("dictionary.tidy.actions.select", { word: label })}
        />
      </span>
      <div className="min-w-0">{words}</div>
      <div className="col-start-2 min-w-0 text-muted-foreground sm:col-start-auto">
        {item.action === "keep-one" && (
          <div
            role="radiogroup"
            aria-label={t("dictionary.tidy.actions.spellingLabel", { words: label })}
            className="mb-1 flex flex-wrap gap-1.5"
          >
            {item.words.map((word) => {
              const meta = info.get(word);
              const on = keep === word;
              return (
                <button
                  key={word}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={busy || (item.locked && !on)}
                  onClick={() => onChoice({ ...choice, keep: word })}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60",
                    on
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border/70 bg-background hover:border-border-hover dark:border-white/10"
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-block h-2.5 w-2.5 rounded-full border",
                      on ? "border-[3px] border-primary" : "border-muted-foreground"
                    )}
                  />
                  <span dir="auto" className="font-medium">
                    {word}
                  </span>
                  <span className="text-[10.5px] text-muted-foreground">
                    {meta?.usage
                      ? t("dictionary.list.usageShort", {
                          used: usageParts(meta.usage).used,
                          ok: usageParts(meta.usage).ok,
                        })
                      : null}
                    {meta?.usage ? " · " : ""}
                    {meta?.source === "learned"
                      ? t("dictionary.source.learned")
                      : t("dictionary.source.typed")}
                  </span>
                </button>
              );
            })}
            {item.allowNone && (
              <button
                type="button"
                role="radio"
                aria-checked={keep === null}
                disabled={busy}
                onClick={() => onChoice({ ...choice, keep: null })}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  keep === null
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border/70 bg-background hover:border-border-hover dark:border-white/10"
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-block h-2.5 w-2.5 rounded-full border",
                    keep === null ? "border-[3px] border-primary" : "border-muted-foreground"
                  )}
                />
                {t("dictionary.tidy.actions.neither")}
              </button>
            )}
          </div>
        )}
        <span>{reason}</span>
      </div>
      <div className="col-start-2 flex flex-wrap gap-1.5 sm:col-start-auto sm:justify-end">
        {actions}
      </div>
    </li>
  );
}

interface GroupProps {
  group: TidyGroup;
  items: TidyItem[];
  collapsed: boolean;
  days: number;
  usageReason: string | null;
  busy: boolean;
  onToggle: () => void;
  renderItem: (item: TidyItem) => ReactNode;
  selectedCount: number;
  onApplySelected: () => void;
}

function TidyGroupSection({
  group,
  items,
  collapsed,
  days,
  usageReason,
  busy,
  onToggle,
  renderItem,
  selectedCount,
  onApplySelected,
}: GroupProps) {
  const { t } = useTranslation();
  const headingId = `dictionary-tidy-${group.kind}`;
  const bodyId = `${headingId}-body`;
  const base = GROUP_KEYS[group.kind];
  const unavailable = group.unavailable === "history";
  return (
    <section
      aria-labelledby={headingId}
      data-tidy-group={group.kind}
      className={cn(CARD_SURFACE_CLASS, "overflow-hidden")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 bg-foreground/[0.02] px-4 py-2.5 dark:border-white/8 dark:bg-white/[0.02]">
        <h3 id={headingId} className="text-[13px] font-semibold text-foreground">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={onToggle}
            className="flex min-w-0 items-center gap-2 rounded text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={cn(
                "shrink-0 text-muted-foreground transition-transform",
                collapsed ? "rtl:rotate-180" : "rotate-90"
              )}
            />
            <span>{t(`${base}.title`, { days })}</span>
            <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[11px] font-normal tabular-nums text-muted-foreground dark:bg-white/10">
              {unavailable ? "—" : group.total}
            </span>
          </button>
        </h3>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t(`${base}.why`, { days })}</p>
        {selectedCount > 0 && !unavailable && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onApplySelected}>
            {t("dictionary.tidy.actions.apply", { count: selectedCount })}
          </Button>
        )}
      </div>
      {!collapsed && (
        <div id={bodyId}>
          {unavailable ? (
            <p data-tidy-unavailable className="px-4 py-3 text-xs text-muted-foreground">
              {t("dictionary.tidy.needsHistory")}
              {usageReason ? ` · ${t(usageUnavailableKey(usageReason))}` : ""}
            </p>
          ) : (
            <>
              {group.unavailable === "partial" && (
                <p
                  data-tidy-partial
                  className="border-b border-border/50 px-4 py-2 text-xs text-muted-foreground dark:border-white/8"
                >
                  {t("dictionary.tidy.partial")}
                </p>
              )}
              {items.length === 0 ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  {t("dictionary.tidy.empty")}
                </p>
              ) : (
                <ul>{items.map(renderItem)}</ul>
              )}
              {group.total > group.items.length && (
                <p className="border-t border-border/50 px-4 py-2 text-[11px] text-muted-foreground dark:border-white/8">
                  {t("dictionary.tidy.capped", { shown: group.items.length, total: group.total })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export interface DictionaryTidyProps {
  /** The list's items (words, sources, pins, dates, heard/written). */
  items: readonly DictionaryListItem[];
  model: DictionaryTidyModel;
  usageAvailable: boolean;
  usageReason: string | null;
  onClose: () => void;
}

export default function DictionaryTidy({
  items,
  model,
  usageAvailable,
  usageReason,
  onClose,
}: DictionaryTidyProps) {
  const { t } = useTranslation();
  const kept = useDictionaryTidyStore((s) => s.kept);
  const undo = useDictionaryTidyStore((s) => s.undo);
  const busy = useDictionaryTidyStore((s) => s.busy);
  const summary = useDictionaryTidyStore((s) => s.summary);
  const refusal = useDictionaryTidyStore((s) => s.refusal);
  const review = useDictionaryTidyStore((s) => s.review);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [choices, setChoices] = useState<ReadonlyMap<string, TidyChoice>>(() => new Map());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(["neverHeard"]));
  const [focus, setFocus] = useState<"all" | TidyGroupKind>("all");
  const containerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const info = useMemo(() => new Map(items.map((item) => [item.word, item])), [items]);
  const liveWords = useMemo(() => items.map((item) => item.word), [items]);
  const groups = model.groups;
  const visible = useCallback(
    (group: TidyGroup) => group.items.filter((item) => !kept.has(item.id)),
    [kept]
  );
  const isSelected = useCallback(
    (id: string, preselected: boolean) => overrides.get(id) ?? preselected,
    [overrides]
  );
  const select = useCallback((id: string, next: boolean) => {
    setOverrides((current) => new Map(current).set(id, next));
  }, []);
  const choose = useCallback((id: string, choice: TidyChoice) => {
    setChoices((current) => new Map(current).set(id, choice));
  }, []);

  // The model's suggestions still about words in the dictionary.
  const suggestions = useMemo(() => {
    if (review.status !== "done") return [];
    const live = new Set(liveWords);
    return review.suggestions.filter(
      (suggestion) => !kept.has(suggestion.id) && suggestion.words.every((word) => live.has(word))
    );
  }, [review, liveWords, kept]);

  const shownGroups = groups.filter((group) => focus === "all" || group.kind === focus);
  const selectedOps = useCallback(
    (only?: TidyGroupKind | "model") => {
      const ops: DictionaryTidyOp[] = [];
      let count = 0;
      for (const group of shownGroups) {
        if (only && only !== group.kind) continue;
        if (group.unavailable === "history") continue;
        for (const item of visible(group)) {
          if (!isSelected(item.id, item.preselected)) continue;
          const itemOps = tidyItemOps(item, choices.get(item.id));
          if (itemOps.length === 0) continue;
          ops.push(...itemOps);
          count += 1;
        }
      }
      if ((!only || only === "model") && focus === "all") {
        for (const suggestion of suggestions) {
          if (suggestion.action === "keep" || !isSelected(suggestion.id, false)) continue;
          const suggestionOps = reviewSuggestionOps(suggestion, liveWords);
          if (suggestionOps.length === 0) continue;
          ops.push(...suggestionOps);
          count += 1;
        }
      }
      return { ops, count };
    },
    [shownGroups, visible, isSelected, choices, focus, suggestions, liveWords]
  );
  const allSelected = selectedOps();

  const apply = useCallback(
    async (ops: DictionaryTidyOp[]) => {
      if (ops.length === 0) return;
      // One consistent batch: no choice in it undoes another (a removed word
      // respelled back, a chain run in the wrong order); conflicting ones are skipped.
      const plan = planTidyBatch(ops, liveWords);
      await applyTidy(plan.ops, { skipped: plan.skipped });
    },
    [liveWords]
  );

  const wordCount = model.ready
    ? tidyWordCount(groups.map((group) => ({ ...group, items: visible(group) })))
    : 0;
  const keptCount = kept.size;
  const lastUndo = undo.at(-1);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // A select's popover is portalled: its Esc closes the popover, not this view.
    if (!containerRef.current?.contains(event.target as Node)) return;
    event.preventDefault();
    onClose();
  };

  const renderItem = (item: TidyItem) => (
    <TidyItemRow
      key={item.id}
      item={item}
      selected={isSelected(item.id, item.preselected)}
      choice={choices.get(item.id) ?? {}}
      info={info}
      busy={busy}
      onSelect={(next) => select(item.id, next)}
      onChoice={(choice) => choose(item.id, choice)}
      onApply={(ops) => void apply(ops)}
      onKeep={() => keepTidyItem(item.id)}
    />
  );

  return (
    <div
      ref={containerRef}
      data-dictionary-tidy
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
            {!model.ready
              ? t("dictionary.tidy.checking")
              : wordCount > 0
                ? t("dictionary.tidy.title", { count: wordCount })
                : t("dictionary.tidy.titleNone")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {usageAvailable && model.days > 0
              ? t("dictionary.tidy.subtitle", { days: model.days })
              : t("dictionary.tidy.subtitleNoHistory")}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onClose}>
          <X size={12} />
          {t("dictionary.tidy.close")}
        </Button>
      </div>

      <div
        role="group"
        aria-label={t("dictionary.tidy.filtersLabel")}
        className="flex flex-wrap gap-1.5"
      >
        {(["all", ...TIDY_GROUP_ORDER] as const).map((option) => {
          const group = option === "all" ? null : groups.find((entry) => entry.kind === option);
          const count = group
            ? group.unavailable === "history"
              ? null
              : visible(group).length
            : wordCount;
          const active = focus === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              data-tidy-filter={option}
              onClick={() => setFocus(option)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                active
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/70 text-foreground/75 hover:border-foreground/30 dark:border-white/10"
              )}
            >
              {option === "all"
                ? t("dictionary.tidy.all")
                : t(`${GROUP_KEYS[option]}.title`, { days: model.days || 90 })}
              <span className="ms-1 tabular-nums text-muted-foreground">{count ?? "—"}</span>
            </button>
          );
        })}
      </div>

      {shownGroups.map((group) => {
        const items = visible(group);
        const selectedCount = items.filter((item) => isSelected(item.id, item.preselected)).length;
        return (
          <TidyGroupSection
            key={group.kind}
            group={group}
            items={items}
            collapsed={collapsed.has(group.kind)}
            days={model.days || 90}
            usageReason={usageAvailable ? null : usageReason}
            busy={busy}
            onToggle={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(group.kind)) next.delete(group.kind);
                else next.add(group.kind);
                return next;
              })
            }
            renderItem={renderItem}
            selectedCount={selectedCount}
            onApplySelected={() => void apply(selectedOps(group.kind).ops)}
          />
        );
      })}

      {focus === "all" && (
        <DictionaryTidyReview
          items={items}
          usageAvailable={usageAvailable}
          protectedKeys={model.protectedKeys}
          suggestions={suggestions}
          busy={busy}
          isSelected={(id) => isSelected(id, false)}
          onSelect={select}
          onApply={(ops) => void apply(ops)}
          onApplySelected={() => void apply(selectedOps("model").ops)}
          liveWords={liveWords}
        />
      )}

      <div
        data-tidy-footer
        className="sticky bottom-0 z-10 -mx-1 mt-1 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-popover px-3 py-2 text-xs shadow-lg dark:bg-surface-3"
      >
        <div role="status" aria-live="polite" className="min-w-0 flex-1 text-muted-foreground">
          {refusal ? (
            <span className="text-destructive">
              {t(REFUSAL_KEYS[refusal.code] ?? "dictionary.tidy.undo.refused.other", {
                word: refusal.word ?? "",
                existing: refusal.existing ?? "",
              })}
            </span>
          ) : summary ? (
            <span data-tidy-summary className="text-foreground">
              {tidySummaryText(summary, t)}
            </span>
          ) : (
            <span>{t("dictionary.tidy.undo.session")}</span>
          )}
          {lastUndo?.merged && !refusal && (
            <span className="block text-[11px]">{t("dictionary.tidy.undo.evidence")}</span>
          )}
          {keptCount > 0 && (
            <button
              type="button"
              onClick={restoreKeptTidyItems}
              className="block text-[11px] text-primary hover:underline"
            >
              {t("dictionary.tidy.actions.showKept", { count: keptCount })}
            </button>
          )}
        </div>
        {undo.length > 0 && (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void undoLastTidy()}>
              <Undo2 size={12} />
              {t("dictionary.tidy.undo.undo")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undoAllTidy()}>
              {t("dictionary.tidy.undo.undoAll", { count: undo.length })}
            </Button>
          </>
        )}
        <Button
          size="sm"
          data-tidy-apply
          disabled={busy || allSelected.count === 0}
          onClick={() => void apply(allSelected.ops)}
        >
          {t("dictionary.tidy.actions.apply", { count: allSelected.count })}
        </Button>
      </div>
    </div>
  );
}
