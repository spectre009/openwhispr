// Similar words in a dictionary, for the word detail and Tidy up: spelling
// variants (the same word once case, hyphens, spaces, dots and underscores are
// removed: Claude / CLAUDE, agents-shared / agentsshared), plural pairs (s, es,
// ies: file / files, query / queries) and near spellings (an edit distance of
// at most 2 for words of 5+ characters, 1 for shorter ones; a swap of two
// neighbouring letters counts once: approver / approverl). Pure, and never
// logged: these are the user's words.

import { dictionaryWordKey } from "./dictionaryWordKey.js";

export type SimilarReason = "variant" | "plural" | "near";

export interface SimilarGroup {
  reason: SimilarReason;
  /** The words, in the list's order. */
  words: string[];
}

export interface SimilarWord {
  word: string;
  reason: SimilarReason;
  /** The edit distance, for near spellings. */
  distance?: number;
}

const REASON_ORDER: Record<SimilarReason, number> = { variant: 0, plural: 1, near: 2 };
// The shortest singular a plural pair is made with ("its" / "it" isn't one).
const MIN_SINGULAR_CHARS = 3;
const NEAR_LONG_CHARS = 5;

/** The key two spelling variants share: case, hyphens, spaces, dots and underscores removed. */
export function spellingKey(word: string): string {
  return dictionaryWordKey(word).replace(/[-\s._]+/g, "");
}

function singularsOf(key: string): string[] {
  const out: string[] = [];
  if (key.endsWith("ies")) out.push(`${key.slice(0, -3)}y`);
  if (key.endsWith("es")) out.push(key.slice(0, -2));
  if (key.endsWith("s")) out.push(key.slice(0, -1));
  return out.filter((singular) => singular.length >= MIN_SINGULAR_CHARS);
}

/** How far apart two near spellings may be: 2 from 5 characters, else 1. */
export function nearThreshold(a: string, b: string): number {
  return Math.min(a.length, b.length) >= NEAR_LONG_CHARS ? 2 : 1;
}

/**
 * The edit distance (insert, delete, substitute; two neighbouring letters
 * swapped count once), or `max + 1` as soon as it must exceed `max`.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const width = b.length + 1;
  let prevPrev = new Array<number>(width).fill(0);
  let prev = Array.from({ length: width }, (_, j) => j);
  let current = new Array<number>(width).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    [prevPrev, prev, current] = [prev, current, prevPrev];
  }
  return prev[b.length];
}

interface Indexed {
  word: string;
  key: string;
  spelling: string;
  index: number;
}

function indexWords(words: readonly string[]): Indexed[] {
  const seen = new Set<string>();
  const out: Indexed[] = [];
  words.forEach((word, index) => {
    if (typeof word !== "string" || seen.has(word)) return;
    const key = dictionaryWordKey(word);
    if (!key) return;
    seen.add(word);
    out.push({ word, key, spelling: spellingKey(word), index });
  });
  return out;
}

// Why two words are similar, or null. Variant first, then plural, then near.
function relate(a: Indexed, b: Indexed): { reason: SimilarReason; distance?: number } | null {
  if (a.word === b.word) return null;
  if (a.spelling && a.spelling === b.spelling) return { reason: "variant" };
  if (singularsOf(a.key).includes(b.key) || singularsOf(b.key).includes(a.key)) {
    return { reason: "plural" };
  }
  const max = nearThreshold(a.key, b.key);
  const distance = editDistance(a.key, b.key, max);
  return distance <= max ? { reason: "near", distance } : null;
}

/** The words in `words` similar to `word` (never itself), closest reason first. */
export function similarWordsFor(word: string, words: readonly string[]): SimilarWord[] {
  const key = typeof word === "string" ? dictionaryWordKey(word) : "";
  if (!key) return [];
  const target: Indexed = { word, key, spelling: spellingKey(word), index: -1 };
  const found: Array<SimilarWord & { index: number }> = [];
  for (const other of indexWords(words)) {
    const relation = relate(target, other);
    if (relation) found.push({ word: other.word, ...relation, index: other.index });
  }
  return found
    .sort(
      (x, y) =>
        REASON_ORDER[x.reason] - REASON_ORDER[y.reason] ||
        (x.distance ?? 0) - (y.distance ?? 0) ||
        x.index - y.index
    )
    .map(({ index: _index, ...rest }) => rest);
}

/**
 * The similar words of a whole list: spelling variants grouped (two or more
 * words), then plural pairs, then near-spelling pairs. A pair already in a
 * variant group isn't listed again.
 */
export function similarWordGroups(words: readonly string[]): SimilarGroup[] {
  const list = indexWords(words);
  const groups: SimilarGroup[] = [];

  const bySpelling = new Map<string, Indexed[]>();
  for (const item of list) {
    if (!item.spelling) continue;
    const bucket = bySpelling.get(item.spelling);
    if (bucket) bucket.push(item);
    else bySpelling.set(item.spelling, [item]);
  }
  for (const bucket of bySpelling.values()) {
    if (bucket.length > 1) groups.push({ reason: "variant", words: bucket.map((i) => i.word) });
  }

  const byKey = new Map(list.map((item) => [item.key, item]));
  for (const item of list) {
    for (const singular of singularsOf(item.key)) {
      const base = byKey.get(singular);
      if (base && base.spelling !== item.spelling) {
        const pair = base.index < item.index ? [base, item] : [item, base];
        groups.push({ reason: "plural", words: pair.map((i) => i.word) });
      }
    }
  }

  // Near spellings: compared by length, so a pair too far apart in length
  // is never measured.
  const byLength = [...list].sort((a, b) => a.key.length - b.key.length);
  for (let i = 0; i < byLength.length; i += 1) {
    const a = byLength[i];
    for (let j = i + 1; j < byLength.length; j += 1) {
      const b = byLength[j];
      if (b.key.length - a.key.length > 2) break;
      const relation = relate(a, b);
      if (relation?.reason === "near") {
        const pair = a.index < b.index ? [a, b] : [b, a];
        groups.push({ reason: "near", words: pair.map((item) => item.word) });
      }
    }
  }
  return groups;
}
