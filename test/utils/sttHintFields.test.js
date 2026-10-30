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
