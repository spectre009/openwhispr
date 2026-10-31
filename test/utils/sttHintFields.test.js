const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSttHintFields,
  isHintEcho,
  normalizeHintDictionary,
} = require("../../src/utils/sttHintFields.js");
const {
  GROQ_PROMPT_CHARS,
  WHISPER_PROMPT_CHARS,
} = require("../../src/utils/dictionaryPromptCap.js");

// What Re-transcribe builds per route (live parity is pinned on captured
// requests in test/helpers/sttHintParity.test.js). Synthetic words only.

const SIMPLIFIED_BIAS = "以下是简体中文。语言、学习、软件、网络。";
const dictionary = (extra = {}) => ({
  words: ["Alpha", "gonestly", "Little Buddy", "Gamma"],
  learned: ["gonestly"],
  pinned: ["gamma"],
  glossaryTerms: ["Scout Web"],
  snippets: [{ trigger: "cal link" }],
  chineseScriptPreference: null,
  speechLanguage: "en",
  ...extra,
});

test("the dictionary input is validated: strings only, triggers only, bounded", () => {
  const normalized = normalizeHintDictionary({
    words: ["ok", 3, "", null, "x".repeat(600)],
    learned: ["  MiXeD "],
    pinned: "nope",
    snippets: [{ trigger: "sig", replacement: "secret" }, { trigger: "" }, null],
    speechLanguage: "",
  });
  assert.deepEqual(normalized.words, ["ok", "x".repeat(500)]);
  assert.deepEqual(normalized.learned, ["mixed"]);
  assert.deepEqual(normalized.pinned, []);
  assert.deepEqual(normalized.snippets, [{ trigger: "sig" }]);
  assert.equal(normalized.speechLanguage, "auto");
  assert.deepEqual(buildSttHintFields({ route: "openai-compatible" }, null).prompt, null);
});

test("OpenAI whisper-1: a tail-ordered prompt, pinned then typed last; echo against it", () => {
  const fields = buildSttHintFields(
    { route: "openai-compatible", provider: "openai", endpoint: "", model: "whisper-1" },
    dictionary()
  );
  assert.equal(fields.prompt, "gonestly, cal link, Scout Web, Alpha, Little Buddy, Gamma");
  assert.deepEqual(fields.keywords, []);
  assert.deepEqual(fields.echo, { prompt: fields.prompt, dictionaryPrompt: fields.prompt });
  assert.equal(
    isHintEcho("gonestly, cal link, Scout Web, Alpha, Little Buddy, Gamma", fields.echo),
    true
  );
  assert.equal(isHintEcho("Send the report to Alpha today.", fields.echo), false);
});

test("gpt-transcribe: keywords[] in head order, the prompt only the script bias and overflow", () => {
  const words = Array.from({ length: 905 }, (_, i) => `Term${i}`);
  const fields = buildSttHintFields(
    { route: "openai-compatible", model: "gpt-transcribe" },
    { words, speechLanguage: "zh-CN" }
  );
  assert.equal(fields.keywords.length, 900);
  assert.equal(fields.keywords[0], "Term0");
  assert.equal(fields.prompt, `${SIMPLIFIED_BIAS} Term900, Term901, Term902, Term903, Term904`);
  assert.equal(fields.echo.dictionaryPrompt.split(", ").length, 905);
});

test("Groq: the budget leaves room for the script bias; the prompt never passes the cap", () => {
  const words = Array.from({ length: 300 }, (_, i) => `Word${i}`);
  const fields = buildSttHintFields(
    { route: "openai-compatible", provider: "groq", model: "whisper-large-v3" },
    { words, speechLanguage: "zh-TW" }
  );
  assert.ok(fields.prompt.length <= GROQ_PROMPT_CHARS, fields.prompt.length);
  assert.ok(fields.prompt.startsWith("以下是繁體中文"));
  assert.ok(fields.counts.notSent > 0);
  const whisper = buildSttHintFields({ route: "openai-compatible", model: "whisper-1" }, { words });
  assert.ok(whisper.prompt.length <= WHISPER_PROMPT_CHARS);
});

