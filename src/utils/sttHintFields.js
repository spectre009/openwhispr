// The speech-to-text hints a request carries, per route, built from the same
// primitives live dictation uses (audioManager.js): the one hint-list builder
// (buildDictionaryHints + resolveHintTarget), the provider budgets
// (dictionaryPromptLimit, trimDictionaryPrompt with the Chinese script bias
// reserved), gpt-transcribe's keywords and their overflow. History's
// Re-transcribe builds its request with it in main; parity tests compare the
// requests it produces with live dictation's, provider by provider. Pure ESM:
// main loads it with import(), the renderer can import it too.
//
// It returns hint concepts; each caller maps them to its own wire fields:
// - prompt:      OpenAI-compatible `prompt`, Tinfoil and managed Azure
//                `prompt`, OpenWhispr Cloud `prompt`, local Whisper's
//                `initialPrompt` (script bias included);
// - keywords:    gpt-transcribe's repeated `keywords[]`;
// - phrases:     Azure Speech's `definition.phraseList` (≤ 199, head order);
// - contextBias: Mistral's repeated `context_bias` (the biased prompt's first
//                100 whitespace words);
// - keyterms:    Gemini's `keyterms`, xAI's repeated `keyterm` (≤ 100 of ≤ 50
//                characters, no snippet triggers);
// - echo:        what the dictionary-echo check measures a reply against
//                (`{ prompt, dictionaryPrompt }`), or null when the route has
//                no echo check (Azure Speech, Corti, local sherpa, nothing sent).
// And what the Dictionary page shows, read off those same fields:
// - entries:     every term in priority order (`rank` 1 first) with its
//                coverage: "notSent" unless the fields above carry all of it,
//                "unread" for a sent term outside a Whisper prompt's tail
//                window (WHISPER_DECODER_PROMPT_CHARS, an estimate), else "read";
// - budget:      what the route counts against its limit (characters,
//                keywords, phrases, words or terms), or `unit: null` when it
//                carries no hints;
// - ranking:     how the unpinned words were ordered (`order`, whether
//                evidence order applied, how many scores came): counts only.
// Pinned words go in pin order, and a tail-ordered prompt ends with the top
// pin (dictionaryHints.ts); the entries' ranks stay highest priority first.
// The words are the user's dictionary: never log them, only counts (`counts`).

import { HINT_SEPARATOR, buildDictionaryHints, resolveHintTarget } from "./dictionaryHints.ts";
import {
  MAX_HINT_SCORES,
  normalizeDictionaryHintOrder,
  normalizeHintScores,
} from "./dictionaryHintOrder.ts";
import {
  WHISPER_DECODER_PROMPT_CHARS,
  dictionaryPromptLimit,
  trimDictionaryPrompt,
} from "./dictionaryPromptCap.js";
import {
  MAX_TRANSCRIPTION_KEYWORDS,
  dictionaryKeywordOverflow,
  dictionaryKeywords,
  dictionaryTerms,
  usesTranscriptionKeywords,
} from "./dictionaryKeywords.js";
import { mergeWhisperPrompt, resolveChineseScriptTarget } from "./chineseScript.js";
import { matchesDictionaryPrompt } from "./dictionaryEchoFilter.js";
import {
  AZURE_SPEECH_MAX_PHRASES,
  AZURE_SPEECH_PROVIDER_ID,
} from "../helpers/azureSpeechTranscription.js";

export const STT_HINT_ROUTES = Object.freeze([
  "openai-compatible",
  "azure-speech",
  "mistral",
  "gemini",
  "xai",
  "tinfoil",
  "managed",
  "cloud",
  "local-whisper",
  "none",
]);

// Mistral's contextBias and the keyterm channels' caps (audioManager's
// PROXY_TRANSCRIPTION_PROVIDERS and its proxied call site).
export const CONTEXT_BIAS_MAX_WORDS = 100;
export const KEYTERM_MAX = 100;
const KEYTERM_MAX_CHARS = 50;
// Bounds on what a retry may pass across IPC.
const MAX_WORDS = 10_000;
const MAX_WORD_CHARS = 500;

