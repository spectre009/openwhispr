// "Heard vs written" for each dictionary word, from local History, in main.
// Pure ESM like stepFailure.js: main loads it through require(esm), and the
// renderer's usage store reads `isSpeechMissed` from it.
//
// Per word, over the completed, non-deleted dictations of the last 90 days
// (translations and the assistant's answers left out by the database read):
// - heard: rows whose raw transcript contains it (speech-to-text wrote it);
// - written: rows whose final text contains it (what was pasted);
// - missedRows: rows where the final text has it and the raw text doesn't.
//   Paired per row, never written − heard: ten misses and ten unrelated
//   raw-only hits would cancel out.
// These are heuristics, and 0/0 means unknown, never "speech gets it right".
//
// A token index, not a regex per word: each row is tokenized once into
// lowercase word tokens; a one-token word is a set lookup, and a word with
// several tokens ("agents-shared", "CLAUDE.md") matches as that token
// sequence. Text never leaves this module except as counts, and is never
// logged.

import { dictionaryWordKey } from "../utils/dictionaryWordKey.js";

export const DICTIONARY_USAGE_DAYS = 90;
// Recomputed at most this often while dictations keep arriving.
export const DICTIONARY_USAGE_MIN_INTERVAL_MS = 30_000;

// What "speech often misses it" means: at least two paired misses, or one
// when it's at least a quarter of the rows that wrote the word.
export const MISSED_MIN_ROWS = 2;
export const MISSED_MIN_SHARE = 0.25;

const TOKEN_RE = /[\p{L}\p{M}\p{N}_]+/gu;
// The same runs for ASCII text, without Unicode property lookups.
const ASCII_TOKEN_RE = /[a-z0-9_]+/g;
const NON_ASCII_RE = /[\u0080-\uffff]/;

/** Lowercase word tokens of a text, in order. */
export function usageTokens(text) {
  if (typeof text !== "string" || !text) return [];
  if (!NON_ASCII_RE.test(text)) return text.toLowerCase().match(ASCII_TOKEN_RE) ?? [];
  return text.normalize("NFC").toLowerCase().match(TOKEN_RE) ?? [];
}

/** Whether a word's counts say speech often misses it (cleanup's "words speech misses"). */
export function isSpeechMissed(counts) {
  const missed = Number(counts?.missedRows) || 0;
  const written = Number(counts?.written) || 0;
  if (missed < 1) return false;
  return missed >= MISSED_MIN_ROWS || missed >= MISSED_MIN_SHARE * written;
}

// The final text without what snippets expanded into: a word that appears
// only inside an expansion wasn't said, so it isn't "written" either.
function withoutExpansions(text, expansions) {
  let out = text;
  for (const expansion of expansions) {
    if (out.includes(expansion)) out = out.split(expansion).join(" ");
  }
  return out;
}

// The indices of the words a row's tokens contain, each once (`stamps` marks
// what this row already matched): a one-token word is a lookup, a word of
// several tokens (indexed by its first) a search for its token sequence.
function collectMatches(tokens, index, stamps, stamp, out) {
  let joined = null;
  for (const token of tokens) {
    const single = index.singles.get(token);
    if (single) {
      for (const word of single) {
        if (stamps[word] !== stamp) {
          stamps[word] = stamp;
          out.push(word);
        }
      }
    }
    const multi = index.multisByFirst.get(token);
    if (multi) {
      joined ??= ` ${tokens.join(" ")} `;
      for (const { word, seq } of multi) {
        if (stamps[word] !== stamp && joined.includes(seq)) {
          stamps[word] = stamp;
          out.push(word);
        }
      }
    }
  }
  return out;
}

/**
 * Counts each word over `rows` (`{ raw, final }`). Pure: no database, no clock.
 * `snippetExpansions`: the snippets' replacement texts.
 */
export function countDictionaryUsage(rows, words, { snippetExpansions = [] } = {}) {
  const list = Array.isArray(words) ? words.filter((w) => typeof w === "string") : [];
  const expansions = (Array.isArray(snippetExpansions) ? snippetExpansions : []).filter(
    (text) => typeof text === "string" && text.trim()
  );
  const heard = new Array(list.length).fill(0);
  const written = new Array(list.length).fill(0);
  const missedRows = new Array(list.length).fill(0);

  // The token index: one-token words by token; several-token words as
  // " a b " sequences, by their first token.
  const index = { singles: new Map(), multisByFirst: new Map() };
  list.forEach((word, position) => {
    const tokens = usageTokens(dictionaryWordKey(word));
    if (tokens.length === 0) return;
    const [first] = tokens;
    const bucket = tokens.length === 1 ? index.singles : index.multisByFirst;
    const entry = tokens.length === 1 ? position : { word: position, seq: ` ${tokens.join(" ")} ` };
    if (bucket.has(first)) bucket.get(first).push(entry);
    else bucket.set(first, [entry]);
  });

  const heardStamps = new Int32Array(list.length).fill(-1);
  const writtenStamps = new Int32Array(list.length).fill(-1);
  let counted = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.raw !== "string") continue;
    const stamp = counted;
    counted += 1;
    const finalText = typeof row.final === "string" ? row.final : row.raw;
    const heardHere = collectMatches(usageTokens(row.raw), index, heardStamps, stamp, []);
    const writtenHere = collectMatches(
      usageTokens(expansions.length ? withoutExpansions(finalText, expansions) : finalText),
      index,
      writtenStamps,
      stamp,
      []
    );
    for (const word of heardHere) heard[word] += 1;
    for (const word of writtenHere) {
      written[word] += 1;
      if (heardStamps[word] !== stamp) missedRows[word] += 1;
    }
  }

  return {
    rows: counted,
    words: list.map((word, index) => ({
      word,
      heard: heard[index],
      written: written[index],
      missedRows: missedRows[index],
    })),
  };
}

