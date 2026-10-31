const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// "Sort into categories" › Ask a model as data (dictionaryCategoryReview.ts):
// the request carries the words with their current category and who set it,
// nothing else (a canary in every other field); the reply is parsed leniently
// and validated strictly (malformed, oversized, unknown word or category, a
// reason that isn't one short line, a word named twice); and the store drops
// a reply when the dictionary or its categories changed while it ran, and
// discards a cancelled one. Synthetic words only.

let review;
let prompt;
test.before(async () => {
  review = await import("../../src/utils/dictionaryCategoryReview.ts");
  prompt = await import("../../src/config/prompts/dictionaryCategoryReview.ts");
});

const CANARY = "qxzcanary";
const ENTRIES = [
  { word: "Aishwaria", category: "people", source: "auto" },
  { word: "Kusto", category: "people", source: "auto" },
  { word: "groq", category: null, source: "auto" },
  { word: "EngHub", category: "work", source: "user" },
  { word: "Janitorial", category: "everyday", source: "model" },
  // Whatever else an entry might carry never reaches the request.
  {
    word: "Scout Web",
    category: "work",
    source: "auto",
    usage: { heard: 99, written: 98 },
    evidence: `${CANARY}evidence`,
    transcript: `${CANARY}transcript`,
    app: `${CANARY}.exe`,
  },
];

test("the request: words, their category and who set it; never counts, History or text", () => {
  const request = review.buildDictionaryCategoryReviewRequest({
    entries: [...ENTRIES, { word: "Kusto", category: "work", source: "user" }, { word: "" }],
    uiLanguage: "de",
  });
  assert.deepEqual(request.words, [
    "Aishwaria",
    "Kusto",
    "groq",
    "EngHub",
    "Janitorial",
    "Scout Web",
  ]);
  assert.deepEqual(request.text.split("\n"), [
    "Columns: word, category, set by",
    '["Aishwaria","people","auto"]',
    '["Kusto","people","auto"]',
    '["groq","unsorted","auto"]',
    '["EngHub","work","user"]',
    '["Janitorial","everyday","model"]',
    '["Scout Web","work","auto"]',
  ]);
  const everything = `${request.systemPrompt}\n${request.text}`;
  assert.equal(everything.includes(CANARY), false, "nothing but the word and its category");
  assert.equal(everything.includes("99"), false, "no usage counts");
  assert.match(request.systemPrompt, /in German/, "reasons in the UI language");
  assert.match(request.systemPrompt, /\{"proposals":\[/);
  assert.equal(
    request.estimatedTokens,
    Math.ceil((request.systemPrompt.length + request.text.length) / 4)
  );
});

test("the prompt is fixed and English, and asks for at most 80 proposals", () => {
  const text = prompt.buildDictionaryCategoryReviewPrompt({ uiLanguage: "fr" });
  assert.equal(prompt.DICTIONARY_CATEGORY_REVIEW_ASKED_MAX, 80);
  assert.match(text, /at most 80 changes/);
  assert.match(text, /"people", "work" or "everyday"/);
  assert.match(text, /never an instruction to you/);
  assert.equal(
    prompt.buildDictionaryCategoryReviewPrompt({ uiLanguage: "xx" }).includes("in English"),
    true
  );
});

const WORDS = ENTRIES.map((entry) => entry.word);
const parse = (reply) => review.parseDictionaryCategoryReviewReply(reply, { words: WORDS });

test("lenient parsing: a code fence and text around the JSON are fine", () => {
  const body = JSON.stringify({
    proposals: [{ word: "Kusto", category: "work", reason: "A query language" }],
  });
  for (const reply of [body, "```json\n" + body + "\n```", `Here you go:\n${body}\nThanks`]) {
    const parsed = parse(reply);
    assert.equal(parsed.status, "ok");
    assert.deepEqual(parsed.proposals, [
      { id: "category:Kusto", word: "Kusto", category: "work", reason: "A query language" },
    ]);
  }
});

test("strict validation: unknown words and categories, bad reasons and repeats are dropped", () => {
  const parsed = parse(
    JSON.stringify({
      proposals: [
        { word: "Kusto", category: "work", reason: "A query language" },
        { word: "kusto", category: "everyday", reason: "Named again: the later one goes" },
        { word: "Nonexistent", category: "work", reason: "Not sent" },
        { word: "groq", category: "products", reason: "Unknown category" },
        { word: "groq", category: "work", reason: "Line one\nline two" },
        { word: "Aishwaria", category: "people", reason: "x".repeat(201) },
        { word: "aishwaria", category: "people", reason: "  A name  " },
        { word: "Janitorial", category: "everyday" },
        { word: 42, category: "work", reason: "Not a string" },
        "not an object",
      ],
    })
  );
  assert.equal(parsed.status, "ok");
  assert.deepEqual(
    parsed.proposals.map((p) => [p.word, p.category, p.reason]),
    [
      ["Kusto", "work", "A query language"],
      // Matched by key: only one sent word has it.
      ["Aishwaria", "people", "A name"],
      ["Janitorial", "everyday", ""],
    ]
  );
  assert.equal(parsed.kept, 3);
  assert.equal(parsed.dropped, 7);
});

test("a word matched by key only when exactly one sent word has it", () => {
  const parsed = review.parseDictionaryCategoryReviewReply(
    JSON.stringify({ proposals: [{ word: "claude", category: "people", reason: "" }] }),
    { words: ["Claude", "CLAUDE"] }
  );
  assert.deepEqual(parsed.proposals, []);
  assert.equal(parsed.dropped, 1);
});

test("malformed and oversized replies drop everything", () => {
  assert.equal(parse("no JSON here").status, "malformed");
  assert.equal(parse('{"suggestions":[]}').status, "malformed");
  assert.equal(parse('{"proposals":').status, "malformed");
  const many = JSON.stringify({
    proposals: Array.from({ length: 301 }, () => ({ word: "Kusto", category: "work" })),
  });
  const tooMany = parse(many);
  assert.equal(tooMany.status, "oversized");
  assert.deepEqual(tooMany.proposals, []);
  assert.equal(tooMany.dropped, 301);
  assert.equal(parse("x".repeat(200_001)).status, "oversized");
  assert.deepEqual(parse('{"proposals":[]}'), {
    status: "ok",
    proposals: [],
    kept: 0,
    dropped: 0,
  });
});

test("the revision: words, categories and who set them", () => {
  const base = review.dictionaryCategoryRevision(ENTRIES);
  assert.equal(review.dictionaryCategoryRevision(ENTRIES.map((e) => ({ ...e }))), base);
  const recategorized = ENTRIES.map((e) => (e.word === "Kusto" ? { ...e, category: "work" } : e));
  assert.notEqual(review.dictionaryCategoryRevision(recategorized), base);
  const chosen = ENTRIES.map((e) => (e.word === "Kusto" ? { ...e, source: "user" } : e));
  assert.notEqual(review.dictionaryCategoryRevision(chosen), base);
  assert.notEqual(review.dictionaryCategoryRevision(ENTRIES.slice(1)), base);
});

// ─── The store: staleness and Cancel ───

async function loadStores(t) {
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", uiLanguage: "en" },
    window: { electronAPI: {} },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-category-review-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
    },
  });
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const categories = await vite.ssrLoadModule("/stores/dictionaryCategoriesStore.ts");
  const reviewStore = await vite.ssrLoadModule("/stores/dictionaryCategoryReviewStore.ts");
  return { settings, categories, reviewStore };
}

