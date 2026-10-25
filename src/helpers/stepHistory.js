// Step history: what every stage of a dictation did, saved next to the
// dictation it describes. The renderer's post-speech-to-text boundary
// (helpers/postTranscription.ts) returns a trace; it rides on the existing
// save, and main writes it as `transcription_steps` rows (plus the resolved
// prompts in `prompt_versions`) in the same transaction as the history row.
//
// Main is the only authority here:
// - Ownership: a trace belongs to an account ("account:<id>") or to the
//   signed-out namespace, captured by beginRun when the recording (or retry)
//   starts. A trace that completes under another owner is discarded, and
//   reads and exports only ever see the current owner's steps. History rows
//   stay device-wide, so old rows are never assigned to anyone.
// - Policy: steps are written only while the effective "keep local history"
//   setting is on, as main last heard it from the dictation window.
// - Retry from history replaces a row's steps with its new trace, and a run
//   revision drops a completion that a newer retry has overtaken.
//
// Steps hold dictated text and prompts: local only (never synced, exported to
// the cloud or indexed) and never logged. Log reasons and counts only.

const crypto = require("crypto");

const SIGNED_OUT_OWNER = "signed-out";
const ACCOUNT_OWNER_PREFIX = "account:";
const TRACE_VERSION = 1;
const EXPORT_FORMAT = "openwhispr.dictations";
const EXPORT_VERSION = 1;

// "voice" and "edited" are reserved so later stages only add producers, never
// a migration; "style" is written by Stage 3's styled dictations.
const STEP_KINDS = new Set([
  "stt",
  "glossary",
  "cleanup",
  "translation",
  "agent",
  "style",
  "finalize",
  "voice",
  "edited",
]);
const STEP_OUTCOMES = new Set(["ok", "failed", "skipped", "fallback"]);
const ROUTES = new Set(["cleanup", "translation", "agent", "style", "skip", "none"]);
const PROMPT_SOURCES = new Set(["resolved", "server"]);
const STYLE_RUN_MODES = new Set(["two-step", "one-step"]);

const MAX_STEPS = 32;
const MAX_STEP_TEXT = 500_000;
// A prompt longer than this is dropped rather than cut: a stored prompt must be
// exactly what was sent, or it is not stored at all.
const MAX_PROMPT_TEXT = 200_000;
const MAX_SHORT_TEXT = 200;
const MAX_RULES_FIRED = 64;

const RUN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_OPEN_RUNS = 64;

/** The owner key of a trace: the account, or the signed-out namespace. */
function ownerKeyFor(accountId) {
  return typeof accountId === "string" && accountId.trim()
    ? `${ACCOUNT_OWNER_PREFIX}${accountId.trim()}`
    : SIGNED_OUT_OWNER;
}