const stringList = (value, max = MAX_WORDS) =>
  (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, max)
    .map((item) => item.slice(0, MAX_WORD_CHARS));

/**
 * The dictionary a request is built from, validated: stored words in stored
 * order, learned words (lowercased), pinned keys in pin order, the glossary's
 * canonical forms, snippets (their triggers), the Chinese script preference,
 * the effective speech language (a translation recording's source language),
 * the order of the unpinned words (`hintOrder`, evidence unless "added") and
 * their usage scores (`scores`, `[[key, missedRows, written], …]`: at most as
 * many as the words and 2,000, keys of ≤ 100 characters, integers 0 to
 * 1,000,000; anything else dropped). A window that sends no scores gets
 * stored order.
 */
export function normalizeHintDictionary(input) {
  const source = input && typeof input === "object" ? input : {};
  const words = stringList(source.words);
  return {
    words,
    learned: stringList(source.learned).map((word) => word.trim().toLowerCase()),
    pinned: stringList(source.pinned),
    glossaryTerms: stringList(source.glossaryTerms),
    snippets: (Array.isArray(source.snippets) ? source.snippets : [])
      .slice(0, MAX_WORDS)
      .map((snippet) => ({
        trigger:
          typeof snippet?.trigger === "string" ? snippet.trigger.slice(0, MAX_WORD_CHARS) : "",
      }))
      .filter((snippet) => snippet.trigger.trim()),
    chineseScriptPreference:
      typeof source.chineseScriptPreference === "string" ? source.chineseScriptPreference : null,
    speechLanguage:
      typeof source.speechLanguage === "string" && source.speechLanguage
        ? source.speechLanguage
        : "auto",
    hintOrder: normalizeDictionaryHintOrder(source.hintOrder),
    scores: normalizeHintScores(source.scores, Math.min(words.length, MAX_HINT_SCORES)),
  };
}

function plan(dictionary, options) {
  return buildDictionaryHints({
    dictionary: dictionary.words,
    learnedWords: dictionary.learned,
    pinnedWords: dictionary.pinned,
    glossaryTerms: dictionary.glossaryTerms,
    snippets: dictionary.snippets,
    rankBy: dictionary.hintOrder,
    scores: dictionary.scores,
    ...options,
  });
}

// No transcript exists yet: only an explicit zh-CN / zh-TW biases the prompt.
function scriptTarget(dictionary) {
  return resolveChineseScriptTarget(dictionary.speechLanguage, dictionary.chineseScriptPreference);
}

function withScriptBias(dictionary, dictionaryPrompt) {
  return mergeWhisperPrompt(dictionaryPrompt, scriptTarget(dictionary));
}

// The bias leads the prompt; a budgeted request leaves room for it first.
function scriptBiasReserve(dictionary) {
  const bias = withScriptBias(dictionary, null);
  return bias ? bias.length + 1 : 0;
}

// ── Coverage: what the fields above carry, per term ─────────────────────────

const entry = (hint, rank, coverage) => ({
  term: hint.term,
  source: hint.source,
  rank,
  coverage,
});

// Where each piece sits in a prompt that ends with the pieces joined by ", "
// (after the script bias, when there is one).
function pieceSpans(pieces, prompt) {
  const joined = pieces.join(HINT_SEPARATOR);
  let offset = typeof prompt === "string" ? prompt.length - joined.length : 0;
  return pieces.map((piece) => {
    const span = { start: offset, end: offset + piece.length };
    offset = span.end + HINT_SEPARATOR.length;
    return span;
  });
}

