// The custom connection on Settings › AI Connections: one Azure OpenAI or
// OpenAI-compatible endpoint with one key (CUSTOM_CONNECTION_API_KEY). Features
// keep reading their own URL and key fields; main copies the connection's key
// into those key slots. Pure and dependency-free like copilot.js, so main (via
// require), the renderer and the tests share one source.

export const CUSTOM_CONNECTION_SECRET = "CUSTOM_CONNECTION_API_KEY";

/** The store field the renderer hydrates the connection's key into, to show it masked. */
export const CUSTOM_CONNECTION_STORE_KEY = "customConnectionApiKey";

/**
 * The key slots main may copy the connection's key into: each secret a
 * feature's custom-endpoint request reads, with the store field it hydrates.
 * Any other name is refused.
 */
export const CUSTOM_CONNECTION_SLOTS = Object.freeze({
  CUSTOM_TRANSCRIPTION_API_KEY: "customTranscriptionApiKey",
  CUSTOM_CLEANUP_API_KEY: "cleanupCustomApiKey",
  NOTE_FORMATTING_CUSTOM_API_KEY: "noteFormattingCustomApiKey",
  TRANSLATION_CUSTOM_API_KEY: "translationCustomApiKey",
  DICTATION_AGENT_CUSTOM_API_KEY: "dictationAgentCustomApiKey",
  DICTATION_AGENT_VISION_CUSTOM_API_KEY: "dictationAgentVisionCustomApiKey",
  CHAT_AGENT_CUSTOM_API_KEY: "chatAgentCustomApiKey",
});

/** @typedef {keyof typeof CUSTOM_CONNECTION_SLOTS} CustomConnectionSlot */

/**
 * @param {unknown} slot
 * @returns {slot is CustomConnectionSlot}
 */
export function isCustomConnectionSlot(slot) {
  return (
    typeof slot === "string" && Object.prototype.hasOwnProperty.call(CUSTOM_CONNECTION_SLOTS, slot)
  );
}

// ── The setting ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} CustomConnection
 * @property {string} name
 * @property {string} endpoint
 * @property {{ language: string[], speech: string[] }} models  deployments or models used or found
 */

/** @param {unknown} value */
function modelList(value) {
  if (!Array.isArray(value)) return null;
  const names = value.filter((name) => typeof name === "string" && name.trim());
  return [...new Set(names.map((name) => name.trim()))];
}

/**
 * The stored setting, or null when it's absent or malformed.
 *
 * @param {unknown} value
 * @returns {CustomConnection | null}
 */
export function normalizeCustomConnection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { name, endpoint, models } = /** @type {Record<string, any>} */ (value);
  if (typeof name !== "string" || !name.trim()) return null;
  if (typeof endpoint !== "string" || !endpoint.trim()) return null;
  if (!models || typeof models !== "object") return null;
  const language = modelList(models.language);
  const speech = modelList(models.speech);
  if (!language || !speech) return null;
  return { name: name.trim(), endpoint: endpoint.trim(), models: { language, speech } };
}

/**
 * @param {string | null | undefined} raw  the localStorage value
 * @returns {CustomConnection | null}
 */
