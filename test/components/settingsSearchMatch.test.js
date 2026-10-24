const test = require("node:test");
const assert = require("node:assert/strict");
const { makeContext, translators } = require("../lib/settingsSearchFixtures");

// Settings search matching: every token must match somewhere, titles rank above
// aliases, values, descriptions and the breadcrumb, accents and case don't
// matter, English terms work in any UI language, and values ("haiku", "groq",
// "F8") find the settings that hold them.

async function load() {
  const match = await import("../../src/components/settings/search/match.ts");
  const registry = await import("../../src/components/settings/search/registry.ts");
  const index = await import("../../src/components/settings/search/searchIndex.ts");
  const types = await import("../../src/components/settings/search/types.ts");
  return {
    ...(match.default ?? match),
    ...(registry.default ?? registry),
    ...(index.default ?? index),
    ...(types.default ?? types),
  };
}

async function buildIndex(lang = "en", ctx = makeContext()) {
  const lib = await load();
  const { t, tEn } = await translators(lang);
  const index = lib.buildSettingsSearchIndex({
    descriptors: lib.SETTINGS_SEARCH_DESCRIPTORS,
    ctx,
    t,
    tEn,
  });
  return { ...lib, index };
}

const ids = (results) => results.map((result) => result.entry.id);

function entry(overrides) {
  return {
    id: "x",
    kind: "setting",
    groupId: "general",
    groupLabel: "Preferences",
    groupOrder: 3,
    order: 0,
    title: "",
    titleEn: "",
    description: "",
    path: [],
    aliases: [],
    ...overrides,
  };
}

test("normalization folds case and accents", async () => {
  const { normalizeSearchText, tokenizeQuery } = await load();
  assert.equal(normalizeSearchText("Résumé ÜBER Ñandú"), "resume uber nandu");
  assert.deepEqual(tokenizeQuery("  Push   TO talk "), ["push", "to", "talk"]);
  assert.deepEqual(tokenizeQuery("   "), []);
});

test("a title word outranks a title substring, an alias, a value, a description and the path", async () => {
  const { rankSettings } = await load();
  const index = [
    entry({ id: "path", order: 0, title: "Other", path: ["Microphone"] }),
    entry({ id: "description", order: 1, title: "Other", description: "Pick a microphone" }),
    entry({ id: "value", order: 2, title: "Other", value: "USB microphone" }),
    entry({ id: "alias", order: 3, title: "Other", aliases: ["microphone"] }),
    entry({ id: "substring", order: 4, title: "Mymicrophone" }),
    entry({ id: "word", order: 5, title: "Default microphone" }),
  ];
  assert.deepEqual(ids(rankSettings(index, "microphone")), [
    "word",
    "substring",
    "alias",
    "value",
    "description",
    "path",
  ]);
});

test("every token must match somewhere; the order of tokens doesn't matter", async () => {
  const { index, rankSettings } = await buildIndex();
  assert.equal(ids(rankSettings(index, "cleanup model"))[0], "dictation.cleanup.model");
  assert.equal(ids(rankSettings(index, "model cleanup"))[0], "dictation.cleanup.model");
  assert.deepEqual(rankSettings(index, "cleanup zzzqx"), []);
});

test("technical aliases find their setting", async () => {
  const { index, rankSettings } = await buildIndex();
  const top = (query) => ids(rankSettings(index, query))[0];
  assert.equal(top("push to talk"), "hotkeys.activationMode");
  assert.equal(top("ptt"), "hotkeys.activationMode");
  assert.equal(top("dark mode"), "preferences.theme");
  assert.equal(top("autostart"), "preferences.startup.launchAtLogin");
  assert.ok(ids(rankSettings(index, "api key")).includes("dictation.cleanup.model"));
  assert.ok(ids(rankSettings(index, "parakeet")).includes("dictation.stt.engine"));
});

test("current values find the settings that hold them", async () => {
  const { index, rankSettings } = await buildIndex();
  assert.equal(ids(rankSettings(index, "haiku"))[0], "dictation.cleanup.model");
  assert.ok(ids(rankSettings(index, "groq")).includes("dictation.stt.engine"));
  // "Style for F8" names the hotkey in its title, so both lead.
  assert.ok(ids(rankSettings(index, "F8")).slice(0, 2).includes("hotkeys.dictation"));
  // Model ids match too, not only the display names.
  assert.equal(ids(rankSettings(index, "claude-haiku-4-5"))[0], "dictation.cleanup.model");
  const cleanup = index.find((e) => e.id === "dictation.cleanup.model");
  assert.equal(cleanup.value, "Anthropic · Claude Haiku 4.5");
});

