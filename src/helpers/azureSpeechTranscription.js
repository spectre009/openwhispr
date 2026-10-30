// Azure Speech "fast transcription" with MAI-Transcribe-2: the endpoint, the
// request's `definition`, the language map and the answer. ESM like
// providerHttpErrors.js: the dictation window, the route resolver and main
// (History's Re-transcribe, uploads, and the request module's endpoint check
// before it sends the key, via require(esm)) all read it. Pure: no electron,
// no logger, no store.
//
// POST {resource}/speechtotext/transcriptions:transcribe?api-version=2025-10-15
// with `Ocp-Apim-Subscription-Key`, multipart parts `audio` (WAV, MP3 or FLAC
// only) and `definition` (JSON). The text is `combinedPhrases[].text`.

export const AZURE_SPEECH_PROVIDER_ID = "azure-speech";
export const AZURE_SPEECH_NAME = "Azure Speech";
export const AZURE_SPEECH_DEFAULT_MODEL = "MAI-Transcribe-2";
export const AZURE_SPEECH_API_VERSION = "2025-10-15";
export const AZURE_SPEECH_TRANSCRIBE_PATH = "/speechtotext/transcriptions:transcribe";
export const AZURE_SPEECH_KEY_HEADER = "Ocp-Apim-Subscription-Key";
export const AZURE_SPEECH_AUDIO_PART = "audio";
// Under 2 hours of audio and 250 MB per request; the cap applies to the audio
// as it's sent, after any conversion.
export const AZURE_SPEECH_SIZE_CAP_BYTES = 250 * 1024 * 1024;
// 200 is rejected ("Context list cannot have more than 200 items").
export const AZURE_SPEECH_MAX_PHRASES = 199;

// A custom subdomain (the portal's Keys and Endpoint) or a regional host, one label each.
const RESOURCE_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cognitiveservices\.azure\.com|api\.cognitive\.microsoft\.com)$/;

/**
 * @typedef {"required" | "invalidUrl" | "httpsRequired" | "host" | "resourceOnly"} AzureSpeechEndpointError
 */

