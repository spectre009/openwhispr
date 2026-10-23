import { create } from "zustand";
import logger from "../utils/logger";
import type { DictionaryEntrySource } from "../types/electron";

// Which dictionary words the user typed and which auto-learn added. The
// settings store keeps only the words (that list syncs to OpenWhispr Cloud);
// the speech-to-text hint list needs the source to put typed words first, and
// the Dictionary page lists auto-learned words for review.

interface DictionarySourcesState {
  /** Lowercased words whose source is "learned". */
  learned: ReadonlySet<string>;
  loaded: boolean;
}

export const useDictionarySourcesStore = create<DictionarySourcesState>()(() => ({
  learned: new Set<string>(),
  loaded: false,
}));

/** A word missing here (just typed, not yet re-read) counts as typed. */
export function getLearnedDictionaryWords(): ReadonlySet<string> {
  return useDictionarySourcesStore.getState().learned;
}

function apply(entries: unknown): void {
  if (!Array.isArray(entries)) return;
  const learned = new Set<string>();
  for (const entry of entries as Array<{ word?: unknown; source?: DictionaryEntrySource }>) {
    if (entry?.source === "learned" && typeof entry.word === "string") {
      learned.add(entry.word.trim().toLowerCase());
    }
  }
  useDictionarySourcesStore.setState({ learned, loaded: true });
}

let inFlight: Promise<void> | null = null;
let rerun = false;

/** Re-reads the sources; calls during a read coalesce into one more read. */
export function refreshDictionarySources(): Promise<void> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.getDictionaryEntries) return Promise.resolve();
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      rerun = false;
      try {
        apply(await api.getDictionaryEntries!());
      } catch (error) {
        logger.warn(
          "Couldn't read dictionary sources",
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

let subscribed = false;

/**
 * Reads the sources now and again whenever the dictionary changes. The caller
 * passes a subscription to its word list (the settings store) so this module
 * never imports that store.
 */
export function syncDictionarySources(onWordsChanged?: (listener: () => void) => void): void {
  if (!subscribed && onWordsChanged) {
    subscribed = true;
    onWordsChanged(() => void refreshDictionarySources());
  }
  void refreshDictionarySources();
}
