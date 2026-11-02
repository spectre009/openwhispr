// Settings › AI Connections' "Last recorded use" (stage B of "check that every
// AI connection works"): which check descriptor a real request ran on, which
// feature sent it, and whether its outcome says anything about the connection.
// Pure ESM, shared by main (require(esm): connectionOutcomes.js, the batch
// transcription request) and the renderer (ReasoningService, chat streaming,
// the dictation window).
//
// The ids are stage A's (settings/connectionHealth.ts buildCheckPlan):
// `provider:<id>`, `corti:llm`, `corti:stt`, `copilot`, `cloud`, `custom`, and
// `endpoint:<hash>` / `selfHosted:<hash>` for a feature's own endpoint (the
// hash of its route and key slot, never the URL itself).

import {
  isAzureHost,
  isCustomConnectionSlot,
  isPrivateHost,
  validateEndpoint,
} from "../config/customConnection.js";
import { PROVIDER_ERROR_CODES as C, asProviderError } from "./providerHttpErrors.js";

/** FNV-1a, hex: a short, stable id or generation for names that may hold a URL. */
export function shortHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * An endpoint's URL as a check route: the custom connection's validator, Azure
 * as its resource's v1 base. Null when it isn't one.
 *
 * @param {unknown} raw
 * @param {boolean} selfHosted
 * @returns {string | null}
 */
export function endpointCheckRoute(raw, selfHosted) {
  let text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  // A self-hosted server typed without a scheme is plain http on the network.
  if (selfHosted && !text.includes("://")) {
    const host = text.split("/")[0].replace(/:\d+$/, "");
    if (isPrivateHost(host)) text = `http://${text}`;
  }
  let candidate = text;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    // Azure takes its resource origin: operation URLs and api-version queries stay behind.
    if (isAzureHost(url.hostname)) candidate = url.origin;
  } catch {
    return null;
  }
  const validated = validateEndpoint(candidate);
  return validated.ok ? validated.languageBase : null;
}

/**
 * A feature endpoint's descriptor id: rows on one server with one key slot share it.
 *
 * @param {"endpoint" | "selfHosted"} kind
 * @param {string} route
 * @param {string | null} slot
 */
export function endpointDescriptorId(kind, route, slot) {
  return `${kind}:${shortHash(`${route}|${slot ?? ""}`)}`;
}

/** Each API-key provider's credential slot, as stage A's checks read it (connectionChecks.js KIND_SLOTS). */
export const PROVIDER_KEY_SLOTS = Object.freeze({
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  assemblyai: "ASSEMBLYAI_API_KEY",
  "azure-speech": "AZURE_SPEECH_API_KEY",
  tinfoil: "TINFOIL_API_KEY",
});

const FIXED_DESCRIPTOR_SLOTS = Object.freeze({
  "corti:llm": "CORTI_API_KEY",
  "corti:stt": "CORTI_CLIENT_CREDENTIALS",
  copilot: "GITHUB_COPILOT_TOKEN",
  custom: "CUSTOM_CONNECTION_API_KEY",
  // Cloud's session isn't a key: its outcomes go at sign-out.
  cloud: null,
});

const HASHED_ID = /^(endpoint|selfHosted):[0-9a-f]{8}$/;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * The credential slot an outcome on `id` is fenced and cleared by: a slot
 * name, null (none), or undefined when the pair isn't one stage A builds.
 * Only a feature's own endpoint takes the request's slot; every other id
 * has its own.
 *
 * @param {unknown} id
 * @param {unknown} [slot]
 * @returns {string | null | undefined}
 */
export function descriptorSlot(id, slot = null) {
  if (typeof id !== "string") return undefined;
  if (hasOwn(FIXED_DESCRIPTOR_SLOTS, id)) return FIXED_DESCRIPTOR_SLOTS[id];
  if (id.startsWith("provider:")) {
    const provider = id.slice("provider:".length);
    return hasOwn(PROVIDER_KEY_SLOTS, provider) ? PROVIDER_KEY_SLOTS[provider] : undefined;
  }
  const hashed = HASHED_ID.exec(id);
  if (hashed?.[1] === "selfHosted") return null;
  if (hashed?.[1] === "endpoint") return isCustomConnectionSlot(slot) ? slot : undefined;
  return undefined;
}

// ── Features ─────────────────────────────────────────────────────────────────

