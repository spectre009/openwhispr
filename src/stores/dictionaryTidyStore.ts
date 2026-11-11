import { create } from "zustand";
import logger from "../utils/logger";
import { dictionaryWordKey } from "../utils/dictionaryWordKey.js";
import { subscribeListsOwner, useSettingsStore } from "./settingsStore";
import { useDictionarySourcesStore } from "./dictionarySourcesStore";
import { dictionaryRevision, parseDictionaryReviewReply } from "../utils/dictionaryReview";
import type { ReviewRequest, ReviewSuggestion } from "../utils/dictionaryReview";
import type { TidyAggregates } from "../utils/dictionaryTidy";
import { loadCommonWordList } from "../utils/commonWords";
import {
  cancelDictionaryReview,
  runDictionaryReview,
  type ProcessText,
  type ReviewModelOption,
} from "../services/dictionaryReview";
import type {
  DictionaryTidyInputsResult,
  DictionaryTidyOp,
  DictionaryTidyOpResult,
  DictionaryTidyUndoStep,
} from "../types/electron";

// Tidy up's state in this window: main's History aggregates for the checks
// (words and counts, refreshed when the dictionary or History changes), the
// bundled common-word list (loaded on first use), the session's Undo stack
// (kept until the app restarts), the items the user chose to keep, and the
// model review. Every change goes through main (settingsStore's
// applyDictionaryTidy / undoDictionaryTidy); nothing here is logged but counts
// and codes.

const REFRESH_DEBOUNCE_MS = 5_000;

export interface TidySummary {
  removed: number;
  merged: number;
  changed: number;
  added: number;
  kept: number;
  failed: number;
  /** Words left as they were because the batch's choices for them conflicted (planTidyBatch). */
  skipped: number;
}

export interface TidyUndoEntry {
  id: number;
  steps: DictionaryTidyUndoStep[];
  summary: TidySummary;
  /** It merged words: Undo can't bring back what they replaced. */
  merged: boolean;
}

export interface TidyRefusal {
  code: string;
  word?: string;
  existing?: string;
}

export type TidyReviewState =
  | { status: "idle" }
  | { status: "running"; optionId: string; modelName: string; requestId: string }
  | {
      status: "done";
      optionId: string;
      modelName: string;
      suggestions: ReviewSuggestion[];
      kept: number;
      dropped: number;
    }
  | {
      status: "dropped";
      reason: "stale" | "malformed" | "oversized";
      modelName: string;
      dropped: number;
    }
  | { status: "error"; modelName: string; error: unknown };

interface DictionaryTidyState {
  inputsStatus: "idle" | "ready" | "unavailable";
  inputsReason: string | null;
  aggregates: TidyAggregates | null;
  days: number;
  /** The bundled common-word list; null until loaded. */
  commonWords: ReadonlySet<string> | null;
  undo: TidyUndoEntry[];
  /** An apply or Undo in flight. */
  busy: boolean;
  /** What the last apply did. */
  summary: TidySummary | null;
  /** Why the last Undo was refused. */
  refusal: TidyRefusal | null;
  /** Items the user chose Keep for, this session. */
  kept: ReadonlySet<string>;
  keptSinceSummary: number;
  review: TidyReviewState;
}

export const useDictionaryTidyStore = create<DictionaryTidyState>()(() => ({
  inputsStatus: "idle",
  inputsReason: null,
  aggregates: null,
  days: 0,
  commonWords: null,
  undo: [],
  busy: false,
  summary: null,
  refusal: null,
  kept: new Set<string>(),
  keptSinceSummary: 0,
  review: { status: "idle" },
}));

const getState = () => useDictionaryTidyStore.getState();
const setState = (partial: Partial<DictionaryTidyState>) =>
  useDictionaryTidyStore.setState(partial);

// ─── History's aggregates ───

