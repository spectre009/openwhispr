const test = require("node:test");
const assert = require("node:assert/strict");

// Loads DatabaseManager behind the shared electron stub first.
const { createDb } = require("./harness/db.js");
const { createStepHistory, createStepRunRegistry } = require("../../src/helpers/stepHistory.js");
const { createHistoryBrowser } = require("../../src/helpers/historyBrowser.js");
const {
  createDictionaryOccurrencesService,
} = require("../../src/helpers/dictionaryOccurrences.js");

// Where dictionary words appeared, against a real database (Electron's Node):
// "Where it appeared" pages and totals, app and attribution only from the
// current owner's steps, durability, History's dictionary filters as SQL
// functions frozen per dictionary generation (and a stale later page), the
// "📖 n fixed" badge, the History card, the generation's triggers, and a
// benchmark of the filters over 10,000 rows and 250 words. Synthetic text.

const DURABLE = { synced: true, enabled: true, forcedOff: false, resolved: true };

function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  const state = { owner: "account:a", policy: { ...DURABLE } };
  const history = createStepHistory({
    db,
    getOwner: () => state.owner,
    isEnabled: () => true,
    runs: createStepRunRegistry(),
  });
  const browser = createHistoryBrowser({ db, stepHistory: history });
  const occurrences = createDictionaryOccurrencesService({
    db,
    getOwner: () => state.owner,
    getPolicy: () => state.policy,
    getSnippetExpansions: () => db.getSnippets().map((snippet) => snippet.replacement),
    getGeneration: () => db.getDictionaryGeneration(),
  });
  // A dictation saved with the current owner's trace: speech-to-text, an
  // optional glossary step that fired, cleanup.
  const dictate = (
    raw,
    final,
    { glossary = null, app = "Teams.exe", route = "cleanup", voiceAgent = false } = {}
  ) => {
    const glossaryText = glossary ? glossary.text : raw;
    const trace = {
      version: 1,
      runId: history.beginRun(),
      context: { targetApp: app, intents: { voiceAgent, translation: false, wakeWord: false } },
      route,
      glossary: { revision: 1, rulesFired: glossary ? glossary.fired : [] },
      steps: [
        { kind: "stt", outcome: "ok", output: raw },
        { kind: "glossary", outcome: glossary ? "ok" : "skipped", output: glossaryText },
        { kind: "cleanup", outcome: "ok", output: final },
      ],
    };
    return Number(history.saveTranscription(final, raw, { trace }).id);
  };
  const plain = (raw, final, options = {}) => Number(db.saveTranscription(final, raw, options).id);
  const setTimestamp = (id, ms) =>
    db.db
      .prepare("UPDATE transcriptions SET timestamp = ?, created_at = ? WHERE id = ?")
      .run(
        new Date(ms).toISOString().slice(0, 19).replace("T", " "),
        new Date(ms).toISOString().slice(0, 19).replace("T", " "),
        id
      );
  return { db, state, history, browser, occurrences, dictate, plain, setTimestamp };
}

