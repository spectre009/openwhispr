const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");
const { createStepHistory, createStepRunRegistry } = require("../../src/helpers/stepHistory.js");

// Step history's lifecycle against a real database: steps are written in the
// dictation's transaction, owned by the account (or signed-out namespace) the
// run began under, removed with the row however it goes (tombstone, cascade,
// expiry, clear-all, cloud deletion, account deletion), replaced atomically by
// a retry, and never exported across owners. Synthetic text only.

const PROMPT_A = "Clean up this transcript for Jarvis. (prompt A)";
const PROMPT_B = "Restyle this dictation for Teams. (prompt B)";

function makeTrace({
  raw = "um hello littlebuddy",
  working = "um hello Little Buddy",
  final = "Hello, Little Buddy.",
  prompt = PROMPT_A,
  runId,
} = {}) {
  return {
    version: 1,
    rawText: raw,
    workingText: working,
    finalText: final,
    context: {
      targetApp: "Code.exe",
      intents: { voiceAgent: false, translation: false, wakeWord: false },
    },
    route: "cleanup",
    glossary: {
      revision: 4,
      rulesFired: [
        {
          ruleId: "rule-1",
          spelling: "littlebuddy",
          scope: "anywhere",
          from: "littlebuddy",
          to: "Little Buddy",
          index: 9,
        },
      ],
    },
    steps: [
      { kind: "stt", outcome: "ok", output: raw, provider: "groq", model: "whisper", ms: 800 },
      { kind: "glossary", outcome: "ok", output: working, provider: null, model: null, ms: 1 },
      {
        kind: "cleanup",
        outcome: "ok",
        output: final,
        provider: "copilot",
        model: "claude-haiku-5.5",
        ms: 1400,
        prompt: { source: "resolved", text: prompt, entryId: "migrated" },
      },
      { kind: "finalize", outcome: "ok", output: final, provider: null, model: null, ms: 0 },
    ],
    ...(runId ? { runId } : {}),
  };
}

function setup(t, { owner = "account:a", enabled = true } = {}) {
  const db = createDb(t);
  if (!db) return null;
  const state = { owner, enabled };
  const history = createStepHistory({
    db,
    getOwner: () => state.owner,
    isEnabled: () => state.enabled,
    runs: createStepRunRegistry(),
  });
  // One dictation, saved the way db-save-transcription saves it.
  const dictate = (traceOptions = {}, rowOptions = {}) => {
    const runId = history.beginRun();
    const trace = makeTrace({ ...traceOptions, runId });
    return history.saveTranscription(trace.finalText, trace.rawText, {
      ...rowOptions,
      trace,
    }).id;
  };
  const stepCount = (id) =>
    db.db
      .prepare("SELECT COUNT(*) AS n FROM transcription_steps WHERE transcription_id = ?")
      .get(id).n;
  const allSteps = () => db.db.prepare("SELECT COUNT(*) AS n FROM transcription_steps").get().n;
  const prompts = () =>
    db.db
      .prepare("SELECT text FROM prompt_versions ORDER BY text")
      .all()
      .map((row) => row.text);
  const row = (id) => db.db.prepare("SELECT * FROM transcriptions WHERE id = ?").get(id);
  return { db, state, history, dictate, stepCount, allSteps, prompts, row };
}

test("foreign keys are on after migrations, and a second launch keeps the tables", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  assert.equal(ctx.db.db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(ctx.db.stepHistoryReady, true);
  const id = ctx.dictate();

  const reopened = new DatabaseManager();
  try {
    assert.equal(reopened.db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(reopened.stepHistoryReady, true);
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS n FROM transcription_steps").get().n,
      ctx.stepCount(id),
      "re-running the migration keeps existing steps"
    );
  } finally {
    reopened.db.close();
  }
});

