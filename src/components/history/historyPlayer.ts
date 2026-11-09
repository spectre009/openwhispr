import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCachedPlatform } from "../../utils/platform";
import { sentenceAtTime, type HeardTimeline } from "../../utils/historyPlaybackTimes";
import {
  PLAYBACK_RATES,
  setHistoryBackOnResume,
  setHistoryPlaybackRate,
  useHistoryViewStore,
} from "./historyViewStore";
import { OPEN_DIALOG, historyViewHas } from "./useHistoryReview";

// One dictation's recording, played in the History detail. The audio is read
// from main only when it's first played (get-audio-buffer) into an object URL,
// and released (stopped, URL revoked, media keys let go) when the detail goes:
// a new selection, the row deleted or the view left. One controller lives per
// shown row, outside the layout, so a layout change or a review opening keeps
// playback going. Its state is a small external store, so only what shows the
// position re-renders while it plays.

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "unavailable";

export interface PlayerSnapshot {
  status: PlayerStatus;
  /** Seconds. */
  position: number;
  /** Seconds; 0 while unknown. */
  length: number;
  rate: number;
  backOnResume: boolean;
}

export const SKIP_SECONDS = 5;
export const RESUME_REWIND_SECONDS = 2;
export const PLAY_KEYS = "Ctrl+Space";
/** The review form's correction field. */
export const CORRECTION_FIELD_ID = "history-review-expected";
export const altKeyLabel = () => (getCachedPlatform() === "darwin" ? "⌥" : "Alt");

export interface HistoryPlayer {
  getSnapshot: () => PlayerSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Play or pause; the first play loads the audio. */
  toggle: () => Promise<void>;
  /** An ordinary play: after the user's pause, from 2 s earlier when that's on. */
  resume: () => Promise<void>;
  /** Plays from a chosen time (a word, a mark, the caret's sentence): never rewound. */
  playFrom: (seconds: number) => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  skip: (seconds: number) => void;
  stepRate: (direction: 1 | -1) => void;
  cycleRate: () => void;
  setBackOnResume: (on: boolean) => void;
  /** The saved length, until the audio says otherwise. */
  setSavedLength: (durationMs: number | null) => void;
  /** Stops playback and lets the media keys go (the panel is being hidden). */
  suspend: () => void;
  /** Stops, unloads and revokes; the next play loads again. */
  release: () => void;
}

const isAbort = (error: unknown) =>
  !!error && typeof error === "object" && (error as { name?: string }).name === "AbortError";

