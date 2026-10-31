const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const { createStepHistory, createStepRunRegistry } = require("../../src/helpers/stepHistory.js");
const { createHistoryBrowser } = require("../../src/helpers/historyBrowser.js");

// The History view's reads against a real database: pages that stay stable
// across equal timestamps and both stored formats, the rows Home would list,
// a search that takes the user's wildcards literally, the filters, and marks,
// apps and steps read for the current owner only. Synthetic text only.

const STEP = (kind, output, extra = {}) => ({
  kind,
  outcome: "ok",
  output,
  provider: null,
  model: null,
  ms: 10,
  ...extra,
});

function setup(t, { owner = "account:a" } = {}) {
  const db = createDb(t);
  if (!db) return null;
  const state = { owner };
  const stepHistory = createStepHistory({
    db,
    getOwner: () => state.owner,
    isEnabled: () => true,
    runs: createStepRunRegistry(),
  });
  const browser = createHistoryBrowser({ db, stepHistory });

  const setTimestamp = (id, timestamp) =>
    db.db.prepare("UPDATE transcriptions SET timestamp = ? WHERE id = ?").run(timestamp, id);

  // A dictation saved the way db-save-transcription saves it, with the current
  // owner's trace when it has steps.
  const dictate = ({
    final = "Hello there.",
    raw = "hello there",
    app = "Code.exe",
    steps,
    timestamp,
    status,
  } = {}) => {
    const options = status ? { status } : {};
    let id;
    if (steps) {
      const trace = {
        version: 1,
        runId: stepHistory.beginRun(),
        context: { targetApp: app, intents: {} },
        route: "cleanup",
        glossary: { revision: 1, rulesFired: [] },
        steps,
      };
      id = stepHistory.saveTranscription(final, raw, { ...options, trace }).id;
    } else {
      id = db.saveTranscription(final, raw, options).id;
    }
    if (timestamp) setTimestamp(id, timestamp);
    return Number(id);
  };

  const cleanedUp = (overrides = {}) =>
    dictate({
      steps: [
        STEP("stt", "hello there"),
        STEP("glossary", "hello there", { outcome: "skipped" }),
        STEP("cleanup", "Hello there."),
        STEP("finalize", "Hello there."),
      ],
      ...overrides,
    });

  const allIds = (request = {}) => {
    const ids = [];
    let cursor = null;
    for (let page = 0; page < 100; page += 1) {
      const result = browser.list({ ...request, cursor });
      assert.equal(result.success, true);
      ids.push(...result.rows.map((row) => row.id));
      if (!result.nextCursor) return ids;
      cursor = result.nextCursor;
    }
    throw new Error("paging never ended");
  };

  return { db, state, browser, dictate, cleanedUp, allIds, setTimestamp };
}

test("pages are stable across equal timestamps and both stored formats", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const stamps = [
    "2026-10-22 10:00:00",
    "2026-10-22 10:00:00.250Z",
    "2026-10-22 10:00:00",
    "2026-10-21 23:59:59.999Z",
    "2026-10-22 10:00:00",
    "2026-10-22 10:00:01",
    "2026-10-22 10:00:00.250Z",
    "2026-08-03 08:00:00",
  ];
  const ids = stamps.map((timestamp, index) =>
    ctx.dictate({ final: `Dictation ${index}.`, timestamp })
  );
  const expected = ids
    .map((id, index) => ({ id, timestamp: stamps[index] }))
    .sort((a, b) =>
      a.timestamp === b.timestamp ? b.id - a.id : a.timestamp < b.timestamp ? 1 : -1
    )
    .map((row) => row.id);

  for (const limit of [1, 2, 3, 50]) {
    assert.deepEqual(ctx.allIds({ limit }), expected, `limit ${limit}`);
  }

  const first = ctx.browser.list({ limit: 3 });
  assert.equal(first.rows.length, 3);
  assert.deepEqual(first.nextCursor, {
    timestamp: "2026-10-22 10:00:00.250Z",
    id: first.rows[2].id,
  });
  const last = ctx.browser.list({
    limit: 3,
    cursor: { timestamp: "2026-08-03 08:00:00", id: ids[7] },
  });
  assert.deepEqual(last, {
    success: true,
    rows: [],
    nextCursor: null,
    generation: ctx.db.getDictionaryGeneration(),
  });
});

