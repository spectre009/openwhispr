const test = require("node:test");
const assert = require("node:assert/strict");

// The style record: one versioned record is the authority for every style,
// changed only through one read-modify-write. Plain is built in and never an
// entry; the starters are written once, off, and stay deletable. Pure module
// tests over a Map-backed storage.

const load = () => import("../../src/config/styles/library.ts");
const loadStarters = () => import("../../src/config/styles/starters.ts");

const makeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
};

const NAMES = {
  "starter-teams": "Teams chat",
  "starter-requirements": "Requirements",
  "starter-email": "Email",
};

test("the starters are written once, off, with their emoji and run mode", async () => {
  const { ensureStyleLibrary, readStyleLibrary, PLAIN_STYLE_ID, STYLE_LIBRARY_KEY } = await load();
  const { TEAMS_CHAT_INSTRUCTION } = await loadStarters();
  const storage = makeStorage();

  const { library, changed } = ensureStyleLibrary(storage, NAMES, 1000);
  assert.equal(changed, true);
  assert.equal(library.dictationStyleId, PLAIN_STYLE_ID, "Plain is what the hotkey does");
  assert.deepEqual(
    library.styles.map((s) => [s.id, s.emoji, s.name, s.enabled, s.runMode, s.origin]),
    [
      ["starter-teams", "💬", "Teams chat", false, "two-step", "starter"],
      ["starter-requirements", "📋", "Requirements", false, "two-step", "starter"],
      ["starter-email", "✉️", "Email", false, "two-step", "starter"],
    ]
  );
  const teams = library.styles[0];
  assert.equal(teams.instruction, TEAMS_CHAT_INSTRUCTION);
  // The reserved fields are stored and carried.
  assert.deepEqual(
    { examples: teams.examples, useVoice: teams.useVoice, hotkey: teams.hotkey },
    { examples: [], useVoice: false, hotkey: null }
  );
  assert.ok(storage.getItem(STYLE_LIBRARY_KEY), "the record is written");

  // Idempotent: a second window seeding writes nothing new.
  assert.equal(ensureStyleLibrary(storage, NAMES, 2000).changed, false);
  assert.equal(readStyleLibrary(storage).styles.length, 3);
});

test("a deleted starter never comes back, and an edited one keeps its edits", async () => {
  const { ensureStyleLibrary, updateStyleLibrary, removeStyle, updateStyle, readStyleLibrary } =
    await load();
  const storage = makeStorage();
  ensureStyleLibrary(storage, NAMES);

  updateStyleLibrary(storage, (library) => removeStyle(library, "starter-email"));
  updateStyleLibrary(storage, (library) =>
    updateStyle(library, "starter-teams", { instruction: "Be brief.", runMode: "one-step" })
  );
  ensureStyleLibrary(storage, NAMES);

  const library = readStyleLibrary(storage);
  assert.deepEqual(
    library.styles.map((s) => s.id),
    ["starter-teams", "starter-requirements"]
  );
  assert.equal(library.styles[0].instruction, "Be brief.");
  assert.equal(library.styles[0].runMode, "one-step");
});

test("every change re-reads the record, so another window's change survives", async () => {
  const { ensureStyleLibrary, updateStyleLibrary, addStyle, updateStyle, readStyleLibrary } =
    await load();
  const storage = makeStorage();
  ensureStyleLibrary(storage, NAMES);

  // Window A holds a stale copy; window B adds a style; A then switches Teams on.
  const staleCopy = readStyleLibrary(storage);
  updateStyleLibrary(storage, (library) =>
    Boolean(addStyle(library, { name: "Standup", instruction: "Three bullets.", id: "standup" }))
  );
  updateStyleLibrary(storage, (library) =>
    updateStyle(library, "starter-teams", { enabled: true })
  );

  const library = readStyleLibrary(storage);
  assert.equal(staleCopy.styles.length, 3);
  assert.ok(
    library.styles.some((s) => s.id === "standup"),
    "B's style was not overwritten"
  );
  assert.equal(library.styles.find((s) => s.id === "starter-teams").enabled, true);
});

test("the dictation style is Plain or a style that is on; anything else falls back to Plain", async () => {
  const {
    ensureStyleLibrary,
    updateStyleLibrary,
    setDictationStyle,
    updateStyle,
    removeStyle,
    readStyleLibrary,
    PLAIN_STYLE_ID,
  } = await load();
  const storage = makeStorage();
  ensureStyleLibrary(storage, NAMES);

  // A starter is off until switched on, so it can't be picked yet.
  assert.equal(
    updateStyleLibrary(storage, (l) => setDictationStyle(l, "starter-teams")).changed,
    false
  );
  updateStyleLibrary(storage, (l) => updateStyle(l, "starter-teams", { enabled: true }));
  updateStyleLibrary(storage, (l) => setDictationStyle(l, "starter-teams"));
  assert.equal(readStyleLibrary(storage).dictationStyleId, "starter-teams");

  // Switching it off puts Plain back, in the same write.
  updateStyleLibrary(storage, (l) => updateStyle(l, "starter-teams", { enabled: false }));
  assert.equal(readStyleLibrary(storage).dictationStyleId, PLAIN_STYLE_ID);

  updateStyleLibrary(storage, (l) => updateStyle(l, "starter-teams", { enabled: true }));
  updateStyleLibrary(storage, (l) => setDictationStyle(l, "starter-teams"));
  updateStyleLibrary(storage, (l) => removeStyle(l, "starter-teams"));
  assert.equal(readStyleLibrary(storage).dictationStyleId, PLAIN_STYLE_ID);
});

