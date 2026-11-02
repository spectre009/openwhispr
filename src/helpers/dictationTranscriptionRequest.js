// Live dictation's batch transcription request (OpenAI, Groq, custom endpoints,
// self-hosted servers, Azure Speech), sent from main. The dictation window
// chooses the route, builds the prompt and keywords (or Azure's definition),
// converts the audio and parses the answer; it hands main the request
// (endpoint, headers, form fields, the audio part's name, audio bytes, length)
// under a request id.
//
// - Its own connection pool (`ow-dictation-stt`), used for nothing else, so
//   resetting it can never touch chat, cleanup or another window's requests.
// - A client deadline per attempt (transcriptionRequestDeadline.js) covering
//   the whole exchange; a streamed (SSE) answer also times out after 15 s
//   without data, and a terminal event completes it even if the server keeps
//   the connection open.
// - One retry, only when our own deadline fired before any part of the answer
//   arrived (no body byte, no transcript event; never after an HTTP error).
//   Over HTTP/2 an abort resets only its stream, so main awaits
//   closeAllConnections() on the pool first: the dead connection is gone for
//   the retry and for the next dictation. A timeout that isn't retried resets
//   the pool too.
// - A cancel (the dictation window's request id, or the window going away)
//   aborts either attempt or the wait between them; a cancelled request never
//   retries and never reports. Cancel and timeout are told apart by which
//   signal fired, never by the error's name.
// - Once it's over, its outcome goes to Settings › AI Connections' "Last
//   recorded use" (connectionOutcomes.js) under the tag it came with: OK, the
//   HTTP status's code (also when the IPC answers `success: true` around it)
//   or the failure's; never on a cancel.
//
// Logs carry the endpoint, attempt, deadline, elapsed time and bytes sent:
// never headers, fields or the answer.

const crypto = require("crypto");
const {
  TRANSCRIPTION_STREAM_IDLE_MS,
  isLocalTranscriptionEndpoint,
  transcriptionRequestDeadlineMs,
  transcriptionRequestTimeoutError,
} = require("./transcriptionRequestDeadline.js");
const { asProviderError, providerHttpError } = require("./providerHttpErrors");
const { requestOutcomeOfFailure } = require("./connectionOutcomeTargets.js");
const { ipcErrorFields } = require("./ipcErrorFields");
const { createTranscriptionEventParser } = require("./transcriptionEventStream");
const AgentStreamRequestRegistry = require("./agentStreamRequestRegistry");
const {
  AZURE_SPEECH_KEY_HEADER,
  AZURE_SPEECH_PROVIDER_ID,
  isAzureSpeechTranscribeUrl,
} = require("./azureSpeechTranscription.js");

const DICTATION_STT_PARTITION = "ow-dictation-stt";
// History's Re-transcribe: its own pool, so a live dictation's reset can't cut it.
const HISTORY_STT_PARTITION = "ow-history-stt";
const MAX_ATTEMPTS = 2;
// Live checks against a local server: give it the hosted budget.
const TEST_HOSTED_DEADLINE_ENV = "OPENWHISPR_TEST_HOSTED_STT_DEADLINE";
const AZURE_SPEECH_KEY = AZURE_SPEECH_KEY_HEADER.toLowerCase();
const ALLOWED_REQUEST_HEADERS = new Set(["authorization", "api-key", AZURE_SPEECH_KEY]);
// The audio part's name: OpenAI-compatible servers read `file`, Azure Speech `audio`.
const AUDIO_PARTS = new Set(["file", "audio"]);
// What the renderer's error classification reads; nothing else crosses back.
const RESPONSE_HEADERS = [
  "content-type",
  "x-request-id",
  "request-id",
  "apim-request-id",
  "cf-ray",
  "retry-after",
];
// A form part's boundary and headers, roughly; the allowance is in seconds.
const MULTIPART_PART_OVERHEAD_BYTES = 160;

