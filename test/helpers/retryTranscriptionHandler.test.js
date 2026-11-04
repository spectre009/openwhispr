const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const { createStepHistory } = require("../../src/helpers/stepHistory.js");
const originalLoad = Module._load;

// Captures every ipcMain.handle registration and every net.fetch request so the
// registered handler closures can be invoked directly against a fake `this`.
const handlers = new Map();
const fetches = [];
const poolPartitions = [];
let fetchResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ text: "transcribed" }),
  text: async () => JSON.stringify({ text: "transcribed" }),
});

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: {
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      return fetchResponse(String(url), init);
    },
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  // History's OpenAI-compatible re-sends go out on their own pool
  // (connectionPool.js); its fetch is captured like net.fetch.
  session: {
    fromPartition: (partition) => {
      poolPartitions.push(partition);
      return {
        fetch: (url, init) => electronStub.net.fetch(url, init),
        closeAllConnections: async () => {},
      };
    },
  },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

// A 44-byte RIFF header is enough for isWavFormat, which only sniffs the magic.
const WAV_BUFFER = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(32),
]);
const CONVERTED_WAV = Buffer.concat([WAV_BUFFER, Buffer.from("converted")]);

// Conversion is mocked rather than run: spawning ffmpeg from a unit test would
// make it slow and dependent on the runner having a usable binary.
const wavConversions = [];
let convertBehavior = async () => CONVERTED_WAV;
// File-to-file conversions (Azure Speech uploads of a container it doesn't take).
const wavFileConversions = [];
let convertFileBehavior = async (_input, output) =>
  require("node:fs").writeFileSync(output, CONVERTED_WAV);

const cortiCalls = [];
const tinfoilCalls = [];
let cortiBehavior = async () => ({ text: "corti text" });

