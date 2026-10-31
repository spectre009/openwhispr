const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");

// Categories (Dictionary v2, Stage C) against a real database: only explicit
// choices are stored (the user's, or a model proposal the user accepted);
// setting, clearing and refusing them per item; a choice follows its word
// exactly like a pin (removal and Clear all, a rename, a merge with the
// user's choice beating the model's and that beating none, a cloud rename
// and delete, setDictionary); and Tidy up's apply and Undo put a removed or
// merged word's category back. Run under Electron's Node with
// REQUIRE_DB_TESTS=1 so a native-binding failure can't skip it. Synthetic
// words only.

function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  const add = (...words) => db.applyDictionaryChanges({ add: words });
  const set = (items) => db.setDictionaryCategories(items);
  const categories = () =>
    Object.fromEntries(
      db.getDictionaryCategories().map((row) => [row.key, `${row.category}/${row.source}`])
    );
  return { db, add, set, categories };
}

test("the table: created idempotently beside the pins, with its checks", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db } = ctx;
  const columns = db.db
    .prepare("PRAGMA table_info(dictionary_categories)")
    .all()
    .map((column) => column.name);
  assert.deepEqual(columns, ["word_key", "category", "source", "updated_at"]);
  assert.throws(() =>
    db.db
      .prepare(
        "INSERT INTO dictionary_categories (word_key, category, source, updated_at) VALUES ('x', 'products', 'user', 'now')"
      )
      .run()
  );
  assert.throws(() =>
    db.db
      .prepare(
        "INSERT INTO dictionary_categories (word_key, category, source, updated_at) VALUES ('x', 'work', 'auto', 'now')"
      )
      .run()
  );
  // Running the init again changes nothing.
  db._initDictionaryState();
  assert.equal(db.dictionaryStateReady, true);
});

test("set, clear and refuse: per item, in one call, at most the dictionary's size", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, set, categories } = ctx;
  add("Kusto", "Aria", "groq", "Dmitry");

  const result = set([
    { word: "Kusto", category: "work", source: "model" },
    { word: "aria", category: "people", source: "user" },
    { word: "Nonexistent", category: "work", source: "user" },
  ]);
  assert.equal(result.success, true);
  assert.equal(result.changed, 2);
  assert.deepEqual(result.results, [
    { ok: true },
    { ok: true },
    { ok: false, code: "NOT_IN_DICTIONARY" },
  ]);
  assert.deepEqual(categories(), { aria: "people/user", kusto: "work/model" });
  assert.deepEqual(result.categories, db.getDictionaryCategories());

  // Unknown values are refused per item; the rest apply.
  const refused = set([
    { word: "groq", category: "products", source: "user" },
    { word: "groq", category: "work", source: "auto" },
    { word: "groq", category: undefined, source: "user" },
    { word: "groq", category: "work", source: "user" },
  ]);
  assert.deepEqual(
    refused.results.map((entry) => entry.code ?? "ok"),
    ["INVALID_CATEGORY", "INVALID_SOURCE", "INVALID_CATEGORY", "ok"]
  );
  assert.equal(categories().groq, "work/user");

  // The same choice again changes nothing; null clears (back to automatic).
  assert.equal(set([{ word: "Kusto", category: "work", source: "model" }]).changed, 0);
  const cleared = set([{ word: "Kusto", category: null, source: "user" }]);
  assert.equal(cleared.changed, 1);
  assert.deepEqual(categories(), { aria: "people/user", groq: "work/user" });

  // More items than words is refused whole.
  const tooMany = set([
    { word: "Kusto", category: "work", source: "user" },
    { word: "Aria", category: "work", source: "user" },
    { word: "groq", category: "work", source: "user" },
    { word: "Dmitry", category: "people", source: "user" },
    { word: "Kusto", category: "people", source: "user" },
  ]);
  assert.equal(tooMany.success, false);
  assert.equal(tooMany.code, "TOO_MANY");
  assert.deepEqual(categories(), { aria: "people/user", groq: "work/user" });
  assert.equal(db.setDictionaryCategories("nope").code, "INVALID");
});

