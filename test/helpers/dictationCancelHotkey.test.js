const test = require("node:test");
const assert = require("node:assert/strict");

// The dictation window's one owner of the global Esc: held while recording,
// and only after processing has run long; a cycle token keeps an old timer or
// a late registration from taking a newer recording's Esc.

async function load() {
  return import("../../src/helpers/dictationCancelHotkey.js");
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(createDictationCancelHotkey, { result = { success: true } } = {}) {
  const calls = [];
  const hints = [];
  const timers = new Map();
  let nextTimer = 0;
  const owner = createDictationCancelHotkey({
    register: (purpose) => {
      calls.push(`register:${purpose}`);
      return typeof result === "function" ? result(purpose) : result;
    },
    unregister: () => calls.push("unregister"),
    onHintChange: (visible) => hints.push(visible),
    slowAfterMs: 8000,
    setTimer: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const fire = () => {
    const pending = [...timers.entries()];
    timers.clear();
    for (const [, timer] of pending) timer.fn();
  };
  return { owner, calls, hints, timers, fire };
}

test("Esc is held while recording and released when processing begins", async () => {
  const { createDictationCancelHotkey } = await load();
  const h = harness(createDictationCancelHotkey);
  h.owner.setPhase("recording");
  assert.deepEqual(h.calls, ["register:recording"]);
  h.owner.setPhase("processing");
  assert.deepEqual(h.calls, ["register:recording", "unregister"]);
  assert.equal(h.owner.holdsProcessing, false);
});

test("processing holds Esc only after 8 s, with the hint, and releases it on settle", async () => {
  const { createDictationCancelHotkey, SLOW_PROCESSING_MS } = await load();
  assert.equal(SLOW_PROCESSING_MS, 8000);
  const h = harness(createDictationCancelHotkey);
  h.owner.setPhase("processing");
  assert.deepEqual(h.calls, []);
  assert.equal([...h.timers.values()][0].ms, 8000);
  h.fire();
  assert.deepEqual(h.calls, ["register:processing"]);
  await flush();
  assert.deepEqual(h.hints, [true]);
  assert.equal(h.owner.holdsProcessing, true);
  h.owner.setPhase("idle");
  assert.deepEqual(h.calls, ["register:processing", "unregister"]);
  assert.deepEqual(h.hints, [true, false]);
  assert.equal(h.owner.holdsProcessing, false);
});

test("a dictation that settles within 8 s never takes Esc", async () => {
  const { createDictationCancelHotkey } = await load();
  const h = harness(createDictationCancelHotkey);
  h.owner.setPhase("processing");
  h.owner.setPhase("idle");
  assert.equal(h.timers.size, 0, "the timer is cleared");
  h.fire();
  await flush();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.hints, []);
});

test("an old cycle's timer can't grab Esc from a newer recording", async () => {
  const { createDictationCancelHotkey } = await load();
  const timers = [];
  const calls = [];
  const owner = createDictationCancelHotkey({
    register: (purpose) => {
      calls.push(`register:${purpose}`);
      return { success: true };
    },
    unregister: () => calls.push("unregister"),
    setTimer: (fn) => timers.push(fn),
    // A clear that comes too late to stop the callback.
    clearTimer: () => {},
  });
  owner.setPhase("processing");
  owner.setPhase("idle");
  owner.setPhase("recording");
  timers[0]();
  await flush();
  assert.deepEqual(calls, ["register:recording"]);
  assert.equal(owner.holdsProcessing, false);
});

test("a registration that lands after a newer recording began shows no hint", async () => {
  const { createDictationCancelHotkey } = await load();
  const late = deferred();
  const h = harness(createDictationCancelHotkey, {
    result: (purpose) => (purpose === "processing" ? late.promise : { success: true }),
  });
  h.owner.setPhase("processing");
  h.fire();
  // Processing settles and the next recording starts at the boundary.
  h.owner.setPhase("idle");
  h.owner.setPhase("recording");
  late.resolve({ success: true });
  await flush();
  // Main hears them in order, so the recording's registration is the last.
  assert.deepEqual(h.calls, ["register:processing", "unregister", "register:recording"]);
  assert.deepEqual(h.hints, []);
  assert.equal(h.owner.phase, "recording");
});

test("a failed registration shows no hint and holds nothing", async () => {
  const { createDictationCancelHotkey } = await load();
  for (const result of [
    () => ({ success: false, error: "taken" }),
    () => Promise.reject(new Error("ipc")),
  ]) {
    const h = harness(createDictationCancelHotkey, { result });
    h.owner.setPhase("processing");
    h.fire();
    await flush();
    assert.deepEqual(h.hints, []);
    assert.equal(h.owner.holdsProcessing, false);
    h.owner.setPhase("idle");
    assert.deepEqual(h.calls, ["register:processing"], "nothing to release");
  }
});

test("repeated phase reports don't restart the timer or re-register", async () => {
  const { createDictationCancelHotkey } = await load();
  const h = harness(createDictationCancelHotkey);
  h.owner.setPhase("recording");
  h.owner.setPhase("recording");
  h.owner.setPhase("processing");
  const timer = [...h.timers.keys()][0];
  h.owner.setPhase("processing");
  assert.deepEqual([...h.timers.keys()], [timer]);
  assert.deepEqual(h.calls, ["register:recording", "unregister"]);
  h.owner.dispose();
  assert.equal(h.owner.phase, "idle");
  assert.equal(h.timers.size, 0);
});
