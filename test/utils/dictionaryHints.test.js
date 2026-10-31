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

// ── Dictionary v2, Stage B: pin order, evidence order, tail emission ─────────

const { dictionaryWordKey } = require("../../src/utils/dictionaryWordKey.js");

// The builder as it was before pin order and evidence order (stored order in
// every tier, tiers reversed for tail but not their entries): "added" must
// match it byte for byte wherever it has at most one pin.
function legacyBuild({
  dictionary,
  learnedWords,
  pinnedWords,
  glossaryTerms,
  snippets,
  includeSnippets = true,
  maxChars = Infinity,
  maxTerms = Infinity,
  order = "tail",
  readChars = WHISPER_DECODER_PROMPT_CHARS,
} = {}) {
  const PRIORITY = ["pinned", "manual", "glossary", "snippet", "learned"];
  const learned = new Set([...(learnedWords ?? [])].map((w) => w.trim().toLowerCase()));
  const pinned = new Set([...(pinnedWords ?? [])].map((w) => dictionaryWordKey(w)).filter(Boolean));
  const tiers = { pinned: [], manual: [], glossary: [], snippet: [], learned: [] };
  const seen = new Set();
  const add = (source, raw) => {
    if (typeof raw !== "string") return;
    const term = raw.trim();
    if (!term || seen.has(term.toLowerCase())) return;
    seen.add(term.toLowerCase());
    tiers[source].push(term);
  };
  const words = Array.isArray(dictionary) ? dictionary : [];
  for (const word of words) if (pinned.has(dictionaryWordKey(word))) add("pinned", word);
  for (const word of words) if (!learned.has(word.trim().toLowerCase())) add("manual", word);
  for (const term of glossaryTerms ?? []) add("glossary", term);
  if (includeSnippets) for (const snippet of snippets ?? []) add("snippet", snippet?.trigger);
  for (const word of words) add("learned", word);
  const budget = Number.isFinite(maxChars) ? Math.max(0, maxChars) : Infinity;
  const limit = Number.isFinite(maxTerms) ? Math.max(0, Math.floor(maxTerms)) : Infinity;
  const selected = new Set();
  let used = 0;
  let truncated = false;
  for (const source of PRIORITY) {
    for (const term of tiers[source]) {
      const cost = term.length + (selected.size > 0 ? 2 : 0);
      if (selected.size < limit && used + cost <= budget) {
        selected.add(term);
        used += cost;
      } else truncated = true;
    }
  }
  const emission = order === "tail" ? [...PRIORITY].reverse() : PRIORITY;
  const terms = emission.flatMap((source) => tiers[source].filter((t) => selected.has(t)));
  const prompt = terms.length > 0 ? terms.join(", ") : null;
  const offsets = new Map();
  let position = 0;
  for (const term of terms) {
    offsets.set(term, position);
    position += term.length + 2;
  }
  const readStart =
    order === "tail" && Number.isFinite(readChars) ? Math.max(0, (prompt?.length ?? 0) - readChars) : 0;
  const entries = PRIORITY.flatMap((source) =>
    tiers[source].map((term) => ({
      term,
      source,
      coverage: !selected.has(term)
        ? "notSent"
        : (offsets.get(term) ?? 0) >= readStart
          ? "read"
          : "unread",
    }))
  );
  return { prompt, terms, entries, truncated };
}

const score = (missedRows, written) => ({ missedRows, written });
// Evidence for some of the fixture's words: typed and learned, ties, 0/0.
const SCORES = new Map([
  ["kubernetes", score(5, 9)],
  ["supabase", score(5, 12)],
  ["gizmo labs", score(0, 40)],
  ["learnedterm140", score(9, 9)],
  ["learnedterm007", score(1, 3)],
  ["learnedterm090", score(1, 3)],
  ["learnedterm030", score(0, 0)],
]);

