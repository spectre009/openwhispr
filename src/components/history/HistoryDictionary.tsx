import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Wand2 } from "../icons";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import GlossaryRuleDialog from "../GlossaryRuleDialog";
import GlossaryOfferNotice from "../dictionary/GlossaryOfferNotice";
import { KindTag } from "../dictionary/DictionaryWordOccurrences";
import { FIXED_BY_KEYS } from "../dictionary/dictionaryLabels";
import { useGlossaryStore } from "../../stores/glossaryStore";
import { loadCommonWords, useDictionaryTidyStore } from "../../stores/dictionaryTidyStore";
import { usageTokens } from "../../helpers/dictionaryUsage.js";
import { requestOpenDictionaryWord } from "../../utils/openDictionaryWord";
import {
  glossaryHandles,
  glossaryOfferFor,
  type GlossaryOffer,
} from "../../utils/dictionaryGlossaryOffer";
import { appearanceKinds } from "../../helpers/dictionaryOccurrences.js";
import type {
  DictionaryAppearanceKind,
  DictionarySpeechVariant,
  HistoryDictionaryAppearance,
  HistoryDictionaryWord,
} from "../../types/electron";

// History's "Dictionary in this dictation" (history-get-item's `dictionary`):
// your dictionary words in the dictation, as the dictionary is now, each with
// what happened to it: speech got it, fixed after speech (what speech wrote,
// and "by the glossary" or "by cleanup" when this dictation's recorded steps
// show which) or changed after speech. A fix offers a glossary rule with the
// panel's scope safety (the spelling's evidence over 90 days of local
// History); "Open in Dictionary" opens the word's panel. The final text above
// underlines the words (green: speech got it, amber: fixed after speech), and
// the cleanup step's changes mark the dictionary words it put in. Nothing is
// logged.

interface Underline {
  start: number;
  end: number;
  kind: "ok" | "fix";
}

// Non-overlapping underlines in text order; where two words overlap, the
// longer (or earlier) one wins.
function underlines(words: readonly HistoryDictionaryWord[], length: number): Underline[] {
  const all: Underline[] = [];
  for (const entry of words) {
    for (const appearance of entry.appearances) {
      if (appearance.kind !== "ok" && appearance.kind !== "fix") continue;
      if (appearance.start < 0 || appearance.end > length || appearance.end <= appearance.start)
        continue;
      all.push({ start: appearance.start, end: appearance.end, kind: appearance.kind });
    }
  }
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: Underline[] = [];
  let reached = 0;
  for (const mark of all) {
    if (mark.start < reached) continue;
    kept.push(mark);
    reached = mark.end;
  }
  return kept;
}

const UNDERLINE_CLASS: Record<"ok" | "fix", string> = {
  ok: "border-b-2 border-success/80",
  fix: "border-b-2 border-warning/90",
};

/**
 * The final text with its dictionary words underlined. Each underline is
 * focusable and described by its kind (green: speech got it, amber: fixed
 * after speech) without adding words to the text a selection copies.
 */
