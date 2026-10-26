const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// Recording quality (Settings › Storage › Recordings) on every dictation
// recorder: the pre-roll, the batch recorder (fresh or adopted), microphone
// recovery and the streaming fallback, read once when a session starts; and
// the merge of a recovered recording carries the session's quality to main.

const BITS = { smaller: 32000, balanced: 64000 };

class FakeMediaRecorder {
  static created = [];
  constructor(stream, options) {
    this.stream = stream;
    this.argCount = arguments.length;
    this.options = options;
    this.state = "inactive";
    this.mimeType = "audio/webm;codecs=opus";
    FakeMediaRecorder.created.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
  }
}

function installRecorder(t) {
  FakeMediaRecorder.created = [];
  globalThis.MediaRecorder = FakeMediaRecorder;
  t.after(() => {
    delete globalThis.MediaRecorder;
  });
}

const fakeStream = () => {
  const track = { stop() {}, getSettings: () => ({}), label: "Fake" };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
};

// What a recorder was asked for: its bitrate, or "none" when built without options.
const askedFor = (recorder) =>
  recorder.argCount === 1 ? "none" : (recorder.options?.audioBitsPerSecond ?? "none");
const expected = (quality) => BITS[quality] ?? "none";

async function load(t, settings = {}) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-recording-quality-test-",
    settingsKey: "__recordingQualitySettings",
    settings,
  });
  installRecorder(t);
  return loaded;
}

function batchManager(createManager, overrides = {}) {
  return createManager({
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    _streamingStopPromise: null,
    mediaRecorder: null,
    _batchPcmTap: null,
    _batchSegments: [],
    audioChunks: [],
    micRecovery: { started: false, stop() {} },
    preparedMicCapture: { take: async () => null },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({ audio: true }),
    _acquireCaptureStream: async () => fakeStream(),
    _startPcmTap: () => null,
    beginMicRecovery: async () => {},
    onStateChange() {},
    ...overrides,
  });
}

test("a fresh batch recorder takes each quality's bitrate; Original passes no options", async (t) => {
  const { createManager, setSettings } = await load(t);
  for (const quality of ["smaller", "balanced", "original"]) {
    setSettings({ recordingQuality: quality });
    const manager = batchManager(createManager);
    t.after(() => manager.teardownSpeechGate());
    assert.equal(await manager.startRecording(), true, quality);
    const recorder = FakeMediaRecorder.created.at(-1);
    assert.equal(askedFor(recorder), expected(quality), quality);
    assert.equal(manager._recordingQuality, quality);
  }
  // Original constructs the recorder exactly as before: one argument.
  assert.equal(FakeMediaRecorder.created.at(-1).argCount, 1);

  setSettings({ recordingQuality: "something-else" });
  const unknown = batchManager(createManager);
  t.after(() => unknown.teardownSpeechGate());
  await unknown.startRecording();
  assert.equal(askedFor(FakeMediaRecorder.created.at(-1)), "none", "unknown reads as Original");
});

test("the pre-roll records at the quality read when the mic is prepared", async (t) => {
  const { createManager, setSettings } = await load(t, { recordingQuality: "smaller" });
  const manager = createManager({
    _startInProgress: false,
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    _streamingStopPromise: null,
    mediaRecorder: null,
    isRecordingAllowedByPolicy: () => true,
    preparedMicCapture: { prepare: async (open) => open() },
    _startPcmTap: () => null,
    getAudioConstraints: async () => ({ audio: true }),
    _acquireCaptureStream: async () => fakeStream(),
    shouldUseStreaming: () => false,
  });
  const prepared = await manager.prepareMicCapture();
  assert.equal(prepared.recordingQuality, "smaller");
  assert.strictEqual(prepared.recorder, FakeMediaRecorder.created.at(-1));
  assert.equal(askedFor(prepared.recorder), 32000);

  setSettings({ recordingQuality: "balanced" });
  const direct = { stream: fakeStream(), chunks: [], recordingQuality: "balanced" };
  manager._startPreRollRecorder(direct, null);
  assert.equal(askedFor(direct.recorder), 64000);
});

test("an adopted pre-roll decides the session, and mic recovery keeps it after the setting changes", async (t) => {
  const { createManager, setSettings } = await load(t, { recordingQuality: "original" });
  const preRoll = new FakeMediaRecorder(fakeStream(), { audioBitsPerSecond: 32000 });
  preRoll.state = "recording";
  const prepared = {
    stream: fakeStream(),
    constraints: { audio: true },
    recorder: preRoll,
    chunks: [],
    pcmTap: null,
    startedAt: Date.now(),
    recordingQuality: "smaller",
  };
  const manager = batchManager(createManager, {
    preparedMicCapture: { take: async () => prepared },
  });
  t.after(() => manager.teardownSpeechGate());
  const before = FakeMediaRecorder.created.length;

  assert.equal(await manager.startRecording(), true);
  assert.equal(FakeMediaRecorder.created.length, before, "the pre-roll is adopted, not rebuilt");
  assert.strictEqual(manager.mediaRecorder, preRoll);
  assert.equal(manager._recordingQuality, "smaller", "the key-down quality, not the setting");

  // Mid-recording the user picks Balanced; the microphone then goes away.
  setSettings({ recordingQuality: "balanced" });
  manager.isRecording = true;
  manager.mediaRecorder.state = "inactive";
  await manager.replaceBatchMic(fakeStream());
  assert.equal(askedFor(FakeMediaRecorder.created.at(-1)), 32000, "recovery keeps the session's");

  // The next session reads the setting again.
  manager.isRecording = false;
  manager.mediaRecorder = null;
  assert.equal(await manager.startRecording(), true);
  assert.equal(askedFor(FakeMediaRecorder.created.at(-1)), 64000);
  assert.equal(manager._recordingQuality, "balanced");
});

