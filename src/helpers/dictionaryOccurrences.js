// Where a dictionary word appeared in History, and what speech wrote instead:
// the Dictionary's "Where it appeared" and "Speech writes it as", and
// History's "Dictionary in this dictation" and its underlines. Pure ESM like
// dictionaryUsage.js (main loads it through require(esm)), plus the main
// service at the end.
//
// Two layers, on purpose:
// - Row summaries (dictionaryUsage.js's token-index matcher) decide which
//   rows a word is in at all: counts, filters, and the candidates here.
// - Aligned spans (this file) say, per appearance, what happened. A row's raw
//   transcript and its final text are aligned word by word (lowercase
//   `usageTokens` tokens, an LCS bounded like utils/textDiff.ts), with
//   character offsets into both texts. Each place a word's tokens occur is an
//   appearance:
//   - "ok": in raw and final at aligned positions (speech got it);
//   - "fix": in final, and the aligned raw span differs (fixed after speech);
//     `speechWrote` is that raw span as written (case and punctuation kept),
//     at most 4 tokens, null when the alignment is ambiguous or speech wrote
//     nothing there;
//   - "chg": in raw, and the aligned final span differs (changed after speech).
//   A row can be mixed ("Little Buddy and Littbuddy": one ok, one fix), so a
//   row's kinds are a set. Row summaries and alignment agree except for mixed
//   rows (the summary counts the row once: "speech got it" when raw and final
//   both have the word) and rows too long to align (no appearances here, still
//   counted by the summaries).
// - Snippet expansions are blanked out of the final text by as many spaces,
//   so they're skipped for matching (as usage skips them) while every offset
//   still points into the real final text.
// - Attribution (`by`) never comes from raw against final: "glossary" when
//   one of this owner's glossary steps for the row fired a rule whose
//   canonical form is the word, else "cleanup" (or "style") when that step's
//   input lacks the word and its output has it, else null.
//
// Ownership: raw and final text are device-wide in History (any owner sees
// every row's text there), so snippets follow that contract. The app, the
// attribution and the assistant-row exclusion come only from the current
// owner's steps, and the Dictionary's occurrences are additionally gated by
// durable History for the owner (usageAvailability), as usage is.
//
// Nothing here logs: dictionary words, snippets and what speech wrote never
// reach a log, whatever "Include dictated text" says. Callers log counts.

import { dictionaryWordKey } from "../utils/dictionaryWordKey.js";
import { stepChanges } from "../utils/stepChanges.js";
import {
  DICTIONARY_USAGE_DAYS,
  DICTIONARY_USAGE_MIN_INTERVAL_MS,
  buildUsageIndex,
  createUsageMatcher,
  usableExpansions,
  usageAvailability,
  usageRowTime,
  usageTokens,
  withoutExpansions,
} from "./dictionaryUsage.js";

/** The LCS table's cap, as utils/textDiff.ts: over it, a row has no appearances. */
export const ALIGNMENT_MAX_CELLS = 4_000_000;
/** What speech wrote is at most this many tokens; longer is a rewrite, not a spelling. */
export const SPEECH_WROTE_MAX_TOKENS = 4;
/** A snippet's context on each side of the match, in characters. */
export const SNIPPET_CONTEXT_CHARS = 60;
export const OCCURRENCES_DEFAULT_LIMIT = 20;
export const OCCURRENCES_MAX_LIMIT = 50;
export const SPEECH_VARIANTS_MAX = 5;

export const APPEARANCE_KINDS = Object.freeze(["ok", "fix", "chg"]);
const KIND_BITS = Object.freeze({ ok: 1, fix: 2, chg: 4 });
// A list row's kind when one stands for it: fixed, else got, else changed.
const KIND_PRIORITY = Object.freeze(["fix", "ok", "chg"]);

const NON_ASCII_RE = /[\u0080-\uffff]/;
const ASCII_TOKEN_RE = /[A-Za-z0-9_]+/g;
const TOKEN_RE = /[\p{L}\p{M}\p{N}_]+/gu;

/**
 * `text` with each snippet expansion replaced by as many spaces, in the order
 * usage removes them: the tokens are usage's, the offsets the real text's.
 */
export function maskExpansions(text, snippetExpansions) {
  if (typeof text !== "string" || !text) return typeof text === "string" ? text : "";
  const expansions = usableExpansions(snippetExpansions);
  let out = text;
  for (const expansion of expansions) {
    let at = out.indexOf(expansion);
    if (at < 0) continue;
    let next = "";
    let from = 0;
    while (at >= 0) {
      next += out.slice(from, at) + " ".repeat(expansion.length);
      from = at + expansion.length;
      at = out.indexOf(expansion, from);
    }
    out = next + out.slice(from);
  }
  return out;
}

