// The one builder for the speech-to-text hint list: the request, the
// dictionary-echo check and the Dictionary page all read its output, so what
// the page says was sent is exactly what was sent.
//
// Priority within the provider's request budget, highest first:
//   1. pinned dictionary words (the user's "always send first"), in the
//      order the user gave them (main's pin positions),
//   2. manual dictionary entries (typed by the user),
//   3. the glossary's canonical forms (never its "heard as" spellings),
//   4. snippet triggers (included as before, so a spoken trigger survives),
//   5. auto-learned dictionary entries.
// The tiers never change places. Within the manual and auto-learned tiers,
// evidence order (dictionaryHintOrder.ts, the default) puts the words speech
// misses most first: missed rows, then rows that used the word, then stored
// order, words with no evidence last in stored order. "added", or no scores,
// keeps stored order.
//
// Whisper-family decoders (whisper-1, Groq's whisper-large-v3, whisper.cpp)
// read only the last ~223 tokens of a prompt, so for them ("tail" order) the
// highest priority is emitted LAST: the tiers are reversed, and so are the
// entries of each ranked tier (the pins, and the manual and learned tiers
// when evidence order applies), so the top pin ends the prompt. Unranked
// tiers keep today's emission. Keyword channels, Azure Speech's phrase list
// (199 entries at most) and the gpt-4o transcribe models read the whole
// list but caps keep its head, so they get "head" order. Either way the
// budget picks highest priority first, and `entries` stay in priority order.
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
  dictionaryReachesTranscriptionModel,
} from "./dictionaryPromptCap.js";
import { usesTranscriptionKeywords } from "./dictionaryKeywords.js";
import { dictionaryWordKey } from "./dictionaryWordKey.js";
import {
  compareHintScores,
  hasHintEvidence,
  type DictionaryHintOrder,
  type HintScore,
} from "./dictionaryHintOrder.ts";
import {
  AZURE_SPEECH_MAX_PHRASES,
  AZURE_SPEECH_PROVIDER_ID,
} from "../helpers/azureSpeechTranscription.js";
import type { Snippet } from "./snippets";

export type HintSource = "pinned" | "manual" | "glossary" | "snippet" | "learned";
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
  /** Whether evidence order ranked the typed and auto-learned tiers (else stored order). */
  evidence: boolean;
  maxChars: number;
  readChars: number;
}

export interface HintTarget {
  /**
   * How the request carries the hints: a prompt, keywords, a phrase list
   * (Azure Speech's `phraseList`, a bias the model never continues, so no
   * dictionary-echo check), or "none" when it sends no hints at all.
   */
  channel: "prompt" | "keywords" | "phrases" | "none";
  order: HintOrder;
  /** Request budget for the joined list. */
  maxChars: number;
  /** How much of the emitted list the model is estimated to read. */
  readChars: number;
  /** A cap on the number of terms, where the request counts entries rather than characters. */
  maxTerms?: number;
}

export const HINT_SEPARATOR = ", ";
const PRIORITY: HintSource[] = ["pinned", "manual", "glossary", "snippet", "learned"];
// The tiers evidence order ranks; the glossary's and the snippets' keep their own order.
const EVIDENCE_TIERS: HintSource[] = ["manual", "learned"];

export interface BuildDictionaryHintsOptions {
  /** Stored dictionary words, in stored order. */
  dictionary?: readonly string[] | null;
  /** Lowercased words whose source is "learned"; any other word counts as manual. */
  learnedWords?: Iterable<string> | null;
  /**
   * Pinned words' keys (dictionaryWordKey) in pin order, the first sent
   * first; a pinned word leads, whatever its source. A key without a word in
   * the dictionary is skipped.
   */
  pinnedWords?: Iterable<string> | null;
  /** Canonical forms of the active glossary rules. */
  glossaryTerms?: readonly string[] | null;
  snippets?: readonly Snippet[] | null;
  includeSnippets?: boolean;
  maxChars?: number;
  /** At most this many terms, chosen by priority like the character budget. */
  maxTerms?: number;
  /** Where the model reads the list: "tail" emits the highest priority last. */
  order?: HintOrder;
  readChars?: number;
  /** The order of the typed and auto-learned tiers (`dictionaryHintOrder`). */
  rankBy?: DictionaryHintOrder;
  /** Usage scores keyed by dictionaryWordKey; evidence order needs some evidence among them. */
  scores?: ReadonlyMap<string, HintScore> | null;
}

function anyEvidence(scores: ReadonlyMap<string, HintScore> | null | undefined): boolean {
  if (!scores || typeof scores.values !== "function") return false;
  for (const score of scores.values()) if (hasHintEvidence(score)) return true;
  return false;
}

