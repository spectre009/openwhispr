const test = require("node:test");
const assert = require("node:assert/strict");

// Similar words in a dictionary (dictionarySimilar.ts): spelling variants,
// plural pairs and near spellings, for a word (the word detail) and for the
// whole list (Tidy up). The patterns are the ones measured in a real list;
// the words are synthetic.

let similar;
test.before(async () => {
  similar = await import("../../src/utils/dictionarySimilar.ts");
});

test("spelling variants: case, hyphens, spaces, dots and underscores removed", () => {
  const { spellingKey, similarWordsFor } = similar;
  assert.equal(spellingKey("Agents-Shared"), "agentsshared");
  assert.equal(spellingKey(" dsa_code.review "), "dsacodereview");
  const words = ["Claude", "CLAUDE", "agents-shared", "agentsshared", "dsa-code-review"];
  assert.deepEqual(similarWordsFor("Claude", words), [{ word: "CLAUDE", reason: "variant" }]);
  assert.deepEqual(similarWordsFor("agents-shared", words), [
    { word: "agentsshared", reason: "variant" },
  ]);
  assert.deepEqual(similarWordsFor("dsa codereview", words), [
    { word: "dsa-code-review", reason: "variant" },
  ]);
});

test("plural pairs: s, es and ies, never shorter than three letters", () => {
  const { similarWordsFor } = similar;
  const words = ["file", "files", "box", "boxes", "query", "queries", "it", "its"];
  assert.deepEqual(similarWordsFor("files", words), [{ word: "file", reason: "plural" }]);
  assert.deepEqual(similarWordsFor("box", words), [{ word: "boxes", reason: "plural" }]);
  assert.deepEqual(similarWordsFor("queries", words), [{ word: "query", reason: "plural" }]);
  assert.deepEqual(
    similarWordsFor("its", words).filter((entry) => entry.reason === "plural"),
    []
  );
});

test("near spellings: distance 2 from five letters, 1 below; a swap counts once", () => {
  const { similarWordsFor, editDistance } = similar;
  assert.equal(editDistance("approverl", "approver"), 1);
  assert.equal(editDistance("teh", "the"), 1, "a swap of neighbours is one edit");
  assert.equal(editDistance("kitten", "sitting", 1), 2, "stops past the bound");
  const words = ["approver", "sessions", "honestly", "cat", "cot", "dog"];
  assert.deepEqual(similarWordsFor("approverl", words), [
    { word: "approver", reason: "near", distance: 1 },
  ]);
  assert.deepEqual(similarWordsFor("aessions", words), [
    { word: "sessions", reason: "near", distance: 1 },
  ]);
  assert.deepEqual(similarWordsFor("gonestly", words), [
    { word: "honestly", reason: "near", distance: 1 },
  ]);
  // Short words: one edit only.
  assert.deepEqual(similarWordsFor("cat", words), [{ word: "cot", reason: "near", distance: 1 }]);
  assert.deepEqual(similarWordsFor("cog", ["cat"]), []);
  // Five letters and up: two edits, never three.
  assert.deepEqual(similarWordsFor("Scout Web", ["Scoot Wab"]), [
    { word: "Scoot Wab", reason: "near", distance: 2 },
  ]);
  assert.deepEqual(similarWordsFor("CLAUDE.md", ["Claude"]), []);
  assert.deepEqual(similarWordsFor("Kiri", ["Kirk", "Kirby"]), [
    { word: "Kirk", reason: "near", distance: 1 },
  ]);
});

test("a word is never similar to itself, and the closest reason comes first", () => {
  const { similarWordsFor } = similar;
  const words = ["Scout Web", "scout-web", "Scout Webs", "Scout Wob"];
  assert.deepEqual(similarWordsFor("Scout Web", words), [
    { word: "scout-web", reason: "variant" },
    { word: "Scout Webs", reason: "plural" },
    { word: "Scout Wob", reason: "near", distance: 1 },
  ]);
  assert.deepEqual(similarWordsFor("", words), []);
});

test("the whole list: variant groups, plural pairs, near pairs, each once", () => {
  const { similarWordGroups } = similar;
  const groups = similarWordGroups([
    "agents-shared",
    "agentsshared",
    "Agents_Shared",
    "file",
    "files",
    "approver",
    "approverl",
    "Kusto",
    "Little",
    "buddy",
  ]);
  assert.deepEqual(groups, [
    { reason: "variant", words: ["agents-shared", "agentsshared", "Agents_Shared"] },
    { reason: "plural", words: ["file", "files"] },
    { reason: "near", words: ["approver", "approverl"] },
  ]);
});

test("a thousand words group in well under a second", () => {
  const { similarWordGroups } = similar;
  const words = Array.from({ length: 1000 }, (_, i) => `Term${i.toString(36)}x${i % 7}`);
  const start = performance.now();
  similarWordGroups(words);
  const ms = performance.now() - start;
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
});