/**
 * `usageTokens(text)` with each token's place in `text`: `tokens` lowercase
 * (NFC for non-ASCII text), `starts` and `ends` character offsets.
 */
export function offsetTokens(text) {
  const tokens = [];
  const starts = [];
  const ends = [];
  if (typeof text !== "string" || !text) return { tokens, starts, ends };
  const ascii = !NON_ASCII_RE.test(text);
  for (const match of text.matchAll(ascii ? ASCII_TOKEN_RE : TOKEN_RE)) {
    tokens.push(ascii ? match[0].toLowerCase() : match[0].normalize("NFC").toLowerCase());
    starts.push(match.index);
    ends.push(match.index + match[0].length);
  }
  return { tokens, starts, ends };
}

function trimmedSpan(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return { start, endA, endB };
}

/** Whether two token lists align within the cap (their common start and end set aside). */
export function alignmentFits(a, b, { maxCells = ALIGNMENT_MAX_CELLS } = {}) {
  const { start, endA, endB } = trimmedSpan(a, b);
  return (endA - start) * (endB - start) <= maxCells;
}

/**
 * A word-level alignment of `a` (raw tokens) with `b` (final tokens): the
 * common start and end, then the longest common subsequence of the rest,
 * preferring textDiff's choices. `rawOf[j]`: the raw token final token `j`
 * equals, or -1; `finalOf[i]` the other way. Null over `maxCells`.
 */
