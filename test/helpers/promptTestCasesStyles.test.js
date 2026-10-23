const test = require("node:test");
const assert = require("node:assert/strict");

const { createPromptTestCases, isValidTarget } = require("../../src/helpers/promptTestCases.js");

// Cases can target a style ("style:<id>"): saved from a style's Test, or
// pinned from a styled dictation in History, with bullet and numbered-item
// counts. Clearing one target leaves the others. A fake in-memory database
// stands in for DatabaseManager (promptTestCasesDatabase.test.js covers SQLite).

function fakeDb() {
  const rows = [];
  const transcriptions = new Map();
  return {
    rows,
    transcriptions,
    promptTestCasesReady: true,
    getPromptTestCases: (owner) => rows.filter((row) => row.owner === owner),
    getPromptTestCase: (owner, id) =>
      rows.find((row) => row.owner === owner && row.id === id) ?? null,
    findPromptTestCaseByText: (owner, target, rawText) =>
      rows.find(
        (row) => row.owner === owner && row.target === target && row.raw_text === rawText
      ) ?? null,
    countPromptTestCases: (owner) => rows.filter((row) => row.owner === owner).length,
    insertPromptTestCase(row) {
      rows.push({ ...row });
      return { ...row };
    },
    updatePromptTestCase(owner, id, fields) {
      const row = rows.find((r) => r.owner === owner && r.id === id);
      if (!row) return null;
      Object.assign(row, fields);
      return { ...row };
    },
    deletePromptTestCase: () => false,
    clearPromptTestCases(owner, target = null) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].owner === owner && (!target || rows[i].target === target)) rows.splice(i, 1);
      }
      return before - rows.length;
    },
    takePromptTestCases: () => [],
    getTranscriptionById: (id) => transcriptions.get(id) ?? null,
    getTranscriptionSteps: () => ({ status: "none" }),
  };
}

function setup() {
  const db = fakeDb();
  let ids = 0;
  const cases = createPromptTestCases({
    db,
    getOwner: () => "account:a",
    getPolicy: () => ({ synced: true, enabled: true, forcedOff: false, resolved: true }),
    now: () => new Date(Date.UTC(2026, 9, 23, 9, 0, ids)),
    randomId: () => `case-${++ids}`,
  });
  return { db, cases };
}

test("targets: cleanup or a style id; anything else is refused", () => {
  assert.equal(isValidTarget("cleanup"), true);
  assert.equal(isValidTarget("style:starter-teams"), true);
  assert.equal(isValidTarget("style:"), false);
  assert.equal(isValidTarget("style:bad id"), false);
  assert.equal(isValidTarget("translation"), false);

  const { cases } = setup();
  assert.equal(cases.save({ rawText: "x", target: "translation" }).code, "INVALID_INPUT");
});

test("a style's case keeps its target and its counts, and the same text can be both", () => {
  const { db, cases } = setup();
  const styleCase = cases.save({
    rawText: "status update the migration is done",
    target: "style:starter-requirements",
    styleChecks: { numberedMax: "0", bulletsMin: -1, numberedMin: 2.7, bulletsMax: "x" },
  });
  assert.equal(styleCase.success, true);
  assert.equal(styleCase.case.target, "style:starter-requirements");
  assert.deepEqual(styleCase.case.styleChecks, {
    bulletsMin: null,
    bulletsMax: null,
    numberedMin: 2,
    numberedMax: 0,
  });
  assert.equal(db.rows[0].style_checks, JSON.stringify(styleCase.case.styleChecks));

  // The same input as a cleanup case is a different case.
  const cleanup = cases.save({ rawText: "status update the migration is done" });
  assert.equal(cleanup.duplicate, false);
  assert.equal(cleanup.case.target, "cleanup");
  assert.equal(db.rows[1].style_checks, null, "no counts stored for a case without any");

  const updated = cases.update(styleCase.case.id, {
    styleChecks: { numberedMax: 1 },
    mustNotContain: ["Must"],
  });
  assert.deepEqual(updated.case.styleChecks, {
    bulletsMin: null,
    bulletsMax: null,
    numberedMin: null,
    numberedMax: 1,
  });
  assert.equal(updated.case.target, "style:starter-requirements", "the target never changes");
});

test("a styled dictation pinned from History becomes a case for its style", () => {
  const { db, cases } = setup();
  db.transcriptions.set(5, {
    id: 5,
    status: "completed",
    raw_text: "hey team quick update",
    text: "Hey team 👋\n- Quick update.",
    route_kind: "style:starter-teams",
  });
  db.transcriptions.set(6, {
    id: 6,
    status: "completed",
    raw_text: "hola",
    text: "Hello",
    route_kind: "translation",
  });
  assert.equal(cases.pinFromHistory(5).case.target, "style:starter-teams");
  assert.equal(cases.pinFromHistory(6).case.target, "cleanup");
});

test("clearing one target leaves the others", () => {
  const { cases } = setup();
  cases.save({ rawText: "a" });
  cases.save({ rawText: "b", target: "style:starter-teams" });
  cases.save({ rawText: "c", target: "style:starter-email" });

  assert.deepEqual(cases.clear("style:starter-teams"), { success: true, removed: 1 });
  assert.deepEqual(
    cases.list().cases.map((c) => c.target),
    ["cleanup", "style:starter-email"]
  );
  assert.equal(cases.clear("not a target").code, "INVALID_INPUT");
  assert.deepEqual(cases.clear(), { success: true, removed: 2 });
});
