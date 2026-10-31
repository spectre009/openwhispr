const test = require("node:test");
const assert = require("node:assert/strict");

// The Dictionary page's list rules (dictionaryList.ts), without rendering:
// what each row knows, the filters and their counts, the five sorts, where
// send order's dividers go, and the pinned words' section and ranks.
// Synthetic words only.

let list;
test.before(async () => {
  list = await import("../../src/utils/dictionaryList.ts");
});

const NOW = Date.parse("2026-10-30T12:00:00Z");
const daysAgo = (days) =>
  new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");

const WORDS = ["Assistant", "OpenWhispr", "EngHub", "gonestly", "SuperApp", "the", "Kusto"];
const ENTRIES = [
  { word: "Assistant", source: "manual", createdAt: daysAgo(90) },
  { word: "OpenWhispr", source: "manual", createdAt: daysAgo(80) },
  { word: "EngHub", source: "manual", createdAt: daysAgo(3) },
  { word: "gonestly", source: "learned", createdAt: daysAgo(1) },
  { word: "SuperApp", source: "learned", createdAt: daysAgo(40) },
  { word: "the", source: "learned", createdAt: daysAgo(60) },
  { word: "Kusto", source: "learned", createdAt: null },
];
// A tail-ordered Whisper prompt: two read, two sent but past the window, the rest cut.
const COVERAGE = [
  { term: "SuperApp", source: "pinned", coverage: "read", rank: 1 },
  { term: "Assistant", source: "manual", coverage: "read", rank: 2 },
  { term: "OpenWhispr", source: "manual", coverage: "unread", rank: 3 },
  { term: "EngHub", source: "manual", coverage: "unread", rank: 4 },
  { term: "Glossed", source: "glossary", coverage: "read", rank: 5 },
  { term: "the", source: "learned", coverage: "notSent", rank: 6 },
  { term: "gonestly", source: "learned", coverage: "notSent", rank: 7 },
  { term: "Kusto", source: "learned", coverage: "notSent", rank: 8 },
];
const USAGE = [
  { word: "OpenWhispr", heard: 0, written: 6, missedRows: 6, bothRows: 0 },
  { word: "EngHub", heard: 5, written: 8, missedRows: 3, bothRows: 5 },
  // An older answer without bothRows: what's written and wasn't missed.
  { word: "SuperApp", heard: 5, written: 10, missedRows: 5 },
  { word: "the", heard: 2752, written: 2760, missedRows: 0, bothRows: 2745 },
];

function items({ usage = USAGE } = {}) {
  return list.buildDictionaryListItems({
    words: WORDS,
    entries: ENTRIES,
    pinned: new Set(["superapp"]),
    coverage: COVERAGE,
    usage,
    hiddenKeys: new Set(["assistant"]),
  });
}

test("each row: source, pin, date, coverage and rank, heard/written (zero when not seen)", () => {
  const rows = items();
  assert.deepEqual(
    rows.map((row) => row.word),
    ["OpenWhispr", "EngHub", "gonestly", "SuperApp", "the", "Kusto"],
    "the assistant's name is hidden"
  );
  const superApp = rows.find((row) => row.word === "SuperApp");
  assert.equal(superApp.source, "learned");
  assert.equal(superApp.pinned, true);
  assert.equal(superApp.coverage, "read");
  assert.equal(superApp.rank, 1);
  assert.deepEqual(superApp.usage, { heard: 5, written: 10, missedRows: 5, bothRows: 5 });
  const gonestly = rows.find((row) => row.word === "gonestly");
  assert.deepEqual(gonestly.usage, { heard: 0, written: 0, missedRows: 0, bothRows: 0 });
  assert.equal(rows.find((row) => row.word === "Kusto").createdMs, NaN);
  // Without counts, usage is null, never zero.
  assert.ok(items({ usage: null }).every((row) => row.usage === null));
});

test("filters and their counts; Speech misses it and Never used need counts", () => {
  const rows = items();
  assert.deepEqual(list.dictionaryFilterCounts(rows, NOW), {
    all: 6,
    typed: 2,
    learned: 4,
    pinned: 1,
    notSent: 3,
    speechMisses: 3,
    neverHeard: 2,
    addedThisWeek: 2,
  });
  const shown = (filter) =>
    list
      .viewDictionaryList(rows, { filter, sort: "alpha", search: "", now: NOW, locale: "en" })
      .items.map((row) => row.word);
  assert.deepEqual(shown("neverHeard"), ["gonestly", "Kusto"]);
  assert.deepEqual(shown("speechMisses"), ["EngHub", "OpenWhispr", "SuperApp"]);
  assert.deepEqual(shown("addedThisWeek"), ["EngHub", "gonestly"]);
  assert.deepEqual(shown("notSent"), ["gonestly", "Kusto", "the"]);
  assert.equal(list.dictionaryFilterCounts(items({ usage: null }), NOW).neverHeard, 0);
  assert.equal(list.dictionaryFilterCounts(items({ usage: null }), NOW).speechMisses, 0);
});

