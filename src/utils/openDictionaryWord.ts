import { create } from "zustand";

// "Open in Dictionary" (History's "Dictionary in this dictation"): the control
// panel leaves Settings, shows the Dictionary page and opens that word's
// panel. A window event, like "Open in History", and a pending request the
// page takes once the word is in its list (the page may still be loading).

export const OPEN_DICTIONARY_WORD_EVENT = "openwhispr:open-dictionary-word";

export function requestOpenDictionaryWord(word: string): void {
  if (typeof window === "undefined" || typeof word !== "string" || !word.trim()) return;
  window.dispatchEvent(new CustomEvent(OPEN_DICTIONARY_WORD_EVENT, { detail: { word } }));
}

interface DictionaryWordRequestState {
  /** The word to open, until the page has opened it. */
  word: string | null;
  /** Bumped by every request, so the same word opens again. */
  request: number;
}

export const useDictionaryWordRequest = create<DictionaryWordRequestState>()(() => ({
  word: null,
  request: 0,
}));

export function setDictionaryWordRequest(word: string): void {
  useDictionaryWordRequest.setState((state) => ({ word, request: state.request + 1 }));
}

export function clearDictionaryWordRequest(): void {
  useDictionaryWordRequest.setState({ word: null });
}
