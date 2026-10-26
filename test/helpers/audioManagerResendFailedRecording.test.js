const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");
const { asProviderError, providerHttpError } = require("../../src/helpers/providerHttpErrors.js");
const { ipcErrorFields } = require("../../src/helpers/ipcErrorFields.js");
const {
  transcriptionRequestTimeoutError,
} = require("../../src/helpers/transcriptionRequestDeadline.js");

// A timed-out dictation reaches the error card and the keep-audio save, and the
// card's Retry re-sends the kept recording through the live pipeline,
// completing the failed History row instead of adding one. Synthetic audio and
// text only.

const errorContext = {
  provider: "OpenAI",
  selfHosted: false,
  model: "whisper-1",
  surface: "transcription",
};
// What main replies after its deadline fired twice (dictationTranscriptionRequest.js).
const timeoutReply = () => ({
  success: false,
  ...ipcErrorFields(
    asProviderError(
      transcriptionRequestTimeoutError({ attempt: 2, deadlineMs: 21_900 }),
      errorContext
    )
  ),
});
const answerReply = (text) => ({
  success: true,
  ok: true,
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
  attempts: 1,
});
const httpErrorReply = (status) => ({
  success: true,
  ok: false,
  status,
  statusText: "",
  headers: { "content-type": "application/json" },
  body: '{"error":{"message":"Incorrect API key provided"}}',
});

const TEAMS = Object.freeze({ id: "teams", name: "Teams chat", emoji: "💬", runMode: "two-step" });

async function setup(t, { settings = {}, replies = [] } = {}) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-resend-failed-test-",
    settingsKey: "__resendFailedSettings",
    settings: {
      useLocalWhisper: false,
      allowLocalFallback: false,
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
      dataRetentionEnabled: true,
      audioRetentionDays: 30,
      ...settings,
    },
    mockModules: {
      "/services/SyncService.js": "export const syncService = { debouncedPush() {} };",
    },
  });
  const calls = {
    requests: [],
    cancels: [],
    saves: [],
    audio: [],
    runs: [],
    completions: [],
    captures: 0,
    errors: [],
    results: [],
    routeKinds: [],
  };
  const api = loaded.window.electronAPI;
  const pending = [...replies];
  api.transcribeDictationRequest = async (request) => {
    calls.requests.push(request);
    const reply = pending.shift();
    return typeof reply === "function" ? reply(request) : reply;
  };
  api.cancelDictationTranscription = (id) => calls.cancels.push(id);
  api.saveTranscription = async (text, rawText, options) => {
    calls.saves.push({ text, rawText, options });
    return { id: 41 + calls.saves.length - 1, success: true };
  };
  api.saveTranscriptionAudio = async (id, buffer, metadata) => {
    calls.audio.push({ id, bytes: buffer.byteLength, metadata });
    return { success: true };
  };
  api.recordAnalyticsEvent = async () => ({ success: true });
  api.beginStepHistoryRun = async (options) => {
    calls.runs.push(options ?? null);
    return { runId: `run-${calls.runs.length}` };
  };
  api.captureDictationTarget = async () => {
    calls.captures += 1;
    return { success: true, pid: 1 };
  };
  api.getDictationTargetApp = async () => ({ exeName: "Teams.exe" });
  api.dismissDictationPreview = () => {};
  api.completeFailedDictationRetry = async (id, text, rawText, options) => {
    calls.completions.push({ id, text, rawText, options });
    return calls.completionReply ?? { success: true, transcription: { id } };
  };

  const manager = loaded.createManager({
    isRecording: false,
    isProcessing: true,
    isStreaming: false,
    streamingStartInProgress: false,
    _streamingStopPromise: null,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _activeTranscriptionAbortController: null,
    _activeProcessingPipeline: null,
    _localSpeechGateState: null,
    voiceAgentRequested: false,
    translationRequested: false,
    recordingStyle: TEAMS,
    lastAudioBlob: null,
    lastAudioMetadata: null,
    pendingSelectionEdit: null,
    pendingAssistantConversation: null,
    pendingCleanupFailure: null,
    getEffectiveSttLanguage: () => "auto",
    getAPIKey: async () => "test-key",
    getWhisperPrompt: () => null,
    getKeyterms: () => [],
    isDictionaryEcho: () => false,
    isReasoningAvailable: async () => false,
    async processTranscription(text) {
      calls.routeKinds.push(this.getRecordingRouteKind());
      return { text: `${text}.`, trace: { version: 1, steps: [] } };
    },
    onStateChange() {},
    onNoAudio() {},
    onError: (report) => calls.errors.push(report),
    onTranscriptionComplete: (result) => {
      calls.results.push(result);
      return manager.saveTranscription(result.text, result.rawText, {
        trace: result.trace,
        ...(result.replacesTranscriptionId
          ? { replacesTranscriptionId: result.replacesTranscriptionId }
          : {}),
      });
    },
  });
  return { manager, calls, api, setSettings: loaded.setSettings };
}

