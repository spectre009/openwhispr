const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadAudioManager } = require("./harness/audioManager");
const { createStepHistory } = require("../../src/helpers/stepHistory.js");

// Re-transcribe sends the dictionary exactly as live dictation does, provider
// by provider: both sides run for real and are compared on what they put on
// the wire. Live: the dictation window's audioManager (Vite SSR) with its
// requests served by main's real handlers (the batch request module, the
// proxy-* handlers, cloud-transcribe, transcribe-local-whisper). Retry: main's
// retry-transcription handler. Every request is captured where it leaves main:
// the connection pools and net.fetch (multipart field names and values), the
// Gemini and Tinfoil clients' arguments, managed Azure's executor, the whisper
// manager. Synthetic words only.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
let captured = [];
const TEXT = "We moved the meeting to Thursday afternoon.";

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const respond = (url) =>
  url.includes("speechtotext")
    ? jsonResponse({ combinedPhrases: [{ text: TEXT }] })
    : jsonResponse({ text: TEXT });
// What the providers answer; a test may swap it (an echo of what was sent).
let responder = respond;
const fetchVia = (via) => async (url, init) => {
  captured.push({ via, url: String(url), init });
  return responder(String(url));
};

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { session: { cookies: { get: async () => [{ name: "sb", value: "token" }] } } },
};
const electronStub = {
  app: {
    getPath: () => os.tmpdir(),
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
  net: { fetch: fetchVia("net") },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return fakeWindow;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: {
    fromPartition: () => ({
      fetch: fetchVia("pool"),
      closeAllConnections: async () => {},
      webRequest: { onBeforeSendHeaders() {} },
    }),
  },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(32),
]);

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async (args) => {
          captured.push({ via: "tinfoil", args });
          return { text: TEXT, model: "tinfoil-model" };
        },
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./geminiTranscription") {
      return {
        transcribeWithGemini: async (args) => {
          captured.push({ via: "gemini", args });
          return { text: TEXT };
        },
      };
    }
    if (request === "./cortiTranscription") {
      return {
        transcribeAudio: async (args) => {
          captured.push({ via: "corti", args });
          return { text: TEXT };
        },
      };
    }
    if (request === "./windowBroadcast") return { broadcastToWindows: () => {} };
    if (request === "./ffmpegUtils") {
      const real = originalLoad.call(this, request, parent, isMain);
      return {
        ...real,
        convertBufferToWav: async () => WAV,
        convertToWav: async (_input, output) => fs.writeFileSync(output, WAV),
        // Cloud's chunked upload: two chunks, each a request of its own.
        splitAudioFile: async (_input, dir) => {
          const chunkPaths = [0, 1].map((index) => {
            const file = path.join(dir, `chunk-${index}.mp3`);
            fs.writeFileSync(file, Buffer.from(`chunk ${index}`));
            return file;
          });
          return { chunkPaths, durationSeconds: 120 };
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

// ── The dictionary: what both sides are given ───────────────────────────────

const {
  hintScoreTuples,
  hintScoresForDictionary,
  normalizeDictionaryHintOrder,
} = require("../../src/utils/dictionaryHintOrder.ts");

const dictionaryState = {
  words: [],
  learned: [],
  pinned: [],
  glossary: [],
  snippets: [],
  // The order setting and the usage counts (the usage store's words), or none.
  hintOrder: undefined,
  usage: null,
};
globalThis.__parity = dictionaryState;

function setDictionary({
  words,
  learned = [],
  pinned = [],
  glossary = [],
  snippets = [],
  hintOrder = undefined,
}) {
  Object.assign(dictionaryState, { words, learned, pinned, glossary, snippets, hintOrder });
}

// What ControlPanel.retryTranscription and the Dictionary page send of the
// scores: the usage store's, bounded to the dictionary.
const retryScores = () =>
  hintScoresForDictionary(
    dictionaryState.usage ? hintScoreTuples(dictionaryState.usage) : null,
    dictionaryState.words
  );

// ── Main ────────────────────────────────────────────────────────────────────

let whisperAnswers = [];
const STORED_SMALL = 7;
const STORED_LARGE = 9;
const databaseManager = {
  updateTranscriptionText() {},
  updateTranscriptionStatus() {},
  updateTranscriptionAudio() {},
  getTranscriptionById: (id) => ({ id, audio_duration_ms: 4000 }),
  getDictionaryEntries: () =>
    dictionaryState.words.map((word) => ({
      word,
      source: dictionaryState.learned.includes(word.trim().toLowerCase()) ? "learned" : "manual",
    })),
};
let managedPrompt;
let retryHandler;
let IPCHandlers;
const target = {
  sessionId: "parity-session",
  audioStorageManager: {
    getAudioBuffer: (id) =>
      id === STORED_SMALL
        ? Buffer.from("stored webm")
        : id === STORED_LARGE
          ? Buffer.alloc(4 * 1024 * 1024 + 16, 1)
          : null,
  },
  databaseManager,
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
    getGeminiKey: () => "gm-gemini",
    getCustomTranscriptionKey: () => "ck-custom",
    getCortiClientId: () => "corti-id",
    getCortiClientSecret: () => "corti-secret",
    getAzureSpeechKey: () => "az-key",
  },
  whisperManager: {
    serverManager: { isAvailable: () => true },
    transcribeLocalWhisper: async (_buffer, options) => {
      captured.push({ via: "whisper", options });
      return whisperAnswers.length > 0 ? whisperAnswers.shift() : { success: true, text: TEXT };
    },
  },
  parakeetManager: {
    transcribeLocalParakeet: async (_buffer, options) => {
      captured.push({ via: "parakeet", options });
      return { success: true, text: TEXT };
    },
  },
  _resolveWhisperVadOptions: () => ({ vadEnabled: true }),
  _cloudTranscriptionRequests: {
    begin: () => new AbortController(),
    cancelSender() {},
    complete() {},
  },
};
const fakeThis = new Proxy(target, {
  get: (value, property) => (property in value ? value[property] : anything()),
});
const event = { sender: { id: 1, once() {}, removeListener() {} } };

test.before(() => {
  process.env.OPENWHISPR_API_URL = "https://api.parity.test";
  delete require.cache[handlersModulePath];
  const loaded = require(handlersModulePath);
  IPCHandlers = loaded.default || loaded;
  target._learnedDictionaryWords = IPCHandlers.prototype._learnedDictionaryWords;
  IPCHandlers.prototype.setupHandlers.call(fakeThis);
  retryHandler = handlers.get("retry-transcription");
  // Managed Azure: the prompt its executor gets is the `prompt` field it sends.
  target.executeManagedTranscription = async (_event, _route, options) => {
    managedPrompt = options.prompt;
    return TEXT;
  };
});

test.after(() => {
  Module._load = originalLoad;
  delete process.env.OPENWHISPR_API_URL;
  delete globalThis.__parity;
});

// ── Live ────────────────────────────────────────────────────────────────────

// One live harness for the whole file: its browser globals and Vite server
// stay up across tests and go in test.after.
const liveCleanups = [];
const fileScope = { after: (fn) => liveCleanups.push(fn) };
test.after(async () => {
  for (const cleanup of liveCleanups.reverse()) await cleanup();
});

let live;
async function liveHarness() {
  if (live) return live;
  const t = fileScope;
  const originalContext = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    decodeAudioData() {
      const samples = new Float32Array(16);
      return Promise.resolve({
        sampleRate: 16000,
        numberOfChannels: 1,
        getChannelData: () => samples,
      });
    }
  };
  t.after(() => {
    if (originalContext === undefined) delete globalThis.OfflineAudioContext;
    else globalThis.OfflineAudioContext = originalContext;
  });
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-stt-hint-parity-test-",
    settingsKey: "__sttHintParitySettings",
    mockModules: {
      "/stores/dictionarySourcesStore": `
        export const getLearnedDictionaryWords = () => new Set(globalThis.__parity.learned);
        export const getPinnedDictionaryKeys = () => new Set(globalThis.__parity.pinned);
        export const isDictionarySourcesLoaded = () => true;
      `,
      "/glossaryTerms": `
        export const getGlossaryCanonicalTerms = () => globalThis.__parity.glossary;
        export const setGlossaryCanonicalTerms = () => {};
      `,
      "/services/managedTranscription.ts": `
        export const getManagedTranscriptionResolution = () => globalThis.__parity.managed;
        export const isManagedTranscriptionActive = () => !!globalThis.__parity.managed;
      `,
    },
  });
  const api = loaded.window.electronAPI;
  const mainHandler = (channel) => (payload) => handlers.get(channel)(event, payload);
  Object.assign(api, {
    proxyMistralTranscription: mainHandler("proxy-mistral-transcription"),
    proxyXaiTranscription: mainHandler("proxy-xai-transcription"),
    proxyGeminiTranscription: mainHandler("proxy-gemini-transcription"),
    proxyTinfoilTranscription: mainHandler("proxy-tinfoil-transcription"),
    proxyCortiTranscription: mainHandler("proxy-corti-transcription"),
    managedTranscribe: async (payload) => {
      managedPrompt = payload.prompt;
      return { text: TEXT };
    },
    cloudTranscribe: (buffer, opts) => handlers.get("cloud-transcribe")(event, buffer, opts),
    transcribeLocalWhisper: (buffer, opts) =>
      handlers.get("transcribe-local-whisper")(event, buffer, opts),
  });
  // Every live OpenAI-compatible and Azure Speech request reaches main's pool.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchVia("pool");
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  live = loaded;
  return live;
}

