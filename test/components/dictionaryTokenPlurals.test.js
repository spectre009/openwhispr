const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The Dictionary's token estimates ("≈ 1 token", "≈ 1.3K tokens") in every UI
// language: one plural key selected by the raw estimate and shown through
// i18next's number formatter (dictionary.tokens.approx_*, its compact twin
// approxCompact_*), rendered by approxTokens and carried by every estimate
// sentence as {{tokensText}}. Real locale files, the app's i18next options.

const LOCALES = path.join(__dirname, "../../src/locales");
const LANGS = fs
  .readdirSync(LOCALES)
  .filter((entry) => fs.statSync(path.join(LOCALES, entry)).isDirectory())
  .sort();
const resource = (lang) =>
  JSON.parse(fs.readFileSync(path.join(LOCALES, lang, "translation.json"), "utf8"));
const get = (root, dotted) => dotted.split(".").reduce((node, part) => node?.[part], root);

let i18n;
let approxTokens;
test.before(async () => {
  ({ approxTokens } = await import("../../src/components/dictionary/dictionaryLabels.ts"));
  const i18next = require("i18next");
  i18n = i18next.createInstance();
  await i18n.init({
    resources: Object.fromEntries(LANGS.map((lang) => [lang, { translation: resource(lang) }])),
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnEmptyString: true,
    returnNull: false,
  });
});

const tIn = (lang) => i18n.getFixedT(lang);
const number = (lang, n) => new Intl.NumberFormat(lang).format(n);
const compact = (lang, n) =>
  new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 }).format(n);

test("English: 1 token, 2 tokens, a compact 1.3K tokens", () => {
  const t = tIn("en");
  assert.equal(approxTokens(t, 1), "≈ 1 token");
  assert.equal(approxTokens(t, 2), "≈ 2 tokens");
  assert.equal(approxTokens(t, 0), "≈ 0 tokens");
  assert.equal(approxTokens(t, 1234), "≈ 1,234 tokens");
  assert.equal(approxTokens(t, 1300, { compact: true }), "≈ 1.3K tokens");
  assert.equal(approxTokens(t, 1, { compact: true }), "≈ 1 token");
  // The raw estimate picks the form; a fraction or a bad value never shows.
  assert.equal(approxTokens(t, 0.6), "≈ 1 token");
  assert.equal(approxTokens(t, Number.NaN), "≈ 0 tokens");
});

test("the estimate sentences carry it, their wording otherwise unchanged", () => {
  const t = tIn("en");
  const text = (n, options) => approxTokens(t, n, options);
  assert.equal(
    t("dictionary.where.cleanup.tokens", { tokensText: text(1) }),
    "≈ 1 token every cleanup"
  );
  assert.equal(
    t("dictionary.where.cleanup.monthly", { tokensText: text(48200, { compact: true }) }),
    "≈ 48.2K tokens a month"
  );
  assert.equal(
    t("dictionary.where.cleanup.monthlyDetail", { tokensText: text(1, { compact: true }) }),
    "≈ 1 token a month at your dictation pace"
  );
  assert.equal(
    t("dictionary.where.chat.tokens", { tokensText: text(2) }),
    "≈ 2 tokens every message"
  );
  assert.equal(
    t("dictionary.where.chat.tokensDetail", { tokensText: text(1) }),
    "≈ 1 token every message"
  );
  // The list summary's word count and the token count pluralize separately.
  assert.equal(
    t("settingsPage.cleanupDictionary.count", { count: 1, tokensText: text(1) }),
    "1 word · ≈ 1 token"
  );
  assert.equal(
    t("settingsPage.cleanupDictionary.count", { count: 7, tokensText: text(15) }),
    "7 words · ≈ 15 tokens"
  );
  assert.equal(
    t("dictionary.tidy.review.estimate", { count: 1, tokensText: text(1) }),
    "Sends your 1 word with its source and counts, never your dictations. One request, ≈ 1 token."
  );
  assert.equal(
    t("dictionary.categories.review.estimate", { count: 3, tokensText: text(1234) }),
    "Sends your 3 words and their current category, never your dictations. One request, ≈ 1,234 tokens."
  );
  assert.equal(
    t("dictionary.categories.notes.wordSet", { count: 1, tokensText: text(1) }),
    "“All words except everyday words” leaves out 1 word (≈ 1 token a cleanup)."
  );
});

test("Arabic: zero, one, two, few, many and other", () => {
  const t = tIn("ar");
  const cases = [
    [0, "رمز"],
    [1, "رمز"],
    [2, "رمزان"],
    [3, "رموز"],
    [10, "رموز"],
    [11, "رمزًا"],
    [99, "رمزًا"],
    [100, "رمز"],
    [1300, "رمز"],
  ];
  for (const [n, word] of cases) {
    assert.equal(approxTokens(t, n), `≈ ${number("ar", n)} ${word}`, String(n));
  }
  assert.equal(
    approxTokens(t, 1300, { compact: true }),
    `≈ ${compact("ar", 1300)} رمز`,
    "compact in Arabic"
  );
});

