const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DICTATION_STT_PARTITION,
  TEST_HOSTED_DEADLINE_ENV,
  registerDictationTranscriptionIpc,
  runTranscriptionRequest,
  transcriptionRequestFrom,
  usesLocalDeadline,
} = require("../../src/helpers/dictationTranscriptionRequest.js");

// Main's live dictation request: one retry on our own deadline before any
// answer, on a reset pool; never after an HTTP error, a started answer, a
// cancel or a second timeout. Synthetic audio and text only.

const encoder = new TextEncoder();
const abortError = () => new DOMException("The operation was aborted.", "AbortError");

// A body that sends `chunks` and then, unless `end`, nothing more: it errors
// only when the request is aborted, as a dead connection's would.
function bodyResponse({ status = 200, headers = {}, chunks = [], end = false, signal }) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (end) controller.close();
      signal?.addEventListener("abort", () => {
        try {
          controller.error(abortError());
        } catch {
          // Already closed.
        }
      });
    },
  });
  return new Response(body, { status, headers });
}

// A server that accepted the upload and never answers.
const silent = (signal) =>
  new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(abortError())));

const jsonAnswer = (text) =>
  new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "req_1" },
  });

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const SSE_HEADERS = { "content-type": "text/event-stream" };

function request(overrides = {}) {
  return transcriptionRequestFrom({
    endpoint: "https://stt.example.com/v1/audio/transcriptions",
    headers: { Authorization: "Bearer test-key", Cookie: "session=1" },
    fields: [
      ["model", "whisper-1"],
      ["keywords[]", "Ozempic"],
      ["keywords[]", "OpenWhispr"],
    ],
    file: { bytes: new Uint8Array(64), name: "audio.wav", type: "audio/wav" },
    audioSeconds: 2,
    errorContext: { provider: "OpenAI", selfHosted: false, model: "whisper-1" },
    ...overrides,
  });
}

// `answers[i]` answers attempt i+1: (init) => Response | Promise.
function harness(answers, { deadlines = [40, 60], idleMs = 30, ...rest } = {}) {
  const events = [];
  const inits = [];
  const deadlineCalls = [];
  const options = {
    request: request(rest.requestOverrides),
    fetch: async (url, init) => {
      inits.push(init);
      events.push(`fetch${inits.length}`);
      const answer = answers[inits.length - 1];
      return answer ? answer(init) : silent(init.signal);
    },
    resetPool: async () => {
      events.push("reset");
      await rest.onReset?.();
    },
    deadlineFor: (args) => {
      deadlineCalls.push(args);
      return deadlines[args.attempt - 1];
    },
    idleMs,
    ...(rest.cancelSignal ? { cancelSignal: rest.cancelSignal } : {}),
    ...(rest.local !== undefined ? { local: rest.local } : {}),
  };
  return { events, inits, deadlineCalls, run: () => runTranscriptionRequest(options) };
}

test("our deadline before any answer retries once, on a pool reset first", async () => {
  const h = harness([(init) => silent(init.signal), () => jsonAnswer("hello there")]);
  const answer = await h.run();
  assert.deepEqual(h.events, ["fetch1", "reset", "fetch2"]);
  assert.equal(answer.ok, true);
  assert.equal(answer.status, 200);
  assert.equal(JSON.parse(answer.body).text, "hello there");
  assert.equal(answer.attempts, 2);
  assert.equal(answer.headers["x-request-id"], "req_1");
  assert.deepEqual(
    h.deadlineCalls.map((call) => call.attempt),
    [1, 2]
  );
  assert.ok(h.deadlineCalls[0].bytesSent > 64, "the deadline counts every byte sent");
  assert.equal(h.deadlineCalls[0].audioSeconds, 2);
});

