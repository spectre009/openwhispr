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
// The same rows and matching give one word's counts per week (the
// Dictionary's word detail) and the dictation pace (dictations a day, for the
// monthly token estimate).
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
 * The token index of a word list: one-token words by token; several-token
 * words as " a b " sequences, by their first token. Words are referred to by
 * their position in `words`.
 */
export function buildUsageIndex(words) {
  const list = Array.isArray(words) ? words : [];
  const index = { size: list.length, singles: new Map(), multisByFirst: new Map() };
  list.forEach((word, position) => {
    const tokens = usageTokens(dictionaryWordKey(word));
    if (tokens.length === 0) return;
    const [first] = tokens;
    const bucket = tokens.length === 1 ? index.singles : index.multisByFirst;
    const entry = tokens.length === 1 ? position : { word: position, seq: ` ${tokens.join(" ")} ` };
    if (bucket.has(first)) bucket.get(first).push(entry);
    else bucket.set(first, [entry]);
  });
  return index;
}

/**
 * One row at a time against an index (buildUsageIndex): the positions of the
 * words its raw transcript has (heard), its final text has without snippet
 * expansions (written), and the second without the first (missed, paired per
 * row). Rows without a raw transcript return null.
 */
export function createUsageMatcher(index, { snippetExpansions = [] } = {}) {
  const expansions = (Array.isArray(snippetExpansions) ? snippetExpansions : []).filter(
    (text) => typeof text === "string" && text.trim()
  );
  const heardStamps = new Int32Array(index.size).fill(-1);
  const writtenStamps = new Int32Array(index.size).fill(-1);
  let stamp = -1;
  return (row) => {
    if (!row || typeof row.raw !== "string") return null;
    stamp += 1;
    const finalText = typeof row.final === "string" ? row.final : row.raw;
    const heard = collectMatches(usageTokens(row.raw), index, heardStamps, stamp, []);
    const written = collectMatches(
      usageTokens(expansions.length ? withoutExpansions(finalText, expansions) : finalText),
      index,
      writtenStamps,
      stamp,
      []
    );
    const missed = written.filter((word) => heardStamps[word] !== stamp);
    return { heard, written, missed };
  };
}

/**
 * Counts each word over `rows` (`{ raw, final }`). Pure: no database, no clock.
 * `snippetExpansions`: the snippets' replacement texts.
 */
export function countDictionaryUsage(rows, words, { snippetExpansions = [] } = {}) {
  const list = Array.isArray(words) ? words.filter((w) => typeof w === "string") : [];
  const heard = new Array(list.length).fill(0);
  const written = new Array(list.length).fill(0);
  const missedRows = new Array(list.length).fill(0);
  const match = createUsageMatcher(buildUsageIndex(list), { snippetExpansions });

  let counted = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const found = match(row);
    if (!found) continue;
    counted += 1;
    for (const word of found.heard) heard[word] += 1;
    for (const word of found.written) written[word] += 1;
    for (const word of found.missed) missedRows[word] += 1;
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

const DAY_MS = 24 * 60 * 60 * 1000;
// The word detail's chart: 13 weeks ending now (the oldest one starts where
// the 90-day window does, so it's a day short).
export const DICTIONARY_USAGE_WEEKS = 13;
// Dictation pace (the monthly token estimate): the last 30 days.
export const DICTIONARY_PACE_DAYS = 30;

/** A row's time (SQLite's "YYYY-MM-DD HH:MM:SS", UTC, or ISO) in ms; NaN when unreadable. */
export function usageRowTime(at) {
  if (typeof at !== "string" || !at.trim()) return NaN;
  const text = at.trim();
  const iso = text.includes("T") ? text : text.replace(" ", "T");
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
}

/**
 * One word's counts per week over `rows` (`{ raw, final, at }`), by the same
 * matching as countDictionaryUsage: `weeks` buckets of 7 days ending at
 * `now`, the oldest starting no earlier than `days` ago. Counts only.
 */
export function countWordUsageByWeek(
  rows,
  word,
  {
    snippetExpansions = [],
    now = Date.now(),
    days = DICTIONARY_USAGE_DAYS,
    weeks = DICTIONARY_USAGE_WEEKS,
  } = {}
) {
  const windowStart = now - days * DAY_MS;
  const buckets = Array.from({ length: weeks }, (_, k) => {
    const start = Math.max(windowStart, now - (weeks - k) * 7 * DAY_MS);
    return { start, heard: 0, written: 0, missedRows: 0 };
  });
  if (typeof word !== "string" || !dictionaryWordKey(word)) {
    return buckets.map((bucket) => ({ ...bucket, start: new Date(bucket.start).toISOString() }));
  }
  const match = createUsageMatcher(buildUsageIndex([word]), { snippetExpansions });
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = usageRowTime(row?.at);
    if (!Number.isFinite(at) || at < windowStart || at > now) continue;
    const found = match(row);
    if (!found) continue;
    let k = weeks - 1;
    while (k > 0 && at < buckets[k].start) k -= 1;
    const bucket = buckets[k];
    if (found.heard.length > 0) bucket.heard += 1;
    if (found.written.length > 0) bucket.written += 1;
    if (found.missed.length > 0) bucket.missedRows += 1;
  }
  return buckets.map((bucket) => ({ ...bucket, start: new Date(bucket.start).toISOString() }));
}

