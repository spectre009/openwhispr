import { create } from "zustand";
import logger from "../utils/logger";
import { dictionaryWordKey } from "../utils/dictionaryWordKey.js";
import type { DictionaryEntry, DictionaryEntrySource } from "../types/electron";

// Which dictionary words the user typed and which auto-learn added, when each
// was added, and which are pinned. The settings store keeps only the words
// (that list syncs to OpenWhispr Cloud); the speech-to-text hint list needs
// the source to put typed words first and pins before them, cleanup's word
// set needs both, and the Dictionary page filters and sorts by source and
// date. Main owns the pins (local only, never synced) and their order; this
// mirrors them, in pin order.

interface DictionarySourcesState {
  /** Lowercased words whose source is "learned". */
  learned: ReadonlySet<string>;
  /** Main's rows: each word's source and when it was added, in stored order. */
  entries: readonly DictionaryEntry[];
  loaded: boolean;
  /** Pinned words' keys (dictionaryWordKey), in pin order (a Set iterates as inserted). */
  pinned: ReadonlySet<string>;
  pinsLoaded: boolean;
}

export const useDictionarySourcesStore = create<DictionarySourcesState>()(() => ({
  learned: new Set<string>(),
  entries: [],
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

/**
 * The pinned words' keys (dictionaryWordKey) in pin order, the first sent
 * first: iterate it (or spread it) for the order. Empty until read.
 */
export function getPinnedDictionaryKeys(): ReadonlySet<string> {
  return useDictionarySourcesStore.getState().pinned;
}

function apply(rows: unknown): void {
  if (!Array.isArray(rows)) return;
  const learned = new Set<string>();
  const entries: DictionaryEntry[] = [];
  for (const row of rows as Array<Partial<DictionaryEntry> | null>) {
    if (typeof row?.word !== "string") continue;
    const source: DictionaryEntrySource = row.source === "learned" ? "learned" : "manual";
    if (source === "learned") learned.add(row.word.trim().toLowerCase());
    entries.push({
      word: row.word,
      source,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    });
  }
  useDictionarySourcesStore.setState({ learned, entries, loaded: true });
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

/**
 * Pins or unpins several words, one at a time (each through main, which
 * broadcasts). Resolves how many changed.
 */
export async function setDictionaryPins(
  words: readonly string[],
  pinned: boolean
): Promise<number> {
  const current = useDictionarySourcesStore.getState().pinned;
  let changed = 0;
  for (const word of words) {
    if (current.has(dictionaryWordKey(word)) === pinned) continue;
    if (await setDictionaryPin(word, pinned)) changed += 1;
  }
  return changed;
}

/**
 * Puts the pins in a new order (the Dictionary page's "Always sent first":
 * a drop, Alt+↑/↓, Move to top). Optimistic: the store shows the new order at
 * once, and main's answer settles it. Main refuses a list that isn't
 * exactly the current pins (MISMATCH) and answers with its own, which the
 * store goes back to; a failure restores the old order unless something newer
 * arrived meanwhile.
 */
export async function reorderDictionaryPins(
  keys: readonly string[]
): Promise<{ success: boolean; code?: string }> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.reorderDictionaryPins) return { success: false, code: "UNAVAILABLE" };
  const previous = useDictionarySourcesStore.getState().pinned;
  const next = new Set<string>();
  for (const key of keys) {
    const normalized = dictionaryWordKey(key);
    if (normalized) next.add(normalized);
  }
  useDictionarySourcesStore.setState({ pinned: next });
  const restore = () => {
    if (useDictionarySourcesStore.getState().pinned === next) {
      useDictionarySourcesStore.setState({ pinned: previous });
    }
  };
  try {
    const result = await api.reorderDictionaryPins([...next]);
    if (Array.isArray(result?.pins)) {
      if (useDictionarySourcesStore.getState().pinned === next || result.success) {
        applyPins(result.pins);
      }
    } else if (!result?.success) {
      restore();
    }
    return result?.success ? { success: true } : { success: false, code: result?.code ?? "FAILED" };
  } catch (error) {
    logger.warn("Couldn't reorder the pins", { error: (error as Error)?.message }, "settings");
    restore();
    return { success: false, code: "FAILED" };
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
    // A source change ("Mark typed") leaves the words as they were.
    window.electronAPI?.onDictionaryUpdated?.(() => void refreshDictionarySources());
  }
  void refreshDictionarySources();
}