// Kept installed for the whole file: the corti client is require()d lazily at
// handler invocation time, not at module load.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  // ipcHandlers requires the system-browser opener: never a real one in a test.
  if (request === "./externalUrlOpener") {
    return { openExternalUrl: async () => {} };
  }
  if (parent?.filename === handlersModulePath) {
    if (request === "./cortiTranscription") {
      return {
        transcribeAudio: async (opts) => {
          cortiCalls.push(opts);
          return cortiBehavior(opts);
        },
      };
    }
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async (opts) => {
          tinfoilCalls.push(opts);
          return { text: "tinfoil text", model: "tinfoil-model" };
        },
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
    if (request === "./ffmpegUtils") {
      const real = originalLoad.call(this, request, parent, isMain);
      return {
        ...real,
        convertBufferToWav: async (buffer, options) => {
          wavConversions.push(buffer);
          return convertBehavior(buffer, options);
        },
        convertToWav: async (input, output, options) => {
          wavFileConversions.push(input);
          return convertFileBehavior(input, output, options);
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// A permissive `this` for setupHandlers: registration only stores closures, so
// any manager not exercised by the retry handler can be an inert stub.
function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const dbRows = new Map([
    [7, { id: 7, audio_duration_ms: 1200 }],
    [8, { id: 8, audio_duration_ms: 1200 }],
  ]);
  const databaseManager = {
    writes: [],
    updateTranscriptionText(id, ...rest) {
      this.writes.push(["text", id, ...rest]);
    },
    updateTranscriptionStatus(id, status) {
      this.writes.push(["status", id, status]);
    },
    updateTranscriptionAudio(id, audio) {
      this.writes.push(["audio", id, audio.provider, audio.model]);
    },
    getTranscriptionById: (id) => dbRows.get(id),
  };
  const target = {
    sessionId: "test-session",
    audioStorageManager: {
      // 7 is a stored WebM recording, 8 one already in WAV.
      getAudioBuffer: (id) => (id === 7 ? Buffer.from([1, 2, 3]) : id === 8 ? WAV_BUFFER : null),
    },
    databaseManager,
    // The real step-history service over the fake database: retry runs and
    // their revisions, and the writes they guard.
    stepHistory: createStepHistory({
      db: databaseManager,
      getOwner: () => "signed-out",
      isEnabled: () => true,
    }),
    environmentManager: {
      getOpenAIKey: () => "sk-openai",
      getGroqKey: () => "gk-groq",
      getMistralKey: () => "mk-mistral",
      getXaiKey: () => "xk-xai",
      getTinfoilKey: () => "tk-tinfoil",
      getCustomTranscriptionKey: () => "ck-custom",
      getCortiClientId: () => "corti-id",
      getCortiClientSecret: () => "corti-secret",
      getAzureSpeechKey: () => "az-speech-key",
    },
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

let retryHandler;
let fakeThis;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  fakeThis = buildFakeThis();
  Ctor.prototype.setupHandlers.call(fakeThis);
  retryHandler = handlers.get("retry-transcription");
  assert.ok(retryHandler, "retry-transcription must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

const invoke = (settings, id = 7) => retryHandler({ sender: {} }, id, settings);

test("retry: corti routes to the corti client, never OpenAI", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cortiEnvironment: "eu",
    cortiTenant: "acme",
    preferredLanguage: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(cortiCalls.length, 1);
  assert.equal(cortiCalls[0].environment, "eu");
  assert.equal(cortiCalls[0].tenant, "acme");
  assert.equal(cortiCalls[0].language, "en");
  assert.equal(fetches.length, 0, "corti retry must not touch HTTP endpoints");
});

const CORTI = {
  cloudTranscriptionProvider: "corti",
  cloudTranscriptionMode: "byok",
  transcriptionMode: "providers",
  cortiEnvironment: "eu",
  cortiTenant: "acme",
  preferredLanguage: "auto",
};

// Speech-to-text answers only when the test says so, so another run on the
// same row can begin while this one waits.
function holdCorti() {
  let answer;
  cortiBehavior = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  return {
    answer: (text) => answer({ text }),
    restore: () => {
      cortiBehavior = async () => ({ text: "corti text" });
    },
  };
}

test("retry: a Re-transcribe a Re-run cleanup overtook writes nothing", async (t) => {
  const corti = holdCorti();
  t.after(corti.restore);
  fakeThis.databaseManager.writes.length = 0;
  const pending = invoke(CORTI);
  await new Promise((resolve) => setImmediate(resolve));
  // Re-run cleanup begins its own run on the row (step-history-begin-run).
  const cleanupRun = fakeThis.stepHistory.beginRun({ transcriptionId: 7 });
  assert.ok(cleanupRun);
  corti.answer("heard again");
  const result = await pending;
  assert.deepEqual(result, { success: false, stale: true });
  assert.deepEqual(
    fakeThis.databaseManager.writes,
    [],
    "no text, status, audio, provider or model write"
  );
});

test("retry: a Re-transcribe begun after a Re-run cleanup writes, and the cleanup's completion is dropped", async (t) => {
  const corti = holdCorti();
  t.after(corti.restore);
  fakeThis.databaseManager.writes.length = 0;
  const cleanupRun = fakeThis.stepHistory.beginRun({ transcriptionId: 7 });
  const pending = invoke(CORTI);
  await new Promise((resolve) => setImmediate(resolve));
  corti.answer("heard again");
  const result = await pending;
  assert.equal(result.success, true);
  assert.deepEqual(
    fakeThis.databaseManager.writes.map((write) => write.slice(0, 3)),
    [
      ["text", 7, "heard again"],
      ["status", 7, "completed"],
      ["audio", 7, "corti"],
    ]
  );
  // The overtaken Re-run cleanup's completion is stale: nothing written.
  fakeThis.databaseManager.writes.length = 0;
  const completion = fakeThis.stepHistory.completeRetry(7, "Cleaned.", "heard", {
    trace: { version: 1, runId: cleanupRun, steps: [] },
  });
  assert.deepEqual(completion, { success: false, stale: true });
  assert.deepEqual(fakeThis.databaseManager.writes, []);
});

test("retry: custom misconfiguration fails closed with a coded error", async () => {
  fetches.length = 0;
  for (const cloudTranscriptionBaseUrl of ["", "https://api.openai.com/v1", "not a url"]) {
    const result = await invoke({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cloudTranscriptionBaseUrl,
    });
    assert.equal(result.success, false, cloudTranscriptionBaseUrl);
    assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID", cloudTranscriptionBaseUrl);
  }
  assert.equal(fetches.length, 0);
});

test("retry: openwhispr cloud masks a leftover BYOK misconfiguration", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "openwhispr",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "",
  });
  // BrowserWindow.fromWebContents is stubbed to null, so the cloud branch
  // produces no result — but the route error must NOT surface.
  assert.equal(result.success, false);
  assert.notEqual(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.match(result.error, /No transcription engine available/);
  assert.equal(fetches.length, 0);
});

test("retry: Azure custom endpoints get deployment URLs and api-key auth", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://myres.openai.azure.com",
    cloudTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /myres\.openai\.azure\.com\/openai\/deployments\/my-deployment/);
  assert.equal(fetches[0].init.headers["api-key"], "ck-custom");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
});

test("retry: plain custom endpoints use Bearer auth at the configured URL", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
    cloudTranscriptionModel: "parasail-model",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].url, "https://stt.parasail.example.com/v1/audio/transcriptions");
  assert.equal(fetches[0].init.headers.Authorization, "Bearer ck-custom");
});

