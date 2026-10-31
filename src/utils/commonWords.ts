// The bundled common-word list (src/config/commonEnglishWords.json, SCOWL;
// scripts/generate-common-words.js regenerates it), loaded once on first use
// as its own chunk and shared by everything that reads it: Tidy up's checks,
// the glossary offer's scope and the dictionary's categories. Never at
// startup unless a setting needs it.

let load: Promise<ReadonlySet<string> | null> | null = null;
let loaded: ReadonlySet<string> | null = null;

/** Resolves the list, or null when it couldn't be read (the caller decides what that means). */
export function loadCommonWordList(): Promise<ReadonlySet<string> | null> {
  if (load) return load;
  load = import("../config/commonEnglishWords.json")
    .then((module) => {
      const list = (module as { default?: unknown }).default ?? module;
      const words = Array.isArray(list)
        ? list.filter((word): word is string => typeof word === "string")
        : [];
      loaded = new Set(words);
      return loaded;
    })
    .catch(() => null);
  return load;
}

/** The list if it has loaded, else null. */
export function getLoadedCommonWordList(): ReadonlySet<string> | null {
  return loaded;
}
