import type { PromptKind } from "./registry";

// The prompt library: every saved prompt of one kind lives in a single
// versioned record, `promptLibrary.<kind>`, the only authority for that kind.
// `customPrompt.<kind>` is a compatibility cache written from the record in the
// same operation (the active entry's text, or "" for the built-in default), so
// everything that reads prompts keeps reading that one key. Default is not an
// entry: it stays the "empty override", which follows the UI language and app
// updates.

export const PROMPT_LIBRARY_VERSION = 1;
export const DEFAULT_PROMPT_ID = "default";
// Deterministic, so two windows migrating the same install at once write the
// same record instead of two copies under different ids.
export const MIGRATED_PROMPT_ID = "migrated";
export const PROMPT_NAME_MAX_LENGTH = 80;

export type PromptEntryOrigin = "migrated" | "user";

export interface PromptLibraryEntry {
  id: string;
  name: string;
  text: string;
  updatedAt: number;
  /** "migrated" came from a pre-library override; only those are ever swept. */
  origin: PromptEntryOrigin;
}

export interface PromptLibrary {
  version: number;
  /** An entry id, or DEFAULT_PROMPT_ID for the built-in prompt. */
  activeId: string;
  entries: PromptLibraryEntry[];
}

export interface PromptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const promptLibraryKey = (kind: PromptKind): string => `promptLibrary.${kind}`;
export const customPromptKey = (kind: PromptKind): string => `customPrompt.${kind}`;

export function createEmptyPromptLibrary(): PromptLibrary {
  return { version: PROMPT_LIBRARY_VERSION, activeId: DEFAULT_PROMPT_ID, entries: [] };
}

export function normalizePromptName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, PROMPT_NAME_MAX_LENGTH).trim();
}

function newEntryId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Parses a stored record, or null when there is none or it is unreadable.
 * Unknown fields (from a newer app version) are kept so a write here does not
 * drop them.
 */
export function parsePromptLibrary(raw: string | null | undefined): PromptLibrary | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as PromptLibrary).entries)) {
    return null;
  }
  const record = data as Record<string, unknown> & { entries: unknown[] };
  const seen = new Set<string>();
  const entries: PromptLibraryEntry[] = [];
  for (const candidate of record.entries) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== "string" || !id || id === DEFAULT_PROMPT_ID || seen.has(id)) continue;
    if (typeof entry.text !== "string") continue;
    seen.add(id);
    entries.push({
      ...entry,
      id,
      name: typeof entry.name === "string" ? entry.name : "",
      text: entry.text,
      updatedAt:
        typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : 0,
      origin: entry.origin === "migrated" ? "migrated" : "user",
    });
  }
  const activeId =
    typeof record.activeId === "string" && seen.has(record.activeId)
      ? record.activeId
      : DEFAULT_PROMPT_ID;
  const version =
    typeof record.version === "number" && record.version >= PROMPT_LIBRARY_VERSION
      ? record.version
      : PROMPT_LIBRARY_VERSION;
  return { ...record, version, activeId, entries };
}

export function findPromptEntry(
  library: PromptLibrary,
  id: string | null | undefined
): PromptLibraryEntry | undefined {
  return id ? library.entries.find((entry) => entry.id === id) : undefined;
}

/** What `customPrompt.<kind>` must hold for this record: "" means the built-in default. */
export function activePromptText(library: PromptLibrary): string {
  if (library.activeId === DEFAULT_PROMPT_ID) return "";
  return findPromptEntry(library, library.activeId)?.text ?? "";
}

/**
 * The id of the entry in use when `template` is its text (DEFAULT_PROMPT_ID for
 * ""), or null when the record and the template disagree, e.g. a window that
 * has not caught up with another one's change yet.
 */
export function activeEntryIdFor(
  library: PromptLibrary | null | undefined,
  template: string
): string | null {
  if (!library) return null;
  return activePromptText(library) === (template || "") ? library.activeId : null;
}

/** A pre-library install's override becomes the active "migrated" entry. */
function libraryFromCache(storage: PromptStorage, kind: PromptKind, migratedName: string) {
  const library = createEmptyPromptLibrary();
  const cached = storage.getItem(customPromptKey(kind)) ?? "";
  if (cached.length > 0) {
    library.entries.push({
      id: MIGRATED_PROMPT_ID,
      name: normalizePromptName(migratedName) || "My prompt",
      text: cached,
      updatedAt: Date.now(),
      origin: "migrated",
    });
    library.activeId = MIGRATED_PROMPT_ID;
  }
  return library;
}

/** The stored record, or an empty library when there is none (nothing is written). */
export function readPromptLibrary(storage: PromptStorage, kind: PromptKind): PromptLibrary {
  return parsePromptLibrary(storage.getItem(promptLibraryKey(kind))) ?? createEmptyPromptLibrary();
}

function writePromptLibrary(storage: PromptStorage, kind: PromptKind, library: PromptLibrary) {
  // Record first: it is the authority. The cache is always written, never
  // removed, because other windows' storage listeners ignore removals.
  storage.setItem(promptLibraryKey(kind), JSON.stringify(library));
  storage.setItem(customPromptKey(kind), activePromptText(library));
}

/**
 * One-time and idempotent: an install without a record gets one built from its
 * `customPrompt.<kind>` (a non-empty override becomes the active entry, empty
 * means Default). An existing record is left alone.
 */