const textEncoder = new TextEncoder();

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function shortString(value, max = 200) {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

/**
 * Validates a renderer request: an http(s) endpoint, only the auth headers,
 * string form fields, the audio as bytes and its part's name (`file` or
 * `audio`). Azure Speech's key goes only to the transcribe operation on a
 * Speech resource (isAzureSpeechTranscribeUrl), alone: a request pairing it
 * with any other endpoint is refused, whoever built it.
 */
function transcriptionRequestFrom(payload) {
  if (!payload || typeof payload !== "object") {
    throw new TypeError("Invalid transcription request");
  }
  let url;
  try {
    url = new URL(payload.endpoint);
  } catch {
    throw new TypeError("Invalid transcription endpoint");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Invalid transcription endpoint");
  }
  const bytes = toBytes(payload.file?.bytes);
  if (!bytes) throw new TypeError("Transcription request has no audio");
  const audioPart = payload.audioPart ?? "file";
  if (!AUDIO_PARTS.has(audioPart)) throw new TypeError("Invalid audio part");
  let headers = {};
  for (const [name, value] of Object.entries(payload.headers || {})) {
    if (ALLOWED_REQUEST_HEADERS.has(name.toLowerCase()) && typeof value === "string") {
      headers[name] = value;
    }
  }
  const azureKey = Object.keys(headers).find((name) => name.toLowerCase() === AZURE_SPEECH_KEY);
  if (azureKey) {
    if (!isAzureSpeechTranscribeUrl(payload.endpoint)) {
      throw new TypeError("Azure Speech requests go only to a Speech resource");
    }
    headers = { [AZURE_SPEECH_KEY_HEADER]: headers[azureKey] };
  }
  const fields = (Array.isArray(payload.fields) ? payload.fields : []).filter(
    (field) =>
      Array.isArray(field) &&
      field.length === 2 &&
      typeof field[0] === "string" &&
      typeof field[1] === "string"
  );
  const context = payload.errorContext || {};
  return {
    endpoint: payload.endpoint,
    headers,
    fields,
    audioPart,
    file: {
      bytes,
      name: shortString(payload.file?.name) || "audio.webm",
      type: shortString(payload.file?.type) || "application/octet-stream",
    },
    audioSeconds:
      Number.isFinite(payload.audioSeconds) && payload.audioSeconds > 0
        ? payload.audioSeconds
        : null,
    stream: payload.stream === true,
    selfHosted: payload.selfHosted === true,
    errorContext: {
      provider: shortString(context.provider) || "OpenAI",
      ...(context.providerId === AZURE_SPEECH_PROVIDER_ID
        ? { providerId: AZURE_SPEECH_PROVIDER_ID }
        : {}),
      selfHosted: context.selfHosted === true,
      model: shortString(context.model),
      surface: "transcription",
    },
  };
}

function requestBytes(request) {
  let total = request.file.bytes.byteLength + MULTIPART_PART_OVERHEAD_BYTES;
  for (const [name, value] of request.fields) {
    total += textEncoder.encode(name).length + textEncoder.encode(value).length;
    total += MULTIPART_PART_OVERHEAD_BYTES;
  }
  return total;
}

// Built per attempt: a body can only be read once.
function buildForm(request) {
  const form = new FormData();
  form.append(
    request.audioPart || "file",
    new Blob([request.file.bytes], { type: request.file.type }),
    request.file.name
  );
  for (const [name, value] of request.fields) form.append(name, value);
  return form;
}

function pickHeaders(headers) {
  const picked = {};
  if (!headers) return picked;
  for (const name of RESPONSE_HEADERS) {
    const value =
      typeof headers.get === "function"
        ? headers.get(name)
        : (headers[name] ?? headers[name.toLowerCase()]);
    if (typeof value === "string" && value) picked[name] = value;
  }
  return picked;
}

// Reads the body as text, chunk by chunk. `onChunk` returning true stops
// reading (a terminal event) and releases the stream.
async function readBody(response, onChunk) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = typeof response.text === "function" ? await response.text() : "";
    if (text) onChunk(text);
    return;
  }
  const decoder = new TextDecoder("utf-8");
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      const tail = decoder.decode();
      if (tail) onChunk(tail);
      return;
    }
    if (!value || value.byteLength === 0) continue;
    if (onChunk(decoder.decode(value, { stream: true })) === true) {
      reader.cancel().catch(() => {});
      return true;
    }
  }
}

