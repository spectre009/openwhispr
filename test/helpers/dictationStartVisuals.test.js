const test = require("node:test");
const assert = require("node:assert/strict");

const {
  START_VISUALS_DEADLINE_MS,
  StartVisualsTracker,
  isStartVisualsComplete,
  missingStartVisuals,
  startVisualsSlowness,
} = require("../../src/helpers/dictationStartVisuals");

// One "Dictation start visuals" line per dictation start (helpers/
// dictationStartVisuals.js): written once the pill, its entrance and the strip
// or frame are in, or after 3 s with what arrived; a warning when the pill
// took over 500 ms, the frame over 1000 ms, or graphics fell back to the CPU;
// nothing for a press cancelled before anything showed.

const KEY = 1_800_000_000_000;
const HARDWARE = { mode: "hardware", reason: null };
const FALLBACK = { mode: "software", reason: "fallback" };

function setup({ graphics = HARDWARE, logger } = {}) {
  const clock = { now: KEY };
  const timers = [];
  const lines = [];
  const tracker = new StartVisualsTracker({
    logger: logger ?? {
      info: (message, meta, scope) => lines.push({ level: "info", message, meta, scope }),
      warn: (message, meta, scope) => lines.push({ level: "warn", message, meta, scope }),
    },
    getGraphics: typeof graphics === "function" ? graphics : () => graphics,
    now: () => clock.now,
    timers: {
      setTimeout: (fn, ms) => {
        const timer = { fn, at: clock.now + ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        if (timer) timer.cleared = true;
      },
    },
  });
  const advance = (ms) => {
    clock.now += ms;
    for (const timer of timers.filter((t) => !t.cleared && t.at <= clock.now)) {
      timer.cleared = true;
      timer.fn();
    }
  };
  const at = (ms) => KEY + ms;
  const press = (options = {}) =>
    tracker.begin({
      pressId: KEY,
      keyAt: KEY,
      keyTimeSource: "os",
      pillWasVisible: false,
      strip: "frame",
      ...options,
    });
  return { tracker, lines, advance, at, press, clock };
}

test("a start with the frame on: one line once the pill, its entrance and the frame are in", () => {
  const { tracker, lines, advance, at, press } = setup();
  press();
  assert.equal(tracker.pendingPressId, KEY);
  assert.equal(tracker.mark(KEY, "pillPainted", at(42)), true);
  advance(300);
  tracker.recordingStarted();
  tracker.frameShown({ window: "new", at: at(430) });
  assert.deepEqual(lines, [], "the entrance hasn't ended yet");
  advance(600);
  tracker.mark(KEY, "pillSettled", at(880));
  assert.deepEqual(lines, [
    {
      level: "info",
      message: "Dictation start visuals",
      meta: {
        pressId: KEY,
        keyTimeSource: "os",
        pillShownAfterKeyMs: 42,
        pillWasVisible: false,
        pillSettledAfterKeyMs: 880,
        recordingAfterKeyMs: 300,
        frameShownAfterKeyMs: 430,
        frameWindow: "new",
        strip: "frame",
        graphics: "hardware",
        outcome: "complete",
        loggedAfterKeyMs: 900,
      },
      scope: "window",
    },
  ]);
  assert.equal(tracker.pendingPressId, null);
  advance(START_VISUALS_DEADLINE_MS);
  assert.equal(lines.length, 1, "the deadline was cleared");
});

test("slow: the pill after 500 ms, the frame after 1000 ms, or a software fallback", () => {
  const cases = [
    { pill: 500, frame: 1000, graphics: HARDWARE, slow: null },
    { pill: 501, frame: 900, graphics: HARDWARE, slow: ["pill"] },
    { pill: 40, frame: 1001, graphics: HARDWARE, slow: ["frame"] },
    { pill: 40, frame: 300, graphics: FALLBACK, slow: ["graphics"] },
    { pill: 40, frame: 300, graphics: { mode: "software", reason: "requested" }, slow: null },
  ];
  for (const { pill, frame, graphics, slow } of cases) {
    const { tracker, lines, at, press } = setup({ graphics });
    press({ expectSettle: false, pillWasVisible: true });
    tracker.mark(KEY, "pillPainted", at(pill));
    tracker.recordingStarted(at(200));
    tracker.frameShown({ window: "reused", at: at(frame) });
    const [line] = lines;
    const label = JSON.stringify({ pill, frame, graphics });
    if (slow) {
      assert.equal(line.level, "warn", label);
      assert.equal(line.message, "Slow dictation start visuals", label);
      assert.deepEqual(line.meta.slow, slow, label);
    } else {
      assert.equal(line.level, "info", label);
      assert.equal(line.meta.slow, undefined, label);
    }
    assert.equal(line.meta.frameWindow, "reused");
    assert.equal(line.meta.pillWasVisible, true);
    assert.equal(line.meta.graphics, graphics.mode);
  }
});

test("after 3 s, what arrived is written; a mark still missing counts as late", () => {
  const { tracker, lines, advance, at, press } = setup();
  press();
  tracker.mark(KEY, "pillPainted", at(30));
  advance(400);
  tracker.recordingStarted();
  advance(START_VISUALS_DEADLINE_MS - 401);
  assert.deepEqual(lines, []);
  advance(1);
  assert.equal(lines.length, 1);
  const { level, meta } = lines[0];
  assert.equal(level, "warn");
  assert.deepEqual(meta.missing, ["settle", "frame"]);
  assert.deepEqual(meta.slow, ["frame"]);
  assert.equal(meta.outcome, "timeout");
  assert.equal(meta.frameShownAfterKeyMs, undefined);
  assert.equal(meta.frameWindow, undefined);
  assert.equal(meta.loggedAfterKeyMs, START_VISUALS_DEADLINE_MS);

  // A recording that never started by then: the strip wasn't due, the pill was quick.
  const slowMic = setup();
  slowMic.press();
  slowMic.tracker.mark(KEY, "pillPainted", slowMic.at(25));
  slowMic.advance(START_VISUALS_DEADLINE_MS);
  assert.equal(slowMic.lines[0].level, "info");
  assert.equal(slowMic.lines[0].meta.missing, undefined);
  assert.equal(slowMic.lines[0].meta.recordingAfterKeyMs, undefined);

  // A renderer that never painted: the pill is late.
  const hung = setup();
  hung.press();
  hung.advance(START_VISUALS_DEADLINE_MS);
  assert.deepEqual(hung.lines[0].meta.slow, ["pill"]);
  assert.deepEqual(hung.lines[0].meta.missing, ["pill"]);
});

test("a press cancelled before anything showed writes nothing; after the pill, what arrived", () => {
  const { tracker, lines, advance, at, press } = setup();
  press();
  advance(90);
  tracker.cancelled();
  assert.deepEqual(lines, []);
  assert.equal(tracker.pendingPressId, null);
  advance(START_VISUALS_DEADLINE_MS);
  assert.deepEqual(lines, [], "and nothing later");

  press();
  tracker.mark(KEY, "pillPainted", at(20));
  advance(120);
  tracker.cancelled();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "info");
  assert.equal(lines[0].meta.outcome, "cancelled");
  assert.equal(lines[0].meta.pillShownAfterKeyMs, 20);
  assert.equal(lines[0].meta.missing, undefined, "nothing else was due without a recording");
});

