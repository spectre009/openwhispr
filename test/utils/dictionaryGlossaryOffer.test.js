const test = require("node:test");
const assert = require("node:assert/strict");

// A glossary rule offered from what speech wrote (dictionaryGlossaryOffer.ts):
// `anywhere` only for a spelling that never stayed as written in a final text
// and isn't everyday words; otherwise `start`, with why. A spelling an
// enabled rule already turns into the word is "handled". The measured
// patterns: "LittleBuddy", "Sean" → Shawn, "work tree" → worktree.

let offer;
test.before(async () => {
  offer = await import("../../src/utils/dictionaryGlossaryOffer.ts");
});

const COMMON = new Set(["work", "tree", "sean", "little", "buddy", "the"]);
const rule = (id, canonical, spellings, extra = {}) => ({
  id,
  canonical,
  spellings: spellings.map((text) =>
    typeof text === "string" ? { text, scope: "anywhere" } : text
  ),
  apps: [],
  enabled: true,
  revision: 1,
  ...extra,
});

test("everyday words: every token in the common list; unknown or unloaded counts as common", () => {
  assert.equal(offer.isCommonSpelling("work tree", COMMON), true);
  assert.equal(offer.isCommonSpelling("LittleBuddy", COMMON), false);
  assert.equal(offer.isCommonSpelling("Ash Varia", COMMON), false);
  assert.equal(offer.isCommonSpelling("Sean", COMMON), true);
  assert.equal(offer.isCommonSpelling("LittleBuddy", null), true, "not loaded");
  assert.equal(offer.isCommonSpelling("LittleBuddy", new Set()), true, "couldn't be read");
});

test("the scope: anywhere only when never kept and not common", () => {
  assert.deepEqual(offer.glossaryOfferScope({ keptInFinal: 0, common: false }), {
    scope: "anywhere",
    caution: null,
  });
  assert.deepEqual(offer.glossaryOfferScope({ keptInFinal: 5, common: false }), {
    scope: "start",
    caution: "kept",
  });
  assert.deepEqual(offer.glossaryOfferScope({ keptInFinal: 0, common: true }), {
    scope: "start",
    caution: "common",
  });
  assert.deepEqual(offer.glossaryOfferScope({ keptInFinal: null, common: false }), {
    scope: "start",
    caution: "unknown",
  });
});

test("a new rule from a variant: canonical the word, the spelling at its safe scope", () => {
  const safe = offer.glossaryOfferFor([], "Little Buddy", "LittleBuddy", {
    keptInFinal: 0,
    commonWords: COMMON,
  });
  assert.equal(safe.opened, "new");
  assert.deepEqual(safe.rule, {
    canonical: "Little Buddy",
    spellings: [{ text: "LittleBuddy", scope: "anywhere" }],
    apps: [],
    enabled: true,
  });
  const kept = offer.glossaryOfferFor([], "Shawn", "Sean", { keptInFinal: 5, commonWords: COMMON });
  assert.deepEqual(kept.rule.spellings, [{ text: "Sean", scope: "start" }]);
  assert.equal(kept.caution, "kept");
  const common = offer.glossaryOfferFor([], "worktree", "work tree", {
    keptInFinal: 0,
    commonWords: COMMON,
  });
  assert.deepEqual([common.scope, common.caution], ["start", "common"]);
});

test("existing rules: one with the spelling opens as it is; one that writes the word gains it", () => {
  const rules = [rule("r1", "Little Buddy", ["Littbuddy"]), rule("r2", "Shawn Smith", ["Sean"])];
  const added = offer.glossaryOfferFor(rules, "little buddy", "LittleBuddy", {
    keptInFinal: 0,
    commonWords: COMMON,
  });
  assert.equal(added.opened, "addedToRule");
  assert.equal(added.rule.id, "r1");
  assert.deepEqual(added.rule.spellings, [
    { text: "Littbuddy", scope: "anywhere" },
    { text: "LittleBuddy", scope: "anywhere" },
  ]);
  assert.deepEqual(rules[0].spellings.length, 1, "the stored rule isn't touched");
  const existing = offer.glossaryOfferFor(rules, "Shawn", "sean", {
    keptInFinal: 3,
    commonWords: COMMON,
  });
  assert.equal(existing.opened, "existingSpelling");
  assert.equal(existing.rule.id, "r2");
});

test("handled: an enabled rule writes this word from this spelling (any case and spacing)", () => {
  const rules = [
    rule("r1", "Little Buddy", ["littlebuddy"]),
    rule("r2", "Kusto", ["Custo"], { enabled: false }),
  ];
  assert.equal(offer.glossaryHandles(rules, "Little Buddy", "LittleBuddy")?.id, "r1");
  assert.equal(offer.glossaryHandles(rules, "Kusto", "Custo"), null, "a disabled rule doesn't");
  assert.equal(offer.glossaryHandles(rules, "Shawn", "LittleBuddy"), null, "another word");
});
