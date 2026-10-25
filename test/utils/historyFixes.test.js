const test = require("node:test");
const assert = require("node:assert/strict");

const {
  alignCorrection,
  blamedStepIndex,
  cleanPhrase,
  firedGlossaryRules,
  glossaryRuleWithSpelling,
  historyFixKind,
  suggestTestChecks,
  trimSpan,
} = require("../../src/utils/historyFixes.ts");

// The History review's fixes, pure: which fix a blamed step suggests, the
// canonical form a glossary correction would write (the correction's words
// for the selected ones, only when they line up cleanly), and the literal
// checks a test case is offered (words the correction adds and removes).

const step = (kind, output, extra = {}) => ({
  kind,
  outcome: "ok",
  output,
  provider: null,
  model: null,
  ms: 1,
  errorCode: null,
  prompt: null,
  detail: null,
  ...extra,
});
const STEPS = [step("stt", "a"), step("glossary", "a"), step("cleanup", "A."), step("style", "A!")];
const at = (text, part) => {
  const start = text.indexOf(part);
  assert.ok(start >= 0, `"${part}" is in the text`);
  return [start, start + part.length];
};

test("the fix follows the blamed step; Not sure and steps without a fix have none", () => {
  assert.equal(historyFixKind({ kind: "stt", seq: 0 }, STEPS), "recognition");
  assert.equal(historyFixKind({ kind: "glossary", seq: 1 }, STEPS), "glossary");
  assert.equal(historyFixKind({ kind: "cleanup", seq: 2 }, STEPS), "cleanup");
  assert.equal(historyFixKind({ kind: "style", seq: 3 }, STEPS), "style");
  assert.equal(historyFixKind({ kind: "delivery", seq: null }, STEPS), "delivery");
  assert.equal(historyFixKind({ kind: "unsure", seq: null }, STEPS), null);
  assert.equal(historyFixKind(null, STEPS), null);
  // A step that isn't the row's (another seq, another kind) names nothing.
  assert.equal(historyFixKind({ kind: "cleanup", seq: 1 }, STEPS), null);
  assert.equal(
    historyFixKind({ kind: "finalize", seq: 4 }, [...STEPS, step("finalize", "A!")]),
    null
  );
  assert.equal(blamedStepIndex({ kind: "cleanup", seq: 2 }, STEPS), 2);
  assert.equal(blamedStepIndex({ kind: "delivery", seq: null }, STEPS), null);
});

test("a selection loses its edge spaces and sentence punctuation", () => {
  assert.deepEqual(trimSpan("  little body, and", 0, 15), { start: 2, end: 13 });
  assert.equal(trimSpan(" , ", 0, 3), null);
  assert.equal(cleanPhrase(" little\n body, "), "little body");
});

const HEARD = "Move voice assistant to little body and keep translation on it too";
const CORRECTED = "Move Voice Assistant to Little Buddy, and keep Translation on it too.";

test("a selection the correction replaces gives the canonical form", () => {
  assert.equal(alignCorrection(HEARD, ...at(HEARD, "little body"), CORRECTED), "Little Buddy");
  assert.equal(alignCorrection(HEARD, ...at(HEARD, "body"), CORRECTED), "Buddy");
  // Edge spaces in the selection don't matter.
  const [start, end] = at(HEARD, " little body ");
  assert.equal(alignCorrection(HEARD, start, end, CORRECTED), "Little Buddy");
  // An insertion inside the selection is part of what replaces it.
  assert.equal(
    alignCorrection("open whisper repo", 0, 12, "open the whisper repo"),
    "open the whisper"
  );
  // A replaced run selected whole.
  assert.equal(alignCorrection("the quick brown fox", 4, 15, "the slow fox"), "slow");
});

