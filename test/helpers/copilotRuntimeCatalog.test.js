const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MODELS,
  manualTimers,
  runtimeWith,
  gate,
  flush,
  captureLogger,
} = require("./harness/copilotSdk");

// The Copilot runtime's model catalog: kept per sign-in across idle restarts,
// refreshed without blocking a request that a stale list already allows, one
// fetch in flight per runtime, and the prewarm a recording's start sends.

const HAIKU = "claude-haiku-5.5";
const LUNA = "gpt-6-luna";
const HAIKU_ONLY = MODELS.filter((model) => model.id !== LUNA);

const ask = (runtime, model = HAIKU, extra = {}) =>
  runtime.complete({ model, system: "s", user: "u", ...extra });

function timerOptions(timers, extra = {}) {
  return { setTimer: timers.setTimer, clearTimer: timers.clearTimer, idleStopMs: 1000, ...extra };
}

test("an idle restart keeps the catalog: the next request makes no catalog call", async () => {
  const timers = manualTimers();
  const { runtime, fake } = runtimeWith({}, timerOptions(timers));
  runtime.setToken("gho_token123456");
  const first = await ask(runtime);
  assert.equal(first.timings.catalog, "fetched");
  assert.equal(fake.listCalls(), 1);

  timers.fire(1000);
  await flush();
  assert.equal(fake.clients[0].stopped, true);

  fake.calls.length = 0;
  const second = await ask(runtime);
  assert.equal(fake.clients.length, 2);
  assert.deepEqual(fake.calls, ["start", "createSession", "send", "disconnect", "delete"]);
  assert.equal(second.timings.coldStart, true);
  assert.equal(second.timings.catalog, "fresh");
  assert.equal(fake.listCalls(), 1);
});

test("a token change drops the catalog, also when no runtime is running", async () => {
  const timers = manualTimers();
  const { runtime, fake } = runtimeWith({}, timerOptions(timers));
  runtime.setToken("gho_first1234567");
  await ask(runtime);

  runtime.setToken("gho_second123456");
  assert.equal((await ask(runtime)).timings.catalog, "fetched");
  assert.equal(fake.listCalls(), 2);

  // Idle-stopped first: there is no runtime to retire, and the catalog still goes.
  timers.fire(1000);
  await flush();
  assert.equal(runtime.getStatus().running, false);
  runtime.setToken("gho_third1234567");
  assert.equal((await ask(runtime)).timings.catalog, "fetched");
  assert.equal(fake.listCalls(), 3);
});

test("a stale catalog that lists the model is used at once and refreshed after the request", async () => {
  const clock = { now: 0 };
  const refresh = gate();
  const { runtime, fake } = runtimeWith(
    { clock, list: (call) => (call === 1 ? MODELS : refresh.promise) },
    { now: () => clock.now, modelsTtlMs: 1000 }
  );
  runtime.setToken("gho_token123456");
  await ask(runtime);
  clock.now += 5000;

  fake.calls.length = 0;
  // Would hang on the held refresh if the request waited for it.
  const result = await ask(runtime);
  assert.equal(result.timings.catalog, "stale");
  assert.equal(result.timings.catalogMs, 0);
  assert.deepEqual(fake.calls, ["createSession", "send", "disconnect", "delete", "list"]);
  // The refresh holds its own lease until it lands.
  assert.equal(runtime.getStatus().activeRequests, 1);

  refresh.resolve(MODELS);
  await flush();
  assert.equal(runtime.getStatus().activeRequests, 0);
  assert.equal((await ask(runtime)).timings.catalog, "fresh");
  assert.equal(fake.listCalls(), 2);
});

test("a stale catalog without the model waits for the refresh, then sends or refuses", async () => {
  for (const [refreshed, expected] of [
    [MODELS, "sends"],
    [HAIKU_ONLY, "refuses"],
  ]) {
    const clock = { now: 0 };
    const refresh = gate();
    const { runtime, fake } = runtimeWith(
      { clock, list: (call) => (call === 1 ? HAIKU_ONLY : refresh.promise) },
      { now: () => clock.now, modelsTtlMs: 1000 }
    );
    runtime.setToken("gho_token123456");
    await ask(runtime);
    clock.now += 5000;

    const pending = ask(runtime, LUNA);
    await flush();
    assert.equal(fake.clients[0].createConfigs.length, 1, "nothing created before the refresh");
    refresh.resolve(refreshed);
    if (expected === "sends") {
      const result = await pending;
      assert.equal(result.timings.catalog, "refreshed");
      assert.equal(fake.clients[0].createConfigs[1].model, LUNA);
    } else {
      await assert.rejects(pending, (error) => {
        assert.equal(error.code, "COPILOT_MODEL_UNAVAILABLE");
        assert.equal(error.copilotTimings.catalog, "refreshed");
        return true;
      });
      assert.equal(fake.clients[0].createConfigs.length, 1);
    }
  }
});

