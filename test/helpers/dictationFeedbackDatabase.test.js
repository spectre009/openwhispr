const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const { createStepHistory, createStepRunRegistry } = require("../../src/helpers/stepHistory.js");
const { createHistoryBrowser } = require("../../src/helpers/historyBrowser.js");
const { createDictationFeedback } = require("../../src/helpers/dictationFeedback.js");
const { createDictationReview } = require("../../src/helpers/dictationReview.js");

// Dictation reviews against a real database: the table, owner-scoped saves
// tied to the row's revision, main's validation and durable gate, every path
// that deletes a row, its text or its steps deleting its reviews in the same
// transaction, the list's rating and Flagged filter, and the dictation the
// review hotkey opens. Synthetic text only.

const STEP = (kind, output, extra = {}) => ({
  kind,
  outcome: "ok",
  output,
  provider: null,
  model: null,
  ms: 10,
  ...extra,
});

const STEPS = [
  STEP("stt", "hello there"),
  STEP("glossary", "hello there", { outcome: "skipped" }),
  STEP("cleanup", "hello there."),
  STEP("cleanup", "Hello there."),
  STEP("finalize", "Hello there."),
];

const DURABLE = { synced: true, enabled: true, forcedOff: false, resolved: true };

function setup(t, { owner = "account:a" } = {}) {
  const db = createDb(t);
  if (!db) return null;
  const state = { owner, policy: { ...DURABLE } };
  const stepHistory = createStepHistory({
    db,
    getOwner: () => state.owner,
    isEnabled: () => true,
    runs: createStepRunRegistry(),
  });
  const changes = [];
  const feedback = createDictationFeedback({
    db,
    getOwner: () => stepHistory.currentOwner(),
    getPolicy: () => state.policy,
    onChange: (change) => changes.push(change),
    now: () => new Date("2026-10-24T12:00:00.000Z"),
  });
  const browser = createHistoryBrowser({ db, stepHistory, feedback });

  const trace = (steps, extra = {}) => ({
    version: 1,
    runId: stepHistory.beginRun(extra.retryOf ? { transcriptionId: extra.retryOf } : {}),
    context: { targetApp: "Code.exe", intents: {} },
    route: extra.route ?? "cleanup",
    glossary: { revision: 1, rulesFired: [] },
    steps,
  });

  // A dictation saved the way db-save-transcription saves it.
  const dictate = ({
    final = "Hello there.",
    raw = "hello there",
    steps = STEPS,
    status,
    route,
    timestamp,
  } = {}) => {
    const options = status ? { status } : {};
    const id = steps
      ? stepHistory.saveTranscription(final, raw, { ...options, trace: trace(steps, { route }) }).id
      : db.saveTranscription(final, raw, options).id;
    if (timestamp) {
      db.db.prepare("UPDATE transcriptions SET timestamp = ? WHERE id = ?").run(timestamp, id);
    }
    return Number(id);
  };

  const revisionOf = (id) => browser.getItem(id).revision;
  const review = (id, fields = {}) =>
    feedback.save({
      id,
      revision: revisionOf(id),
      verdict: "bad",
      stage: { kind: "cleanup", seq: 3 },
      expectedText: "Hello, there!",
      note: "it dropped the comma",
      ...fields,
    });
  const count = (owner) =>
    owner
      ? db.db.prepare("SELECT COUNT(*) AS n FROM dictation_feedback WHERE owner = ?").get(owner).n
      : db.db.prepare("SELECT COUNT(*) AS n FROM dictation_feedback").get().n;

  return {
    db,
    state,
    stepHistory,
    feedback,
    browser,
    changes,
    trace,
    dictate,
    revisionOf,
    review,
    count,
  };
}

test("the table is created once, tied to its dictation", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  assert.equal(ctx.db.dictationFeedbackReady, true);
  // Startup runs it again on every launch.
  ctx.db._initDictationFeedback();
  ctx.db._initDictationFeedback();
  const keys = ctx.db.db.prepare("PRAGMA foreign_key_list(dictation_feedback)").all();
  assert.deepEqual(
    keys.map((key) => [key.table, key.from, key.on_delete]),
    [["transcriptions", "transcription_id", "CASCADE"]]
  );
  const id = ctx.dictate();
  assert.equal(ctx.review(id).success, true);
  ctx.db._initDictationFeedback();
  assert.equal(ctx.count(), 1, "re-running the setup keeps saved reviews");
});

