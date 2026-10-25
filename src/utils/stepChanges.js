// What each saved step of a dictation did to its text (step history,
// helpers/stepHistory.js). Pure and dependency-free like
// config/customConnection.js, so main (via require), the renderer and the tests
// share one rule: a step received the output of the last earlier step that left
// text behind (one that succeeded or was skipped). A failed step has no output
// and a blank reply was ignored, so neither is ever the next step's input.

/** @typedef {"changed" | "same" | "failed" | "skipped" | "fallback"} StepChange */

/**
 * @param {{ outcome: string, output: string | null }} step
 * @returns {boolean} whether the step's output is the text the next step received
 */
export function leavesText(step) {
  return (
    !!step &&
    (step.outcome === "ok" || step.outcome === "skipped") &&
    typeof step.output === "string"
  );
}

/**
 * One entry per step, in saved order. `input`: the index of the step whose
 * output this one received, or null (the first step). `change`: the outcome of
 * a step that didn't succeed, else "changed" or "same" against its input, or
 * null when there is nothing to compare it with.
 *
 * @param {ReadonlyArray<{ outcome: string, output: string | null }>} steps
 * @returns {Array<{ input: number | null, change: StepChange | null }>}
 */
export function stepChanges(steps) {
  if (!Array.isArray(steps)) return [];
  let input = null;
  return steps.map((step, index) => {
    const entry = { input, change: null };
    if (step?.outcome === "failed" || step?.outcome === "skipped" || step?.outcome === "fallback") {
      entry.change = step.outcome;
    } else if (input !== null && typeof step?.output === "string") {
      entry.change = step.output === steps[input].output ? "same" : "changed";
    }
    if (leavesText(step)) input = index;
    return entry;
  });
}