/**
 * Dictations a day (`rows` with `at`) over the last DICTIONARY_PACE_DAYS, or
 * since the oldest row when History is younger than that (at least a day).
 * One decimal.
 */
export function dictationPace(rows, { now = Date.now(), days = DICTIONARY_PACE_DAYS } = {}) {
  const since = now - days * DAY_MS;
  let count = 0;
  let oldest = Infinity;
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = usageRowTime(row?.at);
    if (!Number.isFinite(at)) continue;
    if (at < oldest) oldest = at;
    if (at >= since && at <= now) count += 1;
  }
  if (count === 0) return { perDay: 0 };
  const spanDays = Math.min(days, Math.max(1, (now - Math.max(oldest, since)) / DAY_MS));
  return { perDay: Math.round((count / spanDays) * 10) / 10 };
}

/** SQLite's UTC time format ("YYYY-MM-DD HH:MM:SS"), as transcriptions.created_at stores it. */
function sqliteTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function usageRows(db, { days, owner, now }) {
  const since = sqliteTime(now - days * DAY_MS);
  return db.getDictionaryUsageRows({ owner, since });
}

/**
 * The counts over `db`'s History (DatabaseManager): the rows of the last
 * `days` days, the dictionary's words, the snippets' expansions; and the
 * dictation pace from the same rows.
 */
export function computeDictionaryUsage(
  db,
  words,
  { days = DICTIONARY_USAGE_DAYS, owner = null, snippetExpansions = [], now = Date.now() } = {}
) {
  const rows = usageRows(db, { days, owner, now });
  return {
    ...countDictionaryUsage(rows, words, { snippetExpansions }),
    pace: dictationPace(rows, { now }),
  };
}

/** One word's weekly counts over `db`'s History, by computeDictionaryUsage's rows and rule. */
export function computeWordUsage(
  db,
  word,
  { days = DICTIONARY_USAGE_DAYS, owner = null, snippetExpansions = [], now = Date.now() } = {}
) {
  const rows = usageRows(db, { days, owner, now });
  return countWordUsageByWeek(rows, word, { snippetExpansions, now, days });
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
      pace: counts.pace,
    };
  }

  // The owner History is read for, when it's durable for them; else why not.
  function readableOwner() {
    let owner = null;
    try {
      owner = getOwner();
    } catch {
      owner = null;
    }
    const availability = usageAvailability(getPolicy?.() ?? null, owner);
    if (!availability.available) return { owner: null, reason: availability.reason };
    if (!db?.getDictionaryUsageRows) return { owner: null, reason: STORAGE_REASONS.UNAVAILABLE };
    return { owner, reason: null };
  }

  async function get() {
    const { owner, reason } = readableOwner();
    if (!owner) return { available: false, reason };

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

  // The word detail's weekly counts, for the few words opened lately.
  const wordCache = new Map();
  const WORD_CACHE_SIZE = 16;

  async function getWord(word) {
    const { owner, reason } = readableOwner();
    if (!owner) return { available: false, reason };
    const at = now();
    const expansions = getSnippetExpansions() ?? [];
    const revision = db.getHistoryContentRevision?.() ?? null;
    const shape = JSON.stringify([owner, dayKey(at), dictionaryWordKey(word), expansions]);
    const cached = wordCache.get(shape);
    if (cached && revision !== null && cached.revision === revision) return cached.result;
    const weeks = computeWordUsage(db, word, {
      days,
      owner,
      snippetExpansions: expansions,
      now: at,
    });
    const result = { available: true, days, weeks };
    wordCache.delete(shape);
    wordCache.set(shape, { revision, result });
    if (wordCache.size > WORD_CACHE_SIZE) wordCache.delete(wordCache.keys().next().value);
    return result;
  }

  // How this owner's cleanups ran per dictionary word set (the cleanup or
  // one-step style steps that recorded one), over the same window. Counts only.
  async function getCleanupScopeCounts() {
    const { owner, reason } = readableOwner();
    if (!owner) return { available: false, reason };
    if (!db.getDictionaryCleanupScopeCounts) {
      return { available: false, reason: STORAGE_REASONS.UNAVAILABLE };
    }
    const since = sqliteTime(now() - days * DAY_MS);
    return { available: true, days, sets: db.getDictionaryCleanupScopeCounts({ owner, since }) };
  }

  return {
    get,
    getWord,
    getCleanupScopeCounts,
    /** History's policy or owner changed: the next read recomputes. */
    invalidate() {
      cache = null;
      wordCache.clear();
    },
  };
}
