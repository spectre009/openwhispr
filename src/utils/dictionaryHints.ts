// The one builder for the speech-to-text hint list: the request, the
// dictionary-echo check and the Dictionary page all read its output, so what
// the page says was sent is exactly what was sent.
//
// Priority within the provider's request budget, highest first:
//   1. manual dictionary entries (typed by the user),
//   2. the glossary's canonical forms (never its "heard as" spellings),
//   3. snippet triggers (included as before, so a spoken trigger survives),
//   4. auto-learned dictionary entries.
//
// Whisper-family decoders (whisper-1, Groq's whisper-large-v3, whisper.cpp)
// read only the last ~223 tokens of a prompt, so for them ("tail" order) the
// highest priority is emitted LAST. Keyword channels and the gpt-4o transcribe
// models read the whole list but caps keep its head, so they get "head" order.
// The emitted order never touches the stored dictionary: reordering by
// deleting and re-adding words would churn cloud sync.
//
// Coverage ("read", "unread", "notSent") is an estimate: the app has no
// Whisper tokenizer, so the decoder window is the chars-per-token heuristic in
// dictionaryPromptCap.js (WHISPER_DECODER_PROMPT_CHARS).

import {
  GROQ_PROMPT_CHARS,
  TRANSCRIBE_PROMPT_CHARS,
  WHISPER_DECODER_PROMPT_CHARS,
  dictionaryPromptLimit,
} from "./dictionaryPromptCap.js";
import { usesTranscriptionKeywords } from "./dictionaryKeywords.js";
import type { Snippet } from "./snippets";

export type HintSource = "manual" | "glossary" | "snippet" | "learned";
export type HintCoverage = "read" | "unread" | "notSent";
export type HintOrder = "tail" | "head";

export interface HintEntry {
  term: string;
  source: HintSource;
  coverage: HintCoverage;
}

export interface DictionaryHintPlan {
  /** The terms joined with ", " exactly as emitted (before any Chinese script bias). */
  prompt: string | null;
  /** The emitted terms, in emission order. */
  terms: string[];
  /** One entry per distinct term, in priority order. */
  entries: HintEntry[];
  /** Whether any term was left out to fit the budget. */
  truncated: boolean;
  order: HintOrder;
  maxChars: number;
  readChars: number;
}

export interface HintTarget {
  /** How the request carries the hints; "none" sends no hints at all. */
  channel: "prompt" | "keywords" | "none";
  order: HintOrder;
  /** Request budget for the joined list. */
  maxChars: number;
  /** How much of the emitted list the model is estimated to read. */
  readChars: number;
}

export const HINT_SEPARATOR = ", ";
const PRIORITY: HintSource[] = ["manual", "glossary", "snippet", "learned"];

export interface BuildDictionaryHintsOptions {
  /** Stored dictionary words, in stored order. */
  dictionary?: readonly string[] | null;
  /** Lowercased words whose source is "learned"; any other word counts as manual. */
  learnedWords?: Iterable<string> | null;
  /** Canonical forms of the active glossary rules. */
  glossaryTerms?: readonly string[] | null;
  snippets?: readonly Snippet[] | null;
  includeSnippets?: boolean;
  maxChars?: number;
  order?: HintOrder;
  readChars?: number;
}

export function buildDictionaryHints({
  dictionary,
  learnedWords,
  glossaryTerms,
  snippets,
  includeSnippets = true,
  maxChars = Infinity,
  order = "tail",
  readChars = WHISPER_DECODER_PROMPT_CHARS,
}: BuildDictionaryHintsOptions = {}): DictionaryHintPlan {
  const learned = new Set<string>();
  for (const word of learnedWords ?? []) {
    if (typeof word === "string") learned.add(word.trim().toLowerCase());
  }
  const tiers: Record<HintSource, string[]> = {
    manual: [],
    glossary: [],
    snippet: [],
    learned: [],
  };
  const seen = new Set<string>();
  const add = (source: HintSource, raw: unknown) => {
    if (typeof raw !== "string") return;
    const term = raw.trim();
    if (!term) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tiers[source].push(term);
  };
  const words = Array.isArray(dictionary) ? dictionary : [];
  for (const word of words) {
    if (typeof word === "string" && !learned.has(word.trim().toLowerCase())) add("manual", word);
  }
  for (const term of glossaryTerms ?? []) add("glossary", term);
  if (includeSnippets) for (const snippet of snippets ?? []) add("snippet", snippet?.trigger);
  for (const word of words) add("learned", word);

  const budget = Number.isFinite(maxChars) ? Math.max(0, maxChars) : Infinity;
  const selected = new Set<string>();
  let used = 0;
  let truncated = false;
  for (const source of PRIORITY) {
    for (const term of tiers[source]) {
      const cost = term.length + (selected.size > 0 ? HINT_SEPARATOR.length : 0);
      if (used + cost <= budget) {
        selected.add(term);
        used += cost;
      } else {
        truncated = true;
      }
    }
  }

  const emission = order === "tail" ? [...PRIORITY].reverse() : PRIORITY;
  const terms = emission.flatMap((source) => tiers[source].filter((t) => selected.has(t)));
  const prompt = terms.length > 0 ? terms.join(HINT_SEPARATOR) : null;

  const offsets = new Map<string, number>();
  let position = 0;
  for (const term of terms) {
    offsets.set(term, position);
    position += term.length + HINT_SEPARATOR.length;
  }
  const readStart =
    order === "tail" && Number.isFinite(readChars)
      ? Math.max(0, (prompt?.length ?? 0) - readChars)
      : 0;
  const entries: HintEntry[] = PRIORITY.flatMap((source) =>
    tiers[source].map((term) => ({
      term,
      source,
      coverage: !selected.has(term)
        ? "notSent"
        : (offsets.get(term) ?? 0) >= readStart
          ? "read"
          : "unread",
    }))
  );

  return { prompt, terms, entries, truncated, order, maxChars: budget, readChars };
}

/**
 * Where and how a dictation's hints travel, per transcription setup. The
 * request path passes its real endpoint; the Dictionary page passes what the
 * settings say, which is why the page calls its coverage an estimate.
 */
export function resolveHintTarget({
  engine,
  provider = "",
  endpoint = "",
  model = "",
}: {
  engine: "local-whisper" | "local-other" | "cloud" | "byok";
  provider?: string;
  endpoint?: string;
  model?: string;
}): HintTarget {
  const whisperTail = (maxChars: number): HintTarget => ({
    channel: "prompt",
    order: "tail",
    maxChars,
    readChars: WHISPER_DECODER_PROMPT_CHARS,
  });
  if (engine === "local-whisper") return whisperTail(Infinity);
  if (engine === "local-other") {
    return { channel: "none", order: "head", maxChars: 0, readChars: 0 };
  }
  // OpenWhispr Cloud picks its model server-side; Groq's request cap is the
  // tightest it may apply, so everything sent survives whatever it keeps.
  if (engine === "cloud") return whisperTail(GROQ_PROMPT_CHARS);
  if (usesTranscriptionKeywords(model)) {
    return { channel: "keywords", order: "head", maxChars: Infinity, readChars: Infinity };
  }
  if (typeof model === "string" && model.toLowerCase().startsWith("gpt-4o")) {
    return {
      channel: "prompt",
      order: "head",
      maxChars: TRANSCRIBE_PROMPT_CHARS,
      readChars: Infinity,
    };
  }
  return whisperTail(dictionaryPromptLimit({ provider, endpoint, model }));
}