export function alignTokens(a, b, { maxCells = ALIGNMENT_MAX_CELLS } = {}) {
  const rawOf = new Int32Array(b.length).fill(-1);
  const finalOf = new Int32Array(a.length).fill(-1);
  const { start, endA, endB } = trimmedSpan(a, b);
  const n = endA - start;
  const m = endB - start;
  if (n * m > maxCells) return null;
  for (let k = 0; k < start; k += 1) {
    rawOf[k] = k;
    finalOf[k] = k;
  }
  for (let k = 0; k < a.length - endA; k += 1) {
    rawOf[endB + k] = endA + k;
    finalOf[endA + k] = endB + k;
  }
  if (n > 0 && m > 0) {
    const width = m + 1;
    const Table = Math.min(n, m) < 0xffff ? Uint16Array : Uint32Array;
    const lcs = new Table((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * width + j] =
          a[start + i] === b[start + j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        finalOf[start + i] = start + j;
        rawOf[start + j] = start + i;
        i += 1;
        j += 1;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }
  return { rawOf, finalOf };
}

// The changed runs between equal tokens: each `{ rawStart, rawEnd,
// finalStart, finalEnd }` (end exclusive), and which one each unequal final
// token is in.
function changedRuns(rawLength, finalLength, rawOf) {
  const runOfFinal = new Int32Array(finalLength).fill(-1);
  const runs = [];
  let previousRaw = -1;
  let previousFinal = -1;
  for (let j = 0; j <= finalLength; j += 1) {
    if (j < finalLength && rawOf[j] < 0) continue;
    const nextRaw = j < finalLength ? rawOf[j] : rawLength;
    const run = {
      rawStart: previousRaw + 1,
      rawEnd: nextRaw,
      finalStart: previousFinal + 1,
      finalEnd: j,
    };
    if (run.rawEnd > run.rawStart || run.finalEnd > run.finalStart) {
      for (let k = run.finalStart; k < run.finalEnd; k += 1) runOfFinal[k] = runs.length;
      runs.push(run);
    }
    if (j < finalLength) {
      previousRaw = rawOf[j];
      previousFinal = j;
    }
  }
  return { runs, runOfFinal };
}

/**
 * Words prepared for matching: each with its key and token sequence, one per
 * key (the first spelling), indexed by first token. Words without tokens are
 * left out.
 */
export function prepareWords(words) {
  const list = [];
  const byFirst = new Map();
  const seen = new Set();
  for (const word of Array.isArray(words) ? words : []) {
    if (typeof word !== "string") continue;
    const key = dictionaryWordKey(word);
    if (!key || seen.has(key)) continue;
    const seq = usageTokens(key);
    if (seq.length === 0) continue;
    seen.add(key);
    const index = list.length;
    list.push({ word, key, seq });
    if (byFirst.has(seq[0])) byFirst.get(seq[0]).push(index);
    else byFirst.set(seq[0], [index]);
  }
  return { list, byFirst };
}

// Where each prepared word starts in `tokens` (non-overlapping per word).
function findStarts(tokens, prepared) {
  const found = new Map();
  const lastEnd = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const candidates = prepared.byFirst.get(tokens[i]);
    if (!candidates) continue;
    for (const w of candidates) {
      const { seq } = prepared.list[w];
      if (i + seq.length > tokens.length || (lastEnd.get(w) ?? 0) > i) continue;
      let k = 1;
      while (k < seq.length && tokens[i + k] === seq[k]) k += 1;
      if (k < seq.length) continue;
      if (found.has(w)) found.get(w).push(i);
      else found.set(w, [i]);
      lastEnd.set(w, i + seq.length);
    }
  }
  return found;
}

const sameSequence = (tokens, from, to, seq) =>
  to - from === seq.length && seq.every((token, k) => tokens[from + k] === token);

// A changed run's raw side longer than this isn't trimmed: it's a rewrite.
const TRIM_MAX_TOKENS = 8;
const TRIM_MAX_CHARS = 80;

/** Levenshtein distance, two rows. */
function editDistance(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// The contiguous part of raw tokens [rs, re) whose letters are closest to the
// word's; the whole span unless a part is strictly closer and still looks
// like the word (at most half its letters differ). Among parts as close,
// the longest.
function closestPart(tokens, rs, re, target) {
  const letters = (s, t) => tokens.slice(s, t).join("");
  if (letters(rs, re).length > TRIM_MAX_CHARS || target.length > TRIM_MAX_CHARS) return { rs, re };
  const whole = editDistance(letters(rs, re), target);
  let best = null;
  for (let s = rs; s < re; s += 1) {
    for (let t = s + 1; t <= re; t += 1) {
      if (s === rs && t === re) continue;
      const distance = editDistance(letters(s, t), target);
      if (
        !best ||
        distance < best.distance ||
        (distance === best.distance && t - s > best.re - best.rs)
      ) {
        best = { rs: s, re: t, distance };
      }
    }
  }
  if (!best || best.distance >= whole || best.distance > Math.floor(target.length / 2)) {
    return { rs, re };
  }
  return { rs: best.rs, re: best.re };
}

/**
 * Each prepared word's appearances in one row (`{ raw, final }`, final
 * defaulting to raw): `{ aligned, words: [{ word, key, appearances }] }`,
 * appearances `{ kind, start, end, speechWrote }` with `start`/`end` offsets
 * into the final text for "ok" and "fix", into the raw transcript for "chg",
 * plus `rawStart`/`rawEnd` (what speech wrote, or the raw side of an "ok")
 * when known. `aligned: false` (no appearances): the row has no raw
 * transcript or is too long to align.
 */
export function rowAppearances(
  row,
  prepared,
  { snippetExpansions = [], maxCells = ALIGNMENT_MAX_CELLS } = {}
) {
  if (!row || typeof row.raw !== "string") return { aligned: false, words: [] };
  const raw = row.raw;
  const finalText = typeof row.final === "string" ? row.final : raw;
  const rawSide = offsetTokens(raw);
  const finalSide = offsetTokens(maskExpansions(finalText, snippetExpansions));
  const inRaw = findStarts(rawSide.tokens, prepared);
  const inFinal = findStarts(finalSide.tokens, prepared);
  if (inRaw.size === 0 && inFinal.size === 0) return { aligned: true, words: [] };
  const alignment = alignTokens(rawSide.tokens, finalSide.tokens, { maxCells });
  if (!alignment) return { aligned: false, words: [] };
  const { rawOf } = alignment;
  let runs = null;

  // The raw span aligned with final tokens [q, e): from the first's raw token
  // (or the start of its changed run) to the last's (or the run's end). Null
  // when a changed run reaches outside the word (ambiguous), speech wrote
  // nothing there, or it's longer than a spelling. When the word is one
  // changed run on its own and speech wrote several tokens there, words
  // merely dropped beside it ("sean and" → "Shawn") are trimmed off: the
  // contiguous part closest in letters wins, only when strictly closer.
  const speechWroteFor = (q, e, seq) => {
    runs ??= changedRuns(rawSide.tokens.length, finalSide.tokens.length, rawOf);
    let rs;
    if (rawOf[q] >= 0) rs = rawOf[q];
    else {
      const run = runs.runs[runs.runOfFinal[q]];
      if (!run || run.finalStart !== q) return null;
      rs = run.rawStart;
    }
    let re;
    if (rawOf[e - 1] >= 0) re = rawOf[e - 1] + 1;
    else {
      const run = runs.runs[runs.runOfFinal[e - 1]];
      if (!run || run.finalEnd !== e) return null;
      re = run.rawEnd;
    }
    if (re <= rs) return null;
    const oneRun =
      rawOf[q] < 0 && rawOf[e - 1] < 0 && runs.runOfFinal[q] === runs.runOfFinal[e - 1];
    if (oneRun && re - rs > 1 && re - rs <= TRIM_MAX_TOKENS) {
      ({ rs, re } = closestPart(rawSide.tokens, rs, re, seq.join("")));
    }
    if (re - rs > SPEECH_WROTE_MAX_TOKENS) return null;
    if (sameSequence(rawSide.tokens, rs, re, seq)) return null;
    const rawStart = rawSide.starts[rs];
    const rawEnd = rawSide.ends[re - 1];
    return { text: raw.slice(rawStart, rawEnd), rawStart, rawEnd };
  };

  const words = [];
  const indexes = new Set([...inFinal.keys(), ...inRaw.keys()]);
  for (const w of [...indexes].sort((x, y) => x - y)) {
    const { word, key, seq } = prepared.list[w];
    const L = seq.length;
    const appearances = [];
    const okRaw = new Set();
    for (const q of inFinal.get(w) ?? []) {
      const p = rawOf[q];
      let ok = p >= 0;
      for (let k = 1; ok && k < L; k += 1) ok = rawOf[q + k] === p + k;
      const start = finalSide.starts[q];
      const end = finalSide.ends[q + L - 1];
      if (ok) {
        okRaw.add(p);
        appearances.push({
          kind: "ok",
          start,
          end,
          speechWrote: null,
          rawStart: rawSide.starts[p],
          rawEnd: rawSide.ends[p + L - 1],
        });
      } else {
        const wrote = speechWroteFor(q, q + L, seq);
        appearances.push({
          kind: "fix",
          start,
          end,
          speechWrote: wrote ? wrote.text : null,
          rawStart: wrote ? wrote.rawStart : null,
          rawEnd: wrote ? wrote.rawEnd : null,
        });
      }
    }
    for (const p of inRaw.get(w) ?? []) {
      if (okRaw.has(p)) continue;
      const start = rawSide.starts[p];
      const end = rawSide.ends[p + L - 1];
      appearances.push({
        kind: "chg",
        start,
        end,
        speechWrote: null,
        rawStart: start,
        rawEnd: end,
      });
    }
    if (appearances.length > 0) words.push({ word, key, appearances });
  }
  return { aligned: true, words };
}

/** The kinds a row's appearances have, as a set (in "ok", "fix", "chg" order). */
export function appearanceKinds(appearances) {
  const kinds = new Set((appearances ?? []).map((appearance) => appearance.kind));
  return APPEARANCE_KINDS.filter((kind) => kinds.has(kind));
}

const kindBits = (kinds) => kinds.reduce((bits, kind) => bits | (KIND_BITS[kind] ?? 0), 0);

/**
 * A row's kinds for one word, cheaply when the row summary already says: a
 * word only in the final text is all "fix", only in the raw transcript all
 * "chg"; in both, only the alignment can tell (it may be mixed). 0 when the
 * row can't be aligned.
 */
function rowKindBits(row, found, prepared, options) {
  const inRaw = found.heard.length > 0;
  const inFinal = found.written.length > 0;
  if (inRaw && inFinal) {
    const result = rowAppearances(row, prepared, options);
    if (!result.aligned) return { bits: 0, aligned: false };
    return { bits: kindBits(appearanceKinds(result.words[0]?.appearances)), aligned: true };
  }
  const finalText = typeof row.final === "string" ? row.final : row.raw;
  const fits = alignmentFits(
    usageTokens(row.raw),
    usageTokens(withoutExpansions(finalText, usableExpansions(options.snippetExpansions))),
    options
  );
  if (!fits) return { bits: 0, aligned: false };
  return { bits: inFinal ? KIND_BITS.fix : KIND_BITS.chg, aligned: true };
}

// ─── Snippets ───

const SPACE = /\s/;

/**
 * At most `max` characters of `text` each side of `[start, end)`, cut at
 * word boundaries; a cut side starts (or ends) with "…" within the limit.
 */
export function snippetAround(text, start, end, max = SNIPPET_CONTEXT_CHARS) {
  const source = typeof text === "string" ? text : "";
  const match = source.slice(start, end);
  let before;
  if (start <= max) before = source.slice(0, start);
  else {
    // max − 1 characters and the ellipsis; a word cut in two is left out.
    let from = start - (max - 1);
    if (!SPACE.test(source[from - 1])) {
      while (from < start && !SPACE.test(source[from])) from += 1;
    }
    before = `…${source.slice(from, start).trimStart()}`;
  }
  let after;
  if (source.length - end <= max) after = source.slice(end);
  else {
    let to = end + (max - 1);
    if (!SPACE.test(source[to])) {
      while (to > end && !SPACE.test(source[to - 1])) to -= 1;
    }
    after = `${source.slice(end, to).trimEnd()}…`;
  }
  return { before, match, after };
}

// ─── Attribution, from this owner's steps ───

function parseDetail(detail) {
  if (detail && typeof detail === "object") return detail;
  if (typeof detail !== "string") return null;
  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

function containsSequence(tokens, seq) {
  if (seq.length === 0) return false;
  for (let i = 0; i + seq.length <= tokens.length; i += 1) {
    if (sameSequence(tokens, i, i + seq.length, seq)) return true;
  }
  return false;
}

/**
 * Who put `word` into the final text, from one row's recorded steps (this
 * owner's, in saved order: `{ kind, outcome, output, detail }`): "glossary"
 * when a glossary step fired a rule whose canonical form is the word,
 * "cleanup" or "style" when that step's input lacks the word and its output
 * has it, else null. Never inferred from raw against final.
 */
export function attributeFix(steps, word) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const key = dictionaryWordKey(word);
  if (!key) return null;
  for (const step of steps) {
    if (step?.kind !== "glossary" || step.outcome !== "ok") continue;
    const fired = parseDetail(step.detail)?.rulesFired;
    if (
      Array.isArray(fired) &&
      fired.some((rule) => typeof rule?.to === "string" && dictionaryWordKey(rule.to) === key)
    ) {
      return "glossary";
    }
  }
  const seq = usageTokens(key);
  const changes = stepChanges(steps);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step?.kind !== "cleanup" && step?.kind !== "style") continue;
    if (step.outcome !== "ok" || typeof step.output !== "string") continue;
    const input = changes[i]?.input;
    const inputText = input === null || input === undefined ? null : steps[input]?.output;
    if (typeof inputText !== "string") continue;
    if (
      !containsSequence(usageTokens(inputText), seq) &&
      containsSequence(usageTokens(step.output), seq)
    ) {
      return step.kind;
    }
  }
  return null;
}