test("a recording stopped before its frame showed is written then; quick is not slow", () => {
  const { tracker, lines, advance, at, press } = setup();
  press();
  tracker.mark(KEY, "pillPainted", at(20));
  advance(200);
  tracker.recordingStarted();
  tracker.cancelled();
  assert.deepEqual(lines, [], "a recording isn't cancelled");
  advance(200);
  tracker.recordingEnded();
  assert.equal(lines[0].level, "info");
  assert.equal(lines[0].meta.outcome, "stopped");
  assert.deepEqual(lines[0].meta.missing, ["settle", "frame"]);
  tracker.recordingEnded();
  assert.equal(lines.length, 1);
});

test("strip off: frameWindow none and nothing awaited; no entrance under the assistant panel", () => {
  const { tracker, lines, at, press } = setup();
  press({ strip: "off", expectSettle: false });
  tracker.mark(KEY, "pillPainted", at(18));
  tracker.recordingStarted(at(250));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].meta.frameWindow, "none");
  assert.equal(lines[0].meta.strip, undefined);
  assert.equal(lines[0].meta.outcome, "complete");
  // An unknown mode reads as off.
  press({ strip: "huge" });
  assert.equal(tracker._start.strip, "off");
});

test("marks for another press, repeated, unknown or far off are ignored; a new press ends the old", () => {
  const { tracker, lines, at, press, clock } = setup();
  press();
  assert.equal(tracker.mark(KEY + 1, "pillPainted", at(10)), false);
  assert.equal(tracker.mark(KEY, "pillShown", at(10)), false);
  assert.equal(tracker.mark(KEY, "__proto__", at(10)), false);
  assert.equal(tracker.mark(KEY, "pillPainted", Number.NaN), false);
  assert.equal(tracker.mark(KEY, "pillPainted", at(20_000)), false);
  assert.equal(tracker.mark(KEY, "pillPainted", at(10)), true);
  assert.equal(tracker.mark(KEY, "pillPainted", at(11)), false);
  tracker.frameShown({ window: "new", at: at(50) });
  assert.equal(tracker._start.frame, undefined, "no strip before its recording");

  clock.now = at(700);
  tracker.begin({ pressId: KEY + 700, keyAt: at(700), keyTimeSource: "main", strip: "short" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].meta.outcome, "superseded");
  assert.equal(lines[0].meta.pressId, KEY);
  assert.equal(tracker.pendingPressId, KEY + 700);
  assert.equal(tracker._start.keyTimeSource, "main");

  // A key time far from now (a clock it doesn't share) falls back to now.
  tracker.begin({ pressId: 5, keyAt: 5, keyTimeSource: "os", strip: "short" });
  assert.equal(tracker._start.keyAt, clock.now);
  tracker.begin({ pressId: undefined });
  assert.equal(tracker.pendingPressId, null);
});

