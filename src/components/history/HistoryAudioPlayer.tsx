import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { AudioLines, Loader2, Pause, Play } from "../icons";
import { formatMmSs } from "../../utils/formatDuration";
import { useUiLocale } from "../../hooks/useUiLocale";
import {
  formatClock,
  heardOffsetAt,
  sentenceAtTime,
  sentenceStartAt,
  type CorrectionPlacement,
  type HeardTimeline,
  type WordAnchors,
} from "../../utils/historyPlaybackTimes";
import { Kbd } from "./HistoryReview";
import {
  CORRECTION_FIELD_ID,
  PLAY_KEYS,
  SKIP_SECONDS,
  altKeyLabel,
  usePlayerState,
  type HistoryPlayer,
} from "./historyPlayer";

// The History player's controls (play/pause, ±5 s, a seek bar with sentence
// ticks and the correction's edit marks, speed, "back 2 s on resume"), the
// estimated-position line shown beside the correction, and "From your
// cursor". Positions taken from the text are estimates and say so.

function SeekBar({
  player,
  ticks,
  marks,
}: {
  player: HistoryPlayer;
  ticks: readonly number[];
  marks: readonly number[];
}) {
  const { t } = useTranslation();
  const position = usePlayerState(player, (state) => state.position);
  const length = usePlayerState(player, (state) => state.length);
  const shown = Math.max(length, position);
  const at = (seconds: number) => (shown > 0 ? Math.min(100, (seconds / shown) * 100) : 0);
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);

  const seekTo = (clientX: number) => {
    const bar = ref.current;
    if (!bar || shown <= 0) return;
    const rect = bar.getBoundingClientRect();
    if (!rect.width) return;
    player.seek(((clientX - rect.left) / rect.width) * shown);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragging.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Dragging still works while the pointer stays on the bar.
    }
    seekTo(event.clientX);
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current !== event.pointerId) return;
    dragging.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Already released.
    }
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      dir="ltr"
      aria-label={t("historyView.audio.position")}
      aria-valuemin={0}
      aria-valuemax={Math.round(shown)}
      aria-valuenow={Math.round(position)}
      aria-valuetext={t("historyView.audio.positionText", {
        position: formatClock(position),
        length: formatClock(shown),
      })}
      title={t("historyView.audio.seekHint")}
      data-history-seek
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (dragging.current === event.pointerId) seekTo(event.clientX);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") player.skip(-SKIP_SECONDS);
        else if (event.key === "ArrowRight" || event.key === "ArrowUp") player.skip(SKIP_SECONDS);
        else if (event.key === "Home") player.seek(0);
        else if (event.key === "End") player.seek(shown);
        else return;
        event.preventDefault();
      }}
      className="relative h-6 min-w-[8rem] flex-1 cursor-pointer touch-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted dark:bg-white/10">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `${at(position)}%` }}
        />
        {ticks.map((time) => (
          <span
            key={time}
            aria-hidden="true"
            data-sentence-tick
            className="absolute -top-1 h-3 w-px bg-foreground/25"
            style={{ left: `${at(time)}%` }}
          />
        ))}
      </div>
      {marks.map((time) => (
        <span
          key={time}
          aria-hidden="true"
          data-edit-mark={time.toFixed(2)}
          title={t("historyView.audio.editMark", { time: formatClock(time) })}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            void player.playFrom(Math.max(0, time - 1));
          }}
          className="absolute top-0 z-10 size-2 -translate-x-1/2 cursor-pointer rounded-full bg-warning ring-2 ring-card"
          style={{ left: `${at(time)}%` }}
        />
      ))}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow ring-1 ring-black/20"
        style={{ left: `${at(position)}%` }}
      />
    </div>
  );
}

