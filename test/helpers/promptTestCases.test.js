const test = require("node:test");
const assert = require("node:assert/strict");

const { createPromptTestCases, MAX_RAW_TEXT } = require("../../src/helpers/promptTestCases.js");

// The test set's cases in main: owned by an account or the signed-out
// namespace, durable only while local history is on (and its managed policy
// settled), kept for the session otherwise, never durable under an
// organization's always_off, and never pinned from a row without a raw
// transcript. A fake in-memory database stands in for DatabaseManager here;
// promptTestCasesDatabase.test.js runs the same contract on SQLite.

function fakeDb() {
  const rows = [];
  const transcriptions = new Map();
  const steps = new Map();
  return {
    rows,
    transcriptions,
    steps,
    promptTestCasesReady: true,
    getPromptTestCases: (owner) => rows.filter((row) => row.owner === owner),
    getPromptTestCase: (owner, id) =>
      rows.find((row) => row.owner === owner && row.id === id) ?? null,
    findPromptTestCaseByText: (owner, target, rawText) =>
      rows.find(
        (row) => row.owner === owner && row.target === target && row.raw_text === rawText
      ) ?? null,
    countPromptTestCases: (owner) => rows.filter((row) => row.owner === owner).length,
    insertPromptTestCase(row) {
      rows.push({ ...row });
      return { ...row };
    },
    updatePromptTestCase(owner, id, fields) {
      const row = rows.find((r) => r.owner === owner && r.id === id);
      if (!row) return null;
      Object.assign(row, fields);
      return { ...row };
    },
    deletePromptTestCase(owner, id) {
      const index = rows.findIndex((r) => r.owner === owner && r.id === id);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
    clearPromptTestCases(owner) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].owner === owner) rows.splice(i, 1);
      return before - rows.length;
    },
    takePromptTestCases(owner) {
      const taken = rows.filter((row) => row.owner === owner);
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].owner === owner) rows.splice(i, 1);
      return taken;
    },
    getTranscriptionById: (id) => transcriptions.get(id) ?? null,
    getTranscriptionSteps: (id, owner) => steps.get(`${id}:${owner}`) ?? { status: "none" },
  };
}

const ON = { synced: true, enabled: true, forcedOff: false, resolved: true };

function setup({ owner = "account:a", policy = ON } = {}) {
  const db = fakeDb();
  const state = { owner, policy: { ...policy } };
  const changes = [];
  let clock = 0;
  let ids = 0;
  const cases = createPromptTestCases({
    db,
    getOwner: () => state.owner,
    getPolicy: () => state.policy,
    onChange: (change) => changes.push(change),
    now: () => new Date(Date.UTC(2026, 9, 22, 12, 0, clock++)),
    randomId: () => `case-${++ids}`,
  });
  db.transcriptions.set(1, {
    id: 1,
    status: "completed",
    raw_text: "um send the report by thursday no wait friday",
    text: "Send the report by Friday.",
    deleted_at: null,
  });
  return { db, state, cases, changes };
}

test("a pin from History copies the raw transcript and the pasted text, for this owner", () => {
  const { db, cases } = setup();
  db.steps.set("1:account:a", { status: "captured", context: { targetApp: "Code.exe" } });

  const result = cases.pinFromHistory(1);
  assert.equal(result.success, true);
  assert.equal(result.durable, true);
  assert.equal(result.case.rawText, "um send the report by thursday no wait friday");
  assert.equal(result.case.referenceText, "Send the report by Friday.");
  assert.equal(result.case.targetApp, "Code.exe", "the app the dictation was made in");
  assert.equal(result.case.source, "history");
  assert.equal(result.case.sourceTranscriptionId, 1);
  assert.equal(result.case.target, "cleanup");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].owner, "account:a");

  // The copy outlives the history row.
  db.transcriptions.delete(1);
  assert.equal(cases.list().cases[0].rawText, "um send the report by thursday no wait friday");
});