/** The target app this owner's steps recorded for a row, or null. */
export function appFromSteps(steps) {
  const first = Array.isArray(steps) ? steps[0] : null;
  if (!first) return null;
  const context = parseDetail(first.context);
  return typeof context?.targetApp === "string" && context.targetApp ? context.targetApp : null;
}

/** Whether this owner's steps say the row was the assistant's (its answer isn't what was said). */
export function isAssistantTrace({ route = null, context = null } = {}) {
  return route === "agent" || parseDetail(context)?.intents?.voiceAgent === true;
}

/**
 * History's "Dictionary in this dictation" for one row: each dictionary word
 * (by key, the dictionary's first spelling) with its appearances
 * (`{ kind, start, end, speechWrote, by }`, offsets as rowAppearances), `by`
 * only on a fix and only from `steps` (the current owner's; none ⇒ null).
 */
export function historyItemDictionary(
  row,
  words,
  { snippetExpansions = [], steps = [], maxCells = ALIGNMENT_MAX_CELLS } = {}
) {
  const result = rowAppearances(row, prepareWords(words), { snippetExpansions, maxCells });
  return {
    aligned: result.aligned,
    words: result.words.map(({ word, appearances }) => {
      const hasFix = appearances.some((appearance) => appearance.kind === "fix");
      const by = hasFix ? attributeFix(steps, word) : null;
      return {
        word,
        appearances: appearances.map(({ kind, start, end, speechWrote }) => ({
          kind,
          start,
          end,
          speechWrote,
          by: kind === "fix" ? by : null,
        })),
      };
    }),
  };
}

