const test = require("node:test");
const assert = require("node:assert/strict");

// Tidy up's checks (dictionaryTidy.ts) against the patterns measured in a real
// list (design notes, "Measured"): common words (the, What), typos
// (gonestly, aessions, approverl), fragments (then...ahh, enough,this, 8/5),
// spelling pairs (agents-shared / agentsshared, Claude / CLAUDE), plurals
// (file / files) and a split phrase (Little + Buddy). The words are synthetic
// stand-ins; nothing here is a real dictation.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

let tidy;
let learnerWords;
let commonWords;
test.before(async () => {
  tidy = await import("../../src/utils/dictionaryTidy.ts");
  learnerWords = new Set(
    (await import("../../src/utils/correctionCommonWords.js")).CORRECTION_COMMON_WORDS
  );
  commonWords = new Set(require("../../src/config/commonEnglishWords.json"));
});

function word(spelling, source, usage, { pinned = false, ageDays = 60 } = {}) {
  return {
    word: spelling,
    source,
    pinned,
    createdAt: sqlTime(NOW - ageDays * DAY),
    usage: usage ? { heard: usage[0], written: usage[1], missedRows: usage[2] ?? 0 } : null,
  };
}

// The list, roughly as measured.
const WORDS = [
  word("OpenWhispr", "manual", [0, 6, 6], { pinned: true }),
  word("the", "learned", [2752, 2760, 0]),
  word("What", "learned", [877, 880, 0]),
  word("Now", "learned", [486, 490, 0], { pinned: true }),
  word("rather", "learned", [5, 5, 0]),
  word("engine", "learned", [5, 9, 3]),
  word("soon", "learned", [0, 0, 0]),
  word("model", "manual", [30, 30, 0]),
  word("gonestly", "learned", [0, 0, 0], { ageDays: 40 }),
  word("aessions", "learned", [0, 1, 0]),
  word("sesions", "learned", [1, 1, 0]),
  word("approverl", "learned", [0, 0, 0]),
  word("approver", "manual", [3, 5, 2]),
  word("then...ahh", "learned", [0, 0, 0]),
  word("enough,this", "learned", [0, 0, 0]),
  word("8/5", "learned", [0, 0, 0]),
  word("2024", "learned", [0, 0, 0]),
  word("agents-shared", "learned", [4, 10, 6]),
  word("agentsshared", "learned", [0, 1, 1]),
  word("Claude", "manual", [10, 20, 10]),
  word("CLAUDE", "learned", [1, 3, 2]),
  word("file", "learned", [10, 10, 0]),
  word("files", "learned", [4, 4, 0]),
  word("Little", "learned", [280, 300, 20]),
  word("Buddy", "learned", [293, 293, 0]),
  word("Look", "learned", [391, 391, 0]),
  word("freshword", "learned", [0, 0, 0], { ageDays: 5 }),
  word("EngHub", "manual", [0, 0, 0]),
];

const AGGREGATES = {
  frequentTokens: [
    { token: "the", rows: 2752 },
    { token: "sessions", rows: 169 },
    { token: "honestly", rows: 12 },
    { token: "approver", rows: 5 },
    { token: "seldom", rows: 4 },
  ],
  adjacency: [
    { a: "Little", b: "Buddy", together: 255, rarerRows: 293 },
    { a: "the", b: "model", together: 20, rarerRows: 30 },
  ],
};

function run(overrides = {}) {
  return tidy.computeTidyGroups({
    words: WORDS,
    usageAvailable: true,
    aggregates: AGGREGATES,
    commonWords,
    learnerCommonWords: learnerWords,
    protectedKeys: new Set(["look"]),
    now: NOW,
    ...overrides,
  });
}

const groupOf = (groups, kind) => groups.find((group) => group.kind === kind);
const wordsIn = (group) => group.items.map((item) => item.words.join(" + "));