test("a choice follows its word: removal, Clear all and setDictionary prune it", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, set, categories } = ctx;
  add("Kusto", "Aria", "groq", "Dmitry");
  set([
    { word: "Kusto", category: "work", source: "model" },
    { word: "Aria", category: "work", source: "user" },
    { word: "groq", category: "work", source: "user" },
    { word: "Dmitry", category: "people", source: "user" },
  ]);

  db.applyDictionaryChanges({ remove: ["Kusto"] });
  assert.deepEqual(Object.keys(categories()), ["aria", "dmitry", "groq"]);

  // setDictionary (a replace) keeps what stays, drops what goes.
  db.setDictionary(["Aria", "Dmitry"]);
  assert.deepEqual(Object.keys(categories()), ["aria", "dmitry"]);

  // Clear all: every word removed, every choice with it.
  db.applyDictionaryChanges({ remove: ["Aria", "Dmitry"] });
  assert.deepEqual(categories(), {});

  // A word added again starts automatic.
  add("Kusto");
  assert.deepEqual(categories(), {});
});

test("a rename moves the choice to the new key; a case-only rename keeps it", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, set, categories } = ctx;
  add("Kusto", "groq");
  set([
    { word: "Kusto", category: "work", source: "user" },
    { word: "groq", category: "work", source: "model" },
  ]);
  assert.equal(db.renameDictionaryWord("Kusto", "Kusto Explorer").success, true);
  assert.deepEqual(categories(), { groq: "work/model", "kusto explorer": "work/user" });
  assert.equal(db.renameDictionaryWord("groq", "Groq").success, true);
  assert.deepEqual(categories(), { groq: "work/model", "kusto explorer": "work/user" });
});

test("merge precedence: the user's choice beats the model's, which beats none; a tie keeps the target's", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, set, categories } = ctx;
  add("A1", "A2", "B1", "B2", "C1", "C2", "D1", "D2", "E1", "E2");
  set([
    // from user, into model: the user's wins.
    { word: "A1", category: "people", source: "user" },
    { word: "A2", category: "work", source: "model" },
    // from model, into none: the model's goes over.
    { word: "B1", category: "everyday", source: "model" },
    // from model, into user: into's stays.
    { word: "C1", category: "work", source: "model" },
    { word: "C2", category: "people", source: "user" },
    // both user: the target's stays.
    { word: "D1", category: "work", source: "user" },
    { word: "D2", category: "people", source: "user" },
    // from none, into model: into's stays.
    { word: "E2", category: "everyday", source: "model" },
  ]);
  for (const [from, into] of [
    ["A1", "A2"],
    ["B1", "B2"],
    ["C1", "C2"],
    ["D1", "D2"],
    ["E1", "E2"],
  ]) {
    assert.equal(db.mergeDictionaryWords(from, into).success, true, `${from} → ${into}`);
  }
  assert.deepEqual(categories(), {
    a2: "people/user",
    b2: "everyday/model",
    c2: "people/user",
    d2: "people/user",
    e2: "everyday/model",
  });
});

test("cloud pulls: a rename from another device moves the choice; a delete drops it", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, set, categories } = ctx;
  add("Aria", "SuperApp");
  set([
    { word: "Aria", category: "work", source: "user" },
    { word: "SuperApp", category: "work", source: "model" },
  ]);
  const aria = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Aria'").get();
  db.upsertDictionaryFromCloud({
    id: "cloud-aria",
    client_dict_id: aria.client_dict_id,
    word: "AriaEvent",
    source: "manual",
    updated_at: "2099-01-01T00:00:00.000Z",
  });
  assert.deepEqual(categories(), { ariaevent: "work/user", superapp: "work/model" });

  // A move onto a key with a choice already: the stronger stays, the target's on a tie.
  db.db
    .prepare(
      "INSERT INTO dictionary_categories (word_key, category, source, updated_at) VALUES ('legacy', 'people', 'user', 'x')"
    )
    .run();
  db._moveDictionaryCategory("legacy", "SuperApp");
  assert.equal(categories().superapp, "people/user", "the user's beats the model's");
  db.db
    .prepare(
      "INSERT INTO dictionary_categories (word_key, category, source, updated_at) VALUES ('older', 'everyday', 'user', 'x')"
    )
    .run();
  db._moveDictionaryCategory("older", "SuperApp");
  assert.equal(categories().superapp, "people/user", "a tie keeps the target's");
  assert.equal(categories().older, undefined);

  const superApp = db.db.prepare("SELECT id FROM custom_dictionary WHERE word = 'SuperApp'").get();
  db.hardDeleteDictionaryEntry(superApp.id);
  assert.deepEqual(categories(), { ariaevent: "work/user" });
});