function applyInputs(result: DictionaryTidyInputsResult | null | undefined): void {
  if (!result || result.available !== true) {
    setState({
      inputsStatus: "unavailable",
      inputsReason: (result && "reason" in result && result.reason) || null,
      aggregates: null,
      days: 0,
    });
    return;
  }
  setState({
    inputsStatus: "ready",
    inputsReason: null,
    aggregates: {
      frequentTokens: Array.isArray(result.frequentTokens) ? result.frequentTokens : [],
      adjacency: Array.isArray(result.adjacency) ? result.adjacency : [],
    },
    days: result.days,
  });
}

let inFlight: Promise<void> | null = null;
let rerun = false;

/** Asks main for the aggregates; calls during a read coalesce into one more read. */
export function refreshTidyInputs(): Promise<void> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.getDictionaryTidyInputs) {
    if (getState().inputsStatus === "idle") applyInputs(null);
    return Promise.resolve();
  }
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      rerun = false;
      try {
        applyInputs(await api.getDictionaryTidyInputs!());
      } catch (error) {
        logger.warn(
          "Couldn't read Tidy up inputs",
          { error: (error as Error)?.message },
          "settings"
        );
        applyInputs(null);
      }
    } while (rerun);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleTidyInputsRefresh(delayMs = REFRESH_DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void refreshTidyInputs();
  }, delayMs);
}

let subscribed = false;

/** Reads the aggregates now, and again when the dictionary or History changes. */
export function syncDictionaryTidy(): void {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!subscribed && api) {
    subscribed = true;
    api.onDictionaryUpdated?.(() => scheduleTidyInputsRefresh(500));
    const later = () => scheduleTidyInputsRefresh();
    api.onTranscriptionAdded?.(later);
    api.onTranscriptionUpdated?.(later);
    api.onTranscriptionDeleted?.(later);
    api.onTranscriptionsCleared?.(later);
  }
  void refreshTidyInputs();
  void loadCommonWords();
}

// ─── The common-word list (SCOWL, src/config/commonEnglishWords.json) ───

let commonWordsLoad: Promise<void> | null = null;

/** Loads the bundled common-word list once (shared, utils/commonWords); an empty set if it can't be read. */
export function loadCommonWords(): Promise<void> {
  if (commonWordsLoad) return commonWordsLoad;
  commonWordsLoad = loadCommonWordList().then((words) => {
    if (!words) logger.warn("Couldn't load the common-word list");
    setState({ commonWords: words ?? new Set<string>() });
  });
  return commonWordsLoad;
}

// ─── Applying, and Undo ───

let nextUndoId = 1;
// Bumped when the personal lists start belonging to another account: Undo
// steps, kept items and a model's suggestions were made on the previous
// account's list, and main writes an Undo into the active account's.
let session = 0;

/** Starts Tidy up's session over: no Undo, summary, kept items or model review. */
export function resetTidySession(): void {
  session += 1;
  cancelModelReview();
  setState({
    undo: [],
    summary: null,
    refusal: null,
    kept: new Set<string>(),
    keptSinceSummary: 0,
    review: { status: "idle" },
  });
}

// A settings store without account scoping (a test's stand-in) has no owner to follow.
if (typeof subscribeListsOwner === "function") subscribeListsOwner(resetTidySession);

// What main applied, by what it did, whatever kind of choice asked for it: a
// respell that folded into an existing word is a merge, a removal a removal.
function summarize(
  results: readonly DictionaryTidyOpResult[],
  kept: number,
  skipped = 0
): TidySummary {
  const summary: TidySummary = {
    removed: 0,
    merged: 0,
    changed: 0,
    added: 0,
    kept,
    failed: 0,
    skipped,
  };
  for (const result of results) {
    if (!result.ok) {
      summary.failed += 1;
      continue;
    }
    summary.removed += result.removed ?? 0;
    summary.merged += result.merged ?? 0;
    summary.changed += result.renamed ?? 0;
    summary.added += result.added ?? 0;
  }
  return summary;
}

export interface ApplyTidyOptions {
  /** Words planTidyBatch left out as conflicting choices: the summary says so. */
  skipped?: number;
}