function parse(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Why an endpoint can't be used, or null when it can: https, the resource
 * origin only (no path, query, fragment, credentials or port), on Azure's
 * Cognitive Services hosts. Scheme-less input is invalid here; the field
 * normalizes it on blur (`normalizeAzureSpeechEndpoint`).
 *
 * @param {unknown} raw
 * @returns {AzureSpeechEndpointError | null}
 */
export function azureSpeechEndpointError(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "required";
  const url = parse(text);
  if (!url || !url.hostname) return "invalidUrl";
  if (url.protocol !== "https:") return url.protocol === "http:" ? "httpsRequired" : "invalidUrl";
  if (!RESOURCE_HOST.test(url.hostname.toLowerCase())) return "host";
  if (
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    text.endsWith("?") ||
    text.endsWith("#") ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    return "resourceOnly";
  }
  return null;
}

/** Whether the key may be sent here: a Speech resource's https origin. */
export function isAzureSpeechEndpoint(raw) {
  return azureSpeechEndpointError(raw) === null;
}

/** The resource origin (lowercased host, no trailing slash), or null when invalid. */
export function azureSpeechOrigin(raw) {
  return isAzureSpeechEndpoint(raw) ? new URL(raw.trim()).origin : null;
}

/**
 * The endpoint as the field stores it after editing: trimmed, https added to a
 * bare host, and the origin when that's valid; otherwise the text as typed, so
 * the field can say what's wrong with it.
 *
 * @param {unknown} raw
 */
export function normalizeAzureSpeechEndpoint(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "";
  const withScheme = text.includes("://") ? text : `https://${text}`;
  return azureSpeechOrigin(withScheme) ?? text;
}

/** `{origin}/speechtotext/transcriptions:transcribe?api-version=…`, or null for an invalid endpoint. */
export function buildAzureSpeechTranscribeUrl(endpoint) {
  const origin = azureSpeechOrigin(endpoint);
  return origin
    ? `${origin}${AZURE_SPEECH_TRANSCRIBE_PATH}?api-version=${AZURE_SPEECH_API_VERSION}`
    : null;
}

/**
 * Whether a request URL is exactly the transcribe operation on a Speech
 * resource: what main checks before it sends the key.
 *
 * @param {unknown} url
 */
export function isAzureSpeechTranscribeUrl(url) {
  if (typeof url !== "string") return false;
  const parsed = parse(url);
  if (!parsed) return false;
  return buildAzureSpeechTranscribeUrl(parsed.origin) === url;
}

// ── Language ─────────────────────────────────────────────────────────────────

// MAI-Transcribe-2's languages (Microsoft Learn, "MAI-Transcribe-2 (preview)",
// Language support), as the base codes its examples use.
export const MAI_LOCALES = new Set([
  "af",
  "ar",
  "as",
  "az",
  "bg",
  "bn",
  "bs",
  "ca",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fa",
  "fi",
  "fil",
  "fr",
  "gl",
  "gu",
  "he",
  "hi",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "ja",
  "kk",
  "kn",
  "ko",
  "lt",
  "lv",
  "mk",
  "ml",
  "mr",
  "ms",
  "nb",
  "ne",
  "nl",
  "or",
  "pa",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
  "sw",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "vi",
  "yue",
  "zh",
]);

// The app's codes MAI names differently.
export const MAI_LOCALE_ALIASES = Object.freeze({ no: "nb", tl: "fil" });

/**
 * What a language sends as `locales`: the app's code reduced to its base
 * (zh-TW → zh, en-US → en), aliased where MAI names it differently, or null
 * for "auto" and for a language MAI doesn't list (the model then detects it).
 * `unsupported` names the language that was left out, for the log.
 *
 * @param {string | null | undefined} language
 * @returns {{ locale: string | null, unsupported: string | null }}
 */
export function resolveMaiLocale(language) {
  const text = typeof language === "string" ? language.trim() : "";
  if (!text || text === "auto") return { locale: null, unsupported: null };
  const base = text.split("-")[0].toLowerCase();
  const locale = MAI_LOCALE_ALIASES[base] ?? base;
  return MAI_LOCALES.has(locale)
    ? { locale, unsupported: null }
    : { locale: null, unsupported: base };
}

/** `resolveMaiLocale(language).locale`. */
export function maiLocale(language) {
  return resolveMaiLocale(language).locale;
}

// ── Request and answer ──────────────────────────────────────────────────────

/**
 * The `definition` part: the model under `enhancedMode`, `locales` only for a
 * set language, `phraseList` only with phrases (at most 199, in the order
 * given). No `modelOptions`: the verbatim default is what was chosen.
 *
 * @param {{ model?: string, locale?: string | null, phrases?: readonly string[] | null }} options
 */
export function buildAzureSpeechDefinition({ model, locale, phrases } = {}) {
  const definition = {};
  if (locale) definition.locales = [locale];
  definition.enhancedMode = { enabled: true, model: model || AZURE_SPEECH_DEFAULT_MODEL };
  const list = (Array.isArray(phrases) ? phrases : [])
    .filter((phrase) => typeof phrase === "string" && phrase.trim())
    .slice(0, AZURE_SPEECH_MAX_PHRASES);
  if (list.length > 0) definition.phraseList = { phrases: list };
  return JSON.stringify(definition);
}

/**
 * The request main sends (dictation's `dictation-transcription-request`, or
 * History's and uploads' `transcriptionRequestFrom`): the transcribe URL, the
 * key header, the `definition` field and the `audio` part name. Null for an
 * invalid endpoint, so a key is never paired with anything else.
 *
 * @param {{ endpoint: string, apiKey: string, model?: string, locale?: string | null, phrases?: readonly string[] | null }} options
 */
export function buildAzureSpeechRequest({ endpoint, apiKey, model, locale, phrases }) {
  const url = isAzureSpeechTranscribeUrl(endpoint)
    ? endpoint
    : buildAzureSpeechTranscribeUrl(endpoint);
  if (!url) return null;
  return {
    endpoint: url,
    headers: { [AZURE_SPEECH_KEY_HEADER]: apiKey },
    fields: [["definition", buildAzureSpeechDefinition({ model, locale, phrases })]],
    audioPart: AZURE_SPEECH_AUDIO_PART,
  };
}

/**
 * The transcript in a 200 answer (parsed JSON or its text): every
 * `combinedPhrases[].text`, trimmed, empty ones skipped, joined with a space.
 * "" for a silent clip or an answer without phrases.
 *
 * @param {unknown} answer
 */
export function parseAzureSpeechAnswer(answer) {
  let data = answer;
  if (typeof answer === "string") {
    try {
      data = JSON.parse(answer);
    } catch {
      return "";
    }
  }
  const phrases = data && typeof data === "object" ? data.combinedPhrases : null;
  if (!Array.isArray(phrases)) return "";
  return phrases
    .map((phrase) => (typeof phrase?.text === "string" ? phrase.text.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

/** Formats MAI takes as they are; anything else is converted to WAV first. */
const ACCEPTED_EXTENSIONS = new Set(["wav", "mp3", "flac"]);

/** Whether an upload's file extension can be sent to Azure Speech without conversion. */
export function isAzureSpeechAcceptedExtension(extension) {
  return ACCEPTED_EXTENSIONS.has(String(extension || "").toLowerCase());
}