test("a second timeout is PROVIDER_TIMEOUT, after resetting the pool again", async () => {
  const h = harness([]);
  await assert.rejects(h.run(), (error) => {
    assert.equal(error.code, "PROVIDER_TIMEOUT");
    assert.equal(error.messageKey, "providerErrors.timeout");
    assert.equal(error.messageParams.provider, "OpenAI");
    assert.equal(error.technicalDetails.underlyingError, "TRANSCRIPTION_REQUEST_TIMEOUT");
    return true;
  });
  assert.deepEqual(h.events, ["fetch1", "reset", "fetch2", "reset"]);
});

test("a self-hosted timeout says your server took too long", async () => {
  const h = harness([], {
    requestOverrides: {
      errorContext: { provider: "OpenAI", selfHosted: true, model: "whisper-1" },
    },
  });
  await assert.rejects(h.run(), (error) => {
    assert.equal(error.messageKey, "providerErrors.selfHosted.timeout");
    assert.equal(error.message, "Your server took too long to respond.");
    return true;
  });
});

test("an HTTP error is the answer: never retried, and no pool reset", async () => {
  const h = harness([
    () =>
      new Response('{"error":"overloaded"}', {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  ]);
  const answer = await h.run();
  assert.equal(answer.ok, false);
  assert.equal(answer.status, 503);
  assert.equal(answer.body, '{"error":"overloaded"}');
  assert.deepEqual(h.events, ["fetch1"]);
});

test("an HTTP error whose body stalls keeps its status and is never retried", async () => {
  const h = harness([
    (init) => bodyResponse({ status: 500, chunks: ['{"err'], signal: init.signal }),
  ]);
  const answer = await h.run();
  assert.equal(answer.ok, false);
  assert.equal(answer.status, 500);
  assert.equal(answer.body, "");
  assert.equal(answer.attempts, 1);
  assert.deepEqual(h.events, ["fetch1", "reset"]);
});

test("a JSON answer that stops after its first bytes times out without a retry", async () => {
  const h = harness([(init) => bodyResponse({ chunks: ['{"text":"hel'], signal: init.signal })]);
  await assert.rejects(h.run(), (error) => error.code === "PROVIDER_TIMEOUT");
  assert.deepEqual(h.events, ["fetch1", "reset"]);
});

test("headers without a body byte are no answer yet: retried", async () => {
  const h = harness([
    (init) => bodyResponse({ chunks: [], signal: init.signal }),
    () => jsonAnswer("second try"),
  ]);
  const answer = await h.run();
  assert.equal(JSON.parse(answer.body).text, "second try");
  assert.deepEqual(h.events, ["fetch1", "reset", "fetch2"]);
});

test("a stream that goes idle after transcript events times out without a retry", async () => {
  const h = harness(
    [
      (init) =>
        bodyResponse({
          headers: SSE_HEADERS,
          chunks: [sse({ type: "transcript.text.delta", delta: "Hello" })],
          signal: init.signal,
        }),
    ],
    { deadlines: [1_000, 1_000], idleMs: 25, requestOverrides: { stream: true } }
  );
  await assert.rejects(h.run(), (error) => error.code === "PROVIDER_TIMEOUT");
  assert.deepEqual(h.events, ["fetch1", "reset"]);
});

test("a stream idle before any transcript event is retried", async () => {
  const h = harness(
    [
      (init) =>
        bodyResponse({ headers: SSE_HEADERS, chunks: [": keep-alive\n\n"], signal: init.signal }),
      (init) =>
        bodyResponse({
          headers: SSE_HEADERS,
          chunks: [sse({ type: "transcript.text.done", text: "after retry" })],
          end: true,
          signal: init.signal,
        }),
    ],
    { deadlines: [1_000, 1_000], idleMs: 25, requestOverrides: { stream: true } }
  );
  const answer = await h.run();
  assert.equal(answer.streamed, true);
  assert.equal(answer.text, "after retry");
  assert.deepEqual(h.events, ["fetch1", "reset", "fetch2"]);
});

test("a terminal event completes the answer though the server keeps the stream open", async () => {
  const h = harness(
    [
      (init) =>
        bodyResponse({
          headers: SSE_HEADERS,
          chunks: [
            sse({ type: "transcript.text.delta", delta: "Hello wor" }),
            sse({ type: "transcript.text.done", text: "Hello world" }),
          ],
          signal: init.signal,
        }),
    ],
    { deadlines: [5_000, 5_000], idleMs: 5_000, requestOverrides: { stream: true } }
  );
  const started = Date.now();
  const answer = await h.run();
  assert.ok(Date.now() - started < 1_000, "completed on the event, not a timer");
  assert.equal(answer.text, "Hello world");
  assert.equal(answer.stats.usedFinalText, true);
  assert.equal(h.inits[0].signal.aborted, true, "the open stream is released");
  assert.deepEqual(h.events, ["fetch1"]);
});

test("a cancel during the first attempt never retries or reports", async () => {
  const cancel = new AbortController();
  const h = harness(
    [
      (init) => {
        setImmediate(() => cancel.abort());
        return silent(init.signal);
      },
    ],
    { deadlines: [5_000, 5_000], cancelSignal: cancel.signal }
  );
  assert.deepEqual(await h.run(), { cancelled: true });
  assert.deepEqual(h.events, ["fetch1"]);
});

test("a cancel during the retry, or while the pool resets, stays a cancel", async () => {
  const duringRetry = new AbortController();
  const retry = harness(
    [
      (init) => silent(init.signal),
      (init) => {
        setImmediate(() => duringRetry.abort());
        return silent(init.signal);
      },
    ],
    { deadlines: [20, 5_000], cancelSignal: duringRetry.signal }
  );
  assert.deepEqual(await retry.run(), { cancelled: true });
  assert.deepEqual(retry.events, ["fetch1", "reset", "fetch2"]);

  const duringReset = new AbortController();
  const reset = harness([], {
    deadlines: [20, 5_000],
    cancelSignal: duringReset.signal,
    onReset: () => duringReset.abort(),
  });
  assert.deepEqual(await reset.run(), { cancelled: true });
  assert.deepEqual(reset.events, ["fetch1", "reset"]);
});

test("a cancel that lands with the deadline is a cancel, told apart by its signal", async () => {
  const cancel = new AbortController();
  const timers = [];
  const options = {
    request: request(),
    fetch: (_url, init) => silent(init.signal),
    cancelSignal: cancel.signal,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
    deadlineFor: () => 1,
  };
  const pending = runTranscriptionRequest(options);
  await new Promise((resolve) => setImmediate(resolve));
  // Both before the attempt's continuation runs.
  timers[0]();
  cancel.abort();
  assert.deepEqual(await pending, { cancelled: true });
});

test("a network failure is classified, not retried", async () => {
  const h = harness([
    () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    },
  ]);
  await assert.rejects(h.run(), (error) => {
    assert.equal(error.code, "PROVIDER_UNREACHABLE");
    return true;
  });
  assert.deepEqual(h.events, ["fetch1"]);
});

test("the request carries only the auth headers and the form, file first", async () => {
  const h = harness([() => jsonAnswer("ok")]);
  await h.run();
  const init = h.inits[0];
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { Authorization: "Bearer test-key" });
  const names = [...init.body.keys()];
  assert.deepEqual(names, ["file", "model", "keywords[]", "keywords[]"]);
  assert.deepEqual(init.body.getAll("keywords[]"), ["Ozempic", "OpenWhispr"]);
  assert.equal(init.body.get("file").name, "audio.wav");
  assert.equal(init.body.get("file").type, "audio/wav");
});