test("a dictation's steps and prompt are saved with its row, for its owner only", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate();
  assert.equal(ctx.row(id).text, "Hello, Little Buddy.");
  assert.equal(ctx.stepCount(id), 4);
  assert.deepEqual(ctx.prompts(), [PROMPT_A]);

  const mine = ctx.history.getSteps(id);
  assert.equal(mine.status, "captured");
  assert.equal(mine.route, "cleanup");
  assert.equal(mine.context.targetApp, "Code.exe");
  assert.deepEqual(
    mine.steps.map((step) => [step.kind, step.outcome, step.output]),
    [
      ["stt", "ok", "um hello littlebuddy"],
      ["glossary", "ok", "um hello Little Buddy"],
      ["cleanup", "ok", "Hello, Little Buddy."],
      ["finalize", "ok", "Hello, Little Buddy."],
    ]
  );
  const cleanup = mine.steps[2];
  assert.deepEqual(
    { provider: cleanup.provider, model: cleanup.model, ms: cleanup.ms },
    { provider: "copilot", model: "claude-haiku-5.5", ms: 1400 }
  );
  assert.equal(cleanup.prompt.source, "resolved");
  assert.equal(cleanup.prompt.text, PROMPT_A);
  assert.equal(cleanup.prompt.entryId, "migrated");
  assert.equal(mine.steps[1].detail.rulesFired.length, 1);

  ctx.state.owner = "account:b";
  assert.deepEqual(ctx.history.getSteps(id), {
    status: "otherOwner",
    route: null,
    context: null,
    steps: [],
  });
  ctx.state.owner = "signed-out";
  assert.equal(ctx.history.getSteps(id).status, "otherOwner");
});

test("old rows and rows without a trace show no steps", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { id } = ctx.db.saveTranscription("from before step history", "raw");
  assert.equal(ctx.history.getSteps(id).status, "none");
  assert.equal(ctx.history.getSteps(424242).status, "none");
});

test("a null raw transcript stays null: no invented stt step", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const runId = ctx.history.beginRun();
  const { id } = ctx.history.saveTranscription("Final.", null, {
    trace: makeTrace({ runId }),
  });
  assert.equal(ctx.row(id).raw_text, null);
  assert.deepEqual(
    ctx.history.getSteps(id).steps.map((step) => step.kind),
    ["glossary", "cleanup", "finalize"]
  );
});

test("unsynced delete: the row and its steps go, and the unused prompt with them", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate();
  assert.equal(ctx.db.deleteTranscription(id).success, true);
  assert.equal(ctx.row(id), undefined);
  assert.equal(ctx.stepCount(id), 0, "ON DELETE CASCADE");
  assert.deepEqual(ctx.prompts(), [], "the last reference took the prompt version");
});

test("synced delete: the tombstone and the step deletion happen together", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate();
  ctx.db.markTranscriptionSynced(id, "cloud-1");
  assert.equal(ctx.db.deleteTranscription(id).success, true);
  const tombstone = ctx.row(id);
  assert.ok(tombstone.deleted_at, "a synced row is only marked");
  assert.equal(tombstone.sync_status, "pending");
  assert.equal(ctx.stepCount(id), 0);
  assert.deepEqual(ctx.prompts(), []);
  assert.equal(ctx.history.getSteps(id).status, "none");
});

test("a prompt version stays while any step in any account still uses it", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const first = ctx.dictate();
  ctx.state.owner = "account:b";
  const second = ctx.dictate();
  assert.deepEqual(ctx.prompts(), [PROMPT_A], "stored once, by hash");
  ctx.db.deleteTranscription(first);
  assert.deepEqual(ctx.prompts(), [PROMPT_A], "account b's step still references it");
  ctx.db.deleteTranscription(second);
  assert.deepEqual(ctx.prompts(), []);
});

test("expiry: synced and unsynced rows past the window lose their steps", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const oldLocal = ctx.dictate();
  const oldSynced = ctx.dictate();
  const fresh = ctx.dictate({ prompt: PROMPT_B });
  ctx.db.markTranscriptionSynced(oldSynced, "cloud-2");
  ctx.db.db
    .prepare(
      "UPDATE transcriptions SET created_at = datetime('now', '-10 days') WHERE id IN (?, ?)"
    )
    .run(oldLocal, oldSynced);

  const { ids } = ctx.db.deleteTranscriptionsExpiredBefore(7);
  assert.deepEqual(ids.sort(), [oldLocal, oldSynced].sort());
  assert.equal(ctx.row(oldLocal), undefined);
  assert.ok(ctx.row(oldSynced).deleted_at);
  assert.equal(ctx.stepCount(oldLocal), 0);
  assert.equal(ctx.stepCount(oldSynced), 0);
  assert.equal(ctx.stepCount(fresh), 4);
  assert.deepEqual(ctx.prompts(), [PROMPT_B]);
});