test("a recording's style is frozen from the record, and retry finds deleted ones gone", async () => {
  const {
    ensureStyleLibrary,
    updateStyleLibrary,
    updateStyle,
    setDictationStyle,
    readStyleLibrary,
    resolveRecordingStyle,
    resolveRetryStyle,
  } = await load();
  const storage = makeStorage();
  ensureStyleLibrary(storage, NAMES);
  let library = readStyleLibrary(storage);
  assert.equal(resolveRecordingStyle(library), null, "Plain carries no style");

  updateStyleLibrary(storage, (l) => updateStyle(l, "starter-requirements", { enabled: true }));
  updateStyleLibrary(storage, (l) => setDictationStyle(l, "starter-requirements"));
  library = readStyleLibrary(storage);
  const style = resolveRecordingStyle(library);
  assert.equal(style.id, "starter-requirements");
  assert.equal(style.emoji, "📋");
  assert.equal(style.runMode, "two-step");
  assert.ok(Object.isFrozen(style), "the snapshot can't change mid-recording");

  // A key may ask for another style (Stage 4); an off style is never applied.
  assert.equal(resolveRecordingStyle(library, "starter-teams"), null);
  assert.equal(resolveRecordingStyle(library, "plain"), null);
  // Retry re-runs an off style (it exists), but not a deleted one.
  assert.equal(resolveRetryStyle(library, "starter-teams").id, "starter-teams");
  assert.equal(resolveRetryStyle(library, "gone"), null);
});

test("a new style needs a name and an instruction; edits that would empty it are refused", async () => {
  const { createEmptyStyleLibrary, addStyle, updateStyle } = await load();
  const library = createEmptyStyleLibrary();
  assert.equal(addStyle(library, { name: " ", instruction: "x" }), null);
  assert.equal(addStyle(library, { name: "x", instruction: "  " }), null);
  const style = addStyle(library, {
    name: "  Standup   notes ",
    emoji: " 🧍 ",
    instruction: " Three bullets. ",
    id: "standup",
  });
  assert.deepEqual(
    [style.name, style.emoji, style.instruction, style.enabled, style.origin],
    ["Standup notes", "🧍", "Three bullets.", true, "user"]
  );
  assert.equal(updateStyle(library, "standup", { instruction: "" }), false);
  assert.equal(updateStyle(library, "standup", { name: "" }), false);
  assert.equal(updateStyle(library, "standup", { name: "Standup notes" }), false, "no change");
  assert.equal(updateStyle(library, "standup", { appGlossary: false }), true);
  assert.equal(library.styles[0].appGlossary, false);
});

test("parsing keeps unknown fields, drops bad ids and repairs a stale dictation style", async () => {
  const { parseStyleLibrary, PLAIN_STYLE_ID } = await load();
  const raw = JSON.stringify({
    version: 1,
    futureField: { kept: true },
    dictationStyleId: "off-style",
    seededStarters: ["starter-teams", 7],
    styles: [
      { id: "off-style", name: "Off", instruction: "x", enabled: false, futureStyleField: 1 },
      { id: "plain", name: "Not allowed", instruction: "x", enabled: true },
      { id: "bad id!", name: "Bad", instruction: "x", enabled: true },
      { id: "off-style", name: "Duplicate", instruction: "y", enabled: true },
    ],
  });
  const library = parseStyleLibrary(raw);
  assert.deepEqual(library.futureField, { kept: true });
  assert.deepEqual(library.seededStarters, ["starter-teams"]);
  assert.deepEqual(
    library.styles.map((s) => s.id),
    ["off-style"]
  );
  assert.equal(library.styles[0].futureStyleField, 1);
  assert.equal(library.dictationStyleId, PLAIN_STYLE_ID, "an off style can't be the hotkey's");
  assert.equal(parseStyleLibrary("{not json"), null);
  assert.equal(parseStyleLibrary(null), null);
});

test("history's route kind round-trips a style id", async () => {
  const { styleRouteKind, styleIdFromRouteKind } = await load();
  assert.equal(styleRouteKind("starter-teams"), "style:starter-teams");
  assert.equal(styleRouteKind("plain"), null);
  assert.equal(styleRouteKind(null), null);
  assert.equal(styleIdFromRouteKind("style:starter-teams"), "starter-teams");
  assert.equal(styleIdFromRouteKind("translation"), null);
  assert.equal(styleIdFromRouteKind("style:bad id"), null);
  assert.equal(styleIdFromRouteKind(null), null);
});
