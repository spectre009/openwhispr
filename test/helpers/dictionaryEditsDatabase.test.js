const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const { createStepHistory, createStepRunRegistry } = require("../../src/helpers/stepHistory.js");
const {
  computeDictionaryUsage,
  computeWordUsage,
  createDictionaryUsageService,
} = require("../../src/helpers/dictionaryUsage.js");

// The Dictionary's list against a real database: a rename keeps the row (its
// source, date and cloud identity) and moves what's keyed by the word (pin,
// evidence, accepted suggestion), a case-only rename keeps the key, a clash
// is refused, a merge folds one word into another, "Mark typed" promotes
// learned words, and the word detail's weekly counts and the cleanup-set
// comparison read History by its rules. Synthetic text only.

const DAY = 24 * 60 * 60 * 1000;

function makeTrace({ raw, final, runId, scope = null, kind = "cleanup" }) {
  return {
    version: 1,
    rawText: raw,
    workingText: raw,
    finalText: final,
    context: {
      targetApp: "Code.exe",
      intents: { voiceAgent: false, translation: false, wakeWord: false },
    },
    route: "cleanup",
    glossary: { revision: null, rulesFired: [] },
    steps: [
      { kind: "stt", outcome: "ok", output: raw, provider: "groq", model: "whisper", ms: 800 },
      {
        kind,
        outcome: "ok",
        output: final,
        provider: "openai",
        model: "m",
        ms: 10,
        ...(scope ? { detail: { dictionaryScope: scope } } : {}),
      },
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
  const backdate = (id, days) =>
    db.db
      .prepare(`UPDATE transcriptions SET created_at = datetime('now', ?) WHERE id = ?`)
      .run(`-${days} days`, id);
  return { db, state, history, dictate, row, backdate };
}

test("a rename keeps the row: learned stays learned, its date, pin and cloud identity", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, row, dictate } = ctx;
  db.applyDictionaryChanges({ add: ["Claud Web"] }, "learned");
  db.db
    .prepare("UPDATE custom_dictionary SET created_at = '2026-08-03 10:00:00' WHERE word = ?")
    .run("Claud Web");
  const before = row("Claud Web");
  db.markDictionaryEntrySynced(before.id, "cloud-claud");
  assert.equal(row("Claud Web").sync_status, "synced");
  db.setDictionaryPin("Claud Web", true);

  // Its evidence, and the accepted suggestion it came from.
  const id = dictate("ask claude web", "Ask Claud Web.");
  db.addDictionaryWordEvidence({
    word: "Claud Web",
    owner: "account:a",
    transcriptionId: id,
    replaced: "claude web",
    app: "github.exe",
  });
  db.db
    .prepare(
      `INSERT INTO dictionary_suggestions (word, word_key, times, status, created_at, updated_at)
       VALUES ('Claud Web', 'claud web', 1, 'accepted', '2026-08-03', '2026-08-03')`
    )
    .run();

  const result = db.renameDictionaryWord("Claud Web", "Scout Web");
  assert.deepEqual(result, { success: true, changed: true, word: "Scout Web" });
  const after = row("Scout Web");
  assert.equal(after.id, before.id, "the same row");
  assert.equal(after.source, "learned", "learned stays learned");
  assert.equal(after.created_at, "2026-08-03 10:00:00", "its date stays");
  assert.equal(after.cloud_id, "cloud-claud");
  assert.equal(after.client_dict_id, before.client_dict_id);
  assert.equal(after.sync_status, "pending", "marked for sync, as an edit");
  assert.equal(row("Claud Web"), undefined);
  assert.deepEqual(db.getDictionaryPins(), ["scout web"], "the pin moves");
  assert.equal(db.getDictionaryWordEvidence("account:a", ["scout web"]).length, 1);
  assert.equal(db.getDictionaryWordEvidence("account:a", ["claud web"]).length, 0);
  const suggestion = db.db
    .prepare("SELECT word, word_key, status FROM dictionary_suggestions")
    .all();
  assert.deepEqual(suggestion, [{ word: "Scout Web", word_key: "scout web", status: "accepted" }]);
  assert.deepEqual(
    db.getPendingDictionary().map((entry) => [entry.word, entry.source, entry.cloud_id]),
    [["Scout Web", "learned", "cloud-claud"]],
    "the next push sends the new spelling as an edit of the same entry"
  );
  const entry = db.getDictionaryEntries().find((e) => e.word === "Scout Web");
  assert.equal(entry.createdAt, "2026-08-03 10:00:00");
  assert.equal(entry.source, "learned");
});