function liveManager(overrides = {}) {
  return live.createManager({
    isProcessing: true,
    _activeTranscriptionAbortController: null,
    translationRequested: false,
    processTranscription: async (text) => ({ text }),
    postTranscribe: async (text) => ({ text, trace: null }),
    isReasoningAvailable: async () => false,
    consumeStreamingFallbackReason: () => null,
    getAPIKey: async () => "test-key",
    ...overrides,
  });
}

const baseSettings = (overrides = {}) => ({
  useLocalWhisper: false,
  allowLocalFallback: false,
  cloudTranscriptionMode: "byok",
  transcriptionMode: "providers",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "whisper-1",
  cloudTranscriptionBaseUrl: "https://api.openai.com/v1",
  preferredLanguage: "en",
  chineseScriptPreference: "as-transcribed",
  translationSourceLanguage: "auto",
  whisperModel: "base",
  azureSpeechEndpoint: "https://res.cognitiveservices.azure.com",
  ...overrides,
});
// The dictionary as it is when a request is made.
const withDictionary = (settings) => ({
  ...settings,
  customDictionary: dictionaryState.words,
  snippets: dictionaryState.snippets,
  dictionaryHintOrder: dictionaryState.hintOrder,
});

// The retry settings ControlPanel.retryTranscription sends.
function retrySettings(settings, { translation = false, managed } = {}) {
  return {
    ...settings,
    managed,
    speechLanguage: translation
      ? settings.translationSourceLanguage || "auto"
      : settings.preferredLanguage,
    dictionary: {
      words: [...dictionaryState.words],
      pinned: [...dictionaryState.pinned],
      glossaryTerms: [...dictionaryState.glossary],
      snippets: dictionaryState.snippets.map((snippet) => ({ trigger: snippet.trigger })),
      chineseScriptPreference: settings.chineseScriptPreference ?? null,
      hintOrder: normalizeDictionaryHintOrder(settings.dictionaryHintOrder),
      scores: retryScores(),
    },
  };
}

