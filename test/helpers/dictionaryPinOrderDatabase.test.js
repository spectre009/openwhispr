const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");

// Pin order (Dictionary v2, Stage B) against a real database: the position
// column's migration on a pins table from before it (backfilled by pin date,
// then key, after any positions already there; idempotent across reopens), a
// new pin going last, the reorder's validation against the current pins, and
// every pin mover keeping the place: a rename, a merge (both pinned: the
// higher place wins), a cloud rename and delete, Tidy up and its Undo
// putting a pin back where it was. Synthetic words only.

function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  const add = (...words) => db.applyDictionaryChanges({ add: words });
  const pin = (...words) => {
    for (const word of words) assert.equal(db.setDictionaryPin(word, true).success, true, word);
  };
  const positions = () =>
    db.db
      .prepare("SELECT word_key, position FROM dictionary_pins ORDER BY position, word_key")
      .all()
      .map((row) => [row.word_key, row.position]);
  // Opens the same file again, as a relaunch does. Each is closed before the
  // harness removes the folder (`closeReopened`, in the test's finally).
  const reopened = [];
  const reopen = () => {
    const manager = new DatabaseManager();
    reopened.push(manager);
    return manager;
  };
  const closeReopened = () => {
    for (const manager of reopened.splice(0)) {
      try {
        manager.db.close();
      } catch {
        // already closed
      }
    }
  };
  return { db, add, pin, positions, reopen, closeReopened };
}

test("migration: an old pins table gets positions by pin date, then key; reopening changes nothing", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, reopen, closeReopened } = ctx;
  // Stored order Alpha, Beta, Gamma, Delta: what the old hint list followed.
  add("Alpha", "Beta", "Gamma", "Delta");
  db.db.exec(`
    DROP TABLE dictionary_pins;
    CREATE TABLE dictionary_pins (word_key TEXT PRIMARY KEY, pinned_at TEXT NOT NULL);
    INSERT INTO dictionary_pins (word_key, pinned_at) VALUES
      ('alpha', '2026-10-02T10:00:00.000Z'),
      ('beta', '2026-10-01T09:00:00.000Z'),
      ('gamma', '2026-10-02T10:00:00.000Z'),
      ('delta', '2026-09-30T08:00:00.000Z');
  `);
  const placesIn = (manager) =>
    manager.db
      .prepare("SELECT word_key, position FROM dictionary_pins ORDER BY position")
      .all()
      .map((row) => [row.word_key, row.position]);

  try {
    const first = reopen();
    assert.equal(first.dictionaryStateReady, true);
    const columns = first.db.prepare("PRAGMA table_info(dictionary_pins)").all();
    assert.ok(columns.some((column) => column.name === "position"), "the column is added");
    // By pin date; alpha and gamma tie on it, so by key. Not stored order.
    assert.deepEqual(first.getDictionaryPins(), ["delta", "beta", "alpha", "gamma"]);
    assert.deepEqual(placesIn(first), [
      ["delta", 0],
      ["beta", 1],
      ["alpha", 2],
      ["gamma", 3],
    ]);

    // Idempotent: another relaunch finds nothing to fill and moves nothing.
    first.reorderDictionaryPins(["gamma", "alpha", "beta", "delta"]);
    const second = reopen();
    assert.deepEqual(second.getDictionaryPins(), ["gamma", "alpha", "beta", "delta"]);
    assert.deepEqual(placesIn(second), [
      ["gamma", 0],
      ["alpha", 1],
      ["beta", 2],
      ["delta", 3],
    ]);
  } finally {
    closeReopened();
  }
});

test("migration: rows without a place go after the places already there", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, reopen, closeReopened } = ctx;
  add("One", "Two", "Three", "Four");
  db.db.exec(`
    DELETE FROM dictionary_pins;
    INSERT INTO dictionary_pins (word_key, pinned_at, position) VALUES
      ('two', '2026-10-05T00:00:00.000Z', 4),
      ('one', '2026-10-01T00:00:00.000Z', NULL),
      ('four', '2026-10-03T00:00:00.000Z', 1),
      ('three', '2026-10-02T00:00:00.000Z', NULL);
  `);
  try {
    const reopened = reopen();
    assert.deepEqual(reopened.getDictionaryPins(), ["four", "two", "one", "three"]);
    const place = (key) =>
      reopened.db.prepare("SELECT position FROM dictionary_pins WHERE word_key = ?").get(key)
        .position;
    assert.deepEqual(
      [place("one"), place("three")],
      [5, 6],
      "after the highest existing place (4), by pin date"
    );
  } finally {
    closeReopened();
  }
});