test("retry: OpenAI-compatible re-sends get a deadline on History's own pool", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionModel: "whisper-1",
  });
  assert.equal(result.success, true);
  assert.ok(poolPartitions.includes("ow-history-stt"));
  assert.ok(!poolPartitions.includes("ow-dictation-stt"), "never the live dictation's pool");
  assert.ok(fetches[0].init.signal instanceof AbortSignal, "the deadline can abort it");
  assert.deepEqual(
    [...fetches[0].init.body.keys()],
    ["file", "model"],
    "the same form as before: no prompt, keywords or stream"
  );
});

const CUSTOM_SETTINGS = {
  cloudTranscriptionProvider: "custom",
  cloudTranscriptionMode: "byok",
  transcriptionMode: "providers",
  cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
  cloudTranscriptionModel: "parasail-model",
};

const uploadedPart = () => fetches[0].init.body.get("file");

test("retry: a stored WebM is re-encoded before reaching a custom endpoint", async () => {
  // Without this the renderer-side fix covers fresh dictations only, and every
  // retry of a recording that failed for the container reason fails again.
  fetches.length = 0;
  wavConversions.length = 0;

  const result = await invoke(CUSTOM_SETTINGS);

  assert.equal(result.success, true);
  assert.equal(wavConversions.length, 1, "the stored container must be converted");
  const part = uploadedPart();
  assert.equal(part.name, "audio.wav");
  assert.equal(part.type, "audio/wav");
  assert.equal(part.size, CONVERTED_WAV.length, "the converted bytes are what gets uploaded");
});

test("retry: audio already in WAV is uploaded untouched", async () => {
  fetches.length = 0;
  wavConversions.length = 0;

  const result = await invoke(CUSTOM_SETTINGS, 8);

  assert.equal(result.success, true);
  assert.equal(wavConversions.length, 0, "re-encoding WAV would only cost time");
  assert.equal(uploadedPart().size, WAV_BUFFER.length);
});

test("retry: WAV expansion preserves uploads that fit the provider limit", async (t) => {
  for (const wavSize of [25 * 1024 * 1024, 25 * 1024 * 1024 + 1]) {
    await t.test(`${wavSize} converted bytes`, async () => {
      fetches.length = 0;
      const converted = Buffer.alloc(wavSize);
      WAV_BUFFER.copy(converted);
      convertBehavior = async () => converted;
      try {
        const result = await invoke(CUSTOM_SETTINGS);
        assert.equal(result.success, true);
        const part = uploadedPart();
        const fits = wavSize === 25 * 1024 * 1024;
        assert.equal(part.type, fits ? "audio/wav" : "audio/webm");
        assert.equal(part.name, fits ? "audio.wav" : "audio.webm");
        assert.deepEqual(
          Buffer.from(await part.arrayBuffer()),
          fits ? converted : Buffer.from([1, 2, 3])
        );
      } finally {
        convertBehavior = async () => CONVERTED_WAV;
      }
    });
  }
});

test("retry: built-in providers keep sending the stored container", async () => {
  fetches.length = 0;
  wavConversions.length = 0;

  await invoke({
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionModel: "whisper-1",
  });

  assert.equal(wavConversions.length, 0, "only custom endpoints need the re-encode");
  assert.equal(uploadedPart().name, "audio.webm");
});

test("retry: a conversion failure falls open to the stored container", async () => {
  fetches.length = 0;
  wavConversions.length = 0;
  convertBehavior = async () => {
    throw new Error("ffmpeg missing");
  };

  try {
    const result = await invoke(CUSTOM_SETTINGS);
    assert.equal(result.success, true, "a failed re-encode must not fail the retry");
    const part = uploadedPart();
    assert.equal(part.name, "audio.webm");
    assert.equal(part.type, "audio/webm");
  } finally {
    convertBehavior = async () => CONVERTED_WAV;
  }
});

test("retry: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://inference.tinfoil.sh/v1",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
  assert.equal(tinfoilCalls.length, 0);
});

test("retry: mistral goes to Mistral with x-api-key", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "mistral",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
});

test("retry: a missing BYOK key on the generic provider branch is a classified error", async () => {
  fetches.length = 0;
  const originalGetMistralKey = fakeThis.environmentManager.getMistralKey;
  fakeThis.environmentManager.getMistralKey = () => "";
  try {
    const result = await invoke({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
    });
    assert.equal(result.success, false);
    assert.equal(result.code, "API_KEY_MISSING");
    assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.deepEqual(result.messageParams, { provider: "Mistral" });
    assert.equal(fetches.length, 0, "a missing key must fail before any request is sent");
  } finally {
    fakeThis.environmentManager.getMistralKey = originalGetMistralKey;
  }
});

