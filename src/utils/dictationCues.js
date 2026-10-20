import logger from "./logger";
import { getSettings } from "../stores/settingsStore";

const START_NOTES = [523.25, 659.25];
const STOP_NOTES = [587.33, 440];
const NOTE_DURATION_SECONDS = 0.09;
const NOTE_GAP_SECONDS = 0.025;
const NOTE_ATTACK_SECONDS = 0.015;
const MAX_GAIN = 0.2;
const MIN_GAIN = 0.0001;
// Bluetooth headphones stop their link while nothing plays and drop the first ~0.25 s
// of the next sound (AirPods Max, 2026-10-20) — longer than the whole start cue. So the
// output is woken at the hotkey press with an inaudible signal (−80 dBFS; true digital
// silence would let Chromium keep its output stream closed) and the start cue begins no
// sooner than WARM_LEAD_SECONDS after that.
const WARM_LEVEL = 0.0001;
const WARM_LEAD_SECONDS = 0.25;
// A press whose recording never starts (declined, or a toggle guess that was wrong).
const WARM_IDLE_RELEASE_MS = 10000;
const WARM_RELEASE_DELAY_MS = 1000;

let audioContext = null;
let warm = null;

const getAudioContext = () => {
  if (typeof window === "undefined") {
    return null;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContextCtor();
  }

  return audioContext;
};

export const resumeContextIfNeeded = async () => {
  try {
    const context = getAudioContext();
    if (!context) {
      return null;
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    return context.state === "running" ? context : null;
  } catch (error) {
    logger.debug(
      "Failed to initialize dictation cue audio context",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
    return null;
  }
};

const scheduleTone = (context, frequency, startTime) => {
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const stopTime = startTime + NOTE_DURATION_SECONDS;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startTime);

  gainNode.gain.setValueAtTime(MIN_GAIN, startTime);
  gainNode.gain.linearRampToValueAtTime(MAX_GAIN, startTime + NOTE_ATTACK_SECONDS);
  gainNode.gain.exponentialRampToValueAtTime(MIN_GAIN, stopTime);

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);

  oscillator.start(startTime);
  oscillator.stop(stopTime + 0.01);
};

const isEnabled = () => getSettings().audioCuesEnabled;

// When a cue may start: soon, but never before the output has had WARM_LEAD_SECONDS to wake.
export const cueStartTime = (now, warmStartedAt) =>
  Math.max(now + 0.005, warmStartedAt == null ? 0 : warmStartedAt + WARM_LEAD_SECONDS);

const clearWarmTimer = () => {
  if (warm?.timer) clearTimeout(warm.timer);
  if (warm) warm.timer = null;
};

const stopWarm = () => {
  if (!warm) return;
  clearWarmTimer();
  try {
    warm.source.stop();
    warm.source.disconnect();
  } catch {
    // Already stopped.
  }
  warm = null;
};

const scheduleWarmRelease = (delayMs) => {
  if (!warm) return;
  clearWarmTimer();
  warm.timer = setTimeout(stopWarm, delayMs);
};

// Starts waking the output for an upcoming cue. Idempotent; a running warm-up is kept.
export const warmCueOutput = async () => {
  try {
    if (!isEnabled()) return false;
    if (warm) {
      if (!warm.holding) scheduleWarmRelease(WARM_IDLE_RELEASE_MS);
      return true;
    }
    const context = await resumeContextIfNeeded();
    if (!context || warm) return Boolean(warm);
    const source = context.createConstantSource();
    source.offset.value = WARM_LEVEL;
    source.connect(context.destination);
    source.start();
    warm = { source, startedAt: context.currentTime, holding: false, timer: null };
    scheduleWarmRelease(WARM_IDLE_RELEASE_MS);
    return true;
  } catch (error) {
    logger.debug(
      "Failed to warm dictation cue output",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
    return false;
  }
};

// Lets the output go back to sleep once nothing needs it (recording ended or abandoned).
export const releaseCueOutput = () => scheduleWarmRelease(WARM_RELEASE_DELAY_MS);

// Resolves with what the cue cost: a context created or resumed for it makes the
// tones audible later than the recording actually started.
const playCue = async (notes, { holdOutput = false } = {}) => {
  try {
    if (!isEnabled()) return { played: false, reason: "disabled" };

    const requestedAt = performance.now();
    const priorState = audioContext?.state ?? "none";
    const wasWarm = Boolean(warm);
    await warmCueOutput();
    const context = await resumeContextIfNeeded();
    if (!context) {
      return { played: false, reason: "no-context", priorState };
    }
    if (warm && holdOutput) {
      // Kept for the whole recording, so the stop cue isn't lost to a sleeping link either.
      warm.holding = true;
      clearWarmTimer();
    }

    const now = context.currentTime;
    const warmedForMs = warm ? Math.round((now - warm.startedAt) * 1000) : null;
    const baseTime = cueStartTime(now, warm?.startedAt);
    notes.forEach((frequency, index) => {
      const noteStart = baseTime + index * (NOTE_DURATION_SECONDS + NOTE_GAP_SECONDS);
      scheduleTone(context, frequency, noteStart);
    });
    return {
      played: true,
      priorState,
      readyMs: Math.round(performance.now() - requestedAt),
      outputLatencyMs: Math.round(
        ((context.outputLatency || 0) + (context.baseLatency || 0)) * 1000
      ),
      wasWarm,
      warmedForMs,
      delayedMs: Math.max(0, Math.round((baseTime - now - 0.005) * 1000)),
    };
  } catch (error) {
    logger.debug(
      "Failed to play dictation cue",
      { error: error instanceof Error ? error.message : String(error) },
      "audio"
    );
    return { played: false, reason: "error" };
  }
};

export const playStartCue = () => playCue(START_NOTES, { holdOutput: true });

export const playStopCue = () => playCue(STOP_NOTES);