test("clear-all removes every step in every account, synced or not", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const synced = ctx.dictate();
  ctx.db.markTranscriptionSynced(synced, "cloud-3");
  ctx.dictate({ prompt: PROMPT_B });
  ctx.state.owner = "signed-out";
  ctx.dictate();

  ctx.db.clearTranscriptions();
  assert.ok(ctx.row(synced).deleted_at);
  assert.equal(ctx.allSteps(), 0);
  assert.deepEqual(ctx.prompts(), []);
});

test("cloud deletions pulled from the cloud cascade, and a changed cloud copy drops stale steps", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  // SyncService: a pulled cloud row with deleted_at hard-deletes the local one.
  const pulledDelete = ctx.dictate();
  ctx.db.markTranscriptionSynced(pulledDelete, "cloud-4");
  assert.equal(ctx.db.hardDeleteTranscription(pulledDelete).success, true);
  assert.equal(ctx.stepCount(pulledDelete), 0);

  // The delete pusher: a tombstone, then the hard delete once the cloud confirms.
  const pushed = ctx.dictate({ prompt: PROMPT_B });
  ctx.db.markTranscriptionSynced(pushed, "cloud-5");
  ctx.db.deleteTranscription(pushed);
  ctx.db.hardDeleteTranscription(pushed);
  assert.equal(ctx.row(pushed), undefined);
  assert.deepEqual(ctx.prompts(), [], "the trigger collected both prompts through the cascade");

  const changed = ctx.dictate({}, { clientTranscriptionId: "client-changed" });
  ctx.db.upsertTranscriptionFromCloud({
    id: "cloud-6",
    client_transcription_id: "client-changed",
    text: "Edited on another device.",
    raw_text: "um hello littlebuddy",
    status: "completed",
    created_at: "2026-10-22T10:00:00.000Z",
  });
  assert.equal(ctx.row(changed).text, "Edited on another device.");
  assert.equal(ctx.stepCount(changed), 0);
});

test("history off: main writes neither steps nor prompt versions", (t) => {
  const ctx = setup(t, { enabled: false });
  if (!ctx) return;
  const id = ctx.dictate();
  assert.ok(ctx.row(id), "the dictation itself follows the renderer's own check");
  assert.equal(ctx.stepCount(id), 0);
  assert.deepEqual(ctx.prompts(), []);

  ctx.state.enabled = true;
  assert.equal(ctx.stepCount(ctx.dictate()), 4);
});

test("an account change mid-run discards the trace but keeps the dictation", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const runId = ctx.history.beginRun();
  ctx.state.owner = "account:b";
  const trace = makeTrace({ runId });
  const { id } = ctx.history.saveTranscription(trace.finalText, trace.rawText, { trace });
  assert.equal(ctx.row(id).text, "Hello, Little Buddy.");
  assert.equal(ctx.stepCount(id), 0);
  assert.deepEqual(ctx.prompts(), []);

  // Signing in is an owner change too: signed-out steps are never adopted.
  ctx.state.owner = "signed-out";
  const signedOutRun = ctx.history.beginRun();
  ctx.state.owner = "account:a";
  const late = makeTrace({ runId: signedOutRun });
  const second = ctx.history.saveTranscription(late.finalText, late.rawText, { trace: late });
  assert.equal(ctx.stepCount(second.id), 0);
});