test("the common-word list: SCOWL's everyday words, not product names", () => {
  // Auto-learn's own everyday words are the same list Tidy up reads.
  const { COMMON_WORDS } = require("../../src/utils/correctionLearner.js");
  assert.deepEqual([...COMMON_WORDS].sort(), [...learnerWords].sort());
  assert.ok(COMMON_WORDS.has("the") && COMMON_WORDS.has("what"));
  for (const spelling of ["the", "for", "what", "file", "files", "honestly"]) {
    assert.ok(commonWords.has(spelling), `${spelling} is common`);
  }
  for (const spelling of ["openwhispr", "kubectl", "claude", "approver"]) {
    assert.equal(commonWords.has(spelling), false, `${spelling} isn't`);
  }
  for (const spelling of commonWords) {
    assert.match(spelling, /^\p{L}{2,}$/u, "lowercase letters, two or more");
    assert.equal(spelling, spelling.toLowerCase());
  }
  assert.ok(commonWords.size > 8000 && commonWords.size < 12000, `${commonWords.size} words`);
});

test("groups come in order, each word in one group (never heard aside)", () => {
  const groups = run();
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["variants", "plurals", "splitPhrases", "ordinary", "typos", "fragments", "neverHeard"]
  );
  const seen = new Map();
  for (const group of groups) {
    if (group.informational) continue;
    for (const item of group.items) {
      for (const spelling of item.words) {
        assert.equal(
          seen.has(spelling),
          false,
          `${spelling} in ${seen.get(spelling)} and ${group.kind}`
        );
        seen.set(spelling, group.kind);
      }
    }
  }
});

test("case and spelling variants: keep the one written more often; only learned ones go", () => {
  const variants = groupOf(run(), "variants");
  assert.deepEqual(wordsIn(variants), ["agents-shared + agentsshared", "Claude + CLAUDE"]);
  const [agents, claude] = variants.items;
  assert.equal(agents.action, "keep-one");
  assert.equal(agents.keep, "agents-shared", "written 10 against 1");
  assert.equal(agents.reason.key, "dictionary.tidy.reasons.keepWritten");
  assert.equal(agents.preselected, true);
  assert.equal(claude.keep, "Claude");
  assert.equal(claude.preselected, true, "CLAUDE, the one that goes, was auto-learned");
  assert.deepEqual(tidy.tidyItemOps(claude), [{ kind: "merge", from: "CLAUDE", into: "Claude" }]);
  assert.deepEqual(tidy.tidyItemOps(claude, { keep: "CLAUDE" }), [
    { kind: "merge", from: "Claude", into: "CLAUDE" },
  ]);

  // Without counts: typed, then the newest. A typed word that would go is never preselected.
  const blind = groupOf(run({ usageAvailable: false, aggregates: null }), "variants");
  const blindClaude = blind.items.find((item) => item.words.includes("Claude"));
  assert.equal(blindClaude.keep, "Claude");
  assert.equal(blindClaude.reason.key, "dictionary.tidy.reasons.keepTyped");
  const typedLoses = groupOf(
    tidy.computeTidyGroups({
      words: [word("Claude", "manual", [0, 1, 0]), word("CLAUDE", "learned", [5, 9, 0])],
      usageAvailable: true,
      aggregates: null,
      commonWords,
      learnerCommonWords: learnerWords,
      now: NOW,
    }),
    "variants"
  ).items[0];
  assert.equal(typedLoses.keep, "CLAUDE");
  assert.equal(typedLoses.preselected, false, "the typed word would go");
});