test("a row without a raw transcript, or that isn't a completed dictation, can't be pinned", () => {
  const { db, cases } = setup();
  db.transcriptions.set(2, { id: 2, status: "completed", raw_text: null, text: "Cleaned." });
  db.transcriptions.set(3, { id: 3, status: "completed", raw_text: "   ", text: "Cleaned." });
  db.transcriptions.set(4, { id: 4, status: "failed", raw_text: "raw", text: "" });
  db.transcriptions.set(5, { id: 5, status: "completed", raw_text: "raw", deleted_at: "now" });
  db.transcriptions.set(6, { id: 6, status: "completed", raw_text: "x".repeat(MAX_RAW_TEXT + 1) });

  assert.deepEqual(cases.pinFromHistory(2), { success: false, code: "NO_RAW_TEXT" });
  assert.deepEqual(cases.pinFromHistory(3), { success: false, code: "NO_RAW_TEXT" });
  assert.deepEqual(cases.pinFromHistory(4), { success: false, code: "NOT_PINNABLE" });
  assert.deepEqual(cases.pinFromHistory(5), { success: false, code: "NOT_FOUND" });
  assert.deepEqual(cases.pinFromHistory(6), { success: false, code: "TOO_LONG" });
  assert.deepEqual(cases.pinFromHistory(99), { success: false, code: "NOT_FOUND" });
  assert.deepEqual(cases.pinFromHistory("1"), { success: false, code: "INVALID_INPUT" });
  assert.equal(db.rows.length, 0, "the cleaned text is never substituted as the input");
});

test("history off keeps new pins for this session only, from both entry points", () => {
  const { db, cases, state } = setup({ policy: { ...ON, enabled: false } });

  const pinned = cases.pinFromHistory(1);
  const saved = cases.save({ rawText: "hello littlebuddy" });
  for (const result of [pinned, saved]) {
    assert.equal(result.success, true);
    assert.equal(result.durable, false);
    assert.equal(result.reason, "history-off");
    assert.equal(result.case.durable, false);
  }
  assert.equal(db.rows.length, 0, "nothing reaches the database");
  assert.equal(cases.list().cases.length, 2);
  assert.equal(cases.list().durable, false);

  // Turning history back on stores new pins; session ones stay session-only.
  state.policy.enabled = true;
  const later = cases.save({ rawText: "another" });
  assert.equal(later.durable, true);
  assert.deepEqual(
    cases.list().cases.map((c) => c.durable),
    [false, false, true]
  );
});

test("an unsynced or unsettled policy never writes, and a signed-out user needs no managed policy", () => {
  const unsynced = setup({ policy: { ...ON, synced: false } });
  assert.equal(unsynced.cases.save({ rawText: "a" }).reason, "pending");
  assert.equal(unsynced.db.rows.length, 0);

  const unsettled = setup({ policy: { ...ON, resolved: false } });
  assert.equal(unsettled.cases.save({ rawText: "a" }).reason, "pending");
  assert.equal(unsettled.db.rows.length, 0);

  const signedOut = setup({ owner: "signed-out", policy: { ...ON, resolved: false } });
  assert.equal(signedOut.cases.save({ rawText: "a" }).durable, true);
  assert.equal(signedOut.db.rows.length, 1);
});

test("an organization's always_off allows no durable copy, and existing pins follow it", () => {
  const { db, cases, state, changes } = setup();
  cases.save({ rawText: "first" });
  cases.pinFromHistory(1);
  assert.equal(db.rows.length, 2);

  state.policy = { ...ON, enabled: false, forcedOff: true };
  changes.length = 0;
  assert.equal(cases.policyChanged(), 2, "the stored cases move to memory");
  assert.equal(db.rows.length, 0, "and leave the disk");
  assert.deepEqual(changes, [{ owner: "account:a", reason: "policy" }]);

  const listed = cases.list();
  assert.equal(listed.durable, false);
  assert.equal(listed.reason, "policy-off");
  assert.deepEqual(
    listed.cases.map((c) => [c.rawText, c.durable]),
    [
      ["first", false],
      ["um send the report by thursday no wait friday", false],
    ]
  );
  const pinned = cases.save({ rawText: "new" });
  assert.equal(pinned.durable, false);
  assert.equal(db.rows.length, 0);

  // Even if the retention sync hasn't run the move yet, listing enforces it.
  state.policy = ON;
  cases.save({ rawText: "durable again" });
  state.policy = { ...ON, enabled: false, forcedOff: true };
  assert.equal(
    cases.list().cases.every((c) => !c.durable),
    true
  );
  assert.equal(db.rows.length, 0);
});

