// A fake Copilot SDK for copilotRuntime's suites: clients, sessions and the
// catalog, with an ordered call log, a list-call counter and an optional fake
// clock (behavior.clock advanced by behavior.cost[step]). Never a real runtime.
const { createCopilotRuntime } = require("../../../src/helpers/copilot/copilotRuntime");

const MODELS = [
  { id: "auto", name: "Auto", capabilities: { supports: {} } },
  {
    id: "claude-haiku-5.5",
    name: "Claude Haiku 5.5",
    capabilities: { supports: { vision: true } },
    supportedReasoningEfforts: ["low", "medium", "high"],
    policy: { state: "enabled" },
    billing: { tokenPrices: { inputPrice: 10, outputPrice: 50 } },
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    capabilities: { supports: { reasoning_effort: ["none", "low", "high"] } },
    policy: { state: "enabled" },
  },
  { id: "blocked-model", name: "Blocked", capabilities: {}, policy: { state: "disabled" } },
];

function createFakeSdk(behavior = {}) {
  const clients = [];
  // Every SDK call in order, across clients: start, list, createSession, send,
  // disconnect, delete.
  const calls = [];
  let listCalls = 0;
  let sessionCount = 0;
  // A fake clock the runtime reads (`now`): each step costs behavior.cost[step].
  const advance = (step) => {
    if (behavior.clock && behavior.cost?.[step]) behavior.clock.now += behavior.cost[step];
  };

  class FakeSession {
    constructor(client, config) {
      this.client = client;
      this.config = config;
      this.sessionId = `session-${++sessionCount}`;
      this.handlers = new Set();
      this.aborted = false;
      this.disconnected = false;
      // Like the SDK: registered before session.create is sent.
      if (config.onEvent) this.on(config.onEvent);
    }
    on(handler) {
      this.handlers.add(handler);
      return () => this.handlers.delete(handler);
    }
    emit(type, data) {
      for (const handler of [...this.handlers]) handler({ type, data });
    }
    async sendAndWait({ prompt }) {
      calls.push("send");
      this.prompt = prompt;
      advance("send");
      if (behavior.send) return behavior.send(this, prompt);
      this.emit("assistant.usage", { model: this.config.model, finishReason: "stop" });
      return { data: { content: `clean: ${prompt}` } };
    }
    async abort() {
      this.aborted = true;
    }
    async disconnect() {
      calls.push("disconnect");
      advance("disconnect");
      this.disconnected = true;
      if (behavior.disconnectThrows) throw new Error("disconnect failed");
    }
  }

  class CopilotClient {
    constructor(options) {
      this.options = options;
      this.sessions = [];
      this.createConfigs = [];
      this.deleted = [];
      this.stopped = false;
      this.forceStopped = false;
      clients.push(this);
    }
    async start() {
      calls.push("start");
      if (behavior.startGate) await behavior.startGate;
      advance("start");
      if (behavior.startError) throw behavior.startError;
      this.started = true;
    }
    async stop() {
      if (behavior.stopHangs) return new Promise(() => {});
      this.stopped = true;
      return [];
    }
    async forceStop() {
      this.forceStopped = true;
    }
    get rpc() {
      return {
        models: {
          list: async () => {
            listCalls += 1;
            const call = listCalls;
            calls.push("list");
            if (behavior.list) {
              const models = await behavior.list(call, this);
              advance("list");
              return { models };
            }
            advance("list");
            if (behavior.listError) throw behavior.listError;
            return { models: behavior.models ?? MODELS };
          },
        },
      };
    }
    async createSession(config) {
      calls.push("createSession");
      this.createConfigs.push(config);
      const session = new FakeSession(this, config);
      advance("create");
      if (behavior.create) await behavior.create(session, config);
      if (behavior.createError) throw behavior.createError;
      this.sessions.push(session);
      return session;
    }
    async deleteSession(id) {
      calls.push("delete");
      advance("delete");
      this.deleted.push(id);
    }
  }

  return {
    sdk: { CopilotClient, RuntimeConnection: { forStdio: (opts) => ({ kind: "stdio", ...opts }) } },
    clients,
    calls,
    listCalls: () => listCalls,
  };
}

function manualTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    fire(ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms === ms) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: (ms) => [...timers.values()].filter((timer) => timer.ms === ms).length,
  };
}

function runtimeWith(behavior, options = {}) {
  const fake = createFakeSdk(behavior);
  const directories = [];
  const runtime = createCopilotRuntime({
    loadSdk: () => fake.sdk,
    baseDirectory: "C:\\fake\\copilot-runtime",
    ensureDirectory: (dir) => directories.push({ dir, clientsBefore: fake.clients.length }),
    env: { PATH: "C:\\Windows", OPENAI_API_KEY: "sk-secret", GH_TOKEN: "gho_ambient123456" },
    ...options,
  });
  return { runtime, fake, directories };
}

// A promise held open until the test resolves or rejects it.
function gate() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Lets queued promise chains run.
async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function captureLogger() {
  const lines = [];
  const logger = {};
  for (const level of ["debug", "info", "warn", "error"]) {
    logger[level] = (message, meta, scope) => lines.push({ level, message, meta, scope });
  }
  return { logger, lines, named: (message) => lines.filter((line) => line.message === message) };
}

module.exports = {
  MODELS,
  createFakeSdk,
  manualTimers,
  runtimeWith,
  gate,
  flush,
  captureLogger,
};
