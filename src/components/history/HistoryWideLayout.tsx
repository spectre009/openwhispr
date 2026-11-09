import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { ThumbsDown } from "../icons";
import type { StyleLibrary } from "../../config/styles/library";
import type { HeardTimeline } from "../../utils/historyPlaybackTimes";
import type { HistoryDictionaryWord, HistoryItemResult } from "../../types/electron";
import HistoryDictionaryCard, { DictionaryFinalText } from "./HistoryDictionary";
import HistoryHeardText from "./HistoryHeardText";
import { Kbd } from "./HistoryReview";
import { StepCards, StepStrip, WithoutSteps, type StepJump } from "./HistorySteps";
import {
  SPLIT_MAX,
  SPLIT_MIN,
  setHistoryReferenceTab,
  setHistorySplitRatio,
  useHistoryViewStore,
  type HistoryReferenceTab,
} from "./historyViewStore";
import type { HistoryFixesController } from "./useHistoryFixes";
import type { HistoryReviewController } from "./useHistoryReview";
import type { HistoryPlayer } from "./historyPlayer";

// The History detail's wide layout, under its header and player: the step
// strip, then two panes side by side. The start pane is the reference (what
// speech heard, the step cards, the dictionary words), the end pane the final
// output or, while a 👎 review is open, the review form filling it. A divider
// between them sets the split (dragged or with ←/→), kept as a preference.

type LoadedItem = Extract<HistoryItemResult, { success: true }>;

const SPLIT_STEP = 0.05;

function PaneDivider({
  ratio,
  splitRef,
}: {
  ratio: number;
  splitRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const dragging = useRef<number | null>(null);
  const latest = useRef(ratio);
  useLayoutEffect(() => {
    latest.current = ratio;
  });

  const rtl = () => {
    const node = splitRef.current;
    return !!node && getComputedStyle(node).direction === "rtl";
  };
  const ratioAt = (clientX: number) => {
    const node = splitRef.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (!rect.width) return null;
    return (rtl() ? rect.right - clientX : clientX - rect.left) / rect.width;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Dragging still works while the pointer stays on the divider.
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current !== event.pointerId) return;
    const next = ratioAt(event.clientX);
    if (next !== null) setHistorySplitRatio(next, { persist: false });
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current !== event.pointerId) return;
    dragging.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Already released.
    }
    setHistorySplitRatio(latest.current);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let next: number;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const towardEnd = (event.key === "ArrowRight") !== rtl();
      next = ratio + (towardEnd ? SPLIT_STEP : -SPLIT_STEP);
    } else if (event.key === "Home") next = SPLIT_MIN;
    else if (event.key === "End") next = SPLIT_MAX;
    else return;
    event.preventDefault();
    setHistorySplitRatio(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("historyView.wide.divider")}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(SPLIT_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_MAX * 100)}
      tabIndex={0}
      data-history-divider
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      className="group flex w-3 shrink-0 cursor-col-resize touch-none items-center justify-center rounded focus-visible:outline-none"
    >
      <span className="h-10 w-1 rounded-full bg-border transition-colors group-hover:bg-foreground/30 group-focus-visible:bg-primary motion-reduce:transition-none dark:bg-white/15" />
    </div>
  );
}

const PANE_CLASS =
  "flex min-h-0 min-w-0 flex-col rounded-lg border border-border/70 bg-card/40 dark:border-white/10 dark:bg-surface-2/40";
const TAB_TRIGGER_CLASS =
  "h-7 rounded-md px-2.5 py-0 text-[12.5px] focus-visible:ring-offset-0 data-[state=active]:bg-background dark:data-[state=active]:bg-white/10";