test("the streaming fallback recorder and its replacement use the session's quality", async (t) => {
  const { createManager, setSettings } = await load(t, { recordingQuality: "balanced" });
  const manager = createManager({
    _startInProgress: false,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    _streamingCancellationGeneration: 0,
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    _streamingStopPromise: null,
    isRecordingAllowedByPolicy: () => true,
    preparedMicCapture: { take: async () => null },
    getAudioConstraints: async () => ({ audio: true }),
    _acquireCaptureStream: async () => fakeStream(),
    // Stops the start right after the fallback recorder is built.
    getOrCreateAudioContext: async () => {
      throw new Error("no audio context in this test");
    },
    _markCaptureStreamReleased() {},
    cleanupStreaming: async () => {},
    getStreamingProviderName: () => "test",
    onError() {},
    onStateChange() {},
  });

  assert.equal(await manager.startStreamingRecording(), false);
  const fallback = manager.streamingFallbackRecorder;
  assert.ok(fallback, "the fallback recorder started");
  assert.equal(askedFor(fallback), 64000);

  setSettings({ recordingQuality: "smaller" });
  manager.startStreamingFallbackRecorder(fakeStream());
  assert.equal(askedFor(FakeMediaRecorder.created.at(-1)), 64000, "a replacement keeps it");
});

test("merging a recovered recording sends its quality, and finalize uses the one it started with", async (t) => {
  const { window, createManager } = await load(t);
  const merges = [];
  window.electronAPI.mergeAudioSegments = async (payload, options) => {
    merges.push({ count: payload.length, options });
    return { success: true, buffer: new ArrayBuffer(8), mimeType: "audio/webm" };
  };
  const segment = () => new Blob([new Uint8Array(1024)], { type: "audio/webm" });
  const manager = createManager({ _recordingQuality: "smaller" });

  await manager.mergeRecordedSegments([segment(), segment()]);
  await manager.mergeRecordedSegments([segment(), segment()], "balanced");
  await manager.mergeRecordedSegments([segment(), segment()], "bogus");
  assert.deepEqual(
    merges.map((merge) => merge.options),
    [{ quality: "smaller" }, { quality: "balanced" }, { quality: "original" }]
  );

  // A snapshot of a cancelled recording keeps its quality for the background save.
  manager.audioChunks = [];
  manager._batchSegments = [];
  manager.recordingMimeType = "audio/webm";
  manager.recordingStartTime = Date.now();
  assert.equal(manager.takeDiscardedBatchSnapshot().recordingQuality, "smaller");

  // Finalize reads the quality before anything else can change it.
  const seen = [];
  const finalizing = createManager({
    _recordingQuality: "balanced",
    isRecording: true,
    isProcessing: false,
    _processingCancellationGeneration: 0,
    _streamingCancellationGeneration: 0,
    _streamingStopPromise: null,
    _activeTranscriptionAbortController: null,
    _batchSegments: [segment()],
    _batchPcmTap: null,
    _receivedAudioData: true,
    _streamingCommitActive: false,
    recordingMimeType: "audio/webm",
    recordingStartTime: Date.now(),
    micRecovery: { stop() {} },
    teardownSpeechGate() {},
    cleanupPreview: async () => null,
    shouldShowPreviewCleanupState: () => false,
    mergeRecordedSegments: async (segments, quality) => {
      seen.push(quality);
      finalizing._recordingQuality = "original";
      return segment();
    },
    getLargestRecordedSegment: () => null,
    processAudio: async () => {},
    onStateChange() {},
    _requestStreamingCancellation() {},
  });
  await finalizing.finalizeBatchRecording(segment());
  assert.deepEqual(seen, ["balanced"]);
});

test("a recording recovered after a crash merges at the quality it was spooled with", async (t) => {
  const { createManager } = await load(t);
  const seen = [];
  const manager = createManager({
    mergeRecordedSegments: async (segments, quality) => {
      seen.push(quality);
      return null;
    },
  });
  assert.equal(
    await manager._saveInterruptedRecording(
      {
        segments: [],
        startedAt: Date.now(),
        durationMs: 0,
        routeKind: null,
        recordingQuality: "smaller",
      },
      "crash"
    ),
    true
  );
  assert.deepEqual(seen, ["smaller"]);
});