export function createHistoryPlayer(id: number, durationMs: number | null): HistoryPlayer {
  const prefs = useHistoryViewStore.getState();
  let snapshot: PlayerSnapshot = {
    status: "idle",
    position: 0,
    // MediaRecorder's WebM often reports no duration, so the saved one leads.
    length: durationMs && durationMs > 0 ? durationMs / 1000 : 0,
    rate: prefs.playbackRate,
    backOnResume: prefs.backOnResume,
  };
  const listeners = new Set<() => void>();
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;
  let loading: Promise<HTMLAudioElement | null> | null = null;
  // Bumped by release(): a load that finishes after it is thrown away.
  let generation = 0;
  // The user paused: the next ordinary resume starts a little earlier.
  let rewindOnResume = false;
  let frame = 0;
  let sessionBound = false;

  const set = (patch: Partial<PlayerSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const currentTime = (element: HTMLAudioElement) =>
    typeof element.currentTime === "number" && Number.isFinite(element.currentTime)
      ? element.currentTime
      : snapshot.position;
  const clamp = (seconds: number) => {
    let at = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    if (snapshot.length > 0) at = Math.min(at, snapshot.length);
    return at;
  };

  const tick = () => {
    frame = 0;
    if (!audio || audio.paused) return;
    const at = currentTime(audio);
    if (Math.abs(at - snapshot.position) > 0.02) set({ position: at });
    frame = requestAnimationFrame(tick);
  };
  const startTicking = () => {
    if (!frame && typeof requestAnimationFrame === "function") frame = requestAnimationFrame(tick);
  };
  const stopTicking = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const mediaSession = () =>
    typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null;
  const bindMediaKeys = () => {
    const session = mediaSession();
    if (!session || sessionBound) return;
    try {
      session.setActionHandler("play", () => void resume());
      session.setActionHandler("pause", () => pause());
      sessionBound = true;
    } catch {
      // No media session here.
    }
  };
  const releaseMediaKeys = () => {
    if (!sessionBound) return;
    sessionBound = false;
    try {
      mediaSession()?.setActionHandler("play", null);
      mediaSession()?.setActionHandler("pause", null);
    } catch {
      // Already gone.
    }
  };

  const load = (): Promise<HTMLAudioElement | null> => {
    if (audio) return Promise.resolve(audio);
    if (loading) return loading;
    const mine = generation;
    set({ status: "loading" });
    loading = (async () => {
      let buffer: ArrayBuffer | null = null;
      try {
        buffer = (await window.electronAPI?.getAudioBuffer?.(id)) ?? null;
      } catch {
        buffer = null;
      }
      if (mine !== generation) return null;
      loading = null;
      if (!buffer) {
        set({ status: "unavailable" });
        return null;
      }
      url = URL.createObjectURL(new Blob([buffer], { type: "audio/webm" }));
      const element = new Audio(url);
      element.addEventListener("play", () => {
        set({ status: "playing" });
        startTicking();
      });
      element.addEventListener("pause", () => {
        stopTicking();
        if (snapshot.status === "playing")
          set({ status: "paused", position: currentTime(element) });
      });
      element.addEventListener("ended", () => {
        stopTicking();
        rewindOnResume = false;
        set({ status: "paused", position: 0 });
      });
      element.addEventListener("timeupdate", () => {
        if (!frame) set({ position: currentTime(element) });
      });
      element.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(element.duration) && element.duration > 0) {
          set({ length: element.duration });
        }
      });
      element.addEventListener("error", () => set({ status: "unavailable" }));
      element.playbackRate = snapshot.rate;
      if (snapshot.position > 0) element.currentTime = snapshot.position;
      audio = element;
      return element;
    })();
    return loading;
  };

  const start = async (rewind: boolean) => {
    if (snapshot.status === "unavailable") return;
    const mine = generation;
    const element = await load();
    if (!element || mine !== generation) return;
    if (rewind && rewindOnResume && snapshot.backOnResume) {
      const at = Math.max(0, snapshot.position - RESUME_REWIND_SECONDS);
      element.currentTime = at;
      set({ position: at });
    }
    rewindOnResume = false;
    element.playbackRate = snapshot.rate;
    try {
      await element.play();
    } catch (error) {
      if (mine === generation && !isAbort(error)) set({ status: "unavailable" });
      return;
    }
    if (mine !== generation || element.paused) return;
    set({ status: "playing" });
    bindMediaKeys();
    startTicking();
  };

  const resume = () => start(true);

  const pause = () => {
    if (!audio || audio.paused) return;
    audio.pause();
    stopTicking();
    const at = currentTime(audio);
    rewindOnResume = at > 0;
    set({ status: "paused", position: at });
  };

  const seek = (seconds: number) => {
    const at = clamp(seconds);
    rewindOnResume = false;
    if (audio) audio.currentTime = at;
    set({ position: at });
  };

  const setRate = (rate: number) => {
    if (!(PLAYBACK_RATES as readonly number[]).includes(rate)) return;
    if (audio) audio.playbackRate = rate;
    setHistoryPlaybackRate(rate);
    set({ rate });
  };
  const rateIndex = () => {
    const index = (PLAYBACK_RATES as readonly number[]).indexOf(snapshot.rate);
    return index >= 0 ? index : 1;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle: async () => {
      if (snapshot.status === "loading" || snapshot.status === "unavailable") return;
      if (audio && !audio.paused) {
        pause();
        return;
      }
      await resume();
    },
    resume,
    playFrom: async (seconds) => {
      seek(seconds);
      await start(false);
    },
    pause,
    seek,
    skip: (seconds) => seek(snapshot.position + seconds),
    stepRate: (direction) => {
      const index = Math.min(PLAYBACK_RATES.length - 1, Math.max(0, rateIndex() + direction));
      setRate(PLAYBACK_RATES[index]);
    },
    cycleRate: () => setRate(PLAYBACK_RATES[(rateIndex() + 1) % PLAYBACK_RATES.length]),
    setBackOnResume: (on) => {
      setHistoryBackOnResume(on);
      set({ backOnResume: on });
    },
    setSavedLength: (ms) => {
      if (audio || !ms || ms <= 0) return;
      set({ length: ms / 1000 });
    },
    suspend: () => {
      pause();
      releaseMediaKeys();
    },
    release: () => {
      generation += 1;
      loading = null;
      stopTicking();
      releaseMediaKeys();
      const element = audio;
      audio = null;
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
      if (url) URL.revokeObjectURL(url);
      url = null;
      rewindOnResume = false;
      if (snapshot.status !== "unavailable") set({ status: "idle" });
    },
  };
}