export default function HistoryWideLayout({
  result,
  app,
  captured,
  styleLibrary,
  review,
  fixes,
  player,
  timeline,
  heard,
  sttIndex,
  correction,
  dictionaryWords,
  dictionaryAligned,
  markWords,
  onRerunCleanup,
  rerunBusy,
  rerunning,
  reviewForm,
  savedReview,
}: {
  result: LoadedItem;
  app: string | null;
  captured: boolean;
  styleLibrary: StyleLibrary;
  review: HistoryReviewController;
  fixes: HistoryFixesController;
  player: HistoryPlayer | null;
  timeline: HeardTimeline | null;
  heard: string;
  /** The speech-to-text step's seq when the heard text is its output. */
  sttIndex: number | null;
  /** The open draft's correction (debounced); null without one. */
  correction: string | null;
  dictionaryWords: readonly HistoryDictionaryWord[];
  dictionaryAligned: boolean;
  markWords: readonly string[];
  onRerunCleanup?: () => void;
  rerunBusy: boolean;
  rerunning: boolean;
  /** The review form, laid out for the end pane (shown while a draft is open). */
  reviewForm: ReactNode;
  /** A saved review, under the final output. */
  savedReview: ReactNode;
}) {
  const { t } = useTranslation();
  const { item, steps } = result;
  const ratio = useHistoryViewStore((state) => state.splitRatio);
  const chosenTab = useHistoryViewStore((state) => state.referenceTab);
  const splitRef = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState<StepJump | null>(null);
  const clearJump = useCallback(() => setJump(null), []);
  // The tab goes when a dictation has no dictionary words (and could be compared).
  const dictionaryTab = !dictionaryAligned || dictionaryWords.length > 0;
  const tab: HistoryReferenceTab =
    chosenTab === "dictionary" && !dictionaryTab ? "heard" : chosenTab;
  const outputs = steps.map((step) => step.output);

  const jumpTo = (index: number) => {
    setHistoryReferenceTab("steps");
    setJump({ index, nonce: Date.now() });
  };

  const browsing = (
    <div data-final-output className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-sm font-medium text-foreground">{t("historyView.steps.final")}</h3>
        <span className="text-[11px] text-muted-foreground/80">
          {app ? (
            <BidiInterpolatedText
              text={t("historyView.steps.sentTo", { app: BIDI_VALUE_TOKEN })}
              value={app}
            />
          ) : (
            t("historyView.steps.sentToUnknown")
          )}
        </span>
      </div>
      <p
        dir="auto"
        className="whitespace-pre-wrap wrap-break-word text-[15px] leading-relaxed text-foreground"
        data-history-final-text
      >
        <DictionaryFinalText text={item.text} words={dictionaryWords} />
      </p>
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={review.openBad}
          disabled={!review.canReview || review.saving}
          data-correct-it
        >
          <ThumbsDown size={13} className="text-destructive" />
          {t("historyView.wide.correctIt")}
          <Kbd>B</Kbd>
        </Button>
      </div>
      {savedReview}
    </div>
  );

  return (
    <>
      {captured && (
        <StepStrip
          steps={steps}
          app={app}
          blamed={fixes.blamed}
          onJump={jumpTo}
          className="shrink-0"
        />
      )}
      <div ref={splitRef} data-history-panes className="flex min-h-[16rem] flex-1">
        <section
          aria-label={t("historyView.wide.reference")}
          className={PANE_CLASS}
          style={{ flex: `${ratio} 1 0` }}
          data-history-pane="start"
        >
          <Tabs
            value={tab}
            onValueChange={(value) => setHistoryReferenceTab(value as HistoryReferenceTab)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="shrink-0 border-b border-border/70 px-3 py-2 dark:border-white/10">
              <TabsList className="h-8 gap-0.5 rounded-lg p-0.5">
                <TabsTrigger value="heard" className={TAB_TRIGGER_CLASS}>
                  {t("historyView.heard.tab")}
                </TabsTrigger>
                <TabsTrigger value="steps" className={TAB_TRIGGER_CLASS}>
                  {t("historyView.steps.title")}
                </TabsTrigger>
                {dictionaryTab && (
                  <TabsTrigger value="dictionary" className={TAB_TRIGGER_CLASS}>
                    {dictionaryAligned
                      ? t("historyView.wide.dictionaryCount", { number: dictionaryWords.length })
                      : t("historyView.wide.dictionary")}
                  </TabsTrigger>
                )}
              </TabsList>
            </div>
            <TabsContent value="heard" className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <HistoryHeardText
                heard={heard}
                finalText={item.text}
                correction={correction}
                timeline={timeline}
                player={player}
                stepIndex={sttIndex}
                outputs={outputs}
                fixes={fixes}
              />
            </TabsContent>
            <TabsContent value="steps" className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              {captured ? (
                <StepCards
                  result={result}
                  app={app}
                  styleLibrary={styleLibrary}
                  fixes={fixes}
                  onRerunCleanup={onRerunCleanup}
                  rerunBusy={rerunBusy}
                  rerunning={rerunning}
                  markWords={markWords}
                  jump={jump}
                  onJumped={clearJump}
                  headingClassName="mt-3"
                />
              ) : (
                <WithoutSteps
                  item={item}
                  otherOwner={result.status === "otherOwner"}
                  finalBlamed={fixes.blamed === "delivery"}
                  headingClassName="mt-3"
                />
              )}
            </TabsContent>
            {dictionaryTab && (
              <TabsContent
                value="dictionary"
                className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 py-3"
              >
                <HistoryDictionaryCard
                  itemId={item.id}
                  words={dictionaryWords}
                  aligned={dictionaryAligned}
                  variant="tab"
                />
              </TabsContent>
            )}
          </Tabs>
        </section>
        <PaneDivider ratio={ratio} splitRef={splitRef} />
        <section
          aria-label={t(review.draft ? "historyView.review.label" : "historyView.steps.final")}
          className={PANE_CLASS}
          style={{ flex: `${1 - ratio} 1 0` }}
          data-history-pane="end"
        >
          <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto p-4")}>
            {review.draft ? reviewForm : browsing}
          </div>
        </section>
      </div>
    </>
  );
}