test("a graphics reader that throws reads unknown; a logger without info never throws", () => {
  const throwing = setup({
    graphics: () => {
      throw new Error("not yet");
    },
  });
  throwing.press({ strip: "off", expectSettle: false });
  throwing.tracker.mark(KEY, "pillPainted", throwing.at(10));
  throwing.tracker.recordingStarted(throwing.at(100));
  assert.equal(throwing.lines[0].meta.graphics, "unknown");

  const quiet = setup({ logger: { warn: () => undefined } });
  quiet.press({ strip: "off", expectSettle: false });
  quiet.tracker.mark(KEY, "pillPainted", quiet.at(10));
  assert.doesNotThrow(() => quiet.tracker.recordingStarted(quiet.at(100)));
});

test("the pure rules: what is missing, when it is complete, why it is slow", () => {
  const start = { keyAt: 0, strip: "full", expectSettle: true };
  assert.deepEqual(missingStartVisuals(start), ["pill"]);
  assert.equal(isStartVisualsComplete({ ...start, pillPainted: 5 }), false, "no recording yet");
  const recording = { ...start, pillPainted: 5, recording: 100 };
  assert.deepEqual(missingStartVisuals(recording), ["settle", "frame"]);
  assert.equal(isStartVisualsComplete({ ...recording, pillSettled: 700, frame: 200 }), true);
  assert.deepEqual(startVisualsSlowness(recording, { now: 999, graphics: null }), []);
  assert.deepEqual(startVisualsSlowness(recording, { now: 1001, graphics: FALLBACK }), [
    "frame",
    "graphics",
  ]);
});