test("Orukeet takes no prompt; a translation from Auto never biases the script", () => {
  const orukeet = buildSttHintFields(
    { route: "openai-compatible", model: "orukeet-v0.1.0" },
    dictionary()
  );
  assert.equal(orukeet.prompt, null);
  assert.deepEqual(orukeet.echo, { prompt: null, dictionaryPrompt: null });
  const auto = buildSttHintFields(
    { route: "openai-compatible", model: "whisper-1" },
    dictionary({ speechLanguage: "auto", chineseScriptPreference: "simplified" })
  );
  assert.ok(!auto.prompt.includes("以下是"));
});

test("Azure Speech: at most 199 phrases, head order, no echo check", () => {
  const words = Array.from({ length: 205 }, (_, i) => `Phrase${i}`);
  const fields = buildSttHintFields({ route: "azure-speech" }, { words, pinned: ["phrase204"] });
  assert.equal(fields.phrases.length, 199);
  assert.equal(fields.phrases[0], "Phrase204");
  assert.equal(fields.echo, null);
  const one = buildSttHintFields({ route: "azure-speech" }, { words: ["OpenWhispr"] });
  assert.deepEqual(one.phrases, ["OpenWhispr"]);
  assert.equal(one.echo, null, "a one-word dictation equal to the phrase is kept");
});

test("Mistral: the biased prompt in head order, split into whitespace words, first 100", () => {
  const words = Array.from({ length: 80 }, (_, i) => `Two Words${i}`);
  const fields = buildSttHintFields({ route: "mistral" }, { words, speechLanguage: "zh-CN" });
  assert.equal(fields.contextBias.length, 100);
  assert.equal(fields.contextBias[0], SIMPLIFIED_BIAS);
  assert.deepEqual(fields.contextBias.slice(1, 4), ["Two", "Words0", "Two"]);
  assert.equal(fields.echo.dictionaryPrompt, fields.contextBias.join(" "));
  assert.equal(fields.echo.prompt, null);
});

test("Gemini and xAI: ≤ 100 keyterms of ≤ 50 characters, head order, no snippet triggers", () => {
  const words = ["x".repeat(70), ...Array.from({ length: 120 }, (_, i) => `Key${i}`)];
  for (const route of ["gemini", "xai"]) {
    const fields = buildSttHintFields({ route }, { words, snippets: [{ trigger: "cal link" }] });
    assert.equal(fields.keyterms.length, 100, route);
    assert.equal(fields.keyterms[0], "x".repeat(50), route);
    assert.ok(!fields.keyterms.includes("cal link"), route);
    assert.equal(fields.echo.dictionaryPrompt, fields.keyterms.join(", "), route);
  }
});

test("Tinfoil and managed Azure: the unbudgeted, script-biased tail prompt", () => {
  for (const route of ["tinfoil", "managed"]) {
    const fields = buildSttHintFields({ route }, dictionary({ speechLanguage: "zh-CN" }));
    assert.equal(
      fields.prompt,
      `${SIMPLIFIED_BIAS} gonestly, cal link, Scout Web, Alpha, Little Buddy, Gamma`
    );
    assert.equal(fields.echo.dictionaryPrompt, fields.dictionaryPrompt);
  }
  assert.equal(buildSttHintFields({ route: "tinfoil" }, { words: [] }).echo, null);
});

test("OpenWhispr Cloud: budgeted to Groq's cap, echo against what was sent", () => {
  const words = Array.from({ length: 300 }, (_, i) => `Cloud${i}`);
  const fields = buildSttHintFields({ route: "cloud" }, { words });
  assert.ok(fields.prompt.length <= GROQ_PROMPT_CHARS);
  assert.equal(fields.echo.prompt, fields.prompt);
});

test("routes that send nothing: Corti and local sherpa", () => {
  const fields = buildSttHintFields({ route: "none" }, dictionary());
  assert.equal(fields.prompt, null);
  assert.equal(fields.echo, null);
  assert.equal(buildSttHintFields({ route: "bogus" }, dictionary()).route, "none");
});

// ── The Dictionary page's coverage, read off the fields above ───────────────

const sentTerms = (fields) =>
  fields.entries.filter((entry) => entry.coverage !== "notSent").map((entry) => entry.term);

