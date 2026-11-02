// Settings › AI Connections & Local Models: checks that each saved connection
// works. The renderer builds one check descriptor per thing to verify,
// `{ id, kind, capability, route, slot, models, generation }`, made of names
// only (the slot is a credential's name, never its value), because the
// endpoints, regions, tenants and models live in its settings. Main validates
// each descriptor against its kind's allowlist, reads the key from the named
// slot (it never leaves main), makes one free authenticated request (a model
// list, or an account or key-info route; never text or audio) and answers
// evidence, not a verdict:
//
//   { reachable, credentials: "accepted" | "rejected" | "unknown",
//     models: { [id]: "offered" | "missing" | "unknown" },
//     limit?, httpStatus?, code, proof, checkedAt, generation }
//
// Bodies are read only to classify an answer (providerHttpErrors.js: a 403
// isn't always a bad key, Gemini's 400 API_KEY_INVALID is) and to compare the
// models the descriptor names; they're never logged, kept or returned, and
// neither is a provider's model list. Logs carry the kind, the code and the
// HTTP status only.
//
// One queue, deduplicating a descriptor that is already being checked. Results
// are cached per descriptor id and fenced twice: by the descriptor's
// `generation` (route, slot, models, region, tenant; the renderer's) and by
// main's credential generation for the slot, bumped by every write, copy or
// removal of the key (environment.js's onSecretChanged). A check whose
// generations changed while it ran is dropped.

const {
  canonicalEndpoint,
  isCustomConnectionSlot,
  validateEndpoint,
} = require("../config/customConnection.js");
const { BYOK_API_KEYS } = require("../config/secretKeys");
const { azureSpeechOrigin } = require("./azureSpeechTranscription.js");
const { PROVIDER_ERROR_CODES: C, providerHttpError } = require("./providerHttpErrors");
const { normalizeBaseUrl } = require("./providerConnectionTest");
const { runCustomEndpointCheck } = require("./customConnectionIpc");
const { copilotProviderError } = require("./copilot/copilotErrors");
const openWhisprCloudGate = require("./openWhisprCloudGate");

const REQUEST_TIMEOUT_MS = 8000;
const MAX_CONCURRENT_REQUESTS = 4;
// Copilot's model list starts its runtime (~150 MB) when it isn't running.
const COPILOT_DEADLINE_MS = 45000;
const MAX_REDIRECTS = 3;
const MAX_DESCRIPTORS = 48;
const MAX_MODELS = 24;
const MAX_BODY_CHARS = 8 * 1024 * 1024;
const MAX_ERROR_CHARS = 4096;
const GEMINI_MAX_PAGES = 5;
const AZURE_SPEECH_MODELS_API_VERSION = "2024-11-15";
const GITHUB_API_VERSION = "2022-11-28";

/** Codes beyond providerHttpErrors' own (PROVIDER_*, API_KEY_MISSING). */
const CHECK_CODES = Object.freeze({
  OK: "OK",
  NO_KEY: C.KEY_MISSING,
  INVALID_ROUTE: "CHECK_INVALID_ROUTE",
  CLOUD_DISABLED: "CHECK_CLOUD_DISABLED",
  ENDPOINT_NOT_FOUND: "CHECK_ENDPOINT_NOT_FOUND",
  NOT_VERIFIABLE: "CHECK_NOT_VERIFIABLE",
  MANAGEMENT_KEY: "CHECK_MANAGEMENT_KEY",
  KEY_BLOCKED: "CHECK_KEY_BLOCKED",
  LIMIT_REACHED: "CHECK_LIMIT_REACHED",
  MALFORMED: "CHECK_MALFORMED",
  REDIRECTED: "CHECK_REDIRECTED",
  UNAVAILABLE: "CHECK_UNAVAILABLE",
});

// ── Kinds and their allowlists ───────────────────────────────────────────────

/** Each fixed route, as the renderer's API_ENDPOINTS and providers name it. */
const FIXED_ROUTES = Object.freeze({
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  deepgram: "https://api.deepgram.com/v1",
  assemblyai: "https://api.assemblyai.com/v2",
  tinfoil: "https://inference.tinfoil.sh/v1",
  "corti-llm": "https://ai.eu.corti.app/v1",
  copilot: "https://api.github.com",
});

const OPENAI_DEFAULT_ROUTE = "https://api.openai.com/v1";

/** The credential slot each kind reads. `endpoint` names a feature's slot; `selfHosted` none. */
const KIND_SLOTS = Object.freeze({
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
  "corti-llm": "CORTI_API_KEY",
  "corti-stt": "CORTI_CLIENT_CREDENTIALS",
  custom: "CUSTOM_CONNECTION_API_KEY",
  copilot: "GITHUB_COPILOT_TOKEN",
});

const KINDS = new Set([...Object.keys(KIND_SLOTS), "endpoint", "selfHosted"]);
const CAPABILITIES = new Set(["llm", "stt", "identity"]);
// Kinds whose explicit Check does more than the automatic one (a fresh token,
// Copilot's own model list), so an automatic check in flight doesn't stand in for it.
const DEEP_KINDS = new Set(["copilot", "corti-stt"]);

