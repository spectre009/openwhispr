// Dictation reviews: what the user thought of one dictation in the History
// view (good or bad; for a bad one, the step they think got it wrong, what it
// should have said and a note), in main's local-only `dictation_feedback`
// table (history DB).
//
// Main is the only authority here:
// - Ownership: a review belongs to step history's current owner
//   ("account:<id>" or "signed-out"), and every read and write is scoped to
//   it. Signed-out reviews are never adopted on sign-in; account deletion
//   removes the account's reviews in its own transaction (database.js).
// - Version: a review is of one revision of its dictation (historyRevision:
//   the row's text, raw text and status and the owner's step ids). Saving
//   needs the revision the form was opened on. A retry, any text replacement
//   and new steps delete the row's reviews in the transaction of the change,
//   and the row's deletion (any path) takes them along.
// - Policy: a review is saved only while history is durable for its owner,
//   decided as the test set decides it (promptTestCases.js): the "keep local
//   history" setting synced and on and, for an account, its managed policy
//   settled and not forcing history off. Otherwise nothing is kept.
//
// Corrections and notes are dictated text: local only (never synced,
// exported or indexed) and never logged. Log reasons and counts only.

const crypto = require("crypto");
const { SIGNED_OUT_OWNER, STEP_KINDS } = require("./stepHistory");

const VERDICTS = new Set(["good", "bad"]);
// Stages that aren't a recorded step: the user blames the paste, or doesn't know.
const OTHER_STAGES = new Set(["delivery", "unsure"]);
const MAX_REVISION_CHARS = 64;
const MAX_EXPECTED_TEXT = 100_000;
const MAX_NOTE_CHARS = 500;

/**
 * The version of a dictation a review is of: its text, raw text and status,
 * and the ids of the owner's steps (new ids after a retry or any rewrite).
 */
function historyRevision(row, stepIds) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([row?.text ?? "", row?.raw_text ?? null, row?.status ?? null, stepIds ?? []])
    )
    .digest("hex")
    .slice(0, 32);
}

/** An opaque name for an owner, so the renderer can key drafts without seeing account ids. */
function ownerTag(owner) {
  return crypto.createHash("sha256").update(`owner:${owner}`).digest("hex").slice(0, 16);
}

/**
 * history-feedback-save's input as the database stores it, or why it can't be.
 * A good review keeps no step and no correction.
 */
function normalizeFeedbackInput(input) {
  const value = input && typeof input === "object" ? input : {};
  const { id, revision, verdict } = value;
  if (!Number.isInteger(id) || id <= 0) return { error: "INVALID" };
  if (typeof revision !== "string" || !revision || revision.length > MAX_REVISION_CHARS) {
    return { error: "INVALID" };
  }
  if (!VERDICTS.has(verdict)) return { error: "INVALID" };

  let stageKind = null;
  let stageSeq = null;
  const stage = verdict === "bad" ? value.stage : null;
  if (stage != null) {
    if (typeof stage !== "object") return { error: "INVALID_STAGE" };
    if (OTHER_STAGES.has(stage.kind)) {
      if (stage.seq != null) return { error: "INVALID_STAGE" };
      stageKind = stage.kind;
    } else if (STEP_KINDS.has(stage.kind) && Number.isInteger(stage.seq) && stage.seq >= 0) {
      stageKind = stage.kind;
      stageSeq = stage.seq;
    } else {
      return { error: "INVALID_STAGE" };
    }
  }

  let expectedText = null;
  if (verdict === "bad" && value.expectedText != null) {
    if (typeof value.expectedText !== "string") return { error: "INVALID" };
    if (value.expectedText.length > MAX_EXPECTED_TEXT) return { error: "TOO_LONG" };
    expectedText = value.expectedText.trim() ? value.expectedText : null;
  }

  let note = null;
  if (value.note != null) {
    if (typeof value.note !== "string") return { error: "INVALID" };
    // One line: a pasted line break becomes a space.
    const line = value.note.replace(/\s*[\r\n]+\s*/g, " ").trim();
    note = line ? line.slice(0, MAX_NOTE_CHARS) : null;
  }

  return { value: { id, revision, verdict, stageKind, stageSeq, expectedText, note } };
}