// ── What a request carried ──────────────────────────────────────────────────

const HINT_FIELDS = new Set(["prompt", "keywords[]", "context_bias", "keyterm"]);
const multipartHints = (body) =>
  [...body.entries()]
    .filter(([name]) => HINT_FIELDS.has(name))
    .map(([name, value]) => [name, String(value)]);
const bufferHints = (body) =>
  [
    ...Buffer.from(body)
      .toString("utf8")
      .matchAll(/name="(prompt)"\r\n\r\n([\s\S]*?)\r\n--/g),
  ].map((match) => [match[1], match[2]]);

function requestHints(entries) {
  return entries.map((entry) => {
    if (entry.via === "gemini") return { gemini: entry.args.keyterms ?? null };
    if (entry.via === "tinfoil") return { tinfoil: entry.args.prompt ?? null };
    if (entry.via === "corti") return { corti: Object.keys(entry.args).sort() };
    if (entry.via === "parakeet") return { parakeet: Object.keys(entry.options).sort() };
    if (entry.via === "whisper") {
      return {
        whisper: entry.options.initialPrompt ?? null,
        vad: entry.options.vadEnabled !== false,
      };
    }
    const body = entry.init?.body;
    if (body instanceof FormData) {
      const definition = body.get("definition");
      if (definition) return { phraseList: JSON.parse(definition).phraseList ?? null };
      return { fields: multipartHints(body) };
    }
    return { fields: bufferHints(body) };
  });
}

async function liveRequest(settings, run) {
  live.setSettings(withDictionary(settings));
  captured = [];
  managedPrompt = undefined;
  await run();
  return { requests: requestHints(captured), managedPrompt };
}

async function retryRequest(settings, options = {}, id = STORED_SMALL) {
  captured = [];
  managedPrompt = undefined;
  const result = await retryHandler(event, id, retrySettings(withDictionary(settings), options));
  return { requests: requestHints(captured), managedPrompt, result };
}

async function assertParity(t, name, settings, run, options = {}) {
  await t.test(name, async () => {
    const liveSide = await liveRequest(settings, run);
    const retrySide = await retryRequest(settings, options, options.id);
    assert.ok(liveSide.requests.length > 0 || liveSide.managedPrompt !== undefined, "live sent");
    assert.deepEqual(retrySide.requests, liveSide.requests, "the same hint fields, in order");
    assert.equal(retrySide.managedPrompt, liveSide.managedPrompt);
    // The Dictionary page's coverage for these settings is what was carried.
    if (!options.translation) {
      assertCoverage(retrySide, await dictionaryPageHints(settings, options.managed));
    }
    if (options.check) await options.check(liveSide, retrySide);
  });
}

// ── The Dictionary page's coverage against what a request carried ──────────

// What the Dictionary page computes for these settings: the hint route
// (sttHintSpec.ts, as Re-transcribe maps it) and buildSttHintFields' entries.
let pageModules;
async function dictionaryPageHints(settings, managed) {
  pageModules ??= {
    spec: await import("../../src/utils/sttHintSpec.ts"),
    fields: await import("../../src/utils/sttHintFields.js"),
    providers: require("../../src/models/modelRegistryData.json").transcriptionProviders,
  };
  const spec = pageModules.spec.resolveSttHintSpec({
    settings,
    managed,
    providers: pageModules.providers,
  });
  return pageModules.fields.buildSttHintFields(spec, {
    words: dictionaryState.words,
    learned: dictionaryState.learned,
    pinned: dictionaryState.pinned,
    glossaryTerms: dictionaryState.glossary,
    snippets: dictionaryState.snippets.map((snippet) => ({ trigger: snippet.trigger })),
    chineseScriptPreference: settings.chineseScriptPreference ?? null,
    speechLanguage: settings.preferredLanguage || "auto",
    hintOrder: normalizeDictionaryHintOrder(dictionaryState.hintOrder),
    scores: retryScores(),
  });
}

const SCRIPT_BIAS = /^以下是\S*\s?/;
// A prompt's terms with where each starts (after any script bias).
function promptSpans(prompt) {
  if (!prompt) return [];
  const bias = prompt.match(SCRIPT_BIAS)?.[0] ?? "";
  const rest = prompt.slice(bias.length);
  if (!rest) return [];
  let offset = bias.length;
  return rest.split(", ").map((term) => {
    const span = { term, start: offset };
    offset += term.length + 2;
    return span;
  });
}
const termWords = (term) =>
  term
    .split(",")
    .flatMap((part) => part.trim().split(/\s+/))
    .filter(Boolean);