// A prompt route: `full` is the prompt before any cut, `sent` what the
// request carries (a prefix of it, cut at a comma), or null. A term is sent
// when `sent` still holds all of it, and read when it starts inside the last
// `readChars` of it.
function promptCoverage(hints, { full, sent, readChars }) {
  const spans = new Map();
  pieceSpans(hints.terms, full).forEach((span, i) => spans.set(hints.terms[i], span));
  const sentLength = typeof sent === "string" ? sent.length : 0;
  const readFrom = Number.isFinite(readChars) ? Math.max(0, sentLength - readChars) : 0;
  return hints.entries.map((hint, i) => {
    const span = spans.get(hint.term);
    if (!span || sentLength === 0 || span.end > sentLength) return entry(hint, i + 1, "notSent");
    return entry(hint, i + 1, span.start >= readFrom ? "read" : "unread");
  });
}

// gpt-transcribe: the emitted terms split into keywords as dictionaryKeywords
// does; the first 900 go as keywords[], the rest ride in the (biased, capped)
// prompt. A term is sent when each of its keywords is either.
function keywordCoverage(hints, { keywordCount, overflowFull, overflowSent }) {
  const piecesByTerm = hints.terms.map((term) => dictionaryTerms(term));
  const overflowPieces = piecesByTerm.flat().slice(keywordCount);
  const spans = pieceSpans(overflowPieces, overflowFull);
  const sentLength = typeof overflowSent === "string" ? overflowSent.length : 0;
  const sentTerms = new Set();
  let index = 0;
  hints.terms.forEach((term, t) => {
    const pieces = piecesByTerm[t];
    const all = pieces.every((_, p) => {
      const at = index + p;
      if (at < keywordCount) return true;
      const span = spans[at - keywordCount];
      return !!span && sentLength > 0 && span.end <= sentLength;
    });
    if (pieces.length > 0 && all) sentTerms.add(term);
    index += pieces.length;
  });
  return hints.entries.map((hint, i) =>
    entry(hint, i + 1, sentTerms.has(hint.term) ? "read" : "notSent")
  );
}

// Mistral: the biased prompt split at commas, then whitespace; the first
// `maxWords` go. A term is sent when all its words are among them.
function wordCapCoverage(hints, { biasWords, maxWords }) {
  const sentTerms = new Set();
  let used = biasWords;
  for (const term of hints.terms) {
    const words = term
      .split(",")
      .flatMap((part) => part.trim().split(/\s+/))
      .filter(Boolean);
    used += words.length;
    if (words.length > 0 && used <= maxWords) sentTerms.add(term);
  }
  return hints.entries.map((hint, i) =>
    entry(hint, i + 1, sentTerms.has(hint.term) ? "read" : "notSent")
  );
}

// A list channel (phrases, keyterms): the first `count` emitted terms go.
function listCoverage(hints, count) {
  const sentTerms = new Set(hints.terms.slice(0, count));
  return hints.entries.map((hint, i) =>
    entry(hint, i + 1, sentTerms.has(hint.term) ? "read" : "notSent")
  );
}

function noneCoverage(hints) {
  return hints.entries.map((hint, i) => entry(hint, i + 1, "notSent"));
}

const NO_BUDGET = Object.freeze({ unit: null, used: 0, limit: null, readChars: null });

function emptyFields(route, dictionary) {
  return {
    route,
    prompt: null,
    keywords: [],
    phrases: [],
    contextBias: [],
    keyterms: [],
    dictionaryPrompt: null,
    echo: null,
    entries: [],
    budget: NO_BUDGET,
    counts: { terms: 0, notSent: 0 },
    ranking: {
      order: dictionary.hintOrder,
      evidence: dictionary.hintOrder === "evidence" && dictionary.scores.size > 0,
      scores: dictionary.scores.size,
    },
  };
}

function finish(fields, entries, budget) {
  const notSent = entries.filter((e) => e.coverage === "notSent").length;
  return {
    ...fields,
    entries,
    budget,
    counts: { terms: entries.length - notSent, notSent },
  };
}

/**
 * The hints one request sends. `route` is one of STT_HINT_ROUTES; the
 * OpenAI-compatible route also takes `provider` (the selected transcription
 * provider, "openai" by default), `endpoint` and `model`, as live dictation
 * passes them to dictionaryPromptLimit and resolveHintTarget.
 */