test("requests are validated: an http(s) endpoint and audio bytes", () => {
  assert.throws(() => request({ endpoint: "file:///etc/passwd" }), /endpoint/);
  assert.throws(() => request({ endpoint: "not a url" }), /endpoint/);
  assert.throws(() => request({ file: { bytes: "audio" } }), /audio/);
  const normalized = request({ fields: [["model", "m"], ["bad", 1], "x"], stream: "yes" });
  assert.deepEqual(normalized.fields, [["model", "m"]]);
  assert.equal(normalized.stream, false);
  assert.equal(normalized.errorContext.surface, "transcription");
});

test("local servers get the local budget unless the test override asks for the hosted one", () => {
  const local = "http://127.0.0.1:8178/v1/audio/transcriptions";
  assert.equal(usesLocalDeadline(local, { env: {} }), true);
  assert.equal(usesLocalDeadline(local, { env: { [TEST_HOSTED_DEADLINE_ENV]: "1" } }), false);
  assert.equal(usesLocalDeadline("https://api.openai.com/v1", { env: {} }), false);
  assert.equal(usesLocalDeadline("https://stt.example.com", { selfHosted: true, env: {} }), true);
});

function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => listeners.set(channel, fn),
    },
    invoke: (sender, payload) =>
      handlers.get("dictation-transcription-request")({ sender }, payload),
    cancel: (sender, id) => listeners.get("dictation-transcription-cancel")({ sender }, id),
  };
}

