const test = require("node:test");
const assert = require("node:assert/strict");

// The prompt library record: one versioned record per prompt kind is the
// authority, and customPrompt.<kind> is a cache written from it in the same
// step. Pure module tests over a Map-backed storage.

const load = () => import("../../src/config/prompts/library.ts");

const makeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    map,
    writes,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      writes.push(key);
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
  };
};

const record = (storage, kind = "cleanup") => JSON.parse(storage.getItem(`promptLibrary.${kind}`));

// After every operation the cache must equal what the record says is in use.
const assertCacheMatches = async (storage, kind = "cleanup") => {
  const { activePromptText, parsePromptLibrary } = await load();
  const library = parsePromptLibrary(storage.getItem(`promptLibrary.${kind}`));
  assert.ok(library, "a record exists");
  assert.equal(storage.getItem(`customPrompt.${kind}`), activePromptText(library));
};

test("migration: a non-empty override becomes the active 'My prompt' entry", async () => {
  const { migratePromptLibrary, MIGRATED_PROMPT_ID } = await load();
  const storage = makeStorage({ "customPrompt.cleanup": "Keep my words." });

  const { library, migrated } = migratePromptLibrary(storage, "cleanup", "My prompt");

  assert.equal(migrated, true);
  assert.equal(library.activeId, MIGRATED_PROMPT_ID);
  assert.equal(library.entries.length, 1);
  assert.deepEqual(
    { ...library.entries[0], updatedAt: 0 },
    { id: "migrated", name: "My prompt", text: "Keep my words.", updatedAt: 0, origin: "migrated" }
  );
  assert.equal(storage.getItem("customPrompt.cleanup"), "Keep my words.");
  assert.deepEqual(record(storage), library);
});

test("migration: an empty or missing override means Default and no entries", async () => {
  const { migratePromptLibrary } = await load();
  const storage = makeStorage({ "customPrompt.translate": "" });

  for (const kind of ["translate", "chatAgent"]) {
    const { library } = migratePromptLibrary(storage, kind, "My prompt");
    assert.equal(library.activeId, "default");
    assert.deepEqual(library.entries, []);
    // The cache is written, never removed: other windows ignore removals.
    assert.equal(storage.getItem(`customPrompt.${kind}`), "");
  }
});

test("migration is idempotent and leaves an existing record alone", async () => {
  const { migratePromptLibrary } = await load();
  const storage = makeStorage({ "customPrompt.cleanup": "Mine." });
  migratePromptLibrary(storage, "cleanup", "My prompt");
  const first = storage.getItem("promptLibrary.cleanup");
  const writes = storage.writes.length;

  const again = migratePromptLibrary(storage, "cleanup", "Another name");

  assert.equal(again.migrated, false);
  assert.equal(storage.getItem("promptLibrary.cleanup"), first);
  assert.equal(storage.writes.length, writes, "nothing is written the second time");
});

test("the cache follows the record through every change", async () => {
  const lib = await load();
  const storage = makeStorage({ "customPrompt.cleanup": "Original." });
  lib.migratePromptLibrary(storage, "cleanup", "My prompt");
  const update = (change) => lib.updatePromptLibrary(storage, "cleanup", "My prompt", change);

  let created;
  update((library) => {
    created = lib.addPromptEntry(library, { name: "  Teams   tone ", text: "Be brief." });
    return true;
  });
  assert.equal(record(storage).entries[1].name, "Teams tone");
  assert.equal(record(storage).entries[1].origin, "user");
  assert.equal(storage.getItem("customPrompt.cleanup"), "Original.", "a new prompt isn't in use");
  await assertCacheMatches(storage);

  update((library) => lib.setActivePrompt(library, created.id));
  assert.equal(storage.getItem("customPrompt.cleanup"), "Be brief.");
  await assertCacheMatches(storage);

  update((library) => lib.savePromptEntryText(library, created.id, "Be briefer."));
  assert.equal(storage.getItem("customPrompt.cleanup"), "Be briefer.", "saving the active one");
  await assertCacheMatches(storage);

  update((library) => lib.renamePromptEntry(library, created.id, "Short"));
  assert.equal(record(storage).entries[1].name, "Short");
  await assertCacheMatches(storage);

  update((library) => lib.setActivePrompt(library, lib.DEFAULT_PROMPT_ID));
  assert.equal(storage.getItem("customPrompt.cleanup"), "", "Default is the empty override");
  assert.equal(record(storage).entries.length, 2, "using Default deletes nothing");
  await assertCacheMatches(storage);

  update((library) => lib.setActivePrompt(library, "migrated"));
  update((library) => lib.removePromptEntry(library, "migrated"));
  assert.equal(record(storage).activeId, "default", "deleting the prompt in use goes to Default");
  assert.equal(storage.getItem("customPrompt.cleanup"), "");
  await assertCacheMatches(storage);
});