test("Russian: 1, 2, 5 and 21", () => {
  const t = tIn("ru");
  assert.equal(approxTokens(t, 1), "≈ 1 токен");
  assert.equal(approxTokens(t, 2), "≈ 2 токена");
  assert.equal(approxTokens(t, 5), "≈ 5 токенов");
  assert.equal(approxTokens(t, 11), "≈ 11 токенов");
  assert.equal(approxTokens(t, 21), "≈ 21 токен");
  assert.equal(
    t("dictionary.where.cleanup.tokens", { tokensText: approxTokens(t, 21) }),
    "≈ 21 токен на каждую очистку"
  );
});

test("a million-scale compact estimate", () => {
  assert.equal(approxTokens(tIn("en"), 1_234_567, { compact: true }), "≈ 1.2M tokens");
  assert.equal(approxTokens(tIn("en"), 2_000_000, { compact: true }), "≈ 2M tokens");
  // French, Spanish, Italian and Portuguese select "many" for whole millions:
  // their own form, never English.
  assert.equal(
    approxTokens(tIn("fr"), 2_000_000, { compact: true }),
    `≈ ${compact("fr", 2_000_000)} de tokens`
  );
  assert.equal(
    approxTokens(tIn("es"), 1_000_000, { compact: true }),
    `≈ ${compact("es", 1_000_000)} de tokens`
  );
  assert.equal(
    approxTokens(tIn("it"), 3_000_000, { compact: true }),
    `≈ ${compact("it", 3_000_000)} di token`
  );
  assert.equal(
    approxTokens(tIn("pt"), 1_000_000, { compact: true }),
    `≈ ${compact("pt", 1_000_000)} de tokens`
  );
  assert.equal(
    approxTokens(tIn("de"), 1_500_000, { compact: true }),
    `≈ ${compact("de", 1_500_000)} Tokens`
  );
  // The raw estimate picks the form: 1,234,567 is Russian "many" ("1,2 млн токенов").
  assert.equal(
    approxTokens(tIn("ru"), 1_234_567, { compact: true }),
    `≈ ${compact("ru", 1_234_567)} токенов`
  );
});

test("every language has the form each count selects: no English fallback, the number formatted", () => {
  const counts = [0, 1, 2, 3, 5, 11, 21, 100, 1300, 1_000_000, 1_234_567, 2_000_000];
  for (const lang of LANGS) {
    const json = resource(lang);
    const t = tIn(lang);
    const rules = new Intl.PluralRules(lang);
    for (const n of counts) {
      for (const [key, options, shown] of [
        ["approx", {}, number(lang, n)],
        ["approxCompact", { compact: true }, compact(lang, n)],
      ]) {
        const form = `${key}_${rules.select(n)}`;
        assert.equal(
          typeof get(json, `dictionary.tokens.${form}`),
          "string",
          `${lang}: dictionary.tokens.${form} (for ${n})`
        );
        const text = approxTokens(t, n, options);
        assert.ok(text.includes(shown), `${lang} ${key} ${n}: “${text}” shows ${shown}`);
        assert.ok(!text.includes("{{"), `${lang} ${key} ${n}: ${text}`);
      }
    }
  }
});

test("every language's estimate sentences take the phrase, nothing left of the old one", () => {
  const sentences = [
    ["settingsPage.cleanupDictionary.count", { count: 2 }],
    ["dictionary.where.cleanup.tokens", {}],
    ["dictionary.where.cleanup.monthly", {}],
    ["dictionary.where.cleanup.monthlyDetail", {}],
    ["dictionary.where.chat.tokens", {}],
    ["dictionary.where.chat.tokensDetail", {}],
    ["dictionary.tidy.review.estimate", { count: 2 }],
    ["dictionary.categories.review.estimate", { count: 2 }],
    ["dictionary.categories.notes.wordSet", { count: 2 }],
  ];
  for (const lang of LANGS) {
    const t = tIn(lang);
    const tokensText = approxTokens(t, 2);
    for (const [key, options] of sentences) {
      const text = t(key, { ...options, tokensText });
      assert.ok(text.includes(tokensText), `${lang} ${key}: ${text}`);
      assert.ok(!text.includes("{{"), `${lang} ${key}: ${text}`);
      assert.ok(!text.includes("≈ ≈") && !text.includes("約約"), `${lang} ${key}: ${text}`);
    }
  }
});
