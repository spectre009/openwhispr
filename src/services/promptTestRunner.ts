// Prompt Studio's test set runner: every case through prompt A (the one in
// use) and prompt B (the selected prompt or its unsaved draft), 1–3 times
// each, one request at a time. Pure apart from the injected `deps`, so it is
// tested without a provider or a window.
//
// - Inputs go through the glossary like a real dictation's: one frozen
//   snapshot for the whole run, the case's target app deciding the app-scoped
//   rules (none: only "anywhere" rules, like an unknown app).
// - Dictation comes first: before every request the run waits while a
//   dictation is underway (and for its paste). A local-model request a
//   dictation aborted (YIELDED_TO_DICTATION) is sent again afterwards; it is
//   not an outcome.
// - Every request ends as completed, error, cancelled (Stop, account change)
//   or skipped (the run stopped itself). An authentication, quota or
//   configuration failure stops the run; rate-limit waits are bounded; three
//   errors in a row stop it too.
// - Checks: promptTestChecks. An empty reply or a request error is an error
//   outcome, never a failed check. A reply the validator rejected as a
//   repeated transcript is a completed request whose repetition check failed.

import { applyGlossary, type GlossarySnapshot } from "../utils/glossary";
import type { Snippet } from "../utils/snippets";
import { hasTextContent } from "../helpers/translationChain";
import {
  checkOutput,
  repeatedTranscriptChecks,
  type CaseChecks,
  type OutputChecks,
} from "../utils/promptTestChecks";

// The keys every provider attaches to an empty or cut-off cleanup reply
// (EMPTY_OUTPUT_MESSAGE_KEY / TRUNCATED_OUTPUT_MESSAGE_KEY in
// ai/chatRequestBody, and the same strings on main's side). Spelled out so
// this module stays free of the provider graph; a test keeps them equal.
export const EMPTY_REPLY_MESSAGE_KEY = "hooks.audioRecording.errorDescriptions.cleanupEmptyReply";
export const TRUNCATED_REPLY_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.cleanupTruncated";

export const MAX_RUN_CASES = 50;
export const MAX_RUN_REQUESTS = 300;
export const REPETITION_CHOICES = [1, 2, 3] as const;
export const DEFAULT_REPETITIONS = 2;
/** Waits after a rate limit or a busy local model, then the run stops. */
export const RETRY_WAITS_MS = [5_000, 15_000, 30_000] as const;
export const MAX_CONSECUTIVE_ERRORS = 3;
/** A request a dictation keeps interrupting is given up after this many tries. */
export const MAX_YIELDS_PER_REQUEST = 20;
/** Measured warm, per request; the estimate says "about". */
export const ESTIMATED_SECONDS_PER_REQUEST = 1.5;

export type PromptSide = "A" | "B";
export const PROMPT_SIDES: readonly PromptSide[] = ["A", "B"];

export interface RunCase extends CaseChecks {
  id: string;
  label: string;
  rawText: string;
  targetApp: string | null;
  referenceText: string | null;
  source: "history" | "test" | "starter";
  sourceTranscriptionId: number | null;
}

export interface CaseInput {
  raw: string;
  /** What was sent: the raw text after the run's glossary snapshot. */
  corrected: string;
  rulesFired: number;
  targetApp: string | null;
}

export type RequestStatus = "completed" | "error" | "cancelled" | "skipped";

export interface RequestOutcome {
  status: RequestStatus;
  /** Completed: the reply; null when the validator rejected it as a repeated transcript. */
  output?: string | null;
  rejected?: "repeated";
  ms?: number;
  checks?: OutputChecks;
  /** Error: a code ("EMPTY_REPLY", "TRUNCATED" or the provider's) and its wording. */
  code?: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  message?: string;
}

export interface CaseResult {
  caseId: string;
  label: string;
  source: RunCase["source"];
  sourceTranscriptionId: number | null;
  referenceText: string | null;
  checks: CaseChecks;
  input: CaseInput;
  runs: Record<PromptSide, RequestOutcome[]>;
}

export type StopReason =
  "user" | "account" | "auth" | "quota" | "config" | "rateLimit" | "errors" | "settings";

export interface RunProgress {
  phase: "running" | "pausedForDictation" | "waiting" | "finished";
  total: number;
  /** Requests with an outcome. */
  done: number;
  stopReason: StopReason | null;
  results: CaseResult[];
}