test("reviews are saved, read and deleted for the current owner only", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate();
  const saved = ctx.review(id);
  assert.equal(saved.success, true);
  assert.deepEqual(
    { ...saved.feedback, createdAt: undefined, updatedAt: undefined },
    {
      revision: ctx.revisionOf(id),
      verdict: "bad",
      stage: { kind: "cleanup", seq: 3 },
      expectedText: "Hello, there!",
      note: "it dropped the comma",
      createdAt: undefined,
      updatedAt: undefined,
    }
  );
  assert.deepEqual(ctx.changes, [{ id }]);
  assert.deepEqual(ctx.feedback.get(id).feedback, saved.feedback);
  assert.deepEqual(ctx.browser.getItem(id).feedback, saved.feedback);

  // Another sign-in sees none of it, and its own review is its own.
  ctx.state.owner = "account:b";
  assert.equal(ctx.feedback.get(id).feedback, null);
  assert.equal(ctx.browser.getItem(id).feedback, null);
  assert.equal(ctx.browser.list({}).rows[0].rating, null);
  // Its revision has no steps of b's: a review is of what that owner can see.
  assert.notEqual(ctx.revisionOf(id), saved.feedback.revision);
  assert.equal(ctx.review(id, { stage: { kind: "cleanup", seq: 3 } }).code, "INVALID_STAGE");
  assert.equal(ctx.review(id, { verdict: "good" }).success, true);
  assert.equal(ctx.count("account:a"), 1);
  assert.equal(ctx.count("account:b"), 1);
  assert.equal(ctx.feedback.remove(id).removed, true);
  assert.equal(ctx.count("account:a"), 1, "deleting b's review leaves a's");

  // Saving again replaces the owner's review (one per owner and row).
  ctx.state.owner = "account:a";
  const again = ctx.review(id, { stage: { kind: "delivery", seq: null }, note: null });
  assert.equal(again.success, true);
  assert.equal(ctx.count("account:a"), 1);
  assert.deepEqual(again.feedback.stage, { kind: "delivery", seq: null });
  assert.equal(again.feedback.note, null);

  // Signed out is its own owner: an account's reviews never show there.
  ctx.state.owner = "signed-out";
  assert.equal(ctx.feedback.get(id).feedback, null);
  ctx.state.owner = null;
  assert.equal(ctx.feedback.save({ id }).code, "OWNER_UNKNOWN");
});

test("main validates what is saved", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate();
  const old = ctx.dictate({ steps: null, final: "Old one.", raw: "old one" });

  // The revision the form was opened on.
  assert.equal(ctx.review(id, { revision: "0".repeat(32) }).code, "STALE");
  assert.equal(ctx.review(id, { revision: "" }).code, "INVALID");
  // Only a step the owner recorded for that row, by kind and seq.
  assert.equal(ctx.review(id, { stage: { kind: "cleanup", seq: 9 } }).code, "INVALID_STAGE");
  assert.equal(ctx.review(id, { stage: { kind: "style", seq: 2 } }).code, "INVALID_STAGE");
  assert.equal(ctx.review(id, { stage: { kind: "cleanup", seq: null } }).code, "INVALID_STAGE");
  assert.equal(ctx.review(id, { stage: { kind: "delivery", seq: 0 } }).code, "INVALID_STAGE");
  assert.equal(ctx.review(id, { stage: { kind: "nonsense", seq: null } }).code, "INVALID_STAGE");
  assert.equal(ctx.review(old, { stage: { kind: "stt", seq: 0 } }).code, "INVALID_STAGE");
  assert.equal(ctx.review(old, { stage: { kind: "unsure", seq: null } }).success, true);
  // The second cleanup step is its own chip.
  assert.equal(ctx.review(id, { stage: { kind: "cleanup", seq: 2 } }).success, true);
  // Verdicts, types and lengths.
  assert.equal(ctx.review(id, { verdict: "meh" }).code, "INVALID");
  assert.equal(ctx.review(id, { expectedText: 42 }).code, "INVALID");
  assert.equal(ctx.review(id, { expectedText: "x".repeat(100_001) }).code, "TOO_LONG");
  assert.equal(
    ctx.feedback.save({ id: 9999, revision: "0".repeat(32), verdict: "bad" }).code,
    "NOT_FOUND"
  );
  assert.equal(ctx.review(0).code, "INVALID");

  // A note is one short line; a correction equal to the final text is none.
  const noted = ctx.review(id, { note: ` line one\n line two ${"y".repeat(600)}` });
  assert.equal(noted.feedback.note.length, 500);
  assert.ok(noted.feedback.note.startsWith("line one line two"));
  assert.equal(ctx.review(id, { expectedText: "Hello there." }).feedback.expectedText, null);
  // A good review keeps no step and no correction.
  const good = ctx.review(id, { verdict: "good" });
  assert.deepEqual([good.feedback.stage, good.feedback.expectedText], [null, null]);

  // Discarded and deleted rows can't be reviewed.
  const discarded = ctx.dictate({ status: "discarded" });
  assert.equal(ctx.review(discarded, { stage: null }).code, "NOT_FOUND");
});