/** The secrets each slot is read from, for the credential generation. */
const SLOT_SOURCES = Object.freeze({
  CORTI_CLIENT_CREDENTIALS: ["CORTI_CLIENT_ID", "CORTI_CLIENT_SECRET"],
  CUSTOM_CLEANUP_API_KEY: ["CUSTOM_CLEANUP_API_KEY", "CUSTOM_REASONING_API_KEY"],
});

const sourcesOf = (slot) => SLOT_SOURCES[slot] ?? [slot];

const CORTI_AUTH_ROUTE = /^https:\/\/auth\.(eu|us)\.corti\.app\/realms\/([A-Za-z0-9_-]{1,64})$/;
const ID_PATTERN = /^[A-Za-z0-9:._@/-]{1,160}$/;

function openAiRoutes(env) {
  const override = normalizeBaseUrl(env.OPENWHISPR_OPENAI_BASE_URL || env.OPENAI_BASE_URL);
  return new Set([OPENAI_DEFAULT_ROUTE, override].filter(Boolean));
}

/** Whether `route` is what this kind may be sent to; the key is read only after. */
function routeAllowed(kind, route, env) {
  if (typeof route !== "string" || !route || route.length > 2048) return false;
  if (FIXED_ROUTES[kind]) return route === FIXED_ROUTES[kind];
  switch (kind) {
    case "openai":
      return openAiRoutes(env).has(route);
    case "azure-speech":
      return azureSpeechOrigin(route) === route;
    case "corti-stt":
      return CORTI_AUTH_ROUTE.test(route);
    case "custom": {
      const target = validateEndpoint(route);
      return target.ok && canonicalEndpoint(target) === route;
    }
    // The custom connection's validator: https unless the host is private, no
    // credentials, query or fragment, Azure only as its resource's v1 base.
    case "endpoint":
    case "selfHosted": {
      const target = validateEndpoint(route);
      return target.ok && target.languageBase === route;
    }
    default:
      return false;
  }
}

function slotAllowed(kind, slot) {
  if (kind === "selfHosted") return slot === null;
  if (kind === "endpoint") return isCustomConnectionSlot(slot);
  return slot === KIND_SLOTS[kind];
}

function cleanModels(raw) {
  if (!Array.isArray(raw)) return null;
  const models = [];
  for (const value of raw) {
    if (typeof value !== "string") return null;
    const model = value.trim();
    if (!model || model.length > 200 || /[\u0000-\u001f]/.test(model)) return null;
    if (!models.includes(model)) models.push(model);
  }
  return models.length > MAX_MODELS ? null : models;
}

/**
 * A descriptor as main accepts it, or `{ ok: false }` with its id when the id
 * is usable (so the renderer learns why), never echoing a refused value.
 */
function validateDescriptor(raw, env = process.env) {
  const id = typeof raw?.id === "string" && ID_PATTERN.test(raw.id) ? raw.id : null;
  const generation =
    typeof raw?.generation === "string" && raw.generation.length <= 2048 ? raw.generation : "";
  if (!id) return { ok: false, id: null };
  const kind = raw.kind;
  const slot = raw.slot === undefined ? null : raw.slot;
  const models = cleanModels(raw.models ?? []);
  if (
    !KINDS.has(kind) ||
    !CAPABILITIES.has(raw.capability) ||
    !models ||
    !slotAllowed(kind, slot) ||
    !routeAllowed(kind, raw.route, env)
  ) {
    return { ok: false, id, generation };
  }
  return {
    ok: true,
    id,
    generation,
    descriptor: {
      id,
      kind,
      capability: raw.capability,
      route: raw.route,
      slot,
      models,
      generation,
    },
  };
}

// ── Secrets ──────────────────────────────────────────────────────────────────

/** How main reads each slot. Corti's speech-to-text slot is its client credentials. */
function createSecretReader(environmentManager) {
  const getters = {
    CUSTOM_TRANSCRIPTION_API_KEY: () => environmentManager.getCustomTranscriptionKey(),
    CUSTOM_CLEANUP_API_KEY: () => environmentManager.getCleanupCustomKey(),
    CUSTOM_CONNECTION_API_KEY: () => environmentManager.getCustomConnectionKey(),
    GITHUB_COPILOT_TOKEN: () => environmentManager.getGithubCopilotToken(),
    CORTI_CLIENT_CREDENTIALS: () => ({
      clientId: environmentManager.getCortiClientId() || "",
      clientSecret: environmentManager.getCortiClientSecret() || "",
    }),
  };
  for (const entry of BYOK_API_KEYS) {
    getters[entry.env] = () => environmentManager[entry.get]();
  }
  return (slot) => {
    const getter = getters[slot];
    if (!getter) return "";
    const value = getter();
    return typeof value === "string" ? value.trim() : value || "";
  };
}

const hasKey = (value) =>
  typeof value === "string" ? !!value : !!(value?.clientId && value?.clientSecret);

// ── Results ──────────────────────────────────────────────────────────────────

function unknownModels(models) {
  return Object.fromEntries(models.map((model) => [model, "unknown"]));
}

function makeResult(descriptor, fields, now) {
  return {
    reachable: false,
    credentials: "unknown",
    models: unknownModels(descriptor.models),
    proof: "key",
    ...fields,
    checkedAt: now(),
    generation: descriptor.generation,
  };
}