test("where a word appeared: pages, totals, and app and attribution from this owner's steps", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, state, dictate, plain, occurrences, setTimestamp } = ctx;
  db.applyDictionaryChanges({ add: ["Little Buddy", "Aishwaria"] }, "manual");
  const now = Date.now();
  const ids = [
    dictate("littlebuddy open the board", "Little Buddy, open the board.", {
      glossary: {
        text: "Little Buddy open the board",
        fired: [
          {
            ruleId: "r1",
            spelling: "littlebuddy",
            scope: "anywhere",
            from: "littlebuddy",
            to: "Little Buddy",
            index: 0,
          },
        ],
      },
    }),
    dictate("ping ash varia now", "Ping Aishwaria now."),
    dictate("little buddy and littbuddy", "Little Buddy and Little Buddy."),
    plain("little buddy said no", "They said no."),
    // Another owner's dictation: its text is History's, its steps aren't ours.
    (() => {
      state.owner = "account:b";
      const id = dictate("littlebuddy elsewhere", "Little Buddy, elsewhere.", {
        app: "Outlook.exe",
      });
      state.owner = "account:a";
      return id;
    })(),
  ];
  ids.forEach((id, index) => setTimestamp(id, now - (index + 1) * 60_000));

  const page = await occurrences.getOccurrences("Little Buddy", { limit: 2 });
  assert.equal(page.available, true);
  assert.deepEqual(page.totals, { all: 4, ok: 1, fix: 3, chg: 1 });
  assert.deepEqual(
    page.items.map((item) => [item.id, item.kinds, item.app, item.by, item.speechWrote]),
    [
      [ids[0], ["fix"], "Teams.exe", "glossary", "littlebuddy"],
      [ids[2], ["ok", "fix"], "Teams.exe", null, "littbuddy"],
    ]
  );
  const next = await occurrences.getOccurrences("Little Buddy", {
    limit: 2,
    cursor: page.nextCursor,
  });
  assert.deepEqual(
    next.items.map((item) => [item.id, item.kinds, item.app, item.by]),
    [
      [ids[3], ["chg"], null, null],
      [ids[4], ["fix"], null, null],
    ],
    "another owner's row: its text, never its app or who fixed it"
  );
  assert.equal(next.nextCursor, null);
  // Cleanup put Aishwaria in.
  const aishwaria = await occurrences.getOccurrences("Aishwaria", { kind: "fix" });
  assert.deepEqual(
    aishwaria.items.map((item) => [item.by, item.speechWrote, item.snippet.match]),
    [["cleanup", "ash varia", "Aishwaria"]]
  );
  // Speech variants from the same rows.
  const variants = await occurrences.getSpeechVariants("Little Buddy");
  assert.deepEqual(variants.variants[0], { spelling: "littlebuddy", count: 2, keptInFinal: 0 });

  // Durability: off for this owner, nothing.
  state.policy = { ...DURABLE, enabled: false };
  assert.deepEqual(await occurrences.getOccurrences("Little Buddy"), {
    available: false,
    reason: "history-off",
  });
  state.policy = { ...DURABLE };
  // Deleted rows leave.
  db.deleteTranscription(ids[0]);
  const after = await occurrences.getOccurrences("Little Buddy");
  assert.ok(!after.items.some((item) => item.id === ids[0]));
  assert.equal(after.totals.all, 3);
});

test("the dictionary generation: every word or snippet change, not sync bookkeeping", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db } = ctx;
  const start = db.getDictionaryGeneration();
  db.applyDictionaryChanges({ add: ["Kusto"] }, "manual");
  const added = db.getDictionaryGeneration();
  assert.ok(added > start, "a word added");
  const row = db.db.prepare("SELECT id FROM custom_dictionary WHERE word = 'Kusto'").get();
  db.markDictionaryEntrySynced(row.id, "cloud-1");
  assert.equal(db.getDictionaryGeneration(), added, "marking it synced isn't a change");
  db.renameDictionaryWord("Kusto", "KQL");
  const renamed = db.getDictionaryGeneration();
  assert.ok(renamed > added, "a rename");
  db.applyDictionaryChanges({ remove: ["KQL"] });
  const removed = db.getDictionaryGeneration();
  assert.ok(removed > renamed, "a removal");
  db.setSnippets([{ trigger: "my link", replacement: "https://cal.example/x" }]);
  const snipped = db.getDictionaryGeneration();
  assert.ok(snipped > removed, "a snippet's expansion");
  db.setSnippets([{ trigger: "my link", replacement: "https://cal.example/y" }]);
  assert.ok(db.getDictionaryGeneration() > snipped, "a changed expansion");
});