test("a new dictation above the cursor doesn't shift the next page", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  for (let index = 0; index < 5; index += 1) {
    ctx.dictate({ final: `Old ${index}.`, timestamp: `2026-10-20 10:00:0${index}` });
  }
  const first = ctx.browser.list({ limit: 2 });
  ctx.dictate({ final: "Brand new.", timestamp: "2026-10-24 12:00:00.000Z" });
  const second = ctx.browser.list({ limit: 2, cursor: first.nextCursor });
  const seen = [...first.rows, ...second.rows].map((row) => row.preview);
  assert.deepEqual(seen, ["Old 4.", "Old 3.", "Old 2.", "Old 1."]);
});

test("rows are what Home lists: discarded, pending and deleted rows are left out", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const completed = ctx.dictate({ final: "Kept." });
  const failed = ctx.dictate({ final: "", raw: null, status: "failed" });
  ctx.dictate({ final: "", raw: null, status: "discarded" });
  ctx.dictate({ final: "", raw: null, status: "pending" });
  const unsynced = ctx.dictate({ final: "Deleted." });
  ctx.db.deleteTranscription(unsynced);
  const synced = ctx.dictate({ final: "Tombstoned." });
  ctx.db.markTranscriptionSynced(synced, "cloud-1");
  ctx.db.deleteTranscription(synced);

  assert.deepEqual(ctx.allIds().sort(), [completed, failed].sort());
  assert.deepEqual(ctx.browser.getItem(synced), { success: false, code: "NOT_FOUND" });
  assert.deepEqual(ctx.browser.getItem(unsynced), { success: false, code: "NOT_FOUND" });
  assert.deepEqual(ctx.browser.getItem(424242), { success: false, code: "NOT_FOUND" });
});

test("a list row is light: a preview cut in SQL, the raw text when there's no final text", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const long = "word ".repeat(200).trim();
  const id = ctx.dictate({ final: long, raw: "raw words" });
  const rawOnly = ctx.dictate({ final: "", raw: "only the raw transcript" });
  const failed = ctx.dictate({ final: "", raw: null, status: "failed" });
  ctx.db.db
    .prepare(
      "UPDATE transcriptions SET error_code = 'TIMEOUT', route_kind = 'style:email' WHERE id = ?"
    )
    .run(failed);

  const rows = new Map(ctx.browser.list().rows.map((row) => [row.id, row]));
  assert.equal(rows.get(id).preview, long.slice(0, 240));
  assert.equal(rows.get(rawOnly).preview, "only the raw transcript");
  assert.deepEqual(rows.get(failed), {
    id: failed,
    timestamp: rows.get(failed).timestamp,
    status: "failed",
    errorCode: "TIMEOUT",
    preview: null,
    hasAudio: false,
    audioDurationMs: null,
    routeKind: "style:email",
    rating: null,
    dictionaryFixes: 0,
    app: null,
    marks: null,
    stepFailure: null,
  });
  for (const row of rows.values()) {
    assert.ok(!("text" in row) && !("rawText" in row), "no full texts in the list");
  }
});

test("search: case-insensitive on final and raw text, the user's wildcards taken literally", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const percent = ctx.dictate({ final: "I'm 100% sure." });
  const underscore = ctx.dictate({ final: "Open file_name.txt" });
  const backslash = ctx.dictate({ final: "Path C:\\Users\\me" });
  const plain = ctx.dictate({ final: "Nothing special here.", raw: "nothing special here" });
  const rawOnly = ctx.dictate({ final: "Cleaned text.", raw: "um littlebuddy said hi" });
  const cyrillic = ctx.dictate({ final: "Привет, мир." });

  const search = (query) => ctx.allIds({ query }).sort();
  assert.deepEqual(search("%"), [percent]);
  assert.deepEqual(search("_"), [underscore]);
  assert.deepEqual(search("\\"), [backslash]);
  assert.deepEqual(search("0% s"), [percent]);
  assert.deepEqual(search("e_n"), [underscore]);
  assert.deepEqual(search("SPECIAL"), [plain]);
  assert.deepEqual(search("  special  "), [plain], "trimmed");
  assert.deepEqual(search("LittleBuddy"), [rawOnly], "raw text is searched too");
  assert.deepEqual(search("ПРИВЕТ"), [cyrillic], "case folds beyond ASCII");
  assert.deepEqual(search("'; DROP TABLE transcriptions; --"), []);
  assert.equal(search("   ").length, 6, "an empty query is no search");
});