test("English titles work in another UI language, and accents don't matter", async () => {
  const { index, rankSettings } = await buildIndex("de");
  const theme = index.find((e) => e.id === "preferences.theme");
  assert.notEqual(theme.title, theme.titleEn, "the German title differs from the English one");
  assert.equal(ids(rankSettings(index, "theme"))[0], "preferences.theme");
  assert.equal(ids(rankSettings(index, "push to talk"))[0], "hotkeys.activationMode");
  // "Übersetzung" (translation) typed without the umlaut.
  assert.ok(ids(rankSettings(index, "ubersetzung")).includes("page.llms.dictationTranslation"));
  // The German title is matched too.
  assert.ok(ids(rankSettings(index, theme.title)).includes("preferences.theme"));
});

test("localized aliases match in the UI language", async () => {
  const { index, rankSettings } = await buildIndex("es");
  assert.equal(ids(rankSettings(index, "modo oscuro"))[0], "preferences.theme");
});

test("results are grouped by nav item in nav order, the best match is highlighted", async () => {
  const { index, searchSettings } = await buildIndex();
  const outcome = searchSettings(index, "model");
  const order = outcome.groups.map((group) => group.id);
  const groupOrder = (id) => index.find((entry) => entry.groupId === id).groupOrder;
  assert.deepEqual(
    order,
    [...order].sort((a, b) => groupOrder(a) - groupOrder(b))
  );
  assert.ok(order.length > 1);
  // Groups are the nav's top-level items: Dictation's pages share one.
  assert.ok(order.includes("dictation"));
  assert.ok(!order.includes("cleanup") && !order.includes("recognition"));
  assert.equal(outcome.groups.find((group) => group.id === "dictation").label, "Dictation");
  assert.deepEqual(
    outcome.results,
    outcome.groups.flatMap((group) => group.results),
    "results run in display order"
  );
  const best = outcome.results[outcome.bestIndex];
  assert.equal(best.score, Math.max(...outcome.results.map((result) => result.score)));
  for (const group of outcome.groups) {
    const scores = group.results.map((result) => result.score);
    assert.deepEqual(
      scores,
      [...scores].sort((a, b) => b - a),
      `${group.id} best first`
    );
  }
  assert.deepEqual(searchSettings(index, "  "), { groups: [], results: [], bestIndex: -1 });
});

test("breadcrumbs follow the nav tree: parent, page and block", async () => {
  const { index } = await buildIndex();
  const byId = (id) => index.find((e) => e.id === id);
  assert.deepEqual(byId("dictation.cleanup.model").path, ["Dictation", "Cleanup"]);
  assert.equal(byId("dictation.cleanup.model").groupId, "dictation");
  assert.equal(byId("dictation.cleanup.model").pageId, "cleanup");
  assert.deepEqual(byId("preferences.theme").path, [
    "App & Controls",
    "Appearance & Language",
    "Appearance",
  ]);
  // A block named like its page isn't repeated.
  assert.deepEqual(byId("preferences.notifications.disableAll").path, [
    "App & Controls",
    "Notifications",
  ]);
  assert.deepEqual(byId("assistant.model").path, ["Voice Assistant"]);
  assert.deepEqual(byId("workspace.members").path, ["Workspace", "Members"]);
  // A page shows its parent; a top-level page and a parent show nothing.
  assert.deepEqual(byId("page.speechToText.dictation").path, ["Dictation"]);
  assert.deepEqual(byId("page.llms.dictationAgent").path, []);
  assert.deepEqual(byId("page.general").path, []);
  assert.deepEqual(byId("elsewhere.integrations.calendars").path, ["Integrations"]);
  assert.equal(byId("elsewhere.dictionary").groupId, "elsewhere");
});

test("highlight ranges map accent-free matches back to the source text", async () => {
  const { highlightRanges } = await load();
  assert.deepEqual(highlightRanges("Résumé settings", "resume"), [[0, 6]]);
  assert.deepEqual(highlightRanges("Push to talk", "push talk"), [
    [0, 4],
    [8, 12],
  ]);
  // Overlapping tokens merge; single ASCII letters don't mark anything.
  assert.deepEqual(highlightRanges("Microphone", "micro phone"), [[0, 10]]);
  assert.deepEqual(highlightRanges("Microphone", "m"), []);
  assert.deepEqual(highlightRanges("音声認識", "音声"), [[0, 2]]);
});
