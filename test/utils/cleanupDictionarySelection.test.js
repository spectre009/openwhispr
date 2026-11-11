const test = require("node:test");
const assert = require("node:assert/strict");

const {
  estimateDictionaryTokens,
  normalizeCleanupDictionarySetting,
  selectCleanupDictionary,
} = require("../../src/utils/snippets.ts");

// Settings › Dictation › Cleanup › "Dictionary words in the cleanup prompt":
// the one selection a cleanup request is built from (its words and the scope
// its step records). Only dictionary words are filtered; the glossary's
// canonical forms and snippet triggers always follow. Synthetic words only.

const settings = (cleanupDictionaryWords) => ({
  customDictionary: ["OpenWhispr", "gonestly", "EngHub", "Scout Web", "the", "Kusto"],
  snippets: [{ trigger: "cal link", replacement: "https://cal.example" }],
  cleanupDictionaryWords,
});
const SOURCES = {
  learned: new Set(["gonestly", "engHub".toLowerCase(), "scout web", "the"]),
  pinned: new Set(["scout web"]),
  missed: new Set(["enghub"]),
};
const GLOSSARY = ["Little Buddy", "kusto"];

test("All: every word, as today, then the glossary and snippet triggers", () => {
  const { words, scope } = selectCleanupDictionary(settings("all"), SOURCES, GLOSSARY);
  assert.deepEqual(words, [
    "OpenWhispr",
    "gonestly",
    "EngHub",
    "Scout Web",
    "the",
    "Kusto",
    "Little Buddy",
    "cal link",
  ]);
  assert.deepEqual(scope, { setting: "all", applied: "all", words: 6 });
});

test("typed and pinned: learned words go unless pinned", () => {
  const { words, scope } = selectCleanupDictionary(settings("typedPinned"), SOURCES, GLOSSARY);
  assert.deepEqual(words, ["OpenWhispr", "Scout Web", "Kusto", "Little Buddy", "cal link"]);
  assert.deepEqual(scope, { setting: "typedPinned", applied: "typedPinned", words: 3 });
});

test("typed, pinned and missed: learned words speech often misses stay", () => {
  const { words, scope } = selectCleanupDictionary(
    settings("typedPinnedMissed"),
    SOURCES,
    GLOSSARY
  );
  assert.deepEqual(words, [
    "OpenWhispr",
    "EngHub",
    "Scout Web",
    "Kusto",
    "Little Buddy",
    "cal link",
  ]);
  assert.equal(scope.words, 4);
  assert.equal(scope.applied, "typedPinnedMissed");
});

test("None: no dictionary words, but glossary spellings and triggers still go", () => {
  const { words, scope } = selectCleanupDictionary(settings("none"), SOURCES, GLOSSARY);
  assert.deepEqual(words, ["Little Buddy", "kusto", "cal link"]);
  assert.deepEqual(scope, { setting: "none", applied: "none", words: 0 });
});

test("without counts (history off, not loaded) 'missed' sends All, and the scope says so", () => {
  const { words, scope } = selectCleanupDictionary(
    settings("typedPinnedMissed"),
    { ...SOURCES, missed: null },
    GLOSSARY
  );
  assert.equal(words.length, 8);
  assert.deepEqual(scope, { setting: "typedPinnedMissed", applied: "all", words: 6 });
});

test("before the word sources are read, typed can't be told apart: All", () => {
  const { scope } = selectCleanupDictionary(
    settings("typedPinned"),
    { learned: null, pinned: new Set(), missed: null },
    GLOSSARY
  );
  assert.deepEqual(scope, { setting: "typedPinned", applied: "all", words: 6 });
});

test("an unknown setting reads as All; the estimate is characters ÷ 4", () => {
  assert.equal(normalizeCleanupDictionarySetting("most"), "all");
  assert.equal(normalizeCleanupDictionarySetting(undefined), "all");
  assert.equal(selectCleanupDictionary(settings("most"), SOURCES, GLOSSARY).scope.setting, "all");
  assert.equal(estimateDictionaryTokens([]), 0);
  assert.equal(estimateDictionaryTokens(["abcd", "efgh"]), 3, "'abcd, efgh' is 10 characters");
});

// ─── Categories (Dictionary v2, Stage C) ───

const CATEGORY = new Map([
  ["openwhispr", "work"],
  ["enghub", "work"],
  ["scout web", "people"],
  ["the", "everyday"],
  ["kusto", "everyday"],
  ["little buddy", "people"],
]);
const categoryOf = (word) => CATEGORY.get(word.trim().toLowerCase()) ?? null;

test("All words except everyday words: everyday words leave; the glossary and triggers stay", () => {
  const { words, scope } = selectCleanupDictionary(
    settings("noEveryday"),
    { ...SOURCES, categories: categoryOf },
    GLOSSARY
  );
  // "Kusto" is an everyday word here, but the glossary's "kusto" still goes.
  assert.deepEqual(words, [
    "OpenWhispr",
    "gonestly",
    "EngHub",
    "Scout Web",
    "Little Buddy",
    "kusto",
    "cal link",
  ]);
  assert.deepEqual(scope, { setting: "noEveryday", applied: "noEveryday", words: 4 });
});

