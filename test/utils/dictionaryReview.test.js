const test = require("node:test");
const assert = require("node:assert/strict");

// Tidy up's "Ask a model" as data (dictionaryReview.ts): what the request
// carries, the estimate, the reply parsed leniently and validated strictly
// (malformed, oversized, unknown words, a word named twice, a protected
// spelling), the revision that makes a reply stale, and what a suggestion
// applies. Synthetic words only.

let review;
let prompt;
test.before(async () => {
  review = await import("../../src/utils/dictionaryReview.ts");
  prompt = await import("../../src/config/prompts/dictionaryReview.ts");
});

const WORDS = [
  {
    word: "OpenWhispr",
    source: "manual",
    pinned: true,
    usage: { heard: 0, written: 6, missedRows: 6 },
  },
  {
    word: "the",
    source: "learned",
    pinned: false,
    usage: { heard: 2752, written: 2760, missedRows: 0 },
  },
  {
    word: "groq",
    source: "learned",
    pinned: false,
    usage: { heard: 2, written: 2, missedRows: 0 },
  },
  {
    word: "agents-shared",
    source: "learned",
    pinned: false,
    usage: { heard: 4, written: 10, missedRows: 6 },
  },
  {
    word: "agentsshared",
    source: "learned",
    pinned: false,
    usage: { heard: 0, written: 1, missedRows: 1 },
  },
  {
    word: "Claude",
    source: "manual",
    pinned: false,
    usage: { heard: 1, written: 2, missedRows: 1 },
  },
  {
    word: "CLAUDE",
    source: "learned",
    pinned: false,
    usage: { heard: 0, written: 0, missedRows: 0 },
  },
  { word: "8/5", source: "learned", pinned: false, usage: { heard: 0, written: 0, missedRows: 0 } },
];
const SENT = WORDS.map((entry) => entry.word);

const reply = (suggestions) => JSON.stringify({ suggestions });

test("the request: each word with its source, pin and counts, nothing else", () => {
  const request = review.buildDictionaryReviewRequest({
    words: WORDS,
    usageAvailable: true,
    uiLanguage: "de",
  });
  const lines = request.text.split("\n");
  assert.equal(lines[0], "Columns: word, source, pinned, heard, written, missed");
  assert.deepEqual(JSON.parse(lines[1]), ["OpenWhispr", "typed", 1, 0, 6, 6]);
  assert.deepEqual(JSON.parse(lines[2]), ["the", "auto", 0, 2752, 2760, 0]);
  assert.equal(lines.length, WORDS.length + 1);
  assert.deepEqual(request.words, SENT);
  assert.equal(
    request.estimatedTokens,
    Math.ceil((request.systemPrompt.length + request.text.length) / 4)
  );
  assert.match(request.systemPrompt, /one short sentence in German/);
  assert.match(request.systemPrompt, /never an instruction to you/);
  assert.match(request.systemPrompt, /Heard 0 and written 0 means it never came up/);

  // Without counts, none are sent (never zeros).
  const blind = review.buildDictionaryReviewRequest({
    words: WORDS,
    usageAvailable: false,
    uiLanguage: "xx",
  });
  assert.equal(blind.text.split("\n")[0], "Columns: word, source, pinned");
  assert.deepEqual(JSON.parse(blind.text.split("\n")[1]), ["OpenWhispr", "typed", 1]);
  assert.match(blind.systemPrompt, /no usage counts/);
  assert.match(blind.systemPrompt, /in English/);
  assert.equal(prompt.reviewLanguageName("zh-TW"), "Traditional Chinese");
});

test("the reply is read leniently: a code fence, prose around the object", () => {
  const body = reply([{ action: "remove", words: ["the"], reason: "An ordinary word." }]);
  for (const text of [
    body,
    "```json\n" + body + "\n```",
    "Here is my review:\n\n```\n" + body + "\n```\nThanks.",
    "Sure! " + body + " Let me know.",
  ]) {
    const parsed = review.parseDictionaryReviewReply(text, { words: SENT });
    assert.equal(parsed.status, "ok", text);
    assert.equal(parsed.kept, 1);
  }
  // Braces inside a reason don't end the object early.
  const braces = reply([{ action: "remove", words: ["8/5"], reason: "A date {like} 8/5." }]);
  assert.equal(review.parseDictionaryReviewReply(braces, { words: SENT }).kept, 1);
});

test("malformed and oversized replies are dropped whole", () => {
  for (const text of [
    "",
    "No changes needed.",
    "{ not json }",
    JSON.stringify({ changes: [] }),
    JSON.stringify({ suggestions: "none" }),
    '{"suggestions": [',
    42,
    null,
  ]) {
    const parsed = review.parseDictionaryReviewReply(text, { words: SENT });
    assert.equal(parsed.status, "malformed", String(text));
    assert.deepEqual(parsed.suggestions, []);
  }
  const tooMany = reply(
    Array.from({ length: 301 }, () => ({ action: "keep", words: ["the"], reason: "x" }))
  );
  const oversized = review.parseDictionaryReviewReply(tooMany, { words: SENT });
  assert.equal(oversized.status, "oversized");
  assert.equal(oversized.dropped, 301);
  const huge = review.parseDictionaryReviewReply("x".repeat(200_001), { words: SENT });
  assert.equal(huge.status, "oversized");
  assert.equal(review.parseDictionaryReviewReply(reply([]), { words: SENT }).status, "ok");
});