async function runAttempt({
  request,
  fetch,
  cancelSignal,
  deadlineMs,
  idleMs,
  setTimer,
  clearTimer,
}) {
  if (cancelSignal?.aborted) return { kind: "cancelled" };
  const controller = new AbortController();
  // Which of our own timers aborted the attempt, if any.
  let timeout = null;
  let stage = "request";
  let answerStarted = false;
  let httpError = false;
  let idleTimer = null;

  const onCancel = () => controller.abort();
  cancelSignal?.addEventListener("abort", onCancel, { once: true });
  const deadlineTimer = setTimer(() => {
    timeout = timeout ?? "deadline";
    controller.abort();
  }, deadlineMs);
  const armIdle = () => {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      timeout = timeout ?? "idle";
      controller.abort();
    }, idleMs);
  };
  // Cancel wins over a timeout that fired at the same moment.
  const abortedOutcome = () => {
    if (cancelSignal?.aborted) return { kind: "cancelled", stage };
    if (timeout) {
      return { kind: "timeout", timeout, stage, retryable: !answerStarted && !httpError };
    }
    return null;
  };

  try {
    const response = await fetch(request.endpoint, {
      method: "POST",
      headers: { ...request.headers },
      body: buildForm(request),
      signal: controller.signal,
    });
    stage = "response";
    const status = response.status;
    const ok = typeof response.ok === "boolean" ? response.ok : status >= 200 && status < 300;
    const headers = pickHeaders(response.headers);
    const statusText = typeof response.statusText === "string" ? response.statusText : "";
    const answer = { ok, status, statusText, headers };

    if (!ok) {
      httpError = true;
      const parts = [];
      try {
        await readBody(response, (chunk) => {
          parts.push(chunk);
        });
      } catch (error) {
        const aborted = abortedOutcome();
        if (aborted?.kind === "cancelled") return aborted;
        // The status is the answer: a stalled error body is never retried.
        if (aborted) return { kind: "response", response: { ...answer, body: "" }, stalled: true };
        throw error;
      }
      return { kind: "response", response: { ...answer, body: parts.join("") } };
    }

    if (request.stream && (headers["content-type"] || "").includes("text/event-stream")) {
      stage = "events";
      const parser = createTranscriptionEventParser();
      armIdle();
      const stopped = await readBody(response, (chunk) => {
        armIdle();
        const done = parser.push(chunk);
        answerStarted = parser.started;
        return done;
      });
      if (!stopped) parser.end();
      // A terminal event without EOF: release the stream the server kept open.
      if (stopped) controller.abort();
      return {
        kind: "response",
        response: { ...answer, streamed: true, text: parser.text(), stats: parser.stats() },
      };
    }

    stage = "body";
    const parts = [];
    await readBody(response, (chunk) => {
      answerStarted = true;
      parts.push(chunk);
    });
    return { kind: "response", response: { ...answer, body: parts.join("") } };
  } catch (error) {
    return abortedOutcome() ?? { kind: "error", error };
  } finally {
    clearTimer(deadlineTimer);
    if (idleTimer) clearTimer(idleTimer);
    cancelSignal?.removeEventListener("abort", onCancel);
  }
}

/**
 * Sends one logical transcription request: up to two attempts, the second
 * only after our own deadline fired before any answer, on a reset pool.
 * Resolves `{ cancelled: true }`, or the answer `{ ok, status, statusText,
 * headers, body }` / `{ ok, status, ..., streamed: true, text }` with
 * `attempts`; rejects with a classified error (a timeout is PROVIDER_TIMEOUT).
 */
