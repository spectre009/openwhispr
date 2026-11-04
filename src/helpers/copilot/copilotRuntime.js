// Owns the GitHub Copilot SDK runtime (copilot-runtime.exe) for the language-
// model provider. One CopilotClient per sign-in, started on first use (or by a
// prewarm at a recording's start) and stopped after IDLE_STOP_MS without a
// request, on sign-out and on quit. The model catalog is kept per sign-in
// across those idle restarts.
//
// Every request is a one-shot session with Copilot's own prompt replaced, no
// tools and an in-memory session filesystem, so the transcript the runtime
// journals never reaches disk. The runtime gets an allowlisted environment:
// the app keeps every decrypted API key in process.env, and the runtime needs
// none of them.
const { createMemorySessionFs } = require("./memorySessionFs");

const IDLE_STOP_MS = 10 * 60 * 1000;
// Fits inside sidecarRegistry's 8 s quit deadline, leaving room to force-stop.
const STOP_GRACE_MS = 4000;
const MODELS_TTL_MS = 10 * 60 * 1000;
// A catalog fetch is shared by everyone waiting on it and holds the runtime
// up, so it has its own bound: callers' deadlines only stop their waiting.
const CATALOG_TIMEOUT_MS = 15000;
// A prewarm (start plus catalog) stops waiting after this long.
const PREWARM_TIMEOUT_MS = 30000;
const SEND_WAIT_SLACK_MS = 5000;
const PID_FILE_NAME = "copilot";

const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];
const TRUNCATED_FINISH_REASONS = new Set(["length", "max_tokens", "max_output_tokens"]);
// Messages the SDK uses when the runtime process or its pipe has gone away.
const CONNECTION_LOST = /connection|disposed|closed|not connected|EPIPE|ECONNRESET|exited|stopped/i;
// Events that mean the model has started answering.
const OUTPUT_EVENTS = new Set([
  "assistant.message_start",
  "assistant.message",
  "assistant.message_delta",
  "assistant.streaming_delta",
  "assistant.reasoning",
  "assistant.reasoning_delta",
  "assistant.tool_call_delta",
  "assistant.usage",
]);
const JSON_RPC_INVALID_PARAMS = -32602;
// MCP servers the runtime starts in every session on its own. Sessions get no
// tools, so connecting them only costs a network round trip per request
// (0.6–10 s measured with GitHub's).
const BUILTIN_MCP_SERVERS = Object.freeze(["github-mcp-server"]);
// What a request logs of the SDK's assistant.usage event: [field, source, round].
const USAGE_FIELDS = [
  ["modelMs", "duration", false],
  ["ttftMs", "timeToFirstTokenMs", true],
  ["inputTokens", "inputTokens", false],
  ["outputTokens", "outputTokens", false],
  ["cacheReadTokens", "cacheReadTokens", false],
  ["cacheWriteTokens", "cacheWriteTokens", false],
];

const SESSION_FS_CONFIG = Object.freeze({
  initialCwd: "/work",
  sessionStatePath: "/session-state",
  conventions: "posix",
});

const ENV_ALLOWLIST = new Set(
  [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "PUBLIC",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "TZ",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ].map((name) => name.toUpperCase())
);

const TOKEN_PATTERN = /\b(?:gh[oupsr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,})/g;

function redactTokens(value) {
  return String(value ?? "").replace(TOKEN_PATTERN, "[redacted]");
}

function buildRuntimeEnv(source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST.has(name.toUpperCase())) env[name] = value;
  }
  // Documented to stop the native runtime's direct GitHub telemetry uploads.
  env.COPILOT_GITHUB_TELEMETRY_DISABLED = "true";
  return env;
}

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message || code), { code }, extra);
}

// Errors this module raised itself; anything else came from the SDK or its
// JSON-RPC transport (whose ResponseError carries a numeric `code`).
function isOwnError(error) {
  return typeof error?.code === "string" && error.code.startsWith("COPILOT_");
}