test("a new pin goes last; unpinning leaves a gap reads ignore", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, pin, positions } = ctx;
  add("Kusto", "Aria", "SuperApp", "EngHub");
  pin("SuperApp", "Kusto", "Aria");
  assert.deepEqual(db.getDictionaryPins(), ["superapp", "kusto", "aria"], "in the order pinned");
  db.setDictionaryPin("Kusto", false);
  pin("EngHub");
  assert.deepEqual(positions(), [
    ["superapp", 0],
    ["aria", 2],
    ["enghub", 3],
  ]);
  assert.deepEqual(db.getDictionaryPins(), ["superapp", "aria", "enghub"]);
  // Pinning again what's pinned changes nothing.
  assert.equal(db.setDictionaryPin("superapp", true).changed, false);
  assert.deepEqual(db.getDictionaryPins(), ["superapp", "aria", "enghub"]);
});

test("reorder: exactly the current pins in one transaction, anything else refused unchanged", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, pin, positions } = ctx;
  add("Kusto", "Aria", "SuperApp", "EngHub", "Loose");
  pin("Kusto", "Aria", "SuperApp");
  db.setDictionaryPin("Aria", false);
  pin("Aria", "EngHub");
  const before = db.getDictionaryPins();
  assert.deepEqual(before, ["kusto", "superapp", "aria", "enghub"]);

  const reordered = db.reorderDictionaryPins(["EngHub", " kusto ", "Aria", "superapp"]);
  assert.equal(reordered.success, true);
  assert.equal(reordered.changed, true);
  assert.deepEqual(reordered.pins, ["enghub", "kusto", "aria", "superapp"]);
  assert.deepEqual(positions(), [
    ["enghub", 0],
    ["kusto", 1],
    ["aria", 2],
    ["superapp", 3],
  ]);
  assert.equal(
    db.reorderDictionaryPins(["enghub", "kusto", "aria", "superapp"]).changed,
    false,
    "the same order changes nothing"
  );

  const current = db.getDictionaryPins();
  for (const [why, keys] of [
    ["one missing", ["enghub", "kusto", "aria"]],
    ["a duplicate", ["enghub", "kusto", "aria", "aria"]],
    ["an unknown key", ["enghub", "kusto", "aria", "loose"]],
    ["more than the pins", ["enghub", "kusto", "aria", "superapp", "loose"]],
    ["not a list", "enghub"],
    ["a non-string", ["enghub", "kusto", "aria", 4]],
  ]) {
    const refused = db.reorderDictionaryPins(keys);
    assert.deepEqual(
      [refused.success, refused.code, refused.pins],
      [false, "MISMATCH", current],
      why
    );
    assert.deepEqual(db.getDictionaryPins(), current, `${why}: nothing changed`);
  }
});

test("a rename keeps the pin's place; a merge keeps a pin, both pinned: the higher place wins", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, pin } = ctx;
  add("Alpha", "Bravo", "Charlie", "Delta", "Echo");
  pin("Alpha", "Bravo", "Charlie", "Delta");

  assert.equal(db.renameDictionaryWord("Bravo", "Bravissimo").success, true);
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "bravissimo", "charlie", "delta"]);

  // Both pinned: Delta (4th) into Bravissimo (2nd) keeps the 2nd place...
  assert.equal(db.mergeDictionaryWords("Delta", "Bravissimo").success, true);
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "bravissimo", "charlie"]);
  // ...and Alpha (1st) into Charlie (3rd) moves Charlie up to the 1st.
  assert.equal(db.mergeDictionaryWords("Alpha", "Charlie").success, true);
  assert.deepEqual(db.getDictionaryPins(), ["charlie", "bravissimo"]);

  // Only `from` pinned: `into` takes its place.
  pin("Echo");
  db.reorderDictionaryPins(["charlie", "echo", "bravissimo"]);
  add("Foxtrot");
  db.setDictionaryPin("Echo", false);
  pin("Echo");
  assert.deepEqual(db.getDictionaryPins(), ["charlie", "bravissimo", "echo"]);
  assert.equal(db.mergeDictionaryWords("Charlie", "Foxtrot").success, true);
  assert.deepEqual(db.getDictionaryPins(), ["foxtrot", "bravissimo", "echo"]);
});

