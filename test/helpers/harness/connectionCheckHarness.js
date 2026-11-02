// A harness for main's connection checks (src/helpers/connectionChecks.js):
// a scripted fetch that records every request, fake keys by slot, captured
// logs and streamed events. Nothing here reaches the network.
const { createConnectionChecks } = require("../../../src/helpers/connectionChecks");

/** Keys a check may read; none may show up in a log, an event or a result. */
const KEYS = Object.freeze({
  OPENAI_API_KEY: "sk-CANARY-openai-0001",
  ANTHROPIC_API_KEY: "sk-ant-CANARY-0002",
  GEMINI_API_KEY: "AIzaCANARY-gemini-0003",
  GROQ_API_KEY: "gsk_CANARY-groq-0004",
  OPENROUTER_API_KEY: "sk-or-CANARY-0005",
  MISTRAL_API_KEY: "mistral-CANARY-0006",
  XAI_API_KEY: "xai-CANARY-0007",
  DEEPGRAM_API_KEY: "deepgram-CANARY-0008",
  ASSEMBLYAI_API_KEY: "assembly-CANARY-0009",
  AZURE_SPEECH_API_KEY: "azspeech-CANARY-0010",
  TINFOIL_API_KEY: "tinfoil-CANARY-0011",
  CORTI_API_KEY: "corti-CANARY-0012",
  CUSTOM_CONNECTION_API_KEY: "conn-CANARY-0013",
  CUSTOM_CLEANUP_API_KEY: "cleanup-CANARY-0014",
  GITHUB_COPILOT_TOKEN: "gho_CANARYcopilot0015",
});
const CORTI = Object.freeze({
  clientId: "corti-client-CANARY",
  clientSecret: "corti-secret-CANARY",
});

const AZURE = "https://littlebuddy-foundry-eus2.openai.azure.com";
const SPEECH = "https://littlebuddy-speech.cognitiveservices.azure.com";

/** One descriptor per kind, as the renderer builds them (connectionHealth.ts). */
const DESCRIPTORS = {
  openai: (models = [], generation = "g1") => ({
    id: "provider:openai",
    kind: "openai",
    capability: "llm",
    route: "https://api.openai.com/v1",
    slot: "OPENAI_API_KEY",
    models,
    generation,
  }),
  anthropic: (models = []) => ({
    id: "provider:anthropic",
    kind: "anthropic",
    capability: "llm",
    route: "https://api.anthropic.com/v1",
    slot: "ANTHROPIC_API_KEY",
    models,
    generation: "g1",
  }),
  gemini: (models = []) => ({
    id: "provider:gemini",
    kind: "gemini",
    capability: "llm",
    route: "https://generativelanguage.googleapis.com/v1beta",
    slot: "GEMINI_API_KEY",
    models,
    generation: "g1",
  }),
  groq: (models = []) => ({
    id: "provider:groq",
    kind: "groq",
    capability: "llm",
    route: "https://api.groq.com/openai/v1",
    slot: "GROQ_API_KEY",
    models,
    generation: "g1",
  }),
  openrouter: (models = []) => ({
    id: "provider:openrouter",
    kind: "openrouter",
    capability: "llm",
    route: "https://openrouter.ai/api/v1",
    slot: "OPENROUTER_API_KEY",
    models,
    generation: "g1",
  }),
  mistral: (models = []) => ({
    id: "provider:mistral",
    kind: "mistral",
    capability: "stt",
    route: "https://api.mistral.ai/v1",
    slot: "MISTRAL_API_KEY",
    models,
    generation: "g1",
  }),
  xai: () => ({
    id: "provider:xai",
    kind: "xai",
    capability: "stt",
    route: "https://api.x.ai/v1",
    slot: "XAI_API_KEY",
    models: [],
    generation: "g1",
  }),
  deepgram: () => ({
    id: "provider:deepgram",
    kind: "deepgram",
    capability: "stt",
    route: "https://api.deepgram.com/v1",
    slot: "DEEPGRAM_API_KEY",
    models: [],
    generation: "g1",
  }),
  assemblyai: () => ({
    id: "provider:assemblyai",
    kind: "assemblyai",
    capability: "stt",
    route: "https://api.assemblyai.com/v2",
    slot: "ASSEMBLYAI_API_KEY",
    models: [],
    generation: "g1",
  }),
  azureSpeech: (models = ["MAI-Transcribe-2"]) => ({
    id: "provider:azure-speech",
    kind: "azure-speech",
    capability: "stt",
    route: SPEECH,
    slot: "AZURE_SPEECH_API_KEY",
    models,
    generation: "g1",
  }),
  tinfoil: (models = []) => ({
    id: "provider:tinfoil",
    kind: "tinfoil",
    capability: "llm",
    route: "https://inference.tinfoil.sh/v1",
    slot: "TINFOIL_API_KEY",
    models,
    generation: "g1",
  }),
  cortiLlm: () => ({
    id: "corti:llm",
    kind: "corti-llm",
    capability: "llm",
    route: "https://ai.eu.corti.app/v1",
    slot: "CORTI_API_KEY",
    models: [],
    generation: "g1",
  }),
  cortiStt: (tenant = "base", environment = "eu") => ({
    id: "corti:stt",
    kind: "corti-stt",
    capability: "stt",
    route: `https://auth.${environment}.corti.app/realms/${tenant}`,
    slot: "CORTI_CLIENT_CREDENTIALS",
    models: [],
    generation: `g-${environment}-${tenant}`,
  }),
  custom: (models = []) => ({
    id: "custom",
    kind: "custom",
    capability: "llm",
    route: AZURE,
    slot: "CUSTOM_CONNECTION_API_KEY",
    models,
    generation: "g1",
  }),
  endpoint: (route = "https://gateway.example.test/v1") => ({
    id: "endpoint:abc",
    kind: "endpoint",
    capability: "llm",
    route,
    slot: "CUSTOM_CLEANUP_API_KEY",
    models: [],
    generation: "g1",
  }),
  selfHosted: (route = "http://192.168.1.20:8178") => ({
    id: "selfHosted:abc",
    kind: "selfHosted",
    capability: "stt",
    route,
    slot: null,
    models: [],
    generation: "g1",
  }),
  copilot: (models = []) => ({
    id: "copilot",
    kind: "copilot",
    capability: "identity",
    route: "https://api.github.com",
    slot: "GITHUB_COPILOT_TOKEN",
    models,
    generation: "g1",
  }),
};

