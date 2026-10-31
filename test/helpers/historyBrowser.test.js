const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createHistoryBrowser,
  normalizeListRequest,
  summarizeSteps,
} = require("../../src/helpers/historyBrowser.js");

// history-list's request handling and the row summaries, without a database:
// the cursor, page size, search and filters main passes on, and the owner it
// asks for. The SQL itself is covered by historyBrowserDatabase.test.js.

test("a request is trimmed, clamped and whitelisted", () => {
  assert.deepEqual(normalizeListRequest(undefined), {
    cursor: null,
    limit: 50,
    query: "",
    failed: false,
    cleanupChanged: false,
    app: null,
    flagged: false,
    dictionaryFixed: false,
    dictionaryWord: null,
    generation: null,
  });
  assert.deepEqual(
    normalizeListRequest({
      cursor: { timestamp: "2026-10-22 10:00:00", id: 7, extra: true },
      limit: 250.7,
      query: "  100%_sure  ",
      generation: 4,
      filters: {
        failed: true,
        cleanupChanged: "yes",
        app: "  Code.exe ",
        flagged: true,
        rated: true,
        dictionaryFixed: true,
        dictionaryWord: "  Little Buddy ",
      },
    }),
    {
      cursor: { timestamp: "2026-10-22 10:00:00", id: 7 },
      limit: 100,
      query: "100%_sure",
      failed: true,
      cleanupChanged: false,
      app: "Code.exe",
      flagged: true,
      dictionaryFixed: true,
      dictionaryWord: "Little Buddy",
      generation: 4,
    }
  );
  assert.equal(normalizeListRequest({ filters: { flagged: "yes" } }).flagged, false);
  assert.equal(normalizeListRequest({ filters: { dictionaryFixed: 1 } }).dictionaryFixed, false);
  assert.equal(normalizeListRequest({ filters: { dictionaryWord: "  " } }).dictionaryWord, null);
  assert.equal(
    normalizeListRequest({ filters: { dictionaryWord: "x".repeat(501) } }).dictionaryWord,
    null
  );
  assert.equal(normalizeListRequest({ generation: "4" }).generation, null);
  assert.equal(normalizeListRequest({ limit: -3 }).limit, 1);
  assert.equal(normalizeListRequest({ limit: "20" }).limit, 50);
  assert.equal(normalizeListRequest({ query: 42 }).query, "");
  assert.equal(normalizeListRequest({ filters: { app: "   " } }).app, null);
  assert.equal(normalizeListRequest({ query: "x".repeat(900) }).query.length, 500);
});

test("a malformed cursor is refused rather than restarting the list", () => {
  for (const cursor of [
    { timestamp: null, id: 1 },
    { timestamp: "2026", id: 0 },
    { timestamp: "2026", id: 1.5 },
    { timestamp: "x".repeat(65), id: 1 },
    "2026-10-22",
  ]) {
    assert.equal(normalizeListRequest({ cursor }), null, JSON.stringify(cursor));
  }
  assert.equal(normalizeListRequest({ cursor: null }).cursor, null);
});

test("a row's app and marks come from its first step's context and each later step", () => {
  assert.deepEqual(summarizeSteps(undefined), { app: null, marks: null, stepFailure: null });
  assert.deepEqual(summarizeSteps([]), { app: null, marks: null, stepFailure: null });
  assert.deepEqual(
    summarizeSteps([
      { kind: "stt", outcome: "ok", output: "hi", context: '{"targetApp":"Code.exe"}' },
      { kind: "cleanup", outcome: "ok", output: "Hi.", context: '{"targetApp":"Code.exe"}' },
      { kind: "finalize", outcome: "ok", output: "Hi!", detail: '{"snippets":true}' },
    ]),
    {
      app: "Code.exe",
      marks: [
        { kind: "cleanup", change: "changed" },
        { kind: "finalize", change: "changed", snippets: true },
      ],
      stepFailure: null,
    }
  );
  assert.equal(
    summarizeSteps([{ kind: "stt", outcome: "ok", output: "hi", context: "not json" }]).app,
    null
  );
});

