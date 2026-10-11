const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SLOW_START_MS,
  createStartTrace,
  isSlowStart,
  joinStartTrace,
  logStartTrace,
  markStartTrace,
  summarizeStartTrace,
} = require("../../src/utils/dictationStartTrace");

const press = { pressId: 7, keyAt: 1000, keyTimeSource: "os", hookAt: 1004, mainAt: 1010 };

test("offsets are measured from the OS key event and skip steps that never ran", () => {
  const trace = createStartTrace({ ...press, prepareSentAt: 1011 });
  markStartTrace(trace, "prepareReceived", 1015);
  markStartTrace(trace, "micGetUserMediaDone", 1070);
  markStartTrace(trace, "micReady", 1090);
  trace.details = { micResolution: "cached", micSource: "opened" };

  assert.deepEqual(summarizeStartTrace(trace, 1500), {
    pressId: 7,
    keyTimeSource: "os",
    hookAfterKeyMs: 4,
    mainAfterKeyMs: 10,
    prepareSentAfterKeyMs: 11,
    prepareReceivedAfterKeyMs: 15,
    micGetUserMediaDoneAfterKeyMs: 70,
    micReadyAfterKeyMs: 90,
    loggedAfterKeyMs: 500,
    micResolution: "cached",
    micSource: "opened",
  });
});

test("the first mark of a step wins", () => {
  const trace = createStartTrace(press);
  markStartTrace(trace, "startReceived", 1200);
  markStartTrace(trace, "startReceived", 1900);
  assert.equal(trace.steps.startReceived, 1200);
});

test("start joins the prepare of the same press and keeps its steps", () => {
  const prepared = createStartTrace(press);
  markStartTrace(prepared, "micReady", 1080);

  const joined = joinStartTrace(prepared, { ...press, startSentAt: 1160 });

  assert.equal(joined, prepared);
  assert.equal(joined.startSentAt, 1160);
  assert.equal(joined.steps.micReady, 1080);
});

test("a start for another press, or with no press at all, begins a fresh trace", () => {
  const prepared = createStartTrace(press);
  markStartTrace(prepared, "micReady", 1080);

  assert.deepEqual(joinStartTrace(prepared, { ...press, pressId: 8 }).steps, {});
  assert.deepEqual(joinStartTrace(prepared, undefined).steps, {});
});

test("without a key time, offsets start at the first renderer step", () => {
  const trace = createStartTrace(undefined);
  markStartTrace(trace, "startReceived", 5000);
  markStartTrace(trace, "recordingStarted", 5240);

  const summary = summarizeStartTrace(trace, 5300);
  assert.equal(summary.keyTimeSource, "renderer");
  assert.equal(summary.startReceivedAfterKeyMs, 0);
  assert.equal(summary.recordingStartedAfterKeyMs, 240);
  assert.equal(summary.loggedAfterKeyMs, 300);
});

test("a start is slow when it takes a second or drops a prepared pre-roll", () => {
  assert.equal(isSlowStart({ recordingStartedAfterKeyMs: SLOW_START_MS }), true);
  assert.equal(isSlowStart({ recordingStartedAfterKeyMs: 400 }), false);
  assert.equal(
    isSlowStart({ recordingStartedAfterKeyMs: 400, usedPreparedCapture: true, preRoll: false }),
    true
  );
  assert.equal(
    isSlowStart({ recordingStartedAfterKeyMs: 400, usedPreparedCapture: false, preRoll: false }),
    false
  );
});

test("a press given up on while still starting is slow once it ran past a second", () => {
  assert.equal(
    isSlowStart({ outcome: "stopped-during-start", loggedAfterKeyMs: SLOW_START_MS + 1 }),
    true
  );
  assert.equal(isSlowStart({ outcome: "stopped-during-start", loggedAfterKeyMs: 300 }), false);
  assert.equal(isSlowStart({ outcome: "not-started", loggedAfterKeyMs: 2500 }), true);
});

test("each attempt is logged once, with its outcome", () => {
  const trace = createStartTrace(press);
  markStartTrace(trace, "recordingStarted", 1300);

  const summary = logStartTrace(trace, "started");

  assert.equal(summary.outcome, "started");
  assert.equal(logStartTrace(trace, "not-started"), null);
  assert.equal(logStartTrace(null, "started"), null);
});
