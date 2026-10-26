const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TRANSCRIPTION_REQUEST_CEILING_MS,
  TRANSCRIPTION_REQUEST_TIMEOUT_CODE,
  isLocalTranscriptionEndpoint,
  transcriptionRequestDeadlineMs,
  transcriptionRequestTimeoutError,
} = require("../../src/helpers/transcriptionRequestDeadline.js");

// WAV at 16 kHz mono s16le: 32,000 bytes per audio second.
const wavBytes = (seconds) => seconds * 32_000;

test("hosted deadlines match the plan's table: processing budget plus upload", () => {
  for (const { seconds, first, retry } of [
    { seconds: 4.6, first: 14_600, retry: 21_900 },
    { seconds: 60, first: 70_000, retry: 105_000 },
    { seconds: 200, first: 210_000, retry: 315_000 },
  ]) {
    const request = { bytesSent: wavBytes(seconds), audioSeconds: seconds };
    assert.equal(transcriptionRequestDeadlineMs({ ...request, attempt: 1 }), first, `${seconds}s`);
    assert.equal(transcriptionRequestDeadlineMs({ ...request, attempt: 2 }), retry, `${seconds}s`);
  }
});

test("the upload allowance follows the bytes actually sent, not the audio length", () => {
  const audioSeconds = 10;
  const small = transcriptionRequestDeadlineMs({ bytesSent: 64_000, audioSeconds });
  const large = transcriptionRequestDeadlineMs({ bytesSent: 6_400_000, audioSeconds });
  assert.equal(small, 10_000 + 5_000 + 1_000);
  assert.equal(large - small, 99_000, "100 s of upload at 64 KB/s, less the 1 s already counted");
});

test("local and self-hosted servers get 60 s + 3 x audio + upload on every attempt", () => {
  const request = { bytesSent: wavBytes(10), audioSeconds: 10, local: true };
  const expected = 60_000 + 30_000 + 5_000;
  assert.equal(transcriptionRequestDeadlineMs({ ...request, attempt: 1 }), expected);
  assert.equal(transcriptionRequestDeadlineMs({ ...request, attempt: 2 }), expected);
});

test("every attempt is capped at 15 minutes", () => {
  assert.equal(TRANSCRIPTION_REQUEST_CEILING_MS, 900_000);
  for (const local of [false, true]) {
    for (const attempt of [1, 2]) {
      assert.equal(
        transcriptionRequestDeadlineMs({
          bytesSent: wavBytes(3_600),
          audioSeconds: 3_600,
          local,
          attempt,
        }),
        TRANSCRIPTION_REQUEST_CEILING_MS
      );
    }
  }
});

test("an unknown length is estimated generously from the bytes", () => {
  const known = transcriptionRequestDeadlineMs({ bytesSent: 40_000, audioSeconds: 20 });
  const unknown = transcriptionRequestDeadlineMs({ bytesSent: 40_000, audioSeconds: null });
  // 40 KB read as 16 kbit/s speech is 20 s: the same budget as the known length.
  assert.equal(unknown, known);
  assert.ok(
    transcriptionRequestDeadlineMs({ bytesSent: 0, audioSeconds: undefined }) >= 10_000,
    "an empty body still gets the base budget"
  );
});

test("local endpoints: localhost, private and link-local addresses, .local, self-hosted", () => {
  for (const endpoint of [
    "http://localhost:8178/v1/audio/transcriptions",
    "http://127.0.0.1:9000/inference",
    "http://192.168.1.126:8178/v1/audio/transcriptions",
    "http://10.0.0.5/v1/audio/transcriptions",
    "https://whisper.local/v1/audio/transcriptions",
    "https://box.tailnet-1234.ts.net/v1/audio/transcriptions",
    "http://[::1]:8080/v1/audio/transcriptions",
  ]) {
    assert.equal(isLocalTranscriptionEndpoint(endpoint), true, endpoint);
  }
  for (const endpoint of [
    "https://api.openai.com/v1/audio/transcriptions",
    "https://littlebuddy-foundry-eus2.openai.azure.com/openai/deployments/gpt-4o-transcribe/audio/transcriptions",
    "https://10.example.com/v1/audio/transcriptions",
    "not a url",
  ]) {
    assert.equal(isLocalTranscriptionEndpoint(endpoint), false, endpoint);
  }
  assert.equal(
    isLocalTranscriptionEndpoint("https://stt.example.com/v1", { selfHosted: true }),
    true,
    "the self-hosted route is local whatever its host"
  );
});

test("the deadline's marker carries its own code", () => {
  const error = transcriptionRequestTimeoutError({ attempt: 2, deadlineMs: 21_900 });
  assert.equal(error.code, TRANSCRIPTION_REQUEST_TIMEOUT_CODE);
  assert.equal(error.attempt, 2);
  assert.match(error.message, /22s/);
});