export function buildSttHintFields(
  { route, provider = "openai", endpoint = "", model = "" } = {},
  dictionaryInput
) {
  const dictionary = normalizeHintDictionary(dictionaryInput);
  const kind = STT_HINT_ROUTES.includes(route) ? route : "none";
  const fields = emptyFields(kind, dictionary);

  if (kind === "openai-compatible") {
    const modelName = typeof model === "string" ? model : "";
    const providerId = provider || "openai";
    const endpointUrl = typeof endpoint === "string" ? endpoint : "";
    const maxChars = dictionaryPromptLimit({
      provider: providerId,
      endpoint: endpointUrl,
      model: modelName,
    });
    const target = resolveHintTarget({
      engine: "byok",
      provider: providerId,
      endpoint: endpointUrl,
      model: modelName,
    });
    const usesKeywords = usesTranscriptionKeywords(modelName);
    const hints = plan(dictionary, {
      maxChars: usesKeywords ? Infinity : maxChars - scriptBiasReserve(dictionary),
      order: target.order,
    });
    const dictionaryPrompt = hints.prompt;
    const full = withScriptBias(
      dictionary,
      usesKeywords ? dictionaryKeywordOverflow(dictionaryPrompt) : dictionaryPrompt
    );
    const trimmed = trimDictionaryPrompt(full, maxChars);
    // Orukeet takes no prompt.
    const orukeet = modelName === "orukeet-v0.1.0";
    const promptSent = Boolean(trimmed.prompt && !orukeet);
    const keywords = usesKeywords ? dictionaryKeywords(dictionaryPrompt) : [];
    const sentPrompt = promptSent ? trimmed.prompt : null;
    const readChars = target.order === "tail" ? WHISPER_DECODER_PROMPT_CHARS : Infinity;
    return finish(
      {
        ...fields,
        prompt: sentPrompt,
        keywords,
        dictionaryPrompt,
        echo: {
          prompt: sentPrompt,
          dictionaryPrompt: usesKeywords || promptSent ? dictionaryPrompt : null,
        },
      },
      usesKeywords
        ? keywordCoverage(hints, {
            keywordCount: keywords.length,
            overflowFull: full,
            overflowSent: sentPrompt,
          })
        : promptCoverage(hints, { full, sent: sentPrompt, readChars }),
      usesKeywords
        ? {
            unit: "keywords",
            used: keywords.length,
            limit: MAX_TRANSCRIPTION_KEYWORDS,
            readChars: null,
          }
        : orukeet
          ? NO_BUDGET
          : {
              unit: "chars",
              used: sentPrompt ? sentPrompt.length : 0,
              limit: maxChars,
              readChars: Number.isFinite(readChars) ? readChars : null,
            }
    );
  }

  if (kind === "azure-speech") {
    const target = resolveHintTarget({ engine: "byok", provider: AZURE_SPEECH_PROVIDER_ID });
    const hints = plan(dictionary, {
      maxChars: target.maxChars,
      maxTerms: target.maxTerms,
      order: target.order,
    });
    // A phrase list is a bias, not a prompt the model continues: no echo check.
    return finish({ ...fields, phrases: hints.terms }, listCoverage(hints, hints.terms.length), {
      unit: "phrases",
      used: hints.terms.length,
      limit: AZURE_SPEECH_MAX_PHRASES,
      readChars: null,
    });
  }

  if (kind === "mistral") {
    const hints = plan(dictionary, { order: "head" });
    const biased = withScriptBias(dictionary, hints.prompt) || "";
    const contextBias = biased
      .split(",")
      .flatMap((entry) => entry.trim().split(/\s+/))
      .filter(Boolean)
      .slice(0, CONTEXT_BIAS_MAX_WORDS);
    const bias = withScriptBias(dictionary, null) || "";
    return finish(
      {
        ...fields,
        contextBias,
        dictionaryPrompt: hints.prompt,
        echo:
          contextBias.length > 0 ? { prompt: null, dictionaryPrompt: contextBias.join(" ") } : null,
      },
      wordCapCoverage(hints, {
        biasWords: bias.split(/\s+/).filter(Boolean).length,
        maxWords: CONTEXT_BIAS_MAX_WORDS,
      }),
      { unit: "words", used: contextBias.length, limit: CONTEXT_BIAS_MAX_WORDS, readChars: null }
    );
  }

  if (kind === "gemini" || kind === "xai") {
    const hints = plan(dictionary, { order: "head", includeSnippets: false });
    const keyterms = hints.terms
      .map((term) => term.trim().slice(0, KEYTERM_MAX_CHARS))
      .filter(Boolean)
      .slice(0, KEYTERM_MAX);
    return finish(
      {
        ...fields,
        keyterms,
        dictionaryPrompt: hints.prompt,
        echo: keyterms.length > 0 ? { prompt: null, dictionaryPrompt: keyterms.join(", ") } : null,
      },
      listCoverage(hints, keyterms.length),
      { unit: "terms", used: keyterms.length, limit: KEYTERM_MAX, readChars: null }
    );
  }

  if (kind === "tinfoil" || kind === "managed") {
    // Unbudgeted, in Whisper's tail order, with the script bias.
    const hints = plan(dictionary, { order: "tail" });
    const prompt = withScriptBias(dictionary, hints.prompt);
    const sends = typeof prompt === "string" && prompt.trim().length > 0;
    return finish(
      {
        ...fields,
        prompt: sends ? prompt : null,
        dictionaryPrompt: hints.prompt,
        echo: sends ? { prompt, dictionaryPrompt: hints.prompt } : null,
      },
      promptCoverage(hints, {
        full: prompt,
        sent: sends ? prompt : null,
        readChars: WHISPER_DECODER_PROMPT_CHARS,
      }),
      {
        unit: "chars",
        used: sends ? prompt.length : 0,
        limit: null,
        readChars: WHISPER_DECODER_PROMPT_CHARS,
      }
    );
  }

  if (kind === "cloud") {
    // Cloud picks its model server-side: the tightest cap a Whisper backend applies.
    const target = resolveHintTarget({ engine: "cloud" });
    const hints = plan(dictionary, {
      maxChars: target.maxChars - scriptBiasReserve(dictionary),
      order: target.order,
    });
    const prompt = withScriptBias(dictionary, hints.prompt);
    return finish(
      {
        ...fields,
        prompt: prompt || null,
        dictionaryPrompt: hints.prompt,
        echo: { prompt: prompt || null, dictionaryPrompt: hints.prompt },
      },
      promptCoverage(hints, { full: prompt, sent: prompt || null, readChars: target.readChars }),
      {
        unit: "chars",
        used: prompt ? prompt.length : 0,
        limit: target.maxChars,
        readChars: target.readChars,
      }
    );
  }

  if (kind === "local-whisper") {
    const hints = plan(dictionary, { order: "tail" });
    const prompt = withScriptBias(dictionary, hints.prompt);
    // Whisper's echo recovery runs on these (localWhisperEchoRecovery.js).
    return finish(
      {
        ...fields,
        prompt: prompt || null,
        dictionaryPrompt: hints.prompt,
        echo: prompt ? { prompt, dictionaryPrompt: hints.prompt } : null,
      },
      promptCoverage(hints, {
        full: prompt,
        sent: prompt || null,
        readChars: WHISPER_DECODER_PROMPT_CHARS,
      }),
      {
        unit: "chars",
        used: prompt ? prompt.length : 0,
        limit: null,
        readChars: WHISPER_DECODER_PROMPT_CHARS,
      }
    );
  }

  // Nothing is sent: every term in priority order, none of it sent.
  return finish(fields, noneCoverage(plan(dictionary, {})), NO_BUDGET);
}

/** The dictionary-echo check (audioManager.isDictionaryEcho) against what a request sent. */
export function isHintEcho(text, echo) {
  if (!echo) return false;
  return (
    matchesDictionaryPrompt(text, echo.dictionaryPrompt) ||
    matchesDictionaryPrompt(text, echo.prompt)
  );
}
