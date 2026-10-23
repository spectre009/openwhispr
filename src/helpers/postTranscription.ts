// The post-speech-to-text boundary: the one place a dictation's transcript
// turns into the text that is pasted. Every ordinary dictation path calls
// runPostTranscription exactly once per recording: batch (local, BYOK, the
// proxied providers, OpenWhispr Cloud), realtime streaming, the
// streaming→batch fallback (which reuses the batch result rather than running
// again), retry from history, and the source side of translation recordings.
// Meetings, note uploads, the CLI's raw transcribe endpoint and the shared
// speech-to-text engines never call it; the live preview stays raw.
//
// Contract (later stages depend on it):
//
//   runPostTranscription(rawText, {
//     context:  { targetApp, voiceAgentRequested, translationRequested },  // frozen per recording
//     glossary: { revision, rules },          // one snapshot for the whole dictation
//     snippets,                               // trigger spans win over glossary replacements
//     stt:      { provider, model, ms },      // what produced rawText
//     detectWakeWord(rawText) -> boolean,     // intent, read from the RAW text
//     run({ rawText, workingText, recordStep, setRoute }) -> string,
//     finalize(text) -> string,               // Chinese script conversion
//     wasCancelled() -> boolean,
//   }) -> Promise<{ text, trace }>
//
//   1. Intent is resolved from the raw transcript, whether or not any model is
//      reachable. `run` must route on `rawText` (wake word, voice assistant,
//      translation, selection edits) and execute on `workingText`.
//   2. The glossary is applied once, to a separate working text.
//   3. `run` performs cleanup, translation or the agent on the working text.
//      A failure keeps the working text: the corrected text is the floor.
//      `run` records each model call with recordStep(kind, meta, fn), where
//      fn(dispatched) reports the provider/model actually dispatched.
//   4. Chinese-script finalization runs last.
//
// Trace shape (PostTranscriptionTrace below; version 1):
//
//   { version: 1,
//     rawText,                      // the chosen uncorrected transcript
//     workingText,                  // after the glossary: what models saw
//     finalText,                    // what is pasted (null until done)
//     context: { targetApp: string | null,
//                intents: { voiceAgent, translation, wakeWord } },
//     route: "cleanup" | "translation" | "agent" | "skip" | "none" | null,
//     glossary: { revision: number | null,
//                 rulesFired: [{ ruleId, spelling, scope, from, to, index }] },
//     steps: [{ kind: "stt" | "glossary" | "cleanup" | "translation" | "agent" | "finalize",
//               outcome: "ok" | "failed" | "skipped" | "fallback",
//               output: string | null, provider: string | null, model: string | null,
//               ms: number | null, errorCode?: string,
//               prompt?: { source: "resolved", text, entryId? }    // model steps, when known
//                      | { source: "server", entryId? },
//               detail?: { snippets: true } }],               // in execution order
//     runId?: string }   // main's step-history run (ownership), set before saving
//
// `provider`/`model` on model steps are what was actually dispatched
// (ReasoningConfig.onDispatch), not settings re-read afterwards. `prompt` is
// the system prompt as sent, reported by the same hook: "resolved" carries the
// exact text after substitutions, the language instruction and the dictionary
// suffix; "server" means OpenWhispr Cloud built it on its server, so it is not
// available and never reconstructed. Later stages add step kinds (Stage 3:
// "style") and pass `glossary: null` to skip it. Optional fields are only
// present when known, so version 1 readers keep working.
//
// The trace (PostTranscriptionTrace below) is carried on the result object,
// never kept on a shared manager. It holds dictated text and prompts: main
// persists it as step history (helpers/stepHistory.js) but it must never be
// logged. Log rule ids and counts only (summarizeGlossaryTrace).

import { applyGlossary, type GlossaryFiredRule, type GlossarySnapshot } from "../utils/glossary";
import type { Snippet } from "../utils/snippets";
import type { DispatchedPrompt } from "../services/BaseReasoningService";
import { hasTextContent } from "./translationChain";

export const POST_TRANSCRIPTION_TRACE_VERSION = 1;

export type TraceStepKind = "stt" | "glossary" | "cleanup" | "translation" | "agent" | "finalize";
export type TraceStepOutcome = "ok" | "failed" | "skipped" | "fallback";
/** "none": no model was reachable, or reasoning was off. Null: never routed. */
export type TraceRoute = "cleanup" | "translation" | "agent" | "skip" | "none" | null;

/** The system prompt a model step ran with; see the contract above. Never log `text`. */
export type TracePromptRef = DispatchedPrompt;

/** OpenWhispr Cloud cleanup: the server builds the prompt, so none is recorded. */
export const SERVER_PROMPT_REF: TracePromptRef = Object.freeze({ source: "server" as const });