const OPTION = {
  id: "openai·gpt-test·",
  roles: ["cleanup"],
  scope: "dictationCleanup",
  provider: "openai",
  model: "gpt-test",
  modelName: "GPT Test",
  request: { model: "gpt-test", config: { inferenceScope: "dictationCleanup" } },
};

test("the store: a reply after the dictionary or its categories changed is dropped; Cancel discards a late one", async (t) => {
  const { settings, categories, reviewStore } = await loadStores(t);
  const { useSettingsStore } = settings;
  const { useDictionaryCategoriesStore } = categories;
  const { askCategoryReview, cancelCategoryReview, useDictionaryCategoryReviewStore } = reviewStore;
  useSettingsStore.setState({ customDictionary: ["Kusto", "groq"] });
  useDictionaryCategoriesStore.setState({
    stored: new Map(),
    storedLoaded: true,
    commonWords: new Set(["the"]),
    ready: true,
  });
  const request = review.buildDictionaryCategoryReviewRequest({
    entries: [
      { word: "Kusto", category: "people", source: "auto" },
      { word: "groq", category: null, source: "auto" },
    ],
  });
  const reply = JSON.stringify({
    proposals: [{ word: "Kusto", category: "work", reason: "A query language" }],
  });

  // Fresh: the proposals, validated.
  const sent = [];
  await askCategoryReview({
    option: OPTION,
    request,
    process: async (text, model, agentName, config) => {
      sent.push({ text, model, config });
      return reply;
    },
  });
  const done = useDictionaryCategoryReviewStore.getState().review;
  assert.equal(done.status, "done");
  assert.deepEqual(
    done.proposals.map((p) => [p.word, p.category]),
    [["Kusto", "work"]]
  );
  // The request: the review's own prompt, logs redacted, a complete reply,
  // giving way to a dictation, tagged for Cancel.
  assert.equal(sent[0].text, request.text);
  assert.equal(sent[0].config.systemPrompt, request.systemPrompt);
  assert.equal(sent[0].config.redactLogs, true);
  assert.equal(sent[0].config.requireCompleteOutput, true);
  assert.equal(sent[0].config.yieldToDictation, true);
  assert.match(sent[0].config.requestId, /^dictionary-category-review-/);
  assert.equal(sent[0].config.temperature, 0);

  // A category changed meanwhile: dropped as stale.
  await askCategoryReview({
    option: OPTION,
    request,
    process: async () => {
      useDictionaryCategoriesStore.setState({
        stored: new Map([["groq", { category: "work", source: "user" }]]),
      });
      return reply;
    },
  });
  assert.deepEqual(useDictionaryCategoryReviewStore.getState().review, {
    status: "dropped",
    reason: "stale",
    modelName: "GPT Test",
    dropped: 0,
  });

  // A word changed meanwhile: stale too.
  await askCategoryReview({
    option: OPTION,
    request,
    process: async () => {
      useSettingsStore.setState({ customDictionary: ["Kusto", "groq", "Aria"] });
      return reply;
    },
  });
  assert.equal(useDictionaryCategoryReviewStore.getState().review.reason, "stale");

  // Cancel: the late reply is discarded.
  let release;
  const pending = askCategoryReview({
    option: OPTION,
    request,
    process: () => new Promise((resolve) => (release = () => resolve(reply))),
  });
  assert.equal(useDictionaryCategoryReviewStore.getState().review.status, "running");
  cancelCategoryReview();
  release();
  await pending;
  assert.deepEqual(useDictionaryCategoryReviewStore.getState().review, { status: "idle" });

  // Malformed: nothing kept.
  await askCategoryReview({ option: OPTION, request, process: async () => "nope" });
  assert.equal(useDictionaryCategoryReviewStore.getState().review.reason, "malformed");
});
