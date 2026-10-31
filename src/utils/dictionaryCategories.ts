// Dictionary categories (Dictionary v2, Stage C), as data: the three
// categories, the rules that place a word on this computer from its shape
// and the bundled common-word list (its "auto" category), the effective
// category (an explicit choice, the user's or an accepted model proposal,
// else the auto one) and the cleanup prompt's grouping. Pure; never logged
// (the user's words).
//
// The rules, first match wins:
// 1. work: a digit; one of `. _ / -` between two characters, or a `#` after
//    one (`C#`); a capital after a token's first letter (`SuperApp`, `IDEAs`,
//    `AriaEvent.view`); or every letter a capital, two or more (`PR`, `CED`).
// 2. everyday: every token, lowercased, is a word of the common list
//    (`The`, `Ideas`, `little`).
// 3. people: it starts with a capital and isn't everyday words (`Little
//    Buddy`, `Aishwaria`, `Kusto`: the list doesn't know a product's name).
// 4. otherwise unsorted (`kusto`, `groq`, `worktree`).
// Without the common list (not loaded yet) only rule 1 runs: the rest is
// unsorted until it loads.

import { dictionaryWordKey } from "./dictionaryWordKey.js";

export type DictionaryCategory = "people" | "work" | "everyday";

export const DICTIONARY_CATEGORIES: readonly DictionaryCategory[] = ["people", "work", "everyday"];

/** Who decided a word's category: the user, an accepted model proposal, or the rules. */
export type DictionaryCategorySource = "user" | "model" | "auto";

/** A stored (explicit) choice: only "user" and "model" are ever stored. */
export interface StoredDictionaryCategory {
  category: DictionaryCategory;
  source: "user" | "model";
}

/** A word's category as the page shows it; `category` null is unsorted. */
export interface EffectiveDictionaryCategory {
  category: DictionaryCategory | null;
  source: DictionaryCategorySource;
}

export function isDictionaryCategory(value: unknown): value is DictionaryCategory {
  return value === "people" || value === "work" || value === "everyday";
}

const DIGIT = /\p{Nd}/u;
// `. _ / -` with a character on both sides, or `#` after one (C#, F#).
const INNER_SEPARATOR = /\S[._/-]\S|\S#/u;
const UPPER = /\p{Lu}/u;
const LETTER = /\p{L}/u;
const LETTERS_ONLY = /^\p{L}+$/u;

function tokensOf(word: string): string[] {
  return word.split(/\s+/).filter(Boolean);
}

/** A capital after a token's first letter: SuperApp, IDEAs, AriaEvent.view. */
function hasInnerCapital(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    const chars = [...token];
    const first = chars.findIndex((ch) => LETTER.test(ch));
    return first >= 0 && chars.slice(first + 1).some((ch) => UPPER.test(ch));
  });
}

/** Every letter a capital, and at least two letters: PR, CED, CUUD. */
function isAllCaps(word: string): boolean {
  const letters = [...word].filter((ch) => LETTER.test(ch));
  return letters.length >= 2 && letters.every((ch) => UPPER.test(ch));
}

/** Rule 1: the shape of a product, a tool, an acronym or code. */
function looksLikeWork(word: string, tokens: readonly string[]): boolean {
  return (
    DIGIT.test(word) || INNER_SEPARATOR.test(word) || hasInnerCapital(tokens) || isAllCaps(word)
  );
}

/** Rule 2: every token, lowercased, is a letters-only word of the common list. */
export function isEverydayWords(word: string, commonWords: ReadonlySet<string>): boolean {
  const tokens = tokensOf(word.trim());
  if (tokens.length === 0) return false;
  return tokens.every((token) => {
    const lower = token.normalize("NFC").toLowerCase();
    return LETTERS_ONLY.test(lower) && commonWords.has(lower);
  });
}

/**
 * The auto category: what the rules on this computer make of a word's shape
 * (rules above, first match wins). `commonWords` null (not loaded): only the
 * work rule runs; anything else is unsorted (null).
 */
export function classifyDictionaryWord(
  word: string,
  commonWords: ReadonlySet<string> | null | undefined
): DictionaryCategory | null {
  if (typeof word !== "string") return null;
  const trimmed = word.trim();
  if (!trimmed) return null;
  const tokens = tokensOf(trimmed);
  if (looksLikeWork(trimmed, tokens)) return "work";
  if (!commonWords) return null;
  if (isEverydayWords(trimmed, commonWords)) return "everyday";
  const first = [...trimmed][0];
  if (first && UPPER.test(first)) return "people";
  return null;
}

/**
 * A word's effective category: its stored choice (the user's, or a model
 * proposal the user accepted), else the auto one. Stored choices are keyed
 * by dictionaryWordKey.
 */
export function effectiveDictionaryCategory(
  word: string,
  stored: ReadonlyMap<string, StoredDictionaryCategory> | null | undefined,
  commonWords: ReadonlySet<string> | null | undefined
): EffectiveDictionaryCategory {
  const choice = stored?.get(dictionaryWordKey(word));
  if (choice && isDictionaryCategory(choice.category)) {
    return { category: choice.category, source: choice.source === "model" ? "model" : "user" };
  }
  return { category: classifyDictionaryWord(word, commonWords), source: "auto" };
}

/** Each category's count, and the unsorted ones, over a list of words. */
export function dictionaryCategoryCounts(
  words: readonly string[],
  categoryOf: (word: string) => DictionaryCategory | null
): Record<DictionaryCategory | "unsorted", number> {
  const counts = { people: 0, work: 0, everyday: 0, unsorted: 0 };
  for (const word of words) counts[categoryOf(word) ?? "unsorted"] += 1;
  return counts;
}

// ─── The cleanup prompt's grouping ───

/** A group of the cleanup prompt's dictionary: a category, or "other". */
export type CleanupDictionaryGroupKey = DictionaryCategory | "other";

/** The order groups are listed in. */
export const CLEANUP_DICTIONARY_GROUP_ORDER: readonly CleanupDictionaryGroupKey[] = [
  "people",
  "work",
  "everyday",
  "other",
];

export interface CleanupDictionaryGroup {
  group: CleanupDictionaryGroupKey;
  words: string[];
}

/**
 * The cleanup prompt's words grouped, in CLEANUP_DICTIONARY_GROUP_ORDER, each
 * group's words in the order they had in the flat list; empty groups left
 * out. `categoryOf(word, index)` names a word's group (null: "other").
 */
export function groupCleanupDictionaryWords(
  words: readonly string[],
  categoryOf: (word: string, index: number) => DictionaryCategory | null
): CleanupDictionaryGroup[] {
  const buckets = new Map<CleanupDictionaryGroupKey, string[]>(
    CLEANUP_DICTIONARY_GROUP_ORDER.map((group) => [group, []])
  );
  words.forEach((word, index) => {
    const category = categoryOf(word, index);
    buckets.get(isDictionaryCategory(category) ? category : "other")!.push(word);
  });
  return CLEANUP_DICTIONARY_GROUP_ORDER.filter((group) => buckets.get(group)!.length > 0).map(
    (group) => ({ group, words: buckets.get(group)! })
  );
}

/** The grouped list as the cleanup prompt carries it: "People: A, B; Work terms: C". */
export function formatCleanupDictionaryGroups(
  groups: readonly CleanupDictionaryGroup[],
  label: (group: CleanupDictionaryGroupKey) => string
): string {
  return groups
    .filter((entry) => entry.words.length > 0)
    .map((entry) => `${label(entry.group)}: ${entry.words.join(", ")}`)
    .join("; ");
}