test("steps need a run main issued, used once; caller-supplied steps are ignored", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const noRun = makeTrace();
  assert.equal(ctx.stepCount(ctx.history.saveTranscription("a", "b", { trace: noRun }).id), 0);
  const unknown = makeTrace({ runId: "not-a-run" });
  assert.equal(ctx.stepCount(ctx.history.saveTranscription("a", "b", { trace: unknown }).id), 0);

  const runId = ctx.history.beginRun();
  const once = makeTrace({ runId });
  assert.equal(ctx.stepCount(ctx.history.saveTranscription("a", "b", { trace: once }).id), 4);
  assert.equal(ctx.stepCount(ctx.history.saveTranscription("a", "b", { trace: once }).id), 0);

  const forged = {
    owner: "account:a",
    version: 1,
    route: null,
    context: null,
    steps: [{ kind: "cleanup", outcome: "ok", output: "forged" }],
  };
  assert.equal(ctx.stepCount(ctx.history.saveTranscription("a", "b", { steps: forged }).id), 0);
});

test("a step that fails to write drops the steps, never the dictation", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { id } = ctx.db.saveTranscription("kept", "kept raw", {
    steps: {
      owner: null, // NOT NULL: the savepoint rolls back
      version: 1,
      route: null,
      context: null,
      steps: [{ kind: "stt", outcome: "ok", output: "kept raw" }],
    },
  });
  assert.equal(ctx.row(id).text, "kept");
  assert.equal(ctx.stepCount(id), 0);
});

test("retry from history replaces the row's trace atomically, and a stale completion is dropped", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate();

  // retry-transcription begins the run, then writes the new raw transcript:
  // the old steps described text that is gone.
  const retryRun = ctx.history.beginRun({ transcriptionId: id });
  ctx.db.updateTranscriptionText(id, "hello there", "hello there");
  assert.equal(ctx.stepCount(id), 0);
  assert.deepEqual(ctx.prompts(), []);

  const retried = makeTrace({
    raw: "hello there",
    working: "hello there",
    final: "Hello there.",
    prompt: PROMPT_B,
    runId: retryRun,
  });
  assert.deepEqual(
    ctx.history.completeRetry(id, "Hello there.", "hello there", { trace: retried }),
    {
      success: true,
      stepsSaved: true,
    }
  );
  assert.equal(ctx.row(id).text, "Hello there.");
  assert.equal(ctx.history.getSteps(id).steps[2].prompt.text, PROMPT_B);
  assert.deepEqual(ctx.prompts(), [PROMPT_B]);

  // Two retries of the same row: the newer one wins whatever order they end in.
  const older = ctx.history.beginRun({ transcriptionId: id });
  const newer = ctx.history.beginRun({ transcriptionId: id });
  const newerTrace = makeTrace({ final: "Newer.", prompt: PROMPT_A, runId: newer });
  assert.equal(
    ctx.history.completeRetry(id, "Newer.", newerTrace.rawText, { trace: newerTrace }).success,
    true
  );
  const olderTrace = makeTrace({ final: "Older.", prompt: PROMPT_B, runId: older });
  assert.deepEqual(
    ctx.history.completeRetry(id, "Older.", olderTrace.rawText, { trace: olderTrace }),
    { success: false, stale: true }
  );
  assert.equal(ctx.row(id).text, "Newer.", "the stale completion wrote nothing");
  assert.equal(ctx.history.getSteps(id).steps[2].output, "Newer.");
  assert.deepEqual(ctx.prompts(), [PROMPT_A]);

  // A run issued for another row can't complete this one.
  const otherRow = ctx.dictate();
  const foreign = ctx.history.beginRun({ transcriptionId: otherRow });
  const foreignTrace = makeTrace({ final: "Foreign.", runId: foreign });
  assert.equal(ctx.history.completeRetry(id, "Foreign.", "x", { trace: foreignTrace }).stale, true);
});

test("a retry with unchanged text still replaces its steps", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate();
  const runId = ctx.history.beginRun({ transcriptionId: id });
  const same = makeTrace({ prompt: PROMPT_B, runId });
  ctx.history.completeRetry(id, same.finalText, same.rawText, { trace: same });
  assert.equal(ctx.stepCount(id), 4);
  assert.deepEqual(ctx.prompts(), [PROMPT_B], "replaced, not appended");
});