function assertCoverage(side, fields) {
  const sent = fields.entries.filter((entry) => entry.coverage !== "notSent");
  const sentTerms = sent.map((entry) => entry.term);
  const requests = side.managedPrompt !== undefined ? [{ managed: side.managedPrompt }] : [];
  requests.push(...side.requests);
  for (const request of requests) {
    let prompt = null;
    let carried = null;
    if ("managed" in request) prompt = request.managed;
    else if ("tinfoil" in request) prompt = request.tinfoil;
    else if ("whisper" in request) prompt = request.whisper;
    else if ("gemini" in request) carried = request.gemini ?? [];
    else if ("phraseList" in request) carried = request.phraseList?.phrases ?? [];
    else if ("corti" in request || "parakeet" in request) carried = [];
    else {
      const named = (name) => request.fields.filter(([key]) => key === name).map(([, v]) => v);
      const contextBias = named("context_bias");
      const keyterms = named("keyterm");
      if (contextBias.length > 0) {
        // Mistral: the sent terms' words lead (after the bias); anything after
        // them is the start of the first term left out.
        const words = contextBias.filter((word) => !SCRIPT_BIAS.test(word));
        const expected = sent.flatMap((entry) => termWords(entry.term));
        assert.deepEqual(words.slice(0, expected.length), expected, "context_bias");
        const rest = words.slice(expected.length);
        const next = fields.entries.find((entry) => entry.coverage === "notSent");
        if (rest.length) assert.deepEqual(termWords(next.term).slice(0, rest.length), rest);
        continue;
      }
      if (keyterms.length > 0) carried = keyterms;
      else {
        prompt = named("prompt")[0] ?? null;
        carried = [...named("keywords[]"), ...promptSpans(prompt).map((span) => span.term)];
        prompt = named("keywords[]").length > 0 ? null : prompt;
      }
    }
    if (carried === null) carried = promptSpans(prompt).map((span) => span.term);
    const expected =
      fields.budget.unit === "terms"
        ? sentTerms.map((term) => term.trim().slice(0, 50))
        : sentTerms;
    assert.deepEqual(
      [...carried].sort(),
      [...expected].sort(),
      "every term the page calls sent is carried, and nothing else"
    );
    // A Whisper prompt's tail window: read where it starts inside it.
    if (prompt && fields.budget.readChars != null) {
      const readFrom = prompt.length - fields.budget.readChars;
      for (const span of promptSpans(prompt)) {
        const entry = sent.find((candidate) => candidate.term === span.term);
        assert.equal(entry.coverage, span.start >= readFrom ? "read" : "unread", span.term);
      }
    } else {
      assert.ok(
        sent.every((entry) => entry.coverage === "read"),
        "everything sent is read"
      );
    }
  }
}

const blob = () => new Blob(["recording"], { type: "audio/webm" });
const runBatch = () => liveManager().processWithOpenAIAPI(blob(), { durationSeconds: 4 });

const WORDS = [
  "gonestly",
  "OpenWhispr",
  "agents-shared",
  "Little Buddy",
  "CLAUDE.md",
  "Scout Web",
  "EngHub",
];
const FIXTURE = {
  words: WORDS,
  learned: ["gonestly", "agents-shared", "claude.md"],
  pinned: ["scout web"],
  glossary: ["Kusto"],
  snippets: [{ trigger: "cal link", replacement: "https://cal.example" }],
};
const many = (count, prefix) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