export interface RunPlan {
  cases: RunCase[];
  repetitions: number;
  glossary: GlossarySnapshot;
  snippets: Snippet[] | null;
}

export interface RunDeps {
  /** Sends one cleanup request with prompt A or B; resolves to the reply. */
  send: (side: PromptSide, text: string, requestId: string) => Promise<string>;
  /** Resolves once no dictation is underway (and its paste is done), or on abort. */
  waitForDictation: (signal: AbortSignal, onPause: () => void) => Promise<void>;
  /** Resolves after `ms`, or on abort. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  newRequestId: () => string;
  /** False once where requests go has changed in a way the run couldn't pin. */
  routeUnchanged?: () => boolean;
  /** Aborts an in-flight request (the local model) when the run is stopped. */
  cancelRequest?: (requestId: string) => void;
  onUpdate?: (progress: RunProgress) => void;
}

const AUTH_CODES = new Set([
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_ACCESS_DENIED",
  "API_KEY_MISSING",
  "INVALID_KEY",
  "AUTH_EXPIRED",
]);
const QUOTA_CODES = new Set(["PROVIDER_QUOTA_EXHAUSTED", "LIMIT_REACHED"]);
const CONFIG_CODES = new Set([
  "PROVIDER_MODEL_NOT_FOUND",
  "MODEL_NOT_AVAILABLE",
  "MODEL_NOT_DOWNLOADED",
  "CUSTOM_ENDPOINT_INVALID",
  "LLAMASERVER_NOT_FOUND",
  "LOCAL_SERVER_UNAVAILABLE",
  "COPILOT_SCOPE_REFUSED",
]);

export type RunErrorKind =
  | "yielded"
  | "repeated"
  | "rateLimited"
  | "busy"
  | "auth"
  | "quota"
  | "config"
  | "empty"
  | "truncated"
  | "error";

/** What a failed request means for the run. */
export function classifyRunError(error: unknown): RunErrorKind {
  const { code, messageKey } = (error ?? {}) as { code?: string; messageKey?: string };
  if (code === "YIELDED_TO_DICTATION") return "yielded";
  if (code === "CLEANUP_OUTPUT_INVALID") return "repeated";
  if (code === "PROVIDER_RATE_LIMITED") return "rateLimited";
  if (code === "LOCAL_MODEL_BUSY") return "busy";
  if (code && AUTH_CODES.has(code)) return "auth";
  if (code && QUOTA_CODES.has(code)) return "quota";
  if (code && CONFIG_CODES.has(code)) return "config";
  if (messageKey === EMPTY_REPLY_MESSAGE_KEY) return "empty";
  if (messageKey === TRUNCATED_REPLY_MESSAGE_KEY) return "truncated";
  return "error";
}

function errorOutcome(error: unknown, kind: RunErrorKind, ms: number): RequestOutcome {
  const source = (error ?? {}) as {
    code?: string;
    messageKey?: string;
    messageParams?: Record<string, string | number>;
    message?: string;
  };
  const code =
    kind === "empty" ? "EMPTY_REPLY" : kind === "truncated" ? "TRUNCATED" : source.code || "ERROR";
  return {
    status: "error",
    ms,
    code,
    ...(source.messageKey ? { messageKey: source.messageKey } : {}),
    ...(source.messageParams ? { messageParams: source.messageParams } : {}),
    ...(typeof source.message === "string" ? { message: source.message.slice(0, 300) } : {}),
  };
}

/** The input a case sends: its raw text through the run's glossary snapshot. */
export function correctCaseInput(
  testCase: Pick<RunCase, "rawText" | "targetApp">,
  glossary: GlossarySnapshot | null,
  snippets: Snippet[] | null
): CaseInput {
  const raw = testCase.rawText;
  const rules = Array.isArray(glossary?.rules) ? glossary.rules : [];
  if (rules.length === 0 || !hasTextContent(raw)) {
    return { raw, corrected: raw, rulesFired: 0, targetApp: testCase.targetApp ?? null };
  }
  const corrected = applyGlossary(raw, rules, {
    targetApp: testCase.targetApp ?? null,
    snippets,
  });
  return {
    raw,
    corrected: corrected.text,
    rulesFired: corrected.fired.length,
    targetApp: testCase.targetApp ?? null,
  };
}

export function clampRepetitions(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_REPETITIONS;
  return Math.min(REPETITION_CHOICES[REPETITION_CHOICES.length - 1], Math.max(1, n));
}