test("reviews are saved only while history is durable for the owner", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate();
  for (const [policy, reason] of [
    [{ synced: false }, "pending"],
    [{ enabled: false }, "history-off"],
    [{ resolved: false }, "pending"],
    [{ forcedOff: true }, "policy-off"],
  ]) {
    ctx.state.policy = { ...DURABLE, ...policy };
    const refused = ctx.review(id);
    assert.deepEqual(
      [refused.success, refused.code, refused.reason],
      [false, "HISTORY_OFF", reason]
    );
  }
  assert.equal(ctx.count(), 0, "nothing is kept, not even for the session");
  assert.deepEqual(ctx.changes, []);

  // Signed out has no managed policy to wait for.
  ctx.state.owner = "signed-out";
  ctx.state.policy = { ...DURABLE, resolved: false };
  assert.equal(ctx.review(id, { stage: null }).success, true);
});

test("every way a dictation, its text or its steps change deletes its reviews", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db } = ctx;
  const reviewed = (fields) => {
    const id = ctx.dictate(fields);
    assert.equal(ctx.review(id, { stage: null }).success, true);
    return id;
  };
  const has = (id) =>
    db.db.prepare("SELECT COUNT(*) AS n FROM dictation_feedback WHERE transcription_id = ?").get(id)
      .n > 0;
  const syncedRow = (id) => db.markTranscriptionSynced(id, `cloud-${id}`);

  // A retry replaces the text and the steps together.
  const retried = reviewed();
  const completion = ctx.stepHistory.completeRetry(retried, "Hello there!", "hello there", {
    trace: ctx.trace(STEPS, { retryOf: retried }),
  });
  assert.equal(completion.stepsSaved, true);
  assert.equal(has(retried), false, "retry");

  // A retry with the same text still replaces the steps.
  const sameText = reviewed();
  ctx.stepHistory.completeRetry(sameText, "Hello there.", "hello there", {
    trace: ctx.trace(STEPS, { retryOf: sameText }),
  });
  assert.equal(has(sameText), false, "step replacement");

  // Text rewritten without a trace; the same text again keeps the review.
  const rewritten = reviewed();
  db.updateTranscriptionText(rewritten, "Hello there.", "hello there");
  assert.equal(has(rewritten), true, "an unchanged text keeps it");
  db.updateTranscriptionText(rewritten, "Something else.", "something else");
  assert.equal(has(rewritten), false, "text replacement");

  // A failed dictation re-transcribed.
  const failed = reviewed({ status: "failed", final: "", raw: null, steps: null });
  db.updateTranscriptionStatus(failed, "completed");
  assert.equal(has(failed), false, "status change");

  // Physical delete (cascade) and tombstone.
  const unsynced = reviewed();
  db.deleteTranscription(unsynced);
  assert.equal(has(unsynced), false, "physical delete");
  const tombstoned = reviewed();
  syncedRow(tombstoned);
  db.deleteTranscription(tombstoned);
  assert.ok(db.db.prepare("SELECT deleted_at FROM transcriptions WHERE id = ?").get(tombstoned));
  assert.equal(has(tombstoned), false, "tombstone");

  // A cloud deletion pull, and a changed cloud copy.
  const pulled = reviewed();
  db.hardDeleteTranscription(pulled);
  assert.equal(has(pulled), false, "cloud deletion");
  const cloud = reviewed();
  const clientId = db.getTranscriptionById(cloud).client_transcription_id;
  const copy = (text) => ({
    id: `cloud-${cloud}`,
    client_transcription_id: clientId,
    text,
    raw_text: "hello there",
    status: "completed",
    created_at: "2026-10-24T10:00:00.000Z",
  });
  db.upsertTranscriptionFromCloud(copy("Hello there."));
  assert.equal(has(cloud), true, "the same cloud copy keeps it");
  db.upsertTranscriptionFromCloud(copy("Hello there, edited elsewhere."));
  assert.equal(has(cloud), false, "changed cloud copy");

  // Expiry: a tombstoned (synced) row and a hard-deleted one.
  const expiredSynced = reviewed();
  const expiredLocal = reviewed();
  syncedRow(expiredSynced);
  db.db
    .prepare(
      "UPDATE transcriptions SET created_at = datetime('now', '-90 days') WHERE id IN (?, ?)"
    )
    .run(expiredSynced, expiredLocal);
  const kept = reviewed();
  db.deleteTranscriptionsExpiredBefore(30);
  assert.equal(has(expiredSynced), false, "expiry (tombstone)");
  assert.equal(has(expiredLocal), false, "expiry (delete)");
  assert.equal(has(kept), true, "a row inside the window keeps it");

  // Clear all.
  syncedRow(kept);
  reviewed();
  db.clearTranscriptions();
  assert.equal(ctx.count(), 0, "clear all");
});