test("coverage: every term in priority order, ranked; nothing sent where nothing goes", () => {
  const fields = buildSttHintFields({ route: "none" }, dictionary());
  assert.deepEqual(
    fields.entries.map((entry) => [entry.term, entry.source, entry.rank, entry.coverage]),
    [
      ["Gamma", "pinned", 1, "notSent"],
      ["Alpha", "manual", 2, "notSent"],
      ["Little Buddy", "manual", 3, "notSent"],
      ["Scout Web", "glossary", 4, "notSent"],
      ["cal link", "snippet", 5, "notSent"],
      ["gonestly", "learned", 6, "notSent"],
    ]
  );
  assert.deepEqual(fields.budget, { unit: null, used: 0, limit: null, readChars: null });
  assert.deepEqual(fields.counts, { terms: 0, notSent: 6 });
  const orukeet = buildSttHintFields(
    { route: "openai-compatible", model: "orukeet-v0.1.0" },
    dictionary()
  );
  assert.deepEqual(sentTerms(orukeet), [], "Orukeet takes no prompt, so nothing is sent");
  assert.equal(orukeet.budget.unit, null);
});

test("coverage: a Whisper prompt's cut and tail window, measured on the prompt sent", () => {
  const words = Array.from({ length: 300 }, (_, i) => `Word${i}`);
  const fields = buildSttHintFields(
    { route: "openai-compatible", provider: "groq", model: "whisper-large-v3" },
    { words, pinned: ["word299"], speechLanguage: "zh-TW" }
  );
  const sent = sentTerms(fields);
  const carried = fields.prompt.replace(/^以下是\S*\s/, "").split(", ");
  assert.deepEqual([...sent].sort(), [...carried].sort(), "sent is what the prompt carries");
  assert.equal(fields.entries[0].term, "Word299");
  assert.equal(fields.entries[0].coverage, "read", "the pin is read: it's emitted last");
  const unread = fields.entries.filter((entry) => entry.coverage === "unread");
  assert.ok(unread.length > 0, "some sent words sit before the tail window");
  for (const entry of unread) {
    assert.ok(fields.prompt.indexOf(`${entry.term},`) < fields.prompt.length - 550, entry.term);
  }
  assert.ok(fields.counts.notSent > 0);
  assert.deepEqual(fields.budget, {
    unit: "chars",
    used: fields.prompt.length,
    limit: GROQ_PROMPT_CHARS,
    readChars: 550,
  });
});

test("coverage: phrase lists, keyterms and context words cut at their caps", () => {
  const many = (count, prefix) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  const azure = buildSttHintFields({ route: "azure-speech" }, { words: many(205, "Phrase") });
  assert.deepEqual(sentTerms(azure), azure.phrases);
  assert.equal(azure.counts.notSent, 6);
  assert.deepEqual(azure.budget, { unit: "phrases", used: 199, limit: 199, readChars: null });

  for (const route of ["gemini", "xai"]) {
    const fields = buildSttHintFields({ route }, { words: many(120, "Key") });
    assert.deepEqual(sentTerms(fields), fields.keyterms, route);
    assert.equal(fields.entries[100].coverage, "notSent", `${route}: past the 100-term cap`);
    assert.equal(fields.budget.unit, "terms");
  }

  const mistral = buildSttHintFields(
    { route: "mistral" },
    { words: many(60, "Two Words"), speechLanguage: "zh-CN" }
  );
  // The bias takes a word: 49 two-word terms fit in 100, the 50th is cut in half.
  assert.equal(sentTerms(mistral).length, 49);
  assert.equal(mistral.entries[49].coverage, "notSent");
  assert.deepEqual(mistral.budget, { unit: "words", used: 100, limit: 100, readChars: null });

  const keywords = buildSttHintFields(
    { route: "openai-compatible", model: "gpt-transcribe" },
    { words: many(905, "Term") }
  );
  assert.equal(sentTerms(keywords).length, 905, "past 900 the rest ride in the prompt");
  assert.deepEqual(keywords.budget, { unit: "keywords", used: 900, limit: 900, readChars: null });
});