test("added: today's output byte for byte, on every order and budget, scores or not", () => {
  const base = {
    dictionary: DICTIONARY,
    learnedWords: LEARNED.map((w) => w.toLowerCase()),
    glossaryTerms: GLOSSARY_TERMS,
    snippets: [{ trigger: "cal link", replacement: "https://cal.example" }],
  };
  const variants = [
    {},
    { order: "head" },
    { maxChars: GROQ_PROMPT_CHARS },
    { maxChars: GROQ_PROMPT_CHARS, order: "head" },
    { maxTerms: 40, order: "head", includeSnippets: false },
    { maxChars: 300, pinnedWords: ["learnedterm100"] },
    { order: "head", pinnedWords: ["supabase"] },
  ];
  for (const variant of variants) {
    const legacy = legacyBuild({ ...base, ...variant });
    for (const options of [
      { rankBy: "added", scores: SCORES },
      { rankBy: "added" },
      { rankBy: "evidence" },
      { rankBy: "evidence", scores: new Map() },
      { rankBy: "evidence", scores: new Map([["supabase", score(0, 0)]]) },
    ]) {
      const plan = buildDictionaryHints({ ...base, ...variant, ...options });
      const label = JSON.stringify({ ...variant, ...options, scores: options.scores?.size });
      assert.equal(plan.prompt, legacy.prompt, label);
      assert.deepEqual(plan.terms, legacy.terms, label);
      assert.deepEqual(plan.entries, legacy.entries, label);
      assert.equal(plan.truncated, legacy.truncated, label);
      assert.equal(plan.evidence, false, label);
    }
  }
});

test("evidence: typed and learned tiers by missed rows, then rows used, then stored order", () => {
  const plan = buildDictionaryHints({
    dictionary: DICTIONARY,
    learnedWords: LEARNED.map((w) => w.toLowerCase()),
    glossaryTerms: GLOSSARY_TERMS,
    snippets: [{ trigger: "cal link", replacement: "https://cal.example" }],
    order: "head",
    rankBy: "evidence",
    scores: SCORES,
  });
  assert.equal(plan.evidence, true);
  const tier = (source) => plan.entries.filter((e) => e.source === source).map((e) => e.term);
  // Supabase and Kubernetes tie on missed rows, so rows used decide; Gizmo
  // Labs has none missed; OpenWhispr has no score and keeps its stored place last.
  assert.deepEqual(tier("manual"), ["Supabase", "Kubernetes", "Gizmo Labs", "OpenWhispr"]);
  const learned = tier("learned");
  // 140 (9 missed) first, then 007 and 090 tied 1/3 in stored order; 030's
  // 0/0 is no evidence: it stays in stored order with the rest.
  assert.deepEqual(learned.slice(0, 4), [
    "LearnedTerm140",
    "LearnedTerm007",
    "LearnedTerm090",
    "LearnedTerm000",
  ]);
  const unranked = learned.slice(3);
  assert.deepEqual(
    unranked,
    LEARNED.filter((w) => !["LearnedTerm140", "LearnedTerm007", "LearnedTerm090"].includes(w)),
    "every word without evidence, in stored order"
  );
  // The tiers themselves never move.
  assert.deepEqual(
    [...new Set(plan.entries.map((e) => e.source))],
    ["manual", "glossary", "snippet", "learned"]
  );
});

test("head order: the same tiers in the same sequence; only the ranked tiers' insides move", () => {
  for (const options of [{}, { maxTerms: 50 }, { maxChars: 600, pinnedWords: ["learnedterm020", "openwhispr"] }]) {
    const input = {
      dictionary: DICTIONARY,
      learnedWords: LEARNED.map((w) => w.toLowerCase()),
      glossaryTerms: GLOSSARY_TERMS,
      order: "head",
      includeSnippets: false,
      ...options,
    };
    const before = buildDictionaryHints({ ...input, rankBy: "added" });
    const after = buildDictionaryHints({ ...input, rankBy: "evidence", scores: SCORES });
    const sources = (plan) => plan.terms.map((term) => plan.entries.find((e) => e.term === term).source);
    assert.deepEqual(sources(after), sources(before), JSON.stringify(options));
    for (const source of ["pinned", "glossary", "snippet"]) {
      const of = (plan) => plan.entries.filter((e) => e.source === source).map((e) => e.term);
      assert.deepEqual(of(after), of(before), `${source} keeps its order`);
    }
    if (input.maxTerms !== undefined || input.maxChars !== undefined) continue;
    // With no cap the same words go; only their order within a tier differs.
    assert.deepEqual([...after.terms].sort(), [...before.terms].sort());
  }
});