test("deleting an account deletes its reviews and no one else's", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate();
  assert.equal(ctx.review(id).success, true);
  ctx.state.owner = "signed-out";
  assert.equal(ctx.review(id, { stage: null }).success, true);
  ctx.state.owner = "account:b";
  assert.equal(ctx.review(id, { stage: null }).success, true);

  ctx.db.setActiveAccountId("a");
  ctx.db.deleteAccountData("a");
  assert.equal(ctx.count("account:a"), 0);
  assert.equal(ctx.count("signed-out"), 1);
  assert.equal(ctx.count("account:b"), 1);

  // Signing in again adopts nothing from signed-out.
  ctx.state.owner = "account:a";
  assert.equal(ctx.feedback.get(id).feedback, null);
});

test("the list carries the owner's rating, and Flagged lists what they marked bad", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const bad = ctx.dictate({ timestamp: "2026-10-24 10:00:03" });
  const good = ctx.dictate({ timestamp: "2026-10-24 10:00:02" });
  const unrated = ctx.dictate({ timestamp: "2026-10-24 10:00:01" });
  const oldBad = ctx.dictate({ steps: null, timestamp: "2026-10-24 10:00:00" });
  assert.equal(ctx.review(bad).success, true);
  assert.equal(ctx.review(good, { verdict: "good" }).success, true);
  assert.equal(ctx.review(oldBad, { stage: null }).success, true);

  const ratings = (request) => ctx.browser.list(request).rows.map((row) => [row.id, row.rating]);
  assert.deepEqual(ratings({}), [
    [bad, "bad"],
    [good, "good"],
    [unrated, null],
    [oldBad, "bad"],
  ]);
  assert.deepEqual(ratings({ filters: { flagged: true } }), [
    [bad, "bad"],
    [oldBad, "bad"],
  ]);
  // Flagged combines with the other criteria and pages like the rest.
  assert.deepEqual(ratings({ filters: { flagged: true, cleanupChanged: true } }), [[bad, "bad"]]);
  const first = ctx.browser.list({ limit: 1, filters: { flagged: true } });
  assert.deepEqual(
    ctx.browser
      .list({ limit: 1, cursor: first.nextCursor, filters: { flagged: true } })
      .rows.map((row) => row.id),
    [oldBad]
  );

  // Another owner: no ratings, nothing flagged.
  ctx.state.owner = "account:b";
  assert.deepEqual(
    ratings({}).map(([, rating]) => rating),
    [null, null, null, null]
  );
  assert.deepEqual(ratings({ filters: { flagged: true } }), []);
});

test("the review hotkey opens the owner's last ordinary dictation, failures included", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const review = createDictationReview({
    windowManager: {},
    db: ctx.db,
    getOwner: () => ctx.stepHistory.currentOwner(),
  });
  assert.equal(review.resolveTarget(), null, "nothing yet");

  const ordinary = ctx.dictate({ timestamp: "2026-10-24 10:00:01" });
  assert.equal(review.resolveTarget(), ordinary);

  // Newer, but not what the hotkey reviews: the assistant, a discarded or
  // deleted dictation, one without steps, or another owner's.
  ctx.dictate({ route: "agent", timestamp: "2026-10-24 10:00:02" });
  ctx.dictate({ status: "discarded", timestamp: "2026-10-24 10:00:03" });
  const deleted = ctx.dictate({ timestamp: "2026-10-24 10:00:04" });
  ctx.db.deleteTranscription(deleted);
  ctx.dictate({ steps: null, timestamp: "2026-10-24 10:00:05" });
  ctx.state.owner = "account:b";
  const othersId = ctx.dictate({ timestamp: "2026-10-24 10:00:06" });
  assert.equal(review.resolveTarget(), othersId, "b's own");
  ctx.state.owner = "account:a";
  assert.equal(review.resolveTarget(), ordinary);

  // A failed one counts; the History view's order decides between equal times.
  const failed = ctx.dictate({
    status: "failed",
    final: "",
    timestamp: "2026-10-24 10:00:07",
  });
  assert.equal(review.resolveTarget(), failed);
  const sameTime = ctx.dictate({ timestamp: "2026-10-24 10:00:07" });
  assert.equal(review.resolveTarget(), sameTime);

  ctx.state.owner = null;
  assert.equal(review.resolveTarget(), null, "no owner, nothing to open");
});