test("retry: missing Corti credentials are a classified error", async () => {
  fetches.length = 0;
  const cortiCallsBefore = cortiCalls.length;
  const originalGetCortiClientId = fakeThis.environmentManager.getCortiClientId;
  fakeThis.environmentManager.getCortiClientId = () => "";
  try {
    const result = await invoke({
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cortiEnvironment: "eu",
      cortiTenant: "acme",
    });
    assert.equal(result.success, false);
    assert.equal(result.code, "API_KEY_MISSING");
    assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.deepEqual(result.messageParams, { provider: "Corti" });
    assert.equal(
      cortiCalls.length,
      cortiCallsBefore,
      "a missing credential must fail before calling Corti"
    );
  } finally {
    fakeThis.environmentManager.getCortiClientId = originalGetCortiClientId;
  }
});

test("proxy-corti-transcription: missing credentials are a classified error", async () => {
  const fn = handlers.get("proxy-corti-transcription");
  assert.ok(fn, "proxy-corti-transcription must be registered");
  const cortiCallsBefore = cortiCalls.length;
  const originalGetCortiClientId = fakeThis.environmentManager.getCortiClientId;
  fakeThis.environmentManager.getCortiClientId = () => "";
  try {
    const result = await fn({ sender: {} }, { audioBuffer: new ArrayBuffer(4) });
    assert.equal(result.code, "API_KEY_MISSING");
    assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.deepEqual(result.messageParams, { provider: "Corti" });
    assert.equal(
      cortiCalls.length,
      cortiCallsBefore,
      "a missing credential must fail before calling Corti"
    );
  } finally {
    fakeThis.environmentManager.getCortiClientId = originalGetCortiClientId;
  }
});

test("proxy transcription handlers resolve to structured errors instead of rejecting", async () => {
  fetchResponse = () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
    json: async () => ({}),
  });
  cortiBehavior = async () => {
    const err = new Error("Corti API Error: 401");
    err.code = "INVALID_KEY";
    throw err;
  };
  try {
    for (const channel of [
      "proxy-mistral-transcription",
      "proxy-xai-transcription",
      "proxy-corti-transcription",
    ]) {
      const fn = handlers.get(channel);
      assert.ok(fn, `${channel} must be registered`);
      const result = await fn({ sender: {} }, { audioBuffer: new ArrayBuffer(4) });
      assert.equal(typeof result.error, "string", channel);
    }
  } finally {
    cortiBehavior = async () => ({ text: "corti text" });
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "transcribed" }),
      text: async () => JSON.stringify({ text: "transcribed" }),
    });
  }
});

const fsNode = require("node:fs");
const osNode = require("node:os");
const pathNode = require("node:path");

const uploadTempFile = pathNode.join(osNode.tmpdir(), "openwhispr-upload-handler-test.webm");

const invokeUpload = (payload) => {
  const uploadHandler = handlers.get("transcribe-audio-file-byok");
  assert.ok(uploadHandler, "transcribe-audio-file-byok must be registered");
  fsNode.writeFileSync(uploadTempFile, Buffer.from([1, 2, 3, 4]));
  return uploadHandler({ sender: {} }, { filePath: uploadTempFile, ...payload });
};

test("upload: mistral sends x-api-key with a provider-validated model and no language on auto", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "mk-mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "gpt-4o-mini-transcribe", // stale from an openai era — must degrade
    provider: "mistral",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
  const body = fetches[0].init.body.toString();
  assert.match(body, /voxtral-mini-latest/);
  assert.doesNotMatch(body, /name="language"/);
});

test("upload: openai diarization fields ride the route, Bearer auth", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "sk-openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    provider: "openai",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].init.headers.Authorization, "Bearer sk-openai");
  const body = fetches[0].init.body.toString();
  assert.match(body, /gpt-4o-transcribe-diarize/);
  assert.match(body, /diarized_json/);
});

test("upload: sentinel custom URL fails closed before any request", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.equal(fetches.length, 0);
});

test("upload: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://inference.tinfoil.sh/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
});

// An uploaded file is frequently not in the dictation language, and a wrong hint
// silently mistranscribes it — so BYOK cloud uploads auto-detect even when the
// user has pinned a preferred language for dictation.
test("upload: a preferred language never constrains a BYOK cloud upload", async () => {
  for (const provider of ["openai", "groq", "custom"]) {
    fetches.length = 0;
    const result = await invokeUpload({
      apiKey: "sk-key",
      baseUrl: provider === "custom" ? "https://gateway.example.com/v1" : "",
      model: "whisper-1",
      provider,
      language: "de",
      transcriptionMode: "providers",
    });
    assert.equal(result.success, true, provider);
    assert.doesNotMatch(fetches[0].init.body.toString(), /name="language"/, provider);
  }
});