// An SDK failure carrying the structured fields of the runtime's session.error
// event, which sendAndWait flattens into a plain Error.
function copilotSdkError(eventData, fallback) {
  const data =
    eventData || (fallback?.data && typeof fallback.data === "object" ? fallback.data : null);
  const message = redactTokens(data?.message || fallback?.message || "Copilot request failed");
  return Object.assign(new Error(message), {
    code: "COPILOT_SDK_ERROR",
    errorType: typeof data?.errorType === "string" ? data.errorType : undefined,
    errorCode: typeof data?.errorCode === "string" ? data.errorCode : undefined,
    statusCode: typeof data?.statusCode === "number" ? data.statusCode : undefined,
    connectionLost: !eventData && CONNECTION_LOST.test(String(fallback?.message || "")),
  });
}

function normalizeModel(model) {
  const supports = model?.capabilities?.supports || {};
  const efforts = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : Array.isArray(supports.reasoning_effort)
      ? supports.reasoning_effort
      : [];
  const prices = model?.billing?.tokenPrices || {};
  return {
    id: String(model.id),
    name: String(model.name || model.id),
    supportsVision: supports.vision === true,
    reasoningEfforts: efforts.filter((effort) => EFFORT_ORDER.includes(effort)),
    defaultReasoningEffort: model?.defaultReasoningEffort || null,
    policyState: model?.policy?.state || null,
    inputPrice: typeof prices.inputPrice === "number" ? prices.inputPrice : null,
    outputPrice: typeof prices.outputPrice === "number" ? prices.outputPrice : null,
  };
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .filter((model) => model && typeof model.id === "string" && model.id !== "auto")
    .filter((model) => model?.policy?.state !== "disabled")
    .map(normalizeModel);
}

// The lowest effort a model accepts, used when the scope turns thinking off.
function lowestEffort(model) {
  for (const effort of EFFORT_ORDER) {
    if (model?.reasoningEfforts?.includes(effort)) return effort;
  }
  return undefined;
}

function createDeadline(ms, setTimer, clearTimer) {
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimer(
      () => reject(codedError("COPILOT_TIMEOUT", `Copilot took longer than ${ms} ms`)),
      ms
    );
  });
  promise.catch(() => {});
  return { promise, clear: () => timer !== null && clearTimer(timer) };
}