export function buildDictionaryHints({
  dictionary,
  learnedWords,
  pinnedWords,
  glossaryTerms,
  snippets,
  includeSnippets = true,
  maxChars = Infinity,
  maxTerms = Infinity,
  order = "tail",
  readChars = WHISPER_DECODER_PROMPT_CHARS,
  rankBy = "evidence",
  scores = null,
}: BuildDictionaryHintsOptions = {}): DictionaryHintPlan {
  const learned = new Set<string>();
  for (const word of learnedWords ?? []) {
    if (typeof word === "string") learned.add(word.trim().toLowerCase());
  }
  const pinOrder: string[] = [];
  const pinned = new Set<string>();
  for (const word of pinnedWords ?? []) {
    const key = dictionaryWordKey(word);
    if (key && !pinned.has(key)) {
      pinned.add(key);
      pinOrder.push(key);
    }
  }
  const tiers: Record<HintSource, string[]> = {
    pinned: [],
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
  if (pinned.size > 0) {
    // Each pin's word (two stored spellings of one key both go), in pin order.
    const byKey = new Map<string, string[]>();
    for (const word of words) {
      if (typeof word !== "string") continue;
      const key = dictionaryWordKey(word);
      if (!pinned.has(key)) continue;
      const spellings = byKey.get(key);
      if (spellings) spellings.push(word);
      else byKey.set(key, [word]);
    }
    for (const key of pinOrder) for (const word of byKey.get(key) ?? []) add("pinned", word);
  }
  for (const word of words) {
    if (typeof word === "string" && !learned.has(word.trim().toLowerCase())) add("manual", word);
  }
  for (const term of glossaryTerms ?? []) add("glossary", term);
  if (includeSnippets) for (const snippet of snippets ?? []) add("snippet", snippet?.trigger);
  for (const word of words) add("learned", word);

  // Evidence order: within the typed and learned tiers, the words speech
  // misses most first; ties and words without evidence keep stored order.
  const evidence = rankBy !== "added" && anyEvidence(scores);
  if (evidence) {
    for (const source of EVIDENCE_TIERS) {
      tiers[source] = tiers[source]
        .map((term, index) => ({ term, index, score: scores?.get(dictionaryWordKey(term)) }))
        .sort((a, b) => compareHintScores(a.score, b.score) || a.index - b.index)
        .map((ranked) => ranked.term);
    }
  }
  // A ranked tier's best entry is its first; a tail prompt emits it last.
  const ranked: Record<HintSource, boolean> = {
    pinned: true,
    manual: evidence,
    glossary: false,
    snippet: false,
    learned: evidence,
  };

  const budget = Number.isFinite(maxChars) ? Math.max(0, maxChars) : Infinity;
  const termLimit = Number.isFinite(maxTerms) ? Math.max(0, Math.floor(maxTerms)) : Infinity;
  const selected = new Set<string>();
  let used = 0;
  let truncated = false;
  for (const source of PRIORITY) {
    for (const term of tiers[source]) {
      const cost = term.length + (selected.size > 0 ? HINT_SEPARATOR.length : 0);
      if (selected.size < termLimit && used + cost <= budget) {
        selected.add(term);
        used += cost;
      } else {
        truncated = true;
      }
    }
  }

  const tail = order === "tail";
  const emission = tail ? [...PRIORITY].reverse() : PRIORITY;
  const terms = emission.flatMap((source) => {
    const sent = tiers[source].filter((t) => selected.has(t));
    return tail && ranked[source] ? sent.reverse() : sent;
  });
  const prompt = terms.length > 0 ? terms.join(HINT_SEPARATOR) : null;

  const offsets = new Map<string, number>();
  let position = 0;
  for (const term of terms) {
    offsets.set(term, position);
    position += term.length + HINT_SEPARATOR.length;
  }
  const readStart =
    tail && Number.isFinite(readChars) ? Math.max(0, (prompt?.length ?? 0) - readChars) : 0;
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

  return { prompt, terms, entries, truncated, order, evidence, maxChars: budget, readChars };
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
  // OpenRouter's speech-to-text endpoint drops `prompt`, so nothing is sent there
  // (its tab or a Custom endpoint on its host; dictionaryReachesTranscriptionModel).
  if (!dictionaryReachesTranscriptionModel(endpoint)) {
    return { channel: "none", order: "head", maxChars: 0, readChars: 0 };
  }
  // Azure Speech's phrase list counts entries (at most 199), not characters.
  if (provider === AZURE_SPEECH_PROVIDER_ID) {
    return {
      channel: "phrases",
      order: "head",
      maxChars: Infinity,
      readChars: Infinity,
      maxTerms: AZURE_SPEECH_MAX_PHRASES,
    };
  }
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