// The dictation error card's Retry re-sent a failed recording.
function failedRow(ctx) {
  const { id } = ctx.db.saveTranscription("", null, {
    status: "failed",
    errorMessage: "OpenAI took too long to respond.",
    errorCode: "PROVIDER_TIMEOUT",
    routeKind: "style:teams",
  });
  ctx.db.updateTranscriptionAudio(id, {
    hasAudio: 1,
    audioDurationMs: 4600,
    provider: null,
    model: null,
  });
  return id;
}

test("a re-sent failed dictation becomes its row: text, steps, status and engine", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = failedRow(ctx);
  const runId = ctx.history.beginRun({ transcriptionId: id });
  const trace = makeTrace({ runId });

  const result = ctx.history.completeFailedDictation(id, trace.finalText, trace.rawText, {
    trace,
    provider: "openai",
    model: "gpt-4o-transcribe",
  });

  assert.equal(result.success, true);
  assert.equal(result.stepsSaved, true);
  const row = ctx.row(id);
  assert.equal(row.status, "completed");
  assert.equal(row.text, "Hello, Little Buddy.");
  assert.equal(row.raw_text, "um hello littlebuddy");
  assert.equal(row.error_message, null);
  assert.equal(row.error_code, null);
  assert.equal(row.route_kind, "style:teams");
  assert.equal(row.has_audio, 1, "the recording stays with its row");
  assert.equal(row.audio_duration_ms, 4600);
  assert.equal(row.provider, "openai");
  assert.equal(row.model, "gpt-4o-transcribe");
  assert.equal(ctx.stepCount(id), 4);
  assert.equal(result.transcription.id, id);
  assert.equal(
    ctx.db.db.prepare("SELECT COUNT(*) AS n FROM transcriptions").get().n,
    1,
    "no second row"
  );
});

test("a re-send whose row is gone, completed or overtaken writes nothing", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  assert.deepEqual(ctx.history.completeFailedDictation(424242, "Text.", "text"), {
    success: false,
    code: "NOT_FOUND",
  });

  const tombstoned = failedRow(ctx);
  ctx.db.markTranscriptionSynced(tombstoned, "cloud-1");
  ctx.db.deleteTranscription(tombstoned);
  assert.equal(ctx.history.completeFailedDictation(tombstoned, "Text.", "text").code, "NOT_FOUND");

  // History's Re-transcribe completed it meanwhile.
  const completed = failedRow(ctx);
  ctx.db.updateTranscriptionText(completed, "From History.", "from history");
  ctx.db.updateTranscriptionStatus(completed, "completed");
  assert.deepEqual(ctx.history.completeFailedDictation(completed, "Text.", "text"), {
    success: false,
    stale: true,
  });
  assert.equal(ctx.row(completed).text, "From History.");

  // A newer retry of the row began after this one.
  const overtaken = failedRow(ctx);
  const older = ctx.history.beginRun({ transcriptionId: overtaken });
  ctx.history.beginRun({ transcriptionId: overtaken });
  const trace = makeTrace({ runId: older });
  assert.deepEqual(
    ctx.history.completeFailedDictation(overtaken, trace.finalText, trace.rawText, { trace }),
    { success: false, stale: true }
  );
  const row = ctx.row(overtaken);
  assert.equal(row.status, "failed");
  assert.equal(row.text, "");
  assert.equal(ctx.stepCount(overtaken), 0);
});

test("an account change mid-retry updates the text and leaves no steps", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.dictate();
  const runId = ctx.history.beginRun({ transcriptionId: id });
  ctx.state.owner = "account:b";
  const trace = makeTrace({ final: "Retried.", runId });
  assert.deepEqual(ctx.history.completeRetry(id, "Retried.", trace.rawText, { trace }), {
    success: true,
    stepsSaved: false,
  });
  assert.equal(ctx.row(id).text, "Retried.");
  assert.equal(ctx.stepCount(id), 0);
});

