// Tidy up's "Ask a model", as data: the request (the dictionary's words with
// their source, pin and heard/written/missed counts; nothing else), the token
// estimate shown before sending, the reply parsed leniently and validated
// strictly, the dictionary revision that drops a stale reply, and the batch
// operations a suggestion applies. Pure; never logged.

import { dictionaryWordKey } from "./dictionaryWordKey.js";
import { buildDictionaryReviewPrompt } from "../config/prompts/dictionaryReview";
import type { DictionaryTidyOp } from "../types/electron";
import type { TidyWord } from "./dictionaryTidy";

/** The most suggestions a reply may hold; more drops the whole reply. */
export const REVIEW_MAX_SUGGESTIONS = 300;
/** A reply longer than this is dropped unread. */
export const REVIEW_MAX_REPLY_CHARS = 200_000;
export const REVIEW_MAX_INTO_CHARS = 100;
export const REVIEW_MAX_REASON_CHARS = 200;
export const REVIEW_MAX_WORDS_PER_SUGGESTION = 50;
/** The reply's output budget. */
export const REVIEW_MAX_TOKENS = 4096;

export type ReviewAction = "remove" | "respell" | "merge" | "keep";
const REVIEW_ACTIONS: ReadonlySet<string> = new Set(["remove", "respell", "merge", "keep"]);

export interface ReviewSuggestion {
  id: string;
  action: ReviewAction;
  /** Dictionary words, as stored. */
  words: string[];
  /** respell and merge: the spelling it becomes or keeps. */
  into?: string;
  reason: string;
}

export interface ReviewRequest {
  systemPrompt: string;
  /** The user message: the entries, one per line. */
  text: string;
  /** The words sent, as stored: what a suggestion may name. */
  words: string[];
  /** ≈ characters ÷ 4 of the system prompt and the message. */
  estimatedTokens: number;
}

/** The words a review sends, and what goes with each. Never more. */
export function buildDictionaryReviewRequest({
  words,
  usageAvailable,
  uiLanguage,
}: {
  words: readonly Pick<TidyWord, "word" | "source" | "pinned" | "usage">[];
  usageAvailable: boolean;
  uiLanguage?: string | null;
}): ReviewRequest {
  const seen = new Set<string>();
  const list = words.filter((entry) => {
    if (typeof entry?.word !== "string" || !dictionaryWordKey(entry.word)) return false;
    if (seen.has(entry.word)) return false;
    seen.add(entry.word);
    return true;
  });
  const hasCounts = usageAvailable;
  const header = hasCounts
    ? "Columns: word, source, pinned, heard, written, missed"
    : "Columns: word, source, pinned";
  const lines = list.map((entry) => {
    const row: Array<string | number> = [
      entry.word,
      entry.source === "learned" ? "auto" : "typed",
      entry.pinned ? 1 : 0,
    ];
    if (hasCounts) {
      row.push(entry.usage?.heard ?? 0, entry.usage?.written ?? 0, entry.usage?.missedRows ?? 0);
    }
    return JSON.stringify(row);
  });
  const systemPrompt = buildDictionaryReviewPrompt({ hasCounts, uiLanguage });
  const text = [header, ...lines].join("\n");
  return {
    systemPrompt,
    text,
    words: list.map((entry) => entry.word),
    estimatedTokens: estimateReviewTokens(systemPrompt, text),
  };
}

/** ≈ characters ÷ 4, as the Dictionary's other estimates. */
export function estimateReviewTokens(systemPrompt: string, text: string): number {
  return Math.ceil(((systemPrompt?.length ?? 0) + (text?.length ?? 0)) / 4);
}

/**
 * What the dictionary is right now, as one comparable value: each word with
 * its source and pin. A review's reply is dropped when it changed meanwhile.
 */
export function dictionaryRevision(
  words: readonly Pick<TidyWord, "word" | "source" | "pinned">[]
): string {
  return JSON.stringify(
    words.map((entry) => [entry.word, entry.source === "learned" ? 1 : 0, entry.pinned ? 1 : 0])
  );
}

/**
 * The reply's JSON object, read leniently: a code fence is stripped and the
 * first balanced {…} block is parsed. Undefined when there is none.
 */