// ─── The service in main ───

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_SIZE = 16;
const MAX_CURSOR_CHARS = 64;
const MAX_SPELLING_CHARS = 200;

/** A spelling's identity: its lowercase tokens ("Ash Varia" and "ash-varia" are one). */
export function spellingKey(spelling) {
  return usageTokens(typeof spelling === "string" ? spelling : "").join(" ");
}

function sqliteTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** The request's options as the service reads them, or null when one is malformed. */
export function normalizeOccurrencesRequest(options) {
  const input = options && typeof options === "object" ? options : {};
  const kind = input.kind == null || input.kind === "all" ? null : input.kind;
  if (kind !== null && !APPEARANCE_KINDS.includes(kind)) return null;
  let range = null;
  if (input.range != null) {
    const start = Date.parse(input.range?.start);
    const end = Date.parse(input.range?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    range = { start, end };
  }
  let cursor = null;
  if (input.cursor != null) {
    const { timestamp, id } = input.cursor;
    if (
      typeof timestamp !== "string" ||
      timestamp.length > MAX_CURSOR_CHARS ||
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return null;
    }
    cursor = { timestamp, id };
  }
  const raw = Number.isFinite(input.limit) ? Math.trunc(input.limit) : OCCURRENCES_DEFAULT_LIMIT;
  const limit = Math.min(OCCURRENCES_MAX_LIMIT, Math.max(1, raw));
  return { kind, range, cursor, limit };
}

function groupSteps(stepRows) {
  const byId = new Map();
  for (const step of stepRows ?? []) {
    if (!byId.has(step.transcription_id)) byId.set(step.transcription_id, []);
    byId.get(step.transcription_id).push(step);
  }
  return byId;
}

const isBefore = (entry, cursor) =>
  entry.sortKey < cursor.timestamp || (entry.sortKey === cursor.timestamp && entry.id < cursor.id);

/**
 * The `dictionary-word-occurrences` and `dictionary-speech-variants` service.
 * - db: the DatabaseManager (getDictionaryOccurrenceRows, getDictionaryOccurrenceTexts,
 *   getHistoryStepRows, getHistoryContentRevision)
 * - getOwner(), getPolicy(): as the usage service; nothing without durable History
 * - getSnippetExpansions(), getGeneration(): the snippets' expansions and the
 *   dictionary generation (database.getDictionaryGeneration)
 *
 * One word's index (its candidate rows, newest first, each with its kinds)
 * is built from the row summaries, aligning only rows where the word is in
 * both texts (the only ones whose kinds need it), and cached by owner, day,
 * word, expansions, generation and History's content revision. A page then
 * aligns its own rows again for their offsets, snippet and what speech wrote,
 * with the app and attribution from this owner's steps. Owner, policy and
 * History's revision are checked again before answering.
 */
export function createDictionaryOccurrencesService({
  db,
  getOwner,
  getPolicy,
  getSnippetExpansions = () => [],
  getGeneration = () => null,
  now = () => Date.now(),
  days = DICTIONARY_USAGE_DAYS,
  maxCells = ALIGNMENT_MAX_CELLS,
  minIntervalMs = DICTIONARY_USAGE_MIN_INTERVAL_MS,
  onComputed = null,
}) {
  const cache = new Map();
  const variantsCache = new Map();
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

  function readableOwner() {
    let owner = null;
    try {
      owner = getOwner();
    } catch {
      owner = null;
    }
    const availability = usageAvailability(getPolicy?.() ?? null, owner);
    if (!availability.available) return { owner: null, reason: availability.reason };
    if (!db?.getDictionaryOccurrenceRows) return { owner: null, reason: "unavailable" };
    return { owner, reason: null };
  }

  const remember = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > CACHE_SIZE) map.delete(map.keys().next().value);
  };

  function context(owner, word) {
    const at = now();
    const expansions = usableExpansions(getSnippetExpansions() ?? []);
    let generation = null;
    try {
      generation = getGeneration?.() ?? null;
    } catch {
      generation = null;
    }
    const revision = db.getHistoryContentRevision?.() ?? null;
    const shape = JSON.stringify([
      owner,
      dayKey(at),
      dictionaryWordKey(word),
      expansions,
      generation,
    ]);
    return { at, expansions, generation, revision, shape };
  }

  const fresh = (cached, ctx) =>
    cached &&
    ((ctx.revision !== null && cached.revision === ctx.revision) ||
      (ctx.revision === null && ctx.at - cached.at < minIntervalMs));

  function buildIndex(owner, word, ctx) {
    const started = now();
    const rows = db.getDictionaryOccurrenceRows({
      owner,
      since: sqliteTime(ctx.at - days * DAY_MS),
    });
    const match = createUsageMatcher(buildUsageIndex([word]), {
      snippetExpansions: ctx.expansions,
    });
    const prepared = prepareWords([word]);
    const options = { snippetExpansions: ctx.expansions, maxCells };
    const entries = [];
    let unaligned = 0;
    let aligned = 0;
    for (const row of rows) {
      const found = match(row);
      if (!found || (found.heard.length === 0 && found.written.length === 0)) continue;
      const { bits, aligned: ok } = rowKindBits(row, found, prepared, options);
      if (!ok) unaligned += 1;
      else if (found.heard.length > 0 && found.written.length > 0) aligned += 1;
      entries.push({
        id: row.id,
        sortKey: typeof row.sort_key === "string" ? row.sort_key : "",
        at: usageRowTime(row.at),
        bits,
      });
    }
    onComputed?.({
      kind: "occurrences",
      rows: rows.length,
      candidates: entries.length,
      aligned,
      unaligned,
      ms: now() - started,
    });
    return { entries, unaligned, revision: ctx.revision, at: ctx.at, generation: ctx.generation };
  }

  function indexFor(owner, word, ctx) {
    const cached = cache.get(ctx.shape);
    if (fresh(cached, ctx)) return cached;
    const index = buildIndex(owner, word, ctx);
    remember(cache, ctx.shape, index);
    return index;
  }

  function page(owner, word, ctx, request) {
    const index = indexFor(owner, word, ctx);
    const inRange = request.range
      ? index.entries.filter(
          (entry) =>
            Number.isFinite(entry.at) &&
            entry.at >= request.range.start &&
            entry.at < request.range.end
        )
      : index.entries;
    const totals = { all: 0, ok: 0, fix: 0, chg: 0 };
    for (const entry of inRange) {
      if (!entry.bits) continue;
      totals.all += 1;
      for (const kind of APPEARANCE_KINDS) if (entry.bits & KIND_BITS[kind]) totals[kind] += 1;
    }
    const wanted = request.kind ? KIND_BITS[request.kind] : 7;
    const listed = inRange.filter(
      (entry) => (entry.bits & wanted) !== 0 && (!request.cursor || isBefore(entry, request.cursor))
    );
    const pageEntries = listed.slice(0, request.limit);
    const ids = pageEntries.map((entry) => entry.id);
    const texts = new Map(
      (ids.length > 0 ? db.getDictionaryOccurrenceTexts(ids) : []).map((row) => [row.id, row])
    );
    const steps = groupSteps(ids.length > 0 ? db.getHistoryStepRows?.(ids, owner) : []);
    const prepared = prepareWords([word]);
    const items = [];
    for (const entry of pageEntries) {
      const row = texts.get(entry.id);
      if (!row) continue; // deleted meanwhile
      const result = rowAppearances(row, prepared, { snippetExpansions: ctx.expansions, maxCells });
      const appearances = result.words[0]?.appearances ?? [];
      const kinds = appearanceKinds(appearances);
      if (kinds.length === 0) continue;
      const shownKind = request.kind ?? KIND_PRIORITY.find((kind) => kinds.includes(kind));
      const shown = appearances.find((appearance) => appearance.kind === shownKind);
      if (!shown) continue;
      const rowSteps = steps.get(entry.id) ?? [];
      const by = shown.kind === "fix" ? attributeFix(rowSteps, word) : null;
      const text =
        shown.kind === "chg" ? row.raw : typeof row.final === "string" ? row.final : row.raw;
      items.push({
        id: entry.id,
        at: typeof row.timestamp === "string" ? row.timestamp : entry.sortKey || null,
        app: appFromSteps(rowSteps),
        kinds,
        speechWrote: shown.speechWrote,
        by,
        snippet: { kind: shown.kind, ...snippetAround(text, shown.start, shown.end) },
      });
    }
    const last = pageEntries[pageEntries.length - 1];
    return {
      available: true,
      generation: ctx.generation,
      items,
      nextCursor:
        listed.length > request.limit && last ? { timestamp: last.sortKey, id: last.id } : null,
      totals,
      unaligned: index.unaligned,
    };
  }

  /**
   * One word's dictations, newest first by History's order, a page at a
   * time: `{ available, reason?, generation, items, nextCursor, totals }`.
   */
  async function getOccurrences(word, options) {
    const request = normalizeOccurrencesRequest(options);
    if (!request) return { available: false, reason: "invalid" };
    for (let attempt = 0; ; attempt += 1) {
      const { owner, reason } = readableOwner();
      if (!owner) return { available: false, reason };
      const ctx = context(owner, word);
      const result = page(owner, word, ctx, request);
      // An account switch, a policy change or a History change meanwhile:
      // nothing from before it is delivered.
      const after = readableOwner();
      if (after.owner !== owner) {
        return { available: false, reason: after.reason ?? "owner-changed" };
      }
      const revision = db.getHistoryContentRevision?.() ?? null;
      if (revision === ctx.revision || attempt >= 1) {
        if (revision !== ctx.revision) return { available: false, reason: "changed" };
        return result;
      }
    }
  }

  function computeVariants(owner, word, ctx) {
    const started = now();
    const rows = db.getDictionaryOccurrenceRows({
      owner,
      since: sqliteTime(ctx.at - days * DAY_MS),
    });
    const match = createUsageMatcher(buildUsageIndex([word]), {
      snippetExpansions: ctx.expansions,
    });
    const prepared = prepareWords([word]);
    const options = { snippetExpansions: ctx.expansions, maxCells };
    // Spelling (by its tokens) → the dictations it was fixed from, and its written forms.
    const spellings = new Map();
    for (const row of rows) {
      const found = match(row);
      if (!found || found.written.length === 0) continue;
      const result = rowAppearances(row, prepared, options);
      const seenHere = new Set();
      for (const appearance of result.words[0]?.appearances ?? []) {
        if (appearance.kind !== "fix" || !appearance.speechWrote) continue;
        const key = spellingKey(appearance.speechWrote);
        if (!key) continue;
        let entry = spellings.get(key);
        if (!entry) {
          entry = { key, rows: 0, forms: new Map() };
          spellings.set(key, entry);
        }
        if (!seenHere.has(key)) {
          seenHere.add(key);
          entry.rows += 1;
        }
        entry.forms.set(appearance.speechWrote, (entry.forms.get(appearance.speechWrote) ?? 0) + 1);
      }
    }
    const top = [...spellings.values()]
      .sort((a, b) => b.rows - a.rows || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, SPEECH_VARIANTS_MAX)
      .map((entry) => ({
        spelling: [...entry.forms].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0],
        count: entry.rows,
      }));
    const kept = keptInFinal(
      rows,
      top.map((variant) => variant.spelling),
      ctx
    );
    onComputed?.({
      kind: "variants",
      rows: rows.length,
      spellings: spellings.size,
      ms: now() - started,
    });
    return {
      variants: top.map((variant, index) => ({ ...variant, keptInFinal: kept[index] })),
      counts: new Map([...spellings.values()].map((entry) => [entry.key, entry.rows])),
    };
  }

  // How many of `rows` keep each spelling in their final text (the row summaries).
  function keptInFinal(rows, spellingsList, ctx) {
    const kept = new Array(spellingsList.length).fill(0);
    if (spellingsList.length === 0) return kept;
    const keep = createUsageMatcher(buildUsageIndex(spellingsList), {
      snippetExpansions: ctx.expansions,
    });
    for (const row of rows) {
      const found = keep(row);
      if (!found) continue;
      for (const index of found.written) kept[index] += 1;
    }
    return kept;
  }

  // One spelling's evidence (History's dictionary card asks for what speech
  // wrote in its dictation, which may not be among the top spellings).
  function requestedVariant(owner, word, ctx, computed, spelling) {
    const key = spellingKey(spelling);
    if (!key) return null;
    const listed = computed.variants.find((variant) => spellingKey(variant.spelling) === key);
    if (listed) return { ...listed, spelling };
    const rows = db.getDictionaryOccurrenceRows({
      owner,
      since: sqliteTime(ctx.at - days * DAY_MS),
    });
    const [kept] = keptInFinal(rows, [spelling], ctx);
    return { spelling, count: computed.counts.get(key) ?? 0, keptInFinal: kept };
  }

  /**
   * The top spellings speech wrote where the final text has the word
   * (`fix` appearances), with how many dictations each came from and in how
   * many the final text still has that spelling. `options.spelling`: that
   * spelling's own numbers too, as `requested`.
   */
  async function getSpeechVariants(word, options = {}) {
    const requested =
      typeof options?.spelling === "string" &&
      options.spelling.trim() &&
      options.spelling.length <= MAX_SPELLING_CHARS
        ? options.spelling
        : null;
    for (let attempt = 0; ; attempt += 1) {
      const { owner, reason } = readableOwner();
      if (!owner) return { available: false, reason };
      const ctx = context(owner, word);
      const cached = variantsCache.get(ctx.shape);
      let computed;
      if (fresh(cached, ctx)) computed = cached.computed;
      else {
        computed = computeVariants(owner, word, ctx);
        remember(variantsCache, ctx.shape, { computed, revision: ctx.revision, at: ctx.at });
      }
      const extra = requested ? requestedVariant(owner, word, ctx, computed, requested) : null;
      const after = readableOwner();
      if (after.owner !== owner) {
        return { available: false, reason: after.reason ?? "owner-changed" };
      }
      const revision = db.getHistoryContentRevision?.() ?? null;
      if (revision === ctx.revision || attempt >= 1) {
        if (revision !== ctx.revision) return { available: false, reason: "changed" };
        return {
          available: true,
          generation: ctx.generation,
          variants: computed.variants,
          ...(requested ? { requested: extra } : {}),
        };
      }
    }
  }

  return {
    getOccurrences,
    getSpeechVariants,
    /** History's policy or owner changed: nothing cached survives. */
    invalidate() {
      cache.clear();
      variantsCache.clear();
    },
  };
}
