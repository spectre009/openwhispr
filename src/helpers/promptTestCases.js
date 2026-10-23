// Prompt test cases: the inputs Prompt Studio's test set runs two cleanup
// prompts against. A case is a dictation's raw transcript, copied, with an
// optional label, target app and literal checks.
//
// Main is the only authority here:
// - Ownership: a case belongs to an account ("account:<id>") or to the
//   signed-out namespace (stepHistory's ownerKeyFor, on the same account
//   binding), and every read and write is scoped to the current owner.
//   Signed-out cases are never adopted on sign-in, and account deletion
//   removes the account's cases in its own transaction (database.js).
// - Policy: a pin is durable only while the effective "keep local history"
//   setting is on (the dictation window's retention sync, the source step
//   history reads). With history off, or before that setting has synced, a
//   pin is kept in memory for this session only. An organization policy that
//   forces history off (always_off) never allows a durable copy: the owner's
//   existing durable cases move to this session's memory when it arrives.
// - Copies: a pinned dictation's raw text is copied, so the case outlives
//   history deletion and expiry; the history row id is kept only to open it.
//   A row without a raw transcript can't be pinned: the cleaned text is never
//   substituted as the input.
//
// Cases hold dictated text: local only (never synced, exported or indexed)
// and never logged. Log reasons and counts only.

const crypto = require("crypto");
const { SIGNED_OUT_OWNER } = require("./stepHistory");

// What a case tests. Stage 3 adds style targets ("style:<id>").
const TARGETS = new Set(["cleanup"]);
const DEFAULT_TARGET = "cleanup";

const MAX_RAW_TEXT = 50_000;
const MAX_REFERENCE_TEXT = 50_000;
const MAX_LABEL = 200;
const MAX_TARGET_APP = 260;
const MAX_CHECKS = 20;
const MAX_CHECK_TEXT = 200;
const MAX_CASES_PER_OWNER = 500;

const STORAGE_REASONS = Object.freeze({
  HISTORY_OFF: "history-off",
  POLICY_OFF: "policy-off",
  PENDING: "pending",
  UNAVAILABLE: "unavailable",
});

function cleanString(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** A list of literal check strings: trimmed, non-empty, unique, capped. */
function normalizeChecks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, MAX_CHECK_TEXT);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_CHECKS) break;
  }
  return out;
}

/** The fields a user may edit, from untrusted renderer input. */
function normalizeEditable(input = {}) {
  return {
    label: cleanString(input.label, MAX_LABEL),
    targetApp: cleanString(input.targetApp, MAX_TARGET_APP),
    mustContain: normalizeChecks(input.mustContain),
    mustNotContain: normalizeChecks(input.mustNotContain),
    matchCase: input.matchCase === true,
  };
}

function parseList(value) {
  if (typeof value !== "string") return [];
  try {
    return normalizeChecks(JSON.parse(value));
  } catch {
    return [];
  }
}

