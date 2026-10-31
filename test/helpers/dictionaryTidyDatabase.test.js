const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const { createStepHistory, createStepRunRegistry } = require("../../src/helpers/stepHistory.js");
const {
  computeDictionaryTidyInputs,
  createDictionaryUsageService,
} = require("../../src/helpers/dictionaryUsage.js");

// Tidy up against a real database: Undo puts a removed word back as it was
// (a tombstoned row reactivated, a hard-deleted one inserted again with its
// date, source, pin and the pin's place), a batch applies through the dictionary's own
// operations and returns the steps that reverse it, Undo is refused with the
// reason when something changed since (an edit, the spelling taken, the word
// merged into gone) and leaves nothing half done, and History's aggregates
// (frequent tokens, adjacent words) follow the usage rows and durability.
// Synthetic words and text only.

function makeTrace({ raw, final, runId, route = "cleanup" }) {
  return {
    version: 1,
    rawText: raw,
    workingText: raw,
    finalText: final,
    context: {
      targetApp: "Code.exe",
      intents: { voiceAgent: false, translation: false, wakeWord: false },
    },
    route,
    glossary: { revision: null, rulesFired: [] },
    steps: [
      { kind: "stt", outcome: "ok", output: raw, provider: "groq", model: "whisper", ms: 800 },
      { kind: "cleanup", outcome: "ok", output: final, provider: "openai", model: "m", ms: 10 },
    ],
    ...(runId ? { runId } : {}),
  };
}

function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  const state = { owner: "account:a" };
  const history = createStepHistory({
    db,
    getOwner: () => state.owner,
    isEnabled: () => true,
    runs: createStepRunRegistry(),
  });
  const dictate = (raw, final, options = {}) => {
    const runId = history.beginRun();
    const trace = makeTrace({ raw, final, runId, ...options });
    return history.saveTranscription(final, raw, { trace }).id;
  };
  const row = (word) =>
    db.db
      .prepare("SELECT * FROM custom_dictionary WHERE word = ? AND deleted_at IS NULL")
      .get(word);
  const anyRow = (word) =>
    db.db.prepare("SELECT * FROM custom_dictionary WHERE word = ?").get(word);
  const words = () => db.getDictionary();
  const dated = (word, createdAt) =>
    db.db
      .prepare("UPDATE custom_dictionary SET created_at = ? WHERE word = ?")
      .run(createdAt, word);
  return { db, state, dictate, row, anyRow, words, dated };
}

test("restore: a tombstoned row comes back as it was, the same row", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, row, anyRow, dated } = ctx;
  db.applyDictionaryChanges({ add: ["gonestly"] }, "learned");
  dated("gonestly", "2026-08-03 10:00:00");
  const before = row("gonestly");
  db.markDictionaryEntrySynced(before.id, "cloud-gonestly");
  db.setDictionaryPin("gonestly", true);

  const applied = db.applyDictionaryTidy([{ kind: "remove", words: ["gonestly"] }]);
  const [removed] = applied.results;
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, 1);
  assert.deepEqual(removed.undo, [
    {
      restore: [
        {
          word: "gonestly",
          source: "learned",
          createdAt: "2026-08-03 10:00:00",
          pinned: true,
          pinPosition: 0,
          category: null,
          categorySource: null,
        },
      ],
    },
  ]);
  const tombstone = anyRow("gonestly");
  assert.ok(tombstone.deleted_at, "a synced word leaves as a tombstone");
  assert.deepEqual(db.getDictionaryPins(), [], "its pin went with it");

  const result = db.restoreDictionaryWords(removed.undo[0].restore);
  assert.deepEqual(result, { success: true, restored: 1, removed: 0 });
  const after = row("gonestly");
  assert.equal(after.id, before.id, "the same row, reactivated");
  assert.equal(after.cloud_id, "cloud-gonestly");
  assert.equal(after.source, "learned");
  assert.equal(after.created_at, "2026-08-03 10:00:00");
  assert.equal(after.sync_status, "pending", "marked for sync");
  assert.deepEqual(db.getDictionaryPins(), ["gonestly"]);
});

test("restore: a hard-deleted row is inserted again with its date, source and pin", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, row, anyRow, dated } = ctx;
  db.applyDictionaryChanges({ add: ["aessions"] }, "learned");
  dated("aessions", "2026-07-01 08:30:00");
  db.setDictionaryPin("aessions", true);
  const before = row("aessions");

  const { results } = db.applyDictionaryTidy([{ kind: "remove", words: ["aessions"] }]);
  assert.equal(anyRow("aessions"), undefined, "never synced: deleted outright");

  db.restoreDictionaryWords(results[0].undo[0].restore);
  const after = row("aessions");
  assert.notEqual(after.id, before.id, "a new row");
  assert.equal(after.source, "learned");
  assert.equal(after.created_at, "2026-07-01 08:30:00", "its original date");
  assert.equal(after.cloud_id, null);
  assert.ok(after.client_dict_id, "a client id, so the push can add it");
  assert.equal(after.sync_status, "pending");
  assert.deepEqual(db.getDictionaryPins(), ["aessions"]);
  assert.ok(
    db.getPendingDictionary().some((entry) => entry.word === "aessions"),
    "the next push adds it"
  );
});