export function parseCustomConnection(raw) {
  if (!raw) return null;
  try {
    return normalizeCustomConnection(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────────

// Mirror of AZURE_HOST_SUFFIXES (isAzureOpenAIEndpoint) in src/utils/urlUtils.ts,
// which main can't load; test/components/customConnection.test.js keeps them in step.
const AZURE_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".cognitiveservices.azure.com",
  ".services.ai.azure.com",
];

// The resource endpoint from Azure's Keys and Endpoint page, optionally with /openai or /openai/v1.
const AZURE_RESOURCE_PATH = /^(?:\/openai(?:\/v1)?)?$/i;

// An operation a pasted OpenAI-compatible URL may end in; its base is what precedes it.
const OPERATION_SUFFIX =
  /\/(?:chat\/completions|completions|responses|models|embeddings|audio\/(?:transcriptions|translations))$/i;

// Mirror of isPrivateHost in src/utils/urlUtils.ts (same constraint as above):
// plain HTTP only reaches private addresses, as isSecureHttpEndpoint allows.
function parseIPv4Literal(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;
  const ipv4 = parseIPv4Literal(h);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
  }
  const isIPv6 = h.includes(":");
  if (isIPv6 && (/^fe[89ab]/.test(h) || h.startsWith("fc") || h.startsWith("fd"))) return true;
  return h.endsWith(".local") || h.endsWith(".ts.net");
}

/** @param {string} hostname */
export function isAzureHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Scheme-less input reads as https, as the connection tests do. */
function parseUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function basePath(pathname) {
  return pathname.replace(/\/+$/, "").replace(OPERATION_SUFFIX, "").replace(/\/+$/, "");
}

/**
 * @typedef {"required" | "invalidUrl" | "httpsRequired" | "azureResourceOnly" | "baseUrlOnly"} CustomEndpointError
 *
 * @typedef {object} ValidatedEndpoint
 * @property {boolean} ok
 * @property {"azure" | "openai-compatible"} kind
 * @property {string} origin
 * @property {string} languageBase  where language models are called ("" when refused)
 * @property {string} speechBase  where speech-to-text is called ("" when refused)
 * @property {CustomEndpointError} [error]
 */

/** @returns {ValidatedEndpoint} */
function refused(error, kind = "openai-compatible", origin = "") {
  return { ok: false, kind, origin, languageBase: "", speechBase: "", error };
}

/**
 * An endpoint the connection can take, and the URLs each capability uses.
 * Azure (by host): the resource origin, optionally followed by /openai or
 * /openai/v1; language models use the v1 API under it, speech-to-text the
 * origin, where the transcription route builds its deployment URLs. Any other
 * Azure path (a Foundry project, a pasted operation URL) is refused rather
 * than rewritten. Other hosts: an OpenAI-compatible base URL, https unless the
 * host is private, without credentials, query or fragment.
 *
 * @param {unknown} raw
 * @returns {ValidatedEndpoint}
 */
export function validateEndpoint(raw) {
  if (typeof raw !== "string" || !raw.trim()) return refused("required");
  const url = parseUrl(raw);
  if (!url || !url.hostname) return refused("invalidUrl");
  const azure = isAzureHost(url.hostname);
  const kind = azure ? "azure" : "openai-compatible";
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    return refused("httpsRequired", kind, url.origin);
  }
  const path = url.pathname.replace(/\/+$/, "");
  const decorated = !!(url.username || url.password || url.search || url.hash);
  if (azure) {
    if (decorated || !AZURE_RESOURCE_PATH.test(path)) {
      return refused("azureResourceOnly", kind, url.origin);
    }
    return {
      ok: true,
      kind,
      origin: url.origin,
      languageBase: `${url.origin}/openai/v1`,
      speechBase: url.origin,
    };
  }
  if (decorated) return refused("baseUrlOnly", kind, url.origin);
  const base = `${url.origin}${basePath(path)}`;
  return { ok: true, kind, origin: url.origin, languageBase: base, speechBase: base };
}

/**
 * The endpoint as the connection stores it: an Azure resource's origin, or the base URL.
 *
 * @param {ValidatedEndpoint} validated
 */
export function canonicalEndpoint(validated) {
  if (!validated.ok) return "";
  return validated.kind === "azure" ? validated.origin : validated.languageBase;
}

/**
 * An endpoint URL as a comparable base (origin and path, no operation suffix,
 * credentials, query or fragment), or "" when it isn't an http(s) URL.
 *
 * @param {unknown} raw
 */
export function endpointBase(raw) {
  const url = parseUrl(raw);
  return url ? `${url.origin}${basePath(url.pathname)}` : "";
}

/**
 * @param {unknown} raw
 */
function endpointHostOf(raw) {
  return parseUrl(raw)?.host ?? "";
}

/**
 * @param {unknown} url
 * @param {ValidatedEndpoint} target  an accepted endpoint
 */
