const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRuntimeEnv,
  normalizeModels,
  lowestEffort,
  redactTokens,
} = require("../../src/helpers/copilot/copilotRuntime");
const { createMemorySessionFs } = require("../../src/helpers/copilot/memorySessionFs");
const { MODELS, manualTimers, runtimeWith } = require("./harness/copilotSdk");

test("the runtime's working directory is created before each client starts", async () => {
  const { runtime, fake, directories } = runtimeWith();
  runtime.setToken("gho_token123456");
  await runtime.listModels();
  await runtime.validateToken("gho_candidate123");
  assert.deepEqual(directories, [
    { dir: "C:\\fake\\copilot-runtime", clientsBefore: 0 },
    { dir: "C:\\fake\\copilot-runtime", clientsBefore: 1 },
  ]);
  assert.equal(fake.clients[0].options.workingDirectory, "C:\\fake\\copilot-runtime");
});

test("a request runs as a one-shot session: Copilot's prompt replaced, no tools, nothing on disk", async () => {
  const { runtime, fake } = runtimeWith();
  runtime.setToken("gho_token123456");
  const result = await runtime.complete({
    model: "claude-haiku-5.5",
    system: "Clean up the transcript.",
    user: "um hello",
    disableThinking: true,
  });
  assert.equal(result.text, "clean: um hello");
  assert.equal(result.reasoningEffort, "low");

  const [client] = fake.clients;
  assert.equal(client.options.mode, "empty");
  assert.equal(client.options.gitHubToken, "gho_token123456");
  assert.equal(client.options.useLoggedInUser, false);
  assert.deepEqual(client.options.connection, { kind: "stdio" });
  assert.equal(client.options.sessionFs.sessionStatePath, "/session-state");

  const [session] = client.sessions;
  assert.deepEqual(session.config.systemMessage, {
    mode: "replace",
    content: "Clean up the transcript.",
  });
  assert.deepEqual(session.config.availableTools, []);
  assert.deepEqual(session.config.infiniteSessions, { enabled: false });
  assert.deepEqual(session.config.allowedModels, ["claude-haiku-5.5"]);
  assert.equal(typeof session.config.onEvent, "function");
  assert.equal(session.config.reasoningEffort, "low");
  assert.equal(typeof session.config.createSessionFsProvider, "function");
  const transformed = session.config.hooks.onUserPromptTransformed({
    prompt: "um hello",
    transformedPrompt: "<current_datetime>x</current_datetime>\n\num hello",
  });
  assert.deepEqual(transformed, { modifiedTransformedPrompt: "um hello" });
  assert.equal(session.disconnected, true);
  assert.deepEqual(client.deleted, [session.sessionId]);
});

test("the runtime gets an allowlisted environment, never the app's keys or ambient GitHub tokens", () => {
  const env = buildRuntimeEnv({
    PATH: "C:\\Windows",
    Path: "C:\\Windows\\System32",
    HTTPS_PROXY: "http://proxy:8080",
    OPENAI_API_KEY: "sk-secret",
    GITHUB_COPILOT_TOKEN: "gho_saved",
    GH_TOKEN: "gho_ambient",
    COPILOT_GITHUB_TOKEN: "gho_ambient2",
    GIT_CONFIG_PARAMETERS: "x",
    ELECTRON_RUN_AS_NODE: "1",
  });
  assert.deepEqual(env, {
    PATH: "C:\\Windows",
    Path: "C:\\Windows\\System32",
    HTTPS_PROXY: "http://proxy:8080",
    COPILOT_GITHUB_TELEMETRY_DISABLED: "true",
  });
});

test("thinking left on keeps the model's own effort", async () => {
  const { runtime, fake } = runtimeWith();
  runtime.setToken("gho_token123456");
  await runtime.complete({ model: "gpt-6-luna", system: "s", user: "u" });
  assert.equal(fake.clients[0].sessions[0].config.reasoningEffort, undefined);
  assert.equal(lowestEffort(normalizeModels(MODELS).find((m) => m.id === "gpt-6-luna")), "none");
});

test("a truncated reply is refused when the caller needs the whole of it", async () => {
  const truncate = (session) => {
    session.emit("assistant.usage", { finishReason: "length" });
    return { data: { content: "partial" } };
  };
  const { runtime } = runtimeWith({ send: truncate });
  runtime.setToken("gho_token123456");
  await assert.rejects(
    runtime.complete({
      model: "claude-haiku-5.5",
      system: "s",
      user: "u",
      maxTokens: 20,
      requireCompleteOutput: true,
    }),
    { code: "COPILOT_TRUNCATED", finishReason: "length" }
  );
  const relaxed = await runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "u" });
  assert.equal(relaxed.text, "partial");
});

