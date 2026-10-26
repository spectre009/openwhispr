const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// The History database section's counts and the recording pace
// (storageInventory.js countHistoryRecords / readRecordingPace) against the
// app's real schema. better-sqlite3 is built for Electron: run under
// Electron's Node (ELECTRON_RUN_AS_NODE=1); plain Node skips.

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-storage-db-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const DatabaseManager = require("../../src/helpers/database.js");
const { countHistoryRecords, readRecordingPace } = require("../../src/helpers/storageInventory");

const DAY = 86400000;
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-storage-db-"));
  try {
    const manager = new DatabaseManager();
    t.after(() => {
      try {
        manager.db?.close();
      } catch {}
      fs.rmSync(userDataDir, { recursive: true, force: true });
    });
    return manager;
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("NODE_MODULE_VERSION") || message.includes("bindings file")) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

// Fills the NOT NULL columns without a default, so the rows fit today's schema.
function insertRow(db, table, values) {
  const row = { ...values };
  const columns = db
    .prepare(
      `SELECT name, type, "notnull" AS required, dflt_value AS fallback, pk FROM pragma_table_info(?)`
    )
    .all(table);
  for (const column of columns) {
    if (column.name in row || column.pk || !column.required || column.fallback !== null) continue;
    row[column.name] = /INT|REAL/i.test(column.type)
      ? 1
      : `${table}-${column.name}-${Math.random()}`;
  }
  const names = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")})
       VALUES (${names.map(() => "?").join(", ")})`
    )
    .run(...names.map((name) => row[name])).lastInsertRowid;
}

test("one query counts what the History database holds, deleted rows left out", (t) => {
  const manager = createDb(t);
  if (!manager) return;
  const db = manager.db;
  const before = countHistoryRecords(db);
  assert.deepEqual(Object.keys(before), [
    "dictations",
    "stepRecords",
    "reviews",
    "testCases",
    "dictionaryWords",
    "glossaryRules",
    "notes",
  ]);

  const first = insertRow(db, "transcriptions", { text: "one" });
  const second = insertRow(db, "transcriptions", { text: "two" });
  insertRow(db, "transcriptions", { text: "gone", deleted_at: sqlTime(Date.now()) });
  insertRow(db, "transcription_steps", { transcription_id: first, seq: 0 });
  insertRow(db, "transcription_steps", { transcription_id: first, seq: 1 });
  insertRow(db, "transcription_steps", { transcription_id: second, seq: 0 });
  insertRow(db, "dictation_feedback", { transcription_id: first, verdict: "bad" });
  insertRow(db, "prompt_test_cases", { id: "case-1" });
  insertRow(db, "custom_dictionary", { word: "OpenWhispr-test-word" });
  insertRow(db, "custom_dictionary", { word: "deleted-word", deleted_at: sqlTime(Date.now()) });
  insertRow(db, "glossary_rules", { id: "rule-test", canonical: "Kubernetes" });
  insertRow(db, "notes", { title: "A" });

  const after = countHistoryRecords(db);
  const delta = Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key] - before[key]])
  );
  assert.deepEqual(delta, {
    dictations: 2,
    stepRecords: 3,
    reviews: 1,
    testCases: 1,
    dictionaryWords: 1,
    glossaryRules: 1,
    notes: 1,
  });
});

test("a table that doesn't exist counts as none; a closed database gives no counts", (t) => {
  const manager = createDb(t);
  if (!manager) return;
  manager.db.exec("DROP TABLE IF EXISTS prompt_test_cases");
  const counts = countHistoryRecords(manager.db);
  assert.equal(counts.testCases, 0);
  assert.equal(countHistoryRecords(null), null);
  manager.db.close();
  assert.equal(countHistoryRecords(manager.db), null);
});

test("the pace: dictations a day over the last 30 days of history times their length", (t) => {
  const manager = createDb(t);
  if (!manager) return;
  const db = manager.db;
  const now = Date.UTC(2026, 9, 25, 12, 0, 0);
  assert.equal(readRecordingPace(db, { now }), null, "no history yet");

  const at = (daysAgo, durationMs = null, extra = {}) =>
    insertRow(db, "transcriptions", {
      text: "x",
      created_at: sqlTime(now - daysAgo * DAY),
      audio_duration_ms: durationMs,
      ...extra,
    });
  at(10, 60000);
  at(5, 60000);
  at(3);
  at(2);
  at(1);
  at(40, 600000, {}); // outside the window
  at(4, 600000, { deleted_at: sqlTime(now) }); // deleted

  assert.deepEqual(readRecordingPace(db, { now }), {
    windowDays: 30,
    spanDays: 10,
    dictations: 5,
    perDay: 0.5,
    averageSeconds: 60,
    minutesPerDay: 0.5,
  });

  // Without any recorded length there's a pace but no minutes.
  db.exec("UPDATE transcriptions SET audio_duration_ms = NULL");
  const noLengths = readRecordingPace(db, { now });
  assert.equal(noLengths.dictations, 5);
  assert.equal(noLengths.minutesPerDay, null);
  assert.equal(readRecordingPace(null, { now }), null);
});
