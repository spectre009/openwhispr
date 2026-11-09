import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import ClampedText from "../ui/ClampedText";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { showInFolderLabelKey, useAddToTestSet } from "../ui/historyActions";
import {
  AlertCircle,
  ArrowLeft,
  Copy,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Settings,
  TestTube,
  Trash2,
  Wand2,
} from "../icons";
import { useStyleStore } from "../../stores/styleStore";
import { findStyle, styleIdFromRouteKind } from "../../config/styles/library";
import { normalizeDbDate } from "../../utils/dateFormatting";
import { formatMmSs } from "../../utils/formatDuration";
import {
  openProviderSettings,
  type ProviderSettingsTarget,
} from "../../utils/describeProviderError";
import { providerSettingsTargetFor } from "../../helpers/providerHttpErrors.js";
import { useUiLocale } from "../../hooks/useUiLocale";
import {
  editMarkTimes,
  heardOffsetAt,
  heardTimeline,
  placeCorrection,
  sentenceStartAt,
  sentenceStartTimes,
  wordAnchors,
  type WordAnchors,
} from "../../utils/historyPlaybackTimes";
import type { HistoryItemResult } from "../../types/electron";
import HistoryAudioPlayer, { EstimatedPosition, FromCursor } from "./HistoryAudioPlayer";
import HistoryDictionaryCard, { DictionaryFinalText } from "./HistoryDictionary";
import { insertedDictionaryWords, visibleDictionaryWords } from "./historyDictionaryWords";
import {
  HotkeyReviewBanner,
  ReviewButtons,
  ReviewForm,
  ReviewNotice,
  SavedReview,
  type FieldFocus,
} from "./HistoryReview";
import { useHistoryReview, type ReviewConfirm } from "./useHistoryReview";
import { FixSuggestion, HistoryFixDialogs } from "./HistoryFixes";
import { useHistoryFixes } from "./useHistoryFixes";
import { StepsSection, WithoutSteps } from "./HistorySteps";
import HistoryWideLayout from "./HistoryWideLayout";
import {
  CORRECTION_FIELD_ID,
  useDebouncedText,
  useHistoryPlayer,
  useHistoryPlayerShortcuts,
  usePlayerLength,
} from "./historyPlayer";

// One dictation in full, read by id (history-get-item): its time, app and
// actions, its recording's player, then either the stacked layout (the final
// text in the header, the review form under the player while a 👎 draft is
// open, the dictionary words, the steps, a saved review) or, when the view
// has room for a completed dictation with something heard, the wide layout
// (HistoryWideLayout): what speech heard beside the final output or the
// review form. The player and its keys belong to the row, not the layout, so
// switching layouts keeps playback and the correction's caret. A 👎 review
// highlights the step it names and suggests fixes for it (HistoryFixes).

type LoadedItem = Extract<HistoryItemResult, { success: true }>;
type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "notFound" }
  | { status: "ready"; result: LoadedItem };
/** Re-transcribe the recording, or Re-run cleanup on the stored raw transcript. */
type RerunKind = "transcribe" | "cleanup";

/** What the History view needs from the shown dictation to choose the layout and fold the list. */
export interface DetailLayoutInfo {
  id: number;
  /** A completed dictation with text and something heard, from this owner's view. */
  eligible: boolean;
  /** The owner tag its review drafts are kept under. */
  owner: string | null;
}
interface HistoryDetailProps {
  id: number;
  /** Bumped by the view when main reports this row changed. */
  revision: number;
  /** Narrow layouts: back to the list. */
  onBack?: () => void;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  /** Re-transcribe; `cleanupOnly`: Re-run cleanup on the stored raw transcript. */
  onRetry: (id: number, routeKind: string | null, cleanupOnly?: boolean) => Promise<void>;
  onShowAudioInFolder: (id: number) => void;
  /** Local history is on, so a review can be kept. */
  historyOn: boolean;
  onOpenPrivacy: () => void;
  /** Opens Settings, at a destination (a review's fixes: Prompt Studio, Styles). */
  onOpenSettings: (destination?: string) => void;
  /** Asks first, in the view's confirm dialog. */
  confirm: (options: ReviewConfirm) => void;
  /** The view has room for the wide layout (decided with the list's state); used for a dictation it suits. */
  wide?: boolean;
  /** What the view needs to decide the layout and fold the list. */
  onLayoutInfo?: (info: DetailLayoutInfo) => void;
}