test("a glossary spelling or snippet trigger is kept, never merged away", () => {
  const groups = tidy.computeTidyGroups({
    words: [word("Groq", "learned", [3, 3, 0]), word("groq", "learned", [0, 9, 0])],
    usageAvailable: true,
    aggregates: null,
    commonWords,
    learnerCommonWords: learnerWords,
    protectedKeys: new Set(["groq"]),
    now: NOW,
  });
  // Both share the protected key: neither can be merged away.
  assert.equal(groupOf(groups, "variants").items.length, 0);

  const kept = tidy.computeTidyGroups({
    words: [
      word("agents-shared", "learned", [0, 0, 0]),
      word("agentsshared", "learned", [0, 9, 0]),
    ],
    usageAvailable: true,
    aggregates: null,
    commonWords,
    learnerCommonWords: learnerWords,
    protectedKeys: new Set(["agents-shared"]),
    now: NOW,
  });
  const item = groupOf(kept, "variants").items[0];
  assert.equal(item.locked, true);
  assert.equal(item.keep, "agents-shared");
  assert.deepEqual(tidy.tidyItemOps(item, { keep: "agentsshared" }), [
    { kind: "merge", from: "agentsshared", into: "agents-shared" },
  ]);
  // Look is protected: not an ordinary word to remove.
  assert.equal(wordsIn(groupOf(run(), "ordinary")).includes("Look"), false);
});

test("plurals: keep the one written more often, or neither when both are ordinary", () => {
  const plurals = groupOf(run(), "plurals");
  assert.deepEqual(wordsIn(plurals), ["file + files"]);
  const [pair] = plurals.items;
  assert.equal(pair.allowNone, true, "both are common words speech gets right");
  assert.equal(pair.keep, null);
  assert.equal(pair.preselected, true);
  assert.deepEqual(tidy.tidyItemOps(pair), [{ kind: "remove", words: ["file", "files"] }]);
  assert.deepEqual(tidy.tidyItemOps(pair, { keep: "file" }), [
    { kind: "merge", from: "files", into: "file" },
  ]);

  // Speech misses "files": keep the one written more often.
  const words = WORDS.map((entry) =>
    entry.word === "files" ? word("files", "learned", [4, 14, 10]) : entry
  );
  const missed = groupOf(run({ words }), "plurals").items[0];
  assert.equal(missed.allowNone, false);
  assert.equal(missed.keep, "files");
});

test("ordinary words: common and heard ≥ 3 with nothing missed, or auto-learn's everyday words", () => {
  const ordinary = groupOf(run(), "ordinary");
  assert.deepEqual(wordsIn(ordinary), ["the", "What", "Now", "rather", "model"]);
  const byWord = new Map(ordinary.items.map((item) => [item.words[0], item]));
  assert.equal(byWord.get("the").reason.key, "dictionary.tidy.reasons.ordinaryLearner");
  assert.equal(byWord.get("rather").reason.key, "dictionary.tidy.reasons.ordinaryHeard");
  assert.equal(byWord.get("rather").reason.params.count, 5);
  assert.equal(byWord.get("the").preselected, true);
  assert.equal(byWord.get("Now").preselected, false, "pinned");
  assert.equal(byWord.get("model").preselected, false, "typed");
  // Speech misses "engine"; "soon" is 0/0: unknown, never "speech gets it right".
  assert.equal(byWord.has("engine"), false);
  assert.equal(byWord.has("soon"), false);
  assert.equal(ordinary.unavailable, null);

  // Without History only auto-learn's everyday words are listed, and the group says so.
  const blind = groupOf(run({ usageAvailable: false, aggregates: null }), "ordinary");
  assert.deepEqual(wordsIn(blind), ["the", "What", "Now"]);
  assert.equal(blind.unavailable, "partial");
});