export function extractReviewJson(reply: unknown): unknown {
  if (typeof reply !== "string") return undefined;
  let text = reply.trim();
  const fenced = text.match(/```[A-Za-z]*[ \t]*\r?\n?([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export type ReviewParseStatus = "ok" | "malformed" | "oversized";

export interface ReviewParseResult {
  status: ReviewParseStatus;
  suggestions: ReviewSuggestion[];
  /** Suggestions kept and dropped (invalid, unknown words, a word named twice). */
  kept: number;
  dropped: number;
}

/**
 * The model's reply, validated strictly against the words sent: an unknown
 * action, a word not sent, a word already named, an `into` that isn't one line
 * of 1–100 characters, a reason over 200 characters, or a change to a
 * protected spelling (a glossary spelling or snippet trigger) drops the
 * suggestion; more than 300 suggestions, or an oversized reply, drops all.
 */
export function parseDictionaryReviewReply(
  reply: unknown,
  { words, protectedKeys }: { words: readonly string[]; protectedKeys?: ReadonlySet<string> }
): ReviewParseResult {
  if (typeof reply === "string" && reply.length > REVIEW_MAX_REPLY_CHARS) {
    return { status: "oversized", suggestions: [], kept: 0, dropped: 0 };
  }
  const parsed = extractReviewJson(reply) as { suggestions?: unknown } | undefined;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.suggestions)) {
    return { status: "malformed", suggestions: [], kept: 0, dropped: 0 };
  }
  const raw = parsed.suggestions as unknown[];
  if (raw.length > REVIEW_MAX_SUGGESTIONS) {
    return { status: "oversized", suggestions: [], kept: 0, dropped: raw.length };
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
  // A word as sent, or by its key when exactly one sent word has it.
  const resolve = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    if (exact.has(value)) return value;
    const matches = byKey.get(dictionaryWordKey(value));
    return matches && matches.length === 1 ? matches[0] : null;
  };
  const guarded = protectedKeys ?? new Set<string>();
  const isProtected = (word: string) => guarded.has(dictionaryWordKey(word));
  const named = new Set<string>();
  const suggestions: ReviewSuggestion[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const action = candidate.action;
    if (typeof action !== "string" || !REVIEW_ACTIONS.has(action)) continue;
    if (!Array.isArray(candidate.words)) continue;
    if (candidate.words.length === 0 || candidate.words.length > REVIEW_MAX_WORDS_PER_SUGGESTION) {
      continue;
    }
    const resolved = candidate.words.map(resolve);
    if (resolved.some((word) => word === null)) continue;
    const list = [...new Set(resolved as string[])];
    if (list.some((word) => named.has(word))) continue;
    if (typeof candidate.reason !== "string") continue;
    const reason = candidate.reason.replace(/\s+/g, " ").trim();
    if (reason.length > REVIEW_MAX_REASON_CHARS) continue;

    let into: string | undefined;
    if (action === "respell" || action === "merge") {
      if (candidate.into !== undefined) {
        if (typeof candidate.into !== "string" || /[\r\n]/.test(candidate.into)) continue;
        const trimmed = candidate.into.trim();
        if (trimmed.length < 1 || trimmed.length > REVIEW_MAX_INTO_CHARS) continue;
        into = trimmed;
      }
    }
    if (action === "respell") {
      if (list.length !== 1 || !into || into === list[0]) continue;
      if (isProtected(list[0])) continue;
    } else if (action === "merge") {
      if (list.length < 2) continue;
      const kept = into ?? list[0];
      into = kept;
      // Every word but the one kept leaves (a new spelling renames the first).
      if (list.some((word) => word !== kept && isProtected(word))) continue;
    } else if (action === "remove") {
      if (list.some(isProtected)) continue;
    }

    list.forEach((word) => named.add(word));
    suggestions.push({
      id: `model:${action}:${list.join("\n")}`,
      action: action as ReviewAction,
      words: list,
      ...(into !== undefined ? { into } : {}),
      reason,
    });
  }

  return {
    status: "ok",
    suggestions,
    kept: suggestions.length,
    dropped: raw.length - suggestions.length,
  };
}

/**
 * The batch operations a suggestion applies, against the dictionary now
 * (`liveWords`): remove; a respell; a merge into a spelling among its words,
 * into a dictionary word with that spelling, or, for a new spelling, the
 * first word respelled and the others merged into it. "keep" applies nothing.
 */
export function reviewSuggestionOps(
  suggestion: ReviewSuggestion,
  liveWords: readonly string[]
): DictionaryTidyOp[] {
  switch (suggestion.action) {
    case "remove":
      return [{ kind: "remove", words: [...suggestion.words] }];
    case "respell":
      return suggestion.into
        ? [{ kind: "respell", from: suggestion.words[0], to: suggestion.into }]
        : [];
    case "merge": {
      const into = suggestion.into ?? suggestion.words[0];
      if (suggestion.words.includes(into)) {
        return suggestion.words
          .filter((word) => word !== into)
          .map((word) => ({ kind: "merge" as const, from: word, into }));
      }
      const key = dictionaryWordKey(into);
      const target =
        liveWords.find((word) => word === into) ??
        liveWords.find((word) => dictionaryWordKey(word) === key);
      if (target && !suggestion.words.includes(target)) {
        return suggestion.words.map((word) => ({
          kind: "merge" as const,
          from: word,
          into: target,
        }));
      }
      const [first, ...rest] = suggestion.words;
      return [
        { kind: "respell", from: first, to: into },
        ...rest.map((word) => ({ kind: "merge" as const, from: word, into })),
      ];
    }
    default:
      return [];
  }
}
