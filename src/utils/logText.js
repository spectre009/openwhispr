// Dictated text in logs (Settings › Storage › Logs). Pure and dependency-free
// like stepChanges.js, so main (via require), the renderer and the tests share
// one rule: a log line says how much text there was, never the text itself,
// unless the user switched on "Include dictated text" to investigate a text bug
// (then at most LOG_TEXT_MAX_CHARS characters of it). Main sets the switch from
// its settings; each renderer from main's answer and its broadcast.

export const LOG_TEXT_MAX_CHARS = 80;

let includeText = false;

/** @param {boolean} enabled */
export function setLogTextEnabled(enabled) {
  includeText = enabled === true;
}

export function isLogTextEnabled() {
  return includeText;
}

/**
 * What a log line may say about a piece of dictated text: its length and word
 * count, plus the first 80 characters only while "Include dictated text" is on.
 * Anything that isn't a string counts as empty.
 *
 * @param {unknown} value
 * @returns {{ chars: number, words: number, text?: string }}
 */
export function logText(value) {
  const text = typeof value === "string" ? value : "";
  const trimmed = text.trim();
  const summary = { chars: text.length, words: trimmed ? trimmed.split(/\s+/u).length : 0 };
  if (includeText && text) {
    return { ...summary, text: Array.from(text).slice(0, LOG_TEXT_MAX_CHARS).join("") };
  }
  return summary;
}