/** A stored row (database or session) as the renderer sees it. */
function caseFromRow(row, durable) {
  return {
    id: row.id,
    target: row.target,
    label: row.label ?? null,
    rawText: row.raw_text,
    referenceText: row.reference_text ?? null,
    targetApp: row.target_app ?? null,
    mustContain: parseList(row.must_contain),
    mustNotContain: parseList(row.must_not_contain),
    matchCase: row.match_case === 1 || row.match_case === true,
    source: row.source,
    sourceTranscriptionId: Number.isInteger(row.source_transcription_id)
      ? row.source_transcription_id
      : null,
    durable,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function byCreation(a, b) {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

/**
 * The service main's IPC handlers delegate to.
 * - db: the DatabaseManager
 * - getOwner(): the current owner key (ownerKeyFor), or null when unknown
 * - getPolicy(): `{ synced, enabled, forcedOff, resolved }` from the retention
 *   sync: whether it has synced, the effective "keep local history" switch,
 *   whether an organization forces it off, and whether that policy has settled
 * - onChange({ owner, reason }): a window should re-read the list
 */
function createPromptTestCases({
  db,
  getOwner,
  getPolicy,
  onChange = () => {},
  logger,
  now = () => new Date(),
  randomId = () => crypto.randomUUID(),
}) {
  // Session-only cases: owner -> Map(id -> row), gone when the app quits.
  const session = new Map();
  let lastOwner;

  const log = (message, meta) => {
    try {
      logger?.debug?.(message, meta, "prompt-tests");
    } catch {
      // Logging must never cost a write.
    }
  };

  const currentOwner = () => {
    try {
      const owner = getOwner();
      return typeof owner === "string" && owner ? owner : null;
    } catch {
      return null;
    }
  };

  const readPolicy = () => {
    try {
      const policy = getPolicy() || {};
      return {
        synced: policy.synced === true,
        enabled: policy.enabled === true,
        forcedOff: policy.forcedOff === true,
        resolved: policy.resolved === true,
      };
    } catch {
      return { synced: false, enabled: false, forcedOff: false, resolved: false };
    }
  };

  const notify = (owner, reason) => {
    try {
      onChange({ owner, reason });
    } catch {
      // A failed broadcast must never undo a write.
    }
  };

  /** Whether a new case for this owner may be written to disk, and why not. */
  function storageFor(owner) {
    const policy = readPolicy();
    if (policy.forcedOff) return { durable: false, reason: STORAGE_REASONS.POLICY_OFF };
    if (!policy.synced) return { durable: false, reason: STORAGE_REASONS.PENDING };
    if (!policy.enabled) return { durable: false, reason: STORAGE_REASONS.HISTORY_OFF };
    // A managed policy that may force history off arrives over the network;
    // until it settles, a signed-in pin stays in memory.
    if (owner !== SIGNED_OUT_OWNER && !policy.resolved) {
      return { durable: false, reason: STORAGE_REASONS.PENDING };
    }
    if (!db.promptTestCasesReady) return { durable: false, reason: STORAGE_REASONS.UNAVAILABLE };
    return { durable: true, reason: null };
  }

  const sessionFor = (owner) => {
    if (!session.has(owner)) session.set(owner, new Map());
    return session.get(owner);
  };

  function durableRows(owner) {
    if (!db.promptTestCasesReady) return [];
    try {
      return db.getPromptTestCases(owner);
    } catch (error) {
      log("Prompt test cases not read", { error: error.message });
      return [];
    }
  }

  /**
   * An organization that forces local history off allows no durable copy:
   * the owner's stored cases move to this session's memory. Returns how many
   * moved.
   */
  function enforcePolicy() {
    const owner = currentOwner();
    if (!owner || !readPolicy().forcedOff || !db.promptTestCasesReady) return 0;
    let rows = [];
    try {
      rows = db.takePromptTestCases(owner);
    } catch (error) {
      log("Prompt test cases not moved for the policy", { error: error.message });
      return 0;
    }
    if (rows.length === 0) return 0;
    const memory = sessionFor(owner);
    for (const row of rows) memory.set(row.id, { ...row });
    log("Prompt test cases kept for this session only", { reason: "policy", moved: rows.length });
    notify(owner, "policy");
    return rows.length;
  }

  function rowsFor(owner) {
    const durable = durableRows(owner).map((row) => ({ row, durable: true }));
    const memory = [...(session.get(owner)?.values() ?? [])].map((row) => ({
      row,
      durable: false,
    }));
    return [...durable, ...memory].sort((a, b) => byCreation(a.row, b.row));
  }

  function findRow(owner, id) {
    const memory = session.get(owner)?.get(id);
    if (memory) return { row: memory, durable: false };
    if (!db.promptTestCasesReady) return null;
    const row = db.getPromptTestCase(owner, id);
    return row ? { row, durable: true } : null;
  }

  function findByText(owner, target, rawText) {
    for (const row of session.get(owner)?.values() ?? []) {
      if (row.target === target && row.raw_text === rawText) return { row, durable: false };
    }
    if (!db.promptTestCasesReady) return null;
    const row = db.findPromptTestCaseByText(owner, target, rawText);
    return row ? { row, durable: true } : null;
  }

  function countFor(owner) {
    const durable = db.promptTestCasesReady ? db.countPromptTestCases(owner) : 0;
    return durable + (session.get(owner)?.size ?? 0);
  }

  function insert(owner, { rawText, referenceText, source, sourceTranscriptionId, editable }) {
    const target = DEFAULT_TARGET;
    const storage = storageFor(owner);
    const existing = findByText(owner, target, rawText);
    if (existing) {
      return {
        success: true,
        duplicate: true,
        case: caseFromRow(existing.row, existing.durable),
        durable: existing.durable,
        reason: existing.durable ? null : storage.reason,
      };
    }
    if (countFor(owner) >= MAX_CASES_PER_OWNER) return { success: false, code: "LIMIT_REACHED" };
    const stamp = now().toISOString();
    const row = {
      id: randomId(),
      owner,
      target,
      label: editable.label,
      raw_text: rawText,
      reference_text:
        typeof referenceText === "string" ? referenceText.slice(0, MAX_REFERENCE_TEXT) : null,
      target_app: editable.targetApp,
      must_contain: JSON.stringify(editable.mustContain),
      must_not_contain: JSON.stringify(editable.mustNotContain),
      match_case: editable.matchCase ? 1 : 0,
      source,
      source_transcription_id: sourceTranscriptionId ?? null,
      created_at: stamp,
      updated_at: stamp,
    };
    let durable = storage.durable;
    let reason = storage.reason;
    if (durable) {
      try {
        db.insertPromptTestCase(row);
      } catch (error) {
        // A failed write keeps the pin for this session rather than losing it.
        log("Prompt test case not stored", { error: error.message });
        durable = false;
        reason = STORAGE_REASONS.UNAVAILABLE;
      }
    }
    if (!durable) sessionFor(owner).set(row.id, row);
    log("Prompt test case added", { source, durable, reason });
    notify(owner, "added");
    return { success: true, duplicate: false, case: caseFromRow(row, durable), durable, reason };
  }

  return {
    currentOwner,
    storageFor,
    enforcePolicy,

    /** The retention sync changed: apply a policy that forbids storage, and let windows re-read. */
    policyChanged() {
      const moved = enforcePolicy();
      if (moved === 0) notify(currentOwner(), "policy");
      return moved;
    },

    /** The current owner's cases and where a new one would be kept. */
    list() {
      const owner = currentOwner();
      if (!owner) return { success: false, code: "OWNER_UNKNOWN", owner: null, cases: [] };
      enforcePolicy();
      const storage = storageFor(owner);
      return {
        success: true,
        owner,
        durable: storage.durable,
        reason: storage.reason,
        cases: rowsFor(owner).map(({ row, durable }) => caseFromRow(row, durable)),
      };
    },

    /**
     * "Add to test set" in History: copies the row's raw transcript (and the
     * pasted text, as a reference) into a case. The renderer names the row;
     * the text is read here, never taken from the renderer.
     */
    pinFromHistory(transcriptionId) {
      const owner = currentOwner();
      if (!owner) return { success: false, code: "OWNER_UNKNOWN" };
      if (!Number.isInteger(transcriptionId)) return { success: false, code: "INVALID_INPUT" };
      const row = db.getTranscriptionById(transcriptionId);
      if (!row || row.deleted_at) return { success: false, code: "NOT_FOUND" };
      if (row.status && row.status !== "completed") return { success: false, code: "NOT_PINNABLE" };
      if (typeof row.raw_text !== "string" || !row.raw_text.trim()) {
        return { success: false, code: "NO_RAW_TEXT" };
      }
      if (row.raw_text.length > MAX_RAW_TEXT) return { success: false, code: "TOO_LONG" };
      // The target app the dictation was made in, when its steps were
      // captured for this owner: the app-scoped glossary rules depend on it.
      let targetApp = null;
      try {
        const steps = db.getTranscriptionSteps?.(transcriptionId, owner);
        if (steps?.status === "captured") targetApp = steps.context?.targetApp ?? null;
      } catch {
        targetApp = null;
      }
      return insert(owner, {
        rawText: row.raw_text,
        referenceText: typeof row.text === "string" ? row.text : null,
        source: "history",
        sourceTranscriptionId: transcriptionId,
        editable: normalizeEditable({ targetApp }),
      });
    },

    /** "Save as test case" from Prompt Studio's single Test: the input as typed. */
    save(input) {
      const owner = currentOwner();
      if (!owner) return { success: false, code: "OWNER_UNKNOWN" };
      const rawText = input?.rawText;
      if (typeof rawText !== "string" || !rawText.trim()) {
        return { success: false, code: "INVALID_INPUT" };
      }
      if (rawText.length > MAX_RAW_TEXT) return { success: false, code: "TOO_LONG" };
      return insert(owner, {
        rawText,
        referenceText: null,
        source: "test",
        sourceTranscriptionId: null,
        editable: normalizeEditable(input),
      });
    },

    /** Replaces a case's label, target app and checks. Its input never changes. */
    update(id, patch) {
      const owner = currentOwner();
      if (!owner) return { success: false, code: "OWNER_UNKNOWN" };
      if (typeof id !== "string") return { success: false, code: "INVALID_INPUT" };
      const found = findRow(owner, id);
      if (!found) return { success: false, code: "NOT_FOUND" };
      const editable = normalizeEditable(patch);
      const fields = {
        label: editable.label,
        target_app: editable.targetApp,
        must_contain: JSON.stringify(editable.mustContain),
        must_not_contain: JSON.stringify(editable.mustNotContain),
        match_case: editable.matchCase ? 1 : 0,
        updated_at: now().toISOString(),
      };
      let row;
      if (found.durable) {
        row = db.updatePromptTestCase(owner, id, fields);
        if (!row) return { success: false, code: "NOT_FOUND" };
      } else {
        row = { ...found.row, ...fields };
        sessionFor(owner).set(id, row);
      }
      notify(owner, "updated");
      return { success: true, case: caseFromRow(row, found.durable) };
    },

    remove(id) {
      const owner = currentOwner();
      if (!owner) return { success: false, code: "OWNER_UNKNOWN" };
      if (typeof id !== "string") return { success: false, code: "INVALID_INPUT" };
      let removed = session.get(owner)?.delete(id) === true;
      if (!removed && db.promptTestCasesReady) removed = db.deletePromptTestCase(owner, id);
      if (!removed) return { success: false, code: "NOT_FOUND" };
      notify(owner, "removed");
      return { success: true };
    },

    /** Removes every case of the current owner, stored and session-only. */
    clear() {
      const owner = currentOwner();
      if (!owner) return { success: false, code: "OWNER_UNKNOWN" };
      const inMemory = session.get(owner)?.size ?? 0;
      session.delete(owner);
      const stored = db.promptTestCasesReady ? db.clearPromptTestCases(owner) : 0;
      log("Prompt test cases cleared", { removed: inMemory + stored });
      notify(owner, "cleared");
      return { success: true, removed: inMemory + stored };
    },

    /** Account deletion: its stored cases go in that transaction; these are the session ones. */
    forgetOwner(owner) {
      if (typeof owner !== "string") return;
      session.delete(owner);
      notify(owner, "cleared");
    },

    /** Reset app data: the database file goes; the session copies go too. */
    clearSession() {
      session.clear();
    },

    /** Tells windows when the owner changed (sign-in, sign-out, another account). */
    ownerMaybeChanged() {
      const owner = currentOwner();
      if (owner === lastOwner) return false;
      lastOwner = owner;
      notify(owner, "owner");
      return true;
    },
  };
}

module.exports = {
  DEFAULT_TARGET,
  MAX_CASES_PER_OWNER,
  MAX_CHECKS,
  MAX_RAW_TEXT,
  STORAGE_REASONS,
  TARGETS,
  caseFromRow,
  createPromptTestCases,
  normalizeChecks,
  normalizeEditable,
};
