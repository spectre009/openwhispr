import { create } from "zustand";
import logger from "../utils/logger";
import { dictionaryWordKey } from "../utils/dictionaryWordKey.js";
import type { DictionaryEntrySource } from "../types/electron";

// Which dictionary words the user typed and which auto-learn added, and which
// are pinned. The settings store keeps only the words (that list syncs to
// OpenWhispr Cloud); the speech-to-text hint list needs the source to put
// typed words first and pins before them, cleanup's word set needs both, and
// the Dictionary page lists auto-learned words for review. Main owns the
// pins (local only, never synced); this mirrors them.

interface DictionarySourcesState {
  /** Lowercased words whose source is "learned". */
  learned: ReadonlySet<string>;
  loaded: boolean;
  /** Pinned words' keys (dictionaryWordKey). */
  pinned: ReadonlySet<string>;
  pinsLoaded: boolean;
}

export const useDictionarySourcesStore = create<DictionarySourcesState>()(() => ({
  learned: new Set<string>(),
  loaded: false,
  pinned: new Set<string>(),
  pinsLoaded: false,
}));

/** A word missing here (just typed, not yet re-read) counts as typed. */
export function getLearnedDictionaryWords(): ReadonlySet<string> {
  return useDictionarySourcesStore.getState().learned;
}

/** Whether the sources were read: until then every word reads as typed. */
export function isDictionarySourcesLoaded(): boolean {
  return useDictionarySourcesStore.getState().loaded;
}

/** The pinned words' keys (dictionaryWordKey); empty until read. */
export function getPinnedDictionaryKeys(): ReadonlySet<string> {
  return useDictionarySourcesStore.getState().pinned;
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

function applyPins(keys: unknown): void {
  if (!Array.isArray(keys)) return;
  const pinned = new Set<string>();
  for (const key of keys) {
    const normalized = dictionaryWordKey(key);
    if (normalized) pinned.add(normalized);
  }
  useDictionarySourcesStore.setState({ pinned, pinsLoaded: true });
}

let inFlight: Promise<void> | null = null;
let rerun = false;

/** Re-reads the sources and pins; calls during a read coalesce into one more read. */
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
        if (api.getDictionaryPins) applyPins(await api.getDictionaryPins());
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

/**
 * Pins or unpins a word through main, which broadcasts the new set to every
 * window. Resolves whether it worked.
 */
export async function setDictionaryPin(word: string, pinned: boolean): Promise<boolean> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.setDictionaryPin) return false;
  try {
    const result = await api.setDictionaryPin(word, pinned);
    if (result?.success && Array.isArray(result.pins)) applyPins(result.pins);
    return result?.success === true;
  } catch (error) {
    logger.warn("Couldn't change a pin", { error: (error as Error)?.message }, "settings");
    return false;
  }
}

let subscribed = false;

/**
 * Reads the sources now and again whenever the dictionary changes. The caller
 * passes a subscription to its word list (the settings store) so this module
 * never imports that store. Pins follow main's broadcast.
 */
export function syncDictionarySources(onWordsChanged?: (listener: () => void) => void): void {
  if (!subscribed && onWordsChanged) {
    subscribed = true;
    onWordsChanged(() => void refreshDictionarySources());
    window.electronAPI?.onDictionaryPinsUpdated?.((keys: string[]) => applyPins(keys));
  }
  void refreshDictionarySources();
}