function fakeSender(id) {
  const destroyed = new Set();
  return {
    id,
    once: (event, fn) => event === "destroyed" && destroyed.add(fn),
    removeListener: (event, fn) => destroyed.delete(fn),
    destroy: () => [...destroyed].forEach((fn) => fn()),
  };
}

const payload = (requestId) => ({
  requestId,
  endpoint: "https://stt.example.com/v1/audio/transcriptions",
  headers: {},
  fields: [["model", "whisper-1"]],
  file: { bytes: new Uint8Array(8).buffer, name: "audio.webm", type: "audio/webm" },
  audioSeconds: 1,
  errorContext: { provider: "OpenAI" },
});

test("main's handler: a cancel names its request, from the window that sent it", async () => {
  const ipc = fakeIpc();
  const partitions = [];
  const resets = [];
  const pool = {
    fetch: (_url, init) => silent(init.signal),
    closeAllConnections: async () => resets.push(true),
  };
  registerDictationTranscriptionIpc({
    ipcMain: ipc.ipcMain,
    getPool: (partition) => {
      partitions.push(partition);
      return pool;
    },
    logger: null,
    env: {},
  });
  const window = fakeSender(7);
  const other = fakeSender(8);
  const pending = ipc.invoke(window, payload("req-a"));
  await new Promise((resolve) => setImmediate(resolve));
  ipc.cancel(other, "req-a");
  ipc.cancel(window, "req-b");
  await new Promise((resolve) => setTimeout(resolve, 10));
  ipc.cancel(window, "req-a");
  assert.deepEqual(await pending, { success: false, cancelled: true });
  assert.deepEqual(partitions, [DICTATION_STT_PARTITION]);
  assert.equal(resets.length, 0, "a cancel never resets the pool");

  const closing = ipc.invoke(window, payload("req-c"));
  await new Promise((resolve) => setImmediate(resolve));
  window.destroy();
  assert.deepEqual(await closing, { success: false, cancelled: true });
});

test("main's handler returns a timeout as classified fields that survive IPC", async () => {
  const ipc = fakeIpc();
  registerDictationTranscriptionIpc({
    ipcMain: ipc.ipcMain,
    getPool: () => ({ fetch: () => Promise.reject(new Error("net::ERR_TIMED_OUT")) }),
    logger: null,
    env: {},
  });
  const reply = await ipc.invoke(fakeSender(1), payload("req-t"));
  assert.equal(reply.success, false);
  assert.equal(reply.code, "PROVIDER_TIMEOUT");
  assert.equal(reply.messageKey, "providerErrors.timeout");
  assert.equal(reply.cancelled, undefined);

  const invalid = await ipc.invoke(fakeSender(1), { ...payload("req-x"), endpoint: "ftp://x" });
  assert.equal(invalid.success, false);
  assert.match(invalid.error, /endpoint/);
});

// ── Azure Speech: the two allowlisted extensions ─────────────────────────────

const AZURE_URL =
  "https://res.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15";