function hashPrompt(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function shortText(value, max = MAX_SHORT_TEXT) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function stepText(value) {
  return typeof value === "string" ? value.slice(0, MAX_STEP_TEXT) : null;
}

function durationMs(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function normalizePrompt(ref) {
  if (!ref || typeof ref !== "object" || !PROMPT_SOURCES.has(ref.source)) return null;
  const entryId = shortText(ref.entryId);
  if (ref.source === "server") return { source: "server", hash: null, text: null, entryId };
  if (typeof ref.text !== "string" || ref.text.length > MAX_PROMPT_TEXT) return null;
  return { source: "resolved", hash: hashPrompt(ref.text), text: ref.text, entryId };
}

function normalizeRulesFired(fired) {
  if (!Array.isArray(fired)) return [];
  return fired
    .slice(0, MAX_RULES_FIRED)
    .filter((rule) => rule && typeof rule === "object" && typeof rule.ruleId === "string")
    .map((rule) => ({
      ruleId: shortText(rule.ruleId),
      spelling: shortText(rule.spelling),
      scope: rule.scope === "start" ? "start" : "anywhere",
      from: shortText(rule.from),
      to: shortText(rule.to),
      index: Number.isInteger(rule.index) && rule.index >= 0 ? rule.index : null,
    }));
}

/** A styled dictation's style (`{ styleId, runMode }` on steps, `{ id, runMode }` on context). */
function normalizeStyleRef(ref, idKey) {
  if (!ref || typeof ref !== "object") return null;
  const id = shortText(ref[idKey]);
  if (!id) return null;
  return { [idKey]: id, runMode: STYLE_RUN_MODES.has(ref.runMode) ? ref.runMode : null };
}

/**
 * Validates a renderer trace into what the database stores, or null when it
 * isn't a version 1 trace with at least one step. `rawTextIsNull`: the
 * history row has no raw transcript, so no `stt` step is invented for it.
 */
function normalizeTrace(trace, { rawTextIsNull = false } = {}) {
  if (!trace || typeof trace !== "object" || trace.version !== TRACE_VERSION) return null;
  if (!Array.isArray(trace.steps)) return null;
  const intents = trace.context?.intents || {};
  const style = normalizeStyleRef(trace.context?.style, "id");
  const context = {
    targetApp: shortText(trace.context?.targetApp),
    intents: {
      voiceAgent: intents.voiceAgent === true,
      translation: intents.translation === true,
      wakeWord: intents.wakeWord === true,
    },
    ...(style ? { style } : {}),
  };
  const glossary = {
    revision: Number.isFinite(trace.glossary?.revision) ? trace.glossary.revision : null,
    rulesFired: normalizeRulesFired(trace.glossary?.rulesFired),
  };
  const steps = [];
  for (const step of trace.steps.slice(0, MAX_STEPS)) {
    if (!step || typeof step !== "object") continue;
    if (!STEP_KINDS.has(step.kind) || !STEP_OUTCOMES.has(step.outcome)) continue;
    if (step.kind === "stt" && rawTextIsNull) continue;
    let detail = null;
    if (step.kind === "glossary") detail = glossary;
    else if (step.kind === "finalize" && step.detail?.snippets === true)
      detail = { snippets: true };
    else if (step.kind === "style") detail = normalizeStyleRef(step.detail, "styleId");
    steps.push({
      kind: step.kind,
      outcome: step.outcome,
      output: stepText(step.output),
      provider: shortText(step.provider),
      model: shortText(step.model),
      ms: durationMs(step.ms),
      errorCode: shortText(step.errorCode, 100),
      prompt: normalizePrompt(step.prompt),
      detail,
    });
  }
  if (steps.length === 0) return null;
  return {
    version: TRACE_VERSION,
    route: ROUTES.has(trace.route) ? trace.route : null,
    context,
    steps,
  };
}

/**
 * Open step-history runs, in memory: who owned each run when it began, and for
 * a retry from history which revision of that row it is. Nothing here needs to
 * outlive the app: a run in flight can't complete after a restart.
 */
function createStepRunRegistry({
  now = Date.now,
  randomId = () => crypto.randomUUID(),
  ttlMs = RUN_TTL_MS,
  maxRuns = MAX_OPEN_RUNS,
} = {}) {
  const runs = new Map();
  const retryRevisions = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [id, run] of runs) {
      if (run.startedAt < cutoff) runs.delete(id);
    }
    while (runs.size > maxRuns) runs.delete(runs.keys().next().value);
  }

  return {
    begin(owner, { transcriptionId = null } = {}) {
      const run = { owner, startedAt: now(), transcriptionId: null, revision: null };
      if (Number.isInteger(transcriptionId)) {
        const revision = (retryRevisions.get(transcriptionId) || 0) + 1;
        retryRevisions.set(transcriptionId, revision);
        run.transcriptionId = transcriptionId;
        run.revision = revision;
      }
      const id = randomId();
      runs.set(id, run);
      prune();
      return id;
    },
    /** Removes and returns the run; each run completes at most once. */
    take(id) {
      prune();
      if (typeof id !== "string" || !runs.has(id)) return null;
      const run = runs.get(id);
      runs.delete(id);
      return run;
    },
    /** False for a retry another, newer retry of the same row has overtaken. */
    isCurrent(run) {
      return (
        run.transcriptionId === null || retryRevisions.get(run.transcriptionId) === run.revision
      );
    },
  };
}

