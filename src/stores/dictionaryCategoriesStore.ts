import { create } from "zustand";
import logger from "../utils/logger";
import { dictionaryWordKey } from "../utils/dictionaryWordKey.js";
import { getLoadedCommonWordList, loadCommonWordList } from "../utils/commonWords";
import {
  effectiveDictionaryCategory,
  isDictionaryCategory,
  type DictionaryCategory,
  type EffectiveDictionaryCategory,
  type StoredDictionaryCategory,
} from "../utils/dictionaryCategories";
import type { DictionaryCategoryRecord, DictionaryCategorySetItem } from "../types/electron";

// The dictionary's categories in this window (Dictionary v2, Stage C): main's
// stored choices (the user's, and model proposals the user accepted; local
// only, never synced), mirrored from `dictionary-categories-get` and its
// broadcast, plus the bundled common-word list the rules read (loaded on
// first use, shared with Tidy up). A word's effective category is its stored
// choice, else what the rules make of it (utils/dictionaryCategories.ts).
// `ready` once both are here: until then cleanup's "All words except
// everyday words" sends all words and the grouped prompt stays flat. This
// module never imports the settings store (which reaches it through
// utils/snippets). Nothing here is logged but counts and codes.

interface DictionaryCategoriesState {
  /** Stored choices by dictionaryWordKey. */
  stored: ReadonlyMap<string, StoredDictionaryCategory>;
  storedLoaded: boolean;
  /** The common-word list; null until loaded (or when it couldn't be read). */
  commonWords: ReadonlySet<string> | null;
  /** Both are here: effective categories are what a dictation would use. */
  ready: boolean;
}

export const useDictionaryCategoriesStore = create<DictionaryCategoriesState>()(() => ({
  stored: new Map<string, StoredDictionaryCategory>(),
  storedLoaded: false,
  commonWords: getLoadedCommonWordList(),
  ready: false,
}));

const getState = () => useDictionaryCategoriesStore.getState();

function setState(partial: Partial<DictionaryCategoriesState>): void {
  const next = { ...getState(), ...partial };
  useDictionaryCategoriesStore.setState({
    ...partial,
    ready: next.storedLoaded && next.commonWords !== null,
  });
}

/** A word's category and who decided it ("user", "model" or "auto"; null category: unsorted). */
export function effectiveCategory(word: string): EffectiveDictionaryCategory {
  const { stored, commonWords } = getState();
  return effectiveDictionaryCategory(word, stored, commonWords);
}

/** Whether the stored choices and the common list are both here. */
export function isDictionaryCategoriesReady(): boolean {
  return getState().ready;
}

/**
 * A word's effective category, for cleanup's word set and grouping; null
 * until the categories are ready (cleanup then sends all words, flat).
 */
export function getDictionaryCategoryLookup():
  ((word: string) => DictionaryCategory | null) | null {
  const { ready, stored, commonWords } = getState();
  if (!ready) return null;
  return (word: string) => effectiveDictionaryCategory(word, stored, commonWords).category;
}

function applyStored(records: unknown): void {
  if (!Array.isArray(records)) return;
  const stored = new Map<string, StoredDictionaryCategory>();
  for (const record of records as Array<Partial<DictionaryCategoryRecord> | null>) {
    const key = dictionaryWordKey(record?.key);
    if (!key || !isDictionaryCategory(record?.category)) continue;
    if (record?.source !== "user" && record?.source !== "model") continue;
    stored.set(key, { category: record.category, source: record.source });
  }
  setState({ stored, storedLoaded: true });
}

let inFlight: Promise<void> | null = null;
let rerun = false;

/** Re-reads the stored choices; calls during a read coalesce into one more read. */
export function refreshDictionaryCategories(): Promise<void> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.getDictionaryCategories) return Promise.resolve();
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      rerun = false;
      try {
        applyStored(await api.getDictionaryCategories!());
      } catch (error) {
        logger.warn(
          "Couldn't read dictionary categories",
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

let wordsLoad: Promise<void> | null = null;

/**
 * Loads the common-word list the rules read (once, shared with Tidy up). A
 * list that can't be read leaves the categories not ready.
 */
export function loadDictionaryCategoryWords(): Promise<void> {
  if (wordsLoad) return wordsLoad;
  wordsLoad = loadCommonWordList().then((words) => {
    if (words) setState({ commonWords: words });
    else logger.warn("Couldn't load the common-word list for categories", {}, "settings");
  });
  return wordsLoad;
}

export interface SetCategoriesResult {
  success: boolean;
  /** How many stored choices changed. */
  changed: number;
  /** Items main refused (an unknown word or value), by their index in the request. */
  refused: number;
  code?: string;
}

/**
 * Stores choices through main (`null` category: back to automatic), which
 * broadcasts the new set to every window. Resolves what happened.
 */
export async function setDictionaryCategories(
  items: readonly DictionaryCategorySetItem[]
): Promise<SetCategoriesResult> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.setDictionaryCategories) {
    return { success: false, changed: 0, refused: items.length, code: "UNAVAILABLE" };
  }
  if (items.length === 0) return { success: true, changed: 0, refused: 0 };
  try {
    const result = await api.setDictionaryCategories([...items]);
    if (Array.isArray(result?.categories)) applyStored(result.categories);
    const refused = Array.isArray(result?.results)
      ? result.results.filter((entry) => !entry.ok).length
      : 0;
    if (!result?.success) {
      logger.debug(
        "Dictionary categories not set",
        { items: items.length, code: result?.code ?? null },
        "settings"
      );
    }
    return {
      success: result?.success === true,
      changed: result?.changed ?? 0,
      refused,
      ...(result?.code ? { code: result.code } : {}),
    };
  } catch (error) {
    logger.warn(
      "Couldn't set dictionary categories",
      { error: (error as Error)?.message },
      "settings"
    );
    return { success: false, changed: 0, refused: items.length, code: "FAILED" };
  }
}

let subscribed = false;

/**
 * Reads the stored choices now and follows main's broadcasts (and the
 * dictionary's changes, which prune choices with their words). `loadWords`:
 * the common list is needed now (a setting reads categories); otherwise it
 * loads when the Dictionary page or a setting asks.
 */
export function syncDictionaryCategories({ loadWords = false } = {}): void {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!subscribed && api) {
    subscribed = true;
    api.onDictionaryCategoriesUpdated?.((records: DictionaryCategoryRecord[]) =>
      applyStored(records)
    );
    api.onDictionaryUpdated?.(() => void refreshDictionaryCategories());
  }
  void refreshDictionaryCategories();
  if (loadWords) void loadDictionaryCategoryWords();
}
