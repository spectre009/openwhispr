// Pure orchestration for a styled dictation. No imports beyond the shared
// text guard: callers inject the model calls, so this stays node-testable.
//
// Two steps (the default): cleanup with the prompt in use, then the restyle.
// One step: the cleanup prompt plus the style block, in one request. With
// cleanup switched off, both modes restyle the working text in one request.
//
// The last good text always survives:
// - cleanup fails: the restyle gets the text cleanup was given;
// - the restyle (or one step) throws or returns nothing usable: the cleaned
//   text stands (one step falls back to a plain cleanup to get it).
// Unlike translation's chain there is no "unchanged" check: a reply that only
// moved line breaks is a change, and any usable reply is the result.

import { hasTextContent } from "./translationChain";

export const STYLE_RUN_MODES = Object.freeze(["two-step", "one-step"]);

/**
 * Runs one styled dictation. Resolves `{ text, applied, cleaned, mode, changed }`:
 * `applied` when the style's reply is the result, `cleaned` when a cleanup reply
 * is part of it, `mode` the run mode that actually ran, `changed` whether the
 * result differs from the text the style was given (line breaks count).
 * `strict` (test runs): a failed style rejects instead of falling back.
 */
export async function executeStyleChain({
  text,
  runMode = "two-step",
  cleanupReachable = false,
  runCleanup,
  runRestyle,
  runOneStep,
  onCleanupError,
  onStyleError,
  wasCancelled = () => false,
  strict = false,
}) {
  const input = typeof text === "string" ? text : "";
  const mode = runMode === "one-step" && cleanupReachable ? "one-step" : "two-step";
  const result = (out, { applied = false, cleaned = false, changed = false } = {}) => ({
    text: out,
    applied,
    cleaned,
    mode,
    changed,
  });

  const cleanup = async (current) => {
    try {
      const cleaned = await runCleanup(current);
      return hasTextContent(cleaned) ? cleaned : null;
    } catch (error) {
      if (strict) throw error;
      onCleanupError?.(error);
      return null;
    }
  };

  const styleFailed = (error) => {
    if (strict) {
      throw (
        error ??
        Object.assign(new Error("The style returned no text"), { code: "STYLE_EMPTY_REPLY" })
      );
    }
    onStyleError?.(error ?? null);
  };

  if (mode === "one-step") {
    let styled = null;
    let failure = null;
    try {
      styled = await runOneStep(input);
    } catch (error) {
      failure = error;
    }
    if (hasTextContent(styled)) {
      return result(styled, { applied: true, cleaned: true, changed: styled !== input });
    }
    styleFailed(failure);
    if (wasCancelled()) return result(input);
    // The cleaned text is the floor even when the style failed in one step.
    const cleaned = await cleanup(input);
    return cleaned ? result(cleaned, { cleaned: true, changed: cleaned !== input }) : result(input);
  }

  let out = input;
  let cleaned = false;
  if (cleanupReachable) {
    const reply = await cleanup(out);
    if (reply) {
      out = reply;
      cleaned = true;
    }
  }
  if (wasCancelled()) return result(out, { cleaned });

  let styled = null;
  try {
    styled = await runRestyle(out);
  } catch (error) {
    styleFailed(error);
    return result(out, { cleaned, changed: out !== input });
  }
  if (!hasTextContent(styled)) {
    styleFailed(null);
    return result(out, { cleaned, changed: out !== input });
  }
  return result(styled, { applied: true, cleaned, changed: styled !== out });
}