test("History's dictionary filters: the row summaries, frozen per generation, stale later pages", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, browser, state, dictate, plain, setTimestamp } = ctx;
  db.applyDictionaryChanges({ add: ["Kusto", "Aishwaria"] }, "manual");
  const now = Date.now();
  const fixed = [];
  const word = [];
  for (let i = 0; i < 12; i += 1) {
    const id =
      i % 3 === 0
        ? plain("ping ash varia", "Ping Aishwaria.")
        : i % 3 === 1
          ? plain("open kusto", "Open Kusto.")
          : plain("nothing here", "Nothing here.");
    setTimestamp(id, now - i * 60_000);
    if (i % 3 === 0) fixed.push(id);
    if (i % 3 === 1) word.push(id);
  }
  // Never fixes: a translation, and this owner's assistant row.
  setTimestamp(
    plain("ping ash varia", "Ping Aishwaria.", { routeKind: "translation" }),
    now - 30 * 60_000
  );
  setTimestamp(
    dictate("ping ash varia", "Ping Aishwaria.", { route: "agent", voiceAgent: true }),
    now - 31 * 60_000
  );

  const first = browser.list({ limit: 2, filters: { dictionaryFixed: true } });
  assert.equal(first.success, true);
  assert.deepEqual(
    first.rows.map((row) => row.id),
    fixed.slice(0, 2)
  );
  assert.ok(
    first.rows.every((row) => row.dictionaryFixes === 1),
    "the badge"
  );
  const generation = first.generation;
  assert.ok(Number.isInteger(generation));
  const second = browser.list({
    limit: 2,
    cursor: first.nextCursor,
    generation,
    filters: { dictionaryFixed: true },
  });
  assert.deepEqual(
    second.rows.map((row) => row.id),
    fixed.slice(2, 4)
  );
  assert.equal(second.nextCursor, null, "no translation, no assistant row");

  // The word filter: raw or final has it, device-wide.
  const withKusto = browser.list({ filters: { dictionaryWord: "kusto" } });
  assert.deepEqual(
    withKusto.rows.map((row) => row.id),
    word
  );
  const none = browser.list({ filters: { dictionaryWord: "Zzyzx" } });
  assert.deepEqual(none.rows, []);

  // The dictionary changes between pages: the later page is stale.
  db.applyDictionaryChanges({ add: ["Nothing"] }, "manual");
  const stale = browser.list({
    limit: 2,
    cursor: first.nextCursor,
    generation,
    filters: { dictionaryFixed: true },
  });
  assert.deepEqual(stale.stale, true);
  assert.deepEqual(stale.rows, []);
  assert.notEqual(stale.generation, generation);
  // Without a dictionary filter nothing is stale; the badges follow the new generation.
  const plainPage = browser.list({ limit: 50, cursor: first.nextCursor, generation });
  assert.equal(plainPage.stale, undefined);
  // A snippet whose expansion holds the word: no longer a fix.
  db.setSnippets([{ trigger: "her name", replacement: "Aishwaria" }]);
  const afterSnippet = browser.list({ filters: { dictionaryFixed: true } });
  assert.deepEqual(afterSnippet.rows, [], "words only in an expansion aren't fixes");
  const badges = browser.dictionaryFixes(fixed);
  assert.equal(badges.success, true);
  assert.ok(Object.values(badges.fixes).every((n) => n === 0));
  void state;
});

test("History's dictionary card: words in a row, who fixed them only for this owner", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, browser, state, dictate } = ctx;
  db.applyDictionaryChanges({ add: ["Little Buddy", "Aishwaria", "Kusto"] }, "manual");
  const id = dictate(
    "littlebuddy ping ash varia about kusto",
    "Little Buddy, ping Aishwaria about Kusto.",
    {
      glossary: {
        text: "Little Buddy ping ash varia about kusto",
        fired: [
          {
            ruleId: "r1",
            spelling: "littlebuddy",
            scope: "anywhere",
            from: "littlebuddy",
            to: "Little Buddy",
            index: 0,
          },
        ],
      },
    }
  );
  const item = browser.getItem(id);
  assert.equal(item.success, true);
  assert.equal(item.dictionaryAligned, true);
  const summary = item.dictionary.map((entry) => [
    entry.word,
    entry.appearances.map((a) => [a.kind, a.speechWrote, a.by]),
  ]);
  assert.deepEqual(summary, [
    ["Little Buddy", [["fix", "littlebuddy", "glossary"]]],
    ["Aishwaria", [["fix", "ash varia", "cleanup"]]],
    ["Kusto", [["ok", null, null]]],
  ]);
  const kusto = item.dictionary[2].appearances[0];
  assert.equal(item.item.text.slice(kusto.start, kusto.end), "Kusto");
  // Another owner sees the row's text (History's contract), never who fixed it.
  state.owner = "account:b";
  const other = browser.getItem(id);
  assert.ok(other.dictionary.every((entry) => entry.appearances.every((a) => a.by === null)));
  assert.deepEqual(
    other.dictionary.map((entry) => entry.word),
    ["Little Buddy", "Aishwaria", "Kusto"]
  );
  // The list's badge: two words in the final text and not the raw one.
  state.owner = "account:a";
  const listed = browser.list({}).rows.find((row) => row.id === id);
  assert.equal(listed.dictionaryFixes, 2);
});