/** The transport: play/pause, ±5 s, the seek bar, time, speed and "back 2 s on resume". */
export default function HistoryAudioPlayer({
  player,
  ticks = [],
  marks = [],
  className,
}: {
  player: HistoryPlayer;
  /** Estimated sentence starts, in seconds (none without a known length). */
  ticks?: readonly number[];
  /** Estimated places the correction differs from the final output. */
  marks?: readonly number[];
  className?: string;
}) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const status = usePlayerState(player, (state) => state.status);
  const position = usePlayerState(player, (state) => state.position);
  const length = usePlayerState(player, (state) => state.length);
  const rate = usePlayerState(player, (state) => state.rate);
  const backOnResume = usePlayerState(player, (state) => state.backOnResume);
  const playing = status === "playing";
  const unavailable = status === "unavailable";
  const alt = altKeyLabel();
  const rateText = t("historyView.audio.rate", {
    rate: new Intl.NumberFormat(locale).format(rate),
  });
  const smallButton =
    "h-7 shrink-0 rounded-md border border-border/70 bg-background/60 px-2 text-[11.5px] tabular-nums text-foreground/90 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 dark:border-white/10";

  return (
    <div
      data-history-player
      className={cn(
        "@container rounded-lg border border-border/70 bg-card px-3 py-2 dark:border-white/10 dark:bg-surface-2",
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <button
          type="button"
          onClick={() => void player.toggle()}
          disabled={status === "loading" || unavailable}
          aria-label={t(playing ? "historyView.audio.pause" : "historyView.audio.play")}
          title={t("historyView.audio.playHint", { keys: PLAY_KEYS })}
          className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
        >
          {status === "loading" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : playing ? (
            <Pause size={14} />
          ) : (
            <Play size={14} />
          )}
        </button>
        {unavailable ? (
          <p className="text-xs text-muted-foreground">{t("controlPanel.history.audioNotFound")}</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => player.skip(-SKIP_SECONDS)}
              aria-label={t("historyView.audio.back")}
              title={t("historyView.audio.backHint", { keys: `${alt}+←` })}
              className={smallButton}
            >
              <span dir="ltr">{t("historyView.audio.backShort")}</span>
            </button>
            <button
              type="button"
              onClick={() => player.skip(SKIP_SECONDS)}
              aria-label={t("historyView.audio.forward")}
              title={t("historyView.audio.forwardHint", { keys: `${alt}+→` })}
              className={smallButton}
            >
              <span dir="ltr">{t("historyView.audio.forwardShort")}</span>
            </button>
            <SeekBar player={player} ticks={ticks} marks={marks} />
            <span dir="ltr" className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatMmSs(position)} / {formatMmSs(Math.max(length, position))}
            </span>
            <button
              type="button"
              onClick={player.cycleRate}
              aria-label={t("historyView.audio.rateLabel", { rate: rateText })}
              title={t("historyView.audio.rateHint", { keys: `${alt}+↑ / ${alt}+↓` })}
              data-history-rate
              className={cn(smallButton, "min-w-11")}
            >
              {rateText}
            </button>
            <label
              title={t("historyView.audio.backOnResumeHint")}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-[11.5px] text-muted-foreground"
            >
              <input
                type="checkbox"
                checked={backOnResume}
                onChange={(event) => player.setBackOnResume(event.target.checked)}
                className="size-3.5 accent-primary"
              />
              {t("historyView.audio.backOnResume")}
            </label>
            <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground/80 @4xl:flex">
              <Kbd>{PLAY_KEYS}</Kbd>
              {t("historyView.audio.keysPlay")}
              <Kbd>{`${alt}+← →`}</Kbd>
              {t("historyView.audio.keysSkip")}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The sentence estimated to be playing, beside the correction (not a live
 * region: it would chatter). Before anything plays, how to start it.
 */
export function EstimatedPosition({
  player,
  timeline,
}: {
  player: HistoryPlayer;
  timeline: HeardTimeline;
}) {
  const { t } = useTranslation();
  const sentence = usePlayerState(player, (state) =>
    state.status === "playing" || state.position > 0 ? sentenceAtTime(timeline, state.position) : -1
  );
  const span = sentence >= 0 ? timeline.sentences[sentence] : null;
  return (
    <div
      data-estimated-position
      title={t("historyView.audio.estimatedHint")}
      className="flex shrink-0 items-baseline gap-2 rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-[12.5px] leading-relaxed"
    >
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary">
        <AudioLines size={12} className="self-center" />
        {t("historyView.audio.estimated")}
      </span>
      {span ? (
        <span dir="auto" className="min-w-0 flex-1 text-foreground/90">
          {timeline.text.slice(span.start, span.end)}
        </span>
      ) : (
        <span className="min-w-0 flex-1 text-muted-foreground">
          {t("historyView.audio.estimatedIdle", { keys: PLAY_KEYS })}
        </span>
      )}
    </div>
  );
}

/**
 * "From your cursor": plays the sentence the correction's caret is in, found
 * through a word both diffs matched in that sentence. Disabled, with why,
 * when there's none.
 */
export function FromCursor({
  placement,
  toHeard,
  timeline,
  onPlay,
}: {
  placement: CorrectionPlacement | null;
  toHeard: WordAnchors | null;
  timeline: HeardTimeline;
  onPlay: () => void;
}) {
  const { t } = useTranslation();
  const [caret, setCaret] = useState<number | null>(null);

  useEffect(() => {
    const field = document.getElementById(CORRECTION_FIELD_ID) as HTMLTextAreaElement | null;
    if (!field) return;
    const read = () => setCaret(field.selectionStart ?? null);
    read();
    const events = ["select", "keyup", "click", "input", "focus"] as const;
    events.forEach((name) => field.addEventListener(name, read));
    return () => events.forEach((name) => field.removeEventListener(name, read));
  }, []);

  const heard = placement && caret !== null ? heardOffsetAt(placement, caret, toHeard) : null;
  const time = heard === null ? null : sentenceStartAt(timeline, heard);
  const alt = altKeyLabel();
  return (
    <div data-from-cursor className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs"
        disabled={time === null}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onPlay}
        title={t("historyView.audio.fromCursorHint", { keys: `${alt}+Enter` })}
      >
        <Play size={11} />
        {t("historyView.audio.fromCursor")}
        {time !== null && (
          <span dir="ltr" className="tabular-nums text-muted-foreground">
            · {formatClock(time)}
          </span>
        )}
      </Button>
      <span className="text-[11px] text-muted-foreground">
        {time === null ? (
          t("historyView.audio.fromCursorNone")
        ) : (
          <>
            <Kbd>{`${alt}+Enter`}</Kbd> {t("historyView.audio.fromCursorKey")}
          </>
        )}
      </span>
    </div>
  );
}