// Providers that require a concrete language still receive one.
test("upload: corti and xai still get their language", async () => {
  fetches.length = 0;
  const xai = await invokeUpload({
    apiKey: "xk-key",
    baseUrl: "",
    model: "grok-stt",
    provider: "xai",
    language: "de",
    transcriptionMode: "providers",
  });
  assert.equal(xai.success, true);
  assert.match(fetches[0].url, /api\.x\.ai/);
  const xaiBody = fetches[0].init.body.toString();
  assert.match(xaiBody, /name="language"[\s\S]*?de/);
  assert.doesNotMatch(xaiBody, /name="model"/);

  const corti = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "corti-transcribe",
    provider: "corti",
    language: "",
    environment: "eu",
    tenant: " acme ",
    transcriptionMode: "providers",
  });
  assert.equal(corti.success, true);
  assert.equal(cortiCalls.at(-1).language, "en", "corti needs a concrete primaryLanguage");
  assert.equal(cortiCalls.at(-1).environment, "eu");
  assert.equal(cortiCalls.at(-1).tenant, "acme");
});

// #1459 made cloudTranscriptionBaseUrl Custom-only, so provider id alone can no
// longer tell whether a Custom endpoint fronts a diarization-capable API.
test("upload: a Custom endpoint fronting OpenAI or Mistral keeps diarization", async () => {
  fetches.length = 0;
  const openaiFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(openaiFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /gpt-4o-transcribe-diarize/);

  fetches.length = 0;
  const mistralFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.mistral.ai/v1/audio/transcriptions",
    model: "voxtral-mini-latest",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(mistralFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /name="diarize"/);

  fetches.length = 0;
  const unknownGateway = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://gateway.example.com/v1",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(unknownGateway.success, true, "an unknown gateway degrades, never fails");
  assert.doesNotMatch(fetches[0].init.body.toString(), /diarized_json/);
});

test("upload: a self-hosted Azure endpoint keeps its deployment URL", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "",
    provider: "custom",
    language: "",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myorg.openai.azure.com",
    remoteTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(
    fetches[0].url,
    "https://myorg.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );
});

// Electron's net.fetch rejects with a plain Error whose message is the Chromium
// net error and no code; both BYOK handlers must classify it before replying.
async function withFetchRejecting(message, run) {
  const originalFetchResponse = fetchResponse;
  fetchResponse = () => {
    throw new Error(message);
  };
  try {
    return await run();
  } finally {
    fetchResponse = originalFetchResponse;
  }
}

test("retry: a net::ERR_* failure from a BYOK provider is classified as unreachable", async () => {
  const result = await withFetchRejecting("net::ERR_INTERNET_DISCONNECTED", () =>
    invoke({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
    })
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "PROVIDER_UNREACHABLE");
  assert.equal(result.messageKey, "providerErrors.unreachable");
  assert.equal(result.messageParams.provider, "Mistral");
  assert.equal(result.surface, "transcription");
});

test("retry: a self-hosted timeout names the user's server", async () => {
  const result = await withFetchRejecting("net::ERR_CONNECTION_TIMED_OUT", () =>
    invoke({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://stt.example.com/v1",
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionMode: "byok",
    })
  );
  assert.equal(result.code, "PROVIDER_TIMEOUT");
  assert.equal(result.messageKey, "providerErrors.selfHosted.timeout");
});

test("retry: a cancelled request (net::ERR_ABORTED) is not classified", async () => {
  const result = await withFetchRejecting("net::ERR_ABORTED", () =>
    invoke({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
    })
  );
  assert.equal(result.success, false);
  assert.equal(result.messageKey, undefined);
  assert.equal(result.error, "net::ERR_ABORTED");
});

test("upload: a net::ERR_* failure from a BYOK provider is classified as unreachable", async () => {
  const result = await withFetchRejecting("net::ERR_NAME_NOT_RESOLVED", () =>
    invokeUpload({
      apiKey: "sk-openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-transcribe",
      provider: "openai",
      language: "",
      transcriptionMode: "providers",
    })
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "PROVIDER_UNREACHABLE");
  assert.equal(result.messageParams.provider, "OpenAI");
  assert.equal(result.surface, "transcription");
  assert.equal(result.error, "Couldn't reach OpenAI. Check your connection.");
});