test("a batch: remove, merge, respell (merging on a clash) and a phrase, then Undo", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, row, words, dictate } = ctx;
  db.applyDictionaryChanges({ add: ["approver", "Claude", "Little Buddy2"] }, "manual");
  db.applyDictionaryChanges(
    { add: ["the", "agentsshared", "agents-shared", "approverl", "Little", "Buddy"] },
    "learned"
  );
  db.setDictionaryPin("the", true);
  db.setDictionaryPin("agentsshared", true);
  const id = dictate("agents shared", "agentsshared");
  db.addDictionaryWordEvidence({
    word: "agentsshared",
    owner: "account:a",
    transcriptionId: id,
    replaced: "agents shared",
    app: "github.exe",
  });
  const littleBefore = row("Little");

  const { success, results } = db.applyDictionaryTidy([
    { kind: "remove", words: ["the"] },
    { kind: "merge", from: "agentsshared", into: "agents-shared" },
    { kind: "respell", from: "approverl", to: "Approver" },
    { kind: "add-phrase", phrase: "Little Buddy", parts: ["Little", "Buddy"] },
    { kind: "remove", words: ["not-there"] },
  ]);
  assert.equal(success, true);
  assert.deepEqual(
    results.map((result) => [result.kind, result.ok, result.code ?? null]),
    [
      ["remove", true, null],
      ["merge", true, null],
      ["respell", true, null],
      ["add-phrase", true, null],
      ["remove", false, "NOT_FOUND"],
    ]
  );
  assert.equal(results[2].merged, 1, "“Approver” is approver's: merged into it");
  assert.equal(results[3].added, 1);
  assert.equal(results[3].removed, 2);
  assert.deepEqual(
    words().sort(),
    ["agents-shared", "approver", "Claude", "Little Buddy", "Little Buddy2"].sort()
  );
  assert.equal(row("Little Buddy").source, "manual", "the phrase is added typed");
  assert.deepEqual(
    db.getDictionaryPins(),
    ["agents-shared"],
    "the merge pinned it; the removed word's pin went"
  );
  assert.equal(
    db.getDictionaryWordEvidence("account:a", ["agents-shared"]).length,
    1,
    "the evidence moved with the merge"
  );

  // Undo everything (the steps of all choices, as Tidy up stacks one action's).
  const steps = results.flatMap((result) => (result.ok ? result.undo : []));
  const undone = db.undoDictionaryTidy(steps);
  assert.deepEqual(undone, { success: true, steps: steps.length });
  assert.deepEqual(
    words().sort(),
    [
      "approver",
      "Claude",
      "Little Buddy2",
      "the",
      "agentsshared",
      "agents-shared",
      "approverl",
      "Little",
      "Buddy",
    ].sort()
  );
  for (const word of ["the", "agentsshared", "approverl", "Little", "Buddy"]) {
    assert.equal(row(word).source, "learned", `${word} is learned again`);
  }
  assert.equal(row("Little").created_at, littleBefore.created_at, "its date");
  assert.equal(row("Little Buddy"), undefined, "the phrase Tidy up added is gone");
  assert.deepEqual(
    db.getDictionaryPins().sort(),
    ["agentsshared", "the"],
    "the merge's pin on agents-shared is undone; the removed words' pins are back"
  );
  assert.equal(
    db.getDictionaryWordEvidence("account:a", ["agentsshared"]).length,
    0,
    "evidence isn't restored: it comes from History"
  );
});

test("a respell that renames, and its Undo", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, row, dated } = ctx;
  db.applyDictionaryChanges({ add: ["groq"] }, "learned");
  dated("groq", "2026-06-01 09:00:00");
  db.setDictionaryPin("groq", true);
  const before = row("groq");
  const { results } = db.applyDictionaryTidy([{ kind: "respell", from: "groq", to: "Groq" }]);
  assert.deepEqual(results[0].undo, [{ rename: { from: "Groq", to: "groq" } }]);
  assert.equal(row("Groq").id, before.id);
  assert.deepEqual(db.undoDictionaryTidy(results[0].undo), { success: true, steps: 1 });
  const after = row("groq");
  assert.equal(after.id, before.id);
  assert.equal(after.created_at, "2026-06-01 09:00:00");
  assert.deepEqual(db.getDictionaryPins(), ["groq"]);
});

