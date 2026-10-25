import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Pause, Play } from "../icons";
import { formatMmSs } from "../../utils/formatDuration";

// The kept recording of one dictation. Its audio is read from main only when
// Play is first pressed (get-audio-buffer) and lives in an object URL that is
// stopped and revoked when this player unmounts: the selection changed, the
// row was deleted or the view closed.

type PlayerState = "idle" | "loading" | "playing" | "paused" | "unavailable";

export default function HistoryAudioPlayer({
  id,
  durationMs,
}: {
  id: number;
  durationMs: number | null;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<PlayerState>("idle");
  const [position, setPosition] = useState(0);
  // MediaRecorder's WebM often reports no duration, so the saved one leads.
  const [length, setLength] = useState(durationMs && durationMs > 0 ? durationMs / 1000 : 0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const audio = audioRef.current;
      audioRef.current = null;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  const toggle = useCallback(async () => {
    const existing = audioRef.current;
    if (existing) {
      if (existing.paused) await existing.play().catch(() => setState("unavailable"));
      else existing.pause();
      return;
    }
    if (state === "loading") return;
    setState("loading");
    let buffer: ArrayBuffer | null = null;
    try {
      buffer = (await window.electronAPI?.getAudioBuffer?.(id)) ?? null;
    } catch {
      buffer = null;
    }
    if (!mountedRef.current) return;
    if (!buffer) {
      setState("unavailable");
      return;
    }
    const url = URL.createObjectURL(new Blob([buffer], { type: "audio/webm" }));
    urlRef.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.addEventListener("play", () => setState("playing"));
    audio.addEventListener("pause", () => setState("paused"));
    audio.addEventListener("ended", () => {
      setState("paused");
      setPosition(0);
    });
    audio.addEventListener("timeupdate", () => setPosition(audio.currentTime));
    audio.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setLength(audio.duration);
    });
    audio.addEventListener("error", () => setState("unavailable"));
    await audio.play().catch(() => {
      if (mountedRef.current) setState("unavailable");
    });
  }, [id, state]);

  const playing = state === "playing";
  const shownLength = Math.max(length, position);
  const progress = shownLength > 0 ? Math.min(100, (position / shownLength) * 100) : 0;

  return (
    <div className="mt-4 flex items-center gap-3 rounded-lg border border-border/70 bg-card/60 px-3 py-2 dark:border-white/10 dark:bg-surface-2/60">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={state === "loading" || state === "unavailable"}
        aria-label={t(playing ? "historyView.audio.pause" : "historyView.audio.play")}
        className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
      >
        {state === "loading" ? (
          <Loader2 size={14} className="animate-spin" />
        ) : playing ? (
          <Pause size={14} />
        ) : (
          <Play size={14} />
        )}
      </button>
      {state === "unavailable" ? (
        <p className="text-xs text-muted-foreground">{t("controlPanel.history.audioNotFound")}</p>
      ) : (
        <>
          <div
            role="progressbar"
            dir="ltr"
            aria-label={t("historyView.audio.position")}
            aria-valuemin={0}
            aria-valuemax={Math.round(shownLength)}
            aria-valuenow={Math.round(position)}
            className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted dark:bg-white/10"
          >
            <div
              className="absolute inset-y-0 start-0 rounded-full bg-primary"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span dir="ltr" className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatMmSs(position)} / {formatMmSs(shownLength)}
          </span>
        </>
      )}
    </div>
  );
}
