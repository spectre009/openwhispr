const test = require("node:test");
const assert = require("node:assert/strict");

// Style checks in the test set: bullet lines and numbered items, at least /
// at most, alongside the literal checks. And the style starters: the
// Requirements style ships the fidelity cases.

const loadChecks = () => import("../../src/utils/promptTestChecks.ts");
const loadStarters = () => import("../../src/config/promptTestStarters.ts");

const REQUIREMENTS = `Summary: export work.

1. Must support JSON export.
2) Should run in the background.

Context:
- CSV export is already supported.
• Excel is out of scope.`;

test("bullet lines and numbered items are counted per line", async () => {
  const { countBulletLines, countNumberedItems } = await loadChecks();
  assert.equal(countBulletLines(REQUIREMENTS), 2);
  assert.equal(countNumberedItems(REQUIREMENTS), 2);
  assert.equal(countBulletLines("A sentence - with a dash."), 0);
  assert.equal(countNumberedItems("We shipped 2. Then 3."), 0, "a number mid-line is not an item");
  assert.equal(countBulletLines("* one\n  - two\n-not a bullet"), 2);
});

test("the counts pass and fail as at least / at most", async () => {
  const { checkOutput } = await loadChecks();
  const checks = {
    mustContain: ["JSON"],
    mustNotContain: [],
    matchCase: false,
    styleChecks: { bulletsMin: 1, bulletsMax: 3, numberedMin: null, numberedMax: 1 },
  };
  const result = checkOutput(checks, "we need json", REQUIREMENTS);
  assert.deepEqual(result.structure, [
    { kind: "bulletsMin", limit: 1, actual: 2, ok: true },
    { kind: "bulletsMax", limit: 3, actual: 2, ok: true },
    { kind: "numberedMax", limit: 1, actual: 2, ok: false },
  ]);
  assert.equal(result.passed, false, "a failed count fails the case");

  const ok = checkOutput({ ...checks, styleChecks: { numberedMax: 2 } }, "x", REQUIREMENTS);
  assert.equal(ok.passed, true);
});

test("a cleanup case has no counts, and its checks keep their shape", async () => {
  const { checkOutput, repeatedTranscriptChecks } = await loadChecks();
  const plain = { mustContain: [], mustNotContain: [], matchCase: false };
  assert.equal("structure" in checkOutput(plain, "a", "A."), false);
  const repeated = repeatedTranscriptChecks({ ...plain, styleChecks: { bulletsMin: 2 } });
  assert.deepEqual(repeated.structure, [{ kind: "bulletsMin", limit: 2, actual: null, ok: null }]);
  assert.equal(repeated.passed, false);
});

test("the Requirements style ships the fidelity cases as starters", async () => {
  const { styleStarterCases, STYLE_STARTER_TEST_CASES, STARTER_TEST_CASES } = await loadStarters();
  const requirements = styleStarterCases("starter-requirements");
  const ids = requirements.map((c) => c.id);
  for (const id of [
    "starter:requirements:status",
    "starter:requirements:negation",
    "starter:requirements:dates",
    "starter:requirements:commitments",
    "starter:requirements:quoted",
    "starter:requirements:closing-tag",
  ]) {
    assert.ok(ids.includes(id), `${id} ships`);
  }
  const closing = requirements.find((c) => c.id === "starter:requirements:closing-tag");
  assert.ok(closing.rawText.includes("</text>"));
  assert.ok(closing.mustContain.includes("</text>"));
  const status = requirements.find((c) => c.id === "starter:requirements:status");
  assert.equal(status.styleChecks.numberedMax, 0, "a status update becomes no requirements");
  assert.deepEqual(status.mustNotContain, ["Must"]);
  assert.equal(status.matchCase, true);

  // The unmeasured Email wording gets cases of its own; a user style has none.
  assert.ok(styleStarterCases("starter-email").length >= 3);
  assert.deepEqual(styleStarterCases("my-style"), []);

  const all = [...STARTER_TEST_CASES, ...Object.values(STYLE_STARTER_TEST_CASES).flat()];
  assert.equal(new Set(all.map((c) => c.id)).size, all.length, "starter ids are unique");
});
