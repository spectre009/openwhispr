const test = require("node:test");
const assert = require("node:assert/strict");

const { MODELS, runtimeWith, flush, captureLogger } = require("./harness/copilotSdk");

// One Copilot request: its step timings and usage numbers, the model guard
// listening from session creation, and the stale-effort retry.

const HAIKU = "claude-haiku-5.5";
const COST = { start: 3000, list: 2000, create: 100, send: 1500, disconnect: 10, delete: 5 };

const ask = (runtime, extra = {}) =>
  runtime.complete({ model: HAIKU, system: "s", user: "u", ...extra });

function withEfforts(efforts) {
  return MODELS.map((model) =>
    model.id === HAIKU ? { ...model, supportedReasoningEfforts: efforts } : model
  );
}

test("a request returns its step timings and usage numbers, cold and warm", async () => {
  const clock = { now: 0 };
  let usage = {
    model: HAIKU,
    finishReason: "stop",
    duration: 850,
    timeToFirstTokenMs: 412.6,
    inputTokens: 1200,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheWriteTokens: "12",
  };
  const send = (session) => {
    session.emit("assistant.usage", usage);
    return { data: { content: "ok" } };
  };
  const { runtime } = runtimeWith({ clock, cost: COST, send }, { now: () => clock.now });
  runtime.setToken("gho_token123456");

  const cold = await ask(runtime);
  assert.deepEqual(cold.timings, {
    coldStart: true,
    acquireMs: 3000,
    catalog: "fetched",
    catalogMs: 2000,
    sessionMs: 100,
    sendMs: 1500,
    closeMs: 15,
  });
  assert.deepEqual(cold.usage, {
    modelMs: 850,
    ttftMs: 413,
    inputTokens: 1200,
    outputTokens: 40,
    cacheReadTokens: 0,
  });

  usage = {
    finishReason: "stop",
    duration: Number.NaN,
    timeToFirstTokenMs: null,
    inputTokens: Number.POSITIVE_INFINITY,
    outputTokens: "40",
  };
  const warm = await ask(runtime);
  assert.deepEqual(warm.timings, {
    coldStart: false,
    acquireMs: 0,
    catalog: "fresh",
    catalogMs: 0,
    sessionMs: 100,
    sendMs: 1500,
    closeMs: 15,
  });
  assert.deepEqual(warm.usage, {});
});

test("a failed request carries the timings it gathered", async () => {
  const clock = { now: 0 };
  const behavior = { clock, cost: COST, createError: new Error("create failed") };
  const { runtime } = runtimeWith(behavior, { now: () => clock.now });

  await assert.rejects(ask(runtime), (error) => {
    assert.equal(error.code, "COPILOT_NOT_SIGNED_IN");
    assert.deepEqual(error.copilotTimings, { coldStart: false, acquireMs: 0 });
    return true;
  });

  runtime.setToken("gho_token123456");
  await assert.rejects(ask(runtime), (error) => {
    assert.equal(error.code, "COPILOT_SDK_ERROR");
    assert.deepEqual(error.copilotTimings, {
      coldStart: true,
      acquireMs: 3000,
      catalog: "fetched",
      catalogMs: 2000,
      sessionMs: 100,
    });
    return true;
  });

  delete behavior.createError;
  behavior.send = () => {
    throw new Error("upstream failed");
  };
  await assert.rejects(ask(runtime), (error) => {
    assert.deepEqual(error.copilotTimings, {
      coldStart: false,
      acquireMs: 0,
      catalog: "fresh",
      catalogMs: 0,
      sessionMs: 100,
      sendMs: 1500,
      closeMs: 15,
    });
    return true;
  });
});

test("a start failure gives each waiting request its own error and timings", async () => {
  const { runtime } = runtimeWith({ startError: new Error("spawn ENOENT") });
  runtime.setToken("gho_token123456");
  const results = await Promise.allSettled([ask(runtime), ask(runtime)]);
  const [first, second] = results.map((result) => result.reason);
  assert.equal(first.code, "COPILOT_RUNTIME_FAILED");
  assert.equal(second.code, "COPILOT_RUNTIME_FAILED");
  assert.notEqual(first, second);
  assert.equal(first.copilotTimings.coldStart, true);
  assert.equal(second.copilotTimings.coldStart, false);
});