test("a case-only rename updates the word in place; the same spelling changes nothing", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, row } = ctx;
  db.applyDictionaryChanges({ add: ["Claude"] }, "learned");
  db.setDictionaryPin("Claude", true);
  const before = row("Claude");
  assert.deepEqual(db.renameDictionaryWord("Claude", "CLAUDE"), {
    success: true,
    changed: true,
    word: "CLAUDE",
  });
  const after = row("CLAUDE");
  assert.equal(after.id, before.id);
  assert.equal(after.source, "learned");
  assert.deepEqual(db.getDictionaryPins(), ["claude"], "the key, so the pin, is the same");
  assert.deepEqual(db.renameDictionaryWord("CLAUDE", "  CLAUDE "), {
    success: true,
    changed: false,
    word: "CLAUDE",
  });
  assert.equal(db.renameDictionaryWord("Nope", "Other").code, "NOT_FOUND");
  assert.equal(db.renameDictionaryWord("CLAUDE", "   ").code, "INVALID_WORD");
  assert.equal(db.renameDictionaryWord("CLAUDE", "two\nlines").code, "INVALID_WORD");
});

test("a rename onto another live word is refused, naming it", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db } = ctx;
  db.applyDictionaryChanges({ add: ["agents-shared", "agentsshared"] }, "learned");
  assert.deepEqual(db.renameDictionaryWord("agentsshared", "AGENTS-SHARED"), {
    success: false,
    code: "EXISTS",
    existing: "agents-shared",
  });
  assert.deepEqual(db.getDictionary().sort(), ["agents-shared", "agentsshared"]);
});

test("a rename takes a spelling a deleted, not yet pushed row still holds", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, row } = ctx;
  db.applyDictionaryChanges({ add: ["Kusto", "Kustoo"] });
  db.markDictionaryEntrySynced(row("Kusto").id, "cloud-kusto");
  db.applyDictionaryChanges({ remove: ["Kusto"] });
  const tombstone = db.db
    .prepare("SELECT * FROM custom_dictionary WHERE cloud_id = 'cloud-kusto'")
    .get();
  assert.ok(tombstone.deleted_at);

  assert.equal(db.renameDictionaryWord("Kustoo", "Kusto").success, true);
  assert.deepEqual(db.getDictionary(), ["Kusto"]);
  const deletes = db.getPendingDictionaryDeletes();
  assert.deepEqual(
    deletes.map((entry) => entry.cloud_id),
    ["cloud-kusto"],
    "the deletion is still pushed"
  );
  assert.notEqual(deletes[0].word, "Kusto");
});

test("a merge keeps `into`: typed wins, a pin survives, evidence moves", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, row, dictate } = ctx;
  db.applyDictionaryChanges({ add: ["agents-shared"] }, "learned");
  db.applyDictionaryChanges({ add: ["agentsshared"] }, "manual");
  db.setDictionaryPin("agentsshared", true);
  db.markDictionaryEntrySynced(row("agentsshared").id, "cloud-from");
  const id = dictate("agents shared", "agentsshared");
  db.addDictionaryWordEvidence({
    word: "agentsshared",
    owner: "account:a",
    transcriptionId: id,
    replaced: "agents shared",
    app: null,
  });
  const into = row("agents-shared");

  const result = db.mergeDictionaryWords("agentsshared", "agents-shared");
  assert.deepEqual(result, { success: true, word: "agents-shared", source: "manual" });
  const kept = row("agents-shared");
  assert.equal(kept.id, into.id);
  assert.equal(kept.source, "manual", "typed wins");
  assert.equal(kept.sync_status, "pending");
  assert.deepEqual(db.getDictionary(), ["agents-shared"]);
  assert.deepEqual(db.getDictionaryPins(), ["agents-shared"], "the pin survives on into");
  assert.equal(db.getDictionaryWordEvidence("account:a", ["agents-shared"]).length, 1);
  assert.equal(db.getDictionaryWordEvidence("account:a", ["agentsshared"]).length, 0);
  assert.deepEqual(
    db.getPendingDictionaryDeletes().map((entry) => entry.cloud_id),
    ["cloud-from"],
    "a synced `from` leaves as a tombstone the next push sends"
  );

  // Learned into learned stays learned; neither pinned, no pin.
  db.applyDictionaryChanges({ add: ["file", "files"] }, "learned");
  assert.deepEqual(db.mergeDictionaryWords("files", "file"), {
    success: true,
    word: "file",
    source: "learned",
  });
  assert.deepEqual(db.getDictionaryPins(), ["agents-shared"]);
  assert.equal(db.mergeDictionaryWords("file", "file").code, "NOT_FOUND");
  assert.equal(db.mergeDictionaryWords("ghost", "file").code, "NOT_FOUND");
});

