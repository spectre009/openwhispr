// The one identity of a dictionary word: trimmed, NFC, lowercased. Pins,
// suggestions, their evidence and the heard/written counts are all keyed by
// it, in main (via require) and the renderer alike, so "Claude" and
// " claude " are one word everywhere. Pure and dependency-free.

/** @param {unknown} word @returns {string} "" for anything that isn't a non-blank string */
export function dictionaryWordKey(word) {
  if (typeof word !== "string") return "";
  return word.trim().normalize("NFC").toLowerCase();
}