/** Requests a run of `cases` cases sends: cases × 2 prompts × repetitions, capped. */
export function estimateRequests(cases: number, repetitions: number): number {
  const runCases = Math.min(Math.max(0, cases), MAX_RUN_CASES);
  return Math.min(runCases * PROMPT_SIDES.length * clampRepetitions(repetitions), MAX_RUN_REQUESTS);
}

const abortReason = (signal: AbortSignal): StopReason =>
  signal.reason === "account" ? "account" : "user";

/**
 * Runs the plan. Resolves with the final progress, partial when stopped;
 * `signal` stops it before the next request (reason "user" or "account").
 */
export async function runPromptTests(
  plan: RunPlan,
  deps: RunDeps,
  signal: AbortSignal
): Promise<RunProgress> {
  const repetitions = clampRepetitions(plan.repetitions);
  const cases = plan.cases.slice(0, MAX_RUN_CASES);
  const results: CaseResult[] = cases.map((testCase) => ({
    caseId: testCase.id,
    label: testCase.label,
    source: testCase.source,
    sourceTranscriptionId: testCase.sourceTranscriptionId,
    referenceText: testCase.referenceText,
    checks: {
      mustContain: [...testCase.mustContain],
      mustNotContain: [...testCase.mustNotContain],
      matchCase: testCase.matchCase,
    },
    input: correctCaseInput(testCase, plan.glossary, plan.snippets),
    runs: { A: [], B: [] },
  }));

  // A and B alternate within a case, so a stopped run still has pairs.
  const queue: Array<{ caseIndex: number; side: PromptSide }> = [];
  results.forEach((_result, caseIndex) => {
    for (let rep = 0; rep < repetitions; rep++) {
      for (const side of PROMPT_SIDES) queue.push({ caseIndex, side });
    }
  });
  queue.splice(MAX_RUN_REQUESTS);

  const progress: RunProgress = {
    phase: "running",
    total: queue.length,
    done: 0,
    stopReason: null,
    results,
  };
  // Each update is a snapshot, so a store can hand it to React as is.
  const emit = () => {
    try {
      deps.onUpdate?.({
        ...progress,
        results: progress.results.map((result) => ({
          ...result,
          runs: { A: [...result.runs.A], B: [...result.runs.B] },
        })),
      });
    } catch {
      // A display update must never stop the run.
    }
  };
  const setPhase = (phase: RunProgress["phase"]) => {
    if (progress.phase === phase) return;
    progress.phase = phase;
    emit();
  };

  let consecutiveErrors = 0;
  let next = 0;
  emit();

  for (; next < queue.length; next++) {
    if (progress.stopReason || signal.aborted) break;
    const { caseIndex, side } = queue[next];
    const result = results[caseIndex];
    let outcome: RequestOutcome | null = null;
    let yields = 0;
    let waits = 0;

    while (!outcome && !signal.aborted && !progress.stopReason) {
      await deps.waitForDictation(signal, () => setPhase("pausedForDictation"));
      if (signal.aborted) break;
      if (deps.routeUnchanged && !deps.routeUnchanged()) {
        progress.stopReason = "settings";
        break;
      }
      setPhase("running");

      const requestId = deps.newRequestId();
      const onAbort = () => deps.cancelRequest?.(requestId);
      signal.addEventListener("abort", onAbort);
      const started = deps.now();
      try {
        const reply = await deps.send(side, result.input.corrected, requestId);
        const ms = deps.now() - started;
        outcome =
          typeof reply === "string" && reply.trim()
            ? {
                status: "completed",
                output: reply,
                ms,
                checks: checkOutput(result.checks, result.input.corrected, reply),
              }
            : { status: "error", ms, code: "EMPTY_REPLY" };
      } catch (error) {
        const ms = deps.now() - started;
        const kind = classifyRunError(error);
        if (kind === "yielded" && yields < MAX_YIELDS_PER_REQUEST) {
          // A dictation took the local model; send this request again after it.
          yields += 1;
          continue;
        }
        if (signal.aborted) {
          outcome = { status: "cancelled" };
        } else if (kind === "repeated") {
          outcome = {
            status: "completed",
            output: null,
            rejected: "repeated",
            ms,
            checks: repeatedTranscriptChecks(result.checks),
          };
        } else if ((kind === "rateLimited" || kind === "busy") && waits < RETRY_WAITS_MS.length) {
          setPhase("waiting");
          await deps.sleep(RETRY_WAITS_MS[waits], signal);
          waits += 1;
          continue;
        } else {
          outcome = errorOutcome(error, kind, ms);
          if (kind === "auth" || kind === "quota" || kind === "config") {
            progress.stopReason = kind;
          } else if (kind === "rateLimited" || kind === "busy") {
            progress.stopReason = "rateLimit";
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (!outcome) break;
    result.runs[side].push(outcome);
    progress.done += 1;
    consecutiveErrors = outcome.status === "error" ? consecutiveErrors + 1 : 0;
    if (!progress.stopReason && consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      progress.stopReason = "errors";
    }
    emit();
  }

  // Everything that didn't run is recorded too, so partial totals are honest.
  const unrun: RequestStatus = signal.aborted ? "cancelled" : "skipped";
  for (; next < queue.length; next++) {
    const { caseIndex, side } = queue[next];
    results[caseIndex].runs[side].push({ status: unrun });
  }
  if (!progress.stopReason && signal.aborted) progress.stopReason = abortReason(signal);
  progress.phase = "finished";
  emit();
  return progress;
}

export interface SideSummary {
  /** Compared cases where every run of this prompt passed every check. */
  passed: number;
  /** Compared cases where a run of this prompt left a filler (advisory). */
  withFillers: number;
  medianMs: number | null;
}

export interface RunSummary {
  cases: number;
  /** Cases where every run of A and of B completed: the only ones counted below. */
  compared: number;
  /** Compared cases whose A and B replies differ. */
  differ: number;
  sides: Record<PromptSide, SideSummary>;
  requests: Record<RequestStatus, number>;
  /** Some request didn't complete, or the run stopped early. */
  partial: boolean;
}

const normalizeReply = (text: string | null | undefined) =>
  (text ?? "").replace(/\s+/g, " ").trim();

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Whether every run of both prompts completed for this case. */
export function isCompared(result: CaseResult): boolean {
  return PROMPT_SIDES.every(
    (side) =>
      result.runs[side].length > 0 && result.runs[side].every((run) => run.status === "completed")
  );
}

export function sidePassed(result: CaseResult, side: PromptSide): boolean {
  return result.runs[side].every((run) => run.status === "completed" && run.checks?.passed);
}

/** Whether A's and B's replies differ (as sets, ignoring whitespace). */
export function repliesDiffer(result: CaseResult): boolean {
  const replies = (side: PromptSide) =>
    new Set(
      result.runs[side].map((run) => (run.rejected ? "\u0000repeated" : normalizeReply(run.output)))
    );
  const a = replies("A");
  const b = replies("B");
  return a.size !== b.size || [...a].some((reply) => !b.has(reply));
}

/** Whether a case belongs under "differences and failures". */
export function needsAttention(result: CaseResult): boolean {
  if (!isCompared(result)) return true;
  if (repliesDiffer(result)) return true;
  return !sidePassed(result, "A") || !sidePassed(result, "B");
}

export function summarizeRun(results: CaseResult[], stopReason: StopReason | null): RunSummary {
  const requests: Record<RequestStatus, number> = {
    completed: 0,
    error: 0,
    cancelled: 0,
    skipped: 0,
  };
  const sides: Record<PromptSide, SideSummary> = {
    A: { passed: 0, withFillers: 0, medianMs: null },
    B: { passed: 0, withFillers: 0, medianMs: null },
  };
  const times: Record<PromptSide, number[]> = { A: [], B: [] };
  let compared = 0;
  let differ = 0;
  for (const result of results) {
    for (const side of PROMPT_SIDES) {
      for (const run of result.runs[side]) requests[run.status] += 1;
    }
    if (!isCompared(result)) continue;
    compared += 1;
    if (repliesDiffer(result)) differ += 1;
    for (const side of PROMPT_SIDES) {
      if (sidePassed(result, side)) sides[side].passed += 1;
      if (result.runs[side].some((run) => (run.checks?.fillers.length ?? 0) > 0)) {
        sides[side].withFillers += 1;
      }
      for (const run of result.runs[side]) {
        if (typeof run.ms === "number") times[side].push(run.ms);
      }
    }
  }
  for (const side of PROMPT_SIDES) sides[side].medianMs = median(times[side]);
  return {
    cases: results.length,
    compared,
    differ,
    sides,
    requests,
    partial: stopReason !== null || requests.completed < requestsTotal(requests),
  };
}

function requestsTotal(requests: Record<RequestStatus, number>): number {
  return requests.completed + requests.error + requests.cancelled + requests.skipped;
}
