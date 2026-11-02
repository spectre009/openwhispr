const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const { setUserDataDir, getUserDataDir } = require("./harness/electronStub.js");
const DatabaseManager = require("../../src/helpers/database.js");
const {
  createConnectionOutcomes,
  createDatabaseOutcomeStore,
} = require("../../src/helpers/connectionOutcomes.js");
const { countHistoryRecords } = require("../../src/helpers/storageInventory");

// "Last recorded use" in History's database (`connection_outcomes`): created
// idempotently beside the other local-only tables, one row per descriptor
// with its last outcome and last failure (codes and times only), kept across
// a restart, cleared by the recorder, and outside History: not counted,
// not touched by clearing History. Run under Electron's Node
// (ELECTRON_RUN_AS_NODE=1, REQUIRE_DB_TESTS=1); plain Node skips.

const outcome = (feature, ok, code, at) => ({ feature, ok, code, at });

test("the table is created once and holds each descriptor's row whole", (t) => {
  const db = createDb(t);
  if (!db) return;
  assert.equal(db.connectionOutcomesReady, true);
  // Idempotent: opening again (or a second init) changes nothing.
  db._initConnectionOutcomes();
  const columns = db.db
    .prepare("SELECT name FROM pragma_table_info('connection_outcomes')")
    .all()
    .map((row) => row.name);
  assert.deepEqual(columns, [
    "descriptor_id",
    "slot",
    "feature",
    "ok",
    "code",
    "at",
    "failure_feature",
    "failure_code",
    "failure_at",
  ]);

  db.saveConnectionOutcome({
    descriptorId: "provider:groq",
    slot: "GROQ_API_KEY",
    last: outcome("cleanup", true, "OK", 2000),
    lastFailure: outcome("styles", false, "PROVIDER_RATE_LIMITED", 1000),
  });
  db.saveConnectionOutcome({
    descriptorId: "cloud",
    slot: null,
    last: outcome("recognition", false, "PROVIDER_UNAVAILABLE", 3000),
    lastFailure: outcome("recognition", false, "PROVIDER_UNAVAILABLE", 3000),
  });
  assert.deepEqual(db.getConnectionOutcomes(), [
    {
      descriptorId: "cloud",
      slot: null,
      last: outcome("recognition", false, "PROVIDER_UNAVAILABLE", 3000),
      lastFailure: outcome("recognition", false, "PROVIDER_UNAVAILABLE", 3000),
    },
    {
      descriptorId: "provider:groq",
      slot: "GROQ_API_KEY",
      last: outcome("cleanup", true, "OK", 2000),
      lastFailure: outcome("styles", false, "PROVIDER_RATE_LIMITED", 1000),
    },
  ]);
  // Replaced whole; no failure yet reads as null.
  db.saveConnectionOutcome({
    descriptorId: "provider:groq",
    slot: "GROQ_API_KEY",
    last: outcome("chat", true, "OK", 4000),
  });
  const groq = db.getConnectionOutcomes().find((row) => row.descriptorId === "provider:groq");
  assert.deepEqual(groq.lastFailure, null);
  assert.equal(groq.last.feature, "chat");

  assert.equal(db.deleteConnectionOutcomes(["provider:groq", "nope"]), 1);
  assert.equal(db.deleteConnectionOutcomes([]), 0);
  assert.deepEqual(
    db.getConnectionOutcomes().map((row) => row.descriptorId),
    ["cloud"]
  );
  assert.equal(db.clearConnectionOutcomes(), 1);
  assert.deepEqual(db.getConnectionOutcomes(), []);
});

test("kept across a restart; outside History's counts and its Clear", (t) => {
  const db = createDb(t);
  if (!db) return;
  const recorder = createConnectionOutcomes({ store: createDatabaseOutcomeStore(() => db) });
  assert.equal(
    recorder.recordConnectionOutcome({
      descriptorId: "provider:azure-speech",
      feature: "recognition",
      ok: false,
      code: "PROVIDER_AUTH_FAILED",
      startedAt: Date.now(),
    }),
    true
  );
  recorder.recordConnectionOutcome({
    descriptorId: "endpoint:0a1b2c3d",
    slot: "CUSTOM_CLEANUP_API_KEY",
    feature: "cleanup",
    ok: true,
    startedAt: Date.now(),
  });

  // History's counts don't include it, and clearing History leaves it.
  const counts = countHistoryRecords(db.db);
  assert.ok(counts && !Object.keys(counts).some((key) => /outcome|connection/i.test(key)));
  db.clearTranscriptions();
  assert.equal(db.getConnectionOutcomes().length, 2);

  // A restart: a new manager over the same file reads what was kept.
  const dir = getUserDataDir();
  db.db.close();
  setUserDataDir(dir);
  const reopened = new DatabaseManager();
  try {
    const after = createConnectionOutcomes({ store: createDatabaseOutcomeStore(() => reopened) });
    const listed = after.list();
    assert.equal(listed["provider:azure-speech"].last.code, "PROVIDER_AUTH_FAILED");
    assert.equal(listed["provider:azure-speech"].lastFailure.feature, "recognition");
    assert.equal(listed["endpoint:0a1b2c3d"].last.ok, true);

    // A key change clears its rows in the file too; Reset app data, all.
    after.noteSecretsChanged({ names: ["CUSTOM_REASONING_API_KEY"] });
    assert.deepEqual(
      reopened.getConnectionOutcomes().map((row) => row.descriptorId),
      ["provider:azure-speech"]
    );
    after.noteSecretsChanged({ names: [], all: true });
    assert.deepEqual(reopened.getConnectionOutcomes(), []);
    assert.equal(
      JSON.stringify(reopened.db.prepare("SELECT * FROM connection_outcomes").all()),
      "[]"
    );
  } finally {
    // Before the harness removes the folder (Windows keeps an open file).
    reopened.db?.close();
  }
});

test("a closed database never costs a request", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db.close();
  const recorder = createConnectionOutcomes({ store: createDatabaseOutcomeStore(() => db) });
  assert.equal(
    recorder.recordConnectionOutcome({
      descriptorId: "copilot",
      feature: "translation",
      ok: true,
      startedAt: Date.now(),
    }),
    true,
    "kept for the session"
  );
  assert.ok(recorder.list().copilot);
  assert.doesNotThrow(() => recorder.noteSecretsChanged({ names: [], all: true }));
});