test("Mark typed promotes learned words, marked for sync, and nothing else", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, row } = ctx;
  db.applyDictionaryChanges({ add: ["EngHub", "SuperApp"] }, "learned");
  db.applyDictionaryChanges({ add: ["IDEAs"] }, "manual");
  db.db.prepare("UPDATE custom_dictionary SET created_at = '2026-08-03 10:00:00'").run();
  db.markDictionaryEntrySynced(row("EngHub").id, "cloud-enghub");
  assert.deepEqual(db.setDictionarySource(["enghub", "IDEAs", "Ghost"], "manual"), {
    success: true,
    changed: 1,
  });
  const promoted = row("EngHub");
  assert.equal(promoted.source, "manual");
  assert.equal(promoted.sync_status, "pending");
  assert.equal(promoted.created_at, "2026-08-03 10:00:00");
  assert.equal(row("SuperApp").source, "learned");
  assert.equal(db.setDictionarySource(["SuperApp"], "learned").code, "INVALID_SOURCE");
  assert.equal(row("SuperApp").source, "learned");
});

test("a word's weekly counts: 13 weeks, the same rows and matching as the totals", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, dictate, backdate } = ctx;
  const now = Date.now();
  // This week: two dictations wrote it without hearing it.
  dictate("open whisper is open whisper", "OpenWhispr is OpenWhispr.");
  dictate("open whisper", "OpenWhispr.");
  // Three weeks ago: one missed, one heard and written.
  backdate(dictate("open whisper", "OpenWhispr."), 22);
  backdate(dictate("openwhispr rocks", "OpenWhispr rocks."), 22);
  // Older than the window: never counted.
  backdate(dictate("openwhispr old", "OpenWhispr old."), 95);

  const weeks = computeWordUsage(db, "OpenWhispr", { owner: "account:a", now });
  assert.equal(weeks.length, 13);
  const last = weeks[12];
  assert.deepEqual(
    { heard: last.heard, written: last.written, missedRows: last.missedRows },
    { heard: 0, written: 2, missedRows: 2 }
  );
  const threeAgo = weeks.find((week) => week.heard + week.written > 0 && week !== last);
  assert.deepEqual(
    { heard: threeAgo.heard, written: threeAgo.written, missedRows: threeAgo.missedRows },
    { heard: 1, written: 2, missedRows: 1 }
  );
  assert.ok(Date.parse(weeks[0].start) >= now - 90 * DAY - 1000, "starts with the window");
  // The weeks add up to the totals.
  const total = computeDictionaryUsage(db, ["OpenWhispr"], { owner: "account:a", now });
  const sum = (key) => weeks.reduce((n, week) => n + week[key], 0);
  assert.deepEqual(
    { heard: sum("heard"), written: sum("written"), missedRows: sum("missedRows") },
    {
      heard: total.words[0].heard,
      written: total.words[0].written,
      missedRows: total.words[0].missedRows,
    }
  );
  assert.ok(total.pace.perDay > 0, "the pace comes from the same rows");
});

test("the cleanup-set comparison: this owner's successful steps, grouped by the set applied", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, dictate, state } = ctx;
  const all = { setting: "all", applied: "all", words: 215 };
  const typed = { setting: "typedPinned", applied: "typedPinned", words: 13 };
  dictate("a", "A.", { scope: all });
  dictate("b", "B.", { scope: all });
  dictate("c", "C.", { scope: typed });
  dictate("d", "D.", { scope: { ...typed, words: 15 }, kind: "style" });
  dictate("e", "E.");
  state.owner = "account:b";
  dictate("f", "F.", { scope: typed });
  state.owner = "account:a";

  const since = new Date(Date.now() - 90 * DAY).toISOString().slice(0, 19).replace("T", " ");
  assert.deepEqual(db.getDictionaryCleanupScopeCounts({ owner: "account:a", since }), [
    { applied: "all", dictations: 2, avgWords: 215 },
    { applied: "typedPinned", dictations: 2, avgWords: 14 },
  ]);
  assert.deepEqual(db.getDictionaryCleanupScopeCounts({ owner: "account:b", since }), [
    { applied: "typedPinned", dictations: 1, avgWords: 13 },
  ]);

  // Through the service: only while History is durable for the owner.
  let policy = { synced: true, enabled: true, forcedOff: false, resolved: true };
  const service = createDictionaryUsageService({
    db,
    getOwner: () => "account:a",
    getPolicy: () => policy,
  });
  const result = await service.getCleanupScopeCounts();
  assert.equal(result.available, true);
  assert.equal(result.sets.length, 2);
  policy = { ...policy, enabled: false };
  assert.deepEqual(await service.getCleanupScopeCounts(), {
    available: false,
    reason: "history-off",
  });
  assert.deepEqual(await service.getWord("OpenWhispr"), {
    available: false,
    reason: "history-off",
  });
});