/**
 * The features an outcome names (connectionUsage.ts's, without the screen
 * context model: the assistant's vision requests are the assistant's).
 */
export const OUTCOME_FEATURES = Object.freeze([
  "recognition",
  "cleanup",
  "styles",
  "assistant",
  "translation",
  "chat",
  "liveRecording",
  "fileTranscription",
  "noteFormatting",
]);

/** @param {unknown} feature */
export const isOutcomeFeature = (feature) =>
  typeof feature === "string" && OUTCOME_FEATURES.includes(feature);

const SCOPE_FEATURES = Object.freeze({
  dictationCleanup: "cleanup",
  dictationAgent: "assistant",
  dictationAgentVision: "assistant",
  noteFormatting: "noteFormatting",
  chatIntelligence: "chat",
  dictationTranslation: "translation",
});

/**
 * The feature a language-model scope's request belongs to, or null (managed
 * speech-to-text's scope). Styles run on Cleanup's scope and say so themselves.
 *
 * @param {unknown} scope
 */
export function featureForScope(scope) {
  return typeof scope === "string" && hasOwn(SCOPE_FEATURES, scope) ? SCOPE_FEATURES[scope] : null;
}

// ── Requests → descriptors ───────────────────────────────────────────────────

/** @typedef {{ id: string, slot: string | null }} OutcomeTarget */

/** @returns {OutcomeTarget | null} */
function providerTarget(provider) {
  return typeof provider === "string" && hasOwn(PROVIDER_KEY_SLOTS, provider)
    ? { id: `provider:${provider}`, slot: PROVIDER_KEY_SLOTS[provider] }
    : null;
}

/** @returns {OutcomeTarget | null} */
function selfHostedTarget(url) {
  const route = endpointCheckRoute(url, true);
  return route ? { id: endpointDescriptorId("selfHosted", route, null), slot: null } : null;
}

/** @returns {OutcomeTarget | null} */
function endpointTarget(url, slot) {
  const route = endpointCheckRoute(url, false);
  if (!route || !isCustomConnectionSlot(slot)) return null;
  return { id: endpointDescriptorId("endpoint", route, slot), slot };
}

/**
 * A language-model request's descriptor: its resolved provider and, for a
 * feature's own endpoint, the URL it sent to and the slot its key came from.
 * Null for local models, enterprise deployments and anything stage A doesn't
 * check.
 *
 * @param {{ provider?: string, baseUrl?: string, lanUrl?: string, slot?: string | null }} request
 * @returns {OutcomeTarget | null}
 */
export function llmOutcomeTarget({ provider, baseUrl, lanUrl, slot } = {}) {
  switch (provider) {
    case "openwhispr":
      return { id: "cloud", slot: null };
    case "copilot":
      return { id: "copilot", slot: FIXED_DESCRIPTOR_SLOTS.copilot };
    case "corti":
      return { id: "corti:llm", slot: FIXED_DESCRIPTOR_SLOTS["corti:llm"] };
    case "lan":
    case "self-hosted":
      return selfHostedTarget(lanUrl);
    case "custom":
      return endpointTarget(baseUrl, slot);
    default:
      return providerTarget(provider);
  }
}

/**
 * A speech-to-text request's descriptor, from its resolved route
 * (transcriptionRoute.ts) and the settings it was resolved from (the custom
 * and self-hosted URLs, as stage A reads them).
 *
 * @param {{ transport?: string, provider?: string } | null | undefined} route
 * @param {{ cloudTranscriptionBaseUrl?: string, remoteTranscriptionUrl?: string }} [settings]
 * @returns {OutcomeTarget | null}
 */
export function transcriptionOutcomeTarget(route, settings = {}) {
  if (!route) return null;
  switch (route.transport) {
    case "azure-speech":
      return providerTarget("azure-speech");
    case "proxied":
      return route.provider === "corti"
        ? { id: "corti:stt", slot: FIXED_DESCRIPTOR_SLOTS["corti:stt"] }
        : providerTarget(route.provider);
    case "http-batch":
      if (route.provider === "self-hosted") {
        return selfHostedTarget(settings?.remoteTranscriptionUrl);
      }
      if (route.provider === "custom") {
        // Every speech-to-text custom endpoint shares one key.
        return endpointTarget(settings?.cloudTranscriptionBaseUrl, "CUSTOM_TRANSCRIPTION_API_KEY");
      }
      return providerTarget(route.provider);
    default:
      return null;
  }
}

