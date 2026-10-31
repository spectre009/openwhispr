import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { diffText, type TextDiffPart } from "../../utils/textDiff";
import { usageTokens } from "../../helpers/dictionaryUsage.js";

// A step's text with what changed from the text it received: insertions
// highlighted, deletions struck, a word that only changed case underlined.
// Added or removed line breaks show as ↵, since whitespace alone is invisible.
// What isn't the step's own text (deletions, ↵ marks, the too-long note) is
// marked so a selection reads only the step's text (HistoryFixes).
// `markWords`: dictionary words; an insertion that contains one (by the row
// summaries' tokens) is underlined amber and described as a dictionary word.

const LINE_BREAK_MARK = "↵";

// Whether `text`'s tokens contain one of the word sequences.
function containsWord(text: string, sequences: readonly string[][]): boolean {
  if (sequences.length === 0) return false;
  const tokens = usageTokens(text) as string[];
  return sequences.some((seq) => {
    for (let i = 0; i + seq.length <= tokens.length; i += 1) {
      if (seq.every((token, k) => tokens[i + k] === token)) return true;
    }
    return false;
  });
}

// An added line break shows a ↵ where it starts; a removed one shows only the ↵.
function withBreakMarks(text: string, removed: boolean, label: string) {
  if (!text.includes("\n")) return text;
  return text.split(/(\n)/).map((segment, index) =>
    segment === "\n" ? (
      <span key={index}>
        <span data-diff-mark aria-label={label}>
          {LINE_BREAK_MARK}
        </span>
        {removed ? null : "\n"}
      </span>
    ) : (
      segment
    )
  );
}

function Part({
  part,
  dictionary,
  dictionaryLabelId,
}: {
  part: TextDiffPart;
  dictionary: boolean;
  dictionaryLabelId: string;
}) {
  const { t } = useTranslation();
  if (part.kind === "same") return <>{part.text}</>;
  if (part.kind === "case") {
    return (
      <span
        title={t("historyView.steps.caseWas", { text: part.was })}
        className="underline decoration-primary/70 decoration-dotted underline-offset-[3px]"
      >
        {part.text}
      </span>
    );
  }
  const lineBreak = t("historyView.steps.lineBreak");
  if (part.kind === "insert") {
    return (
      <ins
        data-dictionary-insert={dictionary || undefined}
        aria-describedby={dictionary ? dictionaryLabelId : undefined}
        title={dictionary ? t("historyView.dictionary.inserted") : undefined}
        className={cn(
          "rounded-[3px] bg-success/15 px-px text-foreground no-underline dark:bg-success/20",
          dictionary && "border-b-2 border-warning/90"
        )}
      >
        {withBreakMarks(part.text, false, lineBreak)}
      </ins>
    );
  }
  return (
    <del className="rounded-[3px] bg-destructive/10 px-px text-destructive/80 decoration-destructive/60 dark:bg-destructive/15">
      {withBreakMarks(part.text, true, lineBreak)}
    </del>
  );
}

export default function HistoryDiffText({
  before,
  after,
  className,
  markWords,
}: {
  before: string;
  after: string;
  className?: string;
  /** Dictionary words whose insertion is marked. */
  markWords?: readonly string[];
}) {
  const { t } = useTranslation();
  const labelId = `${useId().replace(/:/g, "")}-dictionary`;
  const diff = useMemo(() => diffText(before, after), [before, after]);
  const sequences = useMemo(
    () =>
      (markWords ?? [])
        .map((word) => usageTokens(word.trim().normalize("NFC")) as string[])
        .filter((seq) => seq.length > 0),
    [markWords]
  );
  if (diff.kind === "replaced") {
    return (
      <div className={className}>
        <p dir="auto" className="whitespace-pre-wrap wrap-break-word">
          {after}
        </p>
        <p data-diff-mark className="mt-1.5 text-[11px] italic text-muted-foreground">
          {t("historyView.steps.tooLong")}
        </p>
      </div>
    );
  }
  const marked = diff.parts.map(
    (part) => part.kind === "insert" && containsWord(part.text, sequences)
  );
  return (
    <p dir="auto" className={cn("whitespace-pre-wrap wrap-break-word", className)}>
      {diff.parts.map((part, index) => (
        <Part key={index} part={part} dictionary={marked[index]} dictionaryLabelId={labelId} />
      ))}
      {marked.some(Boolean) && (
        <span id={labelId} data-diff-mark hidden>
          {t("historyView.dictionary.inserted")}
        </span>
      )}
    </p>
  );
}
