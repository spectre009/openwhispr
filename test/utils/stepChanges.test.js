const test = require("node:test");
const assert = require("node:assert/strict");

const { stepChanges, leavesText } = require("../../src/utils/stepChanges.js");

// The one rule main's list marks, the "Cleanup changed it" filter (as SQL) and
// the History detail share: a step is compared with the text it received.

const step = (outcome, output) => ({ outcome, output });

test("each step is compared with the output of the step before it", () => {
  assert.deepEqual(
    stepChanges([step("ok", "um hi"), step("ok", "um hi"), step("ok", "Hi."), step("ok", "Hi.")]),
    [
      { input: null, change: null },
      { input: 0, change: "same" },
      { input: 1, change: "changed" },
      { input: 2, change: "same" },
    ]
  );
});

test("a failed step or an ignored blank reply is never the next step's input", () => {
  assert.deepEqual(
    stepChanges([
      step("ok", "hello"),
      step("failed", null),
      step("fallback", ""),
      step("ok", "hello"),
      step("skipped", "hello"),
      step("ok", "Hello."),
    ]),
    [
      { input: null, change: null },
      { input: 0, change: "failed" },
      { input: 0, change: "fallback" },
      { input: 0, change: "same" },
      { input: 3, change: "skipped" },
      { input: 4, change: "changed" },
    ]
  );
});

test("whitespace and case are changes; a missing output compares with nothing", () => {
  assert.deepEqual(
    stepChanges([step("ok", "a b"), step("ok", "a\nb"), step("ok", "A\nb"), step("ok", null)]).map(
      (entry) => entry.change
    ),
    [null, "changed", "changed", null]
  );
  assert.deepEqual(stepChanges([step("ok", "first")]), [{ input: null, change: null }]);
  assert.deepEqual(stepChanges(null), []);
  assert.equal(leavesText(step("skipped", "x")), true);
  assert.equal(leavesText(step("failed", "x")), false);
  assert.equal(leavesText(step("ok", null)), false);
});
