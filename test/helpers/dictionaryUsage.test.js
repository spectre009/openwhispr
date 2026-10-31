const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countDictionaryUsage,
  countTidyInputs,
  countWordUsageByWeek,
  createDictionaryUsageService,
  dictationPace,
  isSpeechMissed,
  usageRowTime,
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
  assert.deepEqual(first.words, [
    { word: "OpenWhispr", heard: 0, written: 1, missedRows: 1, bothRows: 0 },
  ]);
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

test("one word per week: 13 weeks ending now, the same matching, rows outside skipped", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const at = (days) =>
    new Date(now - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const rows = [
    { raw: "open whisper", final: "OpenWhispr.", at: at(1) },
    { raw: "openwhispr again", final: "OpenWhispr again.", at: at(2) },
    { raw: "the agents-shared repo", final: "The agents-shared repo.", at: at(3) },
    { raw: "open whisper", final: "OpenWhispr.", at: at(30) },
    { raw: "openwhispr", final: "OpenWhispr.", at: at(89.5) },
    { raw: "openwhispr", final: "OpenWhispr.", at: at(95) },
    { raw: "openwhispr", final: "OpenWhispr.", at: "not a time" },
  ];
  const weeks = countWordUsageByWeek(rows, "OpenWhispr", { now });
  assert.equal(weeks.length, 13);
  assert.equal(weeks[0].start, new Date(now - 90 * 86_400_000).toISOString(), "window start");
  assert.equal(weeks[12].start, new Date(now - 7 * 86_400_000).toISOString());
  assert.deepEqual(
    [weeks[12].heard, weeks[12].written, weeks[12].missedRows],
    [1, 2, 1],
    "this week: one heard, two written, one missed"
  );
  const month = weeks.find((week) => week.written > 0 && week !== weeks[12] && week !== weeks[0]);
  assert.deepEqual([month.heard, month.written, month.missedRows], [0, 1, 1]);
  assert.deepEqual([weeks[0].heard, weeks[0].written], [1, 1], "the partial first week");
  const sum = weeks.reduce((n, week) => n + week.written, 0);
  assert.equal(sum, 4, "older than 90 days and unreadable times are skipped");
  // Several-token words match as sequences, as the totals do.
  const shared = countWordUsageByWeek(rows, "agents-shared", { now });
  assert.equal(shared[12].heard, 1);
  assert.equal(countWordUsageByWeek(rows, "", { now }).length, 13);
});

test("speech got it is rows with the word in both texts; changed after speech is heard − both", () => {
  const result = countDictionaryUsage(
    [
      row("little buddy, hi", "Little Buddy, hi."),
      row("LittleBuddy, hi", "Little Buddy, hi."),
      // Mixed: the row summary counts it once, as speech got it.
      row("little buddy and littbuddy", "Little Buddy and Little Buddy"),
      row("little buddy said so", "He said so."),
      row("nothing here"),
    ],
    ["Little Buddy"]
  );
  const [entry] = result.words;
  assert.deepEqual(
    {
      heard: entry.heard,
      written: entry.written,
      missedRows: entry.missedRows,
      both: entry.bothRows,
    },
    { heard: 3, written: 3, missedRows: 1, both: 2 }
  );
  assert.equal(entry.heard - entry.bothRows, 1, "changed after speech");
  assert.equal(entry.bothRows + entry.missedRows, entry.written, "used = got it + fixed");
});

