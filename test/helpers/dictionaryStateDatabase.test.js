const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");
const { createStepHistory, createStepRunRegistry } = require("../../src/helpers/stepHistory.js");
const {
  computeDictionaryUsage,
  createDictionaryUsageService,
} = require("../../src/helpers/dictionaryUsage.js");

// The Dictionary's local state against a real database: pins follow their
// word through every dictionary mutation (delete, replace, cloud pull,
// rename), auto-learn's suggestions keep the user's decision, a suggested
// word's evidence retires with History however it goes (cascade, tombstone,
// clear-all, expiry, account deletion), and the heard/written counts read the
// rows they should and recompute after a rewrite. Synthetic text only.

function makeTrace({ raw, final, route = "cleanup", voiceAgent = false, runId }) {
  return {
    version: 1,
    rawText: raw,
    workingText: raw,
    finalText: final,
    context: {
      targetApp: "Code.exe",
      intents: { voiceAgent, translation: false, wakeWord: false },
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

function setup(t, { owner = "account:a" } = {}) {
  const db = createDb(t);
  if (!db) return null;
  const state = { owner };
  const history = createStepHistory({
    db,
    getOwner: () => state.owner,
    isEnabled: () => true,
    runs: createStepRunRegistry(),
  });
  const dictate = (raw, final, options = {}) => {
    const runId = history.beginRun();
    const trace = makeTrace({ raw, final, runId, ...options });
    return history.saveTranscription(final, raw, { trace, ...(options.row || {}) }).id;
  };
  const evidenceRows = () =>
    db.db.prepare("SELECT * FROM dictionary_word_evidence ORDER BY id").all();
  const nowSql = (offsetMs = 0) =>
    new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
  return { db, state, history, dictate, evidenceRows, nowSql };
}

test("the tables open idempotently, and foreign keys are on after migrations", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  assert.equal(ctx.db.dictionaryStateReady, true);
  assert.equal(ctx.db.historyContentRevisionReady, true);
  ctx.db.applyDictionaryChanges({ add: ["Scout Web"] });
  ctx.db.setDictionaryPin("Scout Web", true);
  const reopened = new DatabaseManager();
  try {
    assert.equal(reopened.dictionaryStateReady, true);
    assert.equal(reopened.db.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(reopened.getDictionaryPins(), ["scout web"], "the pin survives a relaunch");
  } finally {
    reopened.db.close();
  }
});

test("a pin needs its word in the dictionary, and keys by the one identity", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db } = ctx;
  assert.equal(db.setDictionaryPin("Ghost", true).code, "NOT_IN_DICTIONARY");
  db.applyDictionaryChanges({ add: ["Cafe\u0301"] });
  const pinned = db.setDictionaryPin("  CAFÉ ", true);
  assert.equal(pinned.success, true);
  assert.deepEqual(pinned.pins, ["café"]);
  assert.equal(db.setDictionaryPin("café", true).changed, false, "pinning twice changes nothing");
  assert.deepEqual(db.setDictionaryPin("Café", false).pins, []);
});

test("a pin follows its word: deletes (hard and soft), replacements and cloud pulls", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db } = ctx;
  db.applyDictionaryChanges({ add: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"] });
  for (const word of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"])
    db.setDictionaryPin(word, true);

  // Never synced: a physical delete.
  db.applyDictionaryChanges({ remove: ["alpha"] });
  assert.ok(!db.getDictionaryPins().includes("alpha"));

  // Synced: a tombstone the next push sends; the pin goes with the mark.
  const beta = db.db.prepare("SELECT id FROM custom_dictionary WHERE word = 'Beta'").get();
  db.markDictionaryEntrySynced(beta.id, "cloud-beta");
  db.applyDictionaryChanges({ remove: ["Beta"] });
  assert.ok(
    db.db.prepare("SELECT deleted_at FROM custom_dictionary WHERE id = ?").get(beta.id).deleted_at
  );
  assert.ok(!db.getDictionaryPins().includes("beta"));

  // A whole-list replacement drops the words it omits, and their pins.
  db.setDictionary(["Gamma", "Delta", "Epsilon", "Zeta"]);
  db.setDictionary(["Delta", "Epsilon", "Zeta"]);
  assert.deepEqual(db.getDictionaryPins().sort(), ["delta", "epsilon"]);

  // A cloud deletion pull removes the live row physically.
  const delta = db.db.prepare("SELECT id FROM custom_dictionary WHERE word = 'Delta'").get();
  db.hardDeleteDictionaryEntry(delta.id);
  assert.deepEqual(db.getDictionaryPins(), ["epsilon"]);

  // A rename from another device (the cloud pull's in-place UPDATE) moves it.
  const epsilon = db.db.prepare("SELECT * FROM custom_dictionary WHERE word = 'Epsilon'").get();
  db.upsertDictionaryFromCloud({
    id: "cloud-eps",
    client_dict_id: epsilon.client_dict_id,
    word: "Epsilon Prime",
    source: "manual",
    updated_at: "2099-01-01T00:00:00.000Z",
  });
  assert.deepEqual(db.getDictionaryPins(), ["epsilon prime"]);
  // A case-only change keeps the same key.
  db.upsertDictionaryFromCloud({
    id: "cloud-eps",
    client_dict_id: epsilon.client_dict_id,
    word: "EPSILON PRIME",
    source: "manual",
    updated_at: "2099-01-02T00:00:00.000Z",
  });
  assert.deepEqual(db.getDictionaryPins(), ["epsilon prime"]);
});

test("suggestions: upsert, dismiss for good, accept idempotently, suggest again after removal", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db } = ctx;
  db.applyDictionaryChanges({ add: ["Known"] });

  const first = db.recordDictionarySuggestions(["Scout Web", "known", "Kiri"]);
  assert.deepEqual(
    first.map((s) => s.word),
    ["Scout Web", "Kiri"],
    "a word already in the dictionary is never suggested"
  );
  db.recordDictionarySuggestions(["scout web"]);
  let list = db.getDictionarySuggestions();
  assert.equal(list.suggestions.find((s) => s.word_key === "scout web").times, 2);

  const kiri = first.find((s) => s.word === "Kiri").id;
  assert.equal(db.dismissDictionarySuggestions([kiri]).dismissed, 1);
  assert.deepEqual(db.recordDictionarySuggestions(["Kiri"]), [], "dismissed: never again");
  assert.equal(db.getDictionarySuggestions().dismissed, 1);

  const scout = first.find((s) => s.word === "Scout Web").id;
  const accepted = db.acceptDictionarySuggestions([scout]);
  assert.deepEqual(accepted.accepted, ["scout web"], "the newest spelling");
  assert.equal(accepted.added, 1);
  assert.deepEqual(
    db.getDictionaryEntries().find((e) => e.word === "scout web"),
    { word: "scout web", source: "learned" }
  );
  assert.deepEqual(
    db.acceptDictionarySuggestions([scout]).accepted,
    [],
    "accepting twice: nothing"
  );
  assert.equal(db.getDictionary().filter((w) => w.toLowerCase() === "scout web").length, 1);
  assert.deepEqual(db.recordDictionarySuggestions(["Scout Web"]), [], "in the dictionary now");

  db.applyDictionaryChanges({ remove: ["scout web"] });
  const again = db.recordDictionarySuggestions(["Scout Web"]);
  assert.deepEqual(
    again.map((s) => [s.id, s.word]),
    [[scout, "Scout Web"]],
    "removed and learned again: suggested again"
  );
  list = db.getDictionarySuggestions();
  assert.equal(list.suggestions.find((s) => s.id === scout).times, 1);

  assert.equal(db.clearDismissedDictionarySuggestions().cleared, 1);
  assert.equal(db.recordDictionarySuggestions(["Kiri"]).length, 1, "forgotten: may come back");
});

