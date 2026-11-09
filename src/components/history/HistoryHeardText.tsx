import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import {
  heardPieces,
  segmentText,
  unitAtOffset,
  wordPlayTime,
  type HeardPiece,
  type HeardTimeline,
  type TextSegments,
} from "../../utils/historyPlaybackTimes";
import {
  setHistoryHeardView,
  useHistoryViewStore,
  type HistoryHeardView,
} from "./historyViewStore";
import { SelectionActions } from "./HistoryFixes";
import { useStepTextSelection, type HistoryFixesController } from "./useHistoryFixes";
import { useEstimatedSentence, type HistoryPlayer } from "./historyPlayer";

// The wide layout's "What speech heard": the speech-to-text text, alone or
// compared with the final output ("Changes after speech") or the review's
// correction ("Speech → your correction"). Every view shows the heard text by
// its own offsets: words speech wrote that were changed are struck but stay
// selectable, and added text is marked as not part of it, so words selected
// here start the same fixes as in the speech-to-text step's card. With a
// known recording length a word click plays from about there and the sentence
// estimated to be playing is tinted.

interface Chunk {
  text: string;
  /** The heard-text offset of the word this is part of; null between words. */
  word: number | null;
  sentence: number;
}

// The text of [start, end) of the heard text, cut at its words.
function chunksOf(text: string, segments: TextSegments, start: number, end: number): Chunk[] {
  const chunks: Chunk[] = [];
  const { units } = segments;
  let index = Math.max(0, unitAtOffset(segments, start));
  while (index < units.length && units[index].end <= start) index += 1;
  let at = start;
  let sentence = units[index]?.sentence ?? units[units.length - 1]?.sentence ?? 0;
  for (; index < units.length && units[index].start < end; index += 1) {
    const unit = units[index];
    const from = Math.max(unit.start, start);
    const to = Math.min(unit.end, end);
    if (from > at) chunks.push({ text: text.slice(at, from), word: null, sentence });
    sentence = unit.sentence;
    chunks.push({ text: text.slice(from, to), word: unit.start, sentence });
    at = to;
  }
  if (at < end) chunks.push({ text: text.slice(at, end), word: null, sentence });
  return chunks;
}

