import { create } from "zustand";
import {
  STYLE_LIBRARY_KEY,
  addStyle,
  applyStyleHotkeyBindings,
  createEmptyStyleLibrary,
  ensureStyleLibrary,
  hotkeyEligibleStyleIds,
  orphanedStyleHotkeys,
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
  type StyleHotkeyResult,
  type StyleHotkeyState,
  type StyleInput,
  type StyleLibrary,
  type StylePatch,
} from "../config/styles/library";

// This window's view of the dictation styles. The record in localStorage
// (`dictationStyles`, config/styles/library.ts) is the only authority: every
// change here is one read-modify-write of it, and other windows follow its
// `storage` event. What a recording uses is read from the record itself when
// the recording starts, never from a copy that might be behind.
//
// Style hotkeys (Stage 4) are the exception: main owns the bindings, and this
// store keeps main's view (`hotkeys`) and mirrors it into each style's
// `hotkey`. A change that leaves a style unable to hold a key (deleted, off,
// emptied), here or in another window, asks main to release it.

const hasStorage = () => typeof localStorage !== "undefined" && localStorage !== null;

const EMPTY_HOTKEY_STATE: StyleHotkeyState = {
  bindings: [],
  supported: true,
  unsupportedReason: null,
};

interface StyleStoreState {
  library: StyleLibrary;
  /** Main's style hotkey bindings and whether this backend takes them. */
  hotkeys: StyleHotkeyState;
  /** A style another page asked Style Studio to open (the Hotkeys page's list). */
  focusStyleId: string | null;
}

export const useStyleStore = create<StyleStoreState>()(() => ({
  library: hasStorage() ? readStyleLibrary(localStorage) : createEmptyStyleLibrary(),
  hotkeys: EMPTY_HOTKEY_STATE,
  focusStyleId: null,
}));

function change(apply: (library: StyleLibrary) => boolean): boolean {
  if (!hasStorage()) return false;
  const { library, changed } = updateStyleLibrary(localStorage, apply);
  useStyleStore.setState({ library });
  if (changed) releaseOrphanedStyleHotkeys(library);
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
  if (library) {
    useStyleStore.setState({ library });
    releaseOrphanedStyleHotkeys(library);
  }
  return true;
}

// --- Style hotkeys (Stage 4) ---------------------------------------------------

const styleHotkeyApi = () => (typeof window !== "undefined" ? window.electronAPI : undefined);

function isHotkeyState(value: unknown): value is StyleHotkeyState {
  return Boolean(value) && Array.isArray((value as StyleHotkeyState).bindings);
}

/**
 * Takes main's view: stores it and rewrites the record's `hotkey` mirrors
 * (only when they differ, so every window applying the same broadcast writes
 * at most once between them). Then releases any key whose style can no
 * longer hold one, unless this view is main's answer to that very request.
 */
export function applyStyleHotkeyState(
  state: unknown,
  { releaseOrphans = true }: { releaseOrphans?: boolean } = {}
): void {
  if (!isHotkeyState(state)) return;
  const hotkeys: StyleHotkeyState = {
    bindings: state.bindings
      .filter((binding) => binding && typeof binding.hotkey === "string")
      .map((binding) => ({
        hotkey: binding.hotkey,
        styleId: String(binding.styleId),
        active: binding.active === true,
        error: typeof binding.error === "string" ? binding.error : null,
      })),
    supported: state.supported !== false,
    unsupportedReason: typeof state.unsupportedReason === "string" ? state.unsupportedReason : null,
  };
  useStyleStore.setState({ hotkeys });
  if (!hasStorage()) return;
  const { library } = updateStyleLibrary(localStorage, (current) =>
    applyStyleHotkeyBindings(current, hotkeys.bindings)
  );
  useStyleStore.setState({ library });
  if (releaseOrphans) releaseOrphanedStyleHotkeys(library);
}

let orphanReleaseInFlight = false;

/**
 * Asks main to release the keys of styles that can no longer hold one. Reads
 * the record itself, so a window whose copy is behind never releases a key a
 * newer write still allows.
 */
export function releaseOrphanedStyleHotkeys(library?: StyleLibrary): void {
  const api = styleHotkeyApi();
  if (!api?.syncStyleHotkeyStyles || orphanReleaseInFlight) return;
  const { bindings } = useStyleStore.getState().hotkeys;
  if (bindings.length === 0) return;
  const current = hasStorage() ? readStyleLibrary(localStorage) : (library ?? null);
  if (!current || orphanedStyleHotkeys(current, bindings).length === 0) return;
  orphanReleaseInFlight = true;
  void api
    .syncStyleHotkeyStyles(hotkeyEligibleStyleIds(current))
    .then((result) => {
      applyStyleHotkeyState(result, { releaseOrphans: false });
      return result?.success === true;
    })
    .catch(() => false)
    .then((succeeded) => {
      orphanReleaseInFlight = false;
      // A style that lost its key while this request was out gets its turn
      // now; after a failure, the next change tries again.
      if (succeeded) releaseOrphanedStyleHotkeys();
    });
}

/** Main's current bindings, mirrored into the record. */
export async function loadStyleHotkeys(): Promise<StyleHotkeyState> {
  const api = styleHotkeyApi();
  if (!api?.getStyleHotkeys) return useStyleStore.getState().hotkeys;
  try {
    applyStyleHotkeyState(await api.getStyleHotkeys());
  } catch {
    // Keeps the last known view; the next broadcast refreshes it.
  }
  return useStyleStore.getState().hotkeys;
}

/**
 * Binds `hotkey` to a style through main (null removes it). Main registers it
 * first and commits only on success; the refusal's reason comes back in
 * `message`.
 */
export async function setStyleHotkey(
  styleId: string,
  hotkey: string | null
): Promise<{ success: boolean; message?: string }> {
  const api = styleHotkeyApi();
  if (!api?.setStyleHotkey) return { success: false };
  try {
    const result: StyleHotkeyResult = await api.setStyleHotkey(styleId, hotkey || null);
    applyStyleHotkeyState(result);
    return { success: result?.success === true, message: result?.message };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : undefined };
  }
}

/** Asks Style Studio to scroll to its styles without opening one. */
export const STYLE_LIST_FOCUS = "__styles__";

/** Opens a style in Style Studio from elsewhere (the Hotkeys page's list). */
export function requestStyleFocus(styleId: string | null): void {
  useStyleStore.setState({ focusStyleId: styleId });
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
  const api = window.electronAPI;
  if (api?.onStyleHotkeysChanged) {
    api.onStyleHotkeysChanged((state) => applyStyleHotkeyState(state));
    void loadStyleHotkeys();
  }
}

listenForOtherWindows();