test("evidence: tied to this owner's dictation of the pasted text, at most 5 per word", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, dictate, state } = ctx;
  const pasted = "Ask CLAUDE web about it.";
  const id = dictate("ask claude web about it", ` ${pasted} `);
  const now = Date.now();
  assert.equal(db.findEvidenceTranscription("account:a", pasted, now), id);
  assert.equal(db.findEvidenceTranscription("account:b", pasted, now), null, "another owner's");
  assert.equal(db.findEvidenceTranscription("account:a", "Something else.", now), null);
  assert.equal(
    db.findEvidenceTranscription("account:a", pasted, now + 11 * 60 * 1000),
    null,
    "saved more than 10 minutes before the paste"
  );
  // A failed row isn't a dictation the user edited.
  state.owner = "account:a";
  const failed = dictate("ask claude web", "Ask CLAUDE web.", { row: { status: "failed" } });
  assert.equal(db.findEvidenceTranscription("account:a", "Ask CLAUDE web.", now), null);
  void failed;

  for (let i = 0; i < 7; i += 1) {
    assert.equal(
      db.addDictionaryWordEvidence({
        word: "Scout Web",
        owner: "account:a",
        transcriptionId: id,
        replaced: `CLAUDE web ${i}`,
        app: "github.exe",
        now: `2026-10-30T10:00:0${i}.000Z`,
      }),
      true
    );
  }
  db.addDictionaryWordEvidence({
    word: "Scout Web",
    owner: "account:b",
    transcriptionId: id,
    replaced: "x".repeat(500),
    app: null,
  });
  const mine = db.getDictionaryWordEvidence("account:a", ["scout web"]);
  assert.equal(mine.length, 5, "the oldest go");
  assert.equal(mine[0].replaced, "CLAUDE web 6");
  assert.equal(mine[0].app, "github.exe");
  const theirs = db.getDictionaryWordEvidence("account:b");
  assert.equal(theirs.length, 1, "read only for its owner");
  assert.equal(theirs[0].replaced.length, 200, "capped");
});