test("filters: failed, Cleanup changed it (this owner's), and app (this owner's)", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const changed = ctx.cleanedUp({ app: "Code.exe" });
  const unchanged = ctx.dictate({
    app: "Teams.exe",
    final: "Hello there.",
    raw: "Hello there.",
    steps: [STEP("stt", "Hello there."), STEP("cleanup", "Hello there.")],
  });
  // A failed cleanup keeps the text; a blank reply was ignored.
  const cleanupFailed = ctx.dictate({
    app: null,
    steps: [STEP("stt", "hello there"), STEP("cleanup", null, { outcome: "failed" })],
  });
  const cleanupFallback = ctx.dictate({
    app: null,
    steps: [STEP("stt", "hello there"), STEP("cleanup", "", { outcome: "fallback" })],
  });
  // Compared with the text cleanup received: the last step that left text, not the failed one.
  const afterFailedGlossary = ctx.dictate({
    app: null,
    steps: [
      STEP("stt", "hello there"),
      STEP("glossary", null, { outcome: "failed" }),
      STEP("cleanup", "hello there"),
    ],
  });
  const oldRow = ctx.dictate({ final: "Hello there.", raw: "hello there" });
  const failed = ctx.dictate({ final: "", raw: null, status: "failed" });
  ctx.state.owner = "account:b";
  const theirs = ctx.cleanedUp({ app: "Code.exe" });
  ctx.state.owner = "account:a";

  // Failed: the failed transcription, and this owner's failed or ignored cleanup.
  assert.deepEqual(
    ctx.allIds({ filters: { failed: true } }).sort(),
    [failed, cleanupFailed, cleanupFallback].sort()
  );
  assert.deepEqual(ctx.allIds({ filters: { cleanupChanged: true } }), [changed]);
  assert.deepEqual(ctx.allIds({ filters: { app: "Code.exe" } }), [changed]);
  assert.deepEqual(ctx.allIds({ filters: { app: "Teams.exe" } }), [unchanged]);
  assert.deepEqual(ctx.allIds({ filters: { app: "code.exe" } }), [], "the app as recorded");
  assert.deepEqual(ctx.allIds({ filters: { cleanupChanged: true, app: "Teams.exe" } }), []);
  assert.deepEqual(
    ctx.allIds({ filters: { failed: true, query: "x", bogus: true } }).sort(),
    [failed, cleanupFailed, cleanupFallback].sort()
  );
  assert.deepEqual(
    ctx.allIds({ filters: { bogus: true } }).sort(),
    [
      changed,
      unchanged,
      cleanupFailed,
      cleanupFallback,
      afterFailedGlossary,
      oldRow,
      failed,
      theirs,
    ].sort(),
    "unknown filters are ignored"
  );

  ctx.state.owner = "account:b";
  assert.deepEqual(ctx.allIds({ filters: { cleanupChanged: true } }), [theirs]);
  assert.deepEqual(ctx.allIds({ filters: { app: "Code.exe" } }), [theirs]);
  assert.deepEqual(
    ctx.allIds({ filters: { failed: true } }),
    [failed],
    "another owner's failed steps never count"
  );
  ctx.state.owner = null;
  assert.deepEqual(ctx.allIds({ filters: { cleanupChanged: true } }), [], "no owner, no steps");
  assert.deepEqual(ctx.allIds({ filters: { failed: true } }), [failed]);
  assert.equal(ctx.allIds().length, 8, "rows stay device-wide");
});