test("likely typos: near a word said often or a dictionary word, rarely used", () => {
  const typos = groupOf(run(), "typos");
  assert.deepEqual(wordsIn(typos), ["gonestly", "aessions", "approverl"]);
  const [gonestly, aessions, approverl] = typos.items;
  assert.equal(gonestly.action, "remove");
  assert.equal(gonestly.to, "honestly");
  assert.deepEqual(gonestly.reason, {
    key: "dictionary.tidy.reasons.typoToken",
    params: { target: "honestly", count: 12 },
  });
  assert.equal(aessions.to, "sessions");
  assert.equal(approverl.action, "respell");
  assert.equal(approverl.to, "approver");
  assert.equal(approverl.toExisting, true, "already in the dictionary: a merge");
  assert.ok(typos.items.every((item) => item.preselected));
  assert.deepEqual(tidy.tidyItemOps(gonestly), [{ kind: "remove", words: ["gonestly"] }]);
  assert.deepEqual(tidy.tidyItemOps(gonestly, { respell: true }), [
    { kind: "respell", from: "gonestly", to: "honestly" },
  ]);
  assert.deepEqual(tidy.tidyItemOps(approverl), [
    { kind: "respell", from: "approverl", to: "approver" },
  ]);
  // Heard and written twice: not "rarely used". A token in 4 dictations isn't "often".
  assert.equal(wordsIn(typos).includes("sesions"), false);

  // Under five letters: one edit at most.
  const short = groupOf(
    tidy.computeTidyGroups({
      words: [word("wrk", "learned", [0, 0, 0]), word("wxrq", "learned", [0, 0, 0])],
      usageAvailable: true,
      aggregates: { frequentTokens: [{ token: "work", rows: 40 }], adjacency: [] },
      commonWords,
      learnerCommonWords: new Set(),
      now: NOW,
    }),
    "typos"
  );
  assert.deepEqual(wordsIn(short), ["wrk"]);
  assert.equal(short.items[0].to, "work");
  assert.equal(tidy.matchCase("Kubernets", "kubernetes"), "Kubernetes");
  assert.equal(tidy.matchCase("AWSS", "aws"), "AWS");

  // Needs History.
  const blind = groupOf(run({ usageAvailable: false, aggregates: null }), "typos");
  assert.deepEqual(blind.items, []);
  assert.equal(blind.unavailable, "history");
});

test("fragments: punctuation inside, digits only, an edge mark, one character", () => {
  const fragments = groupOf(run(), "fragments");
  assert.deepEqual(wordsIn(fragments), ["then...ahh", "enough,this", "8/5", "2024"]);
  assert.deepEqual(
    fragments.items.map((item) => item.reason.key),
    [
      "dictionary.tidy.reasons.fragment.punctuation",
      "dictionary.tidy.reasons.fragment.punctuation",
      "dictionary.tidy.reasons.fragment.punctuation",
      "dictionary.tidy.reasons.fragment.digits",
    ]
  );
  assert.equal(tidy.fragmentKind("x"), "short");
  assert.equal(tidy.fragmentKind("pre-"), "edge");
  assert.equal(tidy.fragmentKind(".net"), "edge");
  assert.equal(tidy.fragmentKind("a;b"), "punctuation");
  assert.equal(tidy.fragmentKind("CLAUDE.md"), null);
  // Fragments don't need History.
  const blind = groupOf(run({ usageAvailable: false, aggregates: null }), "fragments");
  assert.equal(blind.items.length, 4);
  assert.equal(blind.unavailable, null);
});

test("split phrases come before ordinary words: two everyday words can be one name", () => {
  const words = [word("Little", "learned", [300, 300, 0]), word("Buddy", "learned", [293, 293, 0])];
  const groups = tidy.computeTidyGroups({
    words,
    usageAvailable: true,
    aggregates: {
      frequentTokens: [],
      adjacency: [{ a: "Little", b: "Buddy", together: 255, rarerRows: 293 }],
    },
    commonWords: new Set(["little", "buddy"]),
    learnerCommonWords: new Set(),
    now: NOW,
  });
  assert.deepEqual(wordsIn(groupOf(groups, "splitPhrases")), ["Little + Buddy"]);
  assert.deepEqual(wordsIn(groupOf(groups, "ordinary")), []);
});

