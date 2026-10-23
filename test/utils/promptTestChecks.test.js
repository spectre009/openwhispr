const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkOutput,
  containsLiteral,
  findFillers,
  isRepeatedTranscript,
  repeatedTranscriptChecks,
} = require("../../src/utils/promptTestChecks.ts");
const { diffWords } = require("../../src/utils/wordDiff.ts");

// The test set's checks: the repetition validator a dictation runs, literal
// must/must-not contain (case-insensitive unless asked), and filler words
// flagged as advice only.

const NO_CHECKS = { mustContain: [], mustNotContain: [], matchCase: false };

test("fillers are whole words, flagged once each, in any case", () => {
  assert.deepEqual(findFillers("Um, so I think, uh, we go. UM. Hmm."), ["um", "uh", "hmm"]);
  assert.deepEqual(findFillers("The umbrella is in the hmmm drawer"), []);
  assert.deepEqual(findFillers("I said “ee” on purpose"), ["ee"]);
  assert.deepEqual(findFillers("Erm… ahh, eh?"), ["erm", "ahh", "eh"]);
  assert.deepEqual(findFillers(""), []);
});

test("fillers never fail a case: German 'um', a quoted filler and a meaningful 'eh' pass", () => {
  for (const output of [
    "Wir treffen uns um 10 Uhr.",
    "Write “ee” in the subject line.",
    "Canada is great, eh?",
  ]) {
    const checks = checkOutput(NO_CHECKS, "input words", output);
    assert.equal(checks.passed, true, output);
    assert.ok(checks.fillers.length > 0, `${output} is still flagged`);
  }
});

test("literal checks: case-insensitive by default, exact with match case", () => {
  assert.equal(containsLiteral("Hello, Little Buddy.", "little buddy", false), true);
  assert.equal(containsLiteral("Hello, Little Buddy.", "little buddy", true), false);
  assert.equal(containsLiteral("Hello, Little Buddy.", "Little Buddy", true), true);
  assert.equal(containsLiteral("anything", "", true), true);

  const correction = checkOutput(
    { mustContain: ["Friday"], mustNotContain: ["Thursday"], matchCase: false },
    "send it by thursday no wait friday",
    "Send it by Friday."
  );
  assert.equal(correction.passed, true);
  assert.deepEqual(correction.mustContain, [{ text: "Friday", ok: true }]);
  assert.deepEqual(correction.mustNotContain, [{ text: "Thursday", ok: true }]);

  const answered = checkOutput(
    { mustContain: [], mustNotContain: ["Paris"], matchCase: false },
    "what is the capital of France",
    "The capital of France is Paris."
  );
  assert.equal(answered.passed, false, "a model answering the dictated question is caught");
  assert.deepEqual(answered.mustNotContain, [{ text: "Paris", ok: false }]);

  const caseSensitive = checkOutput(
    { mustContain: ["Little Buddy"], mustNotContain: [], matchCase: true },
    "hello Little Buddy",
    "Hello, little buddy."
  );
  assert.equal(caseSensitive.passed, false);
});

test("a repeated transcript fails its check; an empty reply is never a check", () => {
  const input = "please send the quarterly report to the whole finance team today";
  const clean = "Please send the quarterly report to the whole finance team today.";
  assert.equal(isRepeatedTranscript(input, clean), false);
  assert.equal(isRepeatedTranscript(input, `${clean}\n\n${clean}`), true);

  const repeated = checkOutput(NO_CHECKS, input, `${clean}\n\n${clean}`);
  assert.equal(repeated.notDuplicated, false);
  assert.equal(repeated.passed, false);

  const rejected = repeatedTranscriptChecks({
    mustContain: ["Friday"],
    mustNotContain: ["Paris"],
    matchCase: false,
  });
  assert.equal(rejected.passed, false);
  assert.deepEqual(rejected.mustContain, [{ text: "Friday", ok: null }], "not checked");
  assert.deepEqual(rejected.fillers, []);
});

test("word differences mark only the words that changed, keeping each text as written", () => {
  const { a, b } = diffWords("Send it by Thursday.", "Send it by Friday.");
  assert.equal(a.map((s) => s.text).join(""), "Send it by Thursday.");
  assert.equal(b.map((s) => s.text).join(""), "Send it by Friday.");
  assert.deepEqual(
    a.filter((s) => s.kind !== "same").map((s) => s.text),
    ["Thursday."]
  );
  assert.deepEqual(
    b.filter((s) => s.kind !== "same").map((s) => [s.kind, s.text]),
    [["added", "Friday."]]
  );

  const same = diffWords("No change here.", "No change here.");
  assert.deepEqual(same.a, [{ text: "No change here.", kind: "same" }]);

  const inserted = diffWords("Hello team", "Hello, dear team");
  assert.deepEqual(
    inserted.b.filter((s) => s.kind === "added").map((s) => s.text),
    ["Hello, dear"]
  );
  assert.deepEqual(
    inserted.a.filter((s) => s.kind === "removed").map((s) => s.text),
    ["Hello"]
  );
});
