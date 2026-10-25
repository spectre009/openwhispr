import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { diffText, type TextDiffPart } from "../../utils/textDiff";

// A step's text with what changed from the text it received: insertions
// highlighted, deletions struck, a word that only changed case underlined.
// Added or removed line breaks show as ↵, since whitespace alone is invisible.
// What isn't the step's own text (deletions, ↵ marks, the too-long note) is
// marked so a selection reads only the step's text (HistoryFixes).

const LINE_BREAK_MARK = "↵";

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

function Part({ part }: { part: TextDiffPart }) {
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
      <ins className="rounded-[3px] bg-success/15 px-px text-foreground no-underline dark:bg-success/20">
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
}: {
  before: string;
  after: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const diff = useMemo(() => diffText(before, after), [before, after]);
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
  return (
    <p dir="auto" className={cn("whitespace-pre-wrap wrap-break-word", className)}>
      {diff.parts.map((part, index) => (
        <Part key={index} part={part} />
      ))}
    </p>
  );
}