test("no canonical form unless the alignment is a clean replacement", () => {
  // Only the case changed: the glossary can't write that.
  assert.equal(alignCorrection(HEARD, ...at(HEARD, "little"), CORRECTED), null);
  // Unchanged words.
  assert.equal(alignCorrection(HEARD, ...at(HEARD, "and keep"), CORRECTED), null);
  // A word cut in two.
  assert.equal(alignCorrection(HEARD, ...at(HEARD, "ittle bo"), CORRECTED), null);
  // Half of a replaced run.
  assert.equal(alignCorrection("the quick brown fox", 4, 9, "the slow fox"), null);
  // No correction, or nothing selected.
  assert.equal(alignCorrection(HEARD, ...at(HEARD, "body"), ""), null);
  assert.equal(alignCorrection(HEARD, 3, 3, CORRECTED), null);
});

test("an existing spelling is found in any case and spacing", () => {
  const rules = [
    {
      id: "r1",
      canonical: "Little Buddy",
      spellings: [{ text: "Little  Body", scope: "anywhere" }],
      apps: [],
      enabled: true,
      revision: 1,
    },
  ];
  assert.equal(glossaryRuleWithSpelling(rules, "little body")?.id, "r1");
  assert.equal(
    glossaryRuleWithSpelling(rules, "Little Buddy"),
    null,
    "the canonical isn't a spelling"
  );
  assert.equal(glossaryRuleWithSpelling(rules, "  "), null);
});

test("the rules that fired, once each, from the glossary steps that ran", () => {
  const fired = (rulesFired, outcome = "ok") =>
    step("glossary", "x", { outcome, detail: { revision: 1, rulesFired } });
  assert.deepEqual(
    firedGlossaryRules([
      step("stt", "x"),
      fired([
        { ruleId: "r1", from: "open whisper", to: "OpenWhispr", index: 0 },
        { ruleId: "r1", from: "open whisper", to: "OpenWhispr", index: 20 },
        { ruleId: null, from: "a", to: "b" },
      ]),
      fired([{ ruleId: "r2", from: "x", to: "y" }], "failed"),
    ]),
    [{ ruleId: "r1", from: "open whisper", to: "OpenWhispr" }]
  );
});

test("suggested checks: additions must be there, removals must not, as phrases", () => {
  assert.deepEqual(
    suggestTestChecks(
      "We're shipping on Friday if the tests pass, and we'll decide Monday.",
      "We're not shipping on Friday unless the tests pass. We'll decide Monday."
    ),
    {
      mustContain: ["not shipping", "unless the"],
      mustNotContain: ["if the", "and we'll"],
    }
  );
  // A single word takes its neighbor; case is kept as written on each side.
  assert.deepEqual(
    suggestTestChecks(
      "Move Voice Assistant to little body, and keep Translation on it too.",
      CORRECTED
    ),
    { mustContain: ["Little Buddy"], mustNotContain: ["little body"] }
  );
});

test("suggested checks are capped, deduplicated and never trivially true", () => {
  const output = "one a two b three c four d five e";
  const correction = "one A1 two B1 three C1 four D1 five E1";
  const capped = suggestTestChecks(output, correction);
  assert.equal(capped.mustContain.length, 3);
  assert.equal(capped.mustNotContain.length, 3);
  assert.deepEqual(suggestTestChecks(output, correction, { max: 1 }).mustContain, ["A1 two"]);

  // The same phrase added twice is suggested once.
  assert.deepEqual(suggestTestChecks("go home, go home", "go Rome, go Rome").mustContain, [
    "go Rome",
  ]);
  // A phrase the other text already has would always pass, so it's left out.
  assert.deepEqual(suggestTestChecks("red car and car", "red car and blue car").mustContain, [
    "blue car",
  ]);
  assert.deepEqual(suggestTestChecks("dog and big dog", "big dog and big dog").mustContain, []);

  // Punctuation-only and case-only changes suggest nothing; nor does no correction.
  assert.deepEqual(suggestTestChecks("Hello world", "Hello, world."), {
    mustContain: [],
    mustNotContain: [],
  });
  assert.deepEqual(suggestTestChecks("hello world", "Hello World"), {
    mustContain: [],
    mustNotContain: [],
  });
  assert.deepEqual(suggestTestChecks("hello", ""), { mustContain: [], mustNotContain: [] });
});