test("OpenAI-compatible routes: prompt or keywords[], as live sends them", async (t) => {
  await liveHarness();
  setDictionary(FIXTURE);
  await assertParity(t, "whisper-1: tail-ordered prompt", baseSettings(), runBatch, {
    check: (side) => {
      const [[, prompt]] = side.requests[0].fields;
      assert.ok(prompt.endsWith("Scout Web"), "the pinned word is read last");
      assert.ok(prompt.includes("Kusto") && prompt.includes("cal link"));
    },
  });
  await assertParity(
    t,
    "a Chinese script bias leads the prompt",
    baseSettings({ preferredLanguage: "zh-CN" }),
    runBatch,
    { check: (side) => assert.match(side.requests[0].fields[0][1], /^以下是简体中文/) }
  );
  await assertParity(
    t,
    "a translation recording biases with its source language",
    baseSettings({ translationSourceLanguage: "zh-TW" }),
    () =>
      liveManager({ translationRequested: true }).processWithOpenAIAPI(blob(), {
        durationSeconds: 4,
      }),
    {
      translation: true,
      check: (side) => assert.match(side.requests[0].fields[0][1], /^以下是繁體中文/),
    }
  );
  await assertParity(
    t,
    "gpt-4o-mini-transcribe: head order",
    baseSettings({ cloudTranscriptionModel: "gpt-4o-mini-transcribe" }),
    runBatch,
    { check: (side) => assert.ok(side.requests[0].fields[0][1].startsWith("Scout Web")) }
  );

  setDictionary({ ...FIXTURE, words: [...WORDS, ...many(905, "Term")] });
  await assertParity(
    t,
    "gpt-transcribe: 900 keywords[], the rest as the prompt (overflow)",
    baseSettings({ cloudTranscriptionModel: "gpt-transcribe", preferredLanguage: "zh-CN" }),
    runBatch,
    {
      check: (side) => {
        const fields = side.requests[0].fields;
        assert.equal(fields.filter(([name]) => name === "keywords[]").length, 900);
        assert.match(fields.find(([name]) => name === "prompt")[1], /^以下是简体中文/);
      },
    }
  );

  setDictionary({ ...FIXTURE, words: [...WORDS, ...many(300, "LongerTerm")] });
  await assertParity(
    t,
    "Groq whisper-large-v3: the 890-character cap, at the boundary",
    baseSettings({
      cloudTranscriptionProvider: "groq",
      cloudTranscriptionModel: "whisper-large-v3",
      cloudTranscriptionBaseUrl: "https://api.groq.com/openai/v1",
    }),
    runBatch,
    {
      check: (side) => {
        const prompt = side.requests[0].fields[0][1];
        assert.ok(prompt.length <= 890 && prompt.length > 800, String(prompt.length));
      },
    }
  );

  setDictionary(FIXTURE);
  await assertParity(
    t,
    "a custom endpoint",
    baseSettings({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionModel: "whisper-large-v3-turbo",
      cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
    }),
    runBatch
  );
  await assertParity(
    t,
    "a self-hosted server",
    baseSettings({
      transcriptionMode: "self-hosted",
      remoteTranscriptionType: "openai-compatible",
      remoteTranscriptionUrl: "https://stt.example.com/v1",
      remoteTranscriptionModel: "whisper-large-v3",
    }),
    runBatch
  );
  await assertParity(
    t,
    "Orukeet: no prompt",
    baseSettings({
      transcriptionMode: "self-hosted",
      remoteTranscriptionType: "openai-compatible",
      remoteTranscriptionUrl: "https://stt.example.com/v1",
      remoteTranscriptionModel: "orukeet-v0.1.0",
    }),
    runBatch,
    { check: (side) => assert.deepEqual(side.requests[0].fields, []) }
  );
});

test("Azure Speech: the phrase list, ≤ 199 in head order; a one-word result is kept", async (t) => {
  await liveHarness();
  const azure = baseSettings({
    cloudTranscriptionProvider: "azure-speech",
    cloudTranscriptionModel: "MAI-Transcribe-2",
  });
  setDictionary({ ...FIXTURE, words: [...WORDS, ...many(205, "Phrase")] });
  await assertParity(t, "205 words: 199 sent, pinned first", azure, runBatch, {
    check: (side) => {
      assert.equal(side.requests[0].phraseList.phrases.length, 199);
      assert.equal(side.requests[0].phraseList.phrases[0], "Scout Web");
    },
  });
  setDictionary({ words: ["OpenWhispr"] });
  await t.test("a one-phrase dictionary whose dictation equals it is not an echo", async () => {
    responder = (url) => jsonResponse({ combinedPhrases: [{ text: "OpenWhispr" }], url });
    t.after(() => {
      responder = respond;
    });
    const liveSide = await liveRequest(azure, async () => {
      const result = await runBatch();
      assert.equal(result.text, "OpenWhispr");
    });
    const retrySide = await retryRequest(azure);
    responder = respond;
    assert.deepEqual(retrySide.requests, liveSide.requests);
    assert.deepEqual(retrySide.requests[0].phraseList, { phrases: ["OpenWhispr"] });
    assert.equal(retrySide.result.success, true, "a phrase list is a bias, not a prompt it echoes");
  });
});

test("proxied providers: Mistral context_bias, Gemini keyterms, xAI keyterm, Tinfoil prompt", async (t) => {
  await liveHarness();
  setDictionary({
    ...FIXTURE,
    words: [...WORDS, "x".repeat(70), ...many(120, "Multi Word")],
  });
  await assertParity(
    t,
    "Mistral: the biased head-order prompt's first 100 words",
    baseSettings({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionModel: "voxtral-mini-latest",
      preferredLanguage: "zh-CN",
    }),
    runBatch,
    {
      check: (side) => {
        const fields = side.requests[0].fields;
        assert.equal(fields.length, 100);
        assert.ok(fields.every(([name]) => name === "context_bias"));
        assert.match(fields[0][1], /^以下是简体中文/);
      },
    }
  );
  await assertParity(
    t,
    "Gemini: ≤ 100 keyterms of ≤ 50 characters, no snippet triggers",
    baseSettings({
      cloudTranscriptionProvider: "gemini",
      cloudTranscriptionModel: "gemini-2.5-flash",
    }),
    runBatch,
    {
      check: (side) => {
        const keyterms = side.requests[0].gemini;
        assert.equal(keyterms.length, 100);
        assert.ok(keyterms.every((term) => term.length <= 50));
        assert.ok(!keyterms.includes("cal link"));
      },
    }
  );
  await assertParity(
    t,
    "xAI: the same terms as repeated keyterm fields",
    baseSettings({ cloudTranscriptionProvider: "xai", cloudTranscriptionModel: "grok-stt" }),
    runBatch,
    {
      check: (side) => {
        const fields = side.requests[0].fields;
        assert.equal(fields.length, 100);
        assert.ok(fields.every(([name]) => name === "keyterm"));
      },
    }
  );
  setDictionary(FIXTURE);
  await assertParity(
    t,
    "Tinfoil: the unbudgeted, tail-ordered prompt",
    baseSettings({
      cloudTranscriptionProvider: "tinfoil",
      cloudTranscriptionModel: "whisper-large-v3-turbo",
      cloudTranscriptionBaseUrl: "https://inference.tinfoil.sh/v1",
    }),
    runBatch,
    { check: (side) => assert.ok(side.requests[0].tinfoil.endsWith("Scout Web")) }
  );
  await assertParity(
    t,
    "Corti: nothing, as live",
    baseSettings({
      cloudTranscriptionProvider: "corti",
      cortiEnvironment: "eu",
      cortiTenant: "acme",
    }),
    runBatch,
    {
      check: (side) => {
        const keys = side.requests[0].corti;
        assert.ok(!keys.includes("prompt") && !keys.includes("keyterms"), keys.join(","));
      },
    }
  );
});

