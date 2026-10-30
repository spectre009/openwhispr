const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDictionaryHints, resolveHintTarget } = require("../../src/utils/dictionaryHints.ts");
const {
  GROQ_PROMPT_CHARS,
  TRANSCRIBE_PROMPT_CHARS,
  WHISPER_DECODER_PROMPT_CHARS,
  WHISPER_PROMPT_CHARS,
} = require("../../src/utils/dictionaryPromptCap.js");
const { matchesDictionaryPrompt } = require("../../src/utils/dictionaryEchoFilter.js");

// Synthetic: a few typed words among ~150 auto-learned ones, stored oldest
// first with the typed words in the middle, like a long-lived dictionary.
const LEARNED = Array.from({ length: 150 }, (_, i) => `LearnedTerm${String(i).padStart(3, "0")}`);
const MANUAL = ["OpenWhispr", "Supabase", "Gizmo Labs", "Kubernetes"];
const DICTIONARY = [...LEARNED.slice(0, 60), ...MANUAL, ...LEARNED.slice(60)];
const GLOSSARY_TERMS = ["Little Buddy"];
const ALIASES = ["everybody", "every body", "buddy", "buddies", "little buddies", "littlebuddy"];

function groqPlan(extra = {}) {
  const target = resolveHintTarget({ engine: "byok", provider: "groq", model: "whisper-large-v3" });
  return buildDictionaryHints({
    dictionary: DICTIONARY,
    learnedWords: LEARNED.map((w) => w.toLowerCase()),
    glossaryTerms: GLOSSARY_TERMS,
    snippets: [{ trigger: "cal link", replacement: "https://cal.example" }],
    maxChars: target.maxChars,
    order: target.order,
    readChars: target.readChars,
    ...extra,
  });
}

test("manual and canonical glossary terms land in the estimated read tail", () => {
  const plan = groqPlan();
  assert.ok(plan.prompt.length <= GROQ_PROMPT_CHARS, `prompt is ${plan.prompt.length} chars`);
  assert.equal(plan.truncated, true, "the fixture must overflow Groq's budget");
  const tail = plan.prompt.slice(-WHISPER_DECODER_PROMPT_CHARS);
  for (const term of [...MANUAL, ...GLOSSARY_TERMS]) {
    assert.ok(tail.includes(term), `${term} must be in the read tail`);
    const entry = plan.entries.find((e) => e.term === term);
    assert.equal(entry.coverage, "read", term);
  }
  // The highest priority is emitted last.
  assert.ok(plan.prompt.endsWith("Kubernetes"));
  assert.equal(plan.entries.find((e) => e.term === "cal link").source, "snippet");
});

test("a glossary's misheard spellings never enter the hint list", () => {
  const plan = groqPlan();
  const terms = new Set(plan.terms.map((t) => t.toLowerCase()));
  for (const alias of ALIASES) assert.ok(!terms.has(alias), alias);
  assert.ok(!/\beverybody\b/i.test(plan.prompt));
});

test("every entry gets an estimated coverage; overflow is 'not sent'", () => {
  const plan = groqPlan();
  const counts = { read: 0, unread: 0, notSent: 0 };
  for (const entry of plan.entries) counts[entry.coverage] += 1;
  assert.ok(counts.read > 0 && counts.unread > 0 && counts.notSent > 0, JSON.stringify(counts));
  // Everything sent is exactly what the prompt holds, in order.
  const sent = plan.entries.filter((e) => e.coverage !== "notSent").map((e) => e.term);
  assert.deepEqual(new Set(sent), new Set(plan.terms));
  assert.equal(plan.terms.join(", "), plan.prompt);
  // Learned entries fill what is left, so only they are cut.
  for (const entry of plan.entries.filter((e) => e.coverage === "notSent")) {
    assert.equal(entry.source, "learned", entry.term);
  }
});

test("an echo of the exact capped prompt is detected", () => {
  const plan = groqPlan();
  assert.equal(matchesDictionaryPrompt(plan.prompt, plan.prompt), true);
  // The uncapped list (what echo detection used to rebuild) misses it.
  const uncapped = buildDictionaryHints({
    dictionary: DICTIONARY,
    learnedWords: LEARNED.map((w) => w.toLowerCase()),
    glossaryTerms: GLOSSARY_TERMS,
  }).prompt;
  assert.equal(matchesDictionaryPrompt(plan.prompt, uncapped), false);
});

test("head order puts priority first for keyword channels and LLM transcribers", () => {
  const plan = buildDictionaryHints({
    dictionary: DICTIONARY,
    learnedWords: LEARNED.map((w) => w.toLowerCase()),
    glossaryTerms: GLOSSARY_TERMS,
    order: "head",
    includeSnippets: false,
  });
  assert.deepEqual(plan.terms.slice(0, 5), [...MANUAL, "Little Buddy"]);
  assert.equal(plan.terms.length, DICTIONARY.length + 1);
  assert.ok(plan.entries.every((e) => e.coverage === "read"));
});