const recording = () => new Blob([new Uint8Array(2048)], { type: "audio/webm" });
const metadata = { durationSeconds: 4.6, analyticsOccurredAt: "2026-10-26T17:46:30.000Z" };

async function failOnce(h, blob = recording()) {
  h.manager.lastAudioBlob = blob;
  const pipeline = h.manager._startProcessingPipeline();
  await h.manager.processAudio(blob, metadata, pipeline);
  await pipeline.resultHandled;
  return blob;
}

test("a timeout reaches the card and the keep-audio save, never as a cancel", async (t) => {
  const h = await setup(t, { replies: [timeoutReply()] });
  const blob = await failOnce(h);

  assert.equal(h.calls.errors.length, 1);
  const report = h.calls.errors[0];
  assert.equal(report.code, "PROVIDER_TIMEOUT");
  assert.equal(report.messageKey, "providerErrors.timeout");
  assert.equal(h.manager._processingCancellationGeneration, 0, "a timeout is not a cancel");
  assert.equal(h.calls.saves.length, 1);
  assert.equal(h.calls.saves[0].options.status, "failed");
  assert.equal(h.calls.saves[0].options.routeKind, "style:teams");
  assert.deepEqual(
    h.calls.audio.map((entry) => entry.id),
    [41]
  );

  const kept = report.keptRecording;
  assert.ok(kept, "Retry gets the recording to re-send");
  assert.equal(kept.blob, blob);
  assert.equal(kept.style, TEAMS);
  assert.equal(kept.translationRequested, false);
  assert.equal(await kept.rowId, 41);
  assert.equal(h.calls.requests[0].audioSeconds, 4.6);
});

test("Retry re-sends the recording and its success completes the failed row", async (t) => {
  const h = await setup(t, { replies: [timeoutReply(), answerReply("hello again")] });
  await failOnce(h);
  const kept = h.calls.errors[0].keptRecording;
  // The intent changed since (an unstyled recording), and Retry restores it.
  h.manager.setRecordingStyle(null);
  h.manager.isProcessing = false;

  assert.equal(await h.manager.resendFailedRecording(kept), true);

  assert.equal(h.calls.requests.length, 2);
  assert.equal(h.calls.captures, 1, "the paste target is captured afresh");
  assert.deepEqual(h.calls.runs.at(-1), { transcriptionId: 41 });
  assert.deepEqual(h.calls.routeKinds, ["style:teams"]);
  assert.equal(h.calls.results.length, 1);
  assert.equal(h.calls.results[0].replacesTranscriptionId, 41);
  assert.equal(h.calls.results[0].text, "hello again.");
  assert.deepEqual(h.calls.completions, [
    {
      id: 41,
      text: "hello again.",
      rawText: "hello again",
      options: {
        trace: { version: 1, steps: [] },
        provider: "openai",
        model: h.calls.completions[0].options.model,
      },
    },
  ]);
  assert.equal(h.calls.saves.length, 1, "no second History row");
  assert.equal(h.manager.isProcessing, false);
});

test("a re-send that fails again brings the card back for the same row", async (t) => {
  const h = await setup(t, { replies: [timeoutReply(), timeoutReply()] });
  await failOnce(h);
  const first = h.calls.errors[0].keptRecording;
  h.manager.isProcessing = false;

  assert.equal(await h.manager.resendFailedRecording(first), true);

  assert.equal(h.calls.errors.length, 2);
  const again = h.calls.errors[1].keptRecording;
  assert.ok(again, "the card offers Retry again");
  assert.equal(await again.rowId, 41);
  assert.equal(again.blob, first.blob);
  assert.equal(h.calls.saves.length, 1, "the row stays failed: no second failed row");
  assert.equal(h.calls.completions.length, 0);
});