test("upload: an HTTP failure logs its status and a redacted body", async (t) => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const warnings = [];
  t.mock.method(debugLogger, "warn", (message, meta) => warnings.push({ message, meta }));
  const originalFetchResponse = fetchResponse;
  t.after(() => {
    fetchResponse = originalFetchResponse;
  });
  const body = '{"error":{"message":"Incorrect API key provided: sk-proj-leakedKey12345"}}';
  fetchResponse = () => ({
    ok: false,
    status: 401,
    headers: new Headers(),
    text: async () => body,
    json: async () => JSON.parse(body),
  });

  const result = await invokeUpload({
    apiKey: "sk-openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    provider: "openai",
    language: "",
    transcriptionMode: "providers",
  });

  assert.equal(result.code, "PROVIDER_AUTH_FAILED");
  const failure = warnings.find(({ message }) => message === "BYOK file transcription failed");
  assert.ok(failure, "the failure must be logged");
  assert.equal(failure.meta.status, 401);
  assert.match(failure.meta.body, /Incorrect API key provided/);
  assert.equal(failure.meta.body.includes("sk-proj-leakedKey12345"), false);
});

// ── Azure Speech (MAI-Transcribe-2) ──────────────────────────────────────────

const AZURE_ENDPOINT = "https://res.cognitiveservices.azure.com";
const AZURE_TRANSCRIBE_URL =
  "https://res.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15";
const AZURE_SETTINGS = {
  cloudTranscriptionProvider: "azure-speech",
  cloudTranscriptionMode: "byok",
  transcriptionMode: "providers",
  cloudTranscriptionModel: "MAI-Transcribe-2",
  azureSpeechEndpoint: AZURE_ENDPOINT,
  preferredLanguage: "en",
};
const azureAnswer =
  (body, status = 200) =>
  () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  });
const AZURE_OK = azureAnswer(
  JSON.stringify({ combinedPhrases: [{ text: " Heard " }, { text: "" }, { text: "again." }] })
);
const definitionOf = (fetch) => JSON.parse(fetch.init.body.get("definition"));

async function withFetchResponse(response, run) {
  const original = fetchResponse;
  fetchResponse = response;
  try {
    return await run();
  } finally {
    fetchResponse = original;
  }
}

test("retry: Azure Speech converts the stored WebM and sends main's key to the resource", async () => {
  fetches.length = 0;
  wavConversions.length = 0;
  fakeThis.databaseManager.writes.length = 0;
  const result = await withFetchResponse(AZURE_OK, () => invoke(AZURE_SETTINGS));

  assert.equal(result.success, true);
  assert.equal(wavConversions.length, 1, "MAI takes WAV, MP3 or FLAC only");
  assert.equal(fetches.length, 1);
  const [request] = fetches;
  assert.equal(request.url, AZURE_TRANSCRIBE_URL);
  assert.deepEqual(request.init.headers, { "Ocp-Apim-Subscription-Key": "az-speech-key" });
  assert.deepEqual([...request.init.body.keys()], ["audio", "definition"]);
  const audio = request.init.body.get("audio");
  assert.equal(audio.type, "audio/wav");
  assert.equal(audio.size, CONVERTED_WAV.length);
  // The retry settings' language, and no dictionary: Re-transcribe sends none.
  assert.deepEqual(definitionOf(request), {
    locales: ["en"],
    enhancedMode: { enabled: true, model: "MAI-Transcribe-2" },
  });
  assert.ok(poolPartitions.includes("ow-history-stt"), "History's own pool, with its deadline");
  // The run-revision guard still writes it, joined from combinedPhrases.
  assert.deepEqual(fakeThis.databaseManager.writes[0].slice(0, 3), ["text", 7, "Heard again."]);
  assert.deepEqual(fakeThis.databaseManager.writes.at(-1).slice(0, 4), [
    "audio",
    7,
    "azure-speech",
    "MAI-Transcribe-2",
  ]);
});

// Live dictation's empty answer is EMPTY_TRANSCRIPT (silence); Re-transcribe's
// is main's own path and keeps what it showed: no code, nothing written.
test("retry: an empty Azure Speech answer still reads as no transcript, uncoded", async () => {
  fetches.length = 0;
  fakeThis.databaseManager.writes.length = 0;
  const result = await withFetchResponse(
    azureAnswer(JSON.stringify({ durationMilliseconds: 1500, combinedPhrases: [] })),
    () => invoke(AZURE_SETTINGS)
  );
  assert.equal(fetches.length, 1);
  assert.deepEqual(result, { success: false, error: "No transcription engine available" });
  assert.deepEqual(fakeThis.databaseManager.writes, []);
});