test("only a fresh catalog refuses a model it lacks; a failed refresh lets the request go ahead and keeps the catalog", async () => {
  const clock = { now: 0 };
  const { runtime, fake } = runtimeWith(
    {
      clock,
      list: async (call) => {
        if (call === 1) return HAIKU_ONLY;
        throw new Error("offline");
      },
    },
    { now: () => clock.now, modelsTtlMs: 1000 }
  );
  runtime.setToken("gho_token123456");
  await ask(runtime);
  // Fresh and without the model: refused, nothing created.
  await assert.rejects(ask(runtime, LUNA), { code: "COPILOT_MODEL_UNAVAILABLE" });
  assert.equal(fake.clients[0].createConfigs.length, 1);

  clock.now += 5000;
  // Stale and without the model, and the refresh fails: the stale list is no
  // evidence against the model, so the request goes ahead pinned to it.
  const result = await ask(runtime, LUNA, { disableThinking: true });
  assert.equal(result.timings.catalog, "failed");
  const config = fake.clients[0].createConfigs[1];
  assert.equal(config.model, LUNA);
  assert.deepEqual(config.allowedModels, [LUNA]);
  assert.equal(config.reasoningEffort, undefined);

  // The known catalog survived the failure: a model it lists goes ahead at once.
  assert.equal((await ask(runtime)).timings.catalog, "stale");
});

test("a request during a prewarm's catalog fetch shares it", async () => {
  const { logger, named } = captureLogger();
  const fetch = gate();
  const { runtime, fake } = runtimeWith({ list: () => fetch.promise }, { logger });
  runtime.setToken("gho_token123456");

  const warming = runtime.prewarm();
  await flush();
  assert.equal(fake.listCalls(), 1);
  const request = ask(runtime);
  await flush();
  assert.equal(fake.listCalls(), 1);
  assert.equal(fake.clients[0].createConfigs.length, 0);

  fetch.resolve(MODELS);
  const result = await request;
  await warming;
  assert.equal(result.timings.catalog, "shared");
  assert.equal(result.timings.coldStart, false);
  assert.equal(fake.listCalls(), 1);
  assert.equal(fake.clients.length, 1);
  const [prewarmed] = named("Copilot runtime prewarmed");
  assert.equal(prewarmed.meta.catalog, "fetched");
  assert.equal(prewarmed.meta.coldStart, true);
});

test("concurrent requests and the model list with no catalog share one fetch", async () => {
  const fetch = gate();
  const { runtime, fake } = runtimeWith({ list: () => fetch.promise });
  runtime.setToken("gho_token123456");
  const requests = [ask(runtime), ask(runtime, LUNA), runtime.listModels()];
  await flush();
  assert.equal(fake.listCalls(), 1);
  fetch.resolve(MODELS);
  const [first, second, models] = await Promise.all(requests);
  // Whoever got there first fetched; everyone else shared it.
  const catalogs = [first.timings.catalog, second.timings.catalog];
  assert.ok(catalogs.includes("shared"), catalogs.join());
  assert.ok(catalogs.every((catalog) => catalog === "fetched" || catalog === "shared"));
  assert.equal(models.length, 2);
  assert.equal(fake.listCalls(), 1);
});

test("a broken runtime's replacement never joins its fetch, and the old fetch stores nothing", async () => {
  const clock = { now: 0 };
  const oldFetch = gate();
  const { runtime, fake } = runtimeWith(
    {
      clock,
      list: (call) => (call === 1 ? HAIKU_ONLY : call === 2 ? oldFetch.promise : MODELS),
      send: (session, prompt) => {
        if (prompt === "lose") throw new Error("Connection is closed.");
        session.emit("assistant.usage", { finishReason: "stop" });
        return { data: { content: "ok" } };
      },
    },
    { now: () => clock.now, modelsTtlMs: 1000 }
  );
  runtime.setToken("gho_token123456");
  await ask(runtime);
  clock.now += 5000;

  // The prewarm refreshes the stale catalog on the first runtime (held open).
  const warming = runtime.prewarm();
  await flush();
  assert.equal(fake.listCalls(), 2);
  // That runtime is lost mid-request.
  await assert.rejects(ask(runtime, HAIKU, { user: "lose" }), { connectionLost: true });

  // Same sign-in, new runtime: it fetches for itself rather than joining.
  const replaced = await ask(runtime, LUNA);
  assert.equal(replaced.timings.catalog, "refreshed");
  assert.equal(fake.listCalls(), 3);
  assert.equal(fake.clients.length, 2);
  assert.equal(fake.clients[1].createConfigs[0].model, LUNA);

  // The lost runtime's late, older list must not replace the new one.
  oldFetch.resolve(HAIKU_ONLY);
  await warming;
  await flush();
  assert.equal((await ask(runtime, LUNA)).timings.catalog, "fresh");
  assert.equal(fake.clients[0].stopped, true);
});

