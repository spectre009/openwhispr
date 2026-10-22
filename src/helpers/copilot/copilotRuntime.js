// Owns the GitHub Copilot SDK runtime (copilot-runtime.exe) for the language-
// model provider. One CopilotClient per sign-in, started on first use and
// stopped after IDLE_STOP_MS without a request, on sign-out and on quit.
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
const SEND_WAIT_SLACK_MS = 5000;
const PID_FILE_NAME = "copilot";

const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];
const TRUNCATED_FINISH_REASONS = new Set(["length", "max_tokens", "max_output_tokens"]);
// Messages the SDK uses when the runtime process or its pipe has gone away.
const CONNECTION_LOST = /connection|disposed|closed|not connected|EPIPE|ECONNRESET|exited|stopped/i;

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
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  clientInfo = { applicationName: "OpenWhispr" },
} = {}) {
  let token = "";
  let generation = 0;
  let current = null;
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
      models: null,
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

  async function acquire() {
    if (!token) throw codedError("COPILOT_NOT_SIGNED_IN", "Not signed in to GitHub Copilot");
    if (current?.broken) {
      const broken = current;
      current = null;
      retire(broken);
    }
    if (!current) current = newEntry();
    const entry = current;
    entry.active += 1;
    if (entry.idleTimer) clearTimer(entry.idleTimer);
    entry.idleTimer = null;
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

  async function listModels({ refresh = false } = {}) {
    const { entry, client } = await acquire();
    try {
      if (!refresh && entry.models && now() - entry.models.at < modelsTtlMs) {
        return entry.models.list;
      }
      const list = await fetchModels(client);
      entry.models = { at: now(), list };
      return list;
    } catch (error) {
      if (isOwnError(error)) throw error;
      throw markIfLost(entry, copilotSdkError(null, error));
    } finally {
      release(entry);
    }
  }

  function markIfLost(entry, error) {
    if (error?.connectionLost) entry.broken = true;
    return error;
  }

  async function catalogFor(entry, client) {
    try {
      if (!entry.models || now() - entry.models.at >= modelsTtlMs) {
        entry.models = { at: now(), list: await fetchModels(client) };
      }
      return entry.models.list;
    } catch {
      // The catalog only guards the model id and picks an effort; the request
      // itself can still be tried.
      return null;
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
    const deadline = createDeadline(deadlineMs, setTimer, clearTimer);
    const cancelled = abortPromise(signal);
    // The deadline covers a cold runtime start too. A start that finishes
    // after the deadline still hands its slot back.
    const acquiring = acquire();
    let entry;
    let client;
    try {
      ({ entry, client } = await race(acquiring, deadline.promise, cancelled));
    } catch (error) {
      deadline.clear();
      acquiring.then(
        (late) => release(late.entry),
        () => {}
      );
      throw error;
    }
    let session = null;
    try {
      const catalog = await race(catalogFor(entry, client), deadline.promise, cancelled);
      const listed = catalog?.find((candidate) => candidate.id === model);
      if (catalog && !listed) {
        throw codedError("COPILOT_MODEL_UNAVAILABLE", `Copilot model "${model}" isn't available`, {
          model,
        });
      }
      const reasoningEffort = disableThinking ? lowestEffort(listed) : undefined;
      session = await race(
        client.createSession({
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          systemMessage: { mode: "replace", content: system || "" },
          availableTools: [],
          infiniteSessions: { enabled: false },
          ...(maxTokens ? { modelCapabilities: { limits: { max_output_tokens: maxTokens } } } : {}),
          createSessionFsProvider: () => createMemorySessionFs(),
          // The runtime prefixes every prompt with a <current_datetime> tag,
          // which a cleanup model can copy into the text it returns.
          hooks: {
            onUserPromptTransformed: (input) => ({ modifiedTransformedPrompt: input.prompt }),
          },
        }),
        deadline.promise,
        cancelled
      );

      let usage = null;
      let sessionError = null;
      let modelSwitch = null;
      const unsubscribe = session.on((event) => {
        if (event?.agentId) return;
        if (event?.type === "assistant.usage") usage = event.data;
        else if (event?.type === "session.error") sessionError = event.data;
        else if (
          event?.type === "session.model_change" &&
          (event.data?.source === "automatic" || event.data?.cause === "model_unavailable")
        ) {
          // The runtime swaps an unavailable model for another, possibly far
          // pricier, one without failing. Stop instead of paying for it.
          modelSwitch = event.data;
          Promise.resolve()
            .then(() => session.abort())
            .catch(() => {});
        }
      });
      let message;
      try {
        message = await race(
          session.sendAndWait({ prompt: user }, deadlineMs + SEND_WAIT_SLACK_MS),
          deadline.promise,
          cancelled
        );
      } catch (error) {
        if (modelSwitch) {
          throw codedError(
            "COPILOT_MODEL_UNAVAILABLE",
            `Copilot model "${model}" isn't available`,
            {
              model,
            }
          );
        }
        if (error?.code === "COPILOT_TIMEOUT" || error?.code === "COPILOT_CANCELLED") {
          await Promise.resolve()
            .then(() => session.abort())
            .catch(() => {});
          throw error;
        }
        throw markIfLost(entry, copilotSdkError(sessionError, error));
      } finally {
        unsubscribe?.();
      }
      if (modelSwitch) {
        throw codedError("COPILOT_MODEL_UNAVAILABLE", `Copilot model "${model}" isn't available`, {
          model,
        });
      }

      const finishReason = usage?.finishReason || null;
      if (requireCompleteOutput && finishReason && TRUNCATED_FINISH_REASONS.has(finishReason)) {
        throw codedError("COPILOT_TRUNCATED", "Copilot's reply was cut off", { finishReason });
      }
      return {
        text: typeof message?.data?.content === "string" ? message.data.content : "",
        finishReason,
        model: usage?.model || model,
        reasoningEffort: reasoningEffort || null,
      };
    } catch (error) {
      if (isOwnError(error)) throw error;
      throw markIfLost(entry, copilotSdkError(null, error));
    } finally {
      deadline.clear();
      if (session) {
        const sessionId = session.sessionId;
        await Promise.resolve()
          .then(() => session.disconnect())
          .catch(() => {});
        await Promise.resolve()
          .then(() => client.deleteSession(sessionId))
          .catch(() => {});
      }
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

  return { complete, listModels, validateToken, setToken, stop, getStatus };
}

module.exports = {
  createCopilotRuntime,
  buildRuntimeEnv,
  normalizeModels,
  lowestEffort,
  redactTokens,
  IDLE_STOP_MS,
  STOP_GRACE_MS,
  PID_FILE_NAME,
  SESSION_FS_CONFIG,
};
