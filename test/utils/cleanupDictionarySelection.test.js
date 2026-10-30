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