test("cloud pulls: a rename keeps the place (the higher one when the key is pinned twice); a delete drops it", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, pin } = ctx;
  add("Kusto", "Aria", "SuperApp");
  pin("Kusto", "Aria", "SuperApp");
  const aria = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Aria'").get();
  // Pushed first: a pull never rewrites a row still pending its push (upstream #2879).
  db.markDictionaryEntrySynced(aria.id, "cloud-aria");
  db.upsertDictionaryFromCloud({
    id: "cloud-aria",
    client_dict_id: aria.client_dict_id,
    word: "AriaEvent",
    source: "manual",
    updated_at: "2099-01-01T00:00:00.000Z",
  });
  assert.deepEqual(db.getDictionaryPins(), ["kusto", "ariaevent", "superapp"]);

  // A rename onto a key that's pinned already: the higher place stays.
  const place = (key) =>
    db.db.prepare("SELECT position FROM dictionary_pins WHERE word_key = ?").get(key)?.position;
  db.db
    .prepare(
      "INSERT INTO dictionary_pins (word_key, pinned_at, position) VALUES ('legacy', 'x', 7)"
    )
    .run();
  db._moveDictionaryPin("legacy", "Kusto");
  assert.equal(place("kusto"), 0, "Kusto's own place is higher");
  assert.equal(place("legacy"), undefined);
  db.db.prepare("UPDATE dictionary_pins SET position = 9 WHERE word_key = 'superapp'").run();
  db.db
    .prepare(
      "INSERT INTO dictionary_pins (word_key, pinned_at, position) VALUES ('older', 'x', 4)"
    )
    .run();
  db._moveDictionaryPin("older", "SuperApp");
  assert.equal(place("superapp"), 4, "the moved pin's place is higher");
  assert.deepEqual(db.getDictionaryPins(), ["kusto", "ariaevent", "superapp"]);

  const superApp = db.db.prepare("SELECT id FROM custom_dictionary WHERE word = 'SuperApp'").get();
  db.hardDeleteDictionaryEntry(superApp.id);
  assert.deepEqual(db.getDictionaryPins(), ["kusto", "ariaevent"]);
});

test("Tidy up: Undo puts each pin back at its place, even after the pins were reordered", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, pin, positions } = ctx;
  add("Alpha", "Bravo", "Charlie", "Delta", "Echo");
  pin("Alpha", "Bravo", "Charlie", "Delta");

  // Remove the 2nd and 3rd; the rest keep their places, with gaps.
  const removed = db.applyDictionaryTidy([{ kind: "remove", words: ["Bravo", "Charlie"] }]);
  const steps = removed.results[0].undo;
  assert.deepEqual(
    steps[0].restore.map((entry) => [entry.word, entry.pinned, entry.pinPosition]),
    [
      ["Bravo", true, 1],
      ["Charlie", true, 2],
    ]
  );
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "delta"]);
  // Reordered since: every place compacted, so the old ones are taken now.
  db.reorderDictionaryPins(["alpha", "delta"]);
  assert.deepEqual(positions(), [
    ["alpha", 0],
    ["delta", 1],
  ]);
  assert.deepEqual(db.undoDictionaryTidy(steps), { success: true, steps: 1 });
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "bravo", "charlie", "delta"]);

  // A merge of two pinned words, the higher one into the lower: Undo puts
  // both back where they were.
  const merged = db.applyDictionaryTidy([{ kind: "merge", from: "Alpha", into: "Delta" }]);
  assert.equal(merged.results[0].ok, true);
  assert.deepEqual(db.getDictionaryPins(), ["delta", "bravo", "charlie"]);
  assert.deepEqual(merged.results[0].undo[0].repin, [{ word: "Delta", position: 3 }]);
  assert.deepEqual(db.undoDictionaryTidy(merged.results[0].undo), { success: true, steps: 1 });
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "bravo", "charlie", "delta"]);

  // Only the merged word pinned: Undo unpins the word it went into again.
  const into = db.applyDictionaryTidy([{ kind: "merge", from: "Bravo", into: "Echo" }]);
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "echo", "charlie", "delta"]);
  assert.deepEqual(db.undoDictionaryTidy(into.results[0].undo), { success: true, steps: 1 });
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "bravo", "charlie", "delta"]);

  // A respell keeps the place, and so does its Undo.
  const respelled = db.applyDictionaryTidy([{ kind: "respell", from: "Charlie", to: "Charly" }]);
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "bravo", "charly", "delta"]);
  assert.deepEqual(db.undoDictionaryTidy(respelled.results[0].undo), {
    success: true,
    steps: 1,
  });
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "bravo", "charlie", "delta"]);
});

test("restore: a pin without a known place goes last; one already pinned stays where it is", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, pin } = ctx;
  add("Alpha", "Bravo");
  pin("Alpha", "Bravo");
  const restored = db.restoreDictionaryWords([
    { word: "Charlie", source: "manual", createdAt: null, pinned: true },
    { word: "Delta", source: "manual", createdAt: null, pinned: true, pinPosition: -1 },
  ]);
  assert.equal(restored.success, true);
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "bravo", "charlie", "delta"]);
  assert.equal(db._insertDictionaryPinAt("alpha", 3, "x"), false);
  assert.deepEqual(db.getDictionaryPins(), ["alpha", "bravo", "charlie", "delta"]);
});