test("retry: Azure Speech fails closed without a valid endpoint, sending nothing", async () => {
  for (const azureSpeechEndpoint of [
    "",
    "https://res.openai.azure.com",
    "https://evil.example.com",
    "http://res.cognitiveservices.azure.com",
    "https://res.services.ai.azure.com/openai/v1",
  ]) {
    fetches.length = 0;
    const result = await invoke({ ...AZURE_SETTINGS, azureSpeechEndpoint });
    assert.equal(result.success, false, azureSpeechEndpoint);
    assert.equal(result.code, "AZURE_SPEECH_ENDPOINT_INVALID", azureSpeechEndpoint);
    assert.equal(
      result.messageKey,
      "hooks.audioRecording.errorDescriptions.azureSpeechEndpointMissing"
    );
    assert.equal(fetches.length, 0, "no fall-through to another provider");
  }
});

// The AI Connections field saves as typed until it's left, so the retry
// settings can carry a Foundry value unconverted: the request still goes to
// the documented host with main's key, never to services.ai.
test("retry: a stored, unconverted Foundry endpoint is sent to the cognitiveservices host", async () => {
  for (const azureSpeechEndpoint of [
    "https://res.services.ai.azure.com",
    "https://res.services.ai.azure.com/api/projects/proj-1",
  ]) {
    fetches.length = 0;
    const result = await withFetchResponse(AZURE_OK, () =>
      invoke({ ...AZURE_SETTINGS, azureSpeechEndpoint })
    );
    assert.equal(result.success, true, azureSpeechEndpoint);
    assert.equal(fetches.length, 1, azureSpeechEndpoint);
    assert.equal(fetches[0].url, AZURE_TRANSCRIBE_URL, azureSpeechEndpoint);
    assert.deepEqual(fetches[0].init.headers, { "Ocp-Apim-Subscription-Key": "az-speech-key" });
  }
});

test("retry: Azure Speech without a saved key is a classified error before any request", async () => {
  fetches.length = 0;
  const original = fakeThis.environmentManager.getAzureSpeechKey;
  fakeThis.environmentManager.getAzureSpeechKey = () => "";
  try {
    const result = await invoke(AZURE_SETTINGS);
    assert.equal(result.code, "API_KEY_MISSING");
    assert.deepEqual(result.messageParams, { provider: "Azure Speech" });
    assert.equal(fetches.length, 0);
  } finally {
    fakeThis.environmentManager.getAzureSpeechKey = original;
  }
});

test("retry: Azure Speech's conversion failure is worded, never a WebM upload", async () => {
  fetches.length = 0;
  convertBehavior = async () => {
    throw new Error("FFmpeg exited with code 1");
  };
  try {
    const result = await invoke(AZURE_SETTINGS);
    assert.equal(result.success, false);
    assert.equal(result.code, "AZURE_SPEECH_CONVERSION_FAILED");
    assert.equal(
      result.messageKey,
      "hooks.audioRecording.errorDescriptions.azureSpeechConversionFailed"
    );
    assert.equal(fetches.length, 0);
  } finally {
    convertBehavior = async () => CONVERTED_WAV;
  }
});

test("retry: Azure Speech's 404 reads as a wrong endpoint, not a model", async () => {
  const body = JSON.stringify({ error: { code: "404", message: "Resource not found" } });
  const result = await withFetchResponse(azureAnswer(body, 404), () => invoke(AZURE_SETTINGS));
  assert.equal(result.code, "AZURE_SPEECH_ENDPOINT_INVALID");
  assert.equal(result.messageKey, "providerErrors.azureSpeech.endpointNotFound");
  assert.equal(result.settingsTarget, "speechToText");
});

const azureUploadFile = (extension) => {
  const file = pathNode.join(osNode.tmpdir(), `openwhispr-azure-upload-test.${extension}`);
  fsNode.writeFileSync(file, Buffer.from([1, 2, 3, 4, 5]));
  return file;
};
const invokeAzureUpload = (extension, payload = {}) =>
  handlers.get("transcribe-audio-file-byok")(
    { sender: {} },
    {
      filePath: azureUploadFile(extension),
      apiKey: "renderer-azure-key",
      baseUrl: "",
      model: "MAI-Transcribe-2",
      provider: "azure-speech",
      language: "de",
      transcriptionMode: "providers",
      azureSpeechEndpoint: AZURE_ENDPOINT,
      ...payload,
    }
  );