test("evidence retires with History: cascade, tombstone, clear-all, expiry, account deletion", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, dictate, evidenceRows } = ctx;
  const add = (transcriptionId, owner = "account:a") =>
    db.addDictionaryWordEvidence({
      word: "Scout Web",
      owner,
      transcriptionId,
      replaced: "CLAUDE web",
      app: null,
    });
  const count = (id) => evidenceRows().filter((row) => row.transcription_id === id).length;

  // A physical delete (never synced) cascades.
  const local = dictate("one", "One.");
  add(local);
  db.deleteTranscription(local);
  assert.equal(count(local), 0);

  // A synced row is tombstoned: its evidence goes in the same transaction.
  const synced = dictate("two", "Two.");
  add(synced);
  db.markTranscriptionSynced(synced, "cloud-two");
  db.deleteTranscription(synced);
  assert.ok(db.getTranscriptionById(synced).deleted_at);
  assert.equal(count(synced), 0);

  // A cloud deletion pull deletes the row physically.
  const pulled = dictate("three", "Three.");
  add(pulled);
  db.hardDeleteTranscription(pulled);
  assert.equal(count(pulled), 0);

  // Expiry, for tombstoned and physically deleted rows alike.
  const old = dictate("four", "Four.");
  const oldSynced = dictate("five", "Five.");
  add(old);
  add(oldSynced);
  db.markTranscriptionSynced(oldSynced, "cloud-five");
  db.db
    .prepare(
      "UPDATE transcriptions SET created_at = datetime('now', '-10 days') WHERE id IN (?, ?)"
    )
    .run(old, oldSynced);
  db.deleteTranscriptionsExpiredBefore(7);
  assert.equal(count(old) + count(oldSynced), 0);

  // Account deletion takes that owner's evidence, never another's.
  const shared = dictate("six", "Six.");
  add(shared, "account:a");
  add(shared, "account:b");
  db.setActiveAccountId("a");
  db.deleteAccountData("a");
  assert.deepEqual(
    evidenceRows().map((row) => row.owner),
    ["account:b"]
  );

  // Clear-all takes everything.
  db.clearTranscriptions();
  assert.equal(evidenceRows().length, 0);
});

test("evidence survives accepting the suggestion", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, dictate } = ctx;
  const id = dictate("ask claude web", "Ask CLAUDE web.");
  const [suggestion] = db.recordDictionarySuggestions(["Scout Web"]);
  db.addDictionaryWordEvidence({
    word: "Scout Web",
    owner: "account:a",
    transcriptionId: id,
    replaced: "CLAUDE web",
    app: "github.exe",
  });
  db.acceptDictionarySuggestions([suggestion.id]);
  assert.equal(db.getDictionaryWordEvidence("account:a", ["scout web"]).length, 1);
});