test("benchmark: the dictionary filters over 10,000 rows and 250 words", (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, browser } = ctx;
  const words = Array.from({ length: 248 }, (_, i) => `Term${i}x`);
  words.push("Little Buddy", "Aishwaria");
  db.applyDictionaryChanges({ add: words }, "learned");
  // About 50 words a row, as a longer dictation runs.
  const filler =
    "please open the board and check the numbers for this week before the review, " +
    "then write a short note to the team about what changed since Monday and what we " +
    "still need from the data folks, and remind everyone that the demo moved to Thursday afternoon";
  const insert = db.db.prepare(
    `INSERT INTO transcriptions (text, raw_text, status, timestamp, created_at)
     VALUES (?, ?, 'completed', ?, ?)`
  );
  const now = Date.now();
  db.db.transaction(() => {
    for (let i = 0; i < 10_000; i += 1) {
      const at = new Date(now - i * 60_000).toISOString().slice(0, 19).replace("T", " ");
      // Every 50th row: a fix after speech; every 7th: Term3x said and kept.
      const raw = `${filler} ${i % 7 === 0 ? "term3x" : ""} ${i % 50 === 0 ? "ash varia" : "nobody"} ${i}`;
      const final = `${filler} ${i % 7 === 0 ? "Term3x" : ""} ${i % 50 === 0 ? "Aishwaria" : "nobody"} ${i}. Done.`;
      insert.run(final, raw, at, at);
    }
  })();
  const time = (fn) => {
    const started = process.hrtime.bigint();
    const result = fn();
    return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  };
  const cold = time(() => browser.list({ filters: { dictionaryFixed: true } }));
  const later = time(() =>
    browser.list({
      cursor: cold.result.nextCursor,
      generation: cold.result.generation,
      filters: { dictionaryFixed: true },
    })
  );
  const wordCold = time(() => browser.list({ filters: { dictionaryWord: "Term3x" } }));
  const wordLater = time(() =>
    browser.list({
      cursor: wordCold.result.nextCursor,
      generation: wordCold.result.generation,
      filters: { dictionaryWord: "Term3x" },
    })
  );
  const zeroWord = time(() => browser.list({ filters: { dictionaryWord: "Zzyzx" } }));
  // Without Aishwaria nothing was fixed after speech: a cold scan of every row, no hits.
  db.applyDictionaryChanges({ remove: ["Aishwaria"] });
  const zeroFixed = time(() => browser.list({ filters: { dictionaryFixed: true } }));
  // A dictionary change makes the next query cold again.
  db.applyDictionaryChanges({ add: ["Aishwaria"] }, "manual");
  const coldAgain = time(() => browser.list({ filters: { dictionaryFixed: true } }));
  const report = {
    fixedCold: cold.ms,
    fixedLater: later.ms,
    wordCold: wordCold.ms,
    wordLater: wordLater.ms,
    wordZeroHits: zeroWord.ms,
    fixedZeroHits: zeroFixed.ms,
    fixedColdAfterChange: coldAgain.ms,
  };
  console.log(
    `history dictionary filters, 10,000 rows × 250 words (ms): ${Object.entries(report)
      .map(([key, ms]) => `${key} ${ms.toFixed(1)}`)
      .join(", ")}`
  );
  assert.equal(cold.result.rows.length, 50);
  assert.equal(later.result.rows.length, 50, "200 fixes in all");
  assert.equal(wordCold.result.rows.length, 50);
  assert.deepEqual(zeroWord.result.rows, []);
  assert.deepEqual(zeroFixed.result.rows, []);
  assert.equal(coldAgain.result.rows.length, 50);
  for (const [key, ms] of Object.entries(report)) {
    assert.ok(ms < 1500, `${key} took ${ms.toFixed(1)} ms`);
  }
});