export interface TraceStep {
  kind: TraceStepKind;
  outcome: TraceStepOutcome;
  /** The step's output text; null when it produced none (e.g. it failed). */
  output: string | null;
  /** What was actually dispatched; null when nothing was (or it is unknown). */
  provider: string | null;
  model: string | null;
  ms: number | null;
  errorCode?: string;
  /** Model steps: the system prompt as sent. Absent when unknown. */
  prompt?: TracePromptRef;
  /** Kind-specific extras, e.g. `{ snippets: true }` on a finalize step. */
  detail?: { snippets?: boolean };
}

export interface PostTranscriptionContext {
  /** The recording's target app (exe name), frozen at recording start; null when unknown. */
  targetApp?: string | null;
  voiceAgentRequested?: boolean;
  translationRequested?: boolean;
}

export interface PostTranscriptionTrace {
  version: typeof POST_TRANSCRIPTION_TRACE_VERSION;
  rawText: string;
  /** The raw text after the glossary: what cleanup, translation or the agent saw. */
  workingText: string;
  finalText: string | null;
  context: {
    targetApp: string | null;
    intents: { voiceAgent: boolean; translation: boolean; wakeWord: boolean };
  };
  route: TraceRoute;
  glossary: { revision: number | null; rulesFired: GlossaryFiredRule[] };
  steps: TraceStep[];
  /**
   * The main-process step-history run this dictation belongs to, begun when the
   * recording (or retry) started. Main checks ownership with it before it
   * saves the steps; it says nothing about the dictation itself.
   */
  runId?: string;
}

export interface DispatchInfo {
  provider?: string | null;
  model?: string | null;
  prompt?: TracePromptRef | null;
}

function isPromptRef(value: unknown): value is TracePromptRef {
  const ref = value as TracePromptRef | null;
  if (!ref || typeof ref !== "object") return false;
  if (ref.source === "server") return true;
  return ref.source === "resolved" && typeof ref.text === "string";
}

export type RecordStep = <T>(
  kind: TraceStepKind,
  meta: DispatchInfo,
  fn: (dispatched: (info: DispatchInfo) => void) => Promise<T>
) => Promise<T>;

export interface PostTranscriptionRunArgs {
  /** The uncorrected transcript: route on this. */
  rawText: string;
  /** The glossary-corrected transcript: send this to models. */
  workingText: string;
  recordStep: RecordStep;
  setRoute: (kind: TraceRoute | string) => void;
}

export interface PostTranscriptionOptions {
  context?: PostTranscriptionContext;
  glossary?: GlossarySnapshot | null;
  snippets?: Snippet[] | null;
  stt?: { provider?: string | null; model?: string | null; ms?: number | null } | null;
  detectWakeWord?: ((rawText: string) => boolean) | null;
  run?: ((args: PostTranscriptionRunArgs) => Promise<string | null | undefined>) | null;
  finalize?: ((text: string) => string | Promise<string>) | null;
  wasCancelled?: () => boolean;
  now?: () => number;
}

export interface PostTranscriptionResult {
  text: string;
  trace: PostTranscriptionTrace;
}

const defaultNow = () =>
  typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now();

/** For runners called outside the boundary (tests, direct calls): runs fn untraced. */
export const passthroughStep: RecordStep = (_kind, _meta, fn) => fn(() => {});

function errorCodeOf(error: unknown): string {
  const e = error as { code?: unknown; messageKey?: unknown; name?: unknown } | null;
  const code = e?.code || e?.messageKey || e?.name;
  return typeof code === "string" && code ? code : "ERROR";
}

function createStepRecorder(trace: PostTranscriptionTrace, now: () => number): RecordStep {
  return async function recordStep(kind, meta, fn) {
    const step: TraceStep = {
      kind,
      outcome: "ok",
      output: null,
      provider: meta?.provider ?? null,
      model: meta?.model ?? null,
      ms: 0,
    };
    const metaPrompt = meta?.prompt;
    if (isPromptRef(metaPrompt)) step.prompt = metaPrompt;
    const dispatched = (info: DispatchInfo) => {
      if (!info || typeof info !== "object") return;
      if (info.provider) step.provider = String(info.provider);
      if (info.model) step.model = String(info.model);
      // A retried dispatch (e.g. a screenshot request rerun text-only) reports
      // the prompt it actually sent, which replaces the first one.
      const prompt = info.prompt;
      if (isPromptRef(prompt)) step.prompt = prompt;
    };
    const started = now();
    try {
      const output = await fn(dispatched);
      if (typeof output === "string") step.output = output;
      // A blank reply never replaces the text (#1616): the previous text stands.
      if (!hasTextContent(output)) step.outcome = "fallback";
      return output;
    } catch (error) {
      step.outcome = "failed";
      step.errorCode = errorCodeOf(error);
      throw error;
    } finally {
      step.ms = Math.round(now() - started);
      trace.steps.push(step);
    }
  };
}

/**
 * Turns one recording's chosen, uncorrected transcript into the final text.
 * See the contract above.
 */