/**
 * The shown row's player, made once the row has audio (a new dictation's
 * audio is saved just after its row) and released when the row goes; null
 * without audio.
 */
export function useHistoryPlayer(
  id: number,
  hasAudio: boolean,
  durationMs: number | null
): HistoryPlayer | null {
  const [player, setPlayer] = useState(() =>
    hasAudio ? createHistoryPlayer(id, durationMs) : null
  );
  useEffect(() => {
    if (hasAudio && !player) setPlayer(createHistoryPlayer(id, durationMs));
  }, [hasAudio, player, id, durationMs]);
  useEffect(() => {
    player?.setSavedLength(durationMs);
  }, [player, durationMs]);
  useEffect(() => () => player?.release(), [player]);
  return player;
}

/** A value read from the player's state; re-renders only when it changes. */
export function usePlayerState<T>(player: HistoryPlayer, select: (state: PlayerSnapshot) => T): T {
  return useSyncExternalStore(player.subscribe, () => select(player.getSnapshot()));
}

const noSubscribe = () => () => {};

/** The heard sentence estimated to be playing; -1 before anything plays or without a timeline. */
export function useEstimatedSentence(
  player: HistoryPlayer | null,
  timeline: HeardTimeline | null
): number {
  return useSyncExternalStore(player ? player.subscribe : noSubscribe, () => {
    if (!player || !timeline) return -1;
    const state = player.getSnapshot();
    return state.status === "playing" || state.position > 0
      ? sentenceAtTime(timeline, state.position)
      : -1;
  });
}

/** The player's known length in seconds (0 without a player or a length). */
export function usePlayerLength(player: HistoryPlayer | null): number {
  return useSyncExternalStore(player ? player.subscribe : noSubscribe, () =>
    player ? player.getSnapshot().length : 0
  );
}

// Lists, menus and selects keep their own Alt+arrow keys.
const OWN_KEYS =
  'select, [role="combobox"], [role="listbox"], [role="menu"], [role="menubar"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]';

/**
 * The player's keys anywhere in the History view, the correction and note
 * fields included: Ctrl+Space plays or pauses, Alt+←/→ skip 5 s, Alt+↑/↓
 * change speed, Alt+Enter plays the caret's sentence. Exact modifiers only
 * (never AltGr); not while composing, under a dialog, or in a list, menu or
 * select. Ctrl+Space may never arrive where an IME uses it.
 */
export function useHistoryPlayerShortcuts(player: HistoryPlayer | null, fromCursor: () => void) {
  const latest = useRef({ player, fromCursor });
  useLayoutEffect(() => {
    latest.current = { player, fromCursor };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current.player;
      if (!current || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (!historyViewHas(event.target)) return;
      if (document.querySelector(OPEN_DIALOG)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(OWN_KEYS)) return;
      let altGraph = false;
      try {
        altGraph = event.getModifierState?.("AltGraph") ?? false;
      } catch {
        altGraph = false;
      }
      if (altGraph || event.shiftKey || event.metaKey) return;

      if (event.ctrlKey && !event.altKey) {
        if (event.code !== "Space" && event.key !== " ") return;
        event.preventDefault();
        if (!event.repeat) void current.toggle();
        return;
      }
      if (!event.altKey || event.ctrlKey) return;
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          current.skip(-SKIP_SECONDS);
          break;
        case "ArrowRight":
          event.preventDefault();
          current.skip(SKIP_SECONDS);
          break;
        case "ArrowUp":
          event.preventDefault();
          current.stepRate(1);
          break;
        case "ArrowDown":
          event.preventDefault();
          current.stepRate(-1);
          break;
        case "Enter":
          event.preventDefault();
          if (!event.repeat) latest.current.fromCursor();
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** The value after `delayMs` without a change; long texts wait a little longer. */
export function useDebouncedText(value: string, baseMs = 150): string {
  const [debounced, setDebounced] = useState(value);
  const delay = Math.min(1000, baseMs + Math.floor(value.length / 40));
  useEffect(() => {
    if (value === debounced) return;
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, debounced, delay]);
  return debounced;
}