test("managed Azure: the unbudgeted, script-biased prompt its executor sends", async (t) => {
  await liveHarness();
  setDictionary(FIXTURE);
  const managed = {
    kind: "managed",
    provider: "azure",
    deployment: "whisper",
    context: { inferenceScope: "transcription", workspaceId: "ws", policyRevision: 1 },
  };
  dictionaryState.managed = managed;
  t.after(() => {
    delete dictionaryState.managed;
  });
  await assertParity(t, "managed", baseSettings({ preferredLanguage: "zh-TW" }), runBatch, {
    managed,
    check: (side) => {
      assert.match(side.managedPrompt, /^以下是繁體中文/);
      assert.ok(side.managedPrompt.endsWith("Scout Web"));
    },
  });
});

test("OpenWhispr Cloud: the prompt on the inline upload and on every chunk", async (t) => {
  await liveHarness();
  Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
  t.after(() => delete globalThis.navigator.onLine);
  setDictionary({ ...FIXTURE, words: [...WORDS, ...many(300, "CloudTerm")] });
  const cloud = baseSettings({ cloudTranscriptionMode: "openwhispr" });
  const runCloud = (size) => () =>
    liveManager().processWithOpenWhisprCloud(
      new Blob([Buffer.alloc(size, 1)], { type: "audio/webm" }),
      {}
    );
  await assertParity(t, "inline", cloud, runCloud(32), {
    check: (side) => {
      const [[, prompt]] = side.requests[0].fields;
      assert.ok(prompt.length <= 890 && prompt.endsWith("Scout Web"), String(prompt.length));
    },
  });
  await assertParity(t, "chunked", cloud, runCloud(4 * 1024 * 1024 + 16), {
    id: STORED_LARGE,
    check: (side) => assert.equal(side.requests.length, 2, "two chunks, each with the prompt"),
  });
});

test("local Whisper: the initial prompt, and the same echo recovery", async (t) => {
  await liveHarness();
  setDictionary(FIXTURE);
  const local = baseSettings({ useLocalWhisper: true, transcriptionMode: "local" });
  const runLocal = () =>
    liveManager().processWithLocalWhisper(blob(), "base", { durationSeconds: 4 });
  await assertParity(t, "a plain transcript", local, runLocal, {
    check: (side) => assert.ok(side.requests[0].whisper.endsWith("Scout Web")),
  });

  // Whisper continued its prompt: both decode again without it, VAD off, and keep the retry.
  await t.test("a strict echo is decoded again without the prompt", async () => {
    const plain = await liveRequest(local, runLocal);
    const prompt = plain.requests[0].whisper;
    const echoThenSpeech = () => [
      { success: true, text: prompt },
      { success: true, text: TEXT },
    ];
    whisperAnswers = echoThenSpeech();
    const liveSide = await liveRequest(local, runLocal);
    whisperAnswers = echoThenSpeech();
    const retrySide = await retryRequest(local);
    assert.deepEqual(retrySide.requests, liveSide.requests);
    assert.deepEqual(liveSide.requests[1], { whisper: null, vad: false });
    assert.equal(retrySide.result.success, true, "the recovered transcript is kept");
  });

  await t.test("an echo the retry can't recover fails as one, writing nothing", async () => {
    const plain = await liveRequest(local, runLocal);
    const prompt = plain.requests[0].whisper;
    whisperAnswers = [
      { success: true, text: prompt },
      { success: true, text: prompt },
    ];
    const retrySide = await retryRequest(local);
    assert.equal(retrySide.result.success, false);
    assert.equal(retrySide.result.code, "DICTIONARY_ECHO");
  });
});

test("local sherpa: nothing, as live", async () => {
  setDictionary(FIXTURE);
  await retryRequest(
    baseSettings({
      useLocalWhisper: true,
      transcriptionMode: "local",
      localTranscriptionProvider: "nvidia",
      parakeetModel: "parakeet-tdt-0.6b-v3",
    })
  );
  assert.equal(captured.length, 1);
  assert.deepEqual(Object.keys(captured[0].options).sort(), ["language", "model"]);
});