test("Azure Speech: its key header and the `audio` part name are the only extensions", async () => {
  const azure = request({
    endpoint: AZURE_URL,
    headers: {
      "Ocp-Apim-Subscription-Key": "az-key",
      Authorization: "Bearer other",
      "api-key": "other",
      Cookie: "session=1",
    },
    fields: [["definition", '{"enhancedMode":{"enabled":true,"model":"MAI-Transcribe-2"}}']],
    audioPart: "audio",
    errorContext: {
      provider: "Azure Speech",
      providerId: "azure-speech",
      model: "MAI-Transcribe-2",
    },
  });
  // The key travels alone: no other credential rides along with it.
  assert.deepEqual(azure.headers, { "Ocp-Apim-Subscription-Key": "az-key" });
  assert.equal(azure.audioPart, "audio");
  assert.equal(azure.errorContext.providerId, "azure-speech");

  const inits = [];
  await runTranscriptionRequest({
    request: azure,
    fetch: async (_url, init) => {
      inits.push(init);
      return jsonAnswer("ok");
    },
  });
  assert.deepEqual([...inits[0].body.keys()], ["audio", "definition"]);
  assert.equal(inits[0].body.get("audio").name, "audio.wav");

  // Any other part name is refused; none means `file`, as before.
  assert.throws(() => request({ audioPart: "upload" }), /audio part/);
  assert.equal(request().audioPart, "file");
  // Another provider can't borrow Azure's error wording.
  assert.equal(
    request({ errorContext: { provider: "OpenAI", providerId: "copilot" } }).errorContext
      .providerId,
    undefined
  );
});

test("Azure Speech: main refuses its key for anything but a Speech resource's transcribe URL", () => {
  const withKey = (endpoint) =>
    request({ endpoint, headers: { "ocp-apim-subscription-key": "az-key" }, audioPart: "audio" });
  for (const endpoint of [
    "https://stt.example.com/v1/audio/transcriptions",
    "https://res.openai.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    "https://res.cognitiveservices.azure.com.evil.example/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    "http://res.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    "https://res.cognitiveservices.azure.com/other?api-version=2025-10-15",
    // The field accepts a Foundry endpoint, but the key only goes to the
    // documented host it's converted to.
    "https://res.services.ai.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    "https://res.services.ai.azure.com/api/projects/p1/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    "https://res.cognitiveservices.azure.com:8443/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    "https://user:pw@res.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
  ]) {
    assert.throws(() => withKey(endpoint), /Speech resource/, endpoint);
  }
  assert.equal(withKey(AZURE_URL).endpoint, AZURE_URL);
  assert.equal(
    withKey(
      "https://westus2.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15"
    ).headers["Ocp-Apim-Subscription-Key"],
    "az-key"
  );
});

test("main's handler refuses an Azure key bound for another endpoint, sending nothing", async () => {
  const ipc = fakeIpc();
  const fetched = [];
  registerDictationTranscriptionIpc({
    ipcMain: ipc.ipcMain,
    getPool: () => ({
      fetch: async (url) => {
        fetched.push(url);
        return jsonAnswer("ok");
      },
    }),
    logger: null,
    env: {},
  });
  const reply = await ipc.invoke(fakeSender(1), {
    ...payload("req-az"),
    headers: { "Ocp-Apim-Subscription-Key": "az-key" },
    audioPart: "audio",
  });
  assert.equal(reply.success, false);
  assert.match(reply.error, /Speech resource/);
  assert.deepEqual(fetched, []);
});

test("Azure's request id comes back with the answer", async () => {
  const inits = [];
  const answer = await runTranscriptionRequest({
    request: request({
      endpoint: AZURE_URL,
      headers: { "Ocp-Apim-Subscription-Key": "az-key" },
      audioPart: "audio",
    }),
    fetch: async (_url, init) => {
      inits.push(init);
      return new Response('{"error":{"code":"404","message":"Resource not found"}}', {
        status: 404,
        headers: { "apim-request-id": "apim-1" },
      });
    },
  });
  assert.equal(answer.status, 404);
  assert.equal(answer.headers["apim-request-id"], "apim-1");
});