test("weeks carry [start, end) bounds anchored once, with both and changed", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const DAY = 86_400_000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const weeks = countWordUsageByWeek(
    [
      // On the last week's start: in the last week, not the one before.
      { raw: "kusto here", final: "Kusto here.", at: iso(now - 7 * DAY) },
      { raw: "kustoe", final: "Kusto.", at: iso(now - 2 * DAY) },
      { raw: "kusto went", final: "It went.", at: iso(now - 3 * DAY) },
      // Exactly now: past the last week's end.
      { raw: "kusto", final: "Kusto", at: iso(now) },
    ],
    "Kusto",
    { now }
  );
  for (let k = 0; k + 1 < weeks.length; k += 1) {
    assert.equal(weeks[k].end, weeks[k + 1].start, "each week ends where the next starts");
  }
  assert.equal(weeks[12].end, new Date(now).toISOString(), "the last ends at the anchor");
  assert.equal(weeks[0].start, new Date(now - 90 * DAY).toISOString());
  const last = weeks[12];
  assert.deepEqual(
    [last.written, last.both, last.missedRows, last.changed, last.heard],
    [2, 1, 1, 1, 2]
  );
  assert.equal(weeks[11].written, 0);
});

test("dictation pace: a day's average over 30 days, or since History began", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const at = (days) => new Date(now - days * 86_400_000).toISOString();
  const month = Array.from({ length: 60 }, (_, i) => ({ at: at(i / 2) }));
  assert.deepEqual(dictationPace([...month, { at: at(45) }], { now }), { perDay: 2 });
  // History only three and a half days old: those days, not thirty.
  const young = Array.from({ length: 8 }, (_, i) => ({ at: at(i / 2) }));
  assert.deepEqual(dictationPace(young, { now }), { perDay: 2.3 });
  assert.deepEqual(dictationPace([], { now }), { perDay: 0 });
  assert.equal(usageRowTime("2026-10-30 12:00:00"), now, "SQLite's UTC format");
  assert.ok(Number.isNaN(usageRowTime(null)));
});

// ─── Tidy up's aggregates ───

test("tidy inputs: frequent tokens by the rows they're in, from the final text", () => {
  const result = countTidyInputs(
    [
      row("so honestly", "So honestly, honestly."),
      row("honestly", "Honestly."),
      row("sessions", "Sessions and sessions."),
      row("raw only words", "Final words."),
      row("my sig", "Thanks, sent from my laptop"),
      { final: "no raw transcript" },
    ],
    [],
    { snippetExpansions: ["sent from my laptop"], maxTokens: 4 }
  );
  assert.equal(result.rows, 5, "rows without a raw transcript aren't read");
  assert.deepEqual(result.frequentTokens, [
    { token: "honestly", rows: 2 },
    { token: "and", rows: 1 },
    { token: "final", rows: 1 },
    { token: "sessions", rows: 1 },
  ]);
  assert.equal(
    result.frequentTokens.some((entry) => entry.token === "laptop"),
    false,
    "a snippet's expansion wasn't said"
  );
  assert.deepEqual(result.adjacency, []);
});

test("tidy inputs: dictionary words side by side, either order, against the rarer one's rows", () => {
  const words = ["Little", "Buddy", "agents-shared", "Repo", "CLAUDE", "Claude"];
  const result = countTidyInputs(
    [
      row("hey little buddy", "Hey Little Buddy."),
      row("little buddy again", "Little Buddy again, little buddy."),
      row("buddy little", "Buddy, little one."),
      row("buddy alone", "Buddy alone."),
      row("little", "Little."),
      row("agents shared repo", "agents-shared repo"),
      row("claude claude", "Claude CLAUDE"),
    ],
    words
  );
  const pair = (a, b) =>
    result.adjacency.find(
      (entry) => (entry.a === a && entry.b === b) || (entry.a === b && entry.b === a)
    );
  // Rows: Little in 4, Buddy in 4; together in 3 (one of them "Buddy, little").
  assert.deepEqual(pair("Little", "Buddy"), {
    a: "Little",
    b: "Buddy",
    together: 3,
    rarerRows: 4,
  });
  // A several-token word sits next to the one after it.
  assert.deepEqual(pair("agents-shared", "Repo"), {
    a: "agents-shared",
    b: "Repo",
    together: 1,
    rarerRows: 1,
  });
  // Two spellings of one word are never a pair.
  assert.equal(pair("Claude", "CLAUDE"), undefined);
});