test("All words except everyday words, before the categories are ready: All, and the scope says so", () => {
  for (const categories of [null, undefined]) {
    const { words, scope } = selectCleanupDictionary(
      settings("noEveryday"),
      { ...SOURCES, categories },
      GLOSSARY
    );
    assert.equal(words.length, 8);
    assert.deepEqual(scope, { setting: "noEveryday", applied: "all", words: 6 });
  }
});

test("grouping: the same flat words, plus groups in the flat list's order; triggers under Other", () => {
  const grouped = selectCleanupDictionary(
    { ...settings("all"), cleanupDictionaryGrouping: true },
    { ...SOURCES, categories: categoryOf },
    GLOSSARY
  );
  const flat = selectCleanupDictionary(settings("all"), SOURCES, GLOSSARY);
  assert.deepEqual(grouped.words, flat.words, "the flat list doesn't change");
  assert.deepEqual(grouped.scope, flat.scope);
  assert.deepEqual(grouped.groups, [
    { group: "people", words: ["Scout Web", "Little Buddy"] },
    { group: "work", words: ["OpenWhispr", "EngHub"] },
    { group: "everyday", words: ["the", "Kusto"] },
    { group: "other", words: ["gonestly", "cal link"] },
  ]);
  // Every flat word is in exactly one group.
  assert.deepEqual(grouped.groups.flatMap((entry) => entry.words).sort(), [...flat.words].sort());
});

test("grouping off, or the categories not ready: no groups at all (the request is today's)", () => {
  const off = selectCleanupDictionary(
    settings("all"),
    { ...SOURCES, categories: categoryOf },
    GLOSSARY
  );
  assert.equal("groups" in off, false);
  assert.deepEqual(Object.keys(off), ["words", "scope"]);
  const notReady = selectCleanupDictionary(
    { ...settings("all"), cleanupDictionaryGrouping: true },
    { ...SOURCES, categories: null },
    GLOSSARY
  );
  assert.equal("groups" in notReady, false);
  const empty = selectCleanupDictionary(
    { customDictionary: [], snippets: [], cleanupDictionaryGrouping: true },
    { ...SOURCES, categories: categoryOf },
    []
  );
  assert.equal("groups" in empty, false, "nothing to group");
});

test("grouping with a word set: the groups follow the set", () => {
  const { words, groups } = selectCleanupDictionary(
    { ...settings("noEveryday"), cleanupDictionaryGrouping: true },
    { ...SOURCES, categories: categoryOf },
    GLOSSARY
  );
  assert.deepEqual(groups, [
    { group: "people", words: ["Scout Web", "Little Buddy"] },
    { group: "work", words: ["OpenWhispr", "EngHub"] },
    // The glossary's spelling stays, under its own category.
    { group: "everyday", words: ["kusto"] },
    { group: "other", words: ["gonestly", "cal link"] },
  ]);
  assert.equal(groups.flatMap((entry) => entry.words).length, words.length);
});

// The shared team dictionary: teammates' words follow the user's own (and the
// glossary and triggers) within the LLM prompts' shared cap, for every set but
// None, and never bring back a personal word the set left out.
test("teammates' words follow every set but None, and never undo the set", () => {
  const shared = (cleanupDictionaryWords) => ({
    ...settings(cleanupDictionaryWords),
    sharedDictionaryHints: { space: ["Qdrant"], workspace: ["the", "Acme", "openwhispr"] },
  });
  const all = selectCleanupDictionary(shared("all"), SOURCES, GLOSSARY);
  assert.deepEqual(all.words.slice(-2), ["Qdrant", "Acme"]);
  assert.equal(all.scope.words, 6, "the scope counts the user's own words");

  const typed = selectCleanupDictionary(shared("typedPinned"), SOURCES, GLOSSARY);
  assert.deepEqual(typed.words, [
    "OpenWhispr",
    "Scout Web",
    "Kusto",
    "Little Buddy",
    "cal link",
    "Qdrant",
    "Acme",
  ]);
  assert.ok(!typed.words.includes("the"), "a learned word left out stays out");

  const none = selectCleanupDictionary(shared("none"), SOURCES, GLOSSARY);
  assert.deepEqual(none.words, ["Little Buddy", "kusto", "cal link"]);
});

test("a moved word whose shared copies the member hid leaves the selection", () => {
  const { words } = selectCleanupDictionary(
    {
      ...settings("all"),
      sharedDictionaryHints: { space: [], workspace: [], suppressedPersonal: ["ENGHUB"] },
    },
    SOURCES,
    GLOSSARY
  );
  assert.ok(!words.includes("EngHub"));
});
