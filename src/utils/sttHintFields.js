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
// The words are the user's dictionary: never log them, only counts (`counts`).

import { buildDictionaryHints, resolveHintTarget } from "./dictionaryHints.ts";
import { dictionaryPromptLimit, trimDictionaryPrompt } from "./dictionaryPromptCap.js";
import {
  dictionaryKeywordOverflow,
  dictionaryKeywords,
  usesTranscriptionKeywords,
} from "./dictionaryKeywords.js";
import { mergeWhisperPrompt, resolveChineseScriptTarget } from "./chineseScript.js";
import { matchesDictionaryPrompt } from "./dictionaryEchoFilter.js";
import { AZURE_SPEECH_PROVIDER_ID } from "../helpers/azureSpeechTranscription.js";

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
const CONTEXT_BIAS_MAX_WORDS = 100;
const KEYTERM_MAX = 100;
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
 * order, learned words (lowercased), pinned keys, the glossary's canonical
 * forms, snippets (their triggers), the Chinese script preference and the
 * effective speech language (a translation recording's source language).
 */
export function normalizeHintDictionary(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    words: stringList(source.words),
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
  };
}

function plan(dictionary, options) {
  return buildDictionaryHints({
    dictionary: dictionary.words,
    learnedWords: dictionary.learned,
    pinnedWords: dictionary.pinned,
    glossaryTerms: dictionary.glossaryTerms,
    snippets: dictionary.snippets,
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

function emptyFields(route) {
  return {
    route,
    prompt: null,
    keywords: [],
    phrases: [],
    contextBias: [],
    keyterms: [],
    dictionaryPrompt: null,
    echo: null,
    counts: { terms: 0, notSent: 0 },
  };
}

function counted(fields, hintPlan) {
  return {
    ...fields,
    counts: {
      terms: hintPlan.terms.length,
      notSent: hintPlan.entries.length - hintPlan.terms.length,
    },
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
  const fields = emptyFields(kind);

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
    const trimmed = trimDictionaryPrompt(
      withScriptBias(
        dictionary,
        usesKeywords ? dictionaryKeywordOverflow(dictionaryPrompt) : dictionaryPrompt
      ),
      maxChars
    );
    // Orukeet takes no prompt.
    const promptSent = Boolean(trimmed.prompt && modelName !== "orukeet-v0.1.0");
    return counted(
      {
        ...fields,
        prompt: promptSent ? trimmed.prompt : null,
        keywords: usesKeywords ? dictionaryKeywords(dictionaryPrompt) : [],
        dictionaryPrompt,
        echo: {
          prompt: promptSent ? trimmed.prompt : null,
          dictionaryPrompt: usesKeywords || promptSent ? dictionaryPrompt : null,
        },
      },
      hints
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
    return counted({ ...fields, phrases: hints.terms }, hints);
  }

  if (kind === "mistral") {
    const hints = plan(dictionary, { order: "head" });
    const biased = withScriptBias(dictionary, hints.prompt) || "";
    const contextBias = biased
      .split(",")
      .flatMap((entry) => entry.trim().split(/\s+/))
      .filter(Boolean)
      .slice(0, CONTEXT_BIAS_MAX_WORDS);
    return counted(
      {
        ...fields,
        contextBias,
        dictionaryPrompt: hints.prompt,
        echo:
          contextBias.length > 0 ? { prompt: null, dictionaryPrompt: contextBias.join(" ") } : null,
      },
      hints
    );
  }

  if (kind === "gemini" || kind === "xai") {
    const hints = plan(dictionary, { order: "head", includeSnippets: false });
    const keyterms = hints.terms
      .map((term) => term.trim().slice(0, KEYTERM_MAX_CHARS))
      .filter(Boolean)
      .slice(0, KEYTERM_MAX);
    return counted(
      {
        ...fields,
        keyterms,
        dictionaryPrompt: hints.prompt,
        echo: keyterms.length > 0 ? { prompt: null, dictionaryPrompt: keyterms.join(", ") } : null,
      },
      hints
    );
  }

  if (kind === "tinfoil" || kind === "managed") {
    // Unbudgeted, in Whisper's tail order, with the script bias.
    const hints = plan(dictionary, { order: "tail" });
    const prompt = withScriptBias(dictionary, hints.prompt);
    const sends = typeof prompt === "string" && prompt.trim().length > 0;
    return counted(
      {
        ...fields,
        prompt: sends ? prompt : null,
        dictionaryPrompt: hints.prompt,
        echo: sends ? { prompt, dictionaryPrompt: hints.prompt } : null,
      },
      hints
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
    return counted(
      {
        ...fields,
        prompt: prompt || null,
        dictionaryPrompt: hints.prompt,
        echo: { prompt: prompt || null, dictionaryPrompt: hints.prompt },
      },
      hints
    );
  }

  if (kind === "local-whisper") {
    const hints = plan(dictionary, { order: "tail" });
    const prompt = withScriptBias(dictionary, hints.prompt);
    // Whisper's echo recovery runs on these (localWhisperEchoRecovery.js).
    return counted(
      {
        ...fields,
        prompt: prompt || null,
        dictionaryPrompt: hints.prompt,
        echo: prompt ? { prompt, dictionaryPrompt: hints.prompt } : null,
      },
      hints
    );
  }

  return fields;
}

/** The dictionary-echo check (audioManager.isDictionaryEcho) against what a request sent. */
export function isHintEcho(text, echo) {
  if (!echo) return false;
  return (
    matchesDictionaryPrompt(text, echo.dictionaryPrompt) ||
    matchesDictionaryPrompt(text, echo.prompt)
  );
}
