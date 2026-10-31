const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyDictionaryWord,
  dictionaryCategoryCounts,
  effectiveDictionaryCategory,
  formatCleanupDictionaryGroups,
  groupCleanupDictionaryWords,
  isEverydayWords,
} = require("../../src/utils/dictionaryCategories.ts");

// Dictionary categories (Dictionary v2, Stage C): the rules that place a word
// from its shape and the bundled common-word list, the effective category
// (an explicit choice, else the rules) and the cleanup prompt's grouping.
// The measured examples are the plan's; the list is the shipped one.

const COMMON = new Set(require("../../src/config/commonEnglishWords.json"));

test("the shipped list: what the measured examples rely on", () => {
  for (const word of ["janitorial", "kusto", "aria", "buddy"]) {
    assert.equal(COMMON.has(word), false, `${word} isn't in the list`);
  }
  for (const word of ["little", "the", "ideas"]) {
    assert.equal(COMMON.has(word), true, `${word} is in the list`);
  }
});

test("work: digits, an inner separator or #, an inner capital, all caps of 2+ letters", () => {
  const work = [
    "SuperApp",
    "IDEAs",
    "AriaEvent.view",
    "PR",
    "CED",
    "CUUD",
    "agents-shared",
    "snake_case",
    "8/5",
    "C#",
    "gpt-4o",
    "Windows 11",
    "iPhone",
    "Hugin SDK",
  ];
  for (const word of work) {
    assert.equal(classifyDictionaryWord(word, COMMON), "work", word);
    // Rule 1 needs no list: it runs before the list loads.
    assert.equal(classifyDictionaryWord(word, null), "work", `${word} without the list`);
  }
});

test("everyday: every token in the common list, capitalized or not", () => {
  for (const word of ["The", "Ideas", "the", "little", "Little Ideas"]) {
    assert.equal(classifyDictionaryWord(word, COMMON), "everyday", word);
  }
  assert.equal(isEverydayWords("Little Buddy", COMMON), false, "buddy isn't common");
});

test("people: capitalized and not everyday words (names, and the products the list doesn't know)", () => {
  for (const word of ["Little Buddy", "Aishwaria", "Dmitry", "Kusto", "Aria", "Janitorial"]) {
    assert.equal(classifyDictionaryWord(word, COMMON), "people", word);
  }
});

test("unsorted: lowercase and not common", () => {
  for (const word of ["kusto", "groq", "worktree", "little buddy"]) {
    assert.equal(classifyDictionaryWord(word, COMMON), null, word);
  }
});

test("first match wins: a capitalized acronym-like word is work, not people", () => {
  assert.equal(classifyDictionaryWord("IDEAs", COMMON), "work", "not everyday (ideas)");
  assert.equal(classifyDictionaryWord("EngHub", COMMON), "work");
  // Case and spacing: the trimmed word is read; a leading space changes nothing.
  assert.equal(classifyDictionaryWord("  Dmitry  ", COMMON), "people");
  // A multi-word name made of everyday words except one.
  assert.equal(classifyDictionaryWord("Little Buddy", COMMON), "people");
  // A lowercase first token isn't a name: a later capitalized token doesn't make one.
  assert.equal(classifyDictionaryWord("little Buddy", COMMON), null);
});

test("without the list: only the work rule; everything else unsorted until it loads", () => {
  for (const word of ["The", "Little Buddy", "Kusto", "kusto"]) {
    assert.equal(classifyDictionaryWord(word, null), null, word);
  }
  assert.equal(classifyDictionaryWord("", COMMON), null);
  assert.equal(classifyDictionaryWord(42, COMMON), null);
});

test("effective category: the stored choice, else the rules, with who decided", () => {
  const stored = new Map([
    ["kusto", { category: "work", source: "model" }],
    ["janitorial", { category: "everyday", source: "user" }],
  ]);
  assert.deepEqual(effectiveDictionaryCategory("Kusto", stored, COMMON), {
    category: "work",
    source: "model",
  });
  assert.deepEqual(effectiveDictionaryCategory("JANITORIAL", stored, COMMON), {
    category: "everyday",
    source: "user",
  });
  assert.deepEqual(effectiveDictionaryCategory("Aria", stored, COMMON), {
    category: "people",
    source: "auto",
  });
  assert.deepEqual(effectiveDictionaryCategory("groq", stored, COMMON), {
    category: null,
    source: "auto",
  });
  // A stored choice counts before the list loads.
  assert.deepEqual(effectiveDictionaryCategory("Kusto", stored, null), {
    category: "work",
    source: "model",
  });
  assert.deepEqual(effectiveDictionaryCategory("Kusto", null, null), {
    category: null,
    source: "auto",
  });
});

test("counts per category", () => {
  const words = ["Dmitry", "PR", "the", "groq", "Aria"];
  assert.deepEqual(
    dictionaryCategoryCounts(words, (word) => classifyDictionaryWord(word, COMMON)),
    { people: 2, work: 1, everyday: 1, unsorted: 1 }
  );
});

test("grouping: people, work, everyday, other; each group in the flat list's order; empty ones left out", () => {
  const flat = ["groq", "Dmitry", "PR", "Aria", "CED", "worktree", "cal link"];
  const groups = groupCleanupDictionaryWords(flat, (word, index) =>
    index < 6 ? classifyDictionaryWord(word, COMMON) : null
  );
  assert.deepEqual(groups, [
    { group: "people", words: ["Dmitry", "Aria"] },
    { group: "work", words: ["PR", "CED"] },
    { group: "other", words: ["groq", "worktree", "cal link"] },
  ]);
  const labels = {
    people: "People",
    work: "Work terms",
    everyday: "Everyday words",
    other: "Other",
  };
  assert.equal(
    formatCleanupDictionaryGroups(groups, (group) => labels[group]),
    "People: Dmitry, Aria; Work terms: PR, CED; Other: groq, worktree, cal link"
  );
  assert.deepEqual(
    groupCleanupDictionaryWords([], () => "people"),
    [],
    "no words, no groups"
  );
});
