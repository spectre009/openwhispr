const test = require("node:test");
const assert = require("node:assert/strict");

// The Dictionary page's hint route (sttHintSpec.ts): the current settings
// mapped as History's Re-transcribe maps a resolved route in main
// (retry-transcription). Parity with the request each route carries is
// pinned in test/helpers/sttHintParity.test.js.

let resolveSttHintSpec;
let providers;
test.before(async () => {
  ({ resolveSttHintSpec } = await import("../../src/utils/sttHintSpec.ts"));
  providers = require("../../src/models/modelRegistryData.json").transcriptionProviders;
});

const byok = (overrides = {}) => ({
  useLocalWhisper: false,
  cloudTranscriptionMode: "byok",
  transcriptionMode: "providers",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "whisper-1",
  cloudTranscriptionBaseUrl: "https://api.openai.com/v1",
  azureSpeechEndpoint: "https://res.cognitiveservices.azure.com",
  ...overrides,
});
const spec = (settings, managed) => resolveSttHintSpec({ settings, managed, providers });

test("local: Whisper sends its prompt; sherpa (Parakeet, Cohere) sends nothing", () => {
  const local = { useLocalWhisper: true, transcriptionMode: "local" };
  assert.deepEqual(spec(byok({ ...local, localTranscriptionProvider: "whisper" })), {
    route: "local-whisper",
  });
  assert.deepEqual(spec(byok({ ...local, localTranscriptionProvider: "nvidia" })), {
    route: "none",
  });
  assert.deepEqual(spec(byok({ ...local, localTranscriptionProvider: "cohere" })), {
    route: "none",
  });
  // Local wins over OpenWhispr Cloud, as Re-transcribe's branch order has it.
  assert.deepEqual(
    spec(
      byok({
        ...local,
        localTranscriptionProvider: "whisper",
        cloudTranscriptionMode: "openwhispr",
      })
    ),
    { route: "local-whisper" }
  );
});

test("OpenWhispr Cloud, managed Azure, and a managed error that sends nothing", () => {
  assert.deepEqual(spec(byok({ cloudTranscriptionMode: "openwhispr" })), { route: "cloud" });
  const managed = {
    kind: "managed",
    provider: "azure",
    deployment: "whisper",
    context: { inferenceScope: "transcription", workspaceId: "ws", policyRevision: 1 },
  };
  assert.deepEqual(spec(byok({ cloudTranscriptionMode: "openwhispr" }), managed), {
    route: "managed",
  });
  assert.deepEqual(spec(byok(), { kind: "error", message: "no", code: "X" }), { route: "none" });
});

test("providers with a channel of their own: Azure Speech, Mistral, Gemini, xAI, Tinfoil", () => {
  assert.deepEqual(
    spec(
      byok({
        cloudTranscriptionProvider: "azure-speech",
        cloudTranscriptionModel: "MAI-Transcribe-2",
      })
    ),
    { route: "azure-speech" }
  );
  assert.deepEqual(spec(byok({ cloudTranscriptionProvider: "mistral" })), { route: "mistral" });
  assert.deepEqual(spec(byok({ cloudTranscriptionProvider: "gemini" })), { route: "gemini" });
  assert.deepEqual(spec(byok({ cloudTranscriptionProvider: "xai" })), { route: "xai" });
  assert.deepEqual(
    spec(
      byok({
        cloudTranscriptionProvider: "tinfoil",
        cloudTranscriptionBaseUrl: "https://inference.tinfoil.sh/v1",
      })
    ),
    { route: "tinfoil" }
  );
  assert.deepEqual(spec(byok({ cloudTranscriptionProvider: "corti" })), { route: "none" });
});

test("OpenAI-compatible: OpenAI, Groq, custom and self-hosted, with the route's endpoint and model", () => {
  assert.deepEqual(spec(byok({ cloudTranscriptionModel: "gpt-4o-mini-transcribe" })), {
    route: "openai-compatible",
    provider: "openai",
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    model: "gpt-4o-mini-transcribe",
  });
  const groq = spec(
    byok({
      cloudTranscriptionProvider: "groq",
      cloudTranscriptionModel: "whisper-large-v3",
      cloudTranscriptionBaseUrl: "https://api.groq.com/openai/v1",
    })
  );
  assert.equal(groq.route, "openai-compatible");
  assert.equal(groq.provider, "groq");
  assert.match(groq.endpoint, /api\.groq\.com/);
  assert.equal(groq.model, "whisper-large-v3");
  const custom = spec(
    byok({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionModel: "whisper-large-v3-turbo",
      cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
    })
  );
  assert.deepEqual(custom, {
    route: "openai-compatible",
    provider: "custom",
    endpoint: "https://stt.example.com/v1/audio/transcriptions",
    model: "whisper-large-v3-turbo",
  });
  // Self-hosted wins over everything, OpenWhispr Cloud and local included.
  const selfHosted = spec(
    byok({
      transcriptionMode: "self-hosted",
      remoteTranscriptionType: "openai-compatible",
      remoteTranscriptionUrl: "https://stt.example.com/v1",
      remoteTranscriptionModel: "orukeet-v0.1.0",
      cloudTranscriptionMode: "openwhispr",
      useLocalWhisper: true,
    })
  );
  assert.equal(selfHosted.route, "openai-compatible");
  assert.equal(selfHosted.model, "orukeet-v0.1.0");
  assert.match(selfHosted.endpoint, /stt\.example\.com/);
});

test("no batch route: a streaming-only provider or a broken endpoint sends nothing, unless Cloud", () => {
  assert.deepEqual(spec(byok({ cloudTranscriptionProvider: "deepgram" })), { route: "none" });
  const broken = byok({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "not a url",
  });
  assert.deepEqual(spec(broken), { route: "none" });
  // A leftover BYOK error doesn't block the Cloud pipeline.
  assert.deepEqual(spec({ ...broken, cloudTranscriptionMode: "openwhispr" }), { route: "cloud" });
});