test("Undo is refused, with the reason, when something changed since, and changes nothing", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, words } = ctx;
  db.applyDictionaryChanges({ add: ["approver"] }, "manual");
  db.applyDictionaryChanges(
    { add: ["foo", "agentsshared", "agents-shared", "approverl", "zed"] },
    "learned"
  );

  // The word was edited since: renamed again.
  const respelled = db.applyDictionaryTidy([{ kind: "respell", from: "zed", to: "Zed" }])
    .results[0];
  db.renameDictionaryWord("Zed", "Zedd");
  assert.deepEqual(db.undoDictionaryTidy(respelled.undo), {
    success: false,
    code: "EDITED",
    word: "Zed",
  });

  // The spelling now belongs to another live word.
  const removed = db.applyDictionaryTidy([{ kind: "remove", words: ["foo"] }]).results[0];
  db.applyDictionaryChanges({ add: ["Foo"] }, "manual");
  assert.deepEqual(db.undoDictionaryTidy(removed.undo), {
    success: false,
    code: "EXISTS",
    word: "foo",
    existing: "Foo",
  });

  // The word it was merged into is gone.
  const merged = db.applyDictionaryTidy([
    { kind: "merge", from: "agentsshared", into: "agents-shared" },
  ]).results[0];
  db.applyDictionaryChanges({ remove: ["agents-shared"] });
  assert.deepEqual(db.undoDictionaryTidy(merged.undo), {
    success: false,
    code: "INTO_GONE",
    word: "agents-shared",
  });

  // All or nothing: one refused step leaves the others undone too.
  const batch = db.applyDictionaryTidy([
    { kind: "remove", words: ["approverl"] },
    { kind: "respell", from: "Zedd", to: "Zeta" },
  ]).results;
  db.renameDictionaryWord("Zeta", "Zeta2");
  const listBefore = words().sort();
  const refused = db.undoDictionaryTidy(batch.flatMap((result) => result.undo));
  assert.equal(refused.success, false);
  assert.equal(refused.code, "EDITED");
  assert.deepEqual(words().sort(), listBefore, "approverl wasn't put back on its own");
});

test("Undo of a merge between two spellings of one word (a legacy case variant)", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, row } = ctx;
  db.applyDictionaryChanges({ add: ["Claude"] }, "manual");
  // A legacy case-variant row, as old databases can hold.
  db.db
    .prepare(
      "INSERT INTO custom_dictionary (word, source, sync_status, created_at) VALUES ('CLAUDE', 'learned', 'pending', '2026-05-05 05:05:05')"
    )
    .run();
  db.setDictionaryPin("Claude", true);
  const { results } = db.applyDictionaryTidy([{ kind: "merge", from: "CLAUDE", into: "Claude" }]);
  assert.equal(results[0].ok, true);
  assert.equal(row("CLAUDE"), undefined);
  assert.deepEqual(db.undoDictionaryTidy(results[0].undo), { success: true, steps: 1 });
  assert.equal(row("CLAUDE").created_at, "2026-05-05 05:05:05");
  assert.ok(row("Claude"), "the word it went into stays");
  assert.deepEqual(db.getDictionaryPins(), ["claude"]);
});

test("tidy inputs over History: the usage rows, adjacency, and only while History is durable", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, dictate, state } = ctx;
  db.applyDictionaryChanges({ add: ["Little", "Buddy"] }, "learned");
  dictate("hey little buddy", "Hey Little Buddy.");
  dictate("little buddy is here", "Little Buddy is here.");
  dictate("buddy", "Buddy honestly.");
  // Not what the user said: the assistant's answer, and a translation.
  dictate("little buddy agent", "Little Buddy agent reply.", { route: "agent" });
  const translation = dictate("little buddy", "Kleiner Kumpel.");
  db.db
    .prepare("UPDATE transcriptions SET route_kind = 'translation' WHERE id = ?")
    .run(translation);

  const counts = computeDictionaryTidyInputs(db, db.getDictionary(), { owner: "account:a" });
  assert.equal(counts.rows, 3);
  assert.deepEqual(counts.adjacency, [{ a: "Little", b: "Buddy", together: 2, rarerRows: 2 }]);
  const token = (name) => counts.frequentTokens.find((entry) => entry.token === name)?.rows;
  assert.equal(token("buddy"), 3);
  assert.equal(token("honestly"), 1);
  assert.equal(token("kleiner"), undefined, "translations aren't read");
  assert.equal(token("agent"), undefined, "the assistant's rows aren't read");

  // Another owner reads its own assistant rows' exclusion; History is device-wide otherwise.
  state.owner = "account:b";
  const other = computeDictionaryTidyInputs(db, db.getDictionary(), { owner: "account:b" });
  assert.equal(other.rows, 4, "account:a's assistant row counts for account:b");

  let policy = { synced: true, enabled: true, forcedOff: false, resolved: true };
  const service = createDictionaryUsageService({
    db,
    getOwner: () => "account:a",
    getPolicy: () => policy,
  });
  const result = await service.getTidyInputs();
  assert.equal(result.available, true);
  assert.deepEqual(result.adjacency, counts.adjacency);
  policy = { ...policy, synced: false };
  assert.deepEqual(await service.getTidyInputs(), { available: false, reason: "pending" });
  policy = { ...policy, synced: true, enabled: false };
  assert.deepEqual(await service.getTidyInputs(), { available: false, reason: "history-off" });
});