function parseJson(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** A stored step as the renderer and the export see it. */
function stepFromRow(row, { includePromptText = false } = {}) {
  const prompt = row.prompt_source
    ? {
        source: row.prompt_source,
        hash: row.prompt_hash || null,
        entryId: row.prompt_entry_id || null,
        ...(includePromptText ? { text: row.prompt_text ?? null } : {}),
      }
    : null;
  return {
    kind: row.kind,
    outcome: row.outcome,
    output: row.output,
    provider: row.provider,
    model: row.model,
    ms: row.duration_ms,
    errorCode: row.error_code,
    prompt,
    detail: parseJson(row.detail),
  };
}

/**
 * The step-history service main's IPC handlers delegate to.
 * - db: the DatabaseManager
 * - getOwner(): the current owner key (ownerKeyFor), or null when unknown
 * - isEnabled(): the effective "keep local history" setting
 */
function createStepHistory({ db, getOwner, isEnabled, runs = createStepRunRegistry(), logger }) {
  const log = (message, meta) => {
    try {
      logger?.debug?.(message, meta, "step-history");
    } catch {
      // Logging must never cost a save.
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

  const historyEnabled = () => {
    try {
      return isEnabled() === true;
    } catch {
      return false;
    }
  };

  // The steps a completed run may write, or why it may not. Re-checked at
  // completion: the policy and the owner may both have changed mid-run.
  function stepsFor(run, trace, rawText) {
    if (!run) return { steps: null, reason: "no-run" };
    if (!historyEnabled()) return { steps: null, reason: "history-off" };
    const owner = currentOwner();
    if (!owner || owner !== run.owner) return { steps: null, reason: "owner-changed" };
    const normalized = normalizeTrace(trace, { rawTextIsNull: rawText == null });
    if (!normalized) return { steps: null, reason: "invalid-trace" };
    return { steps: { owner, ...normalized }, reason: null };
  }

  function buildExport(owner, { now = () => new Date() } = {}) {
    const { dictations, steps, prompts } = db.getStepHistoryExport(owner);
    const stepsById = new Map();
    for (const row of steps) {
      if (!stepsById.has(row.transcription_id)) {
        stepsById.set(row.transcription_id, {
          route: row.route ?? null,
          context: parseJson(row.context),
          steps: [],
        });
      }
      stepsById.get(row.transcription_id).steps.push(stepFromRow(row));
    }
    const lines = [
      JSON.stringify({
        type: "export",
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: now().toISOString(),
        dictations: dictations.length,
        dictationsWithSteps: stepsById.size,
        prompts: prompts.length,
      }),
    ];
    for (const prompt of prompts) {
      lines.push(JSON.stringify({ type: "prompt", hash: prompt.hash, text: prompt.text }));
    }
    for (const row of dictations) {
      const trace = stepsById.get(row.id) || null;
      lines.push(
        JSON.stringify({
          type: "dictation",
          id: row.id,
          clientId: row.client_transcription_id ?? null,
          timestamp: row.timestamp ?? null,
          createdAt: row.created_at ?? null,
          routeKind: row.route_kind ?? null,
          rawText: row.raw_text ?? null,
          finalText: row.text,
          stt: { provider: row.provider ?? null, model: row.model ?? null },
          stepsCaptured: Boolean(trace),
          route: trace?.route ?? null,
          context: trace?.context ?? null,
          steps: trace ? trace.steps : null,
        })
      );
    }
    return { lines, dictations: dictations.length, withSteps: stepsById.size };
  }

  return {
    currentOwner,

    /** Begins a run; for a retry from history pass the row's id. Null when signed state is unknown. */
    beginRun({ transcriptionId = null } = {}) {
      const owner = currentOwner();
      if (!owner) return null;
      return runs.begin(owner, { transcriptionId });
    },

    /** db-save-transcription: the row, plus its trace's steps in the same transaction. */
    saveTranscription(text, rawText, options = {}) {
      // Steps only ever come from a trace main validated, never from the caller.
      const { trace, steps: _ignored, ...rowOptions } = options || {};
      let steps = null;
      if (trace) {
        const run = runs.take(trace.runId);
        const verdict = stepsFor(run && run.transcriptionId === null ? run : null, trace, rawText);
        steps = verdict.steps;
        if (!steps) log("Dictation saved without steps", { reason: verdict.reason });
      }
      return db.saveTranscription(text, rawText, { ...rowOptions, steps });
    },

    /**
     * update-transcription-text after a retry from history: the row's text and
     * its steps are replaced together. A completion a newer retry overtook
     * changes nothing.
     */
    completeRetry(id, text, rawText, options = {}) {
      const trace = options?.trace;
      if (!trace) {
        db.updateTranscriptionText(id, text, rawText);
        return { success: true, stepsSaved: false };
      }
      const run = runs.take(trace.runId);
      if (run && (run.transcriptionId !== id || !runs.isCurrent(run))) {
        log("Stale retry completion dropped", { reason: "superseded" });
        return { success: false, stale: true };
      }
      const verdict = stepsFor(run, trace, rawText);
      if (!verdict.steps) log("Retry saved without steps", { reason: verdict.reason });
      // Null steps still replace: the old ones described text that is gone.
      db.updateTranscriptionText(id, text, rawText, { steps: verdict.steps });
      return { success: true, stepsSaved: Boolean(verdict.steps) };
    },

    /** The current owner's steps for one history row. */
    getSteps(id) {
      const owner = currentOwner();
      if (!owner || !Number.isInteger(id)) return { status: "none", steps: [] };
      const result = db.getTranscriptionSteps(id, owner);
      return {
        status: result.status,
        route: result.route ?? null,
        context: result.context ?? null,
        steps: (result.rows || []).map((row) => stepFromRow(row, { includePromptText: true })),
      };
    },

    /**
     * The JSON Lines export of every history row, with the owner's steps and
     * the prompts they reference. Rows are device-wide, as History shows
     * them; steps and prompts never cross owners.
     */
    buildExport,

    /**
     * Export my dictations. `choosePath` shows main's warning and Save dialog
     * and resolves the chosen path or null. Ownership is captured before the
     * dialog and re-checked after it closes.
     */
    async exportDictations({ choosePath, writeFile, now }) {
      const owner = currentOwner();
      if (!owner) return { success: false, code: "OWNER_UNKNOWN" };
      const filePath = await choosePath();
      if (!filePath) return { success: false, canceled: true };
      if (currentOwner() !== owner) return { success: false, code: "ACCOUNT_CHANGED" };
      const { lines, dictations, withSteps } = buildExport(owner, { now });
      await writeFile(filePath, `${lines.join("\n")}\n`);
      log("Dictations exported", { dictations, withSteps });
      return { success: true, dictations, withSteps };
    },
  };
}

module.exports = {
  ACCOUNT_OWNER_PREFIX,
  EXPORT_FORMAT,
  SIGNED_OUT_OWNER,
  STEP_KINDS,
  TRACE_VERSION,
  createStepHistory,
  createStepRunRegistry,
  hashPrompt,
  normalizeTrace,
  ownerKeyFor,
};