export function migratePromptLibrary(
  storage: PromptStorage,
  kind: PromptKind,
  migratedName: string
): { library: PromptLibrary; migrated: boolean } {
  const existing = parsePromptLibrary(storage.getItem(promptLibraryKey(kind)));
  if (existing) return { library: existing, migrated: false };
  const library = libraryFromCache(storage, kind, migratedName);
  writePromptLibrary(storage, kind, library);
  return { library, migrated: true };
}

/**
 * The single write path. The record is re-read from storage inside the write
 * (never a caller's in-memory copy, which another window may have outdated),
 * changed, and written back together with the cache, all in one synchronous
 * step. `change` returns false to leave storage untouched.
 */
export function updatePromptLibrary(
  storage: PromptStorage,
  kind: PromptKind,
  migratedName: string,
  change: (library: PromptLibrary) => boolean
): { library: PromptLibrary; changed: boolean } {
  const library =
    parsePromptLibrary(storage.getItem(promptLibraryKey(kind))) ??
    libraryFromCache(storage, kind, migratedName);
  if (!change(library)) return { library, changed: false };
  if (library.activeId !== DEFAULT_PROMPT_ID && !findPromptEntry(library, library.activeId)) {
    library.activeId = DEFAULT_PROMPT_ID;
  }
  writePromptLibrary(storage, kind, library);
  return { library, changed: true };
}

// --- Changes, each applied inside updatePromptLibrary --------------------------

export function addPromptEntry(
  library: PromptLibrary,
  input: { name: string; text: string; id?: string; now?: number }
): PromptLibraryEntry {
  const entry: PromptLibraryEntry = {
    id: input.id ?? newEntryId(),
    name: normalizePromptName(input.name),
    text: input.text,
    updatedAt: input.now ?? Date.now(),
    origin: "user",
  };
  library.entries.push(entry);
  return entry;
}

/**
 * Saving an empty text is refused: an active entry with no text would leave the
 * cache empty, so dictation would use Default while the library says otherwise.
 */
export function savePromptEntryText(
  library: PromptLibrary,
  id: string,
  text: string,
  now = Date.now()
): boolean {
  const entry = findPromptEntry(library, id);
  if (!entry || !text.trim()) return false;
  if (entry.text === text) return false;
  entry.text = text;
  entry.updatedAt = now;
  return true;
}

export function renamePromptEntry(
  library: PromptLibrary,
  id: string,
  name: string,
  now = Date.now()
): boolean {
  const entry = findPromptEntry(library, id);
  const normalized = normalizePromptName(name);
  if (!entry || !normalized || entry.name === normalized) return false;
  entry.name = normalized;
  entry.updatedAt = now;
  return true;
}

/** Deleting the prompt in use switches the kind to Default. */
export function removePromptEntry(library: PromptLibrary, id: string): boolean {
  const before = library.entries.length;
  library.entries = library.entries.filter((entry) => entry.id !== id);
  if (library.entries.length === before) return false;
  if (library.activeId === id) library.activeId = DEFAULT_PROMPT_ID;
  return true;
}

/** Default is always selectable; an entry only once it has text. */
export function setActivePrompt(library: PromptLibrary, id: string): boolean {
  if (id !== DEFAULT_PROMPT_ID) {
    const entry = findPromptEntry(library, id);
    if (!entry || !entry.text.trim()) return false;
  }
  if (library.activeId === id) return false;
  library.activeId = id;
  return true;
}

/**
 * The retired-default rule: only a "migrated" entry that byte-matches a retired
 * shipped default is removed (and, if it was in use, the kind goes back to
 * Default). A prompt the user saved is never deleted, whatever its text. The
 * candidates are hashed first; the removal is one write that re-reads the
 * record and skips any entry whose text changed meanwhile. A removed text is
 * archived under `customPrompt.<kind>.retired`, as the pre-library sweep did.
 */
export async function sweepRetiredPromptEntries(
  storage: PromptStorage,
  kinds: readonly PromptKind[],
  isRetired: (text: string) => Promise<boolean>,
  migratedName: string
): Promise<Array<{ kind: PromptKind; library: PromptLibrary }>> {
  const swept: Array<{ kind: PromptKind; library: PromptLibrary }> = [];
  for (const kind of kinds) {
    try {
      const candidates = readPromptLibrary(storage, kind).entries.filter(
        (entry) => entry.origin === "migrated" && entry.text.length > 0
      );
      const retired: Array<{ id: string; text: string }> = [];
      for (const entry of candidates) {
        if (await isRetired(entry.text)) retired.push({ id: entry.id, text: entry.text });
      }
      if (retired.length === 0) continue;

      const removed: PromptLibraryEntry[] = [];
      const { library, changed } = updatePromptLibrary(storage, kind, migratedName, (draft) => {
        draft.entries = draft.entries.filter((entry) => {
          const hit =
            entry.origin === "migrated" &&
            retired.some((match) => match.id === entry.id && match.text === entry.text);
          if (hit) removed.push(entry);
          return !hit;
        });
        if (removed.some((entry) => entry.id === draft.activeId)) {
          draft.activeId = DEFAULT_PROMPT_ID;
        }
        return removed.length > 0;
      });
      if (!changed) continue;
      storage.setItem(`${customPromptKey(kind)}.retired`, removed[removed.length - 1].text);
      swept.push({ kind, library });
    } catch {
      // Storage failures skip this kind; the sweep retries on the next start.
    }
  }
  return swept;
}