async function runTranscriptionRequest({
  request,
  fetch,
  resetPool = async () => {},
  cancelSignal = null,
  local = false,
  logger = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  deadlineFor = transcriptionRequestDeadlineMs,
  idleMs = TRANSCRIPTION_STREAM_IDLE_MS,
}) {
  const bytesSent = requestBytes(request);
  const log = (level, message, meta) => {
    try {
      logger?.[level]?.(message, meta, "transcription");
    } catch {
      // Logging never costs a dictation.
    }
  };
  const resetConnections = async () => {
    try {
      await resetPool();
    } catch (error) {
      log("warn", "Transcription connection pool reset failed", { error: error?.message });
    }
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (cancelSignal?.aborted) return { cancelled: true };
    const deadlineMs = deadlineFor({
      bytesSent,
      audioSeconds: request.audioSeconds,
      local,
      attempt,
    });
    const startedAt = now();
    const outcome = await runAttempt({
      request,
      fetch,
      cancelSignal,
      deadlineMs,
      idleMs,
      setTimer,
      clearTimer,
    });
    const meta = {
      endpoint: request.endpoint,
      attempt,
      deadlineMs,
      elapsedMs: Math.round(now() - startedAt),
      bytesSent,
    };

    if (outcome.kind === "cancelled") {
      log("info", "Transcription request cancelled", { ...meta, stage: outcome.stage });
      return { cancelled: true };
    }
    if (outcome.kind === "timeout") {
      const retrying = outcome.retryable && attempt < MAX_ATTEMPTS;
      log("warn", "Transcription request timed out", {
        ...meta,
        timeout: outcome.timeout,
        stage: outcome.stage,
        retrying,
      });
      await resetConnections();
      if (cancelSignal?.aborted) return { cancelled: true };
      if (retrying) continue;
      throw asProviderError(
        transcriptionRequestTimeoutError({ attempt, deadlineMs }),
        request.errorContext
      );
    }
    if (outcome.kind === "error") {
      log("warn", "Transcription request failed", { ...meta, error: outcome.error?.message });
      throw asProviderError(outcome.error, request.errorContext);
    }
    if (outcome.stalled) {
      log("warn", "Transcription error body stalled", { ...meta, status: outcome.response.status });
      await resetConnections();
    } else {
      log("debug", "Transcription request answered", {
        ...meta,
        status: outcome.response.status,
        streamed: outcome.response.streamed === true,
      });
    }
    return { ...outcome.response, attempts: attempt };
  }
  // Unreachable: the last attempt always returns or throws.
  return { cancelled: true };
}

/**
 * A request's "Last recorded use" tag (connectionOutcomes.js): which check
 * descriptor it runs on and which feature sent it, names only. The dictation
 * window sends its own; main's callers build theirs from the route.
 */
function outcomeTagFrom(raw, startedAt) {
  if (!raw || typeof raw !== "object") return null;
  const { descriptorId, slot = null, feature } = raw;
  if (typeof descriptorId !== "string" || typeof feature !== "string") return null;
  if (slot !== null && typeof slot !== "string") return null;
  return {
    descriptorId: descriptorId.slice(0, 160),
    slot,
    feature,
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : startedAt,
  };
}

/**
 * Records how a logical request ended (after its retry): the HTTP answer,
 * also when the IPC itself succeeds around a failed status, or the classified
 * failure. A cancel records nothing, and recording never costs the request.
 */
function recordTranscriptionOutcome(outcomes, tag, request, { result, error } = {}) {
  if (!outcomes?.recordConnectionOutcome || !tag) return;
  try {
    let outcome;
    if (error) outcome = requestOutcomeOfFailure(error);
    else if (!result || result.cancelled) outcome = null;
    else if (result.ok) outcome = { ok: true, code: "OK" };
    else {
      const classified = providerHttpError({
        ...request.errorContext,
        status: result.status,
        body: typeof result.body === "string" ? result.body : "",
        headers: result.headers,
      });
      outcome = { ok: false, code: classified.code };
    }
    if (!outcome) return;
    outcomes.recordConnectionOutcome({ ...tag, ...outcome });
  } catch {
    // The transcript matters more than its record.
  }
}

/**
 * Whether a request gets the local budget. The test override gives a local
 * server the hosted one, for live checks against a server that never answers.
 */