test("a model swap while the session is created is refused before anything is sent", async () => {
  const create = (session) => {
    session.emit("session.model_change", {
      newModel: "claude-sonnet-5.5",
      cause: "model_unavailable",
      source: "automatic",
    });
  };
  const { runtime, fake } = runtimeWith({ create });
  runtime.setToken("gho_token123456");
  await assert.rejects(ask(runtime), (error) => {
    assert.equal(error.code, "COPILOT_MODEL_UNAVAILABLE");
    assert.equal(error.copilotTimings.sendMs, undefined);
    return true;
  });
  assert.equal(fake.calls.includes("send"), false);
  const [session] = fake.clients[0].sessions;
  assert.deepEqual(session.config.allowedModels, [HAIKU]);
  assert.equal(session.disconnected, true);
  assert.deepEqual(fake.clients[0].deleted, [session.sessionId]);
});

test("sessions disable the runtime's built-in MCP servers, and a connected one shows in the timings", async () => {
  const { runtime, fake } = runtimeWith();
  runtime.setToken("gho_token123456");
  const quiet = await ask(runtime);
  const [first] = fake.clients[0].sessions;
  assert.deepEqual(first.config.disabledMcpServers, ["github-mcp-server"]);
  assert.equal(quiet.timings.mcpConnected, undefined);

  // A server the runtime starts anyway (say, one renamed) is counted.
  const create = (session) => {
    session.emit("session.mcp_server_status_changed", { serverName: "x", status: "pending" });
    session.emit("session.mcp_server_status_changed", { serverName: "x", status: "connected" });
  };
  const other = runtimeWith({ create });
  other.runtime.setToken("gho_token123456");
  const result = await ask(other.runtime);
  assert.equal(result.timings.mcpConnected, 1);
});

test("a sub-agent's model change during creation is not the request's", async () => {
  const create = (session) => {
    for (const handler of session.handlers) {
      handler({
        type: "session.model_change",
        agentId: "sub-agent",
        data: { cause: "model_unavailable", source: "automatic" },
      });
    }
  };
  const { runtime } = runtimeWith({ create });
  runtime.setToken("gho_token123456");
  assert.equal((await ask(runtime)).text, "clean: u");
});

// The plan dropped "low" for Haiku after the catalog was cached.
function staleEffortRuntime({ refusal = "create", refreshedEfforts = ["medium", "high"] } = {}) {
  const clock = { now: 0 };
  const state = { lowGone: false };
  const refused = (config) => state.lowGone && config.reasoningEffort === "low";
  const behavior = {
    clock,
    list: async (call) =>
      call === 1 ? withEfforts(["low", "medium", "high"]) : withEfforts(refreshedEfforts),
    create: (_session, config) => {
      if (refusal === "create" && refused(config)) {
        throw new Error("Reasoning effort 'low' is not supported by this model");
      }
    },
    send: (session) => {
      if (refusal === "send" && refused(session.config)) {
        session.emit("session.error", {
          errorType: "query",
          statusCode: 400,
          message: "Unsupported value: 'reasoning_effort'",
          providerErrorParam: "reasoning_effort",
        });
        throw new Error("Unsupported value");
      }
      if (refusal === "after-output" && refused(session.config)) {
        session.emit("assistant.message_delta", { deltaContent: "x" });
        session.emit("session.error", { errorType: "query", statusCode: 400, message: "effort" });
        throw new Error("effort");
      }
      session.emit("assistant.usage", { model: HAIKU, finishReason: "stop" });
      return { data: { content: "ok" } };
    },
  };
  const { runtime, fake } = runtimeWith(behavior, { now: () => clock.now, modelsTtlMs: 1000 });
  runtime.setToken("gho_token123456");
  return { runtime, fake, clock, state };
}