export async function runPostTranscription(
  rawInput: string,
  {
    context = {},
    glossary = null,
    snippets = null,
    stt = null,
    detectWakeWord = null,
    run = null,
    finalize = null,
    wasCancelled = () => false,
    now = defaultNow,
  }: PostTranscriptionOptions = {}
): Promise<PostTranscriptionResult> {
  const rawText = typeof rawInput === "string" ? rawInput : "";
  const targetApp =
    typeof context.targetApp === "string" && context.targetApp.trim()
      ? context.targetApp.trim()
      : null;
  const intents = {
    voiceAgent: !!context.voiceAgentRequested,
    translation: !!context.translationRequested,
    wakeWord: false,
  };
  const trace: PostTranscriptionTrace = {
    version: POST_TRANSCRIPTION_TRACE_VERSION,
    rawText,
    workingText: rawText,
    finalText: null,
    context: { targetApp, intents },
    route: null,
    glossary: {
      revision: Number.isFinite(glossary?.revision)
        ? (glossary as GlossarySnapshot).revision
        : null,
      rulesFired: [],
    },
    steps: [
      {
        kind: "stt",
        outcome: "ok",
        output: rawText,
        provider: stt?.provider ?? null,
        model: stt?.model ?? null,
        ms: Number.isFinite(stt?.ms) ? Math.round(stt?.ms as number) : null,
      },
    ],
  };

  // 1. Intent comes from what was said, before anything rewrites it. A
  // translation recording ignores the wake word, as routing does.
  if (!intents.translation && typeof detectWakeWord === "function" && hasTextContent(rawText)) {
    try {
      intents.wakeWord = !!detectWakeWord(rawText);
    } catch {
      intents.wakeWord = false;
    }
  }

  // 2. The glossary, once, to a separate working text.
  const rules = Array.isArray(glossary?.rules) ? glossary.rules : [];
  let workingText = rawText;
  const glossaryStart = now();
  if (rules.length > 0 && hasTextContent(rawText)) {
    const corrected = applyGlossary(rawText, rules, { targetApp, snippets });
    workingText = corrected.text;
    trace.glossary.rulesFired = corrected.fired;
    trace.steps.push({
      kind: "glossary",
      outcome: "ok",
      output: workingText,
      provider: null,
      model: null,
      ms: Math.round(now() - glossaryStart),
    });
  } else {
    trace.steps.push({
      kind: "glossary",
      outcome: "skipped",
      output: rawText,
      provider: null,
      model: null,
      ms: 0,
    });
  }
  trace.workingText = workingText;

  // 3. Cleanup, translation or the agent, on the working text.
  let text = workingText;
  if (typeof run === "function") {
    const ran = await run({
      rawText,
      workingText,
      recordStep: createStepRecorder(trace, now),
      setRoute: (kind) => {
        trace.route = typeof kind === "string" ? (kind as TraceRoute) : null;
      },
    });
    if (typeof ran === "string") text = ran;
  }

  if (wasCancelled()) {
    trace.finalText = text;
    return { text, trace };
  }

  // 4. Chinese script last, over whatever is pasted.
  if (typeof finalize === "function") {
    const finalizeStart = now();
    try {
      const finalized = await finalize(text);
      if (typeof finalized === "string") text = finalized;
      trace.steps.push({
        kind: "finalize",
        outcome: "ok",
        output: text,
        provider: null,
        model: null,
        ms: Math.round(now() - finalizeStart),
      });
    } catch (error) {
      // A failed conversion keeps the text as it is, as dictation always has.
      trace.steps.push({
        kind: "finalize",
        outcome: "failed",
        output: text,
        provider: null,
        model: null,
        ms: Math.round(now() - finalizeStart),
        errorCode: errorCodeOf(error),
      });
    }
  }

  trace.finalText = text;
  return { text, trace };
}

/**
 * The text pasted can differ from the boundary's final text: snippets expand
 * after it, in the dictation hook. Records that as a last finalize step so the
 * trace ends with what was pasted. Returns the trace unchanged otherwise.
 */
export function recordPastedText<T extends PostTranscriptionTrace | null | undefined>(
  trace: T,
  pastedText: string
): T {
  if (!trace || typeof pastedText !== "string" || pastedText === trace.finalText) return trace;
  return {
    ...trace,
    finalText: pastedText,
    steps: [
      ...trace.steps,
      {
        kind: "finalize",
        outcome: "ok",
        output: pastedText,
        provider: null,
        model: null,
        ms: 0,
        detail: { snippets: true },
      },
    ],
  };
}

/** Log-safe summary of what the glossary did: ids and counts, never text. */
export function summarizeGlossaryTrace(trace: PostTranscriptionTrace | null | undefined) {
  const fired = Array.isArray(trace?.glossary?.rulesFired) ? trace.glossary.rulesFired : [];
  return {
    revision: trace?.glossary?.revision ?? null,
    fired: fired.length,
    ruleIds: [...new Set(fired.map((f) => f.ruleId))],
    scopes: [...new Set(fired.map((f) => f.scope))],
    targetAppKnown: !!trace?.context?.targetApp,
  };
}