test("split phrases: side by side in ≥ 80% of the rarer one's dictations, ≥ 5 of them", () => {
  const split = groupOf(run(), "splitPhrases");
  assert.deepEqual(wordsIn(split), ["Little + Buddy"]);
  const [item] = split.items;
  assert.equal(item.phrase, "Little Buddy");
  assert.equal(item.phraseExists, false);
  assert.equal(item.preselected, true);
  assert.deepEqual(item.reason.params, { together: 255, count: 293, word: "Buddy" });
  assert.deepEqual(tidy.tidyItemOps(item), [
    { kind: "add-phrase", phrase: "Little Buddy", parts: ["Little", "Buddy"] },
  ]);

  // A typed part isn't preselected; a phrase already there only removes the parts.
  const words = [
    word("Little", "manual", [10, 10, 4]),
    word("Buddy", "learned", [9, 9, 0]),
    word("little buddy", "learned", [0, 0, 0]),
  ];
  const exists = groupOf(
    tidy.computeTidyGroups({
      words,
      usageAvailable: true,
      aggregates: {
        frequentTokens: [],
        adjacency: [{ a: "Little", b: "Buddy", together: 8, rarerRows: 9 }],
      },
      commonWords: new Set(),
      learnerCommonWords: new Set(),
      now: NOW,
    }),
    "splitPhrases"
  ).items[0];
  assert.equal(exists.phraseExists, true);
  assert.equal(exists.phrase, "little buddy");
  assert.equal(exists.preselected, false, "a typed part");

  // Below the share or the floor: not a phrase.
  for (const pair of [
    { a: "Little", b: "Buddy", together: 7, rarerRows: 9 },
    { a: "Little", b: "Buddy", together: 4, rarerRows: 4 },
  ]) {
    const none = groupOf(
      tidy.computeTidyGroups({
        words,
        usageAvailable: true,
        aggregates: { frequentTokens: [], adjacency: [pair] },
        commonWords: new Set(),
        learnerCommonWords: new Set(),
        now: NOW,
      }),
      "splitPhrases"
    );
    assert.equal(none.items.length, 0);
  }
  assert.equal(groupOf(run({ aggregates: null }), "splitPhrases").unavailable, "history");
});

test("never heard: learned, 0/0 for 90 days, added over 30 days ago; never preselected", () => {
  const never = groupOf(run(), "neverHeard");
  assert.equal(never.informational, true);
  assert.deepEqual(wordsIn(never), [
    "soon",
    "gonestly",
    "approverl",
    "then...ahh",
    "enough,this",
    "8/5",
    "2024",
  ]);
  assert.ok(never.items.every((item) => !item.preselected));
  assert.equal(wordsIn(never).includes("freshword"), false, "added 5 days ago");
  assert.equal(wordsIn(never).includes("EngHub"), false, "typed");
  const blind = groupOf(run({ usageAvailable: false, aggregates: null }), "neverHeard");
  assert.equal(blind.unavailable, "history");
  assert.deepEqual(blind.items, []);
});

test("preselection, the word count, and the 200-item cap", () => {
  const groups = run();
  const preselected = tidy.preselectedTidyItems(groups).map((item) => item.words.join(" + "));
  assert.ok(preselected.includes("the"));
  assert.ok(!preselected.includes("Now"), "pinned");
  assert.ok(!preselected.includes("model"), "typed");
  assert.ok(!preselected.includes("soon"), "never heard is informational");
  assert.ok(tidy.tidyWordCount(groups) >= preselected.length);

  const many = Array.from({ length: 250 }, (_, i) => word(`x${i}/y`, "learned", null));
  const capped = groupOf(
    tidy.computeTidyGroups({
      words: many,
      usageAvailable: false,
      aggregates: null,
      commonWords,
      learnerCommonWords: learnerWords,
      now: NOW,
    }),
    "fragments"
  );
  assert.equal(capped.items.length, 200);
  assert.equal(capped.total, 250);
});
