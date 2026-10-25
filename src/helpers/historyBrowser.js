// The History view's reads (components/history/): a paged list, the apps the
// App filter offers, and one dictation by id. Main decides what the renderer
// sees: rows are device-wide, as Home lists them, while everything taken from
// step history (the target app, which steps changed the text, "Cleanup changed
// it", the steps themselves) and from reviews (a row's rating, the Flagged
// filter, the review itself) is the current owner's only, as history-get-steps.
// List rows carry a short preview, never the full texts. Dictated text never
// reaches a log: callers log reasons and counts only.

const { stepChanges } = require("../utils/stepChanges.js");
const { ownerTag } = require("./dictationFeedback");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_CHARS = 500;
const MAX_APP_CHARS = 200;
const MAX_CURSOR_CHARS = 64;

function parseJson(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clampLimit(value) {
  const limit = Number.isFinite(value) ? Math.trunc(value) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, limit));
}

/**
 * history-list's request as the database reads it, or null when the cursor is
 * malformed (a bad cursor must not silently restart at the first page).
 * Unknown filters are ignored; an empty query means no search.
 */
function normalizeListRequest(request) {
  const input = request && typeof request === "object" ? request : {};
  let cursor = null;
  if (input.cursor != null) {
    const { timestamp, id } = input.cursor;
    if (
      typeof timestamp !== "string" ||
      timestamp.length > MAX_CURSOR_CHARS ||
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return null;
    }
    cursor = { timestamp, id };
  }
  const query = typeof input.query === "string" ? input.query.trim().slice(0, MAX_QUERY_CHARS) : "";
  const filters = input.filters && typeof input.filters === "object" ? input.filters : {};
  const app =
    typeof filters.app === "string" && filters.app.trim()
      ? filters.app.trim().slice(0, MAX_APP_CHARS)
      : null;
  return {
    cursor,
    limit: clampLimit(input.limit),
    query,
    failed: filters.failed === true,
    cleanupChanged: filters.cleanupChanged === true,
    app,
    flagged: filters.flagged === true,
  };
}

/**
 * A row's app and marks from its owner's steps (in saved order): what each
 * step after speech-to-text did to the text. Null for both without steps.
 */
function summarizeSteps(steps) {
  if (!steps || steps.length === 0) return { app: null, marks: null };
  const context = parseJson(steps[0].context);
  const app =
    typeof context?.targetApp === "string" && context.targetApp ? context.targetApp : null;
  const changes = stepChanges(steps);
  const marks = [];
  steps.forEach((step, index) => {
    if (step.kind === "stt") return;
    const detail = step.kind === "finalize" ? parseJson(step.detail) : null;
    marks.push({
      kind: step.kind,
      change: changes[index].change,
      ...(detail?.snippets === true ? { snippets: true } : {}),
    });
  });
  return { app, marks };
}

function listRow(row, steps) {
  return {
    id: row.id,
    timestamp: row.timestamp ?? null,
    status: row.status,
    errorCode: row.error_code ?? null,
    preview: row.preview ?? null,
    hasAudio: row.has_audio === 1,
    audioDurationMs: row.audio_duration_ms ?? null,
    routeKind: row.route_kind ?? null,
    rating: row.rating === "good" || row.rating === "bad" ? row.rating : null,
    ...summarizeSteps(steps),
  };
}

function itemFromRow(row) {
  return {
    id: row.id,
    timestamp: row.timestamp ?? null,
    status: row.status,
    text: row.text ?? "",
    rawText: row.raw_text ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    hasAudio: row.has_audio === 1,
    audioDurationMs: row.audio_duration_ms ?? null,
    routeKind: row.route_kind ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
  };
}

/**
 * - db: the DatabaseManager
 * - stepHistory: createStepHistory's service (its owner, and getSteps)
 * - feedback: createDictationFeedback's service (the owner's review of a row)
 */
function createHistoryBrowser({ db, stepHistory, feedback = null }) {
  return {
    /** history-list: a page of rows, and the cursor of the next one (null at the end). */
    list(request) {
      const normalized = normalizeListRequest(request);
      if (!normalized)
        return { success: false, code: "INVALID_CURSOR", rows: [], nextCursor: null };
      const owner = stepHistory.currentOwner();
      const { limit } = normalized;
      // One extra row says whether another page follows.
      const page = db.getHistoryPage({ ...normalized, owner, limit: limit + 1 });
      const rows = page.slice(0, limit);
      const stepsById = new Map();
      for (const step of db.getHistoryStepRows(
        rows.map((row) => row.id),
        owner
      )) {
        if (!stepsById.has(step.transcription_id)) stepsById.set(step.transcription_id, []);
        stepsById.get(step.transcription_id).push(step);
      }
      const last = rows[rows.length - 1];
      return {
        success: true,
        rows: rows.map((row) => listRow(row, stepsById.get(row.id))),
        nextCursor: page.length > limit && last ? { timestamp: last.sort_key, id: last.id } : null,
      };
    },

    /** history-apps: the App filter's choices. */
    apps() {
      return { success: true, apps: db.getHistoryApps(stepHistory.currentOwner()) };
    },

    /**
     * history-get-item: the full row, with the owner's steps as history-get-steps
     * reads them, the revision a review of it is of, the owner as an opaque tag
     * (drafts are kept per owner) and the owner's review of it.
     */
    getItem(id) {
      if (!Number.isInteger(id) || id <= 0) return { success: false, code: "NOT_FOUND" };
      const row = db.getHistoryItem(id);
      if (!row) return { success: false, code: "NOT_FOUND" };
      const owner = stepHistory.currentOwner();
      const { status, route, context, steps } = stepHistory.getSteps(id);
      return {
        success: true,
        item: itemFromRow(row),
        status,
        route,
        context,
        steps,
        revision: db.getHistoryRevision(id, owner),
        owner: owner ? ownerTag(owner) : null,
        feedback: feedback ? feedback.get(id).feedback : null,
      };
    },
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  createHistoryBrowser,
  normalizeListRequest,
  summarizeSteps,
};