/**
 * A speech-to-text request's "Last recorded use" tag: its descriptor and the
 * feature that sent it, or null when stage A has no descriptor for it.
 *
 * @param {Parameters<typeof transcriptionOutcomeTarget>[0]} route
 * @param {Parameters<typeof transcriptionOutcomeTarget>[1]} settings
 * @param {string} feature
 * @returns {{ descriptorId: string, slot: string | null, feature: string } | null}
 */
export function transcriptionOutcomeTag(route, settings, feature) {
  const target = transcriptionOutcomeTarget(route, settings);
  return target ? { descriptorId: target.id, slot: target.slot, feature } : null;
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

/** What a provider (or the user's server) answered about the request: recorded as failures. */
export const CONNECTION_FAILURE_CODES = Object.freeze(
  new Set([
    C.AUTH_FAILED,
    C.ACCESS_DENIED,
    C.QUOTA_EXHAUSTED,
    C.RATE_LIMITED,
    C.MODEL_NOT_FOUND,
    C.PAYLOAD_TOO_LARGE,
    C.BAD_REQUEST,
    C.UNAVAILABLE,
    C.TIMEOUT,
    C.UNREACHABLE,
    C.NO_RESPONSE,
    C.ERROR,
    "AZURE_SPEECH_ENDPOINT_INVALID",
  ])
);

// Stopped by the app, not answered by the connection.
const CANCEL_CODES = new Set([
  "TRANSCRIPTION_CANCELLED",
  "REASON_CANCELLED",
  "UPLOAD_CANCELLED",
  "COPILOT_CANCELLED",
  "YIELDED_TO_DICTATION",
]);

// OpenWhispr Cloud's own answers, in the providers' words.
const CLOUD_CODES = Object.freeze({
  AUTH_EXPIRED: C.AUTH_FAILED,
  LIMIT_REACHED: C.QUOTA_EXHAUSTED,
  SERVER_ERROR: C.UNAVAILABLE,
});

/** Whether a request was stopped (cancel, a newer request, giving way to a dictation). */
export function isCancellation(error) {
  if (!error || typeof error !== "object") return false;
  if (error.name === "AbortError") return true;
  if (typeof error.code === "string" && CANCEL_CODES.has(error.code)) return true;
  // ReasoningService's cancel of a request a newer one replaced.
  return error.status === 499 || error.statusCode === 499;
}

/**
 * The code a failed request records, or null when the failure says nothing
 * about the connection: a cancel or a yield, a missing key (nothing was
 * sent), a local check of the reply (a repeated transcript, an empty or cut
 * off answer), a tool or delivery failure.
 *
 * @param {unknown} error
 * @returns {string | null}
 */
export function connectionFailureCode(error) {
  if (!error || typeof error !== "object" || isCancellation(error)) return null;
  const failure = /** @type {{ code?: unknown, messageKey?: unknown }} */ (error);
  const code = typeof failure.code === "string" ? failure.code : "";
  if (CONNECTION_FAILURE_CODES.has(code)) return code;
  if (hasOwn(CLOUD_CODES, code)) return CLOUD_CODES[code];
  // Already worded as something else (an output check's, a refusal's).
  if (failure.messageKey) return null;
  // A network failure no one classified yet (Chromium's, Node's), read as the
  // providers' classifier reads it.
  const classified = asProviderError(error, { provider: "", surface: "llm" });
  return classified !== error && CONNECTION_FAILURE_CODES.has(classified?.code)
    ? classified.code
    : null;
}

// Failures that are the service's answer about the content: the connection worked.
const ANSWERED_CODES = new Set(["NO_SPEECH_DETECTED"]);

/**
 * What a failed request records: `{ ok: false, code }`, `{ ok: true }` when
 * the service answered (no speech in the audio), or null for nothing.
 *
 * @param {unknown} error
 * @returns {{ ok: boolean, code: string } | null}
 */
export function requestOutcomeOfFailure(error) {
  const failure = /** @type {{ code?: unknown }} */ (error);
  if (failure && typeof failure === "object" && ANSWERED_CODES.has(failure.code)) {
    return { ok: true, code: "OK" };
  }
  const code = connectionFailureCode(error);
  return code ? { ok: false, code } : null;
}
