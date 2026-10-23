// Dictation styles: every style lives in one versioned record,
// `dictationStyles`, the only authority for styles. A style is a short
// instruction that restyles a dictation after cleanup (two steps, the
// default) or together with it (one step). Plain is not an entry: it is the
// built-in "cleanup only", always present, and what the dictation hotkey does
// until a style is picked for it.
//
// Every change is one read-modify-write of the record (updateStyleLibrary),
// re-read inside the write so another window's change is never overwritten
// with a stale copy. Other windows follow the record's `storage` event.
//
// Reserved and carried but not shown: `examples` (style from examples),
// `useVoice` (voice profile) and `hotkey` (Stage 4 style hotkeys).

import { STYLE_STARTERS, type StyleStarter } from "./starters";

export const STYLE_LIBRARY_KEY = "dictationStyles";
export const STYLE_LIBRARY_VERSION = 1;
export const PLAIN_STYLE_ID = "plain";
export const STYLE_NAME_MAX_LENGTH = 40;
export const STYLE_EMOJI_MAX_LENGTH = 16;
export const STYLE_INSTRUCTION_MAX_LENGTH = 2000;
/** A style's history `route_kind` is this prefix plus its id. */
export const STYLE_ROUTE_PREFIX = "style:";
const STYLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export type StyleRunMode = "two-step" | "one-step";
export const STYLE_RUN_MODES: readonly StyleRunMode[] = ["two-step", "one-step"];
export const DEFAULT_STYLE_RUN_MODE: StyleRunMode = "two-step";
export type StyleOrigin = "starter" | "user";

export interface DictationStyle {
  id: string;
  name: string;
  emoji: string;
  /** The only part the user writes: what the style does. */
  instruction: string;
  /** Off: not offered for the dictation hotkey, and never applied. */
  enabled: boolean;
  runMode: StyleRunMode;
  /** The glossary's corrections limited to chosen apps apply to this style's dictations. */
  appGlossary: boolean;
  /** Reserved (style from examples): stored and carried, not shown. */
  examples: unknown[];
  /** Reserved (voice profile): stored and carried, not shown. */
  useVoice: boolean;
  /** Reserved (Stage 4 style hotkeys): stored, never bound here. */
  hotkey: string | null;
  origin: StyleOrigin;
  updatedAt: number;
}

export interface StyleLibrary {
  version: number;
  /** What the dictation hotkey applies: PLAIN_STYLE_ID or an enabled style's id. */
  dictationStyleId: string;
  /** Starters already added once, so a deleted starter never comes back. */
  seededStarters: string[];
  styles: DictationStyle[];
}

/** A style frozen for one recording (or one test run): what the chain reads. */
export interface RecordingStyle {
  id: string;
  name: string;
  emoji: string;
  instruction: string;
  runMode: StyleRunMode;
  appGlossary: boolean;
  useVoice: boolean;
}

export interface StyleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type StarterNames = Partial<Record<string, string>>;

export function isValidStyleId(id: unknown): id is string {
  return typeof id === "string" && STYLE_ID_PATTERN.test(id) && id !== PLAIN_STYLE_ID;
}

/** `style:<id>` for a style's dictations in history; null for Plain. */
export function styleRouteKind(styleId: string | null | undefined): string | null {
  return isValidStyleId(styleId) ? `${STYLE_ROUTE_PREFIX}${styleId}` : null;
}

/** The style id of a history row's `route_kind`, or null when it isn't a styled dictation. */
export function styleIdFromRouteKind(routeKind: string | null | undefined): string | null {
  if (typeof routeKind !== "string" || !routeKind.startsWith(STYLE_ROUTE_PREFIX)) return null;
  const id = routeKind.slice(STYLE_ROUTE_PREFIX.length);
  return isValidStyleId(id) ? id : null;
}

export function normalizeStyleName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.replace(/\s+/g, " ").trim().slice(0, STYLE_NAME_MAX_LENGTH).trim();
}

export function normalizeStyleEmoji(emoji: unknown): string {
  if (typeof emoji !== "string") return "";
  return emoji.replace(/\s+/g, "").slice(0, STYLE_EMOJI_MAX_LENGTH);
}

export function normalizeStyleInstruction(instruction: unknown): string {
  if (typeof instruction !== "string") return "";
  return instruction.trim().slice(0, STYLE_INSTRUCTION_MAX_LENGTH).trim();
}

function normalizeRunMode(value: unknown): StyleRunMode {
  return value === "one-step" ? "one-step" : DEFAULT_STYLE_RUN_MODE;
}

function newStyleId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyStyleLibrary(): StyleLibrary {
  return {
    version: STYLE_LIBRARY_VERSION,
    dictationStyleId: PLAIN_STYLE_ID,
    seededStarters: [],
    styles: [],
  };
}