test("every read and write is scoped to the current owner", () => {
  const { db, cases, state } = setup();
  const a = cases.save({ rawText: "account a's dictation" }).case;
  state.owner = "signed-out";
  const signedOut = cases.save({ rawText: "signed-out dictation" }).case;

  assert.deepEqual(
    cases.list().cases.map((c) => c.id),
    [signedOut.id],
    "signed-out cases only"
  );
  assert.deepEqual(cases.update(a.id, { label: "x" }), { success: false, code: "NOT_FOUND" });
  assert.deepEqual(cases.remove(a.id), { success: false, code: "NOT_FOUND" });

  // Signing in never adopts the signed-out cases.
  state.owner = "account:b";
  assert.deepEqual(cases.list().cases, []);
  cases.clear();
  assert.equal(db.rows.length, 2, "clearing account b leaves a and signed-out alone");

  state.owner = "account:a";
  assert.deepEqual(
    cases.list().cases.map((c) => c.id),
    [a.id]
  );

  state.owner = null;
  assert.equal(cases.list().code, "OWNER_UNKNOWN");
  assert.equal(cases.save({ rawText: "x" }).code, "OWNER_UNKNOWN");
  assert.equal(cases.pinFromHistory(1).code, "OWNER_UNKNOWN");
});

test("session-only cases are owner-scoped too, and an account's are forgotten on deletion", () => {
  const { cases, state } = setup({ policy: { ...ON, enabled: false } });
  cases.save({ rawText: "a's session case" });
  state.owner = "account:b";
  cases.save({ rawText: "b's session case" });
  assert.deepEqual(
    cases.list().cases.map((c) => c.rawText),
    ["b's session case"]
  );

  cases.forgetOwner("account:a");
  state.owner = "account:a";
  assert.deepEqual(cases.list().cases, []);
  state.owner = "account:b";
  assert.equal(cases.list().cases.length, 1);

  cases.clearSession();
  assert.deepEqual(cases.list().cases, []);
});

test("the same input is one case, edits keep the input, and checks are normalized", () => {
  const { cases } = setup();
  const first = cases.save({ rawText: "what is the capital of France" });
  const again = cases.save({ rawText: "what is the capital of France" });
  assert.equal(again.duplicate, true);
  assert.equal(again.case.id, first.case.id);

  const updated = cases.update(first.case.id, {
    label: "  Question  ",
    targetApp: " Code.exe ",
    mustContain: ["France", " France ", "", 7],
    mustNotContain: ["Paris"],
    matchCase: true,
    rawText: "an attempt to change the input",
  });
  assert.equal(updated.success, true);
  assert.equal(updated.case.label, "Question");
  assert.equal(updated.case.targetApp, "Code.exe");
  assert.deepEqual(updated.case.mustContain, ["France"]);
  assert.deepEqual(updated.case.mustNotContain, ["Paris"]);
  assert.equal(updated.case.matchCase, true);
  assert.equal(updated.case.rawText, "what is the capital of France");

  assert.equal(cases.save({ rawText: "   " }).code, "INVALID_INPUT");
  assert.equal(cases.save({}).code, "INVALID_INPUT");
});

test("windows hear about owner changes once, and about every change", () => {
  const { cases, state, changes } = setup();
  assert.equal(cases.ownerMaybeChanged(), true);
  assert.equal(cases.ownerMaybeChanged(), false, "no repeat for the same owner");
  state.owner = "account:b";
  assert.equal(cases.ownerMaybeChanged(), true);
  assert.deepEqual(
    changes.filter((c) => c.reason === "owner"),
    [
      { owner: "account:a", reason: "owner" },
      { owner: "account:b", reason: "owner" },
    ]
  );

  changes.length = 0;
  const added = cases.save({ rawText: "x" }).case;
  cases.update(added.id, { label: "y" });
  cases.remove(added.id);
  cases.clear();
  assert.deepEqual(
    changes.map((c) => c.reason),
    ["added", "updated", "removed", "cleared"]
  );
});

test("a failed write keeps the pin for this session rather than losing it", () => {
  const { db, cases } = setup();
  db.insertPromptTestCase = () => {
    throw new Error("disk full");
  };
  const result = cases.save({ rawText: "keep me" });
  assert.equal(result.success, true);
  assert.equal(result.durable, false);
  assert.equal(result.reason, "unavailable");
  assert.equal(cases.list().cases[0].rawText, "keep me");
});