test("a short dictionary is sent whole and read whole", () => {
  const plan = buildDictionaryHints({
    dictionary: ["OpenWhispr", "Hello"],
    learnedWords: ["hello"],
    glossaryTerms: ["Little Buddy"],
    maxChars: GROQ_PROMPT_CHARS,
  });
  assert.equal(plan.prompt, "Hello, Little Buddy, OpenWhispr");
  assert.equal(plan.truncated, false);
  assert.ok(plan.entries.every((e) => e.coverage === "read"));
  assert.deepEqual(
    plan.entries.map((e) => [e.term, e.source]),
    [
      ["OpenWhispr", "manual"],
      ["Little Buddy", "glossary"],
      ["Hello", "learned"],
    ]
  );
});

test("a canonical term already typed into the dictionary stays manual and appears once", () => {
  const plan = buildDictionaryHints({
    dictionary: ["little buddy", "Groq"],
    glossaryTerms: ["Little Buddy"],
  });
  assert.deepEqual(plan.terms, ["little buddy", "Groq"]);
  assert.equal(plan.entries[0].source, "manual");
});

test("no dictionary yields no prompt", () => {
  assert.equal(buildDictionaryHints({}).prompt, null);
  assert.deepEqual(buildDictionaryHints({ dictionary: null }).entries, []);
});

test("hint targets follow each provider's real limit", () => {
  assert.deepEqual(resolveHintTarget({ engine: "local-whisper" }), {
    channel: "prompt",
    order: "tail",
    maxChars: Infinity,
    readChars: WHISPER_DECODER_PROMPT_CHARS,
  });
  assert.equal(resolveHintTarget({ engine: "local-other" }).channel, "none");
  assert.equal(resolveHintTarget({ engine: "cloud" }).maxChars, GROQ_PROMPT_CHARS);
  assert.equal(
    resolveHintTarget({ engine: "byok", provider: "groq", model: "whisper-large-v3" }).maxChars,
    GROQ_PROMPT_CHARS
  );
  assert.equal(
    resolveHintTarget({ engine: "byok", provider: "openai", model: "whisper-1" }).maxChars,
    WHISPER_PROMPT_CHARS
  );
  assert.deepEqual(
    resolveHintTarget({ engine: "byok", provider: "openai", model: "gpt-4o-mini-transcribe" }),
    { channel: "prompt", order: "head", maxChars: TRANSCRIBE_PROMPT_CHARS, readChars: Infinity }
  );
  assert.equal(
    resolveHintTarget({ engine: "byok", provider: "openai", model: "gpt-transcribe" }).channel,
    "keywords"
  );
});

test("pinned words lead every other tier, whatever their source", () => {
  const plan = buildDictionaryHints({
    dictionary: ["Alpha", "Beta", "gonestly", "Gamma"],
    learnedWords: ["gonestly", "gamma"],
    pinnedWords: [" GAMMA "],
    glossaryTerms: ["Little Buddy"],
    order: "head",
  });
  assert.deepEqual(plan.terms, ["Gamma", "Alpha", "Beta", "Little Buddy", "gonestly"]);
  assert.equal(plan.entries[0].source, "pinned");
  // Tail order (Whisper decoders) emits the pinned word last, where it's read.
  const tail = buildDictionaryHints({
    dictionary: ["Alpha", "gamma"],
    learnedWords: ["gamma"],
    pinnedWords: ["gamma"],
  });
  assert.equal(tail.prompt, "Alpha, gamma");
});

test("a budget keeps pinned words before typed ones; a pin of a word not in the dictionary adds nothing", () => {
  const plan = buildDictionaryHints({
    dictionary: ["Typed One", "Typed Two", "Learned Pin"],
    learnedWords: ["learned pin"],
    pinnedWords: ["learned pin", "not here"],
    maxTerms: 2,
    order: "head",
  });
  assert.deepEqual(plan.terms, ["Learned Pin", "Typed One"]);
  assert.equal(plan.entries.find((entry) => entry.term === "Typed Two").coverage, "notSent");
  assert.ok(!plan.terms.includes("not here"));
});

test("pins use the one word identity: trimmed, NFC, lowercased", () => {
  const decomposed = "Cafe\u0301";
  const plan = buildDictionaryHints({
    dictionary: ["Zed", decomposed],
    pinnedWords: ["café"],
    order: "head",
  });
  assert.equal(plan.terms[0], decomposed);
  assert.equal(plan.entries[0].source, "pinned");
});