test("most and least used: the final text first, then speech got it", () => {
  const rows = list.buildDictionaryListItems({
    words: ["Heardalot", "Usedalot", "Tie"],
    usage: [
      { word: "Heardalot", heard: 9, written: 1, missedRows: 0, bothRows: 1 },
      { word: "Usedalot", heard: 1, written: 5, missedRows: 4, bothRows: 1 },
      { word: "Tie", heard: 5, written: 5, missedRows: 0, bothRows: 5 },
    ],
  });
  const sorted = (sort) =>
    list
      .viewDictionaryList(rows, { filter: "all", sort, search: "", now: NOW, locale: "en" })
      .items.map((row) => row.word);
  assert.deepEqual(sorted("mostHeard"), ["Tie", "Usedalot", "Heardalot"]);
  assert.deepEqual(sorted("leastHeard"), ["Heardalot", "Usedalot", "Tie"]);
});

test("search: word contains, case-insensitive", () => {
  const view = list.viewDictionaryList(items(), {
    filter: "all",
    sort: "alpha",
    search: " HUB",
    now: NOW,
  });
  assert.deepEqual(
    view.items.map((row) => row.word),
    ["EngHub"]
  );
});

test("sorts: send order with its dividers, recent, A–Z, most and least heard", () => {
  const rows = items();
  const sorted = (sort) =>
    list
      .viewDictionaryList(rows, { filter: "all", sort, search: "", now: NOW, locale: "en" })
      .items.map((row) => row.word);
  assert.deepEqual(sorted("sendOrder"), [
    "SuperApp",
    "OpenWhispr",
    "EngHub",
    "the",
    "gonestly",
    "Kusto",
  ]);
  assert.deepEqual(sorted("recent"), [
    "gonestly",
    "EngHub",
    "SuperApp",
    "the",
    "OpenWhispr",
    "Kusto",
  ]);
  assert.deepEqual(sorted("alpha"), [
    "EngHub",
    "gonestly",
    "Kusto",
    "OpenWhispr",
    "SuperApp",
    "the",
  ]);
  assert.deepEqual(sorted("mostHeard"), [
    "the",
    "SuperApp",
    "EngHub",
    "OpenWhispr",
    "gonestly",
    "Kusto",
  ]);
  assert.deepEqual(sorted("leastHeard"), [
    "gonestly",
    "Kusto",
    "OpenWhispr",
    "EngHub",
    "SuperApp",
    "the",
  ]);

  const view = list.viewDictionaryList(rows, {
    filter: "all",
    sort: "sendOrder",
    search: "",
    now: NOW,
  });
  assert.deepEqual(view.dividers, [
    { index: 1, kind: "unread", count: 2 },
    { index: 3, kind: "notSent", count: 3 },
  ]);
  const alpha = list.viewDictionaryList(rows, {
    filter: "all",
    sort: "alpha",
    search: "",
    now: NOW,
  });
  assert.deepEqual(alpha.dividers, [], "dividers belong to send order");
});

test("dividers only where something precedes them; heard sorts fall back without counts", () => {
  const rows = items();
  const onlyCut = list.viewDictionaryList(rows, {
    filter: "notSent",
    sort: "sendOrder",
    search: "",
    now: NOW,
  });
  assert.deepEqual(onlyCut.dividers, [], "nothing sent above: no line");
  const noCounts = list.viewDictionaryList(items({ usage: null }), {
    filter: "all",
    sort: "mostHeard",
    search: "",
    now: NOW,
  });
  assert.equal(noCounts.items[0].word, "SuperApp", "send order");
  assert.equal(noCounts.dividers.length, 2);
});

test("two stored spellings of one word are both listed", () => {
  const rows = list.buildDictionaryListItems({
    words: ["Claude", "claude"],
    entries: [
      { word: "Claude", source: "manual", createdAt: daysAgo(2) },
      { word: "claude", source: "learned", createdAt: daysAgo(1) },
    ],
  });
  assert.deepEqual(
    rows.map((row) => [row.word, row.source]),
    [
      ["Claude", "manual"],
      ["claude", "learned"],
    ]
  );
});