function abortPromise(signal) {
  if (!signal) return null;
  const promise = new Promise((_, reject) => {
    const fail = () => reject(codedError("COPILOT_CANCELLED", "Copilot request cancelled"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  promise.catch(() => {});
  return promise;
}

function race(work, ...guards) {
  return Promise.race([work, ...guards.filter(Boolean)]);
}

function abortQuietly(session) {
  return Promise.resolve()
    .then(() => session.abort())
    .catch(() => {});
}

// A failing disconnect never skips the delete.
async function closeSession(client, session) {
  const sessionId = session.sessionId;
  await Promise.resolve()
    .then(() => session.disconnect())
    .catch(() => {});
  await Promise.resolve()
    .then(() => client.deleteSession(sessionId))
    .catch(() => {});
}

function modelUnavailable(model) {
  return codedError("COPILOT_MODEL_UNAVAILABLE", `Copilot model "${model}" isn't available`, {
    model,
  });
}

// The usage numbers a request logs; anything that isn't a finite number is left out.
function usageNumbers(data) {
  const numbers = {};
  for (const [name, field, round] of USAGE_FIELDS) {
    const value = data?.[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      numbers[name] = round ? Math.round(value) : value;
    }
  }
  return numbers;
}

// A failed request's error carries the steps it got through, for the log. A
// start failure is shared by every request waiting on that start, so each
// request throws its own copy.
function withTimings(error, timings) {
  const source = error instanceof Error ? error : new Error(String(error));
  const copy = Object.assign(new Error(source.message), source, {
    copilotTimings: { ...timings },
  });
  copy.stack = source.stack;
  return copy;
}

// Whether a refused session or send could be about its reasoning effort: a
// JSON-RPC invalid-params reply, a 400/422, or a message naming the effort.
function mayBeEffortRefusal(error, eventData) {
  if (error?.code === JSON_RPC_INVALID_PARAMS) return true;
  if (eventData?.statusCode === 400 || eventData?.statusCode === 422) return true;
  const text = [eventData?.providerErrorParam, eventData?.message, error?.message]
    .filter((part) => typeof part === "string")
    .join(" ");
  return /effort/i.test(text);
}

function createCopilotRuntime({
  loadSdk = () => require("@github/copilot-sdk"),
  baseDirectory,
  // The runtime starts with baseDirectory as its working directory. A missing
  // directory makes the spawn fail, which the SDK's stdio transport swallows
  // and reports only as "Cannot call write after a stream was destroyed".
  ensureDirectory = (dir) => require("fs").mkdirSync(dir, { recursive: true }),
  resolveRuntimePath = () => null,
  findRuntimePids = async () => [],
  pidFile = null,
  logger = null,
  env = process.env,
  idleStopMs = IDLE_STOP_MS,
  stopGraceMs = STOP_GRACE_MS,
  modelsTtlMs = MODELS_TTL_MS,
  catalogTimeoutMs = CATALOG_TIMEOUT_MS,
  prewarmTimeoutMs = PREWARM_TIMEOUT_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  clientInfo = { applicationName: "OpenWhispr" },
} = {}) {
  let token = "";
  let generation = 0;
  let current = null;
  // The last catalog of this sign-in ({ generation, at, list }). It outlives
  // the runtime's idle restarts; a token change drops it.
  let lastCatalog = null;
  const retiring = new Set();
  const log = (level, message, meta) => logger?.[level]?.(message, meta, "copilot");

  function newEntry() {
    return {
      generation,
      token,
      client: null,
      starting: null,
      active: 0,
      idleTimer: null,
      // The catalog fetch in flight on this runtime, shared by its callers.
      flight: null,
      pid: null,
      stopping: null,
      broken: false,
    };
  }

  function createClient(clientToken) {
    const sdk = loadSdk();
    const runtimePath = resolveRuntimePath();
    if (baseDirectory) ensureDirectory(baseDirectory);
    return new sdk.CopilotClient({
      mode: "empty",
      connection: sdk.RuntimeConnection.forStdio(runtimePath ? { path: runtimePath } : {}),
      baseDirectory,
      workingDirectory: baseDirectory,
      gitHubToken: clientToken,
      useLoggedInUser: false,
      env: buildRuntimeEnv(env),
      logLevel: "error",
      clientInfo,
      sessionFs: SESSION_FS_CONFIG,
    });
  }

  async function stopClient(client) {
    if (!client) return;
    const timeout = new Promise((resolve) => {
      const timer = setTimer(() => resolve("timeout"), stopGraceMs);
      timer?.unref?.();
    });
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => client.stop())
        .then(
          () => "stopped",
          () => "failed"
        ),
      timeout,
    ]);
    if (outcome !== "stopped") {
      await Promise.resolve()
        .then(() => client.forceStop())
        .catch(() => {});
    }
  }

  async function recordPid(entry) {
    if (!pidFile) return;
    try {
      const pids = await findRuntimePids(process.pid);
      const known = new Set(
        [current, ...retiring].filter((other) => other && other !== entry).map((o) => o.pid)
      );
      const pid = pids.find((candidate) => !known.has(candidate));
      if (!pid || entry.stopping) return;
      entry.pid = pid;
      pidFile.write(PID_FILE_NAME, pid);
    } catch (error) {
      log("debug", "Couldn't record the Copilot runtime pid", { error: error?.message });
    }
  }

  function stopEntry(entry) {
    if (entry.stopping) return entry.stopping;
    if (entry.idleTimer) clearTimer(entry.idleTimer);
    entry.idleTimer = null;
    entry.stopping = (async () => {
      const starting = entry.starting;
      if (starting) await starting.catch(() => {});
      await stopClient(entry.client);
      entry.client = null;
      if (entry.pid && pidFile) pidFile.clear(PID_FILE_NAME);
      retiring.delete(entry);
      log("info", "Copilot runtime stopped", { generation: entry.generation });
    })();
    // Nothing joins or stores a stopping runtime's catalog fetch.
    if (entry.flight) endFlight(entry, entry.flight);
    return entry.stopping;
  }

  function retire(entry) {
    if (!entry) return;
    retiring.add(entry);
    if (entry.active === 0) stopEntry(entry);
  }

  async function ensureStarted(entry) {
    if (entry.client && !entry.broken) return entry.client;
    if (!entry.starting) {
      entry.starting = (async () => {
        const startedAt = now();
        const client = createClient(entry.token);
        try {
          await client.start();
        } catch (error) {
          await Promise.resolve()
            .then(() => client.forceStop())
            .catch(() => {});
          throw codedError("COPILOT_RUNTIME_FAILED", redactTokens(error?.message), {
            cause: error,
          });
        }
        entry.client = client;
        entry.broken = false;
        log("info", "Copilot runtime started", {
          generation: entry.generation,
          startMs: now() - startedAt,
        });
        recordPid(entry);
        return client;
      })().finally(() => {
        entry.starting = null;
      });
    }
    return entry.starting;
  }

  function scheduleIdleStop(entry) {
    if (entry.idleTimer) clearTimer(entry.idleTimer);
    entry.idleTimer = setTimer(() => {
      entry.idleTimer = null;
      if (entry.active === 0 && current === entry) {
        current = null;
        stopEntry(entry);
      }
    }, idleStopMs);
    entry.idleTimer?.unref?.();
  }

  // A lease keeps the runtime up: its idle stop waits until every lease ends.
  function lease(entry) {
    entry.active += 1;
    if (entry.idleTimer) clearTimer(entry.idleTimer);
    entry.idleTimer = null;
  }

  // `stats.coldStart` says whether this call started the runtime.
  async function acquire(stats = null) {
    if (!token) throw codedError("COPILOT_NOT_SIGNED_IN", "Not signed in to GitHub Copilot");
    if (current?.broken) {
      const broken = current;
      current = null;
      retire(broken);
    }
    if (!current) current = newEntry();
    const entry = current;
    lease(entry);
    if (stats) stats.coldStart = !entry.client && !entry.starting;
    try {
      const client = await ensureStarted(entry);
      return { entry, client };
    } catch (error) {
      release(entry);
      if (current === entry) current = null;
      throw error;
    }
  }

  function release(entry) {
    entry.active = Math.max(0, entry.active - 1);
    if (entry.active > 0) return;
    if (retiring.has(entry) || entry.broken) {
      stopEntry(entry);
    } else if (current === entry) {
      scheduleIdleStop(entry);
    }
  }

  async function fetchModels(client) {
    const result = await client.rpc.models.list({});
    return normalizeModels(result?.models);
  }

  function markIfLost(entry, error) {
    if (error?.connectionLost && !entry.broken) {
      entry.broken = true;
      // Nothing joins or stores a lost runtime's catalog fetch.
      if (entry.flight) endFlight(entry, entry.flight);
    }
    return error;
  }

  const catalogOf = (entry) => (lastCatalog?.generation === entry.generation ? lastCatalog : null);
  const isFresh = (catalog) => now() - catalog.at < modelsTtlMs;

  // One catalog fetch at a time per runtime: a prewarm, requests and the model
  // list share the one in flight. It holds its own lease, so the idle stop
  // waits for it, and gives up after catalogTimeoutMs; a caller's deadline or
  // cancel only ends that caller's wait. It stores its list only while it is
  // still its runtime's flight and that runtime serves the current sign-in.
  // `settled` resolves to { list } or { error } and never rejects.
  function catalogFlight(entry, client) {
    if (entry.flight) return { settled: entry.flight.settled, shared: true };
    const flight = { settled: null, leased: true };
    entry.flight = flight;
    lease(entry);
    const bound = createDeadline(catalogTimeoutMs, setTimer, clearTimer);
    flight.settled = race(fetchModels(client), bound.promise)
      .then(
        (list) => {
          if (entry.flight === flight && entry.generation === generation) {
            lastCatalog = { generation: entry.generation, at: now(), list };
          }
          return { list };
        },
        (error) => ({
          error: isOwnError(error) ? error : markIfLost(entry, copilotSdkError(null, error)),
        })
      )
      .finally(() => {
        bound.clear();
        endFlight(entry, flight);
      });
    return { settled: flight.settled, shared: false };
  }

  function endFlight(entry, flight) {
    if (entry.flight === flight) entry.flight = null;
    if (!flight.leased) return;
    flight.leased = false;
    release(entry);
  }

  async function listModels({ refresh = false } = {}) {
    const { entry, client } = await acquire();
    try {
      const catalog = catalogOf(entry);
      if (!refresh && catalog && isFresh(catalog)) return catalog.list;
      const { list, error } = await catalogFlight(entry, client).settled;
      if (error) throw error;
      return list;
    } finally {
      release(entry);
    }
  }

  async function timed(timings, step, work) {
    const startedAt = now();
    try {
      return await work();
    } finally {
      timings[step] = (timings[step] || 0) + (now() - startedAt);
    }
  }

  // The catalog a request checks its model against and picks its effort from
  // (`list`, or null to go ahead unchecked), and how it got it:
  // - fresh: the sign-in's catalog, younger than modelsTtlMs;
  // - stale: older, but it lists the model, so the request goes ahead at once
  //   and the catalog is refreshed after it;
  // - fetched / shared (none known) or refreshed (stale, without the model):
  //   waited for a fetch, its own or one in flight, raced with the request's
  //   deadline and cancel;
  // - failed: that fetch failed, so the request goes ahead unchecked, as it
  //   always has. A stale list is never evidence against a model.
  async function catalogForRequest(entry, client, model, timings, guards) {
    const startedAt = now();
    try {
      const catalog = catalogOf(entry);
      if (catalog && isFresh(catalog)) {
        timings.catalog = "fresh";
        return { how: "fresh", list: catalog.list };
      }
      if (catalog?.list.some((candidate) => candidate.id === model)) {
        timings.catalog = "stale";
        return { how: "stale", list: catalog.list };
      }
      const flight = catalogFlight(entry, client);
      const { list, error } = await race(flight.settled, ...guards);
      const how = error ? "failed" : catalog ? "refreshed" : flight.shared ? "shared" : "fetched";
      timings.catalog = how;
      return { how, list: error ? null : list };
    } finally {
      timings.catalogMs = now() - startedAt;
    }
  }

  // One session: created with the guard already listening, sent the prompt,
  // then closed. With `mayRetryEffort`, a refusal before any output that may
  // be about the effort comes back as { effortRefused } instead of a throw.
  async function openAndSend({
    entry,
    client,
    model,
    reasoningEffort,
    system,
    user,
    maxTokens,
    deadlineMs,
    guards,
    timings,
    mayRetryEffort = false,
  }) {
    let session = null;
    let listening = true;
    let usage = null;
    let sessionError = null;
    let modelSwitch = null;
    let answered = false;
    // Registered before session.create, so a model swap while the session is
    // created is caught as well as one during the send.
    const onEvent = (event) => {
      if (!listening || event?.agentId) return;
      if (OUTPUT_EVENTS.has(event?.type)) answered = true;
      if (
        event?.type === "session.mcp_server_status_changed" &&
        event.data?.status === "connected"
      ) {
        // Shows in the log if the runtime starts a server we don't disable.
        timings.mcpConnected = (timings.mcpConnected || 0) + 1;
      }
      if (event?.type === "assistant.usage") usage = event.data;
      else if (event?.type === "session.error") sessionError = event.data;
      else if (
        event?.type === "session.model_change" &&
        (event.data?.source === "automatic" || event.data?.cause === "model_unavailable")
      ) {
        // The runtime swaps an unavailable model for another, possibly far
        // pricier, one without failing. Stop instead of paying for it.
        modelSwitch = event.data;
        if (session) abortQuietly(session);
      }
    };
    try {
      try {
        session = await timed(timings, "sessionMs", () =>
          race(
            client.createSession({
              model,
              // The runtime may not move this session to any other model.
              allowedModels: [model],
              disabledMcpServers: [...BUILTIN_MCP_SERVERS],
              ...(reasoningEffort ? { reasoningEffort } : {}),
              systemMessage: { mode: "replace", content: system || "" },
              availableTools: [],
              infiniteSessions: { enabled: false },
              ...(maxTokens
                ? { modelCapabilities: { limits: { max_output_tokens: maxTokens } } }
                : {}),
              createSessionFsProvider: () => createMemorySessionFs(),
              onEvent,
              // The runtime prefixes every prompt with a <current_datetime> tag,
              // which a cleanup model can copy into the text it returns.
              hooks: {
                onUserPromptTransformed: (input) => ({ modifiedTransformedPrompt: input.prompt }),
              },
            }),
            ...guards
          )
        );
      } catch (error) {
        if (isOwnError(error)) throw error;
        if (modelSwitch) throw modelUnavailable(model);
        const failure = copilotSdkError(sessionError, error);
        if (mayRetryEffort && !failure.connectionLost && mayBeEffortRefusal(error, sessionError)) {
          return { effortRefused: failure };
        }
        throw markIfLost(entry, failure);
      }
      // Swapped while the session was created: nothing has been sent yet.
      if (modelSwitch) throw modelUnavailable(model);

      let message;
      try {
        message = await timed(timings, "sendMs", () =>
          race(session.sendAndWait({ prompt: user }, deadlineMs + SEND_WAIT_SLACK_MS), ...guards)
        );
      } catch (error) {
        if (modelSwitch) throw modelUnavailable(model);
        if (error?.code === "COPILOT_TIMEOUT" || error?.code === "COPILOT_CANCELLED") {
          await abortQuietly(session);
          throw error;
        }
        const failure = copilotSdkError(sessionError, error);
        if (
          mayRetryEffort &&
          !answered &&
          !failure.connectionLost &&
          mayBeEffortRefusal(error, sessionError)
        ) {
          return { effortRefused: failure };
        }
        throw markIfLost(entry, failure);
      }
      if (modelSwitch) throw modelUnavailable(model);
      return { message, usage };
    } finally {
      listening = false;
      if (session) {
        const opened = session;
        await timed(timings, "closeMs", () => closeSession(client, opened));
      }
    }
  }

  async function complete({
    model,
    system,
    user,
    disableThinking = false,
    maxTokens,
    requireCompleteOutput = false,
    deadlineMs = 60000,
    signal,
  }) {
    if (!model) throw codedError("COPILOT_NO_MODEL", "No Copilot model selected");
    const startedAt = now();
    const deadline = createDeadline(deadlineMs, setTimer, clearTimer);
    const guards = [deadline.promise, abortPromise(signal)];
    // Step timings: numbers and step names only. A failure carries what it
    // gathered as error.copilotTimings.
    const timings = { coldStart: false, acquireMs: 0 };
    const stats = {};
    // The deadline covers a cold runtime start too. A start that finishes
    // after the deadline still hands its slot back.
    const acquiring = acquire(stats);
    let entry;
    let client;
    try {
      ({ entry, client } = await race(acquiring, ...guards));
    } catch (error) {
      deadline.clear();
      acquiring.then(
        (late) => release(late.entry),
        () => {}
      );
      timings.coldStart = stats.coldStart === true;
      timings.acquireMs = now() - startedAt;
      throw withTimings(error, timings);
    }
    timings.coldStart = stats.coldStart === true;
    timings.acquireMs = now() - startedAt;
    let refreshAfter = false;
    try {
      const catalog = await catalogForRequest(entry, client, model, timings, guards);
      refreshAfter = catalog.how === "stale";
      let listed = catalog.list?.find((candidate) => candidate.id === model);
      if (catalog.list && !listed) throw modelUnavailable(model);
      // The lowest effort from a stale catalog is best-effort: a refusal is
      // checked against a fresh catalog below.
      let reasoningEffort = disableThinking ? lowestEffort(listed) : undefined;
      const request = {
        entry,
        client,
        model,
        system,
        user,
        maxTokens,
        deadlineMs,
        guards,
        timings,
      };
      let outcome = await openAndSend({
        ...request,
        reasoningEffort,
        mayRetryEffort: refreshAfter && !!reasoningEffort,
      });
      if (outcome.effortRefused) {
        // Refused before any output with an effort from the stale catalog:
        // read a fresh one and try once more with its effort, within the same
        // deadline. The effort is never dropped, which could let a higher
        // default apply.
        refreshAfter = false;
        const refreshStartedAt = now();
        let fresh = null;
        try {
          ({ list: fresh = null } = await race(catalogFlight(entry, client).settled, ...guards));
        } finally {
          timings.catalogMs += now() - refreshStartedAt;
        }
        if (fresh) timings.catalog = "refreshed";
        listed = fresh?.find((candidate) => candidate.id === model);
        if (fresh && !listed) throw modelUnavailable(model);
        const freshEffort = lowestEffort(listed);
        if (!freshEffort || freshEffort === reasoningEffort) throw outcome.effortRefused;
        reasoningEffort = freshEffort;
        timings.effortRetried = true;
        outcome = await openAndSend({ ...request, reasoningEffort });
      }
      const { message, usage } = outcome;

      const finishReason = usage?.finishReason || null;
      if (requireCompleteOutput && finishReason && TRUNCATED_FINISH_REASONS.has(finishReason)) {
        throw codedError("COPILOT_TRUNCATED", "Copilot's reply was cut off", { finishReason });
      }
      return {
        text: typeof message?.data?.content === "string" ? message.data.content : "",
        finishReason,
        model: usage?.model || model,
        reasoningEffort: reasoningEffort || null,
        timings: { ...timings },
        usage: usageNumbers(usage),
      };
    } catch (error) {
      const failure = isOwnError(error) ? error : markIfLost(entry, copilotSdkError(null, error));
      throw withTimings(failure, timings);
    } finally {
      deadline.clear();
      // A stale catalog served this request; refresh it for the next one.
      if (refreshAfter && !entry.broken && !entry.stopping && entry.generation === generation) {
        catalogFlight(entry, client);
      }
      release(entry);
    }
  }

  // Starts the runtime and fetches the catalog ahead of a dictation that will
  // need them, then lets the idle timer run as after a request. Bounded by
  // prewarmTimeoutMs, logs one line, never throws; signed out it does nothing.
  async function prewarm() {
    if (!token) return;
    const startedAt = now();
    const bound = createDeadline(prewarmTimeoutMs, setTimer, clearTimer);
    const stats = {};
    const acquiring = acquire(stats);
    let entry;
    let client;
    try {
      ({ entry, client } = await race(acquiring, bound.promise));
    } catch (error) {
      bound.clear();
      acquiring.then(
        (late) => release(late.entry),
        () => {}
      );
      log("debug", "Copilot runtime prewarm failed", {
        code: error?.code,
        coldStart: stats.coldStart === true,
        startMs: now() - startedAt,
      });
      return;
    }
    const startMs = now() - startedAt;
    try {
      // Signed out or signed in again while it started: nothing to warm.
      if (entry.generation !== generation) return;
      let catalog = "fresh";
      let catalogMs = 0;
      const known = catalogOf(entry);
      if (!known || !isFresh(known)) {
        const catalogStartedAt = now();
        const flight = catalogFlight(entry, client);
        const { error } = await race(flight.settled, bound.promise).catch((timeout) => ({
          error: timeout,
        }));
        catalog = error ? "failed" : flight.shared ? "shared" : "fetched";
        catalogMs = now() - catalogStartedAt;
      }
      log("debug", "Copilot runtime prewarmed", {
        coldStart: stats.coldStart === true,
        startMs,
        catalog,
        catalogMs,
      });
    } finally {
      bound.clear();
      release(entry);
    }
  }

  // Checks a token from a new sign-in on its own runtime, before it replaces
  // the saved one: it proves the account can use Copilot and lists its models.
  async function validateToken(candidate, { signal, deadlineMs = 30000 } = {}) {
    const client = createClient(candidate);
    const deadline = createDeadline(deadlineMs, setTimer, clearTimer);
    const cancelled = abortPromise(signal);
    try {
      await race(client.start(), deadline.promise, cancelled);
      const models = await race(fetchModels(client), deadline.promise, cancelled);
      return { models };
    } catch (error) {
      if (isOwnError(error)) throw error;
      throw copilotSdkError(null, error);
    } finally {
      deadline.clear();
      await stopClient(client);
    }
  }

  // Sign-in, sign-out and startup report the saved token. A changed token gets
  // a new client; the old one finishes its requests and stops. Signing out
  // stops it at once.
  function setToken(nextToken) {
    const value = typeof nextToken === "string" ? nextToken : "";
    if (value === token) return;
    token = value;
    generation += 1;
    // A catalog belongs to the sign-in it was fetched with.
    lastCatalog = null;
    const previous = current;
    current = null;
    if (!previous) return;
    if (!value) {
      retiring.add(previous);
      stopEntry(previous);
    } else {
      retire(previous);
    }
  }

  async function stop() {
    const entries = [current, ...retiring].filter(Boolean);
    current = null;
    await Promise.all(entries.map((entry) => stopEntry(entry)));
  }

  function getStatus() {
    return {
      signedIn: !!token,
      running: !!current?.client,
      activeRequests: current?.active || 0,
      generation,
    };
  }

  return { complete, prewarm, listModels, validateToken, setToken, stop, getStatus };
}

module.exports = {
  createCopilotRuntime,
  buildRuntimeEnv,
  normalizeModels,
  lowestEffort,
  redactTokens,
  IDLE_STOP_MS,
  STOP_GRACE_MS,
  CATALOG_TIMEOUT_MS,
  PREWARM_TIMEOUT_MS,
  PID_FILE_NAME,
  SESSION_FS_CONFIG,
  BUILTIN_MCP_SERVERS,
};
