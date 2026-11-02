const test = require("node:test");
const assert = require("node:assert/strict");

const {
  registerDictationTranscriptionIpc,
  runHistoryTranscriptionRequest,
  transcriptionRequestFrom,
} = require("../../src/helpers/dictationTranscriptionRequest.js");
const { createConnectionOutcomes } = require("../../src/helpers/connectionOutcomes.js");

// Main's batch transcription request records its "Last recorded use" once,
// after its retry: OK, the HTTP status's code even though the IPC answers
// `success: true` around it, or the failure's (a timeout); a cancel and an
// untagged request record nothing. Synthetic audio only.

const KEY = "sk-SECRET-openai-STT";

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
  return { id, once() {}, removeListener() {} };
}

const TAG = { descriptorId: "provider:openai", slot: "OPENAI_API_KEY", feature: "recognition" };

const payload = (requestId, extra = {}) => ({
  requestId,
  endpoint: "https://api.openai.com/v1/audio/transcriptions",
  headers: { Authorization: `Bearer ${KEY}` },
  fields: [["model", "gpt-transcribe"]],
  file: { bytes: new Uint8Array(8).buffer, name: "audio.webm", type: "audio/webm" },
  audioSeconds: 1,
  errorContext: { provider: "OpenAI" },
  outcome: TAG,
  ...extra,
});

function recorder() {
  const logs = [];
  const emitted = [];
  const outcomes = createConnectionOutcomes({
    logger: { debug: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    emit: (value) => emitted.push(value),
  });
  return { outcomes, logs, emitted };
}

function register(fetch, outcomes) {
  const ipc = fakeIpc();
  registerDictationTranscriptionIpc({
    ipcMain: ipc.ipcMain,
    getPool: () => ({ fetch, closeAllConnections: async () => {} }),
    logger: null,
    env: {},
    outcomes,
  });
  return ipc;
}

test("a dictation's answer is recorded: OK, and a failed status under success: true", async () => {
  const { outcomes, logs, emitted } = recorder();
  let status = 200;
  const ipc = register(
    async () =>
      new Response(
        status === 200
          ? JSON.stringify({ text: "hello" })
          : `{"error":{"message":"Incorrect API key provided: ${KEY}"}}`,
        { status, headers: { "content-type": "application/json" } }
      ),
    outcomes
  );
  const ok = await ipc.invoke(fakeSender(1), payload("req-1"));
  assert.equal(ok.success, true);
  assert.deepEqual(outcomes.list()["provider:openai"].last, {
    feature: "recognition",
    ok: true,
    code: "OK",
    at: outcomes.list()["provider:openai"].last.at,
  });

  status = 401;
  const rejected = await ipc.invoke(fakeSender(1), payload("req-2"));
  assert.equal(rejected.success, true, "the IPC still answers with the response");
  assert.equal(rejected.ok, false);
  const entry = outcomes.list()["provider:openai"];
  assert.equal(entry.last.ok, false);
  assert.equal(entry.last.code, "PROVIDER_AUTH_FAILED", "the HTTP result is what's recorded");
  assert.equal(entry.lastFailure.code, "PROVIDER_AUTH_FAILED");
  const everything = JSON.stringify({ logs, emitted, list: outcomes.list() });
  assert.ok(!everything.includes(KEY), "no key or body in the record");
  assert.ok(!everything.includes("Incorrect API key"));
});

test("a timeout is recorded; a cancel and an untagged request aren't", async () => {
  const { outcomes } = recorder();
  const timedOut = register(() => Promise.reject(new Error("net::ERR_TIMED_OUT")), outcomes);
  const reply = await timedOut.invoke(fakeSender(1), payload("req-t"));
  assert.equal(reply.code, "PROVIDER_TIMEOUT");
  assert.equal(outcomes.list()["provider:openai"].last.code, "PROVIDER_TIMEOUT");

  const quiet = recorder();
  const silent = register(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        )
      ),
    quiet.outcomes
  );
  const sender = fakeSender(2);
  const pending = silent.invoke(sender, payload("req-c"));
  await new Promise((resolve) => setImmediate(resolve));
  silent.cancel(sender, "req-c");
  assert.deepEqual(await pending, { success: false, cancelled: true });
  assert.deepEqual(quiet.outcomes.list(), {}, "a cancel says nothing about the connection");

  const ok = register(async () => new Response('{"text":"hi"}', { status: 200 }), quiet.outcomes);
  await ok.invoke(fakeSender(3), payload("req-u", { outcome: undefined }));
  await ok.invoke(fakeSender(3), payload("req-v", { outcome: "provider:openai" }));
  assert.deepEqual(quiet.outcomes.list(), {}, "no tag, no record");
});

test("an outcome from before the key changed is dropped", async () => {
  const { outcomes } = recorder();
  let release;
  const ipc = register(
    () =>
      new Promise((resolve) => {
        release = () => resolve(new Response('{"text":"hi"}', { status: 200 }));
      }),
    outcomes
  );
  const pending = ipc.invoke(fakeSender(1), payload("req-k"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  outcomes.noteSecretsChanged({ names: ["OPENAI_API_KEY"] });
  release();
  assert.equal((await pending).success, true);
  assert.deepEqual(outcomes.list(), {});
});

test("Re-transcribe and an Azure Speech upload record under their tag", async () => {
  const { outcomes } = recorder();
  const request = transcriptionRequestFrom({
    endpoint:
      "https://res.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    headers: { "Ocp-Apim-Subscription-Key": "az-SECRET" },
    audioPart: "audio",
    file: { bytes: new Uint8Array(8), name: "audio.wav", type: "audio/wav" },
    errorContext: { provider: "Azure Speech", providerId: "azure-speech", model: "MAI" },
  });
  const pool = (response) => () => ({
    fetch: async () => response(),
    closeAllConnections: async () => {},
  });
  const answer = await runHistoryTranscriptionRequest({
    request,
    getPool: pool(() => new Response('{"error":{"code":"404"}}', { status: 404 })),
    logger: null,
    env: {},
    outcomes,
    outcome: {
      descriptorId: "provider:azure-speech",
      slot: "AZURE_SPEECH_API_KEY",
      feature: "fileTranscription",
    },
  });
  assert.equal(answer.status, 404);
  const entry = outcomes.list()["provider:azure-speech"];
  assert.equal(entry.last.feature, "fileTranscription");
  assert.equal(entry.last.code, "AZURE_SPEECH_ENDPOINT_INVALID");

  await assert.rejects(
    runHistoryTranscriptionRequest({
      request,
      getPool: () => ({
        fetch: () => Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED")),
        closeAllConnections: async () => {},
      }),
      logger: null,
      env: {},
      outcomes,
      outcome: {
        descriptorId: "provider:azure-speech",
        slot: "AZURE_SPEECH_API_KEY",
        feature: "recognition",
      },
    }),
    (error) => error.code === "PROVIDER_UNREACHABLE"
  );
  assert.equal(outcomes.list()["provider:azure-speech"].last.code, "PROVIDER_UNREACHABLE");
  assert.equal(outcomes.list()["provider:azure-speech"].last.feature, "recognition");

  // Without a recorder or a tag it runs as before.
  const plain = await runHistoryTranscriptionRequest({
    request,
    getPool: pool(() => new Response('{"combinedPhrases":[]}', { status: 200 })),
    logger: null,
    env: {},
  });
  assert.equal(plain.ok, true);
});
