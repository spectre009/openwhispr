import { create } from "zustand";
import logger from "../utils/logger";
import { isSpeechMissed } from "../helpers/dictionaryUsage.js";
import { dictionaryWordKey } from "../utils/dictionaryWordKey.js";
import { hintScoreTuples, type HintScoreTuple } from "../utils/dictionaryHintOrder";
import type { DictionaryUsageResult, DictionaryWordUsage } from "../types/electron";

// Heard vs written per dictionary word ("used", "speech got it", "fixed after
// speech"), counted by main from local History (helpers/dictionaryUsage.js).
// Mirrored here so cleanup's "words speech misses" set can be chosen
// synchronously when a dictation's cleanup request is built, and so the
// speech-to-text hint list can rank by evidence (dictionaryHintOrder.ts:
// live requests, Re-transcribe's dictionary block and the Dictionary page
// read the same scores). Counts only.
// Refreshed when a window loads, when the dictionary changes, when the owner
// or History's policy does, and (debounced) when History does; main caches
// the counts and recomputes at most every 30 s while dictations keep arriving.

const REFRESH_DEBOUNCE_MS = 5_000;

interface DictionaryUsageState {
  /** "unavailable": local history isn't durable (off, pending, forced off). */
  status: "idle" | "ready" | "unavailable";
  reason: string | null;
  computedAt: string | null;
  days: number;
  rows: number;
  words: DictionaryWordUsage[];
  /** Keys of the words speech often misses; null until counts are available. */
  missed: ReadonlySet<string> | null;
  /** Dictations a day over the last 30 days; null until counts are available. */
  perDay: number | null;
}

export const useDictionaryUsageStore = create<DictionaryUsageState>()(() => ({
  status: "idle",
  reason: null,
  computedAt: null,
  days: 0,
  rows: 0,
  words: [],
  missed: null,
  perDay: null,
}));

/** The keys of the words speech often misses, or null when counts aren't available. */
export function getMissedDictionaryKeys(): ReadonlySet<string> | null {
  return useDictionaryUsageStore.getState().missed;
}

let scoresFor: { words: readonly DictionaryWordUsage[]; scores: HintScoreTuple[] } | null = null;

/**
 * The hint list's usage scores (`[key, missedRows, written]`, best first,
 * bounded), derived from the counts; null when counts aren't available.
 */
export function hintScoresFromUsage(
  status: DictionaryUsageState["status"],
  words: readonly DictionaryWordUsage[]
): readonly HintScoreTuple[] | null {
  if (status !== "ready") return null;
  if (scoresFor?.words !== words) scoresFor = { words, scores: hintScoreTuples(words) };
  return scoresFor.scores;
}

/** The hint list's usage scores now; null when counts aren't available. */
export function getDictionaryHintScores(): readonly HintScoreTuple[] | null {
  const { status, words } = useDictionaryUsageStore.getState();
  return hintScoresFromUsage(status, words);
}

function apply(result: DictionaryUsageResult | null | undefined): void {
  if (!result || result.available !== true) {
    useDictionaryUsageStore.setState({
      status: "unavailable",
      reason: (result && "reason" in result && result.reason) || null,
      computedAt: null,
      days: 0,
      rows: 0,
      words: [],
      missed: null,
      perDay: null,
    });
    return;
  }
  const words = Array.isArray(result.words) ? result.words : [];
  const missed = new Set<string>();
  for (const entry of words) {
    if (isSpeechMissed(entry)) {
      const key = dictionaryWordKey(entry.word);
      if (key) missed.add(key);
    }
  }
  useDictionaryUsageStore.setState({
    status: "ready",
    reason: null,
    computedAt: result.computedAt,
    days: result.days,
    rows: result.rows,
    words,
    missed,
    perDay: Number.isFinite(result.pace?.perDay) ? (result.pace?.perDay ?? null) : null,
  });
}

let inFlight: Promise<void> | null = null;
let rerun = false;

/** Asks main for the counts; calls during a read coalesce into one more read. */
export function refreshDictionaryUsage(): Promise<void> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.getDictionaryUsage) return Promise.resolve();
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      rerun = false;
      try {
        apply(await api.getDictionaryUsage!());
      } catch (error) {
        logger.warn(
          "Couldn't read dictionary usage",
          { error: (error as Error)?.message },
          "settings"
        );
      }
    } while (rerun);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** A refresh after History settles (a dictation saved, rewritten or deleted). */
export function scheduleDictionaryUsageRefresh(delayMs = REFRESH_DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void refreshDictionaryUsage();
  }, delayMs);
}

let subscribed = false;

/** Reads the counts now, and again when the dictionary or History changes. */
export function syncDictionaryUsage(): void {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!subscribed && api) {
    subscribed = true;
    api.onDictionaryUpdated?.(() => void refreshDictionaryUsage());
    // Another owner, or History's policy changed: the counts were someone else's.
    api.onDictionaryHistoryChanged?.(() => void refreshDictionaryUsage());
    const later = () => scheduleDictionaryUsageRefresh();
    api.onTranscriptionAdded?.(later);
    api.onTranscriptionUpdated?.(later);
    api.onTranscriptionDeleted?.(later);
    api.onTranscriptionsCleared?.(later);
  }
  void refreshDictionaryUsage();
}
