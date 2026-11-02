const test = require("node:test");
const assert = require("node:assert/strict");

const {
  START_VISUAL_MAX_AGE_MS,
  createStartVisualReporter,
} = require("../../src/utils/dictationStartVisualMarks");

// The dictation window's reports for "Dictation start visuals": the first frame
// painted after main's probe and the frame where the pill's entrance settled,
// each after two animation frames, once per press.

function setup() {
  const clock = { now: 1000 };
  const frames = [];
  const reports = [];
  const reporter = createStartVisualReporter({
    report: (mark) => reports.push(mark),
    now: () => clock.now,
    scheduleFrame: (callback) => frames.push(callback),
  });
  const frame = (ms = 8) => {
    clock.now += ms;
    const due = frames.splice(0);
    for (const callback of due) callback();
  };
  return { reporter, reports, frame, clock };
}

test("the probe reports the frame painted after it, two animation frames on", () => {
  const { reporter, reports, frame } = setup();
  reporter.probe(42);
  assert.deepEqual(reports, []);
  frame();
  assert.deepEqual(reports, [], "the first frame only schedules the next");
  frame();
  assert.deepEqual(reports, [{ pressId: 42, mark: "pillPainted", at: 1016 }]);
});

test("the settled entrance is reported once per probed press, and not long after it", () => {
  const { reporter, reports, frame, clock } = setup();
  reporter.settled();
  frame();
  frame();
  assert.deepEqual(reports, [], "nothing probed: a recording no press started");

  reporter.probe(7);
  frame();
  frame();
  clock.now += 600;
  reporter.settled();
  reporter.settled();
  frame();
  frame();
  assert.deepEqual(
    reports.map(({ mark, at }) => [mark, at]),
    [
      ["pillPainted", 1032],
      ["pillSettled", 1648],
    ]
  );

  reporter.probe(8);
  clock.now += START_VISUAL_MAX_AGE_MS + 1;
  reporter.settled();
  frame();
  frame();
  assert.equal(reports.filter(({ pressId }) => pressId === 8).length, 1, "only its paint");
});

test("bad probes are ignored and a failing report never throws", () => {
  const frames = [];
  const reporter = createStartVisualReporter({
    report: () => {
      throw new Error("gone");
    },
    scheduleFrame: (callback) => frames.push(callback),
  });
  reporter.probe(undefined);
  reporter.probe("7");
  assert.equal(frames.length, 0);
  reporter.probe(9);
  assert.doesNotThrow(() => {
    frames.shift()();
    frames.shift()();
  });
});