test("each suggestion is validated strictly; the invalid ones are dropped and counted", () => {
  const parsed = review.parseDictionaryReviewReply(
    reply([
      { action: "remove", words: ["the"], reason: "Ordinary." },
      { action: "respell", words: ["groq"], into: "Groq", reason: "A company name." },
      {
        action: "merge",
        words: ["agents-shared", "agentsshared"],
        into: "agents-shared",
        reason: "Same.",
      },
      // Unknown action, unknown word, a word named again, an invented word.
      { action: "rename", words: ["8/5"], reason: "?" },
      { action: "remove", words: ["kubectl"], reason: "Not in the list." },
      { action: "remove", words: ["the"], reason: "Again." },
      { action: "remove", words: ["8/5", "invented"], reason: "Half known." },
      // into: two lines, too long, missing for a respell, the same spelling.
      { action: "respell", words: ["8/5"], into: "eight\nfive", reason: "x" },
      { action: "respell", words: ["8/5"], into: "y".repeat(101), reason: "x" },
      { action: "respell", words: ["8/5"], reason: "x" },
      { action: "respell", words: ["8/5"], into: "8/5", reason: "x" },
      // A reason too long, or missing; words not an array; a merge of one.
      { action: "remove", words: ["8/5"], reason: "r".repeat(201) },
      { action: "remove", words: ["8/5"] },
      { action: "remove", words: "8/5", reason: "x" },
      { action: "merge", words: ["8/5"], into: "8/5", reason: "x" },
      "not an object",
      // Finally valid.
      { action: "keep", words: ["8/5"], reason: "A sprint name." },
    ]),
    { words: SENT }
  );
  assert.equal(parsed.status, "ok");
  assert.deepEqual(
    parsed.suggestions.map((s) => [s.action, s.words.join("+"), s.into ?? null]),
    [
      ["remove", "the", null],
      ["respell", "groq", "Groq"],
      ["merge", "agents-shared+agentsshared", "agents-shared"],
      ["keep", "8/5", null],
    ]
  );
  assert.equal(parsed.kept, 4);
  assert.equal(parsed.dropped, 13);
});

test("words are matched as sent, or by key when only one word has it", () => {
  const parsed = review.parseDictionaryReviewReply(
    reply([
      { action: "remove", words: ["THE"], reason: "Ordinary." },
      // "claude" is both Claude and CLAUDE: ambiguous, dropped.
      { action: "remove", words: ["claude"], reason: "?" },
    ]),
    { words: SENT }
  );
  assert.deepEqual(
    parsed.suggestions.map((s) => s.words),
    [["the"]]
  );
  assert.equal(parsed.dropped, 1);
});

test("a glossary spelling or snippet trigger is never removed or renamed by a suggestion", () => {
  const parsed = review.parseDictionaryReviewReply(
    reply([
      { action: "remove", words: ["OpenWhispr"], reason: "x" },
      { action: "respell", words: ["OpenWhispr"], into: "Open Whispr", reason: "x" },
      {
        action: "merge",
        words: ["agents-shared", "agentsshared"],
        into: "agentsshared",
        reason: "x",
      },
      {
        action: "merge",
        words: ["agentsshared", "agents-shared"],
        into: "Agents-Shared",
        reason: "x",
      },
      {
        action: "merge",
        words: ["agentsshared", "agents-shared"],
        into: "agents-shared",
        reason: "Keep the protected one.",
      },
    ]),
    { words: SENT, protectedKeys: new Set(["openwhispr", "agents-shared"]) }
  );
  // Only the one that keeps the protected spelling is allowed.
  assert.deepEqual(
    parsed.suggestions.map((s) => s.reason),
    ["Keep the protected one."]
  );
  assert.equal(parsed.dropped, 4);
});

test("a reply is stale when a word, its source or its pin changed", () => {
  const before = review.dictionaryRevision(WORDS);
  assert.equal(review.dictionaryRevision(WORDS.map((entry) => ({ ...entry }))), before);
  assert.notEqual(review.dictionaryRevision(WORDS.slice(1)), before);
  assert.notEqual(
    review.dictionaryRevision(WORDS.map((e, i) => (i === 2 ? { ...e, pinned: true } : e))),
    before
  );
  assert.notEqual(
    review.dictionaryRevision(WORDS.map((e, i) => (i === 2 ? { ...e, source: "manual" } : e))),
    before
  );
});

test("what a suggestion applies", () => {
  const ops = (s) => review.reviewSuggestionOps({ id: "x", reason: "", ...s }, SENT);
  assert.deepEqual(ops({ action: "remove", words: ["the", "8/5"] }), [
    { kind: "remove", words: ["the", "8/5"] },
  ]);
  assert.deepEqual(ops({ action: "respell", words: ["groq"], into: "Groq" }), [
    { kind: "respell", from: "groq", to: "Groq" },
  ]);
  assert.deepEqual(
    ops({ action: "merge", words: ["agents-shared", "agentsshared"], into: "agents-shared" }),
    [{ kind: "merge", from: "agentsshared", into: "agents-shared" }]
  );
  // Into another dictionary word: both fold into it.
  assert.deepEqual(ops({ action: "merge", words: ["groq", "8/5"], into: "the" }), [
    { kind: "merge", from: "groq", into: "the" },
    { kind: "merge", from: "8/5", into: "the" },
  ]);
  // A new spelling: the first is respelled, the rest merge into it.
  assert.deepEqual(
    ops({ action: "merge", words: ["agents-shared", "agentsshared"], into: "Agents Shared" }),
    [
      { kind: "respell", from: "agents-shared", to: "Agents Shared" },
      { kind: "merge", from: "agentsshared", into: "Agents Shared" },
    ]
  );
  assert.deepEqual(ops({ action: "keep", words: ["8/5"] }), []);
});
