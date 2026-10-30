import { getGlossaryCanonicalTerms } from "./glossaryTerms";
import { dictionaryWordKey } from "./dictionaryWordKey.js";
import {
  getLearnedDictionaryWords,
  getPinnedDictionaryKeys,
  isDictionarySourcesLoaded,
} from "../stores/dictionarySourcesStore";
import { getMissedDictionaryKeys } from "../stores/dictionaryUsageStore";

export interface Snippet {
  trigger: string;
  replacement: string;
}

// Mirrors the cap database.js enforces when it stores snippets.
export const MAX_SNIPPET_TRIGGER_LENGTH = 100;

interface SnippetMatcher {
  regex: RegExp;
  replacements: Map<string, string>;
}

export interface SnippetTriggerRange {
  /** Index of the trigger's first character. */
  start: number;
  /** Index one past the trigger's last character. */
  end: number;
}

let cachedSnippets: Snippet[] | null = null;
let cachedMatcher: SnippetMatcher | null = null;

// The regex /i flag can't case-fold Turkish İ (U+0130) or dotless ı
// (U+0131), and İ's toLowerCase() form is two code units ("i" + U+0307), so
// triggers like "İmza" never matched. Folding İ to a plain "i" gives Map
// keys a canonical form, and matching İ/ı explicitly in the pattern lets the
// regex find them in the transcript.
function foldCapitalIDot(value: string): string {
  return value.replace(/İ/g, "i");
}

function buildMatcher(snippets: Snippet[]): SnippetMatcher | null {
  const replacements = new Map<string, string>();
  for (const { trigger, replacement } of snippets) {
    const folded = foldCapitalIDot(trigger.trim().normalize("NFC"));
    const key = folded.toLowerCase();
    if (!key) continue;
    replacements.set(key, replacement);
    // An uppercase I in the trigger may mean Turkish ı as well as English i,
    // so register both readings; an explicit trigger wins over a variant.
    const dotlessKey = folded.replace(/I/g, "ı").toLowerCase();
    if (!replacements.has(dotlessKey)) replacements.set(dotlessKey, replacement);
  }
  if (replacements.size === 0) return null;

  // Longest-first so "investor ask" wins over a shorter "ask" trigger.
  const escaped = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .map((t) => t.replace(/i/g, "[iİ]").replace(/ı/g, "[ıI]"));
  // Unicode-aware word boundaries — triggers never match inside a word.
  const regex = new RegExp(
    `(?<=^|[\\s\\p{P}\\p{S}])(?:${escaped.join("|")})(?=$|[\\s\\p{P}\\p{S}])`,
    "giu"
  );
  return { regex, replacements };
}

// Memoized against the snippets array reference (the settings store replaces
// the array on every change).
function getMatcher(snippets?: Snippet[] | null): SnippetMatcher | null {
  if (!Array.isArray(snippets) || snippets.length === 0) return null;
  if (snippets !== cachedSnippets) {
    cachedSnippets = snippets;
    cachedMatcher = buildMatcher(snippets);
  }
  return cachedMatcher;
}

// The pattern case-folds the Unicode way (/iu) while the keys are toLowerCase'd,
// so a match is not proof of a replacement: "[ıI]mza" matches a plain "imza",
// which is no key at all. Both callers resolve through here, so a reported range
// always means an expansion — wake-word suppression depends on it.
function resolveReplacement(match: string, replacements: Map<string, string>): string | undefined {
  const folded = foldCapitalIDot(match);
  return (
    replacements.get(folded.toLowerCase()) ??
    // An uppercase I can be capital dotless ı as well as English i.
    replacements.get(folded.replace(/I/g, "ı").toLowerCase())
  );
}

/**
 * Character ranges of every trigger occurrence, matched against `text` exactly
 * as given so the offsets index that same string. Wake-word detection uses
 * these to ignore an agent name that only appears because it opens a trigger
 * the user chose, such as "openwhispr review" (see `agentDetection`).
 */
export function findSnippetTriggerRanges(
  text: string,
  snippets?: Snippet[] | null
): SnippetTriggerRange[] {
  if (!text) return [];
  const matcher = getMatcher(snippets);
  if (!matcher) return [];
  return [...text.matchAll(matcher.regex)]
    .filter((match) => resolveReplacement(match[0], matcher.replacements) !== undefined)
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
}

/**
 * Replace every spoken trigger with its saved text in a single pass.
 */
export function expandSnippets(text: string, snippets?: Snippet[] | null): string {
  if (!text) return text;
  const matcher = getMatcher(snippets);
  if (!matcher) return text;
  const { regex, replacements } = matcher;
  // NFC so a decomposed "I" + U+0307 in the transcript recombines into İ.
  return text
    .normalize("NFC")
    .replace(regex, (match) => resolveReplacement(match, replacements) ?? match);
}

/**
 * Dictionary words, the glossary's canonical forms, then snippet triggers —
 * the cleanup-model dictionary suffix (and agent/translation prompts), so
 * triggers and canonical spellings survive cleanup. A glossary's "heard as"
 * spellings never join it. The speech-to-text prompt is built by
 * buildDictionaryHints (utils/dictionaryHints), which also prioritises.
 */