function styleFromStarter(starter: StyleStarter, names: StarterNames, now: number) {
  const style: DictationStyle = {
    id: starter.id,
    name: normalizeStyleName(names[starter.id]) || starter.defaultName,
    emoji: starter.emoji,
    instruction: starter.instruction,
    // Starters are off until switched on.
    enabled: false,
    runMode: starter.runMode,
    appGlossary: true,
    examples: [],
    useVoice: false,
    hotkey: null,
    origin: "starter",
    updatedAt: now,
  };
  return style;
}

/**
 * Adds the starters this record has never had. Deterministic ids, so two
 * windows seeding at once write the same record. Returns whether it changed.
 */
export function seedStarterStyles(
  library: StyleLibrary,
  names: StarterNames = {},
  now = Date.now()
): boolean {
  let changed = false;
  for (const starter of STYLE_STARTERS) {
    if (library.seededStarters.includes(starter.id)) continue;
    library.seededStarters.push(starter.id);
    if (!library.styles.some((style) => style.id === starter.id)) {
      library.styles.push(styleFromStarter(starter, names, now));
    }
    changed = true;
  }
  return changed;
}

/** A style the dictation hotkey can apply: it exists, is on, and is complete. */
function usableStyle(library: StyleLibrary, id: unknown): DictationStyle | undefined {
  if (typeof id !== "string") return undefined;
  const style = findStyle(library, id);
  return style && style.enabled && style.instruction.trim() && style.name ? style : undefined;
}

/**
 * Parses a stored record, or null when there is none or it is unreadable.
 * Unknown fields (from a newer app version) are kept so a write here does not
 * drop them.
 */
export function parseStyleLibrary(raw: string | null | undefined): StyleLibrary | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as StyleLibrary).styles)) {
    return null;
  }
  const record = data as Record<string, unknown> & { styles: unknown[] };
  const seen = new Set<string>();
  const styles: DictationStyle[] = [];
  for (const candidate of record.styles) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Record<string, unknown>;
    const id = entry.id;
    if (!isValidStyleId(id) || seen.has(id)) continue;
    seen.add(id);
    styles.push({
      ...entry,
      id,
      name: normalizeStyleName(entry.name),
      emoji: normalizeStyleEmoji(entry.emoji),
      instruction: typeof entry.instruction === "string" ? entry.instruction : "",
      enabled: entry.enabled === true,
      runMode: normalizeRunMode(entry.runMode),
      appGlossary: entry.appGlossary !== false,
      examples: Array.isArray(entry.examples) ? entry.examples : [],
      useVoice: entry.useVoice === true,
      hotkey: typeof entry.hotkey === "string" && entry.hotkey.trim() ? entry.hotkey : null,
      origin: entry.origin === "starter" ? "starter" : "user",
      updatedAt:
        typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : 0,
    });
  }
  const seededStarters = Array.isArray(record.seededStarters)
    ? [...new Set(record.seededStarters.filter((id): id is string => typeof id === "string"))]
    : [];
  const version =
    typeof record.version === "number" && record.version >= STYLE_LIBRARY_VERSION
      ? record.version
      : STYLE_LIBRARY_VERSION;
  const library: StyleLibrary = {
    ...record,
    version,
    dictationStyleId: PLAIN_STYLE_ID,
    seededStarters,
    styles,
  };
  if (usableStyle(library, record.dictationStyleId)) {
    library.dictationStyleId = record.dictationStyleId as string;
  }
  return library;
}

export function findStyle(
  library: StyleLibrary,
  id: string | null | undefined
): DictationStyle | undefined {
  return id ? library.styles.find((style) => style.id === id) : undefined;
}

/** The styles the dictation hotkey can be given: switched on and complete. */
export function selectableStyles(library: StyleLibrary): DictationStyle[] {
  return library.styles.filter((style) => usableStyle(library, style.id));
}

/** A frozen copy of a style, for one recording or one test run. */
export function snapshotStyle(
  style: Pick<
    DictationStyle,
    "id" | "name" | "emoji" | "instruction" | "runMode" | "appGlossary" | "useVoice"
  >
): RecordingStyle {
  return Object.freeze({
    id: style.id,
    name: style.name,
    emoji: style.emoji,
    instruction: style.instruction.trim(),
    runMode: normalizeRunMode(style.runMode),
    appGlossary: style.appGlossary !== false,
    useVoice: style.useVoice === true,
  });
}

/**
 * The style a starting recording carries: `requestedId` when a key asked for
 * one (Stage 4), else the dictation hotkey's style. Null means Plain: none
 * chosen, or the style is gone, switched off or empty.
 */
export function resolveRecordingStyle(
  library: StyleLibrary,
  requestedId?: string | null
): RecordingStyle | null {
  const id = requestedId ?? library.dictationStyleId;
  if (!id || id === PLAIN_STYLE_ID) return null;
  const style = usableStyle(library, id);
  return style ? snapshotStyle(style) : null;
}

/**
 * The style a retry from history re-runs: the row's style while it exists,
 * even switched off (the user asked for this dictation again). Null when it
 * was deleted or emptied.
 */