/**
 * Applies Tidy up's choices in one batch through main (the page plans it
 * first with planTidyBatch). Each applied choice's Undo steps go on the stack
 * as one entry. Resolves what happened, or null while another change is in
 * flight. A batch whose every choice conflicted sends nothing and says so.
 */
export async function applyTidy(
  ops: readonly DictionaryTidyOp[],
  { skipped = 0 }: ApplyTidyOptions = {}
): Promise<TidySummary | null> {
  if (getState().busy) return null;
  if (ops.length === 0) {
    if (skipped <= 0) return null;
    const summary = summarize([], getState().keptSinceSummary, skipped);
    setState({ summary, refusal: null, keptSinceSummary: 0 });
    logger.debug("Tidy up not applied", { ops: 0, skipped }, "settings");
    return summary;
  }
  setState({ busy: true, refusal: null });
  const startedIn = session;
  try {
    const result = await useSettingsStore.getState().applyDictionaryTidy([...ops]);
    // The lists changed hands meanwhile: nothing here is this session's.
    if (startedIn !== session) return null;
    const kept = getState().keptSinceSummary;
    if (result.success === false) {
      const summary = { ...summarize([], kept, skipped), failed: ops.length };
      setState({ summary });
      logger.warn("Tidy up not applied", { code: result.code, ops: ops.length }, "settings");
      return summary;
    }
    const summary = summarize(result.results, kept, skipped);
    const steps = result.results.flatMap((entry) => (entry.ok ? (entry.undo ?? []) : []));
    const undo =
      steps.length > 0
        ? [
            ...getState().undo,
            {
              id: nextUndoId++,
              steps,
              summary,
              merged: result.results.some((entry) => entry.ok && (entry.merged ?? 0) > 0),
            },
          ]
        : getState().undo;
    setState({ summary, undo, keptSinceSummary: 0 });
    logger.debug(
      "Tidy up applied",
      {
        ops: ops.length,
        removed: summary.removed,
        merged: summary.merged,
        changed: summary.changed,
        added: summary.added,
        failed: summary.failed,
        skipped: summary.skipped,
      },
      "settings"
    );
    return summary;
  } catch (error) {
    logger.warn("Tidy up not applied", { error: (error as Error)?.message }, "settings");
    if (startedIn !== session) return null;
    const summary = {
      ...summarize([], getState().keptSinceSummary, skipped),
      failed: ops.length,
    };
    setState({ summary });
    return summary;
  } finally {
    setState({ busy: false });
  }
}

/** Reverses the last action. Resolves whether it was undone; a refusal is kept with its reason. */
export async function undoLastTidy(): Promise<boolean> {
  const { undo, busy } = getState();
  const entry = undo.at(-1);
  if (!entry || busy) return false;
  setState({ busy: true, refusal: null });
  const startedIn = session;
  try {
    const result = await useSettingsStore.getState().undoDictionaryTidy(entry.steps);
    if (startedIn !== session) return false;
    if (result.success === true) {
      setState({
        undo: getState().undo.filter((candidate) => candidate.id !== entry.id),
        summary: null,
      });
      return true;
    }
    const refused = result as Extract<typeof result, { success: false }>;
    setState({
      refusal: {
        code: refused.code,
        ...(refused.word ? { word: refused.word } : {}),
        ...(refused.existing ? { existing: refused.existing } : {}),
      },
    });
    logger.debug("Tidy up undo refused", { code: refused.code }, "settings");
    return false;
  } catch (error) {
    logger.warn("Tidy up undo failed", { error: (error as Error)?.message }, "settings");
    if (startedIn !== session) return false;
    setState({ refusal: { code: "FAILED" } });
    return false;
  } finally {
    setState({ busy: false });
  }
}

/** Reverses every action, newest first, stopping at the first refusal. Resolves how many. */
export async function undoAllTidy(): Promise<number> {
  let undone = 0;
  while (getState().undo.length > 0) {
    if (!(await undoLastTidy())) break;
    undone += 1;
  }
  return undone;
}