const efforts = (fake) =>
  fake.clients.flatMap((client) => client.createConfigs.map((config) => config.reasoningEffort));

test("an effort from a stale catalog that's refused is checked against a fresh one and retried once", async () => {
  for (const refusal of ["create", "send"]) {
    const { runtime, fake, clock, state } = staleEffortRuntime({ refusal });
    assert.equal((await ask(runtime, { disableThinking: true })).reasoningEffort, "low");
    state.lowGone = true;
    clock.now += 5000;

    const result = await ask(runtime, { disableThinking: true });
    assert.equal(result.text, "ok", refusal);
    assert.equal(result.reasoningEffort, "medium");
    assert.equal(result.timings.catalog, "refreshed");
    assert.equal(result.timings.effortRetried, true);
    assert.deepEqual(efforts(fake), ["low", "low", "medium"]);
    await flush();
    // The retry's refresh replaced the after-request one.
    assert.equal(fake.listCalls(), 2, refusal);
    // The next request reads the fresh catalog.
    const next = await ask(runtime, { disableThinking: true });
    assert.equal(next.timings.catalog, "fresh");
    assert.equal(next.reasoningEffort, "medium");
  }
});

test("a refused stale effort is never dropped or retried unchanged", async () => {
  // The fresh catalog lists no effort: no retry that would let a default apply.
  for (const refreshedEfforts of [[], ["low", "high"]]) {
    const { runtime, fake, clock, state } = staleEffortRuntime({ refreshedEfforts });
    await ask(runtime, { disableThinking: true });
    state.lowGone = true;
    clock.now += 5000;
    await assert.rejects(ask(runtime, { disableThinking: true }), (error) => {
      assert.equal(error.code, "COPILOT_SDK_ERROR");
      assert.equal(error.copilotTimings.catalog, "refreshed");
      return true;
    });
    assert.deepEqual(efforts(fake), ["low", "low"], JSON.stringify(refreshedEfforts));
  }
});

test("no effort retry once output started, or when the effort came from a fresh catalog", async () => {
  const late = staleEffortRuntime({ refusal: "after-output" });
  await ask(late.runtime, { disableThinking: true });
  late.state.lowGone = true;
  late.clock.now += 5000;
  await assert.rejects(ask(late.runtime, { disableThinking: true }), { code: "COPILOT_SDK_ERROR" });
  assert.deepEqual(efforts(late.fake), ["low", "low"]);

  const fresh = staleEffortRuntime();
  fresh.state.lowGone = true;
  await assert.rejects(ask(fresh.runtime, { disableThinking: true }), {
    code: "COPILOT_SDK_ERROR",
  });
  assert.deepEqual(efforts(fresh.fake), ["low"]);
  assert.equal(fresh.fake.listCalls(), 1);
});

test("no prompt or reply text reaches the runtime's logs or its timings", async () => {
  const { logger, lines } = captureLogger();
  let fail = false;
  const send = (session) => {
    if (fail) throw new Error("upstream failed");
    session.emit("assistant.usage", { model: HAIKU, finishReason: "stop", inputTokens: 9 });
    return { data: { content: "REPLY-CANARY-7731" } };
  };
  const { runtime } = runtimeWith({ send }, { logger });
  runtime.setToken("gho_token123456");
  await runtime.prewarm();
  const result = await runtime.complete({
    model: HAIKU,
    system: "SYSTEM-CANARY-7731",
    user: "USER-CANARY-7731",
  });
  assert.equal(result.text, "REPLY-CANARY-7731");
  fail = true;
  const failure = await runtime
    .complete({ model: HAIKU, system: "SYSTEM-CANARY-7731", user: "USER-CANARY-7731" })
    .catch((error) => error);
  assert.ok(lines.length > 0);
  assert.doesNotMatch(JSON.stringify(lines), /CANARY/);
  assert.doesNotMatch(
    JSON.stringify([result.timings, result.usage, failure.copilotTimings]),
    /CANARY/
  );
});
