const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countDictionaryUsage,
  createDictionaryUsageService,
  isSpeechMissed,
  usageAvailability,
  usageTokens,
} = require("../../src/helpers/dictionaryUsage.js");

// Heard vs written, counted from History rows ({ raw, final }) with a token
// index. Synthetic text only.

const row = (raw, final = raw) => ({ raw, final });
const counts = (result, word) => {
  const entry = result.words.find((w) => w.word === word);
  return entry && { heard: entry.heard, written: entry.written, missedRows: entry.missedRows };
};

test("tokens are lowercase word runs, Unicode letters, marks and digits included", () => {
  assert.deepEqual(usageTokens("CLAUDE.md, agents-shared and Café 2"), [
    "claude",
    "md",
    "agents",
    "shared",
    "and",
    "café",
    "2",
  ]);
  assert.deepEqual(usageTokens("会議の資料"), ["会議の資料"]);
  assert.deepEqual(usageTokens("Cafe\u0301"), ["café"], "NFC first");
});

test("heard, written and paired missed rows per word", () => {
  const result = countDictionaryUsage(
    [
      row("open whisper is great", "OpenWhispr is great"),
      row("i love openwhispr", "I love OpenWhispr"),
      row("ask engine hub", "Ask EngHub"),
      row("enghub enghub twice", "EngHub EngHub twice"),
      row("nothing here"),
    ],
    ["OpenWhispr", "EngHub", "Never"]
  );
  assert.equal(result.rows, 5);
  assert.deepEqual(counts(result, "OpenWhispr"), { heard: 1, written: 2, missedRows: 1 });
  assert.deepEqual(
    counts(result, "EngHub"),
    { heard: 1, written: 2, missedRows: 1 },
    "once per row"
  );
  assert.deepEqual(
    counts(result, "Never"),
    { heard: 0, written: 0, missedRows: 0 },
    "0/0 is unknown"
  );
});

test("missed rows are paired per row, never written − heard", () => {
  // Ten rows where speech missed it, ten where speech wrote it and cleanup removed it.
  const rows = [
    ...Array.from({ length: 10 }, () => row("scout web rocks", "Scout Web rocks")),
    ...Array.from({ length: 10 }, () => row("Scout Web said", "they said")),
  ];
  const usage = counts(countDictionaryUsage(rows, ["Scout Web"]), "Scout Web");
  assert.deepEqual(usage, { heard: 20, written: 10, missedRows: 0 });
  const missed = counts(
    countDictionaryUsage(
      [
        ...Array.from({ length: 10 }, () => row("scout with rocks", "Scout Web rocks")),
        ...Array.from({ length: 10 }, () => row("Scout Web said", "they said")),
      ],
      ["Scout Web"]
    ),
    "Scout Web"
  );
  assert.deepEqual(missed, { heard: 10, written: 10, missedRows: 10 });
});

test("multi-token and punctuated words match as a token sequence, not a substring", () => {
  const result = countDictionaryUsage(
    [
      row("check agents shared", "check agents-shared"),
      row("open claude md", "Open CLAUDE.md"),
      row("the agentsshared folder"),
      row("shared agents"),
    ],
    ["agents-shared", "CLAUDE.md", "Little Buddy"]
  );
  assert.deepEqual(counts(result, "agents-shared"), { heard: 1, written: 1, missedRows: 0 });
  assert.deepEqual(counts(result, "CLAUDE.md"), { heard: 1, written: 1, missedRows: 0 });
});

test("words that come only from a snippet's expansion aren't written", () => {
  const result = countDictionaryUsage(
    [row("send my cal link", "Book here: https://cal.example/Gizmo")],
    ["Gizmo"],
    { snippetExpansions: ["https://cal.example/Gizmo"] }
  );
  assert.deepEqual(counts(result, "Gizmo"), { heard: 0, written: 0, missedRows: 0 });
});

test("rows without a raw transcript aren't counted; a word with no tokens counts nothing", () => {
  const result = countDictionaryUsage([{ raw: null, final: "x" }, row("...")], ["..."]);
  assert.equal(result.rows, 1);
  assert.deepEqual(counts(result, "..."), { heard: 0, written: 0, missedRows: 0 });
});

test("'speech often misses it': two paired misses, or one that's a quarter of the writes", () => {
  assert.equal(isSpeechMissed({ written: 0, missedRows: 0 }), false);
  assert.equal(isSpeechMissed({ written: 1, missedRows: 1 }), true);
  assert.equal(isSpeechMissed({ written: 4, missedRows: 1 }), true);
  assert.equal(isSpeechMissed({ written: 5, missedRows: 1 }), false, "one miss in five");
  assert.equal(isSpeechMissed({ written: 100, missedRows: 2 }), true);
  assert.equal(isSpeechMissed(null), false);
});