export function getDictionaryHintWords(
  settings?: {
    customDictionary?: string[] | null;
    snippets?: Snippet[] | null;
  } | null,
  glossaryTerms: readonly string[] = getGlossaryCanonicalTerms()
): string[] {
  const dictionary = Array.isArray(settings?.customDictionary) ? settings.customDictionary : [];
  const snippets = Array.isArray(settings?.snippets) ? settings.snippets : [];
  const known = new Set(dictionary.map((w) => (typeof w === "string" ? w.toLowerCase() : w)));
  const canonical = glossaryTerms.filter((term) => {
    const key = term.toLowerCase();
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (snippets.length === 0) return [...dictionary, ...canonical];

  const triggers = snippets
    .map((s) => s?.trigger)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  return [...dictionary, ...canonical, ...triggers];
}

/**
 * Settings › Dictation › Cleanup › "Dictionary words in the cleanup prompt":
 * every word (today's behaviour), typed and pinned words plus the words
 * speech often misses, typed and pinned words only, or none.
 */
export type CleanupDictionarySetting = "all" | "typedPinnedMissed" | "typedPinned" | "none";

export const CLEANUP_DICTIONARY_SETTINGS: readonly CleanupDictionarySetting[] = [
  "all",
  "typedPinnedMissed",
  "typedPinned",
  "none",
];

export function normalizeCleanupDictionarySetting(value: unknown): CleanupDictionarySetting {
  return CLEANUP_DICTIONARY_SETTINGS.includes(value as CleanupDictionarySetting)
    ? (value as CleanupDictionarySetting)
    : "all";
}

/**
 * What one cleanup request's dictionary was: the setting, the set applied
 * (All when the setting's inputs weren't there: no heard/written counts, or
 * the word sources not read yet) and how many dictionary words it carried.
 * Recorded on the cleanup step (or the one-step style step) as is.
 */
export interface CleanupDictionaryScope {
  setting: CleanupDictionarySetting;
  applied: CleanupDictionarySetting;
  words: number;
}

/** One cleanup request's dictionary: the words its prompt carries, and its scope. */
export interface CleanupDictionarySelection {
  words: string[];
  scope: CleanupDictionaryScope;
}

/** What the set is chosen from besides the settings (the stores, by default). */
export interface CleanupDictionarySources {
  /** Lowercased learned words; null until the sources were read (every word reads as typed). */
  learned: ReadonlySet<string> | null;
  /** Pinned keys (dictionaryWordKey). */
  pinned: ReadonlySet<string>;
  /** Keys of the words speech often misses; null when counts aren't available. */
  missed: ReadonlySet<string> | null;
}

function defaultCleanupDictionarySources(): CleanupDictionarySources {
  return {
    learned: isDictionarySourcesLoaded() ? getLearnedDictionaryWords() : null,
    pinned: getPinnedDictionaryKeys(),
    missed: getMissedDictionaryKeys(),
  };
}

/**
 * The dictionary one cleanup request carries, decided once: the same object
 * feeds the prompt (ReasoningConfig.cleanupDictionary, or Cloud's
 * customDictionary) and the step's `dictionaryScope`. Only dictionary words
 * are filtered: the glossary's canonical forms and snippet triggers always
 * follow, so cleanup never undoes the glossary or breaks a trigger. Chat, the
 * assistant, translation and speech-to-text keep the full list
 * (getDictionaryHintWords).
 */
export function selectCleanupDictionary(
  settings?: {
    customDictionary?: string[] | null;
    snippets?: Snippet[] | null;
    cleanupDictionaryWords?: CleanupDictionarySetting | string | null;
  } | null,
  sources: CleanupDictionarySources = defaultCleanupDictionarySources(),
  glossaryTerms: readonly string[] = getGlossaryCanonicalTerms()
): CleanupDictionarySelection {
  const setting = normalizeCleanupDictionarySetting(settings?.cleanupDictionaryWords);
  const dictionary = (
    Array.isArray(settings?.customDictionary) ? settings.customDictionary : []
  ).filter((word): word is string => typeof word === "string");
  let applied: CleanupDictionarySetting = setting;
  // Typed words can't be told apart before the sources are read, nor missed
  // ones without counts: All, and the step says so.
  if ((setting === "typedPinned" || setting === "typedPinnedMissed") && !sources.learned) {
    applied = "all";
  }
  if (applied === "typedPinnedMissed" && !sources.missed) applied = "all";

  let words: string[];
  if (applied === "all") words = dictionary;
  else if (applied === "none") words = [];
  else {
    words = dictionary.filter((word) => {
      const key = dictionaryWordKey(word);
      if (sources.pinned.has(key)) return true;
      if (!sources.learned?.has(word.trim().toLowerCase())) return true;
      return applied === "typedPinnedMissed" && !!sources.missed?.has(key);
    });
  }
  return {
    words: getDictionaryHintWords(
      { customDictionary: words, snippets: settings?.snippets },
      glossaryTerms
    ),
    scope: { setting, applied, words: words.length },
  };
}

/** The words a cleanup prompt carries (selectCleanupDictionary's `words`). */
export function getCleanupDictionaryWords(
  settings?: Parameters<typeof selectCleanupDictionary>[0]
): string[] {
  return selectCleanupDictionary(settings).words;
}

/** A rough token count for a word list as a prompt carries it (≈ characters ÷ 4). */
export function estimateDictionaryTokens(words: readonly string[]): number {
  if (words.length === 0) return 0;
  return Math.ceil(words.join(", ").length / 4);
}
