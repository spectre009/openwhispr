// The dictation window's side of the live transcription request: main sends it
// (dictationTranscriptionRequest.js), on its own connection pool with a
// deadline and one retry. The request carries an id, so the window's cancel
// (the pill, Esc) reaches it in main, across both attempts.

import { errorFromIpcResult } from "./ipcErrorFields.js";

const cancelledError = () => new DOMException("Transcription cancelled", "AbortError");

// What the renderer's response handling reads, from the headers main kept.
function headersFrom(headers) {
  const values = new Map(
    Object.entries(headers || {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  return { get: (name) => values.get(String(name).toLowerCase()) ?? null };
}

/**
 * Sends the request through main and resolves a Response-like answer: `ok`,
 * `status`, `statusText`, `headers.get()`, `text()`, plus `streamed`/`streamedText`
 * for an SSE answer main read to its end. A cancel (via `signal`) rejects with
 * an AbortError; a timeout or network failure with main's classified error.
 */
export async function sendDictationTranscription(request, signal) {
  const api = window.electronAPI;
  if (!api?.transcribeDictationRequest) {
    throw new Error("Dictation transcription is unavailable in this window");
  }
  if (signal?.aborted) throw cancelledError();
  const requestId = crypto.randomUUID();
  const onAbort = () => api.cancelDictationTranscription?.(requestId);
  signal?.addEventListener("abort", onAbort, { once: true });
  let reply;
  try {
    reply = await api.transcribeDictationRequest({ ...request, requestId });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (reply?.cancelled || signal?.aborted) throw cancelledError();
  if (!reply?.success) throw errorFromIpcResult(reply);
  const body = typeof reply.body === "string" ? reply.body : "";
  return {
    ok: reply.ok === true,
    status: reply.status,
    statusText: reply.statusText || "",
    headers: headersFrom(reply.headers),
    text: async () => body,
    streamed: reply.streamed === true,
    streamedText: typeof reply.text === "string" ? reply.text : "",
    streamStats: reply.stats ?? null,
    attempts: reply.attempts ?? 1,
  };
}
