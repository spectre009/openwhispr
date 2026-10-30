import { create } from "zustand";
import logger from "../utils/logger";
import { isSpeechMissed } from "../helpers/dictionaryUsage.js";
import { dictionaryWordKey } from "../utils/dictionaryWordKey.js";
import type { DictionaryUsageResult, DictionaryWordUsage } from "../types/electron";

// Heard vs written per dictionary word, counted by main from local History
// (helpers/dictionaryUsage.js). Mirrored here so cleanup's "words speech
// misses" set can be chosen synchronously when a dictation's cleanup request
// is built. Counts only. Refreshed when a window loads, when the dictionary
// changes, and (debounced) when History does; main caches the counts and
// recomputes at most every 30 s while dictations keep arriving.

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
}

export const useDictionaryUsageStore = create<DictionaryUsageState>()(() => ({
  status: "idle",
  reason: null,
  computedAt: null,
  days: 0,
  rows: 0,
  words: [],
  missed: null,
}));

/** The keys of the words speech often misses, or null when counts aren't available. */
export function getMissedDictionaryKeys(): ReadonlySet<string> | null {
  return useDictionaryUsageStore.getState().missed;
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
    const later = () => scheduleDictionaryUsageRefresh();
    api.onTranscriptionAdded?.(later);
    api.onTranscriptionUpdated?.(later);
    api.onTranscriptionDeleted?.(later);
    api.onTranscriptionsCleared?.(later);
  }
  void refreshDictionaryUsage();
}
