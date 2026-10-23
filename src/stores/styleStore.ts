import { create } from "zustand";
import {
  STYLE_LIBRARY_KEY,
  addStyle,
  createEmptyStyleLibrary,
  ensureStyleLibrary,
  parseStyleLibrary,
  readStyleLibrary,
  removeStyle,
  resolveRecordingStyle,
  resolveRetryStyle,
  setDictationStyle,
  updateStyle,
  updateStyleLibrary,
  type RecordingStyle,
  type StarterNames,
  type StyleInput,
  type StyleLibrary,
  type StylePatch,
} from "../config/styles/library";

// This window's view of the dictation styles. The record in localStorage
// (`dictationStyles`, config/styles/library.ts) is the only authority: every
// change here is one read-modify-write of it, and other windows follow its
// `storage` event. What a recording uses is read from the record itself when
// the recording starts, never from a copy that might be behind.

const hasStorage = () => typeof localStorage !== "undefined" && localStorage !== null;

interface StyleStoreState {
  library: StyleLibrary;
}

export const useStyleStore = create<StyleStoreState>()(() => ({
  library: hasStorage() ? readStyleLibrary(localStorage) : createEmptyStyleLibrary(),
}));

function change(apply: (library: StyleLibrary) => boolean): boolean {
  if (!hasStorage()) return false;
  const { library, changed } = updateStyleLibrary(localStorage, apply);
  useStyleStore.setState({ library });
  return changed;
}

/** The record as stored right now (the authority), or an empty one. */
export function getStyleLibrary(): StyleLibrary {
  return hasStorage() ? readStyleLibrary(localStorage) : createEmptyStyleLibrary();
}

/** Writes the record with the starters it has never had (named in the UI language). */
export function ensureStyles(names: StarterNames): void {
  if (!hasStorage()) return;
  const { library } = ensureStyleLibrary(localStorage, names);
  useStyleStore.setState({ library });
}

/** Saves a new style of the user's own; returns its id, or null when incomplete. */
export function createStyle(input: StyleInput): string | null {
  let id: string | null = null;
  change((library) => {
    id = addStyle(library, input)?.id ?? null;
    return id !== null;
  });
  return id;
}

/** False when the style is gone, the patch would empty it, or nothing changed. */
export function saveStyle(id: string, patch: StylePatch): boolean {
  return change((library) => updateStyle(library, id, patch));
}

export function deleteStyle(id: string): boolean {
  return change((library) => removeStyle(library, id));
}

/** The dictation hotkey's style: PLAIN_STYLE_ID or a style that is on. */
export function chooseDictationStyle(id: string): boolean {
  return change((library) => setDictationStyle(library, id));
}

/**
 * The style a starting recording carries, read from the record now: the
 * requested one (a style key, Stage 4) or the dictation hotkey's. Null = Plain.
 */
export function resolveStyleForRecording(requestedId?: string | null): RecordingStyle | null {
  return resolveRecordingStyle(getStyleLibrary(), requestedId);
}

/** The style a retry from history re-runs; null when it was deleted. */
export function resolveStyleForRetry(id: string | null | undefined): RecordingStyle | null {
  return resolveRetryStyle(getStyleLibrary(), id);
}

/** Applies another window's write of the record. Returns whether the key was the record's. */
export function applyStyleStorageChange(key: string | null, newValue: string | null): boolean {
  if (key !== STYLE_LIBRARY_KEY) return false;
  const library = parseStyleLibrary(newValue);
  if (library) useStyleStore.setState({ library });
  return true;
}

let listening = false;

function listenForOtherWindows() {
  if (listening || typeof window === "undefined" || !hasStorage()) return;
  if (typeof window.addEventListener !== "function") return;
  listening = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    // Removals are ignored, as for the prompt library: the record is never removed.
    if (event.storageArea !== localStorage || event.newValue === null) return;
    applyStyleStorageChange(event.key, event.newValue);
  });
}

listenForOtherWindows();
