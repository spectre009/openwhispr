const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const { getUserDataDir } = require("./harness/electronStub.js");
const DatabaseManager = require("../../src/helpers/database.js");
const { createPromptTestCases } = require("../../src/helpers/promptTestCases.js");
const { createStepHistory, createStepRunRegistry } = require("../../src/helpers/stepHistory.js");

// The test set's cases on SQLite: the prompt_test_cases table in the history
// database, scoped to an owner, copied rather than referenced, removed by
// account deletion (that account's only, the device keeps everything else)
// and by Reset app data (the database file goes). Synthetic text only.

const ON = { synced: true, enabled: true, forcedOff: false, resolved: true };

function setup(t, { owner = "account:a" } = {}) {
  const db = createDb(t);
  if (!db) return null;
  const state = { owner, policy: { ...ON } };
  const cases = createPromptTestCases({
    db,
    getOwner: () => state.owner,
    getPolicy: () => state.policy,
  });
  const dictate = (raw, text = "Cleaned.") => db.saveTranscription(text, raw).id;
  const rows = () =>
    db.db.prepare("SELECT owner, raw_text FROM prompt_test_cases ORDER BY owner, raw_text").all();
  return { db, state, cases, dictate, rows };
}

test("the table is created with the history database and survives a second launch", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  assert.equal(ctx.db.promptTestCasesReady, true);
  ctx.cases.save({ rawText: "hello littlebuddy", mustContain: ["Little Buddy"], matchCase: true });

  const reopened = new DatabaseManager();
  try {
    assert.equal(reopened.promptTestCasesReady, true);
    const [row] = reopened.getPromptTestCases("account:a");
    assert.equal(row.raw_text, "hello littlebuddy");
    assert.equal(row.must_contain, JSON.stringify(["Little Buddy"]));
    assert.equal(row.match_case, 1);
    assert.equal(row.target, "cleanup");
  } finally {
    reopened.db.close();
  }
});

test("a pinned dictation is a copy: it outlives deleting the history row", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate("um please send it by friday", "Please send it by Friday.");
  const pinned = ctx.cases.pinFromHistory(id);
  assert.equal(pinned.success, true);
  assert.equal(pinned.durable, true);

  ctx.db.deleteTranscription(id);
  assert.equal(ctx.db.getTranscriptionById(id), null);
  const [kept] = ctx.cases.list().cases;
  assert.equal(kept.rawText, "um please send it by friday");
  assert.equal(kept.referenceText, "Please send it by Friday.");
  assert.equal(kept.sourceTranscriptionId, id, "kept only to open it in History");
});

test("a row without a raw transcript is refused; the cleaned text is never the input", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate(null, "Only the cleaned text.");
  assert.deepEqual(ctx.cases.pinFromHistory(id), { success: false, code: "NO_RAW_TEXT" });
  const failed = ctx.db.saveTranscription("", "raw", { status: "failed" }).id;
  assert.deepEqual(ctx.cases.pinFromHistory(failed), { success: false, code: "NOT_PINNABLE" });
  assert.deepEqual(ctx.rows(), []);
});

test("the target app comes from this owner's captured steps only", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const history = createStepHistory({
    db: ctx.db,
    getOwner: () => ctx.state.owner,
    isEnabled: () => true,
    runs: createStepRunRegistry(),
  });
  const runId = history.beginRun();
  const { id } = history.saveTranscription("Hello, Little Buddy.", "hello everybody", {
    trace: {
      version: 1,
      runId,
      context: { targetApp: "Code.exe", intents: {} },
      route: "cleanup",
      steps: [{ kind: "stt", outcome: "ok", output: "hello everybody" }],
    },
  });
  assert.equal(ctx.cases.pinFromHistory(id).case.targetApp, "Code.exe");

  ctx.state.owner = "account:b";
  assert.equal(ctx.cases.pinFromHistory(id).case.targetApp, null, "another owner's steps");
});

test("account deletion removes that account's cases only, and erases nothing else", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const dictation = ctx.dictate("a dictation that stays on the device");
  ctx.cases.pinFromHistory(dictation);
  ctx.cases.save({ rawText: "a's typed case" });
  ctx.state.owner = "account:b";
  ctx.cases.save({ rawText: "b's case" });
  ctx.state.owner = "signed-out";
  ctx.cases.save({ rawText: "signed-out case" });

  ctx.db.setActiveAccountId("a");
  ctx.db.deleteAccountData("a");

  assert.deepEqual(ctx.rows(), [
    { owner: "account:b", raw_text: "b's case" },
    { owner: "signed-out", raw_text: "signed-out case" },
  ]);
  assert.ok(ctx.db.getTranscriptionById(dictation), "history rows are device-wide and stay");

  // Signing in as a fresh account adopts nothing.
  ctx.state.owner = "account:a";
  assert.deepEqual(ctx.cases.list().cases, []);
});

test("an organization's always_off takes the owner's cases off the disk", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.cases.save({ rawText: "first" });
  ctx.state.owner = "signed-out";
  ctx.cases.save({ rawText: "someone else's" });
  ctx.state.owner = "account:a";

  ctx.state.policy = { ...ON, enabled: false, forcedOff: true };
  assert.equal(ctx.cases.policyChanged(), 1);
  assert.deepEqual(ctx.rows(), [{ owner: "signed-out", raw_text: "someone else's" }]);
  assert.deepEqual(
    ctx.cases.list().cases.map((c) => [c.rawText, c.durable]),
    [["first", false]]
  );
});

test("Reset app data removes the cases with the database file", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.cases.save({ rawText: "a private dictation" });
  // cleanup-app closes the database and deletes this file and its WAL files.
  const dbPath = path.join(getUserDataDir(), "transcriptions.db");
  assert.equal(path.resolve(ctx.db.db.name), path.resolve(dbPath), "the cases live in this file");
  ctx.db.db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  ctx.cases.clearSession();

  const fresh = new DatabaseManager();
  try {
    assert.deepEqual(fresh.getPromptTestCases("account:a"), []);
  } finally {
    fresh.db.close();
  }
});

test("cases are never part of the dictation export", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.cases.save({ rawText: "a case that must not be exported" });
  const history = createStepHistory({
    db: ctx.db,
    getOwner: () => "account:a",
    isEnabled: () => true,
    runs: createStepRunRegistry(),
  });
  const { lines } = history.buildExport("account:a");
  assert.equal(
    lines.some((line) => line.includes("must not be exported")),
    false
  );
});