test("an echo of what the retry sent writes nothing, as live discards it", async (t) => {
  await liveHarness();
  setDictionary({ words: ["Alpha Centauri", "Betelgeuse", "Canopus", "Deneb"] });
  const settings = baseSettings();
  const sent = await retryRequest(settings);
  const [[, prompt]] = sent.requests[0].fields;
  responder = () => jsonResponse({ text: prompt });
  t.after(() => {
    responder = respond;
  });
  const writes = [];
  const originalUpdate = databaseManager.updateTranscriptionText;
  databaseManager.updateTranscriptionText = (...args) => writes.push(args);
  t.after(() => {
    databaseManager.updateTranscriptionText = originalUpdate;
  });
  const echoed = await retryRequest(settings);
  assert.deepEqual(echoed.result, {
    success: false,
    error: "No audio detected",
    code: "DICTIONARY_ECHO",
  });
  assert.deepEqual(writes, [], "nothing is written");
  // Live discards the same reply the same way.
  live.setSettings(withDictionary(settings));
  const liveEcho = await liveManager()
    .processWithOpenAIAPI(blob(), { durationSeconds: 4 })
    .then(
      () => null,
      (error) => error
    );
  assert.equal(liveEcho?.code, "DICTIONARY_ECHO");
});

test("pin order and evidence order: live, Re-transcribe and the page agree, head and tail", async (t) => {
  await liveHarness();
  const { useDictionaryUsageStore } = await live.vite.ssrLoadModule(
    "/stores/dictionaryUsageStore.ts"
  );
  // The usage counts live dictation ranks by: the store's (live) and what
  // ControlPanel and the page derive from the same counts (retry, coverage).
  const setUsage = (words) => {
    dictionaryState.usage = words;
    useDictionaryUsageStore.setState(
      words ? { status: "ready", words } : { status: "idle", words: [] }
    );
  };
  t.after(() => {
    setUsage(null);
    dictionaryState.hintOrder = undefined;
  });

  // Stored oldest first; the pins in an order of their own (one of them learned).
  const PINS = ["Zeta Pin", "Alpha Pin", "Mid Pin", "Kilo Pin", "Echo Pin"];
  setDictionary({
    words: [
      "Alpha Pin",
      "Typed Old",
      "learned old",
      "Echo Pin",
      "Typed Missed",
      "Kilo Pin",
      "learned missed",
      "Mid Pin",
      "Typed Used",
      "learned unused",
      "Zeta Pin",
    ],
    learned: ["learned old", "learned missed", "learned unused", "kilo pin"],
    pinned: PINS.map((pin) => pin.toLowerCase()),
    glossary: ["Kusto"],
    snippets: [{ trigger: "cal link", replacement: "https://cal.example" }],
    hintOrder: "evidence",
  });
  setUsage([
    { word: "Typed Missed", heard: 1, written: 9, missedRows: 6 },
    { word: "Typed Used", heard: 20, written: 20, missedRows: 0 },
    { word: "learned missed", heard: 0, written: 4, missedRows: 4 },
    { word: "learned unused", heard: 0, written: 0, missedRows: 0 },
  ]);
  // Priority: the pins in pin order; typed by evidence (Typed Old has none);
  // the glossary; the snippet; learned by evidence.
  const HEAD = [
    ...PINS,
    "Typed Missed",
    "Typed Used",
    "Typed Old",
    "Kusto",
    "cal link",
    "learned missed",
    "learned old",
    "learned unused",
  ];
  // Tail: every tier reversed, and the ranked ones inside too: the top pin last.
  const TAIL = [
    "learned unused",
    "learned old",
    "learned missed",
    "cal link",
    "Kusto",
    "Typed Old",
    "Typed Used",
    "Typed Missed",
    ...[...PINS].reverse(),
  ];
  const fieldsNamed = (side, name) =>
    side.requests[0].fields.filter(([key]) => key === name).map(([, value]) => value);
  const words = (terms) => terms.flatMap((term) => term.split(/\s+/));

  await assertParity(t, "whisper-1 (tail prompt)", baseSettings(), runBatch, {
    check: (side) => assert.equal(fieldsNamed(side, "prompt")[0], TAIL.join(", ")),
  });
  await assertParity(
    t,
    "gpt-4o-mini-transcribe (head prompt)",
    baseSettings({ cloudTranscriptionModel: "gpt-4o-mini-transcribe" }),
    runBatch,
    { check: (side) => assert.equal(fieldsNamed(side, "prompt")[0], HEAD.join(", ")) }
  );
  await assertParity(
    t,
    "gpt-transcribe (keywords[])",
    baseSettings({ cloudTranscriptionModel: "gpt-transcribe" }),
    runBatch,
    { check: (side) => assert.deepEqual(fieldsNamed(side, "keywords[]"), HEAD) }
  );
  await assertParity(
    t,
    "Azure Speech (phrases)",
    baseSettings({
      cloudTranscriptionProvider: "azure-speech",
      cloudTranscriptionModel: "MAI-Transcribe-2",
    }),
    runBatch,
    { check: (side) => assert.deepEqual(side.requests[0].phraseList.phrases, HEAD) }
  );
  await assertParity(
    t,
    "Mistral (context_bias)",
    baseSettings({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionModel: "voxtral-mini-latest",
    }),
    runBatch,
    { check: (side) => assert.deepEqual(fieldsNamed(side, "context_bias"), words(HEAD)) }
  );
  const KEYTERMS = HEAD.filter((term) => term !== "cal link");
  await assertParity(
    t,
    "Gemini (keyterms)",
    baseSettings({
      cloudTranscriptionProvider: "gemini",
      cloudTranscriptionModel: "gemini-2.5-flash",
    }),
    runBatch,
    { check: (side) => assert.deepEqual(side.requests[0].gemini, KEYTERMS) }
  );
  await assertParity(
    t,
    "xAI (keyterm)",
    baseSettings({ cloudTranscriptionProvider: "xai", cloudTranscriptionModel: "grok-stt" }),
    runBatch,
    { check: (side) => assert.deepEqual(fieldsNamed(side, "keyterm"), KEYTERMS) }
  );
  const local = baseSettings({ useLocalWhisper: true, transcriptionMode: "local" });
  await assertParity(
    t,
    "local Whisper (tail initialPrompt)",
    local,
    () => liveManager().processWithLocalWhisper(blob(), "base", { durationSeconds: 4 }),
    { check: (side) => assert.equal(side.requests[0].whisper, TAIL.join(", ")) }
  );

  // "As added": stored order in the typed and learned tiers, emitted as
  // before; the pins keep their own order.
  dictionaryState.hintOrder = "added";
  await assertParity(t, "added: whisper-1", baseSettings(), runBatch, {
    check: (side) =>
      assert.equal(
        fieldsNamed(side, "prompt")[0],
        [
          "learned old",
          "learned missed",
          "learned unused",
          "cal link",
          "Kusto",
          "Typed Old",
          "Typed Missed",
          "Typed Used",
          ...[...PINS].reverse(),
        ].join(", ")
      ),
  });
  await assertParity(
    t,
    "added: Azure Speech",
    baseSettings({
      cloudTranscriptionProvider: "azure-speech",
      cloudTranscriptionModel: "MAI-Transcribe-2",
    }),
    runBatch,
    {
      check: (side) =>
        assert.deepEqual(side.requests[0].phraseList.phrases.slice(0, 8), [
          ...PINS,
          "Typed Old",
          "Typed Missed",
          "Typed Used",
        ]),
    }
  );
  dictionaryState.hintOrder = "evidence";

  // More pins than the decoder reads, under Groq's cap: the budget keeps the
  // top pins, and the tail ends with #1, inside the window.
  const many = Array.from({ length: 50 }, (_, i) => `PinnedProduct${String(i).padStart(2, "0")}Name`);
  setDictionary({
    words: [...many, "Typed Missed"],
    pinned: many.map((pin) => pin.toLowerCase()),
    hintOrder: "evidence",
  });
  const groq = baseSettings({
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "whisper-large-v3",
    cloudTranscriptionBaseUrl: "https://api.groq.com/openai/v1",
  });
  await assertParity(t, "50 pins on Groq: the top pins sent, #1 read last", groq, runBatch, {
    check: async (side) => {
      const prompt = fieldsNamed(side, "prompt")[0];
      assert.ok(prompt.endsWith(many[0]), "the top pin ends the prompt");
      assert.ok(prompt.length <= 890);
      const page = await dictionaryPageHints(groq);
      const coverage = new Map(page.entries.map((entry) => [entry.term, entry.coverage]));
      assert.equal(coverage.get(many[0]), "read");
      assert.equal(coverage.get(many[1]), "read");
      assert.equal(coverage.get(many[49]), "notSent", "the lowest pins don't fit");
      assert.equal(coverage.get("Typed Missed"), "notSent");
      assert.ok(
        page.entries.slice(0, 50).every((entry, i) => entry.term === many[i]),
        "ranks in pin order"
      );
      assert.ok([...coverage.values()].includes("unread"), "some sent pins are past the window");
    },
  });
});

