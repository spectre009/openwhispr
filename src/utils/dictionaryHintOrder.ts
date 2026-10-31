// How the speech-to-text hint list orders the words that aren't pinned
// (Settings › Dictation › Recognition, `dictionaryHintOrder`), and the usage
// scores evidence order ranks them by. Pure and dependency-free apart from
// the word key, so main (Re-transcribe, through sttHintFields.js), the
// renderer's live requests and the Dictionary page share it.
//
// - "evidence" (the default): within the typed and the auto-learned tiers,
//   the words speech misses most go first (missed rows, then rows that used
//   the word), and words never used keep their stored order at the end.
// - "added": stored order, as before.
//
// Order only decides which words fit a request's cap (Azure Speech gives
// every phrase the same weight; a Whisper prompt is read from its tail), and
// it applies only while usage counts exist: without scores both read as
// stored order. Scores cross IPC as numbers keyed by dictionaryWordKey,
// bounded: never a word's usage in a log, only how many.

import { dictionaryWordKey } from "./dictionaryWordKey.js";

export type DictionaryHintOrder = "evidence" | "added";

export const DICTIONARY_HINT_ORDERS: readonly DictionaryHintOrder[] = ["evidence", "added"];

/** An unknown or missing value reads as evidence order. */
export function normalizeDictionaryHintOrder(value: unknown): DictionaryHintOrder {
  return value === "added" ? "added" : "evidence";
}

/** A word's evidence over 90 days: rows speech missed it, rows that used it. */
export interface HintScore {
  missedRows: number;
  written: number;
}

/** One score as it crosses IPC: `[dictionaryWordKey, missedRows, written]`. */
export type HintScoreTuple = [key: string, missedRows: number, written: number];

export const MAX_HINT_SCORES = 2000;
export const MAX_HINT_SCORE_VALUE = 1_000_000;
export const MAX_HINT_SCORE_KEY_CHARS = 100;

const validCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= MAX_HINT_SCORE_VALUE;

const clampCount = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(MAX_HINT_SCORE_VALUE, Math.floor(number));
};

/** Whether a score says anything: 0/0 (never used) is the same as none. */
export function hasHintEvidence(score: HintScore | null | undefined): boolean {
  return !!score && (score.missedRows > 0 || score.written > 0);
}

/**
 * Evidence order between two words' scores, best first: more missed rows,
 * then more rows that used it; no score counts as 0/0. Equal is 0, so a
 * stable sort keeps stored order among ties and puts unused words last.
 */
export function compareHintScores(
  a: HintScore | null | undefined,
  b: HintScore | null | undefined
): number {
  return (b?.missedRows ?? 0) - (a?.missedRows ?? 0) || (b?.written ?? 0) - (a?.written ?? 0);
}

/**
 * The scores for the hint list from the usage counts (dictionaryUsageStore's
 * words): only words with evidence, best first, keys of at most 100
 * characters, counts clamped to 1,000,000, at most 2,000 of them.
 */
export function hintScoreTuples(
  usage: readonly { word?: unknown; missedRows?: unknown; written?: unknown }[] | null | undefined
): HintScoreTuple[] {
  const byKey = new Map<string, HintScoreTuple>();
  for (const counts of Array.isArray(usage) ? usage : []) {
    const key = dictionaryWordKey(counts?.word);
    if (!key || key.length > MAX_HINT_SCORE_KEY_CHARS || byKey.has(key)) continue;
    const missedRows = clampCount(counts?.missedRows);
    const written = clampCount(counts?.written);
    if (missedRows === 0 && written === 0) continue;
    byKey.set(key, [key, missedRows, written]);
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        compareHintScores(
          { missedRows: a[1], written: a[2] },
          { missedRows: b[1], written: b[2] }
        ) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    )
    .slice(0, MAX_HINT_SCORES);
}

/**
 * The scores one request carries: those of the dictionary's own words, at
 * most as many as it has words (and 2,000). Live dictation, Re-transcribe's
 * dictionary block and the Dictionary page all pass through here, so they
 * rank by the same numbers.
 */
export function hintScoresForDictionary(
  tuples: readonly HintScoreTuple[] | null | undefined,
  words: readonly unknown[] | null | undefined
): HintScoreTuple[] {
  if (!Array.isArray(tuples) || tuples.length === 0) return [];
  const list = Array.isArray(words) ? words : [];
  const keys = new Set<string>();
  for (const word of list) {
    const key = dictionaryWordKey(word);
    if (key) keys.add(key);
  }
  const limit = Math.min(list.length, MAX_HINT_SCORES);
  const kept: HintScoreTuple[] = [];
  for (const tuple of tuples) {
    if (kept.length >= limit) break;
    if (Array.isArray(tuple) && keys.has(tuple[0])) kept.push([tuple[0], tuple[1], tuple[2]]);
  }
  return kept;
}

/**
 * Validates scores that crossed IPC (`[[key, missedRows, written], …]`) into
 * the builder's map. At most `maxEntries` (the dictionary's size, never over
 * 2,000) are read, in order; an entry that isn't a key of 1–100 characters
 * with two integers from 0 to 1,000,000 is dropped, as is a repeated key or
 * one without evidence (0/0). Anything that isn't a list reads as none.
 */
export function normalizeHintScores(
  value: unknown,
  maxEntries: number = MAX_HINT_SCORES
): Map<string, HintScore> {
  const scores = new Map<string, HintScore>();
  if (!Array.isArray(value)) return scores;
  const limit = Number.isFinite(maxEntries)
    ? Math.max(0, Math.min(MAX_HINT_SCORES, Math.floor(maxEntries)))
    : MAX_HINT_SCORES;
  for (const item of value.slice(0, limit)) {
    if (!Array.isArray(item) || item.length !== 3) continue;
    const [rawKey, missedRows, written] = item;
    if (typeof rawKey !== "string" || rawKey.length > MAX_HINT_SCORE_KEY_CHARS) continue;
    const key = dictionaryWordKey(rawKey);
    if (!key || scores.has(key)) continue;
    if (!validCount(missedRows) || !validCount(written)) continue;
    if (missedRows === 0 && written === 0) continue;
    scores.set(key, { missedRows, written });
  }
  return scores;
}