/** What an HTTP failure says about the key, from providerHttpErrors' classifier. */
function httpFailure(status, text, { keySent = true, selfHosted = false } = {}) {
  if (status === 404) {
    return { reachable: true, credentials: "unknown", code: CHECK_CODES.ENDPOINT_NOT_FOUND };
  }
  const { code } = providerHttpError({
    provider: "connection check",
    status,
    body: text || "",
    surface: "llm",
    selfHosted,
  });
  switch (code) {
    case C.AUTH_FAILED:
      return keySent
        ? { reachable: true, credentials: "rejected", code }
        : { reachable: true, credentials: "unknown", code: C.ACCESS_DENIED };
    case C.QUOTA_EXHAUSTED:
      return { reachable: true, credentials: keySent ? "accepted" : "unknown", code };
    case C.RATE_LIMITED:
    case C.ACCESS_DENIED:
      return { reachable: true, credentials: "unknown", code };
    case C.UNAVAILABLE:
    case C.TIMEOUT:
      return { reachable: false, credentials: "unknown", code };
    default:
      return { reachable: true, credentials: "unknown", code: C.ERROR };
  }
}

/** A transport failure: no answer, a timeout, a redirect elsewhere, the Cloud switch. */
function transportFailure(error) {
  switch (error?.checkCode) {
    case "timeout":
      return { reachable: false, credentials: "unknown", code: C.TIMEOUT };
    case "redirect":
      return { reachable: true, credentials: "unknown", code: CHECK_CODES.REDIRECTED };
    case "cloud":
      return { reachable: false, credentials: "unknown", code: CHECK_CODES.CLOUD_DISABLED };
    default:
      return { reachable: false, credentials: "unknown", code: C.UNREACHABLE };
  }
}

// ── Model comparison ─────────────────────────────────────────────────────────

const norm = (id) =>
  String(id || "")
    .trim()
    .replace(/^models\//i, "")
    .toLowerCase();

const ALIAS_HINT = /(?:^|[-_.])(?:latest|preview|exp|experimental)(?:$|[-_.])/;

/**
 * Whether `used` may still be served under another listed name: a dated
 * variant of it is listed, it's a dated or tagged form of a listed one, a
 * moving alias (`-latest`, preview, experimental) or a routing variant
 * (OpenRouter's `model:free`). Unknown, never missing.
 */
function nearMatch(used, offered) {
  if (ALIAS_HINT.test(used)) return true;
  const base = used.split(":")[0];
  if (base !== used && offered.has(base)) return true;
  for (const id of offered) {
    if (id.startsWith(`${used}-`) || used.startsWith(`${id}-`)) return true;
  }
  return false;
}

/**
 * Each used model against a provider's listing: offered when listed (by id or
 * a listed alias), unknown when the listing was truncated or the id looks like
 * an alias of something listed, missing otherwise.
 *
 * @param {string[]} used
 * @param {{ ids: Iterable<string>, truncated?: boolean }} listing
 */
function compareModels(used, listing) {
  const offered = new Set([...listing.ids].map(norm).filter(Boolean));
  return Object.fromEntries(
    used.map((model) => {
      const id = norm(model);
      if (offered.has(id)) return [model, "offered"];
      if (listing.truncated || nearMatch(id, offered)) return [model, "unknown"];
      return [model, "missing"];
    })
  );
}

/** `{ data: [{ id, aliases? }] }`: OpenAI, Groq, Mistral, OpenRouter, Tinfoil. */
function openAiListing(data, { aliases = false } = {}) {
  if (!Array.isArray(data?.data)) return null;
  const ids = [];
  for (const entry of data.data) {
    if (typeof entry?.id === "string") ids.push(entry.id);
    if (aliases && Array.isArray(entry?.aliases)) {
      for (const alias of entry.aliases) if (typeof alias === "string") ids.push(alias);
    }
  }
  return { ids, truncated: false };
}

// ── Transport ────────────────────────────────────────────────────────────────

function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return async function run(task) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function transportError(checkCode) {
  const error = new Error(`Connection check transport failed (${checkCode})`);
  error.checkCode = checkCode;
  if (checkCode === "timeout") error.name = "TimeoutError";
  return error;
}

function classifyThrown(error) {
  if (error?.checkCode) return error;
  if (openWhisprCloudGate.isCloudDisabledError(error)) return transportError("cloud");
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return transportError("timeout");
  }
  if (/net::ERR_(?:CONNECTION_)?TIMED_OUT/.test(String(error?.message || ""))) {
    return transportError("timeout");
  }
  return transportError("network");
}

function cancelBody(response) {
  try {
    const cancelled = response?.body?.cancel?.();
    if (cancelled && typeof cancelled.catch === "function") cancelled.catch(() => {});
  } catch {
    // Already read or not a stream.
  }
}

