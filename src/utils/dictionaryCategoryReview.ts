// The Dictionary's "Sort into categories" › Ask a model, as data: the request
// (the dictionary's words, each with its current category and who set it;
// nothing else), the token estimate shown before sending, the reply parsed
// leniently and validated strictly, and the revision that drops a stale
// reply. Pure; never logged.

import { dictionaryWordKey } from "./dictionaryWordKey.js";
import { extractReviewJson } from "./dictionaryReview";
import {
  isDictionaryCategory,
  type DictionaryCategory,
  type DictionaryCategorySource,
} from "./dictionaryCategories";
import { buildDictionaryCategoryReviewPrompt } from "../config/prompts/dictionaryCategoryReview";

/** The most proposals a reply may hold; more drops the whole reply. */
export const CATEGORY_REVIEW_MAX_PROPOSALS = 300;
/** A reply longer than this is dropped unread. */
export const CATEGORY_REVIEW_MAX_REPLY_CHARS = 200_000;
export const CATEGORY_REVIEW_MAX_REASON_CHARS = 200;

/** One word as the review sees it: its effective category (null: unsorted) and who set it. */
export interface CategoryReviewEntry {
  word: string;
  category: DictionaryCategory | null;
  source: DictionaryCategorySource;
}

export interface CategoryReviewRequest {
  systemPrompt: string;
  /** The user message: the entries, one per line. */
  text: string;
  /** The words sent, as stored: what a proposal may name. */
  words: string[];
  /** ≈ characters ÷ 4 of the system prompt and the message. */
  estimatedTokens: number;
}

export interface CategoryProposal {
  id: string;
  /** A dictionary word, as stored. */
  word: string;
  category: DictionaryCategory;
  /** One line, ≤ 200 characters (may be empty). */
  reason: string;
}

/** The words a review sends, and what goes with each: the category and who set it. Never more. */
export function buildDictionaryCategoryReviewRequest({
  entries,
  uiLanguage,
}: {
  entries: readonly CategoryReviewEntry[];
  uiLanguage?: string | null;
}): CategoryReviewRequest {
  const seen = new Set<string>();
  const list = entries.filter((entry) => {
    if (typeof entry?.word !== "string" || !dictionaryWordKey(entry.word)) return false;
    if (seen.has(entry.word)) return false;
    seen.add(entry.word);
    return true;
  });
  const lines = list.map((entry) =>
    JSON.stringify([
      entry.word,
      isDictionaryCategory(entry.category) ? entry.category : "unsorted",
      entry.source === "user" || entry.source === "model" ? entry.source : "auto",
    ])
  );
  const systemPrompt = buildDictionaryCategoryReviewPrompt({ uiLanguage });
  const text = ["Columns: word, category, set by", ...lines].join("\n");
  return {
    systemPrompt,
    text,
    words: list.map((entry) => entry.word),
    estimatedTokens: Math.ceil((systemPrompt.length + text.length) / 4),
  };
}

/**
 * The dictionary and its categories right now, as one comparable value: each
 * word with its effective category and who set it. A reply is dropped when it
 * changed while the model ran.
 */
export function dictionaryCategoryRevision(entries: readonly CategoryReviewEntry[]): string {
  return JSON.stringify(entries.map((entry) => [entry.word, entry.category ?? null, entry.source]));
}

export type CategoryReviewParseStatus = "ok" | "malformed" | "oversized";

export interface CategoryReviewParseResult {
  status: CategoryReviewParseStatus;
  proposals: CategoryProposal[];
  /** Proposals kept and dropped (unknown word or category, a bad reason, a word named again). */
  kept: number;
  dropped: number;
}

/**
 * The model's reply, validated strictly against the words sent: a word not
 * sent (matched exactly, or by key when only one sent word has it), a
 * category that isn't people, work or everyday, a reason that isn't one line
 * of at most 200 characters, or a word already named (the later one goes)
 * drops the proposal; more than 300 proposals, an oversized reply or no
 * `proposals` array drops it all.
 */
export function parseDictionaryCategoryReviewReply(
  reply: unknown,
  { words }: { words: readonly string[] }
): CategoryReviewParseResult {
  if (typeof reply === "string" && reply.length > CATEGORY_REVIEW_MAX_REPLY_CHARS) {
    return { status: "oversized", proposals: [], kept: 0, dropped: 0 };
  }
  const parsed = extractReviewJson(reply) as { proposals?: unknown } | undefined;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.proposals)) {
    return { status: "malformed", proposals: [], kept: 0, dropped: 0 };
  }
  const raw = parsed.proposals as unknown[];
  if (raw.length > CATEGORY_REVIEW_MAX_PROPOSALS) {
    return { status: "oversized", proposals: [], kept: 0, dropped: raw.length };
  }

  const exact = new Set(words);
  const byKey = new Map<string, string[]>();
  for (const word of words) {
    const key = dictionaryWordKey(word);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(word);
    else byKey.set(key, [word]);
  }
  const resolve = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    if (exact.has(value)) return value;
    const matches = byKey.get(dictionaryWordKey(value));
    return matches && matches.length === 1 ? matches[0] : null;
  };

  const named = new Set<string>();
  const proposals: CategoryProposal[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const word = resolve(candidate.word);
    if (!word || named.has(word)) continue;
    if (!isDictionaryCategory(candidate.category)) continue;
    const reason = candidate.reason === undefined ? "" : candidate.reason;
    if (typeof reason !== "string" || /[\r\n\u2028\u2029]/.test(reason)) continue;
    const trimmed = reason.trim();
    if (trimmed.length > CATEGORY_REVIEW_MAX_REASON_CHARS) continue;
    named.add(word);
    proposals.push({
      id: `category:${word}`,
      word,
      category: candidate.category,
      reason: trimmed,
    });
  }
  return {
    status: "ok",
    proposals,
    kept: proposals.length,
    dropped: raw.length - proposals.length,
  };
}