test("a fetch from the previous sign-in that lands after a new one stores nothing", async () => {
  for (const startedBy of ["prewarm", "request"]) {
    const oldFetch = gate();
    const { runtime, fake } = runtimeWith({
      list: (call) => (call === 1 ? oldFetch.promise : MODELS),
    });
    runtime.setToken("gho_first1234567");
    const old = startedBy === "prewarm" ? runtime.prewarm() : ask(runtime);
    await flush();
    assert.equal(fake.listCalls(), 1);

    runtime.setToken("gho_second123456");
    const fresh = await ask(runtime);
    assert.equal(fresh.timings.catalog, "fetched", startedBy);
    assert.equal(fake.clients[1].options.gitHubToken, "gho_second123456");

    oldFetch.resolve(HAIKU_ONLY);
    await old;
    await flush();
    // Still the new sign-in's catalog, which lists Luna.
    assert.equal((await ask(runtime, LUNA)).timings.catalog, "fresh", startedBy);
    assert.equal(fake.clients[0].stopped, true, startedBy);
  }
});

test("a prewarm starts the runtime, fetches the catalog and lets the idle stop run", async () => {
  const timers = manualTimers();
  const clock = { now: 0 };
  const { logger, named } = captureLogger();
  const { runtime, fake } = runtimeWith(
    { clock, cost: { start: 3000, list: 2000 } },
    timerOptions(timers, { logger, now: () => clock.now })
  );
  runtime.setToken("gho_token123456");

  assert.equal(await runtime.prewarm(), undefined);
  assert.equal(fake.clients.length, 1);
  assert.equal(fake.clients[0].started, true);
  assert.equal(fake.listCalls(), 1);
  assert.equal(runtime.getStatus().activeRequests, 0);
  assert.equal(timers.pending(1000), 1);
  assert.deepEqual(named("Copilot runtime prewarmed")[0], {
    level: "debug",
    message: "Copilot runtime prewarmed",
    meta: { coldStart: true, startMs: 3000, catalog: "fetched", catalogMs: 2000 },
    scope: "copilot",
  });

  const result = await ask(runtime);
  assert.equal(result.timings.coldStart, false);
  assert.equal(result.timings.catalog, "fresh");

  // A second prewarm with everything warm returns at once.
  await runtime.prewarm();
  assert.deepEqual(named("Copilot runtime prewarmed")[1].meta, {
    coldStart: false,
    startMs: 0,
    catalog: "fresh",
    catalogMs: 0,
  });
  assert.equal(fake.listCalls(), 1);
  assert.equal(fake.clients.length, 1);
  assert.equal(timers.pending(1000), 1);
});

test("a prewarm signed out does nothing, and a start failure never throws", async () => {
  const timers = manualTimers();
  const { logger, lines, named } = captureLogger();
  const behavior = { startError: new Error("spawn ENOENT") };
  const { runtime, fake } = runtimeWith(behavior, timerOptions(timers, { logger }));

  assert.equal(await runtime.prewarm(), undefined);
  assert.equal(fake.clients.length, 0);
  assert.equal(lines.length, 0);

  runtime.setToken("gho_token123456");
  assert.equal(await runtime.prewarm(), undefined);
  const [failed] = named("Copilot runtime prewarm failed");
  assert.equal(failed.level, "debug");
  assert.equal(failed.meta.code, "COPILOT_RUNTIME_FAILED");
  assert.equal(failed.meta.coldStart, true);
  assert.equal(named("Copilot runtime prewarmed").length, 0);
  assert.equal(runtime.getStatus().activeRequests, 0);
  assert.equal(runtime.getStatus().running, false);

  delete behavior.startError;
  assert.equal((await ask(runtime)).text, "clean: u");
  assert.equal(fake.clients.length, 2);
});