async function readText(response, limit) {
  const text = await response.text();
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * One request as a check makes it: proxy-aware fetch on its own cookie-less
 * session (`fetchImpl`), manual redirects followed only within the same
 * origin, an 8 s timeout covering the body, at most `maxConcurrent` at once,
 * and the Cloud switch's gate. `read` picks what is kept of the answer:
 * "json" (parsed when OK, a short error text otherwise), "status" (a short
 * error text only) or "none" (nothing: the body is cancelled unread).
 */
function createTransport({ fetchImpl, cloudGate, timeoutMs, semaphore }) {
  return async function request(url, { method = "GET", headers = {}, body, read = "status" } = {}) {
    cloudGate.assertCloudAllowed(url, "connection check");
    return semaphore(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let current = url;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          let response;
          try {
            response = await fetchImpl(current, {
              method,
              headers: { Accept: "application/json", ...headers },
              ...(body !== undefined ? { body } : {}),
              redirect: "manual",
              signal: controller.signal,
            });
          } catch (error) {
            throw classifyThrown(error);
          }
          const status = Number(response?.status) || 0;
          if (response?.type === "opaqueredirect" || status === 0) {
            cancelBody(response);
            throw transportError("redirect");
          }
          if (status >= 300 && status < 400) {
            const location = response.headers?.get?.("location");
            cancelBody(response);
            let next;
            try {
              next = new URL(location, current);
            } catch {
              throw transportError("redirect");
            }
            // Credentials never follow a redirect to another origin.
            if (!location || next.origin !== new URL(current).origin) {
              throw transportError("redirect");
            }
            cloudGate.assertCloudAllowed(next.href, "connection check");
            current = next.href;
            continue;
          }
          const ok = status >= 200 && status < 300;
          const result = { status, ok, headers: response.headers, data: undefined, text: "" };
          try {
            if (read === "none") cancelBody(response);
            else if (ok && read === "json") {
              const text = await readText(response, MAX_BODY_CHARS);
              try {
                result.data = JSON.parse(text);
              } catch {
                result.data = undefined;
              }
            } else if (!ok) {
              result.text = await readText(response, MAX_ERROR_CHARS);
            } else {
              cancelBody(response);
            }
          } catch (error) {
            if (controller.signal.aborted) throw transportError("timeout");
            if (ok) result.data = undefined;
            else throw classifyThrown(error);
          }
          return result;
        }
        throw transportError("redirect");
      } finally {
        clearTimeout(timer);
      }
    });
  };
}

// ── Probes ───────────────────────────────────────────────────────────────────

const bearer = (key) => ({ Authorization: `Bearer ${key}` });

/** A list of models behind the key: accepted on 200, compared where the ids are trustworthy. */
async function probeModelList(ctx, { url, headers, listing = null }) {
  const response = await ctx.request(url, { headers, read: listing ? "json" : "status" });
  if (!response.ok)
    return { ...httpFailure(response.status, response.text), httpStatus: response.status };
  const accepted = {
    reachable: true,
    credentials: "accepted",
    httpStatus: response.status,
    code: CHECK_CODES.OK,
  };
  if (!listing || ctx.descriptor.models.length === 0) return accepted;
  const parsed = listing(response.data);
  if (!parsed) return { ...accepted, code: CHECK_CODES.MALFORMED };
  return { ...accepted, models: compareModels(ctx.descriptor.models, parsed) };
}