function usesLocalDeadline(endpoint, { selfHosted = false, env = process.env } = {}) {
  if (env?.[TEST_HOSTED_DEADLINE_ENV] === "1") return false;
  return isLocalTranscriptionEndpoint(endpoint, { selfHosted });
}

/** Fetch on a pool, without the session's cookies. */
function poolFetch(pool) {
  return (url, init) => pool.fetch(url, { ...init, useSessionCookies: false });
}

/**
 * History's Re-transcribe of stored audio (and an upload to Azure Speech): the
 * same deadline and retry, on its own pool (a live dictation's reset can't cut
 * it). It has no cancel. `outcome` tags it for "Last recorded use".
 */
async function runHistoryTranscriptionRequest({
  request,
  getPool,
  logger,
  env = process.env,
  outcomes = null,
  outcome = null,
}) {
  const tag = outcomeTagFrom(outcome, Date.now());
  const pool = getPool(HISTORY_STT_PARTITION);
  try {
    const result = await runTranscriptionRequest({
      request,
      fetch: poolFetch(pool),
      resetPool: () => pool.closeAllConnections(),
      local: usesLocalDeadline(request.endpoint, { selfHosted: request.selfHosted, env }),
      logger,
    });
    recordTranscriptionOutcome(outcomes, tag, request, { result });
    return result;
  } catch (error) {
    recordTranscriptionOutcome(outcomes, tag, request, { error });
    throw error;
  }
}

/**
 * Main's handlers: `dictation-transcription-request` (the request, with the
 * window's request id and its "Last recorded use" tag) and
 * `dictation-transcription-cancel` (that id). `getPool(partition)` returns an
 * Electron session; `outcomes` is connectionOutcomes.js's recorder.
 */
function registerDictationTranscriptionIpc({
  ipcMain,
  getPool,
  logger,
  env = process.env,
  outcomes = null,
}) {
  const requests = new AgentStreamRequestRegistry();

  ipcMain.handle("dictation-transcription-request", async (event, payload) => {
    const startedAt = Date.now();
    let request;
    try {
      request = transcriptionRequestFrom(payload);
    } catch (error) {
      return { success: false, ...ipcErrorFields(error) };
    }
    const tag = outcomeTagFrom(payload.outcome, startedAt);
    const sender = event.sender;
    const senderId = sender.id;
    const requestId =
      typeof payload.requestId === "string" && payload.requestId
        ? payload.requestId.slice(0, 100)
        : crypto.randomUUID();
    const controller = requests.begin(senderId, requestId);
    const cancelSenderRequests = () => requests.cancelSender(senderId);
    sender.once("destroyed", cancelSenderRequests);
    try {
      const pool = getPool(DICTATION_STT_PARTITION);
      const result = await runTranscriptionRequest({
        request,
        fetch: poolFetch(pool),
        resetPool: () => pool.closeAllConnections(),
        cancelSignal: controller.signal,
        local: usesLocalDeadline(request.endpoint, { selfHosted: request.selfHosted, env }),
        logger,
      });
      // A failed status still answers `success: true`: its record is the status's.
      recordTranscriptionOutcome(outcomes, tag, request, { result });
      if (result.cancelled) return { success: false, cancelled: true };
      return { success: true, ...result };
    } catch (error) {
      recordTranscriptionOutcome(outcomes, tag, request, { error });
      return { success: false, ...ipcErrorFields(error) };
    } finally {
      sender.removeListener("destroyed", cancelSenderRequests);
      requests.complete(senderId, requestId, controller);
    }
  });

  ipcMain.on("dictation-transcription-cancel", (event, requestId) => {
    if (typeof requestId === "string" && requestId) requests.cancel(event.sender.id, requestId);
  });
}

module.exports = {
  DICTATION_STT_PARTITION,
  HISTORY_STT_PARTITION,
  MAX_ATTEMPTS,
  TEST_HOSTED_DEADLINE_ENV,
  recordTranscriptionOutcome,
  registerDictationTranscriptionIpc,
  runHistoryTranscriptionRequest,
  runTranscriptionRequest,
  transcriptionRequestFrom,
  usesLocalDeadline,
};