export default function HistoryDetail({
  id,
  revision,
  onBack,
  onCopy,
  onDelete,
  onRetry,
  onShowAudioInFolder,
  historyOn,
  onOpenPrivacy,
  onOpenSettings,
  confirm,
  wide = false,
  onLayoutInfo,
}: HistoryDetailProps) {
  const { t } = useTranslation();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  // Which re-run is going: Re-transcribe or Re-run cleanup (one at a time).
  const [retrying, setRetrying] = useState<RerunKind | null>(null);
  // Bumped when a review finds the dictation changed under it.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const read = window.electronAPI?.getHistoryItem;
    if (!read) {
      setLoad({ status: "error" });
      return;
    }
    read(id).then(
      (reply) => {
        if (cancelled) return;
        if (reply?.success) setLoad({ status: "ready", result: reply });
        else {
          const code = (reply as { code?: string } | null)?.code;
          setLoad({ status: code === "NOT_FOUND" ? "notFound" : "error" });
        }
      },
      () => {
        if (!cancelled) setLoad({ status: "error" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [id, revision, reloads]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  // "Dictionary in this dictation" reads the current dictionary and, for who
  // fixed a word, the current owner's steps: read the row again when either
  // changes.
  useEffect(() => {
    const api = window.electronAPI;
    const again = () => setReloads((n) => n + 1);
    const disposers = [
      api?.onDictionaryUpdated?.(again),
      api?.onSnippetsUpdated?.(again),
      api?.onDictionaryHistoryChanged?.(again),
    ];
    return () => disposers.forEach((dispose) => dispose?.());
  }, []);

  const retry = useCallback(
    async (routeKind: string | null, kind: RerunKind = "transcribe") => {
      if (retrying) return;
      setRetrying(kind);
      try {
        await onRetry(id, routeKind, kind === "cleanup");
      } finally {
        setRetrying(null);
      }
    },
    [id, onRetry, retrying]
  );

  const back = onBack ? (
    <div className="shrink-0 border-b border-border/70 px-3 py-2 dark:border-white/10">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="rtl:-scale-x-100" />
        {t("historyView.detail.back")}
      </Button>
    </div>
  ) : null;

  if (load.status !== "ready") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {back}
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {load.status === "loading" ? (
            <Loader2 size={16} className="animate-spin text-primary" />
          ) : (
            t(
              load.status === "notFound"
                ? "historyView.detail.notFound"
                : "historyView.detail.loadError"
            )
          )}
        </div>
      </div>
    );
  }

  return (
    <LoadedDetail
      result={load.result}
      back={back}
      retrying={retrying}
      onRetry={retry}
      onCopy={onCopy}
      onDelete={onDelete}
      onShowAudioInFolder={onShowAudioInFolder}
      historyOn={historyOn}
      onOpenPrivacy={onOpenPrivacy}
      onOpenSettings={onOpenSettings}
      confirm={confirm}
      reload={reload}
      wide={wide}
      onLayoutInfo={onLayoutInfo}
    />
  );
}

function LoadedDetail({
  result,
  back,
  retrying,
  onRetry,
  onCopy,
  onDelete,
  onShowAudioInFolder,
  historyOn,
  onOpenPrivacy,
  onOpenSettings,
  confirm,
  reload,
  wide,
  onLayoutInfo,
}: {
  result: LoadedItem;
  back: ReactNode;
  retrying: RerunKind | null;
  onRetry: (routeKind: string | null, kind?: RerunKind) => Promise<void>;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onShowAudioInFolder: (id: number) => void;
  historyOn: boolean;
  onOpenPrivacy: () => void;
  onOpenSettings: (destination?: string) => void;
  confirm: (options: ReviewConfirm) => void;
  reload: () => void;
  wide: boolean;
  onLayoutInfo?: (info: DetailLayoutInfo) => void;
}) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const addToTestSet = useAddToTestSet();
  const styleLibrary = useStyleStore((state) => state.library);
  const { item, steps } = result;
  const player = useHistoryPlayer(item.id, item.hasAudio, item.audioDurationMs);
  const review = useHistoryReview({
    result,
    reload,
    confirm,
    onHidePanel: () => player?.suspend(),
  });
  const fixes = useHistoryFixes({ result, review, onCopy, onOpenSettings });
  const dictionaryWords = useMemo(
    () => visibleDictionaryWords(result.dictionary),
    [result.dictionary]
  );
  const markWords = useMemo(() => insertedDictionaryWords(dictionaryWords), [dictionaryWords]);
  const captured = result.status === "captured" && steps.length > 0;
  const app = captured ? (result.context?.targetApp ?? null) : null;
  const completed = item.status === "completed";
  const failed = item.status === "failed";
  // Re-run cleanup: a completed dictation with a raw transcript, never an
  // assistant command; the recording isn't needed.
  const assistantCommand =
    captured && (result.route === "agent" || result.context?.intents?.voiceAgent === true);
  const canRerunCleanup = completed && !!item.rawText?.trim() && !assistantCommand;
  const rerunCleanup = canRerunCleanup ? () => void onRetry(item.routeKind, "cleanup") : undefined;
  // A failed transcription's fix, from the code its row kept.
  const failedSettingsTarget = failed
    ? (providerSettingsTargetFor(item.errorCode, "transcription") as
        ProviderSettingsTarget | undefined)
    : undefined;
  const date = item.timestamp ? normalizeDbDate(item.timestamp) : null;
  const when =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
      : null;
  const audioLength =
    item.audioDurationMs && item.audioDurationMs > 0
      ? formatMmSs(Math.round(item.audioDurationMs / 1000))
      : null;
  const styleId = styleIdFromRouteKind(item.routeKind);
  const style = styleId ? findStyle(styleLibrary, styleId) : undefined;
  const styleLabel = styleId
    ? style
      ? `${style.emoji ? `${style.emoji} ` : ""}${style.name}`
      : t("controlPanel.history.steps.deletedStyle")
    : null;
  const canPin = completed && !!item.rawText?.trim();

  // What speech heard: the speech-to-text step's output, else the row's raw transcript.
  const sttIndex = captured
    ? steps.findIndex((step) => step.kind === "stt" && typeof step.output === "string")
    : -1;
  const heard = sttIndex >= 0 ? (steps[sttIndex].output as string) : (item.rawText ?? "");
  const finalText = completed ? item.text : "";
  const eligible = completed && !!item.text && !!heard.trim() && result.status !== "otherOwner";
  const wideLayout = wide && eligible;
  // A translation's final output is in another language: nothing in it places in the recording.
  const translated =
    captured &&
    (result.context?.intents?.translation === true ||
      steps.some((step) => step.kind === "translation" && step.outcome === "ok"));

  useLayoutEffect(() => {
    onLayoutInfo?.({ id: item.id, eligible, owner: result.owner });
  }, [onLayoutInfo, item.id, eligible, result.owner]);

  // Estimated times, only with a recording of known length and something heard.
  const length = usePlayerLength(player);
  const timeline = useMemo(
    () => (player ? heardTimeline(heard, length) : null),
    [player, heard, length]
  );
  const ticks = useMemo(
    () => (timeline ? sentenceStartTimes(timeline).filter((time) => time > 0) : []),
    [timeline]
  );
  const { draft } = review;
  const correction = draft?.expectedText ?? "";
  const settled = useDebouncedText(correction);
  const placing = !!draft && !!timeline && !translated && !!correction.trim();
  // The heard ↔ final alignment is worked out once per row; the correction's as it settles.
  const anchorsCache = useRef<{ heard: string; finalText: string; anchors: WordAnchors | null }>(
    null
  );
  const toHeard = useMemo(() => {
    if (!placing) return null;
    const cached = anchorsCache.current;
    if (cached && cached.heard === heard && cached.finalText === finalText) return cached.anchors;
    const anchors = wordAnchors(heard, finalText);
    anchorsCache.current = { heard, finalText, anchors };
    return anchors;
  }, [placing, heard, finalText]);
  const placement = useMemo(
    () => (placing && settled.trim() ? placeCorrection(finalText, settled) : null),
    [placing, finalText, settled]
  );
  const marks = useMemo(
    () => (placement && timeline ? editMarkTimes(placement, toHeard, timeline) : []),
    [placement, toHeard, timeline]
  );

  const playFromCursor = () => {
    if (!player || !timeline || !placing || !draft) return;
    const field = document.getElementById(CORRECTION_FIELD_ID) as HTMLTextAreaElement | null;
    const now = placeCorrection(finalText, draft.expectedText);
    const at = now ? heardOffsetAt(now, field?.selectionStart ?? 0, toHeard) : null;
    if (at !== null) void player.playFrom(sentenceStartAt(timeline, at));
  };
  useHistoryPlayerShortcuts(player, playFromCursor);

  // The correction's focus and caret, kept while the form moves between layouts.
  const keepFocus = useRef<FieldFocus | null>(null);
  useEffect(() => {
    if (!draft) keepFocus.current = null;
  }, [draft]);

  const estimated =
    player && timeline ? <EstimatedPosition player={player} timeline={timeline} /> : null;
  const fromCursor =
    placing && timeline ? (
      <FromCursor
        placement={placement}
        toHeard={toHeard}
        timeline={timeline}
        onPlay={playFromCursor}
      />
    ) : null;
  const reviewForm = (layout: "stacked" | "pane") => (
    <ReviewForm
      review={review}
      historyOn={historyOn}
      onOpenPrivacy={onOpenPrivacy}
      fixes={<FixSuggestion fixes={fixes} compact={layout === "pane"} />}
      layout={layout}
      estimated={estimated}
      fromCursor={fromCursor}
      keepFocus={keepFocus}
    />
  );

  const finalBlock = failed ? (
    <p className="flex items-center gap-2 text-base font-medium text-destructive">
      <AlertCircle size={16} className="shrink-0" />
      {t("controlPanel.history.transcriptionFailed")}
    </p>
  ) : item.status === "discarded" ? (
    <p className="text-base text-muted-foreground">
      {t("controlPanel.history.discarded.recording")}
    </p>
  ) : item.text ? (
    <ClampedText collapsedRem={10}>
      <p
        dir="auto"
        className="whitespace-pre-wrap wrap-break-word text-base font-medium leading-relaxed text-foreground"
        data-history-final-text
      >
        <DictionaryFinalText text={item.text} words={dictionaryWords} />
      </p>
    </ClampedText>
  ) : (
    <p className="text-base italic text-muted-foreground">{t("historyView.list.noText")}</p>
  );

  const header = (
    <div
      className={cn(
        "flex flex-wrap gap-x-4 gap-y-3",
        wideLayout ? "shrink-0 items-center" : "items-start"
      )}
    >
      <div className="min-w-0 flex-[1_1_18rem]">
        {!wideLayout && finalBlock}
        <p
          className={cn(
            "flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground",
            !wideLayout && "mt-1.5"
          )}
        >
          {when && <span>{when}</span>}
          <span>
            {app ? (
              <BidiInterpolatedText
                text={t("historyView.detail.inApp", { app: BIDI_VALUE_TOKEN })}
                value={app}
              />
            ) : (
              t("historyView.detail.appNotRecorded")
            )}
          </span>
          {audioLength && (
            <span>
              <BidiInterpolatedText
                text={t("historyView.detail.audioLength", { duration: BIDI_VALUE_TOKEN })}
                value={audioLength}
              />
            </span>
          )}
          {styleLabel && <span dir="auto">{styleLabel}</span>}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <ReviewButtons review={review} />
        {completed && item.text && (
          <Button variant="outline" size="sm" onClick={() => onCopy(item.text)}>
            <Copy size={13} />
            {t("common.copy")}
          </Button>
        )}
        {item.hasAudio && (
          <Button
            variant="outline"
            size="sm"
            disabled={retrying !== null}
            onClick={() => void onRetry(item.routeKind)}
          >
            {retrying === "transcribe" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RotateCcw size={13} />
            )}
            {t("controlPanel.history.retryTranscription")}
          </Button>
        )}
        {rerunCleanup && (
          <Button variant="outline" size="sm" disabled={retrying !== null} onClick={rerunCleanup}>
            {retrying === "cleanup" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Wand2 size={13} />
            )}
            {t("controlPanel.history.rerunCleanup.action")}
          </Button>
        )}
        {canPin && (
          <Button variant="outline" size="sm" onClick={() => void addToTestSet(item.id)}>
            <TestTube size={13} />
            {t("controlPanel.history.testSet.add")}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("controlPanel.history.moreActions")}
              className="size-8 rounded-full"
            >
              <MoreHorizontal size={15} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {item.hasAudio && (
              <DropdownMenuItem className="gap-2.5" onSelect={() => onShowAudioInFolder(item.id)}>
                <FolderOpen size={14} className="shrink-0 opacity-70" />
                {t(showInFolderLabelKey())}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="gap-2.5 text-destructive focus:bg-destructive/8 focus:text-destructive"
              onSelect={() => onDelete(item.id)}
            >
              <Trash2 size={14} className="shrink-0 opacity-70" />
              {t("controlPanel.history.deleteItem")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  // The same elements in the same places in both layouts up to the body, so
  // the player stays mounted when the layout changes.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {back}
      <div
        data-history-detail={wideLayout ? "wide" : "stacked"}
        className={cn("min-h-0 flex-1 overflow-y-auto", wideLayout && "flex flex-col")}
      >
        <div
          className={
            wideLayout
              ? "flex min-h-[34rem] flex-1 flex-col gap-3 px-5 pt-4 pb-4"
              : "mx-auto w-full max-w-3xl px-6 pt-5 pb-12"
          }
        >
          {review.hotkey && <HotkeyReviewBanner />}
          {header}
          {player && (
            <div
              className={
                wideLayout
                  ? "shrink-0"
                  : "sticky top-0 z-20 -mx-2 mt-4 bg-background/95 px-2 py-1.5 backdrop-blur-sm"
              }
            >
              <HistoryAudioPlayer player={player} ticks={ticks} marks={marks} />
            </div>
          )}
          <ReviewNotice review={review} />
          {wideLayout ? (
            <HistoryWideLayout
              result={result}
              app={app}
              captured={captured}
              styleLibrary={styleLibrary}
              review={review}
              fixes={fixes}
              player={player}
              timeline={timeline}
              heard={heard}
              sttIndex={sttIndex >= 0 ? sttIndex : null}
              correction={draft ? settled : null}
              dictionaryWords={dictionaryWords}
              dictionaryAligned={result.dictionaryAligned !== false}
              markWords={markWords}
              onRerunCleanup={rerunCleanup}
              rerunBusy={retrying !== null}
              rerunning={retrying === "cleanup"}
              reviewForm={reviewForm("pane")}
              savedReview={
                <SavedReview review={review} fixes={<FixSuggestion fixes={fixes} compact />} />
              }
            />
          ) : (
            <>
              {failed && (
                <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3.5">
                  {item.errorMessage && (
                    <p dir="auto" className="text-sm leading-relaxed text-foreground/90">
                      {item.errorMessage}
                    </p>
                  )}
                  {item.errorCode && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t("controlPanel.history.steps.errorCode", { code: item.errorCode })}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(
                      item.hasAudio
                        ? "historyView.detail.failedRetry"
                        : "historyView.detail.failedNoAudio"
                    )}
                  </p>
                  {failedSettingsTarget && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => openProviderSettings(failedSettingsTarget)}
                    >
                      <Settings size={13} />
                      {t("providerErrors.openSettings")}
                    </Button>
                  )}
                </div>
              )}
              {reviewForm("stacked")}
              {completed && (
                <HistoryDictionaryCard
                  itemId={item.id}
                  words={dictionaryWords}
                  aligned={result.dictionaryAligned !== false}
                />
              )}
              {captured ? (
                <StepsSection
                  result={result}
                  app={app}
                  styleLibrary={styleLibrary}
                  fixes={fixes}
                  onRerunCleanup={rerunCleanup}
                  rerunBusy={retrying !== null}
                  rerunning={retrying === "cleanup"}
                  markWords={markWords}
                />
              ) : (
                completed && (
                  <WithoutSteps
                    item={item}
                    otherOwner={result.status === "otherOwner"}
                    finalBlamed={fixes.blamed === "delivery"}
                  />
                )
              )}
              <SavedReview review={review} fixes={<FixSuggestion fixes={fixes} />} />
            </>
          )}
          <HistoryFixDialogs fixes={fixes} />
        </div>
      </div>
    </div>
  );
}