/** "Keep": the item leaves Tidy up for this session; nothing changes. */
export function keepTidyItem(id: string): void {
  const { kept, keptSinceSummary } = getState();
  if (kept.has(id)) return;
  setState({ kept: new Set([...kept, id]), keptSinceSummary: keptSinceSummary + 1 });
}

/** Brings back the items kept this session. */
export function restoreKeptTidyItems(): void {
  setState({ kept: new Set<string>(), keptSinceSummary: 0 });
}

// ─── Ask a model ───

/** The dictionary as the review compares it: each word with its source and pin. */
export function currentDictionaryRevision(): string {
  const words = useSettingsStore.getState().customDictionary;
  const { entries, pinned } = useDictionarySourcesStore.getState();
  const sources = new Map(entries.map((entry) => [entry.word, entry.source]));
  return dictionaryRevision(
    words.map((word) => ({
      word,
      source: sources.get(word) ?? "manual",
      pinned: pinned.has(dictionaryWordKey(word)),
    }))
  );
}

let reviewGeneration = 0;

export interface AskModelParams {
  option: ReviewModelOption;
  request: ReviewRequest;
  /** Keys of glossary spellings and snippet triggers: a suggestion may not remove them. */
  protectedKeys: ReadonlySet<string>;
  /** The call that sends it (tests); ReasoningService.processText by default. */
  process?: ProcessText;
}

/**
 * Sends the review. Its reply is dropped when the dictionary changed while it
 * ran (the revision taken now), when it's malformed or oversized, or when it
 * was cancelled; otherwise its suggestions, validated, become a group.
 */
export async function askModelReview({
  option,
  request,
  protectedKeys,
  process,
}: AskModelParams): Promise<void> {
  cancelModelReview();
  const generation = ++reviewGeneration;
  const requestId = `dictionary-review-${Date.now()}-${generation}`;
  const revision = currentDictionaryRevision();
  const modelName = option.modelName;
  setState({ review: { status: "running", optionId: option.id, modelName, requestId } });
  try {
    const reply = await runDictionaryReview(option, request, {
      requestId,
      ...(process ? { process } : {}),
    });
    if (generation !== reviewGeneration) return;
    if (currentDictionaryRevision() !== revision) {
      setState({ review: { status: "dropped", reason: "stale", modelName, dropped: 0 } });
      logger.debug("Dictionary review dropped", { reason: "stale" }, "settings");
      return;
    }
    const parsed = parseDictionaryReviewReply(reply, { words: request.words, protectedKeys });
    if (parsed.status !== "ok") {
      setState({
        review: { status: "dropped", reason: parsed.status, modelName, dropped: parsed.dropped },
      });
    } else {
      setState({
        review: {
          status: "done",
          optionId: option.id,
          modelName,
          suggestions: parsed.suggestions,
          kept: parsed.kept,
          dropped: parsed.dropped,
        },
      });
    }
    logger.debug(
      "Dictionary review finished",
      { status: parsed.status, kept: parsed.kept, dropped: parsed.dropped },
      "settings"
    );
  } catch (error) {
    if (generation !== reviewGeneration) return;
    setState({ review: { status: "error", modelName, error } });
    const failure = error as { code?: string; messageKey?: string };
    logger.warn(
      "Dictionary review failed",
      { code: failure?.code ?? null, messageKey: failure?.messageKey ?? null },
      "settings"
    );
  }
}

/** Stops waiting for a review: a local model's request is aborted, any other reply is discarded. */
export function cancelModelReview(): void {
  const { review } = getState();
  reviewGeneration += 1;
  if (review.status === "running") {
    cancelDictionaryReview(review.requestId);
    setState({ review: { status: "idle" } });
  }
}

/** Forgets the review's result. */
export function clearModelReview(): void {
  cancelModelReview();
  setState({ review: { status: "idle" } });
}
