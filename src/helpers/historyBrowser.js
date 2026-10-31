// The History view's reads (components/history/): a paged list, the apps the
// App filter offers, and one dictation by id. Main decides what the renderer
// sees: rows are device-wide, as Home lists them, while everything taken from
// step history (the target app, which steps changed the text, "Cleanup changed
// it", the steps themselves) and from reviews (a row's rating, the Flagged
// filter, the review itself) is the current owner's only, as history-get-steps.
// List rows carry a short preview, never the full texts. Dictated text never
// reaches a log: callers log reasons and counts only.
//
// The dictionary in History: the "Dictionary fixed" and "Show in History"
// filters and each row's "📖 n fixed" badge are the row-summary matcher
// (dictionaryUsage.js) over the current dictionary generation; a later page
// asked for under an older generation is `stale` and the renderer starts
// over. The detail's "Dictionary in this dictation" is the alignment
// (dictionaryOccurrences.js) of the row's own raw and final text, which
// History already shows; who fixed a word ("by the glossary", "by cleanup")
// only from the current owner's steps.

const { stepChanges } = require("../utils/stepChanges.js");
const { failedStepKind } = require("./stepFailure.js");
const { ownerTag } = require("./dictationFeedback");
// ESM, through require(esm).
const { historyItemDictionary, isAssistantTrace } = require("./dictionaryOccurrences.js");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_CHARS = 500;
const MAX_APP_CHARS = 200;
const MAX_CURSOR_CHARS = 64;
const MAX_WORD_CHARS = 500;
const MAX_FIXES_IDS = 2000;

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
  const dictionaryWord =
    typeof filters.dictionaryWord === "string" &&
    filters.dictionaryWord.trim() &&
    filters.dictionaryWord.length <= MAX_WORD_CHARS
      ? filters.dictionaryWord.trim()
      : null;
  return {
    cursor,
    limit: clampLimit(input.limit),
    query,
    failed: filters.failed === true,
    cleanupChanged: filters.cleanupChanged === true,
    app,
    flagged: filters.flagged === true,
    dictionaryFixed: filters.dictionaryFixed === true,
    dictionaryWord,
    generation: Number.isInteger(input.generation) ? input.generation : null,
  };
}

/**
 * A row's app and marks from its owner's steps (in saved order): what each
 * step after speech-to-text did to the text, and the kind of the first
 * cleanup, style or translation step that failed (the row's badge). Null for
 * all of them without steps.
 */
function summarizeSteps(steps) {
  if (!steps || steps.length === 0) return { app: null, marks: null, stepFailure: null };
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
  return { app, marks, stepFailure: failedStepKind(steps) };
}

function listRow(row, steps, dictionaryFixes = 0) {
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
    dictionaryFixes: Number.isInteger(dictionaryFixes) ? dictionaryFixes : 0,
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
  const generationNow = () => {
    try {
      return db.getDictionaryGeneration?.() ?? null;
    } catch {
      return null;
    }
  };
  const fixesFor = (ids, owner) => {
    try {
      return db.getHistoryDictionaryFixes?.(ids, owner)?.fixes ?? new Map();
    } catch {
      return new Map();
    }
  };
  // The current dictionary and the snippets' expansions, as usage reads them.
  const dictionaryNow = () => {
    try {
      return {
        words: db.getDictionary?.() ?? [],
        expansions: (db.getSnippets?.() ?? []).map((snippet) => snippet.replacement),
      };
    } catch {
      return { words: [], expansions: [] };
    }
  };

  return {
    /**
     * history-list: a page of rows, the cursor of the next one (null at the
     * end) and the dictionary generation the dictionary filters and badges
     * were read with. A later page of a dictionary filter asked for under
     * another generation is `stale`: the renderer starts over.
     */
    list(request) {
      const normalized = normalizeListRequest(request);
      if (!normalized)
        return { success: false, code: "INVALID_CURSOR", rows: [], nextCursor: null };
      const owner = stepHistory.currentOwner();
      const { limit } = normalized;
      const generation = generationNow();
      const dictionaryFiltered = normalized.dictionaryFixed || !!normalized.dictionaryWord;
      if (
        dictionaryFiltered &&
        normalized.cursor &&
        normalized.generation !== null &&
        normalized.generation !== generation
      ) {
        return { success: true, stale: true, rows: [], nextCursor: null, generation };
      }
      // One extra row says whether another page follows.
      const page = db.getHistoryPage({
        ...normalized,
        owner,
        limit: limit + 1,
        dictionaryGeneration: generation,
      });
      const rows = page.slice(0, limit);
      const ids = rows.map((row) => row.id);
      const stepsById = new Map();
      for (const step of db.getHistoryStepRows(ids, owner)) {
        if (!stepsById.has(step.transcription_id)) stepsById.set(step.transcription_id, []);
        stepsById.get(step.transcription_id).push(step);
      }
      const fixes = fixesFor(ids, owner);
      const last = rows[rows.length - 1];
      return {
        success: true,
        rows: rows.map((row) => listRow(row, stepsById.get(row.id), fixes.get(row.id) ?? 0)),
        nextCursor: page.length > limit && last ? { timestamp: last.sort_key, id: last.id } : null,
        generation,
      };
    },

    /**
     * history-dictionary-fixes: loaded rows' "📖 n fixed" badges again, after
     * the dictionary or a snippet changed.
     */
    dictionaryFixes(ids) {
      const list = Array.isArray(ids)
        ? ids.filter((id) => Number.isInteger(id) && id > 0).slice(0, MAX_FIXES_IDS)
        : [];
      const owner = stepHistory.currentOwner();
      const { generation, fixes } = db.getHistoryDictionaryFixes(list, owner);
      return { success: true, generation, fixes: Object.fromEntries(fixes) };
    },

    /** history-apps: the App filter's choices. */
    apps() {
      return { success: true, apps: db.getHistoryApps(stepHistory.currentOwner()) };
    },

    /**
     * history-get-item: the full row, with the owner's steps as history-get-steps
     * reads them, the revision a review of it is of, the owner as an opaque tag
     * (drafts are kept per owner), the owner's review of it, and the dictionary
     * words in it (the current dictionary; who fixed one only from the owner's
     * steps). None for a translation or, by the owner's steps, the assistant's.
     */
    getItem(id) {
      if (!Number.isInteger(id) || id <= 0) return { success: false, code: "NOT_FOUND" };
      const row = db.getHistoryItem(id);
      if (!row) return { success: false, code: "NOT_FOUND" };
      const owner = stepHistory.currentOwner();
      const { status, route, context, steps } = stepHistory.getSteps(id);
      let dictionary = [];
      let dictionaryAligned = true;
      const listed = row.status === "completed" && typeof row.raw_text === "string";
      if (listed && row.route_kind !== "translation" && !isAssistantTrace({ route, context })) {
        const { words, expansions } = dictionaryNow();
        const found = historyItemDictionary(
          { raw: row.raw_text, final: row.text ? row.text : row.raw_text },
          words,
          { snippetExpansions: expansions, steps: status === "captured" ? steps : [] }
        );
        dictionary = found.words;
        dictionaryAligned = found.aligned;
      }
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
        dictionary,
        dictionaryAligned,
        dictionaryGeneration: generationNow(),
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