test("a thousand words filter and sort in a few milliseconds", () => {
  const words = Array.from({ length: 1000 }, (_, i) => `Word${i}`);
  const rows = list.buildDictionaryListItems({
    words,
    entries: words.map((word, i) => ({
      word,
      source: i % 3 ? "learned" : "manual",
      createdAt: daysAgo(i % 30),
    })),
    coverage: words.map((term, i) => ({
      term,
      source: "learned",
      coverage: i < 199 ? "read" : "notSent",
      rank: i + 1,
    })),
    usage: words.map((word, i) => ({ word, heard: i % 50, written: i % 70, missedRows: 0 })),
  });
  const start = performance.now();
  for (const sort of list.DICTIONARY_SORTS) {
    list.viewDictionaryList(rows, { filter: "learned", sort, search: "word1", now: NOW });
  }
  list.dictionaryFilterCounts(rows, NOW);
  const ms = performance.now() - start;
  assert.ok(ms < 200, `${ms.toFixed(1)} ms`);
});

test("pin ranks: the listed pins in pin order; send order over the whole list puts them first", () => {
  const rows = list.buildDictionaryListItems({
    words: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"],
    // Pin order: Delta, then Alpha, then Echo (the Set's order, as main sends it).
    pinned: new Set(["delta", "gone", "alpha", "echo"]),
    coverage: [
      { term: "Delta", source: "pinned", coverage: "read", rank: 1 },
      { term: "Alpha", source: "pinned", coverage: "read", rank: 2 },
      { term: "Echo", source: "pinned", coverage: "unread", rank: 3 },
      { term: "Bravo", source: "manual", coverage: "unread", rank: 4 },
      { term: "Charlie", source: "manual", coverage: "notSent", rank: 5 },
    ],
  });
  assert.deepEqual(
    rows.map((row) => [row.word, row.pinRank]),
    [
      ["Alpha", 2],
      ["Bravo", null],
      ["Charlie", null],
      ["Delta", 1],
      ["Echo", 3],
    ]
  );
  const view = list.viewDictionaryList(rows, { filter: "all", sort: "sendOrder", search: "" });
  assert.equal(view.pinnedCount, 3);
  assert.deepEqual(
    view.items.map((row) => row.word),
    ["Delta", "Alpha", "Echo", "Bravo", "Charlie"],
    "the pins in pin order, even one past the window; the rest in send order"
  );
  // The lines fall in the rest; the pins above count as what precedes them.
  assert.deepEqual(view.dividers, [
    { index: 3, kind: "unread", count: 1 },
    { index: 4, kind: "notSent", count: 1 },
  ]);
  // A filter, a search or another sort: one list, the pins inline.
  for (const query of [
    { filter: "typed", sort: "sendOrder", search: "" },
    { filter: "all", sort: "sendOrder", search: "a" },
    { filter: "all", sort: "alpha", search: "" },
  ]) {
    assert.equal(list.viewDictionaryList(rows, query).pinnedCount, null, JSON.stringify(query));
  }
  const searched = list.viewDictionaryList(rows, { filter: "all", sort: "sendOrder", search: "a" });
  assert.deepEqual(
    searched.items.map((row) => row.word),
    ["Delta", "Alpha", "Echo", "Bravo", "Charlie"].filter((word) => /a/i.test(word))
  );
});

test("no pins: the section is there and empty, and a line can open the rest", () => {
  const rows = list.buildDictionaryListItems({
    words: ["Alpha", "Bravo"],
    coverage: [
      { term: "Alpha", source: "manual", coverage: "unread", rank: 1 },
      { term: "Bravo", source: "manual", coverage: "unread", rank: 2 },
    ],
  });
  const view = list.viewDictionaryList(rows, { filter: "all", sort: "sendOrder", search: "" });
  assert.equal(view.pinnedCount, 0);
  assert.deepEqual(view.dividers, [], "nothing precedes it");
  const pinned = list.buildDictionaryListItems({
    words: ["Alpha", "Bravo"],
    pinned: new Set(["bravo"]),
    coverage: [
      { term: "Bravo", source: "pinned", coverage: "read", rank: 1 },
      { term: "Alpha", source: "manual", coverage: "notSent", rank: 2 },
    ],
  });
  assert.deepEqual(
    list.viewDictionaryList(pinned, { filter: "all", sort: "sendOrder", search: "" }).dividers,
    [{ index: 1, kind: "notSent", count: 1 }],
    "right under the pins"
  );
});