test("an entry without text can't be put in use or saved empty", async () => {
  const lib = await load();
  const library = lib.createEmptyPromptLibrary();
  const blank = lib.addPromptEntry(library, { name: "New prompt", text: "" });

  assert.equal(lib.setActivePrompt(library, blank.id), false);
  assert.equal(library.activeId, "default");
  assert.equal(lib.savePromptEntryText(library, blank.id, "   "), false);
  assert.equal(lib.savePromptEntryText(library, blank.id, "Real text."), true);
  assert.equal(lib.setActivePrompt(library, blank.id), true);
  assert.equal(lib.savePromptEntryText(library, blank.id, ""), false);
  assert.equal(lib.activePromptText(library), "Real text.");
});

test("a change refused by its mutator writes nothing", async () => {
  const lib = await load();
  const storage = makeStorage({ "customPrompt.cleanup": "" });
  lib.migratePromptLibrary(storage, "cleanup", "My prompt");
  const writes = storage.writes.length;

  const { changed } = lib.updatePromptLibrary(storage, "cleanup", "My prompt", (library) =>
    lib.renamePromptEntry(library, "missing", "x")
  );

  assert.equal(changed, false);
  assert.equal(storage.writes.length, writes);
});

test("interleaved writes from two windows lose no entry", async () => {
  const lib = await load();
  const storage = makeStorage({ "customPrompt.cleanup": "Mine." });
  lib.migratePromptLibrary(storage, "cleanup", "My prompt");

  // Window A read the library a while ago; window B has saved since.
  const staleInWindowA = lib.readPromptLibrary(storage, "cleanup");
  lib.updatePromptLibrary(storage, "cleanup", "My prompt", (library) => {
    lib.addPromptEntry(library, { name: "From B", text: "B text." });
    return true;
  });
  assert.equal(staleInWindowA.entries.length, 1, "A's copy is out of date");

  // A's save re-reads the record inside the write, so B's entry survives.
  const { library } = lib.updatePromptLibrary(storage, "cleanup", "My prompt", (draft) => {
    lib.addPromptEntry(draft, { name: "From A", text: "A text." });
    return true;
  });
  assert.deepEqual(
    library.entries.map((entry) => entry.name),
    ["My prompt", "From B", "From A"]
  );
  assert.deepEqual(record(storage), library);
  await assertCacheMatches(storage);
});

test("a write after a missing record migrates the override first", async () => {
  const lib = await load();
  const storage = makeStorage({ "customPrompt.cleanup": "Unmigrated." });

  const { library } = lib.updatePromptLibrary(storage, "cleanup", "My prompt", (draft) => {
    lib.addPromptEntry(draft, { name: "Other", text: "Other." });
    return true;
  });

  assert.deepEqual(
    library.entries.map((entry) => [entry.id === "migrated", entry.text]),
    [
      [true, "Unmigrated."],
      [false, "Other."],
    ]
  );
  assert.equal(storage.getItem("customPrompt.cleanup"), "Unmigrated.");
});

test("an unreadable or partial record is repaired, not trusted", async () => {
  const { parsePromptLibrary } = await load();
  assert.equal(parsePromptLibrary("not json"), null);
  assert.equal(parsePromptLibrary(JSON.stringify({ activeId: "x" })), null);

  const parsed = parsePromptLibrary(
    JSON.stringify({
      version: 1,
      activeId: "gone",
      entries: [
        { id: "a", name: "A", text: "Alpha", updatedAt: 5, origin: "user", future: 1 },
        { id: "a", name: "Dup", text: "Dup" },
        { id: "default", name: "Shadow", text: "x" },
        { id: "b", text: 42 },
        { id: "c", text: "Gamma", origin: "weird" },
      ],
    })
  );
  assert.equal(parsed.activeId, "default", "an active id with no entry falls back to Default");
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.id, entry.origin]),
    [
      ["a", "user"],
      ["c", "user"],
    ]
  );
  assert.equal(parsed.entries[0].future, 1, "unknown fields from a newer app are kept");
});