test("every transcription write bumps the content revision", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, dictate } = ctx;
  const revision = () => db.getHistoryContentRevision();
  const steps = [];
  const start = revision();
  const id = dictate("a", "A.");
  steps.push(revision());
  db.updateTranscriptionText(id, "A!", "a");
  steps.push(revision());
  db.updateTranscriptionStatus(id, "failed");
  steps.push(revision());
  db.markTranscriptionSynced(id, "cloud-a");
  db.deleteTranscription(id);
  steps.push(revision());
  const other = dictate("b", "B.");
  db.hardDeleteTranscription(other);
  steps.push(revision());
  dictate("c", "C.");
  const beforeClear = revision();
  db.clearTranscriptions();
  steps.push(revision());
  assert.ok(revision() > beforeClear, "clear-all");
  let previous = start;
  for (const value of steps) {
    assert.ok(value > previous, `${value} > ${previous}`);
    previous = value;
  }
});

test("usage reads completed, recent dictations, never translations or the assistant's", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, dictate } = ctx;
  dictate("open whisper is fine", "OpenWhispr is fine.");
  dictate("open whisper translated", "OpenWhispr übersetzt.", {
    row: { routeKind: "translation" },
  });
  dictate("hey jarvis open whisper", "OpenWhispr opened.", { route: "agent" });
  dictate("open whisper voice", "OpenWhispr voice.", { voiceAgent: true, route: "skip" });
  dictate("open whisper failed", "OpenWhispr failed.", { row: { status: "failed" } });
  const old = dictate("open whisper old", "OpenWhispr old.");
  db.db
    .prepare("UPDATE transcriptions SET created_at = datetime('now', '-91 days') WHERE id = ?")
    .run(old);
  const deleted = dictate("open whisper deleted", "OpenWhispr deleted.");
  db.deleteTranscription(deleted);
  db.saveTranscription("OpenWhispr without raw.", null);

  const usage = computeDictionaryUsage(db, ["OpenWhispr"], { owner: "account:a" });
  assert.equal(usage.rows, 1);
  assert.deepEqual(usage.words, [{ word: "OpenWhispr", heard: 0, written: 1, missedRows: 1 }]);
});

test("the usage service recomputes after Re-transcribe and Re-run cleanup rewrite a row", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, dictate, history } = ctx;
  db.applyDictionaryChanges({ add: ["OpenWhispr"] });
  let now = Date.now();
  const service = createDictionaryUsageService({
    db,
    getOwner: () => "account:a",
    getPolicy: () => ({ synced: true, enabled: true, forcedOff: false, resolved: true }),
    now: () => now,
  });
  const id = dictate("open whisper", "OpenWhispr.");
  const first = await service.get();
  assert.deepEqual(first.words[0], { word: "OpenWhispr", heard: 0, written: 1, missedRows: 1 });

  // Re-transcribe's new raw transcript (saveRetranscription → updateTranscriptionText).
  now += 31_000;
  const run = history.beginRun({ transcriptionId: id });
  history.saveRetranscription(id, {
    text: "openwhispr",
    provider: "groq",
    model: "whisper",
    isCurrent: history.currentRunCheck(run),
  });
  const afterRetranscribe = await service.get();
  assert.deepEqual(afterRetranscribe.words[0], {
    word: "OpenWhispr",
    heard: 1,
    written: 1,
    missedRows: 0,
  });

  // Re-run cleanup's rewrite (completeRetry with its trace).
  now += 31_000;
  const rerun = history.beginRun({ transcriptionId: id });
  const result = history.completeRetry(id, "Nothing about it.", "openwhispr", {
    trace: { ...makeTrace({ raw: "openwhispr", final: "Nothing about it." }), runId: rerun },
  });
  assert.equal(result.success, true);
  const afterRerun = await service.get();
  assert.deepEqual(afterRerun.words[0], {
    word: "OpenWhispr",
    heard: 1,
    written: 0,
    missedRows: 0,
  });
});