test("a row's badge names its first failed cleanup, style or translation step", () => {
  const steps = (...rest) => [{ kind: "stt", outcome: "ok", output: "hi" }, ...rest];
  assert.equal(
    summarizeSteps(steps({ kind: "cleanup", outcome: "failed", output: null })).stepFailure,
    "cleanup"
  );
  assert.equal(
    summarizeSteps(
      steps(
        { kind: "cleanup", outcome: "ok", output: "Hi." },
        { kind: "style", outcome: "fallback", output: "" }
      )
    ).stepFailure,
    "style",
    "a blank reply that was ignored counts"
  );
  assert.equal(
    summarizeSteps(steps({ kind: "translation", outcome: "failed", output: null })).stepFailure,
    "translation"
  );
  for (const notFailed of [
    { kind: "translation", outcome: "skipped", output: "hi" },
    { kind: "translation", outcome: "ok", output: "hi" },
    { kind: "agent", outcome: "failed", output: null },
    { kind: "finalize", outcome: "failed", output: "hi" },
  ]) {
    assert.equal(summarizeSteps(steps(notFailed)).stepFailure, null, JSON.stringify(notFailed));
  }
});

test("the list asks for one extra row, reads steps for the page's ids under the current owner", () => {
  const calls = [];
  const db = {
    getHistoryPage: (args) => {
      calls.push(["page", args]);
      return [
        {
          id: 3,
          sort_key: "2026-10-22 10:00:02",
          timestamp: "2026-10-22 10:00:02",
          status: "completed",
          has_audio: 1,
        },
        {
          id: 2,
          sort_key: "2026-10-22 10:00:01",
          timestamp: "2026-10-22 10:00:01",
          status: "completed",
          has_audio: 0,
        },
        {
          id: 1,
          sort_key: "2026-10-22 10:00:00",
          timestamp: "2026-10-22 10:00:00",
          status: "failed",
          has_audio: 0,
        },
      ];
    },
    getHistoryStepRows: (ids, owner) => {
      calls.push(["steps", ids, owner]);
      return [{ transcription_id: 2, kind: "stt", outcome: "ok", output: "x", context: null }];
    },
  };
  const browser = createHistoryBrowser({ db, stepHistory: { currentOwner: () => "account:a" } });
  const result = browser.list({ limit: 2, query: " hi " });
  assert.equal(calls[0][1].limit, 3);
  assert.equal(calls[0][1].owner, "account:a");
  assert.equal(calls[0][1].query, "hi");
  assert.deepEqual(calls[1], ["steps", [3, 2], "account:a"]);
  assert.deepEqual(
    result.rows.map((row) => [row.id, row.hasAudio, row.marks]),
    [
      [3, true, null],
      [2, false, []],
    ]
  );
  assert.deepEqual(result.nextCursor, { timestamp: "2026-10-22 10:00:01", id: 2 });
});

test("a row carries the owner's rating; an item its revision, owner tag and review", () => {
  const row = (id, rating) => ({
    id,
    sort_key: `2026-10-22 10:00:0${id}`,
    timestamp: `2026-10-22 10:00:0${id}`,
    status: "completed",
    has_audio: 0,
    rating,
  });
  const reads = [];
  const db = {
    getHistoryPage: () => [row(3, "bad"), row(2, "good"), row(1, null)],
    getHistoryStepRows: () => [],
    getHistoryItem: (id) => ({
      id,
      status: "completed",
      text: "Hi.",
      raw_text: "hi",
      has_audio: 0,
    }),
    getHistoryRevision: (id, owner) => {
      reads.push(["revision", id, owner]);
      return `rev-${id}`;
    },
  };
  let owner = "account:a";
  const stepHistory = {
    currentOwner: () => owner,
    getSteps: () => ({ status: "none", steps: [] }),
  };
  const feedback = {
    get: (id) => ({ success: true, feedback: owner ? { verdict: "bad", id } : null }),
  };
  const browser = createHistoryBrowser({ db, stepHistory, feedback });

  assert.deepEqual(
    browser.list({}).rows.map((listed) => listed.rating),
    ["bad", "good", null]
  );

  const item = browser.getItem(3);
  assert.equal(item.revision, "rev-3");
  assert.deepEqual(reads, [["revision", 3, "account:a"]]);
  assert.match(item.owner, /^[0-9a-f]{16}$/);
  assert.ok(!item.owner.includes("account"), "the owner is opaque");
  assert.deepEqual(item.feedback, { verdict: "bad", id: 3 });

  owner = null;
  const unknown = browser.getItem(3);
  assert.equal(unknown.owner, null);
  assert.equal(unknown.feedback, null);
});
