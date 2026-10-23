const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");
const { createPromptTestCases } = require("../../src/helpers/promptTestCases.js");
const { createStepHistory, createStepRunRegistry } = require("../../src/helpers/stepHistory.js");

// Styles on SQLite: a style's test cases with their counts (an additive
// column, added to a database created before it existed), clearing one
// target only, and a styled dictation's steps and route kind. Synthetic text.

const ON = { synced: true, enabled: true, forcedOff: false, resolved: true };

function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  const cases = createPromptTestCases({
    db,
    getOwner: () => "account:a",
    getPolicy: () => ({ ...ON }),
  });
  return { db, cases };
}

test("a database from before styles gets the style_checks column on the next launch", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  // Recreate the Stage 2b table without the column, as an older build left it.
  ctx.db.db.exec("DROP TABLE prompt_test_cases");
  ctx.db.db.exec(`
    CREATE TABLE prompt_test_cases (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, target TEXT NOT NULL DEFAULT 'cleanup',
      label TEXT, raw_text TEXT NOT NULL, reference_text TEXT, target_app TEXT,
      must_contain TEXT NOT NULL DEFAULT '[]', must_not_contain TEXT NOT NULL DEFAULT '[]',
      match_case INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
      source_transcription_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  ctx.db.db
    .prepare(
      `INSERT INTO prompt_test_cases (id, owner, raw_text, source, created_at, updated_at)
       VALUES ('old', 'account:a', 'an old case', 'test', '2026-10-22', '2026-10-22')`
    )
    .run();

  const reopened = new DatabaseManager();
  try {
    const columns = reopened.db.prepare("PRAGMA table_info(prompt_test_cases)").all();
    assert.ok(columns.some((c) => c.name === "style_checks"));
    const [row] = reopened.getPromptTestCases("account:a");
    assert.equal(row.raw_text, "an old case", "existing cases are kept");
    assert.equal(row.style_checks, null);
  } finally {
    reopened.db.close();
  }
});

test("a style's case stores its target and counts; clearing it leaves the cleanup cases", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.cases.save({ rawText: "cleanup case" });
  const saved = ctx.cases.save({
    rawText: "status update the migration is done",
    target: "style:starter-requirements",
    mustNotContain: ["Must"],
    matchCase: true,
    styleChecks: { numberedMax: 0 },
  });
  assert.equal(saved.durable, true);

  const [listed] = ctx.cases.list().cases.filter((c) => c.target !== "cleanup");
  assert.equal(listed.target, "style:starter-requirements");
  assert.deepEqual(listed.styleChecks, {
    bulletsMin: null,
    bulletsMax: null,
    numberedMin: null,
    numberedMax: 0,
  });
  const updated = ctx.cases.update(listed.id, { styleChecks: { bulletsMin: 2 } });
  assert.equal(updated.case.styleChecks.bulletsMin, 2);
  assert.equal(updated.case.styleChecks.numberedMax, null);

  assert.deepEqual(ctx.cases.clear("style:starter-requirements"), { success: true, removed: 1 });
  assert.deepEqual(
    ctx.cases.list().cases.map((c) => c.rawText),
    ["cleanup case"]
  );
});

test("a styled dictation keeps its style route kind, style steps and context", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const history = createStepHistory({
    db: ctx.db,
    getOwner: () => "account:a",
    isEnabled: () => true,
    runs: createStepRunRegistry(),
  });
  const runId = history.beginRun();
  const { id } = history.saveTranscription(
    "Hey team 👋\n- Ring one is out.",
    "hey team ring one is out",
    {
      routeKind: "style:starter-teams",
      trace: {
        version: 1,
        runId,
        context: {
          targetApp: "ms-teams.exe",
          intents: {},
          style: { id: "starter-teams", runMode: "two-step" },
        },
        route: "style",
        steps: [
          { kind: "stt", outcome: "ok", output: "hey team ring one is out" },
          { kind: "cleanup", outcome: "ok", output: "Hey team, ring one is out." },
          {
            kind: "style",
            outcome: "ok",
            output: "Hey team 👋\n- Ring one is out.",
            provider: "copilot",
            model: "claude-haiku-5.5",
            prompt: { source: "resolved", text: "You restyle dictated text…" },
            detail: { styleId: "starter-teams", runMode: "two-step" },
          },
        ],
      },
    }
  );
  assert.equal(ctx.db.getTranscriptionById(id).route_kind, "style:starter-teams");
  const steps = history.getSteps(id);
  assert.equal(steps.route, "style");
  assert.deepEqual(steps.context.style, { id: "starter-teams", runMode: "two-step" });
  const style = steps.steps.find((s) => s.kind === "style");
  assert.deepEqual(style.detail, { styleId: "starter-teams", runMode: "two-step" });
  assert.equal(style.prompt.text, "You restyle dictated text…");

  // The export carries it too.
  const { lines } = history.buildExport("account:a");
  const dictation = lines.map((line) => JSON.parse(line)).find((l) => l.type === "dictation");
  assert.equal(dictation.routeKind, "style:starter-teams");
  assert.equal(dictation.steps.find((s) => s.kind === "style").detail.styleId, "starter-teams");
});