test("upload: Azure Speech sends WAV, MP3 and FLAC as they are, with no locale or phrases", async () => {
  for (const [extension, type] of [
    ["wav", "audio/wav"],
    ["mp3", "audio/mpeg"],
    ["flac", "audio/flac"],
  ]) {
    fetches.length = 0;
    wavFileConversions.length = 0;
    const result = await withFetchResponse(AZURE_OK, () => invokeAzureUpload(extension));
    assert.deepEqual(result, { success: true, text: "Heard again." }, extension);
    assert.equal(wavFileConversions.length, 0, extension);
    const [request] = fetches;
    assert.equal(request.url, AZURE_TRANSCRIBE_URL);
    assert.deepEqual(request.init.headers, { "Ocp-Apim-Subscription-Key": "renderer-azure-key" });
    assert.deepEqual([...request.init.body.keys()], ["audio", "definition"]);
    assert.equal(request.init.body.get("audio").type, type);
    assert.equal(request.init.body.get("audio").size, 5);
    // An imported file is often in another language: no locale, even with "de" set.
    assert.deepEqual(definitionOf(request), {
      enhancedMode: { enabled: true, model: "MAI-Transcribe-2" },
    });
    assert.equal(request.init.body.get("file"), null, "never the upload's own `file` part");
  }
});

test("upload: Azure Speech converts any other container to WAV first", async () => {
  fetches.length = 0;
  wavFileConversions.length = 0;
  const result = await withFetchResponse(AZURE_OK, () => invokeAzureUpload("webm"));
  assert.equal(result.success, true);
  assert.equal(wavFileConversions.length, 1);
  const audio = fetches[0].init.body.get("audio");
  assert.equal(audio.type, "audio/wav");
  assert.equal(audio.size, CONVERTED_WAV.length);

  // A conversion that fails fails the upload; nothing is sent.
  fetches.length = 0;
  convertFileBehavior = async () => {
    throw new Error("FFmpeg exited with code 1");
  };
  try {
    const failed = await invokeAzureUpload("m4a");
    assert.equal(failed.success, false);
    assert.equal(failed.code, "AZURE_SPEECH_CONVERSION_FAILED");
    assert.equal(fetches.length, 0);
  } finally {
    convertFileBehavior = async (_input, output) => fsNode.writeFileSync(output, CONVERTED_WAV);
  }
});

test("upload: Azure Speech's cap is 250 MB on the audio as sent, after conversion", async () => {
  fetches.length = 0;
  convertFileBehavior = async (_input, output) =>
    fsNode.writeFileSync(output, Buffer.alloc(250 * 1024 * 1024 + 1));
  try {
    const result = await invokeAzureUpload("ogg");
    assert.deepEqual(result, {
      success: false,
      error: "File too large. Maximum size for bring-your-own-key is 250 MB.",
    });
    assert.equal(fetches.length, 0);
  } finally {
    convertFileBehavior = async (_input, output) => fsNode.writeFileSync(output, CONVERTED_WAV);
  }
});

test("upload: Azure Speech falls back to main's key, and fails closed without an endpoint", async () => {
  fetches.length = 0;
  const result = await withFetchResponse(AZURE_OK, () => invokeAzureUpload("wav", { apiKey: "" }));
  assert.equal(result.success, true);
  assert.equal(fetches[0].init.headers["Ocp-Apim-Subscription-Key"], "az-speech-key");

  fetches.length = 0;
  const closed = await invokeAzureUpload("wav", {
    azureSpeechEndpoint: "https://evil.example.com",
  });
  assert.equal(closed.success, false);
  assert.equal(closed.code, "AZURE_SPEECH_ENDPOINT_INVALID");
  assert.equal(fetches.length, 0);
});

test("upload: a stored, unconverted Foundry endpoint is sent to the cognitiveservices host", async () => {
  for (const azureSpeechEndpoint of [
    "https://res.services.ai.azure.com",
    "https://res.services.ai.azure.com/api/projects/proj-1/",
  ]) {
    fetches.length = 0;
    const result = await withFetchResponse(AZURE_OK, () =>
      invokeAzureUpload("wav", { azureSpeechEndpoint })
    );
    assert.deepEqual(result, { success: true, text: "Heard again." }, azureSpeechEndpoint);
    assert.equal(fetches.length, 1, azureSpeechEndpoint);
    assert.equal(fetches[0].url, AZURE_TRANSCRIBE_URL, azureSpeechEndpoint);
    assert.deepEqual(fetches[0].init.headers, {
      "Ocp-Apim-Subscription-Key": "renderer-azure-key",
    });
  }
});

test("upload: Azure Speech's over-2-hours answer is worded", async () => {
  const body = JSON.stringify({
    error: {
      code: "InvalidRequest",
      message: "The audio is too long.",
      innerError: { code: "AudioLengthLimitExceeded" },
    },
  });
  const result = await withFetchResponse(azureAnswer(body, 400), () => invokeAzureUpload("wav"));
  assert.equal(result.success, false);
  assert.equal(result.code, "PROVIDER_PAYLOAD_TOO_LARGE");
  assert.equal(result.messageKey, "providerErrors.azureSpeech.audioTooLong");
  assert.equal(result.error, "This recording is longer than Azure Speech accepts (under 2 hours).");
});