/** A fetch Response stand-in: records whether its body was read or cancelled. */
function reply(status, body = {}, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const state = { read: false, cancelled: false };
  return {
    state,
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: {
      cancel: () => {
        state.cancelled = true;
        return Promise.resolve();
      },
    },
    text: async () => {
      state.read = true;
      return text;
    },
    json: async () => {
      state.read = true;
      return JSON.parse(text);
    },
  };
}

/** A request that only ends when it's aborted (the check's timeout). */
function hang(init) {
  return new Promise((_, reject) => {
    init.signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
    );
  });
}

/**
 * @param {object} options
 * @param {(url: string, init: object) => any} options.route  a reply, an Error to throw, or a function of init
 */
function createHarness({
  route = () => reply(200, { data: [] }),
  keys = KEYS,
  corti = CORTI,
  tinfoil = null,
  copilot = null,
  cortiToken,
  cloudGate,
  now,
  timeoutMs = 40,
  maxConcurrent,
} = {}) {
  const requests = [];
  const events = [];
  const logs = [];
  const reads = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const answer = route(url, init);
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(init) : answer;
  };
  const logger = {};
  for (const level of ["debug", "info", "warn", "error"]) {
    logger[level] = (...args) => logs.push([level, ...args]);
  }
  const checks = createConnectionChecks({
    readSecret: (slot) => {
      reads.push(slot);
      return slot === "CORTI_CLIENT_CREDENTIALS" ? corti : (keys[slot] ?? "");
    },
    fetchImpl,
    tinfoilFetch: tinfoil,
    copilot,
    cortiToken,
    logger,
    emit: (event) => events.push(event),
    timeoutMs,
    ...(maxConcurrent ? { maxConcurrent } : {}),
    ...(cloudGate ? { cloudGate } : {}),
    ...(now ? { now } : {}),
    env: {},
  });

  /** Runs one descriptor and waits for its answer (cached, refused or streamed). */
  async function check(descriptor, { fresh = false, maxAgeMs = 0 } = {}) {
    const answer = checks.run({ descriptors: [descriptor], maxAgeMs, fresh });
    await checks.idle();
    if (answer.results[descriptor.id]) return answer.results[descriptor.id];
    const event = [...events].reverse().find((entry) => entry.id === descriptor.id && entry.result);
    return event?.result;
  }

  return { checks, check, requests, events, logs, reads };
}

const headerOf = (request, name) => new Headers(request.init.headers).get(name);

module.exports = {
  AZURE,
  CORTI,
  DESCRIPTORS,
  KEYS,
  SPEECH,
  createHarness,
  hang,
  headerOf,
  reply,
};