test("a row gone since is saved as a new dictation, with its recording", async (t) => {
  const h = await setup(t, { replies: [timeoutReply(), answerReply("saved anew")] });
  h.calls.completionReply = { success: false, code: "NOT_FOUND" };
  await failOnce(h);
  const kept = h.calls.errors[0].keptRecording;
  h.manager.isProcessing = false;

  await h.manager.resendFailedRecording(kept);

  assert.equal(h.calls.completions.length, 1);
  assert.equal(h.calls.saves.length, 2);
  assert.equal(h.calls.saves[1].text, "saved anew.");
  assert.equal(h.calls.saves[1].options.status, undefined);
  assert.deepEqual(
    h.calls.audio.map((entry) => entry.id),
    [41, 42]
  );
});

test("a cancel while main waits is no card and no save", async (t) => {
  const answered = deferred();
  const h = await setup(t);
  h.api.transcribeDictationRequest = async (request) => {
    h.calls.requests.push(request);
    answered.resolve(request.requestId);
    return new Promise((resolve) => {
      h.api.cancelDictationTranscription = (id) => {
        h.calls.cancels.push(id);
        resolve({ success: false, cancelled: true });
      };
    });
  };
  const blob = recording();
  h.manager.lastAudioBlob = blob;
  const run = h.manager.processAudio(blob, metadata);
  const requestId = await answered.promise;
  assert.equal(h.manager.cancelProcessing(), true);
  await run;

  assert.deepEqual(h.calls.cancels, [requestId]);
  assert.equal(h.calls.errors.length, 0);
  assert.equal(h.calls.saves.length, 0);
});

test("an auth failure keeps the record-again Retry", async (t) => {
  const h = await setup(t, { replies: [httpErrorReply(401)] });
  await failOnce(h);
  assert.equal(h.calls.errors[0].code, "PROVIDER_AUTH_FAILED");
  assert.equal(h.calls.errors[0].keptRecording, undefined);
  assert.equal(h.calls.saves.length, 1, "the failed row is still kept");
  // A real provider 401 classifies the same way in main and here.
  assert.equal(
    providerHttpError({ ...errorContext, status: 401, body: "" }).code,
    "PROVIDER_AUTH_FAILED"
  );
});

test("with local history or recordings off, nothing is kept and Retry records again", async (t) => {
  for (const settings of [{ dataRetentionEnabled: false }, { audioRetentionDays: 0 }]) {
    const h = await setup(t, { settings, replies: [timeoutReply()] });
    await failOnce(h);
    assert.equal(h.calls.errors[0].code, "PROVIDER_TIMEOUT");
    assert.equal(h.calls.errors[0].keptRecording, undefined);
  }
});

test("a re-send waits its turn: never while another dictation holds the pipeline", async (t) => {
  const h = await setup(t, { replies: [timeoutReply()] });
  await failOnce(h);
  const kept = h.calls.errors[0].keptRecording;
  h.manager.isRecording = true;
  assert.equal(await h.manager.resendFailedRecording(kept), false);
  h.manager.isRecording = false;
  h.manager.isProcessing = true;
  assert.equal(await h.manager.resendFailedRecording(kept), false);
  assert.equal(h.calls.requests.length, 1);
});

test("a cancel before the re-send's request leaves nothing behind", async (t) => {
  const h = await setup(t, { replies: [timeoutReply()] });
  await failOnce(h);
  const kept = h.calls.errors[0].keptRecording;
  h.manager.isProcessing = false;
  const slowRow = deferred();
  const resend = h.manager.resendFailedRecording({ ...kept, rowId: slowRow.promise });
  assert.equal(h.manager.isProcessing, true);
  assert.equal(h.manager.cancelProcessing(), true);
  slowRow.resolve(41);
  assert.equal(await resend, false);
  assert.equal(h.calls.requests.length, 1, "nothing was sent");
  assert.equal(h.calls.errors.length, 1);
});