test("an output budget is passed as a capability override", async () => {
  const { runtime, fake } = runtimeWith();
  runtime.setToken("gho_token123456");
  await runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "u", maxTokens: 4096 });
  assert.deepEqual(fake.clients[0].sessions[0].config.modelCapabilities, {
    limits: { max_output_tokens: 4096 },
  });
});

test("a model missing from the catalog is refused before any request is sent", async () => {
  const { runtime, fake } = runtimeWith();
  runtime.setToken("gho_token123456");
  await assert.rejects(runtime.complete({ model: "blocked-model", system: "s", user: "u" }), {
    code: "COPILOT_MODEL_UNAVAILABLE",
  });
  assert.equal(fake.clients[0].sessions.length, 0);
});

test("a model the runtime swaps for another is stopped and reported as unavailable", async () => {
  const swap = (session) => {
    session.emit("session.model_change", {
      newModel: "claude-sonnet-5.5",
      cause: "model_unavailable",
      source: "automatic",
    });
    session.emit("assistant.usage", { model: "claude-sonnet-5.5", finishReason: "stop" });
    return { data: { content: "answered by another model" } };
  };
  const { runtime, fake } = runtimeWith({ send: swap, listError: new Error("offline") });
  runtime.setToken("gho_token123456");
  await assert.rejects(runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "u" }), {
    code: "COPILOT_MODEL_UNAVAILABLE",
  });
  assert.equal(fake.clients[0].sessions[0].aborted, true);
});

test("the deadline aborts a request and still cleans the session up", async () => {
  const { runtime, fake } = runtimeWith({ send: () => new Promise(() => {}) });
  runtime.setToken("gho_token123456");
  await assert.rejects(
    runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "u", deadlineMs: 20 }),
    { code: "COPILOT_TIMEOUT" }
  );
  const [session] = fake.clients[0].sessions;
  assert.equal(session.aborted, true);
  assert.equal(session.disconnected, true);
  assert.deepEqual(fake.clients[0].deleted, [session.sessionId]);
});

test("a failing disconnect doesn't skip the session delete", async () => {
  const { runtime, fake } = runtimeWith({ disconnectThrows: true });
  runtime.setToken("gho_token123456");
  await runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "u" });
  assert.equal(fake.clients[0].deleted.length, 1);
});

test("a structured runtime error keeps its fields and loses any token", async () => {
  const fail = (session) => {
    session.emit("session.error", {
      errorType: "authentication",
      statusCode: 401,
      message: "Bad credentials for gho_abcdefghijklmnop",
    });
    throw new Error("Bad credentials for gho_abcdefghijklmnop");
  };
  const { runtime } = runtimeWith({ send: fail });
  runtime.setToken("gho_token123456");
  await assert.rejects(
    runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "u" }),
    (error) => {
      assert.equal(error.code, "COPILOT_SDK_ERROR");
      assert.equal(error.errorType, "authentication");
      assert.equal(error.statusCode, 401);
      assert.doesNotMatch(error.message, /gho_/);
      return true;
    }
  );
  assert.equal(
    redactTokens("x github_pat_11ABCDEFGH y ghu_abcdef1234"),
    "x [redacted] y [redacted]"
  );
});

test("a lost runtime is replaced on the next request", async () => {
  let calls = 0;
  const send = (session) => {
    calls += 1;
    if (calls === 1) throw new Error("Connection is closed.");
    session.emit("assistant.usage", { finishReason: "stop" });
    return { data: { content: "ok" } };
  };
  const { runtime, fake } = runtimeWith({ send });
  runtime.setToken("gho_token123456");
  await assert.rejects(runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "u" }), {
    code: "COPILOT_SDK_ERROR",
    connectionLost: true,
  });
  const second = await runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "u" });
  assert.equal(second.text, "ok");
  assert.equal(fake.clients.length, 2);
});

test("the runtime stops only after every request ends and the idle time passes", async () => {
  const timers = manualTimers();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const send = async (session) => {
    await gate;
    session.emit("assistant.usage", { finishReason: "stop" });
    return { data: { content: "done" } };
  };
  const { runtime, fake } = runtimeWith(
    { send },
    { setTimer: timers.setTimer, clearTimer: timers.clearTimer, idleStopMs: 1000 }
  );
  runtime.setToken("gho_token123456");
  const first = runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "a" });
  const second = runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "b" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.getStatus().activeRequests, 2);
  assert.equal(timers.pending(1000), 0);
  release();
  await Promise.all([first, second]);
  assert.equal(timers.pending(1000), 1);
  timers.fire(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.clients[0].stopped, true);
  assert.equal(fake.clients.length, 1);
});