function matchesEndpoint(url, target) {
  if (target.kind === "azure") return endpointHostOf(url) === new URL(target.origin).host;
  return !!endpointBase(url) && endpointBase(url) === target.languageBase;
}

/**
 * Whether a feature's custom URL points at the connection: on Azure the same
 * host (one resource serves every capability from its origin), otherwise the
 * same base.
 *
 * @param {unknown} url
 * @param {{ endpoint: string } | null | undefined} connection
 */
export function usesConnectionEndpoint(url, connection) {
  const target = connection ? validateEndpoint(connection.endpoint) : null;
  return !!target?.ok && matchesEndpoint(url, target);
}

/**
 * The value a feature's URL field takes when the connection moves to `next`:
 * language models get its language base, speech-to-text its speech base. An
 * Azure transcription operation URL (a pinned deployment and api-version)
 * keeps its path and query on the new origin.
 *
 * @param {string} current
 * @param {"speech" | "language"} capability
 * @param {ValidatedEndpoint} next
 */
export function rewrittenEndpointUrl(current, capability, next) {
  if (!next.ok) return "";
  if (capability === "language") return next.languageBase;
  if (next.kind === "azure") {
    const url = parseUrl(current);
    if (
      url &&
      /\/audio\/(?:transcriptions|translations)$/i.test(url.pathname.replace(/\/+$/, ""))
    ) {
      return `${next.origin}${url.pathname}${url.search}`;
    }
  }
  return next.speechBase;
}

// ── Used by ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ConnectionUse
 * @property {import("../components/settings/connectionUsage").UsageFeature} feature
 * @property {string} model
 * @property {CustomConnectionSlot} slot  the key slot the feature's request reads
 * @property {string} urlField  the store field its URL comes from (its own, or the one it borrows)
 * @property {"speech" | "language"} capability
 * @property {import("../components/settings/connectionUsage").FeatureUsage} usage
 */

/**
 * The features whose custom endpoint is the connection: on Azure the same host
 * (one resource serves every capability from its origin), otherwise the same
 * base. An inherited URL counts for the feature using it, read from the field
 * the request reads, and keyed by the slot that request reads.
 *
 * @param {readonly import("../components/settings/connectionUsage").FeatureUsage[]} usages
 * @param {{ endpoint: string } | null | undefined} connection
 * @param {object} settings  the store state the usages were computed from
 * @returns {ConnectionUse[]}
 */
export function featuresUsingConnection(usages, connection, settings) {
  const target = connection ? validateEndpoint(connection.endpoint) : null;
  if (!target?.ok) return [];
  const values = /** @type {Record<string, unknown>} */ (settings);
  /** @type {ConnectionUse[]} */
  const uses = [];
  for (const usage of usages) {
    const source = usage.customEndpoint;
    if (usage.connection.type !== "custom" || !source) continue;
    if (!matchesEndpoint(values[source.urlField], target)) continue;
    uses.push({
      feature: usage.feature,
      model: usage.connection.model,
      slot: source.slot,
      urlField: source.urlField,
      capability: usage.connection.secret === "speechToText" ? "speech" : "language",
      usage,
    });
  }
  return uses;
}

// ── Models ───────────────────────────────────────────────────────────────────

/**
 * What a deployment serves, from its model name: transcription models and
 * Whisper are speech-to-text, everything else a language model.
 *
 * @param {string} model
 * @returns {"speech" | "language"}
 */
export function classifyDeployment(model) {
  const name = String(model || "")
    .trim()
    .toLowerCase();
  return name.includes("transcribe") || name.startsWith("whisper") ? "speech" : "language";
}

/**
 * The model lists with `entries` added under their capability, in order and without repeats.
 *
 * @param {{ language: string[], speech: string[] }} models
 * @param {ReadonlyArray<{ name: string, capability: "speech" | "language" }>} entries
 */
export function mergeConnectionModels(models, entries) {
  const next = { language: [...models.language], speech: [...models.speech] };
  for (const { name, capability } of entries) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed && !next[capability].includes(trimmed)) next[capability].push(trimmed);
  }
  return next;
}