test("account deletion removes that account's steps and nobody else's", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const mine = ctx.dictate({ prompt: PROMPT_B });
  const shared = ctx.dictate({ prompt: PROMPT_A });
  ctx.state.owner = "signed-out";
  const signedOut = ctx.dictate({ prompt: PROMPT_A });
  ctx.state.owner = "account:other";
  const other = ctx.dictate({ prompt: PROMPT_A });

  ctx.db.setActiveAccountId("a");
  ctx.db.deleteAccountData("a");
  assert.equal(ctx.stepCount(mine), 0);
  assert.equal(ctx.stepCount(shared), 0);
  assert.equal(ctx.stepCount(signedOut), 4);
  assert.equal(ctx.stepCount(other), 4);
  assert.ok(ctx.row(mine), "dictations are device-wide and stay");
  assert.deepEqual(ctx.prompts(), [PROMPT_A], "B was account a's alone");
});

test("the export is owner-scoped: every row, but only this owner's steps and prompts", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const mine = ctx.dictate({ working: "MINE-working", prompt: PROMPT_A });
  ctx.state.owner = "account:b";
  const theirs = ctx.dictate({ working: "THEIRS-working", prompt: PROMPT_B });
  const { id: legacy } = ctx.db.saveTranscription("Legacy row.", "legacy raw");
  const failed = ctx.db.saveTranscription("", null, { status: "failed" }).id;
  ctx.state.owner = "account:a";

  const written = [];
  const result = await ctx.history.exportDictations({
    choosePath: async () => "C:/exports/dictations.jsonl",
    writeFile: async (filePath, content) => written.push({ filePath, content }),
    now: () => new Date("2026-10-22T12:00:00.000Z"),
  });
  assert.deepEqual(result, { success: true, dictations: 3, withSteps: 1 });
  assert.equal(written.length, 1);
  const { content } = written[0];
  assert.ok(content.endsWith("\n"));
  const lines = content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(lines[0], {
    type: "export",
    format: "openwhispr.dictations",
    version: 1,
    exportedAt: "2026-10-22T12:00:00.000Z",
    dictations: 3,
    dictationsWithSteps: 1,
    prompts: 1,
  });
  assert.deepEqual(lines[1], {
    type: "prompt",
    hash: lines.find((l) => l.id === mine).steps[2].prompt.hash,
    text: PROMPT_A,
  });
  const dictations = lines.filter((line) => line.type === "dictation");
  assert.deepEqual(
    dictations.map((line) => line.id).sort(),
    [mine, theirs, legacy].sort(),
    "failed rows are left out"
  );
  assert.ok(!dictations.some((line) => line.id === failed));

  const own = dictations.find((line) => line.id === mine);
  assert.equal(own.stepsCaptured, true);
  assert.equal(own.rawText, "um hello littlebuddy");
  assert.equal(own.finalText, "Hello, Little Buddy.");
  assert.equal(own.route, "cleanup");
  assert.equal(own.context.targetApp, "Code.exe");
  assert.deepEqual(
    own.steps.map((step) => step.kind),
    ["stt", "glossary", "cleanup", "finalize"]
  );
  assert.equal(own.steps[2].prompt.text, undefined, "prompt texts live on prompt lines");

  for (const id of [theirs, legacy]) {
    const line = dictations.find((entry) => entry.id === id);
    assert.equal(line.stepsCaptured, false);
    assert.equal(line.steps, null);
  }
  assert.ok(!content.includes("THEIRS-working"), "another owner's steps never leave");
  assert.ok(!content.includes(PROMPT_B), "nor the prompts only they used");
});

test("export: ownership is re-checked after the dialog, and cancel writes nothing", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.dictate();
  const writes = [];
  const writeFile = async (...args) => writes.push(args);

  const switched = await ctx.history.exportDictations({
    choosePath: async () => {
      ctx.state.owner = "account:b";
      return "C:/exports/dictations.jsonl";
    },
    writeFile,
  });
  assert.deepEqual(switched, { success: false, code: "ACCOUNT_CHANGED" });

  const canceled = await ctx.history.exportDictations({ choosePath: async () => null, writeFile });
  assert.deepEqual(canceled, { success: false, canceled: true });
  assert.deepEqual(writes, []);
});