async function probeGemini(ctx) {
  const ids = [];
  let pageToken = "";
  let first = null;
  let truncated = false;
  for (let page = 0; page < GEMINI_MAX_PAGES; page += 1) {
    const query = `pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    let response;
    try {
      response = await ctx.request(`${ctx.descriptor.route}/models?${query}`, {
        headers: { "x-goog-api-key": ctx.key },
        read: "json",
      });
    } catch (error) {
      if (page === 0) throw error;
      truncated = true;
      break;
    }
    if (!response.ok) {
      if (page === 0) {
        // Google rejects a bad key with 400 API_KEY_INVALID; the classifier reads it.
        return { ...httpFailure(response.status, response.text), httpStatus: response.status };
      }
      truncated = true;
      break;
    }
    first ??= response;
    const models = response.data?.models;
    if (!Array.isArray(models)) {
      if (page === 0) {
        return {
          reachable: true,
          credentials: "accepted",
          httpStatus: response.status,
          code: CHECK_CODES.MALFORMED,
        };
      }
      truncated = true;
      break;
    }
    for (const model of models) {
      if (typeof model?.name === "string") ids.push(model.name);
      if (typeof model?.baseModelId === "string") ids.push(model.baseModelId);
    }
    pageToken = typeof response.data?.nextPageToken === "string" ? response.data.nextPageToken : "";
    if (!pageToken) break;
    if (page === GEMINI_MAX_PAGES - 1) truncated = true;
  }
  return {
    reachable: true,
    credentials: "accepted",
    httpStatus: first?.status ?? 200,
    code: CHECK_CODES.OK,
    models: compareModels(ctx.descriptor.models, { ids, truncated }),
  };
}

/**
 * OpenRouter's key-info route, never /credits (that needs a management key):
 * a management key is refused for requests, and a key's own spending limit
 * shows only when it has one (`limit: null` is unlimited). Models come from
 * the public list, without the key.
 */
async function probeOpenRouter(ctx) {
  const { route } = ctx.descriptor;
  const response = await ctx.request(`${route}/key`, { headers: bearer(ctx.key), read: "json" });
  if (!response.ok)
    return { ...httpFailure(response.status, response.text), httpStatus: response.status };
  const info = response.data?.data;
  const base = { reachable: true, httpStatus: response.status };
  if (!info || typeof info !== "object") {
    return { ...base, credentials: "accepted", code: CHECK_CODES.MALFORMED };
  }
  if (info.is_management_key === true || info.is_provisioning_key === true) {
    return { ...base, credentials: "rejected", code: CHECK_CODES.MANAGEMENT_KEY };
  }
  let limit;
  let code = CHECK_CODES.OK;
  if (typeof info.limit === "number" && Number.isFinite(info.limit)) {
    const remaining =
      typeof info.limit_remaining === "number" && Number.isFinite(info.limit_remaining)
        ? info.limit_remaining
        : null;
    const reached = remaining !== null && remaining <= 0;
    limit = { amount: info.limit, remaining, reached };
    if (reached) code = CHECK_CODES.LIMIT_REACHED;
  }
  let models;
  if (ctx.descriptor.models.length > 0) {
    try {
      const list = await ctx.request(`${route}/models`, { read: "json" });
      const parsed = list.ok ? openAiListing(list.data) : null;
      if (parsed) models = compareModels(ctx.descriptor.models, parsed);
    } catch {
      // The key was answered; the public list only adds the model comparison.
    }
  }
  return {
    ...base,
    credentials: "accepted",
    code,
    ...(limit ? { limit } : {}),
    ...(models ? { models } : {}),
  };
}

/** xAI's key-info route: a blocked or disabled key (or team) counts as rejected. */
async function probeXai(ctx) {
  const response = await ctx.request(`${ctx.descriptor.route}/api-key`, {
    headers: bearer(ctx.key),
    read: "json",
  });
  if (!response.ok)
    return { ...httpFailure(response.status, response.text), httpStatus: response.status };
  const info = response.data;
  const base = { reachable: true, httpStatus: response.status };
  if (!info || typeof info !== "object") {
    return { ...base, credentials: "accepted", code: CHECK_CODES.MALFORMED };
  }
  if (
    info.api_key_blocked === true ||
    info.api_key_disabled === true ||
    info.team_blocked === true
  ) {
    return { ...base, credentials: "rejected", code: CHECK_CODES.KEY_BLOCKED };
  }
  return { ...base, credentials: "accepted", code: CHECK_CODES.OK };
}

/** AssemblyAI lists recordings' metadata here: the status only, the body cancelled unread. */
async function probeAssemblyAi(ctx) {
  const response = await ctx.request(`${ctx.descriptor.route}/transcript?limit=1`, {
    headers: { Authorization: ctx.key },
    read: "none",
  });
  if (!response.ok) return { ...httpFailure(response.status, ""), httpStatus: response.status };
  return {
    reachable: true,
    credentials: "accepted",
    httpStatus: response.status,
    code: CHECK_CODES.OK,
  };
}

/** The key and the resource; MAI-Transcribe-2 itself is checked when you dictate. */
async function probeAzureSpeech(ctx) {
  const url =
    `${ctx.descriptor.route}/speechtotext/models/base` +
    `?api-version=${AZURE_SPEECH_MODELS_API_VERSION}&top=1`;
  const response = await ctx.request(url, {
    headers: { "Ocp-Apim-Subscription-Key": ctx.key },
    read: "status",
  });
  if (!response.ok)
    return { ...httpFailure(response.status, response.text), httpStatus: response.status };
  return {
    reachable: true,
    credentials: "accepted",
    httpStatus: response.status,
    code: CHECK_CODES.OK,
  };
}

/**
 * Tinfoil's model list is public, so the attested client proves the enclave
 * is reachable and lists models, but not the key, which is never sent there.
 */
async function probeTinfoil(ctx) {
  const response = await ctx.tinfoil("/v1/models");
  const base = { proof: "reachability", credentials: "unknown" };
  if (!response.ok) {
    const failure = httpFailure(response.status, "", { keySent: false });
    return { ...base, ...failure, credentials: "unknown", httpStatus: response.status };
  }
  const parsed = openAiListing(response.data);
  return {
    ...base,
    reachable: true,
    httpStatus: response.status,
    code: CHECK_CODES.NOT_VERIFIABLE,
    ...(parsed && ctx.descriptor.models.length > 0
      ? { models: compareModels(ctx.descriptor.models, parsed) }
      : {}),
  };
}

/** Corti speech-to-text: the client-credentials token request, fresh on an explicit Check. */
async function probeCortiStt(ctx) {
  const [, environment, tenant] = CORTI_AUTH_ROUTE.exec(ctx.descriptor.route);
  let lastStatus = 0;
  let lastText = "";
  // cortiAuth's fetch: the check's transport. The token endpoint's error text
  // is kept here to classify the answer, never handed to cortiAuth's message.
  const fetchAdapter = async (url, init) => {
    const response = await ctx.request(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      read: "json",
    });
    lastStatus = response.status;
    lastText = response.text;
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.data,
      text: async () => "",
    };
  };
  try {
    await ctx.cortiToken(
      { environment, tenant, clientId: ctx.key.clientId, clientSecret: ctx.key.clientSecret },
      fetchAdapter,
      { fresh: ctx.deep }
    );
    return {
      reachable: true,
      credentials: "accepted",
      ...(lastStatus ? { httpStatus: lastStatus } : {}),
      code: CHECK_CODES.OK,
    };
  } catch (error) {
    if (error?.checkCode) throw error;
    const status = typeof error?.status === "number" ? error.status : 0;
    if (!status) {
      // Answered 200 without a token.
      return {
        reachable: true,
        credentials: "unknown",
        ...(lastStatus ? { httpStatus: lastStatus } : {}),
        code: CHECK_CODES.MALFORMED,
      };
    }
    // Keycloak answers bad client credentials 400/401 (invalid_client).
    if (status === 400 || status === 401) {
      return { reachable: true, credentials: "rejected", httpStatus: status, code: C.AUTH_FAILED };
    }
    return { ...httpFailure(status, lastText), httpStatus: status };
  }
}

/**
 * The custom connection: main's own check operation (customConnectionIpc.js),
 * adapted. Deployment ids are compared on Azure when the resource listed them
 * in full; otherwise the models stay unknown. The catalog is never returned.
 */
async function probeCustomConnection(ctx) {
  const target = validateEndpoint(ctx.descriptor.route);
  const request = async (url, headers) => {
    const deployments = url.includes("/openai/deployments");
    const response = await ctx.request(url, { headers, read: deployments ? "json" : "status" });
    return { ok: response.ok, status: response.status, json: async () => response.data };
  };
  ctx.cloudGate.assertCloudAllowed(target.languageBase, "connection check");
  const outcome = await runCustomEndpointCheck({ target, key: ctx.key, request });
  const httpStatus = outcome.httpStatus;
  if (outcome.status === "auth") {
    return httpStatus === 403
      ? { reachable: true, credentials: "unknown", httpStatus, code: C.ACCESS_DENIED }
      : { reachable: true, credentials: "rejected", httpStatus, code: C.AUTH_FAILED };
  }
  if (outcome.status === "network") {
    if (!httpStatus) {
      return outcome.timedOut
        ? { reachable: false, credentials: "unknown", code: C.TIMEOUT }
        : { reachable: false, credentials: "unknown", code: C.UNREACHABLE };
    }
    return { ...httpFailure(httpStatus, ""), httpStatus };
  }
  const result = { reachable: true, credentials: "accepted", code: CHECK_CODES.OK };
  if (target.kind === "azure" && outcome.discovery === "listed" && !outcome.truncated) {
    const ids = (outcome.deployments ?? []).map((deployment) => deployment.id);
    // Deployment names, as features send them: exact, ignoring case.
    const offered = new Set(ids.map((id) => id.toLowerCase()));
    result.models = Object.fromEntries(
      ctx.descriptor.models.map((model) => [
        model,
        offered.has(model.toLowerCase()) ? "offered" : "missing",
      ])
    );
  }
  return result;
}

/** A feature's own custom endpoint (with its slot's key) or self-hosted server (no key). */
async function probeEndpoint(ctx) {
  const keySent = !!ctx.key;
  const selfHosted = ctx.descriptor.kind === "selfHosted";
  const response = await ctx.request(`${ctx.descriptor.route}/models`, {
    headers: keySent ? bearer(ctx.key) : {},
    read: "status",
  });
  const proof = keySent ? "key" : "reachability";
  if (!response.ok) {
    // A server without a model list still answered.
    if (response.status === 404 && selfHosted) {
      return {
        proof,
        reachable: true,
        credentials: "unknown",
        httpStatus: 404,
        code: CHECK_CODES.OK,
      };
    }
    return {
      proof,
      ...httpFailure(response.status, response.text, { keySent, selfHosted }),
      httpStatus: response.status,
    };
  }
  return {
    proof,
    reachable: true,
    credentials: keySent ? "accepted" : "unknown",
    httpStatus: response.status,
    code: CHECK_CODES.OK,
  };
}

/**
 * GitHub Copilot. Automatic: the stored token against GitHub's user route, an
 * identity ("Signed in"). An explicit Check also asks Copilot for the plan's
 * models (fresh), which proves Copilot access and compares the models in use.
 */
async function probeCopilot(ctx) {
  const response = await ctx.request(`${ctx.descriptor.route}/user`, {
    headers: {
      ...bearer(ctx.key),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "OpenWhispr",
    },
    read: "status",
  });
  if (!response.ok) {
    const remaining = response.headers?.get?.("x-ratelimit-remaining");
    if ((response.status === 403 || response.status === 429) && remaining === "0") {
      return {
        proof: "identity",
        reachable: true,
        credentials: "unknown",
        httpStatus: response.status,
        code: C.RATE_LIMITED,
      };
    }
    return {
      proof: "identity",
      ...httpFailure(response.status, response.text),
      httpStatus: response.status,
    };
  }
  const identity = {
    proof: "identity",
    reachable: true,
    credentials: "accepted",
    httpStatus: response.status,
    code: CHECK_CODES.OK,
  };
  const runtime = ctx.copilot?.runtime;
  if (!ctx.deep || !runtime) return identity;
  let timer;
  try {
    const models = await Promise.race([
      runtime.listModels({ refresh: true }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("timeout"), { code: "COPILOT_TIMEOUT" })),
          ctx.copilotDeadlineMs
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const ids = Array.isArray(models) ? models.map((model) => model?.id).filter(Boolean) : [];
    return {
      ...identity,
      proof: "service",
      models: compareModels(ctx.descriptor.models, { ids, truncated: false }),
    };
  } catch (error) {
    const classified = copilotProviderError(error);
    const code = classified?.code ?? C.ERROR;
    if (code === C.AUTH_FAILED) ctx.copilot?.auth?.reportTokenRejected?.();
    const base = { proof: "service", httpStatus: response.status };
    if (code === C.AUTH_FAILED) return { ...base, reachable: true, credentials: "rejected", code };
    if (code === C.UNAVAILABLE || code === C.TIMEOUT) {
      return { ...base, reachable: false, credentials: "accepted", code };
    }
    return { ...base, reachable: true, credentials: "accepted", code };
  }
}

const PROBES = {
  openai: (ctx) =>
    probeModelList(ctx, {
      url: `${ctx.descriptor.route}/models`,
      headers: bearer(ctx.key),
      listing: (data) => openAiListing(data),
    }),
  groq: (ctx) =>
    probeModelList(ctx, {
      url: `${ctx.descriptor.route}/models`,
      headers: bearer(ctx.key),
      listing: (data) => openAiListing(data),
    }),
  mistral: (ctx) =>
    probeModelList(ctx, {
      url: `${ctx.descriptor.route}/models`,
      headers: bearer(ctx.key),
      listing: (data) => openAiListing(data, { aliases: true }),
    }),
  // Aliases and dated ids differ: models aren't compared.
  anthropic: (ctx) =>
    probeModelList(ctx, {
      url: `${ctx.descriptor.route}/models`,
      headers: { "x-api-key": ctx.key, "anthropic-version": "2023-06-01" },
    }),
  "corti-llm": (ctx) =>
    probeModelList(ctx, { url: `${ctx.descriptor.route}/models`, headers: bearer(ctx.key) }),
  deepgram: (ctx) =>
    probeModelList(ctx, {
      url: `${ctx.descriptor.route}/projects`,
      headers: { Authorization: `Token ${ctx.key}` },
    }),
  gemini: probeGemini,
  openrouter: probeOpenRouter,
  xai: probeXai,
  assemblyai: probeAssemblyAi,
  "azure-speech": probeAzureSpeech,
  tinfoil: probeTinfoil,
  "corti-stt": probeCortiStt,
  custom: probeCustomConnection,
  endpoint: probeEndpoint,
  selfHosted: probeEndpoint,
  copilot: probeCopilot,
};

// ── The queue ────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {(slot: string) => string | { clientId: string, clientSecret: string }} deps.readSecret
 * @param {(url: string, init: object) => Promise<Response>} deps.fetchImpl  proxy-aware, cookie-less
 * @param {(path: string, init: object) => Promise<Response>} [deps.tinfoilFetch]  the attested client
 * @param {{ runtime?: { listModels: Function }, auth?: { reportTokenRejected: Function } } | null} [deps.copilot]
 * @param {Function} [deps.cortiToken]  cortiAuth.getCortiToken
 * @param {(payload: object) => void} [deps.emit]  `connection-check-result`
 */
function createConnectionChecks({
  readSecret,
  fetchImpl,
  tinfoilFetch = null,
  copilot = null,
  cortiToken = null,
  cloudGate = openWhisprCloudGate,
  logger = null,
  emit = () => {},
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxConcurrent = MAX_CONCURRENT_REQUESTS,
  copilotDeadlineMs = COPILOT_DEADLINE_MS,
  env = process.env,
}) {
  const semaphore = createSemaphore(maxConcurrent);
  const request = createTransport({ fetchImpl, cloudGate, timeoutMs, semaphore });
  const cache = new Map();
  const inflight = new Map();
  const latest = new Map();
  const sourceGenerations = new Map();

  const credentialGeneration = (slot) =>
    slot ? sourcesOf(slot).reduce((sum, name) => sum + (sourceGenerations.get(name) ?? 0), 0) : 0;

  // Tinfoil's attested client returns a fetch Response: the same timeout and
  // concurrency, the JSON list kept only to compare models.
  async function tinfoil(path) {
    if (!tinfoilFetch) throw transportError("network");
    return semaphore(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response;
        try {
          response = await tinfoilFetch(path, { method: "GET", signal: controller.signal });
        } catch (error) {
          throw classifyThrown(error);
        }
        const status = Number(response?.status) || 0;
        const ok = status >= 200 && status < 300;
        let data;
        if (ok) {
          try {
            data = JSON.parse(await readText(response, MAX_BODY_CHARS));
          } catch {
            data = undefined;
          }
        } else cancelBody(response);
        return { status, ok, data };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  function log(descriptor, result) {
    logger?.debug?.(
      "Connection check finished",
      { kind: descriptor.kind, code: result.code, httpStatus: result.httpStatus ?? null },
      "connection-checks"
    );
  }

  async function probe(job) {
    const { descriptor } = job;
    const key = descriptor.slot ? readSecret(descriptor.slot) : "";
    if (descriptor.slot && !hasKey(key) && descriptor.kind !== "endpoint") {
      return makeResult(descriptor, { code: CHECK_CODES.NO_KEY }, now);
    }
    const ctx = {
      descriptor,
      key,
      deep: job.deep,
      request,
      tinfoil,
      copilot,
      cortiToken: cortiToken ?? require("./cortiAuth").getCortiToken,
      cloudGate,
      copilotDeadlineMs,
    };
    try {
      const fields = await PROBES[descriptor.kind](ctx);
      return makeResult(descriptor, fields, now);
    } catch (error) {
      if (cloudGate.isCloudDisabledError?.(error)) {
        return makeResult(descriptor, transportFailure(transportError("cloud")), now);
      }
      return makeResult(descriptor, transportFailure(classifyThrown(error)), now);
    }
  }

  function current(job) {
    return (
      latest.get(job.descriptor.id) === job.descriptor.generation &&
      credentialGeneration(job.descriptor.slot) === job.credentialGeneration
    );
  }

  function execute(job) {
    const { descriptor } = job;
    return probe(job).then((result) => {
      const stillQueued = inflight.get(descriptor.id) === job;
      if (stillQueued) inflight.delete(descriptor.id);
      if (!current(job)) {
        // Its route, models or key changed while it ran: an answer about
        // something no longer shown. A newer job, if any, reports for it.
        if (stillQueued) {
          emit({ id: descriptor.id, generation: descriptor.generation, dropped: true });
        }
        return;
      }
      cache.set(descriptor.id, {
        slot: descriptor.slot,
        route: descriptor.route,
        generation: descriptor.generation,
        credentialGeneration: job.credentialGeneration,
        result,
      });
      log(descriptor, result);
      emit({ id: descriptor.id, generation: descriptor.generation, result });
    });
  }

  function enqueue(descriptor, fresh) {
    const credential = credentialGeneration(descriptor.slot);
    const deep = fresh && DEEP_KINDS.has(descriptor.kind);
    const running = inflight.get(descriptor.id);
    if (
      running &&
      running.descriptor.generation === descriptor.generation &&
      running.credentialGeneration === credential &&
      (running.deep || !deep)
    ) {
      return running;
    }
    const job = { descriptor, credentialGeneration: credential, deep };
    inflight.set(descriptor.id, job);
    job.promise = execute(job).catch(() => {
      // Never leave a renderer waiting on an answer that won't come.
      if (inflight.get(descriptor.id) === job) {
        inflight.delete(descriptor.id);
        emit({ id: descriptor.id, generation: descriptor.generation, dropped: true });
      }
    });
    return job;
  }

  /**
   * `connection-checks-run`: results younger than `maxAgeMs` (and still
   * fenced) come back at once; the rest are queued and streamed. `fresh` (an
   * explicit Check) skips the cache.
   */
  function run(input) {
    const descriptors = Array.isArray(input?.descriptors)
      ? input.descriptors.slice(0, MAX_DESCRIPTORS)
      : [];
    const maxAgeMs = Number.isFinite(input?.maxAgeMs) ? Math.max(0, input.maxAgeMs) : 0;
    const fresh = input?.fresh === true;
    const results = {};
    const pending = [];
    for (const raw of descriptors) {
      const validated = validateDescriptor(raw, env);
      if (!validated.id) continue;
      if (!validated.ok) {
        results[validated.id] = {
          reachable: false,
          credentials: "unknown",
          models: {},
          proof: "key",
          code: CHECK_CODES.INVALID_ROUTE,
          checkedAt: now(),
          generation: validated.generation,
        };
        continue;
      }
      const { descriptor } = validated;
      latest.set(descriptor.id, descriptor.generation);
      const cached = cache.get(descriptor.id);
      if (
        !fresh &&
        cached &&
        cached.generation === descriptor.generation &&
        cached.credentialGeneration === credentialGeneration(descriptor.slot) &&
        now() - cached.result.checkedAt <= maxAgeMs
      ) {
        results[descriptor.id] = cached.result;
        continue;
      }
      enqueue(descriptor, fresh);
      pending.push(descriptor.id);
    }
    return { results, pending };
  }

  function invalidate(predicate) {
    for (const [id, entry] of cache) {
      if (!predicate(entry)) continue;
      cache.delete(id);
      emit({ id, invalidated: true });
    }
  }

  /** environment.js's onSecretChanged: a key written, copied or removed. */
  function noteSecretsChanged(change) {
    const names = Array.isArray(change?.names) ? change.names : [];
    for (const name of names) sourceGenerations.set(name, (sourceGenerations.get(name) ?? 0) + 1);
    if (change?.all) {
      invalidate(() => true);
      return;
    }
    const touched = new Set(names);
    invalidate((entry) => !!entry.slot && sourcesOf(entry.slot).some((name) => touched.has(name)));
  }

  /** The Cloud switch: results for routes it governs no longer hold. */
  function noteCloudSwitch() {
    invalidate((entry) => cloudGate.isBlockedUrl?.(entry.route) === true);
  }

  return {
    run,
    noteSecretsChanged,
    noteCloudSwitch,
    /** Resolves once every queued check has settled (tests, shutdown). */
    idle: () => Promise.all([...inflight.values()].map((job) => job.promise)),
  };
}

module.exports = {
  CHECK_CODES,
  FIXED_ROUTES,
  KIND_SLOTS,
  REQUEST_TIMEOUT_MS,
  MAX_CONCURRENT_REQUESTS,
  compareModels,
  createConnectionChecks,
  createSecretReader,
  sourcesOf,
  validateDescriptor,
};