const RETIRED = "A retired shipped default.";
const isRetired = async (text) => text === RETIRED;

test("retired defaults: a migrated entry that matches is removed and Default takes over", async () => {
  const lib = await load();
  const storage = makeStorage({ "customPrompt.cleanup": RETIRED });
  lib.migratePromptLibrary(storage, "cleanup", "My prompt");

  const swept = await lib.sweepRetiredPromptEntries(storage, ["cleanup"], isRetired, "My prompt");

  assert.deepEqual(
    swept.map(({ kind }) => kind),
    ["cleanup"]
  );
  assert.deepEqual(record(storage).entries, []);
  assert.equal(record(storage).activeId, "default");
  assert.equal(storage.getItem("customPrompt.cleanup"), "", "the cache is written, not removed");
  assert.equal(storage.getItem("customPrompt.cleanup.retired"), RETIRED, "archived as before");
  await assertCacheMatches(storage);

  const again = await lib.sweepRetiredPromptEntries(storage, ["cleanup"], isRetired, "My prompt");
  assert.deepEqual(again, [], "idempotent");
});

test("retired defaults: a prompt the user saved is never deleted", async () => {
  const lib = await load();
  const storage = makeStorage({ "customPrompt.cleanup": "" });
  lib.migratePromptLibrary(storage, "cleanup", "My prompt");
  lib.updatePromptLibrary(storage, "cleanup", "My prompt", (library) => {
    const entry = lib.addPromptEntry(library, { name: "Old default, kept", text: RETIRED });
    return lib.setActivePrompt(library, entry.id);
  });

  const swept = await lib.sweepRetiredPromptEntries(storage, ["cleanup"], isRetired, "My prompt");

  assert.deepEqual(swept, []);
  assert.equal(record(storage).entries.length, 1);
  assert.equal(storage.getItem("customPrompt.cleanup"), RETIRED);
});

test("retired defaults: an inactive migrated match is removed without switching", async () => {
  const lib = await load();
  const storage = makeStorage({ "customPrompt.cleanup": RETIRED });
  lib.migratePromptLibrary(storage, "cleanup", "My prompt");
  lib.updatePromptLibrary(storage, "cleanup", "My prompt", (library) => {
    const entry = lib.addPromptEntry(library, { name: "Current", text: "My own." });
    return lib.setActivePrompt(library, entry.id);
  });

  await lib.sweepRetiredPromptEntries(storage, ["cleanup"], isRetired, "My prompt");

  assert.deepEqual(
    record(storage).entries.map((entry) => entry.name),
    ["Current"]
  );
  assert.equal(storage.getItem("customPrompt.cleanup"), "My own.");
});

test("retired defaults: an entry edited while hashing is kept", async () => {
  const lib = await load();
  const storage = makeStorage({ "customPrompt.cleanup": RETIRED });
  lib.migratePromptLibrary(storage, "cleanup", "My prompt");

  const swept = await lib.sweepRetiredPromptEntries(
    storage,
    ["cleanup"],
    async (text) => {
      // Another window saves an edit of the entry while the hash is computed.
      lib.updatePromptLibrary(storage, "cleanup", "My prompt", (library) =>
        lib.savePromptEntryText(library, "migrated", `${RETIRED} Edited.`)
      );
      return text === RETIRED;
    },
    "My prompt"
  );

  assert.deepEqual(swept, []);
  assert.equal(record(storage).entries[0].text, `${RETIRED} Edited.`);
  assert.equal(storage.getItem("customPrompt.cleanup"), `${RETIRED} Edited.`);
});

test("retired defaults: a storage failure on one kind doesn't stop the others", async () => {
  const lib = await load();
  const storage = makeStorage({ "customPrompt.dictationAgent": RETIRED });
  lib.migratePromptLibrary(storage, "dictationAgent", "My prompt");
  const failing = {
    getItem(key) {
      if (key === "promptLibrary.cleanup") throw new Error("storage unavailable");
      return storage.getItem(key);
    },
    setItem: (key, value) => storage.setItem(key, value),
  };

  const swept = await lib.sweepRetiredPromptEntries(
    failing,
    ["cleanup", "dictationAgent"],
    isRetired,
    "My prompt"
  );

  assert.deepEqual(
    swept.map(({ kind }) => kind),
    ["dictationAgent"]
  );
  assert.equal(storage.getItem("customPrompt.dictationAgent"), "");
});
