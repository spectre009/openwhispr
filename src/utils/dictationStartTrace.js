import logger from "./logger";

// One dictation start, from the OS key event to the start cue. The main process
// stamps the press (pressId, keyAt, …Sent); the renderer marks its own steps and
// logs one line per attempt — started or not — so a slow start shows which step
// took the time, and a press abandoned while starting is not lost.
export const SLOW_START_MS = 1000;

const STEP_ORDER = [
  "prepareReceived",
  "prepareFramesDone",
  "micConstraintsReady",
  "micGetUserMediaDone",
  "micReady",
  "preRollStarted",
  "startReceived",
  "startFramesDone",
  "targetCaptured",
  "recorderActive",
  "recordingStarted",
  "cueScheduled",
];

export function createStartTrace(pressTrace) {
  return { ...(pressTrace || {}), steps: {} };
}

// Prepare and start arrive separately; start joins the prepare of the same press.
export function joinStartTrace(current, pressTrace) {
  if (pressTrace && current?.pressId === pressTrace.pressId) {
    return Object.assign(current, pressTrace, { steps: current.steps });
  }
  return createStartTrace(pressTrace);
}

export function markStartTrace(trace, step, at = Date.now()) {
  if (trace && trace.steps[step] === undefined) trace.steps[step] = at;
}

// Every offset is ms after the key press (after the first renderer step when the
// press time is unknown, e.g. a toggle). A slow step shows up as the jump in offsets.
// Prepare and start overlap, so offsets must not be summed.
export function summarizeStartTrace(trace, now = Date.now()) {
  const stamps = Object.values(trace.steps);
  const base = trace.keyAt ?? (stamps.length ? Math.min(...stamps) : now);
  const after = (at) => (typeof at === "number" ? at - base : undefined);
  const summary = {
    pressId: trace.pressId,
    keyTimeSource: trace.keyTimeSource ?? "renderer",
    hookAfterKeyMs: after(trace.hookAt),
    mainAfterKeyMs: after(trace.mainAt),
    prepareSentAfterKeyMs: after(trace.prepareSentAt),
    startSentAfterKeyMs: after(trace.startSentAt),
  };
  for (const step of STEP_ORDER) summary[`${step}AfterKeyMs`] = after(trace.steps[step]);
  summary.loggedAfterKeyMs = after(now);
  for (const [key, value] of Object.entries(trace.details || {})) summary[key] = value;
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

export function isSlowStart(summary) {
  if (summary.outcome && summary.outcome !== "started") {
    return summary.loggedAfterKeyMs >= SLOW_START_MS;
  }
  return (
    summary.recordingStartedAfterKeyMs >= SLOW_START_MS ||
    (summary.usedPreparedCapture === true && summary.preRoll === false)
  );
}

// outcome: "started", "stopped-during-start" (released before the start
// finished) or "not-started" (blocked, failed, or superseded).
export function logStartTrace(trace, outcome) {
  if (!trace || trace.logged) return null;
  trace.logged = true;
  trace.details = { ...trace.details, outcome };
  const summary = summarizeStartTrace(trace);
  if (isSlowStart(summary)) logger.warn("Slow dictation start", summary, "audio");
  else logger.info("Dictation start trace", summary, "audio");
  return summary;
}
