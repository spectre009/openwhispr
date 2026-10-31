import { dictionaryWordKey } from "../../utils/dictionaryWordKey.js";
import { getAgentName } from "../../utils/agentName";
import type { HistoryDictionaryWord } from "../../types/electron";

// Which of a dictation's dictionary words History shows ("Dictionary in this
// dictation", the final text's underlines, the cleanup step's marks).

/** The words shown: the hidden assistant name left out, as the Dictionary page does. */
export function visibleDictionaryWords(
  words: readonly HistoryDictionaryWord[] | null | undefined
): HistoryDictionaryWord[] {
  const hidden = dictionaryWordKey(getAgentName());
  return (words ?? []).filter((entry) => dictionaryWordKey(entry.word) !== hidden);
}

/** The dictionary words a step's inserted text is marked for: those fixed after speech here. */
export function insertedDictionaryWords(words: readonly HistoryDictionaryWord[]): string[] {
  return words
    .filter((entry) => entry.appearances.some((appearance) => appearance.kind === "fix"))
    .map((entry) => entry.word);
}