test("counts exist only while local history is durable, by the test set's rule", () => {
  const durable = { synced: true, enabled: true, forcedOff: false, resolved: true };
  assert.deepEqual(usageAvailability(durable, "account:a"), { available: true, reason: null });
  assert.equal(
    usageAvailability({ ...durable, forcedOff: true }, "signed-out").reason,
    "policy-off"
  );
  assert.equal(usageAvailability({ ...durable, synced: false }, "signed-out").reason, "pending");
  assert.equal(
    usageAvailability({ ...durable, enabled: false }, "signed-out").reason,
    "history-off"
  );
  assert.equal(usageAvailability({ ...durable, resolved: false }, "account:a").reason, "pending");
  assert.equal(usageAvailability({ ...durable, resolved: false }, "signed-out").available, true);
  assert.equal(usageAvailability(durable, null).reason, "unavailable");
});

function fakeDb({ rows = [], words = ["OpenWhispr"] } = {}) {
  const db = {
    revision: 1,
    reads: 0,
    rows,
    words,
    getDictionary: () => db.words,
    getHistoryContentRevision: () => db.revision,
    getDictionaryUsageRows: () => {
      db.reads += 1;
      return db.rows;
    },
  };
  return db;
}

test("the service caches by words, owner, day and content revision; at most every 30 s", async () => {
  const db = fakeDb({ rows: [row("open whisper", "OpenWhispr")] });
  let now = Date.parse("2026-10-30T12:00:00Z");
  let owner = "signed-out";
  const policy = { synced: true, enabled: true, forcedOff: false, resolved: true };
  const service = createDictionaryUsageService({
    db,
    getOwner: () => owner,
    getPolicy: () => policy,
    now: () => now,
  });
  const first = await service.get();
  assert.equal(first.available, true);
  assert.equal(first.days, 90);
  assert.deepEqual(first.words, [{ word: "OpenWhispr", heard: 0, written: 1, missedRows: 1 }]);
  await service.get();
  assert.equal(db.reads, 1, "nothing changed: cached");

  // A transcription write (Re-transcribe, Re-run cleanup, a delete) bumps the revision.
  db.revision = 2;
  now += 5_000;
  await service.get();
  assert.equal(db.reads, 1, "dictations keep arriving: the last counts stand for 30 s");
  now += 30_000;
  await service.get();
  assert.equal(db.reads, 2, "then it recomputes");

  db.words = ["OpenWhispr", "EngHub"];
  await service.get();
  assert.equal(db.reads, 3, "a dictionary change recomputes at once");
  owner = "account:a";
  policy.resolved = true;
  await service.get();
  assert.equal(db.reads, 4, "another owner recomputes");
  now += 24 * 60 * 60 * 1000;
  await service.get();
  assert.equal(db.reads, 5, "a new day moves the window");
  service.invalidate();
  await service.get();
  assert.equal(db.reads, 6, "a history policy change recomputes");

  // Concurrent reads share one computation.
  service.invalidate();
  await Promise.all([service.get(), service.get(), service.get()]);
  assert.equal(db.reads, 7);

  policy.enabled = false;
  assert.deepEqual(await service.get(), { available: false, reason: "history-off" });
  assert.equal(db.reads, 7, "History off reads nothing");
});

test("timing: 5,000 rows × 250 words stays well inside main's budget", () => {
  // Synthetic History: ~40-word dictations drawn from a 2,000-word vocabulary,
  // dictionary words sprinkled in, a quarter of them multi-token.
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const vocabulary = Array.from({ length: 2000 }, (_, i) => `word${i}`);
  const words = Array.from({ length: 250 }, (_, i) =>
    i % 4 === 0 ? `Multi Term${i}` : i % 7 === 0 ? `dotted${i}.md` : `Term${i}`
  );
  const rows = Array.from({ length: 5000 }, () => {
    const tokens = Array.from({ length: 40 }, () => vocabulary[Math.floor(random() * 2000)]);
    const inserted = words[Math.floor(random() * 250)];
    const raw = `${tokens.join(" ")} ${random() < 0.5 ? inserted.toLowerCase() : ""}`;
    return row(raw, `${tokens.join(" ")} ${inserted}.`);
  });
  countDictionaryUsage(rows.slice(0, 200), words); // warm up the JIT
  const started = process.hrtime.bigint();
  const result = countDictionaryUsage(rows, words);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`computeDictionaryUsage: 5,000 rows × 250 words in ${ms.toFixed(1)} ms`);
  assert.equal(result.rows, 5000);
  assert.ok(result.words.some((entry) => entry.missedRows > 0));
  assert.ok(ms < 150, `took ${ms.toFixed(1)} ms; the budget is 150 ms`);
});