test("a new sign-in gets its own client; the old one finishes its request first", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const send = async (session, prompt) => {
    if (prompt === "slow") await gate;
    session.emit("assistant.usage", { finishReason: "stop" });
    return { data: { content: prompt } };
  };
  const { runtime, fake } = runtimeWith({ send });
  runtime.setToken("gho_first1234567");
  const slow = runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "slow" });
  await new Promise((resolve) => setImmediate(resolve));
  runtime.setToken("gho_second123456");
  const fast = await runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "fast" });
  assert.equal(fast.text, "fast");
  assert.equal(fake.clients[1].options.gitHubToken, "gho_second123456");
  assert.equal(fake.clients[0].stopped, false);
  release();
  assert.equal((await slow).text, "slow");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.clients[0].stopped, true);
});

test("signing out stops the runtime at once and refuses new requests", async () => {
  const { runtime, fake } = runtimeWith();
  runtime.setToken("gho_token123456");
  await runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "u" });
  runtime.setToken("");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.clients[0].stopped, true);
  await assert.rejects(runtime.complete({ model: "claude-haiku-5.5", system: "s", user: "u" }), {
    code: "COPILOT_NOT_SIGNED_IN",
  });
});

test("a stop that hangs is forced within the grace period", async () => {
  const { runtime, fake } = runtimeWith({ stopHangs: true }, { stopGraceMs: 20 });
  runtime.setToken("gho_token123456");
  await runtime.listModels();
  await runtime.stop();
  assert.equal(fake.clients[0].forceStopped, true);
});

test("a runtime that won't start is reported, and the next request tries again", async () => {
  const behavior = { startError: new Error("spawn ENOENT") };
  const { runtime, fake } = runtimeWith(behavior);
  runtime.setToken("gho_token123456");
  await assert.rejects(runtime.listModels(), { code: "COPILOT_RUNTIME_FAILED" });
  assert.equal(fake.clients[0].forceStopped, true);
  delete behavior.startError;
  assert.equal((await runtime.listModels()).length, 2);
});

test("the model list leaves out Auto and models the organization disabled", async () => {
  const { runtime } = runtimeWith();
  runtime.setToken("gho_token123456");
  const models = await runtime.listModels();
  assert.deepEqual(
    models.map((model) => model.id),
    ["claude-haiku-5.5", "gpt-6-luna"]
  );
  assert.deepEqual(models[0], {
    id: "claude-haiku-5.5",
    name: "Claude Haiku 5.5",
    supportsVision: true,
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: null,
    policyState: "enabled",
    inputPrice: 10,
    outputPrice: 50,
  });
});

test("a candidate token is checked on its own client, which is then stopped", async () => {
  const { runtime, fake } = runtimeWith();
  runtime.setToken("gho_saved1234567");
  const { models } = await runtime.validateToken("gho_candidate123");
  assert.equal(models.length, 2);
  assert.equal(fake.clients.length, 1);
  assert.equal(fake.clients[0].options.gitHubToken, "gho_candidate123");
  assert.equal(fake.clients[0].stopped, true);
});

test("the in-memory session filesystem behaves like a small disk", async () => {
  const fs = createMemorySessionFs();
  await fs.appendFile("/session-state/events.jsonl", "a\n");
  await fs.appendFile("/session-state/events.jsonl", "b\n");
  assert.equal(await fs.readFile("/session-state/events.jsonl"), "a\nb\n");
  assert.deepEqual(await fs.readdir("/"), ["session-state"]);
  assert.deepEqual(await fs.readdirWithTypes("/session-state"), [
    { name: "events.jsonl", type: "file" },
  ]);
  assert.equal((await fs.stat("/session-state")).isDirectory, true);
  await fs.rename("/session-state", "/archived");
  assert.equal(await fs.exists("/session-state/events.jsonl"), false);
  assert.equal(await fs.readFile("/archived/events.jsonl"), "a\nb\n");
  await assert.rejects(fs.rm("/archived", false, false), { code: "ENOTEMPTY" });
  await fs.rm("/archived", true, false);
  await assert.rejects(fs.readFile("/archived/events.jsonl"), { code: "ENOENT" });
  await fs.rm("/missing", false, true);
  assert.deepEqual(fs._paths(), []);
});