export function DictionaryFinalText({
  text,
  words,
}: {
  text: string;
  words: readonly HistoryDictionaryWord[];
}) {
  const { t } = useTranslation();
  const id = useId().replace(/:/g, "");
  const marks = useMemo(() => underlines(words, text.length), [words, text.length]);
  if (marks.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  marks.forEach((mark, index) => {
    if (mark.start > at) parts.push(text.slice(at, mark.start));
    const label = t(mark.kind === "ok" ? "dictionary.kinds.ok" : "dictionary.kinds.fix");
    parts.push(
      <span
        key={index}
        tabIndex={0}
        title={label}
        aria-describedby={`${id}-${mark.kind}`}
        data-dictionary-underline={mark.kind}
        className={cn(
          "rounded-[2px] focus-visible:bg-primary/10 focus-visible:outline-none",
          UNDERLINE_CLASS[mark.kind]
        )}
      >
        {text.slice(mark.start, mark.end)}
      </span>
    );
    at = mark.end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return (
    <>
      {parts}
      <span id={`${id}-ok`} hidden>
        {t("historyView.dictionary.underlineOk")}
      </span>
      <span id={`${id}-fix`} hidden>
        {t("historyView.dictionary.underlineFix")}
      </span>
    </>
  );
}

type VariantEvidence =
  | { status: "loading" }
  | { status: "ready"; variant: DictionarySpeechVariant | null }
  | { status: "unavailable" };

function firstFix(appearances: readonly HistoryDictionaryAppearance[]) {
  return (
    appearances.find((appearance) => appearance.kind === "fix" && appearance.speechWrote) ??
    appearances.find((appearance) => appearance.kind === "fix") ??
    null
  );
}

function WordRow({
  entry,
  evidence,
  onMakeRule,
}: {
  entry: HistoryDictionaryWord;
  evidence: VariantEvidence | undefined;
  onMakeRule: (word: string, spelling: string) => void;
}) {
  const { t } = useTranslation();
  const rules = useGlossaryStore((state) => state.rules);
  const kinds = appearanceKinds(entry.appearances) as DictionaryAppearanceKind[];
  const fix = firstFix(entry.appearances);
  const handled = fix?.speechWrote ? glossaryHandles(rules, entry.word, fix.speechWrote) : null;
  const times =
    evidence?.status === "ready" && evidence.variant && evidence.variant.count > 1
      ? evidence.variant.count
      : null;
  let description: ReactNode;
  if (fix) {
    description = (
      <span>
        {fix.speechWrote ? (
          <>
            {t("historyView.dictionary.speechWrote")}{" "}
            <del dir="auto" className="text-destructive/85 decoration-destructive/60">
              {fix.speechWrote}
            </del>
            {", "}
            {t("historyView.dictionary.fixedAfterSpeech")}
          </>
        ) : (
          t("historyView.dictionary.fixedUnknown")
        )}
        {fix.by && <span data-fixed-by={fix.by}> {t(FIXED_BY_KEYS[fix.by])}</span>}
        {times && (
          <span className="text-muted-foreground">
            {" · "}
            {t("historyView.dictionary.times", { count: times })}
          </span>
        )}
      </span>
    );
  } else if (kinds.includes("ok")) {
    description = (
      <span className="text-muted-foreground">
        {t(
          kinds.includes("chg")
            ? "historyView.dictionary.gotAndChanged"
            : "historyView.dictionary.got"
        )}
      </span>
    );
  } else {
    description = (
      <span className="text-muted-foreground">{t("historyView.dictionary.changed")}</span>
    );
  }
  return (
    <li
      data-history-dictionary-word={entry.word}
      className="grid grid-cols-1 gap-x-3 gap-y-1 border-t border-border/50 py-2 text-[12.5px] first:border-t-0 @md:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] dark:border-white/8"
    >
      <span dir="auto" className="truncate font-semibold text-foreground">
        {entry.word}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap gap-x-2">
          {kinds.map((kind) => (
            <KindTag key={kind} kind={kind} />
          ))}
        </span>
        <span className="mt-0.5 block text-foreground/85">{description}</span>
      </span>
      {/* Under the description, so the actions never squeeze it in a narrow pane. */}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 @md:col-start-2">
        {fix?.speechWrote &&
          (handled ? (
            <span className="text-[11px] text-success" data-glossary-handles>
              {t("dictionary.variants.handled")}
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => onMakeRule(entry.word, fix.speechWrote as string)}
            >
              <Wand2 size={11} />
              {t("dictionary.variants.makeRule")}
            </Button>
          ))}
        <button
          type="button"
          onClick={() => requestOpenDictionaryWord(entry.word)}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {t("historyView.dictionary.openInDictionary")}
          <ExternalLink size={11} />
        </button>
      </span>
    </li>
  );
}

export default function HistoryDictionaryCard({
  itemId,
  words,
  aligned,
}: {
  itemId: number;
  words: readonly HistoryDictionaryWord[];
  aligned: boolean;
}) {
  const { t } = useTranslation();
  const rules = useGlossaryStore((state) => state.rules);
  // What speech wrote for each fixed word, with its evidence over local History.
  const [evidence, setEvidence] = useState<Record<string, VariantEvidence>>({});
  const [dialog, setDialog] = useState<{
    offer: GlossaryOffer;
    spelling: string;
    keptInFinal: number | null;
  } | null>(null);
  const [reset, setReset] = useState(0);
  const request = useRef(0);

  // Another owner or policy: what was read for the old one goes.
  useEffect(
    () => window.electronAPI?.onDictionaryHistoryChanged?.(() => setReset((n) => n + 1)),
    []
  );

  const fixes = useMemo(
    () =>
      words
        .map((entry) => ({ word: entry.word, fix: firstFix(entry.appearances) }))
        .filter((entry): entry is { word: string; fix: HistoryDictionaryAppearance } =>
          Boolean(entry.fix?.speechWrote)
        )
        .slice(0, 8),
    [words]
  );

  useEffect(() => {
    const current = ++request.current;
    const read = window.electronAPI?.getDictionarySpeechVariants;
    setEvidence(Object.fromEntries(fixes.map(({ word }) => [word, { status: "loading" }])));
    if (!read || fixes.length === 0) return;
    void loadCommonWords();
    for (const { word, fix } of fixes) {
      read(word, { spelling: fix.speechWrote as string }).then(
        (result) => {
          if (current !== request.current) return;
          setEvidence((previous) => ({
            ...previous,
            [word]: result?.available
              ? { status: "ready", variant: result.requested ?? null }
              : { status: "unavailable" },
          }));
        },
        () => {
          if (current !== request.current) return;
          setEvidence((previous) => ({ ...previous, [word]: { status: "unavailable" } }));
        }
      );
    }
  }, [itemId, fixes, reset]);

  const makeRule = (word: string, spelling: string) => {
    const known = evidence[word];
    const variant =
      known?.status === "ready" &&
      known.variant &&
      usageTokens(known.variant.spelling).join(" ") === usageTokens(spelling).join(" ")
        ? known.variant
        : null;
    const keptInFinal = variant ? variant.keptInFinal : null;
    const offer = glossaryOfferFor(rules, word, spelling, {
      keptInFinal,
      commonWords: useDictionaryTidyStore.getState().commonWords,
    });
    setDialog({ offer, spelling, keptInFinal });
  };

  if (aligned && words.length === 0) return null;
  return (
    <section
      data-history-dictionary
      className="@container mt-4 rounded-lg border border-border/70 bg-card/50 p-3.5 dark:border-white/10 dark:bg-surface-2/60"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span aria-hidden="true">📖 </span>
          {t("historyView.dictionary.title")}
        </h3>
        <span className="ms-auto text-[11px] text-muted-foreground/80">
          {t("historyView.dictionary.asNow")}
        </span>
      </div>
      {!aligned ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("historyView.dictionary.tooLong")}</p>
      ) : (
        <ul className="mt-1.5">
          {words.map((entry) => (
            <WordRow
              key={entry.word}
              entry={entry}
              evidence={evidence[entry.word]}
              onMakeRule={makeRule}
            />
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {t("historyView.dictionary.note")}
      </p>
      <GlossaryRuleDialog
        rule={dialog?.offer.rule ?? null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        notice={
          dialog ? (
            <GlossaryOfferNotice
              offer={dialog.offer}
              spelling={dialog.spelling}
              keptInFinal={dialog.keptInFinal}
            />
          ) : undefined
        }
      />
    </section>
  );
}