test("Tidy up: a removal's and a phrase's Undo put the categories back", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, set, categories } = ctx;
  add("Kusto", "Little", "Buddy", "groq");
  set([
    { word: "Kusto", category: "work", source: "model" },
    { word: "Little", category: "everyday", source: "user" },
  ]);

  const removed = db.applyDictionaryTidy([{ kind: "remove", words: ["Kusto", "groq"] }]);
  const steps = removed.results[0].undo;
  assert.deepEqual(
    steps[0].restore.map((entry) => [entry.word, entry.category, entry.categorySource]),
    [
      ["Kusto", "work", "model"],
      ["groq", null, null],
    ]
  );
  assert.deepEqual(categories(), { little: "everyday/user" });
  // Through IPC the steps are cloned: plain data.
  const cloned = JSON.parse(JSON.stringify(steps));
  assert.deepEqual(db.undoDictionaryTidy(cloned), { success: true, steps: 1 });
  assert.deepEqual(categories(), { kusto: "work/model", little: "everyday/user" });

  const phrase = db.applyDictionaryTidy([
    { kind: "add-phrase", phrase: "Little Buddy", parts: ["Little", "Buddy"] },
  ]);
  assert.equal(phrase.results[0].ok, true);
  assert.deepEqual(categories(), { kusto: "work/model" });
  assert.deepEqual(db.undoDictionaryTidy(phrase.results[0].undo), { success: true, steps: 1 });
  assert.deepEqual(categories(), { kusto: "work/model", little: "everyday/user" });
});

test("Tidy up: a merge's Undo restores both words' own categories; a respell's moves it back", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, add, set, categories } = ctx;
  add("Kusto", "kusto-cli", "Aria", "Dmitry");
  set([
    { word: "kusto-cli", category: "work", source: "user" },
    { word: "Kusto", category: "people", source: "model" },
    { word: "Dmitry", category: "people", source: "user" },
  ]);

  // The user's choice on `from` wins over the model's on `into`.
  const merged = db.applyDictionaryTidy([{ kind: "merge", from: "kusto-cli", into: "Kusto" }]);
  assert.equal(merged.results[0].ok, true);
  assert.deepEqual(categories(), { dmitry: "people/user", kusto: "work/user" });
  assert.deepEqual(merged.results[0].undo[0].recategorize, [
    { word: "Kusto", category: "people", source: "model" },
  ]);
  assert.deepEqual(db.undoDictionaryTidy(merged.results[0].undo), { success: true, steps: 1 });
  assert.deepEqual(categories(), {
    dmitry: "people/user",
    kusto: "people/model",
    "kusto-cli": "work/user",
  });

  // A merge into a word without one: Undo takes the category it got away again.
  const into = db.applyDictionaryTidy([{ kind: "merge", from: "Dmitry", into: "Aria" }]);
  assert.equal(categories().aria, "people/user");
  assert.deepEqual(db.undoDictionaryTidy(into.results[0].undo), { success: true, steps: 1 });
  assert.equal(categories().aria, undefined);
  assert.equal(categories().dmitry, "people/user");

  // A respell moves the category with the word, and so does its Undo.
  const respelled = db.applyDictionaryTidy([{ kind: "respell", from: "Dmitry", to: "Dmitri" }]);
  assert.equal(categories().dmitri, "people/user");
  assert.deepEqual(db.undoDictionaryTidy(respelled.results[0].undo), {
    success: true,
    steps: 1,
  });
  assert.equal(categories().dmitry, "people/user");
  assert.equal(categories().dmitri, undefined);
});

test("a reopened database keeps the choices", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { add, set } = ctx;
  add("Kusto");
  set([{ word: "Kusto", category: "work", source: "user" }]);
  const reopened = new DatabaseManager();
  try {
    assert.deepEqual(reopened.getDictionaryCategories(), [
      { key: "kusto", category: "work", source: "user" },
    ]);
  } finally {
    reopened.db.close();
  }
});