test("pins go in pin order; a pin without a word in the dictionary is skipped", () => {
  const plan = buildDictionaryHints({
    dictionary: ["Alpha", "Bravo", "Charlie", "Delta"],
    learnedWords: ["bravo"],
    pinnedWords: ["delta", "gone", "BRAVO", "alpha"],
    order: "head",
  });
  assert.deepEqual(plan.terms, ["Delta", "Bravo", "Alpha", "Charlie"]);
  assert.deepEqual(
    plan.entries.map((e) => [e.term, e.source]),
    [
      ["Delta", "pinned"],
      ["Bravo", "pinned"],
      ["Alpha", "pinned"],
      ["Charlie", "manual"],
    ]
  );
  // Tail order reverses the pins too: the top pin is the prompt's last word.
  const tail = buildDictionaryHints({
    dictionary: ["Alpha", "Bravo", "Charlie", "Delta"],
    pinnedWords: ["delta", "bravo", "alpha"],
  });
  assert.equal(tail.prompt, "Charlie, Alpha, Bravo, Delta");
});

test("tail: pins that overflow the decoder window keep the top pins in it, read last", () => {
  // 30 pins of 22 characters: about 720 characters of pins against a 550 window.
  const pins = Array.from({ length: 30 }, (_, i) => `PinnedProductName${String(i).padStart(2, "0")}xyz`);
  const dictionary = [...pins, "Typed Word"];
  const plan = buildDictionaryHints({
    dictionary,
    pinnedWords: pins.map((p) => p.toLowerCase()),
    maxChars: WHISPER_PROMPT_CHARS,
    readChars: WHISPER_DECODER_PROMPT_CHARS,
  });
  assert.ok(plan.prompt.endsWith(pins[0]), "the top pin ends the prompt");
  const coverage = new Map(plan.entries.map((e) => [e.term, e.coverage]));
  assert.equal(coverage.get(pins[0]), "read");
  assert.equal(coverage.get(pins[1]), "read");
  assert.equal(coverage.get(pins[29]), "unread", "the last pin is outside the window");
  // Ranks stay highest first: the entries list the pins in pin order.
  assert.deepEqual(
    plan.entries.slice(0, 30).map((e) => e.term),
    pins
  );
  // The old builder emitted the pins' tier in order (only the tiers were
  // reversed), putting the top pin first among them, outside the window.
  const legacy = legacyBuild({
    dictionary,
    pinnedWords: pins.map((p) => p.toLowerCase()),
    maxChars: WHISPER_PROMPT_CHARS,
  });
  assert.equal(legacy.entries.find((e) => e.term === pins[0]).coverage, "unread");
});

test("tail: a ranked tier is reversed inside; budget picks highest priority first", () => {
  const plan = buildDictionaryHints({
    dictionary: ["Typed A", "Typed B", "Typed C", "learned x", "learned y", "learned z"],
    learnedWords: ["learned x", "learned y", "learned z"],
    glossaryTerms: ["Glossary One", "Glossary Two"],
    snippets: [{ trigger: "snip one" }, { trigger: "snip two" }],
    rankBy: "evidence",
    scores: new Map([
      ["typed c", score(3, 3)],
      ["typed b", score(1, 1)],
      ["learned z", score(2, 2)],
    ]),
  });
  // Learned (ranked: z, x, y → reversed), snippets and glossary as stored,
  // typed (ranked: C, B, A → reversed).
  assert.deepEqual(plan.terms, [
    "learned y",
    "learned x",
    "learned z",
    "snip one",
    "snip two",
    "Glossary One",
    "Glossary Two",
    "Typed A",
    "Typed B",
    "Typed C",
  ]);
  // A budget keeps the best: the typed tier's best, then on down.
  const capped = buildDictionaryHints({
    dictionary: ["Typed A", "Typed B", "Typed C"],
    rankBy: "evidence",
    scores: new Map([["typed c", score(3, 3)]]),
    maxTerms: 1,
  });
  assert.deepEqual(capped.terms, ["Typed C"]);
});