/** SQLite's UTC time format ("YYYY-MM-DD HH:MM:SS"), as transcriptions.created_at stores it. */
function sqliteTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The counts over `db`'s History (DatabaseManager): the rows of the last
 * `days` days, the dictionary's words, the snippets' expansions.
 */
export function computeDictionaryUsage(
  db,
  words,
  { days = DICTIONARY_USAGE_DAYS, owner = null, snippetExpansions = [], now = Date.now() } = {}
) {
  const since = sqliteTime(now - days * 24 * 60 * 60 * 1000);
  const rows = db.getDictionaryUsageRows({ owner, since });
  return countDictionaryUsage(rows, words, { snippetExpansions });
}

const STORAGE_REASONS = Object.freeze({
  POLICY_OFF: "policy-off",
  PENDING: "pending",
  HISTORY_OFF: "history-off",
  UNAVAILABLE: "unavailable",
});

/**
 * Local history durable for this owner, by the test set's rule
 * (promptTestCases.js): never while an organization forces it off, pending
 * until the retention settings synced, off when history is off, and pending
 * for an account until its managed policy resolved.
 */
export function usageAvailability(policy, owner) {
  if (!owner) return { available: false, reason: STORAGE_REASONS.UNAVAILABLE };
  if (policy?.forcedOff === true) return { available: false, reason: STORAGE_REASONS.POLICY_OFF };
  if (policy?.synced !== true) return { available: false, reason: STORAGE_REASONS.PENDING };
  if (policy?.enabled !== true) return { available: false, reason: STORAGE_REASONS.HISTORY_OFF };
  if (owner !== "signed-out" && policy?.resolved !== true) {
    return { available: false, reason: STORAGE_REASONS.PENDING };
  }
  return { available: true, reason: null };
}

/**
 * The `dictionary-usage` service: counts for the current owner, cached by
 * the word list, the snippets, the owner, the day (the window moves) and the
 * history content revision (database.getHistoryContentRevision, bumped by
 * every transcription write). While dictations keep arriving it recomputes at
 * most every 30 s; `invalidate()` (history policy or owner changed) forces
 * the next read. Concurrent reads share one computation.
 */
export function createDictionaryUsageService({
  db,
  getOwner,
  getPolicy,
  getSnippetExpansions = () => [],
  now = () => Date.now(),
  minIntervalMs = DICTIONARY_USAGE_MIN_INTERVAL_MS,
  days = DICTIONARY_USAGE_DAYS,
  onComputed = null,
}) {
  let cache = null;
  let inFlight = null;

  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

  function compute(owner, words, expansions, at) {
    const counts = computeDictionaryUsage(db, words, {
      days,
      owner,
      snippetExpansions: expansions,
      now: at,
    });
    return {
      available: true,
      computedAt: new Date(at).toISOString(),
      days,
      rows: counts.rows,
      words: counts.words,
    };
  }

  async function get() {
    let owner = null;
    try {
      owner = getOwner();
    } catch {
      owner = null;
    }
    const availability = usageAvailability(getPolicy?.() ?? null, owner);
    if (!availability.available) return { available: false, reason: availability.reason };
    if (!db?.getDictionaryUsageRows)
      return { available: false, reason: STORAGE_REASONS.UNAVAILABLE };

    const at = now();
    const words = db.getDictionary();
    const expansions = getSnippetExpansions() ?? [];
    const revision = db.getHistoryContentRevision?.() ?? null;
    const shape = JSON.stringify([owner, dayKey(at), words, expansions]);
    if (cache && cache.shape === shape) {
      const fresh = revision !== null && cache.revision === revision;
      // Dictations keep arriving: the last counts stand for a while.
      if (fresh || at - cache.at < minIntervalMs) return cache.result;
    }
    if (inFlight && inFlight.shape === shape) return inFlight.promise;
    const promise = Promise.resolve().then(() => {
      const result = compute(owner, words, expansions, at);
      cache = { shape, revision, at, result };
      onComputed?.({ rows: result.rows, words: result.words.length, ms: now() - at });
      return result;
    });
    inFlight = { shape, promise };
    try {
      return await promise;
    } finally {
      if (inFlight?.promise === promise) inFlight = null;
    }
  }

  return {
    get,
    /** History's policy or owner changed: the next read recomputes. */
    invalidate() {
      cache = null;
    },
  };
}