function ViewSwitch({ views }: { views: HistoryHeardView[] }) {
  const { t } = useTranslation();
  const current = useHistoryViewStore((state) => state.heardView);
  const shown = views.includes(current) ? current : "heard";
  return (
    <div
      role="radiogroup"
      aria-label={t("historyView.heard.viewLabel")}
      className="inline-flex overflow-hidden rounded-md border border-border/70 dark:border-white/10"
    >
      {views.map((view) => (
        <button
          key={view}
          type="button"
          role="radio"
          aria-checked={shown === view}
          onClick={() => setHistoryHeardView(view)}
          className={cn(
            "px-2.5 py-1 text-[11.5px] whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
            shown === view
              ? "bg-muted text-foreground dark:bg-white/10"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t(`historyView.heard.views.${view}`)}
        </button>
      ))}
    </div>
  );
}

export default function HistoryHeardText({
  heard,
  finalText,
  correction,
  timeline,
  player,
  stepIndex,
  outputs,
  fixes,
}: {
  heard: string;
  finalText: string;
  /** The open draft's correction (debounced); null without a draft. */
  correction: string | null;
  timeline: HeardTimeline | null;
  player: HistoryPlayer | null;
  /** The speech-to-text step's seq, when the heard text is its output: selections start fixes. */
  stepIndex: number | null;
  outputs: readonly (string | null)[];
  fixes: HistoryFixesController;
}) {
  const { t } = useTranslation();
  const chosen = useHistoryViewStore((state) => state.heardView);
  const views: HistoryHeardView[] =
    correction === null ? ["heard", "afterSpeech"] : ["heard", "afterSpeech", "correction"];
  const view = views.includes(chosen) ? chosen : "heard";
  const other = view === "afterSpeech" ? finalText : view === "correction" ? correction : null;
  const segments = useMemo(() => timeline ?? segmentText(heard), [timeline, heard]);
  const pieces = useMemo(() => heardPieces(heard, other), [heard, other]);
  const timed = !!timeline && !!player;
  const sentence = useEstimatedSentence(timed ? player : null, timeline);
  const box = useRef<HTMLDivElement>(null);
  const rendered = useMemo(() => {
    const shown: HeardPiece[] = pieces ?? [{ kind: "heard", start: 0, end: heard.length }];
    return shown.map((piece) => ({
      piece,
      chunks: piece.kind === "added" ? [] : chunksOf(heard, segments, piece.start, piece.end),
    }));
  }, [pieces, heard, segments]);

  useStepTextSelection(box, fixes, outputs);
  // A new view or text: what was selected in the old one goes.
  const { setSelection } = fixes;
  useEffect(() => {
    try {
      const selection = box.current?.ownerDocument.getSelection?.();
      if (
        selection &&
        box.current &&
        selection.anchorNode &&
        box.current.contains(selection.anchorNode)
      ) {
        selection.removeAllRanges();
      }
    } catch {
      // Nothing to clear.
    }
    setSelection(null);
  }, [view, other, setSelection]);

  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (!timed || !timeline || !player) return;
    const selection = event.currentTarget.ownerDocument.getSelection?.();
    if (selection && !selection.isCollapsed) return;
    const word = (event.target as Element | null)?.closest?.("[data-heard-at]");
    if (!word) return;
    void player.playFrom(wordPlayTime(timeline, Number(word.getAttribute("data-heard-at"))));
  };

  const renderChunks = (chunks: Chunk[]) =>
    chunks.map((chunk, index) =>
      chunk.word === null ? (
        chunk.text
      ) : (
        <span
          key={index}
          data-heard-at={chunk.word}
          data-now={chunk.sentence === sentence || undefined}
          className={cn(
            "rounded-[3px]",
            timed && "cursor-pointer hover:bg-primary/12",
            chunk.sentence === sentence && "bg-primary/10 dark:bg-primary/15"
          )}
        >
          {chunk.text}
        </span>
      )
    );

  const legend =
    view === "afterSpeech"
      ? t("historyView.heard.legend.afterSpeech")
      : view === "correction"
        ? t("historyView.heard.legend.correction")
        : t(timed ? "historyView.heard.legend.heard" : "historyView.heard.legend.plain");

  return (
    <div data-heard-text={view}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ViewSwitch views={views} />
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">{legend}</p>
      </div>
      <div ref={box} className="relative">
        <p
          dir="auto"
          data-heard-body
          data-step-output={stepIndex ?? undefined}
          onClick={onClick}
          className="whitespace-pre-wrap wrap-break-word text-sm leading-7 text-foreground"
        >
          {rendered.map(({ piece, chunks: pieceChunks }, index) => {
            if (piece.kind === "added") {
              return (
                <ins
                  key={index}
                  data-diff-mark
                  className="rounded-[3px] bg-success/15 px-px text-foreground no-underline dark:bg-success/20"
                >
                  {piece.text}
                </ins>
              );
            }
            const chunks = renderChunks(pieceChunks);
            if (piece.kind === "removed") {
              return (
                <s
                  key={index}
                  data-heard-removed
                  className="rounded-[3px] bg-destructive/10 text-destructive/85 decoration-destructive/60 dark:bg-destructive/15"
                >
                  {chunks}
                </s>
              );
            }
            if (piece.kind === "case") {
              return (
                <span
                  key={index}
                  title={t("historyView.heard.caseNow", { text: piece.now })}
                  className="underline decoration-primary/70 decoration-dotted underline-offset-[3px]"
                >
                  {chunks}
                </span>
              );
            }
            return <span key={index}>{chunks}</span>;
          })}
        </p>
        {pieces === null && (
          <p className="mt-1.5 text-[11px] italic text-muted-foreground">
            {t("historyView.steps.tooLong")}
          </p>
        )}
        <SelectionActions fixes={fixes} />
      </div>
    </div>
  );
}