test("tidy inputs: at most the top tokens and pairs", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(`t${i} a b`, `t${i} a b`));
  const result = countTidyInputs(rows, ["a", "b"], { maxTokens: 2, maxPairs: 1 });
  assert.deepEqual(result.frequentTokens, [
    { token: "a", rows: 30 },
    { token: "b", rows: 30 },
  ]);
  assert.deepEqual(result.adjacency, [{ a: "a", b: "b", together: 30, rarerRows: 30 }]);
});

test("timing: tidy inputs for 5,000 rows × 250 words stay under 300 ms", () => {
  let seed = 11;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  // A vocabulary larger than the 5,000 tokens kept.
  const vocabulary = Array.from({ length: 8000 }, (_, i) => `word${i}`);
  const words = Array.from({ length: 250 }, (_, i) =>
    i % 4 === 0 ? `Multi Term${i}` : i % 7 === 0 ? `dotted${i}.md` : `Term${i}`
  );
  const rows = Array.from({ length: 5000 }, () => {
    const tokens = Array.from({ length: 40 }, () => vocabulary[Math.floor(random() * 8000)]);
    const first = words[Math.floor(random() * 250)];
    const second = words[Math.floor(random() * 250)];
    const text = `${tokens.join(" ")} ${first} ${second}.`;
    return row(text.toLowerCase(), text);
  });
  countTidyInputs(rows.slice(0, 200), words); // warm up the JIT
  const started = process.hrtime.bigint();
  const result = countTidyInputs(rows, words);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`countTidyInputs: 5,000 rows × 250 words in ${ms.toFixed(1)} ms`);
  assert.equal(result.rows, 5000);
  assert.equal(result.frequentTokens.length, 5000);
  assert.ok(result.adjacency.length > 0);
  assert.ok(ms < 300, `took ${ms.toFixed(1)} ms; the budget is 300 ms`);
});

test("the service's tidy inputs: owner-scoped, durable-History-only, cached by revision", async () => {
  const db = {
    reads: 0,
    revision: 1,
    words: ["Little", "Buddy"],
    getDictionary() {
      return [...this.words];
    },
    getHistoryContentRevision() {
      return this.revision;
    },
    getDictionaryUsageRows({ owner }) {
      this.reads += 1;
      assert.equal(owner, "account:a");
      return [row("little buddy", "Little Buddy."), row("little buddy", "Little Buddy!")];
    },
  };
  const policy = { synced: true, enabled: true, forcedOff: false, resolved: true };
  let at = Date.parse("2026-10-30T12:00:00Z");
  const computed = [];
  const service = createDictionaryUsageService({
    db,
    getOwner: () => "account:a",
    getPolicy: () => policy,
    now: () => at,
    onTidyComputed: (counts) => computed.push(counts),
  });
  const first = await service.getTidyInputs();
  assert.equal(first.available, true);
  assert.equal(first.days, 90);
  assert.deepEqual(first.adjacency, [{ a: "Little", b: "Buddy", together: 2, rarerRows: 2 }]);
  assert.deepEqual(
    Object.keys(computed[0]).sort(),
    ["ms", "pairs", "rows", "tokens"],
    "counts only"
  );
  await service.getTidyInputs();
  assert.equal(db.reads, 1, "the same revision: cached");
  db.revision = 2;
  at += 60_000;
  await service.getTidyInputs();
  assert.equal(db.reads, 2, "History changed");
  db.words = ["Little"];
  await service.getTidyInputs();
  assert.equal(db.reads, 3, "the words changed");

  policy.enabled = false;
  assert.deepEqual(await service.getTidyInputs(), { available: false, reason: "history-off" });
  policy.enabled = true;
  policy.forcedOff = true;
  assert.deepEqual(await service.getTidyInputs(), { available: false, reason: "policy-off" });
  assert.equal(db.reads, 3, "nothing read while History isn't durable");
});