test("privacy: a retry's logs carry counts, never a dictionary word, with dictated text on", async (t) => {
  await liveHarness();
  const debugLogger = require("../../src/helpers/debugLogger");
  const { setLogTextEnabled } = require("../../src/utils/logText.js");
  setLogTextEnabled(true);
  t.after(() => setLogTextEnabled(false));
  const lines = [];
  for (const level of ["debug", "info", "warn", "error", "log"]) {
    t.mock.method(debugLogger, level, (...args) => lines.push(JSON.stringify(args)));
  }
  const MARKER = "Zqxdictmarker";
  setDictionary({
    words: [`${MARKER}One`, `${MARKER} Two`],
    learned: [`${MARKER.toLowerCase()}one`],
    pinned: [`${MARKER.toLowerCase()} two`],
    glossary: [`${MARKER}Glossary`],
    snippets: [{ trigger: `${MARKER} trigger`, replacement: "x" }],
  });
  for (const settings of [
    baseSettings(),
    baseSettings({ cloudTranscriptionModel: "gpt-transcribe" }),
    baseSettings({
      cloudTranscriptionProvider: "mistral",
      cloudTranscriptionModel: "voxtral-mini-latest",
    }),
    baseSettings({
      cloudTranscriptionProvider: "azure-speech",
      cloudTranscriptionModel: "MAI-Transcribe-2",
    }),
    baseSettings({ useLocalWhisper: true, transcriptionMode: "local" }),
  ]) {
    const side = await retryRequest(settings);
    assert.ok(side.requests.length > 0);
  }
  assert.ok(
    lines.some((line) => line.includes("Retry transcription dictionary")),
    "counts logged"
  );
  assert.deepEqual(
    lines.filter((line) => line.toLowerCase().includes(MARKER.toLowerCase())),
    [],
    "no dictionary word in any log line"
  );
});