/** A stored review as the renderer sees it. */
function feedbackFromRow(row) {
  if (!row) return null;
  return {
    revision: row.revision,
    verdict: row.verdict,
    stage: row.stage_kind ? { kind: row.stage_kind, seq: row.stage_seq ?? null } : null,
    expectedText: row.expected_text ?? null,
    note: row.note ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SAVE_FAILURES = {
  notFound: "NOT_FOUND",
  stale: "STALE",
  invalidStage: "INVALID_STAGE",
};

/**
 * The service main's IPC handlers delegate to.
 * - db: the DatabaseManager
 * - getOwner(): the current owner key (step history's), or null when unknown
 * - getPolicy(): `{ synced, enabled, forcedOff, resolved }`, as for the test set
 * - onChange({ id }): a review was saved or deleted
 */
function createDictationFeedback({
  db,
  getOwner,
  getPolicy,
  onChange = () => {},
  logger,
  now = () => new Date(),
}) {
  const log = (message, meta) => {
    try {
      logger?.debug?.(message, meta, "history");
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

  const notify = (id) => {
    try {
      onChange({ id });
    } catch {
      // A failed broadcast must never undo a write.
    }
  };

  /** Whether a review for this owner may be written to disk, and why not. */
  function storageFor(owner) {
    const policy = readPolicy();
    if (policy.forcedOff) return { durable: false, reason: "policy-off" };
    if (!policy.synced) return { durable: false, reason: "pending" };
    if (!policy.enabled) return { durable: false, reason: "history-off" };
    if (owner !== SIGNED_OUT_OWNER && !policy.resolved)
      return { durable: false, reason: "pending" };
    if (!db.dictationFeedbackReady) return { durable: false, reason: "unavailable" };
    return { durable: true, reason: null };
  }

  return {
    storageFor,

    /** history-feedback-get: the current owner's review of a row, or null. */
    get(id) {
      const owner = currentOwner();
      if (!owner || !Number.isInteger(id) || id <= 0 || !db.dictationFeedbackReady) {
        return { success: true, feedback: null };
      }
      return { success: true, feedback: feedbackFromRow(db.getDictationFeedback(id, owner)) };
    },

    /**
     * history-feedback-save: `{ id, revision, verdict, stage, expectedText, note }`.
     * Refused with a code: OWNER_UNKNOWN, INVALID, INVALID_STAGE, TOO_LONG,
     * HISTORY_OFF (not durable now), UNAVAILABLE, NOT_FOUND or STALE (the
     * dictation changed since the form opened).
     */
    save(input) {
      const owner = currentOwner();
      if (!owner) return { success: false, code: "OWNER_UNKNOWN" };
      const normalized = normalizeFeedbackInput(input);
      if (normalized.error) return { success: false, code: normalized.error };
      const storage = storageFor(owner);
      if (!storage.durable) {
        log("Dictation review not saved", { reason: storage.reason });
        return {
          success: false,
          code: storage.reason === "unavailable" ? "UNAVAILABLE" : "HISTORY_OFF",
          reason: storage.reason,
        };
      }
      const { value } = normalized;
      const result = db.saveDictationFeedback({
        ...value,
        transcriptionId: value.id,
        owner,
        now: now().toISOString(),
      });
      if (result.status !== "saved") {
        log("Dictation review not saved", { reason: result.status });
        return { success: false, code: SAVE_FAILURES[result.status] || "FAILED" };
      }
      log("Dictation review saved", {
        verdict: value.verdict,
        stage: Boolean(value.stageKind),
        correction: Boolean(result.row?.expected_text),
        note: Boolean(value.note),
      });
      notify(value.id);
      return { success: true, feedback: feedbackFromRow(result.row) };
    },

    /** history-feedback-delete: the current owner's review of a row. */
    remove(id) {
      const owner = currentOwner();
      if (!owner) return { success: false, code: "OWNER_UNKNOWN" };
      if (!Number.isInteger(id) || id <= 0) return { success: false, code: "INVALID" };
      if (!db.dictationFeedbackReady) return { success: true, removed: false };
      const removed = db.deleteDictationFeedback(id, owner);
      if (removed) {
        log("Dictation review deleted", {});
        notify(id);
      }
      return { success: true, removed };
    },
  };
}

module.exports = {
  MAX_EXPECTED_TEXT,
  MAX_NOTE_CHARS,
  createDictationFeedback,
  feedbackFromRow,
  historyRevision,
  normalizeFeedbackInput,
  ownerTag,
};