test("a prewarm whose start finishes after a new sign-in warms nothing", async () => {
  const start = gate();
  const { logger, named } = captureLogger();
  const { runtime, fake } = runtimeWith({ startGate: start.promise }, { logger });
  runtime.setToken("gho_first1234567");
  const warming = runtime.prewarm();
  await flush();
  runtime.setToken("gho_second123456");
  start.resolve();
  await warming;
  await flush();
  assert.equal(fake.listCalls(), 0);
  assert.equal(named("Copilot runtime prewarmed").length, 0);
  assert.equal(fake.clients[0].stopped, true);

  const result = await ask(runtime);
  assert.equal(fake.clients[1].options.gitHubToken, "gho_second123456");
  assert.equal(result.timings.catalog, "fetched");
});

test("a hung catalog fetch gives up on its own, so the runtime still idles out", async () => {
  const timers = manualTimers();
  const { logger, named } = captureLogger();
  const { runtime, fake } = runtimeWith(
    { list: (call) => (call === 1 ? new Promise(() => {}) : MODELS) },
    timerOptions(timers, { logger, catalogTimeoutMs: 500, prewarmTimeoutMs: 2000 })
  );
  runtime.setToken("gho_token123456");
  const warming = runtime.prewarm();
  await flush();
  // The fetch holds the runtime up while it runs.
  assert.equal(timers.pending(1000), 0);

  timers.fire(500);
  await warming;
  assert.equal(named("Copilot runtime prewarmed")[0].meta.catalog, "failed");
  assert.equal(runtime.getStatus().activeRequests, 0);
  assert.equal(timers.pending(1000), 1);
  timers.fire(1000);
  await flush();
  assert.equal(fake.clients[0].stopped, true);

  const result = await ask(runtime);
  assert.equal(result.timings.catalog, "fetched");
  assert.equal(fake.listCalls(), 2);
});

test("a prewarm's own bound covers its catalog wait; the fetch keeps its lease until its bound", async () => {
  const timers = manualTimers();
  const { logger, named } = captureLogger();
  const { runtime } = runtimeWith(
    { list: () => new Promise(() => {}) },
    timerOptions(timers, { logger, catalogTimeoutMs: 5000, prewarmTimeoutMs: 2000 })
  );
  runtime.setToken("gho_token123456");
  const warming = runtime.prewarm();
  await flush();
  timers.fire(2000);
  await warming;
  assert.equal(named("Copilot runtime prewarmed")[0].meta.catalog, "failed");
  // The prewarm let go; the fetch still holds the runtime until its own bound.
  assert.equal(runtime.getStatus().activeRequests, 1);
  assert.equal(timers.pending(1000), 0);
  timers.fire(5000);
  await flush();
  assert.equal(runtime.getStatus().activeRequests, 0);
  assert.equal(timers.pending(1000), 1);
});

test("a prewarm stuck starting gives up, and the start hands its lease back when it lands", async () => {
  const timers = manualTimers();
  const start = gate();
  const { logger, named } = captureLogger();
  const { runtime, fake } = runtimeWith(
    { startGate: start.promise },
    timerOptions(timers, { logger, prewarmTimeoutMs: 2000 })
  );
  runtime.setToken("gho_token123456");
  const warming = runtime.prewarm();
  await flush();
  timers.fire(2000);
  await warming;
  const [failed] = named("Copilot runtime prewarm failed");
  assert.equal(failed.meta.code, "COPILOT_TIMEOUT");
  assert.equal(runtime.getStatus().activeRequests, 1);

  start.resolve();
  await flush();
  assert.equal(runtime.getStatus().activeRequests, 0);
  assert.equal(timers.pending(1000), 1);
  assert.equal(fake.listCalls(), 0);
});

test("one waiter's cancel never cancels the fetch another still waits on", async () => {
  const fetch = gate();
  const { logger, named } = captureLogger();
  const { runtime, fake } = runtimeWith({ list: () => fetch.promise }, { logger });
  runtime.setToken("gho_token123456");
  const warming = runtime.prewarm();
  await flush();

  const controller = new AbortController();
  const request = ask(runtime, HAIKU, { signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(request, (error) => {
    assert.equal(error.code, "COPILOT_CANCELLED");
    assert.equal(error.copilotTimings.catalog, undefined);
    assert.equal(typeof error.copilotTimings.catalogMs, "number");
    return true;
  });

  fetch.resolve(MODELS);
  await warming;
  assert.equal(named("Copilot runtime prewarmed")[0].meta.catalog, "fetched");
  assert.equal((await ask(runtime)).timings.catalog, "fresh");
  assert.equal(fake.listCalls(), 1);
});
