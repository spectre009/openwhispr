const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_HINT_SCORES,
  compareHintScores,
  hintScoreTuples,
  hintScoresForDictionary,
  normalizeDictionaryHintOrder,
  normalizeHintScores,
} = require("../../src/utils/dictionaryHintOrder.ts");
const {
  buildSttHintFields,
  normalizeHintDictionary,
} = require("../../src/utils/sttHintFields.js");

// The order setting and the usage scores evidence order ranks by: built from
// the usage counts, bounded to the dictionary, and validated where they
// cross IPC (Re-transcribe's dictionary block, normalizeHintDictionary).
// Synthetic words only.

test("the order setting: evidence by default, anything unknown reads as evidence", () => {
  assert.equal(normalizeDictionaryHintOrder("added"), "added");
  assert.equal(normalizeDictionaryHintOrder("evidence"), "evidence");
  for (const value of [undefined, null, "", "ADDED", "recent", 1, {}]) {
    assert.equal(normalizeDictionaryHintOrder(value), "evidence", String(value));
  }
});

test("scores from usage: only words with evidence, best first, keys bounded, counts clamped", () => {
  const tuples = hintScoreTuples([
    { word: "Kusto", heard: 9, written: 12, missedRows: 2 },
    { word: " CUUD ", written: 3, missedRows: 2 },
    { word: "Never", written: 0, missedRows: 0 },
    { word: "Huge", written: 5_000_000, missedRows: 1.7 },
    { word: "x".repeat(101), written: 9, missedRows: 9 },
    { word: "kusto", written: 99, missedRows: 99 },
    { word: 42, written: 1, missedRows: 1 },
    null,
  ]);
  assert.deepEqual(tuples, [
    ["kusto", 2, 12],
    ["cuud", 2, 3],
    ["huge", 1, 1_000_000],
  ]);
  assert.deepEqual(hintScoreTuples(null), []);
  const many = hintScoreTuples(
    Array.from({ length: MAX_HINT_SCORES + 50 }, (_, i) => ({
      word: `w${i}`,
      written: i + 1,
      missedRows: 0,
    }))
  );
  assert.equal(many.length, MAX_HINT_SCORES);
  assert.equal(many[0][0], `w${MAX_HINT_SCORES + 49}`, "the strongest evidence kept");
});

test("scores for one request: the dictionary's own words, at most as many as it has", () => {
  const tuples = [
    ["kusto", 5, 5],
    ["gone", 4, 4],
    ["aria", 3, 3],
    ["cuud", 1, 1],
  ];
  assert.deepEqual(hintScoresForDictionary(tuples, ["Aria", "KUSTO", "Cuud"]), [
    ["kusto", 5, 5],
    ["aria", 3, 3],
    ["cuud", 1, 1],
  ]);
  assert.deepEqual(hintScoresForDictionary(tuples, ["Aria", "KUSTO"]), [
    ["kusto", 5, 5],
    ["aria", 3, 3],
  ]);
  assert.deepEqual(hintScoresForDictionary(null, ["Aria"]), []);
  assert.deepEqual(hintScoresForDictionary(tuples, null), []);
});

test("validation: bounded numbers keyed by word key; anything else is dropped", () => {
  const scores = normalizeHintScores([
    ["kusto", 2, 12],
    [" Aria ", 1, 3],
    ["kusto", 9, 9],
    ["neg", -1, 3],
    ["frac", 1.5, 3],
    ["big", 1, 1_000_001],
    ["max", 1_000_000, 0],
    ["str", "2", 3],
    ["zero", 0, 0],
    ["x".repeat(101), 1, 1],
    ["", 1, 1],
    [42, 1, 1],
    ["four", 1, 1, 1],
    "kusto",
    null,
  ]);
  assert.deepEqual(
    [...scores],
    [
      ["kusto", { missedRows: 2, written: 12 }],
      ["aria", { missedRows: 1, written: 3 }],
      ["max", { missedRows: 1_000_000, written: 0 }],
    ]
  );
  assert.equal(normalizeHintScores("nope").size, 0);
  assert.equal(normalizeHintScores({ kusto: [1, 1] }).size, 0);
  // At most `maxEntries` are read, in order, and never over 2,000.
  const list = Array.from({ length: 2500 }, (_, i) => [`w${i}`, 1, 1]);
  assert.equal(normalizeHintScores(list).size, MAX_HINT_SCORES);
  assert.deepEqual([...normalizeHintScores(list, 3).keys()], ["w0", "w1", "w2"]);
  assert.equal(normalizeHintScores(list, 0).size, 0);
});

test("compare: missed rows, then rows used; no score is 0/0", () => {
  const a = { missedRows: 2, written: 1 };
  const b = { missedRows: 1, written: 50 };
  assert.ok(compareHintScores(a, b) < 0);
  assert.ok(compareHintScores({ missedRows: 1, written: 5 }, b) > 0);
  assert.equal(compareHintScores(undefined, { missedRows: 0, written: 0 }), 0);
  assert.ok(compareHintScores(undefined, { missedRows: 0, written: 1 }) > 0);
});

test("Re-transcribe's block: hintOrder and scores validated against the words sent", () => {
  const normalized = normalizeHintDictionary({
    words: ["Alpha", "Bravo"],
    pinned: ["bravo", "alpha"],
    hintOrder: "sideways",
    scores: [
      ["alpha", 1, 2],
      ["bravo", 3, 4],
      ["charlie", 5, 6],
    ],
  });
  assert.equal(normalized.hintOrder, "evidence");
  assert.deepEqual(normalized.pinned, ["bravo", "alpha"], "pin order kept");
  assert.deepEqual(
    [...normalized.scores],
    [
      ["alpha", { missedRows: 1, written: 2 }],
      ["bravo", { missedRows: 3, written: 4 }],
    ],
    "no more scores than words"
  );
  const older = normalizeHintDictionary({ words: ["Alpha"] });
  assert.equal(older.hintOrder, "evidence");
  assert.equal(older.scores.size, 0, "an older window sends none: stored order");
  assert.equal(normalizeHintDictionary({ words: ["A"], hintOrder: "added" }).hintOrder, "added");
});

test("the fields carry the ranking, and the words go in that order", () => {
  const dictionary = {
    words: ["Typed A", "Typed B", "Typed C"],
    pinned: [],
    glossaryTerms: [],
    snippets: [],
    chineseScriptPreference: null,
    speechLanguage: "en",
    scores: [["typed c", 4, 4]],
  };
  const head = { route: "azure-speech" };
  const evidence = buildSttHintFields(head, dictionary);
  assert.deepEqual(evidence.phrases, ["Typed C", "Typed A", "Typed B"]);
  assert.deepEqual(evidence.ranking, { order: "evidence", evidence: true, scores: 1 });
  assert.deepEqual(
    evidence.entries.map((entry) => [entry.term, entry.rank]),
    [
      ["Typed C", 1],
      ["Typed A", 2],
      ["Typed B", 3],
    ]
  );
  const added = buildSttHintFields(head, { ...dictionary, hintOrder: "added" });
  assert.deepEqual(added.phrases, ["Typed A", "Typed B", "Typed C"]);
  assert.deepEqual(added.ranking, { order: "added", evidence: false, scores: 1 });
  // A tail prompt ends with the best of the ranked tier.
  const tail = buildSttHintFields({ route: "local-whisper" }, dictionary);
  assert.equal(tail.prompt, "Typed B, Typed A, Typed C");
});