test("Failed lists a failed or ignored cleanup, style or translation, never a skipped or unchanged one", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const style = ctx.dictate({
    steps: [
      STEP("stt", "hello there"),
      STEP("cleanup", "Hello there."),
      STEP("style", null, {
        outcome: "failed",
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        detail: {
          styleId: "teams",
          runMode: "two-step",
          failure: {
            code: "PROVIDER_QUOTA_EXHAUSTED",
            messageKey: "providerErrors.quotaExhausted",
            messageParams: { provider: "GitHub Copilot" },
            settingsTarget: "llms",
          },
        },
      }),
    ],
  });
  const translationFailed = ctx.dictate({
    steps: [STEP("stt", "hello"), STEP("translation", null, { outcome: "failed" })],
  });
  const translationEmpty = ctx.dictate({
    steps: [STEP("stt", "hello"), STEP("translation", "", { outcome: "fallback" })],
  });
  const translationSkipped = ctx.dictate({
    steps: [STEP("stt", "hello"), STEP("translation", "hello", { outcome: "skipped" })],
  });
  const translationUnchanged = ctx.dictate({
    steps: [STEP("stt", "bonjour"), STEP("translation", "bonjour")],
  });
  const agentFailed = ctx.dictate({
    steps: [STEP("stt", "hey jarvis"), STEP("agent", null, { outcome: "failed" })],
  });
  const fine = ctx.cleanedUp();

  assert.deepEqual(
    ctx.allIds({ filters: { failed: true } }).sort(),
    [style, translationFailed, translationEmpty].sort()
  );
  const rows = new Map(ctx.browser.list().rows.map((row) => [row.id, row]));
  assert.equal(rows.get(style).stepFailure, "style");
  assert.equal(rows.get(translationFailed).stepFailure, "translation");
  assert.equal(rows.get(translationEmpty).stepFailure, "translation");
  for (const id of [translationSkipped, translationUnchanged, agentFailed, fine]) {
    assert.equal(rows.get(id).stepFailure, null);
  }

  // The stored reason comes back with the step, as main validated it.
  const item = ctx.browser.getItem(style);
  const styleStep = item.steps.find((step) => step.kind === "style");
  assert.deepEqual(styleStep.detail, {
    styleId: "teams",
    runMode: "two-step",
    failure: {
      code: "PROVIDER_QUOTA_EXHAUSTED",
      messageKey: "providerErrors.quotaExhausted",
      messageParams: { provider: "GitHub Copilot" },
      settingsTarget: "llms",
    },
  });
  assert.equal(styleStep.errorCode, "PROVIDER_QUOTA_EXHAUSTED");

  // The flag uses the steps' (owner, transcription_id) index.
  const plan = ctx.db.db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT 1 FROM transcription_steps sf
       WHERE sf.owner = ? AND sf.transcription_id = ?
         AND sf.kind IN ('cleanup', 'style', 'translation')
         AND sf.outcome IN ('failed', 'fallback')`
    )
    .all("account:a", style)
    .map((row) => row.detail)
    .join(" ");
  assert.match(plan, /idx_transcription_steps_owner/);
});

test("marks and app come from the current owner's steps only", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const mine = ctx.dictate({
    app: "OUTLOOK.EXE",
    final: "Hi Sam,\n\nThanks.",
    steps: [
      STEP("stt", "hi sam thanks"),
      STEP("glossary", "hi Sam thanks"),
      STEP("cleanup", "Hi Sam, thanks."),
      STEP("style", "Hi Sam,\n\nThanks.", { detail: { styleId: "email", runMode: "two-step" } }),
      STEP("finalize", "Hi Sam,\n\nThanks."),
      STEP("finalize", "Hi Sam,\n\nThanks!", { detail: { snippets: true } }),
    ],
  });
  const failedCleanup = ctx.dictate({
    steps: [
      STEP("stt", "hello"),
      STEP("glossary", "hello", { outcome: "skipped" }),
      STEP("cleanup", null, { outcome: "failed", errorCode: "TIMEOUT" }),
      STEP("finalize", "hello"),
    ],
  });
  const old = ctx.dictate({ final: "From before step history." });
  ctx.state.owner = "signed-out";
  const signedOut = ctx.cleanedUp({ app: "Slack.exe" });

  const rowsFor = () => new Map(ctx.browser.list().rows.map((row) => [row.id, row]));
  ctx.state.owner = "account:a";
  let rows = rowsFor();
  assert.equal(rows.get(mine).app, "OUTLOOK.EXE");
  assert.deepEqual(rows.get(mine).marks, [
    { kind: "glossary", change: "changed" },
    { kind: "cleanup", change: "changed" },
    { kind: "style", change: "changed" },
    { kind: "finalize", change: "same" },
    { kind: "finalize", change: "changed", snippets: true },
  ]);
  assert.deepEqual(rows.get(failedCleanup).marks, [
    { kind: "glossary", change: "skipped" },
    { kind: "cleanup", change: "failed" },
    { kind: "finalize", change: "same" },
  ]);
  assert.equal(rows.get(failedCleanup).stepFailure, "cleanup", "the row's badge");
  assert.equal(rows.get(mine).stepFailure, null);
  for (const id of [old, signedOut]) {
    assert.equal(rows.get(id).app, null);
    assert.equal(rows.get(id).marks, null, "another owner's steps never show");
  }

  ctx.state.owner = "signed-out";
  rows = rowsFor();
  assert.equal(rows.get(signedOut).app, "Slack.exe");
  assert.equal(rows.get(mine).marks, null);
  assert.equal(rows.get(mine).app, null);
});

test("the App filter's choices: this owner's listed dictations, most used first", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.cleanedUp({ app: "Teams.exe" });
  ctx.cleanedUp({ app: "Code.exe" });
  ctx.cleanedUp({ app: "Code.exe" });
  ctx.cleanedUp({ app: null });
  const deleted = ctx.cleanedUp({ app: "Deleted.exe" });
  ctx.db.markTranscriptionSynced(deleted, "cloud-9");
  ctx.db.deleteTranscription(deleted);
  ctx.state.owner = "account:b";
  ctx.cleanedUp({ app: "Secret.exe" });
  ctx.state.owner = "account:a";

  assert.deepEqual(ctx.browser.apps(), { success: true, apps: ["Code.exe", "Teams.exe"] });
  ctx.state.owner = "account:b";
  assert.deepEqual(ctx.browser.apps().apps, ["Secret.exe"]);
  ctx.state.owner = null;
  assert.deepEqual(ctx.browser.apps().apps, []);
});

test("one item by id: the full row and this owner's steps, as history-get-steps reads them", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const id = ctx.cleanedUp({ app: "Code.exe" });
  ctx.db.db
    .prepare(
      "UPDATE transcriptions SET has_audio = 1, audio_duration_ms = 4200, route_kind = 'style:email' WHERE id = ?"
    )
    .run(id);

  const mine = ctx.browser.getItem(id);
  assert.equal(mine.success, true);
  assert.deepEqual(
    { ...mine.item, timestamp: null },
    {
      id,
      timestamp: null,
      status: "completed",
      text: "Hello there.",
      rawText: "hello there",
      errorCode: null,
      errorMessage: null,
      hasAudio: true,
      audioDurationMs: 4200,
      routeKind: "style:email",
      provider: null,
      model: null,
    }
  );
  assert.equal(mine.status, "captured");
  assert.equal(mine.context.targetApp, "Code.exe");
  assert.deepEqual(
    mine.steps.map((step) => step.kind),
    ["stt", "glossary", "cleanup", "finalize"]
  );

  ctx.state.owner = "account:b";
  const theirs = ctx.browser.getItem(id);
  assert.equal(theirs.success, true, "the row itself is device-wide");
  assert.equal(theirs.item.text, "Hello there.");
  assert.equal(theirs.status, "otherOwner");
  assert.deepEqual(theirs.steps, []);
  assert.equal(theirs.context, null);

  const failed = ctx.dictate({ final: "", raw: null, status: "failed" });
  ctx.db.updateTranscriptionStatus(failed, "failed", "The request timed out.", "TIMEOUT");
  const failure = ctx.browser.getItem(failed);
  assert.equal(failure.item.errorCode, "TIMEOUT");
  assert.equal(failure.item.errorMessage, "The request timed out.");
  assert.equal(failure.status, "none");
});

test("a malformed cursor is refused, and the page size is clamped", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  for (let index = 0; index < 120; index += 1) ctx.dictate({ final: `Row ${index}.` });
  for (const cursor of [{ timestamp: 5, id: 1 }, { timestamp: "x", id: -1 }, { timestamp: "x" }]) {
    assert.deepEqual(ctx.browser.list({ cursor }), {
      success: false,
      code: "INVALID_CURSOR",
      rows: [],
      nextCursor: null,
    });
  }
  assert.equal(ctx.browser.list().rows.length, 50);
  assert.equal(ctx.browser.list({ limit: 0 }).rows.length, 1);
  assert.equal(ctx.browser.list({ limit: 1000 }).rows.length, 100);
  assert.equal(ctx.browser.list(null).success, true);
});