export function resolveRetryStyle(
  library: StyleLibrary,
  styleId: string | null | undefined
): RecordingStyle | null {
  const style = findStyle(library, styleId);
  return style && style.instruction.trim() && style.name ? snapshotStyle(style) : null;
}

/** The stored record, or an empty library when there is none (nothing is written). */
export function readStyleLibrary(storage: StyleStorage): StyleLibrary {
  return parseStyleLibrary(storage.getItem(STYLE_LIBRARY_KEY)) ?? createEmptyStyleLibrary();
}

function writeStyleLibrary(storage: StyleStorage, library: StyleLibrary) {
  // Always written, never removed: other windows' storage listeners ignore removals.
  storage.setItem(STYLE_LIBRARY_KEY, JSON.stringify(library));
}

/**
 * The single write path. The record is re-read from storage inside the write,
 * changed, and written back in one synchronous step. `change` returns false
 * to leave storage untouched. A dictation style the change made unusable
 * falls back to Plain in the same write.
 */
export function updateStyleLibrary(
  storage: StyleStorage,
  change: (library: StyleLibrary) => boolean
): { library: StyleLibrary; changed: boolean } {
  const library = readStyleLibrary(storage);
  if (!change(library)) return { library, changed: false };
  if (
    library.dictationStyleId !== PLAIN_STYLE_ID &&
    !usableStyle(library, library.dictationStyleId)
  ) {
    library.dictationStyleId = PLAIN_STYLE_ID;
  }
  writeStyleLibrary(storage, library);
  return { library, changed: true };
}

/** Writes a record with the starters it has never had; idempotent. */
export function ensureStyleLibrary(
  storage: StyleStorage,
  names: StarterNames = {},
  now = Date.now()
): { library: StyleLibrary; changed: boolean } {
  return updateStyleLibrary(storage, (library) => seedStarterStyles(library, names, now));
}

// --- Changes, each applied inside updateStyleLibrary ---------------------------

export interface StyleInput {
  name: string;
  emoji?: string;
  instruction: string;
  runMode?: StyleRunMode;
  appGlossary?: boolean;
  enabled?: boolean;
  id?: string;
  now?: number;
}

/** A new style of the user's own, on unless asked otherwise. Null when incomplete. */
export function addStyle(library: StyleLibrary, input: StyleInput): DictationStyle | null {
  const name = normalizeStyleName(input.name);
  const instruction = normalizeStyleInstruction(input.instruction);
  if (!name || !instruction) return null;
  const style: DictationStyle = {
    id: input.id && isValidStyleId(input.id) ? input.id : newStyleId(),
    name,
    emoji: normalizeStyleEmoji(input.emoji),
    instruction,
    enabled: input.enabled !== false,
    runMode: normalizeRunMode(input.runMode),
    appGlossary: input.appGlossary !== false,
    examples: [],
    useVoice: false,
    hotkey: null,
    origin: "user",
    updatedAt: input.now ?? Date.now(),
  };
  library.styles.push(style);
  return style;
}

export type StylePatch = Partial<
  Pick<DictationStyle, "name" | "emoji" | "instruction" | "runMode" | "appGlossary" | "enabled">
>;

/**
 * Applies the editable fields. A patch that would leave the style without a
 * name or an instruction is refused, like an empty prompt.
 */
export function updateStyle(
  library: StyleLibrary,
  id: string,
  patch: StylePatch,
  now = Date.now()
): boolean {
  const style = findStyle(library, id);
  if (!style) return false;
  const next = {
    name: patch.name === undefined ? style.name : normalizeStyleName(patch.name),
    emoji: patch.emoji === undefined ? style.emoji : normalizeStyleEmoji(patch.emoji),
    instruction:
      patch.instruction === undefined
        ? style.instruction
        : normalizeStyleInstruction(patch.instruction),
    runMode: patch.runMode === undefined ? style.runMode : normalizeRunMode(patch.runMode),
    appGlossary: patch.appGlossary === undefined ? style.appGlossary : patch.appGlossary !== false,
    enabled: patch.enabled === undefined ? style.enabled : patch.enabled === true,
  };
  if (!next.name || !next.instruction.trim()) return false;
  const changed = (Object.keys(next) as Array<keyof typeof next>).some(
    (key) => next[key] !== style[key]
  );
  if (!changed) return false;
  Object.assign(style, next, { updatedAt: now });
  return true;
}

/** Deleting the dictation hotkey's style puts Plain back on it. */
export function removeStyle(library: StyleLibrary, id: string): boolean {
  const before = library.styles.length;
  library.styles = library.styles.filter((style) => style.id !== id);
  if (library.styles.length === before) return false;
  if (library.dictationStyleId === id) library.dictationStyleId = PLAIN_STYLE_ID;
  return true;
}

/** Plain is always allowed; a style only while it is on and complete. */
export function setDictationStyle(library: StyleLibrary, id: string): boolean {
  if (id !== PLAIN_STYLE_ID && !usableStyle(library, id)) return false;
  if (library.dictationStyleId === id) return false;
  library.dictationStyleId = id;
  return true;
}
