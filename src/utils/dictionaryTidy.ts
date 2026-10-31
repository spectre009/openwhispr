// Tidy up's checks (the Dictionary page): which words look like they don't
// belong, in groups, each item with a suggested action and whether it starts
// selected. Pure: the words, their sources, pins and dates, heard/written
// (or null when local History can't count), main's History aggregates (or
// null), the bundled common-word list and the protected spellings in, groups
// out. Nothing here is logged: these are the user's words.
//
// A word appears in at most one group, in TIDY_GROUP_ORDER, except "never
// heard", which is informational. Only auto-learned, unpinned words start
// selected. Glossary spellings and snippet triggers are never suggested for
// removal. A check that needs History says so instead of reading 0/0 as
// "speech gets it right".
//
// planTidyBatch (at the end) turns the choices the user applies at once into
// one consistent batch before main runs it, so no choice undoes another.

import { dictionaryWordKey } from "./dictionaryWordKey.js";
import { editDistance, similarWordGroups, spellingKey } from "./dictionarySimilar";
import { normalizeDbDate } from "./dateFormatting";
import { usageTokens } from "../helpers/dictionaryUsage.js";
import type { DictionaryTidyOp, DictionaryTidyPair, DictionaryTidyToken } from "../types/electron";

export type TidyGroupKind =
  "variants" | "plurals" | "ordinary" | "typos" | "fragments" | "splitPhrases" | "neverHeard";

export const TIDY_GROUP_ORDER: readonly TidyGroupKind[] = [
  "variants",
  "plurals",
  "splitPhrases",
  "ordinary",
  "typos",
  "fragments",
  "neverHeard",
];

/** The most items a group lists. */
export const TIDY_GROUP_CAP = 200;
/** Ordinary words: speech wrote it at least this often and never missed it. */
export const ORDINARY_MIN_HEARD = 3;
/** Likely typos: a History token in at least this many dictations… */
export const TYPO_MIN_TOKEN_ROWS = 5;
/** …and the word itself heard plus written at most this often. */
export const TYPO_MAX_USES = 1;
/** Split phrases: side by side in this share of the rows with the rarer word… */
export const SPLIT_MIN_SHARE = 0.8;
/** …which appears in at least this many. */
export const SPLIT_MIN_ROWS = 5;
/** Never heard: auto-learned at least this long ago. */
export const NEVER_HEARD_MIN_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
// Edit distance: up to 2 from 5 characters, 1 below.
const NEAR_LONG_CHARS = 5;

export type TidyAction = "remove" | "keep-one" | "respell" | "add-phrase";

export interface TidyReason {
  key: string;
  params?: Record<string, string | number>;
}

export interface TidyUsage {
  heard: number;
  written: number;
  missedRows: number;
}

/** A dictionary word as the checks read it (a DictionaryListItem fits). */
export interface TidyWord {
  word: string;
  source: "manual" | "learned";
  pinned: boolean;
  createdAt: string | null;
  /** Heard/written over 90 days; null when unknown. */
  usage: TidyUsage | null;
}

export interface TidyItem {
  /** Stable while the words are: the group and the words. */
  id: string;
  group: TidyGroupKind;
  action: TidyAction;
  /** The words it touches, in the list's order (keep-one: every spelling). */
  words: string[];
  /** keep-one: the spelling kept by default; null keeps none of them. */
  keep?: string | null;
  /** keep-one: "none of them" is offered (every spelling is an ordinary word). */
  allowNone?: boolean;
  /** keep-one: the kept spelling is fixed (a glossary spelling or snippet trigger). */
  locked?: boolean;
  /**
   * respell: the new spelling. A likely typo whose action is remove may also
   * carry one, offered as "Change to".
   */
  to?: string;
  /** respell: `to` is already a dictionary word, so this folds into it. */
  toExisting?: boolean;
  /** add-phrase: the phrase, and whether the dictionary has it already. */
  phrase?: string;
  phraseExists?: boolean;
  preselected: boolean;
  reason: TidyReason;
}

export interface TidyGroup {
  kind: TidyGroupKind;
  items: TidyItem[];
  /** Items before the cap. */
  total: number;
  /**
   * "history": the check needs this account's local History, which can't be
   * read; "partial": only the part that doesn't need it ran (ordinary words).
   */
  unavailable: null | "history" | "partial";
  /** Never heard: listed to decide on, never selected. */
  informational: boolean;
}

export interface TidyAggregates {
  frequentTokens: readonly DictionaryTidyToken[];
  adjacency: readonly DictionaryTidyPair[];
}

export interface TidyInput {
  /** The dictionary in stored order (the hidden assistant name left out). */
  words: readonly TidyWord[];
  /** Whether heard/written could be counted at all. */
  usageAvailable: boolean;
  /** Main's History aggregates; null when they can't be read. */
  aggregates: TidyAggregates | null;
  /** The bundled common-word list (lowercase); null when it isn't loaded. */
  commonWords: ReadonlySet<string> | null;
  /** Auto-learn's everyday words (correctionCommonWords.js). */
  learnerCommonWords: ReadonlySet<string>;
  /** Keys of glossary spellings and snippet triggers: never suggested for removal. */
  protectedKeys?: ReadonlySet<string>;
  now?: number;
}

interface Info extends TidyWord {
  key: string;
  order: number;
  createdMs: number;
  learnedUnpinned: boolean;
}

function itemId(group: TidyGroupKind, words: readonly string[]): string {
  return `${group}:${words.join("\n")}`;
}

/** The new spelling in the word's case style: "Kubernets" → "Kubernetes". */
export function matchCase(model: string, token: string): string {
  if (!token) return token;
  const letters = model.replace(/[^\p{L}]/gu, "");
  if (letters.length > 1 && letters === letters.toUpperCase()) return token.toUpperCase();
  const first = [...model][0] ?? "";
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return token.charAt(0).toUpperCase() + token.slice(1);
  }
  return token;
}

/** Why a word reads as a fragment, or null: punctuation inside, digits only, an edge mark, too short. */
export function fragmentKind(word: string): "short" | "digits" | "punctuation" | "edge" | null {
  const text = typeof word === "string" ? word.trim() : "";
  if ([...text].length <= 1) return "short";
  if (/^\d+$/.test(text)) return "digits";
  if (/\.\.\.|…|[,;/]/.test(text)) return "punctuation";
  if (/^[-.]|[-.]$/.test(text)) return "edge";
  return null;
}

function nearMax(a: number, b: number): number {
  return Math.min(a, b) >= NEAR_LONG_CHARS ? 2 : 1;
}

interface TypoCandidate {
  target: string;
  /** A dictionary word (else a History token). */
  existing: boolean;
  distance: number;
  /** How often it's used: written (a word) or its rows (a token). */
  weight: number;
}

function closerTypo(candidate: TypoCandidate, best: TypoCandidate | null): boolean {
  if (!best) return true;
  if (candidate.distance !== best.distance) return candidate.distance < best.distance;
  if (candidate.existing !== best.existing) return candidate.existing;
  if (candidate.weight !== best.weight) return candidate.weight > best.weight;
  return candidate.target < best.target;
}

/**
 * The checks over a dictionary. Groups come in TIDY_GROUP_ORDER, every one
 * present (empty when nothing matched), each capped at TIDY_GROUP_CAP items.
 */
export function computeTidyGroups(input: TidyInput): TidyGroup[] {
  const now = input.now ?? Date.now();
  const protectedKeys = input.protectedKeys ?? new Set<string>();
  const usageAvailable = input.usageAvailable;
  const aggregates = input.aggregates;
  const common = input.commonWords;

  const infos: Info[] = [];
  const byWord = new Map<string, Info>();
  input.words.forEach((entry, order) => {
    if (typeof entry?.word !== "string" || byWord.has(entry.word)) return;
    const key = dictionaryWordKey(entry.word);
    if (!key) return;
    const createdMs = entry.createdAt ? normalizeDbDate(entry.createdAt).getTime() : NaN;
    const info: Info = {
      ...entry,
      usage: usageAvailable ? entry.usage : null,
      key,
      order,
      createdMs,
      learnedUnpinned: entry.source === "learned" && !entry.pinned,
    };
    infos.push(info);
    byWord.set(entry.word, info);
  });
  const isProtected = (info: Info) => protectedKeys.has(info.key);
  const claimed = new Set<string>();
  const claim = (words: readonly string[]) => words.forEach((word) => claimed.add(word));
  const free = (info: Info) => !claimed.has(info.word);

  const ordinaryKind = (info: Info): "learner" | "heard" | null => {
    if (isProtected(info)) return null;
    if (input.learnerCommonWords.has(info.key)) return "learner";
    const usage = info.usage;
    if (
      common?.has(info.key) &&
      usage &&
      usage.heard >= ORDINARY_MIN_HEARD &&
      usage.missedRows === 0
    ) {
      return "heard";
    }
    return null;
  };

  // Which spelling to keep: written more often, else typed, else the newest.
  const keepFor = (candidates: Info[]): { info: Info; by: "written" | "typed" | "newest" } => {
    const written = (info: Info) => info.usage?.written ?? 0;
    const created = (info: Info) => (Number.isFinite(info.createdMs) ? info.createdMs : -Infinity);
    const sorted = [...candidates].sort(
      (a, b) =>
        (usageAvailable ? written(b) - written(a) : 0) ||
        (a.source === "manual" ? 0 : 1) - (b.source === "manual" ? 0 : 1) ||
        (created(b) > created(a) ? 1 : created(b) < created(a) ? -1 : 0) ||
        a.order - b.order
    );
    const [first, second] = sorted;
    if (usageAvailable && second && written(first) > written(second)) {
      return { info: first, by: "written" };
    }
    if (second && first.source === "manual" && second.source !== "manual") {
      return { info: first, by: "typed" };
    }
    return { info: first, by: "newest" };
  };

  const keepOneItem = (
    group: "variants" | "plurals",
    members: Info[],
    allowNone: boolean
  ): TidyItem | null => {
    const protectedOnes = members.filter(isProtected);
    if (protectedOnes.length > 1) return null;
    const words = members.map((info) => info.word);
    let keep: Info | null;
    let reason: TidyReason;
    if (protectedOnes.length === 1) {
      keep = protectedOnes[0];
      reason = { key: "dictionary.tidy.reasons.keepProtected", params: { word: keep.word } };
    } else if (allowNone) {
      keep = null;
      reason = { key: "dictionary.tidy.reasons.allOrdinary" };
    } else {
      const chosen = keepFor(members);
      keep = chosen.info;
      reason =
        chosen.by === "written"
          ? {
              key: "dictionary.tidy.reasons.keepWritten",
              params: { word: keep.word, count: keep.usage?.written ?? 0 },
            }
          : chosen.by === "typed"
            ? { key: "dictionary.tidy.reasons.keepTyped", params: { word: keep.word } }
            : { key: "dictionary.tidy.reasons.keepNewest", params: { word: keep.word } };
    }
    const leaving = members.filter((info) => info !== keep);
    return {
      id: itemId(group, words),
      group,
      action: "keep-one",
      words,
      keep: keep?.word ?? null,
      allowNone: allowNone && protectedOnes.length === 0,
      locked: protectedOnes.length === 1,
      preselected: leaving.length > 0 && leaving.every((info) => info.learnedUnpinned),
      reason,
    };
  };

  const similar = similarWordGroups(infos.map((info) => info.word));

  // ─── Case and spelling variants ───
  const variants: TidyItem[] = [];
  for (const group of similar) {
    if (group.reason !== "variant") continue;
    const members = group.words
      .map((word) => byWord.get(word))
      .filter((info): info is Info => !!info && free(info));
    if (members.length < 2) continue;
    const item = keepOneItem("variants", members, false);
    if (!item) continue;
    variants.push(item);
    claim(item.words);
  }

  // ─── Plurals ───
  const plurals: TidyItem[] = [];
  for (const group of similar) {
    if (group.reason !== "plural") continue;
    const members = group.words
      .map((word) => byWord.get(word))
      .filter((info): info is Info => !!info && free(info));
    if (members.length < 2) continue;
    const allOrdinary = members.every((info) => ordinaryKind(info) !== null);
    const item = keepOneItem("plurals", members, allOrdinary);
    if (!item) continue;
    plurals.push(item);
    claim(item.words);
  }

  // ─── Split phrases ───
  // Before ordinary words: "Little" + "Buddy" is a name, though each part is
  // an everyday word speech gets right.
  const splitPhrases: TidyItem[] = [];
  if (aggregates) {
    const bySpelling = new Map<string, Info>();
    for (const info of infos) {
      const key = spellingKey(info.word);
      if (key && !bySpelling.has(key)) bySpelling.set(key, info);
    }
    const pairs = [...aggregates.adjacency].sort((x, y) => y.together - x.together);
    for (const pair of pairs) {
      const a = byWord.get(pair?.a);
      const b = byWord.get(pair?.b);
      if (!a || !b || a === b || !free(a) || !free(b)) continue;
      if (isProtected(a) || isProtected(b)) continue;
      if (pair.rarerRows < SPLIT_MIN_ROWS || pair.together < SPLIT_MIN_SHARE * pair.rarerRows) {
        continue;
      }
      const joined = `${a.word} ${b.word}`;
      const existing = bySpelling.get(spellingKey(joined));
      const phrase = existing && existing !== a && existing !== b ? existing.word : joined;
      const phraseExists = !!existing && existing !== a && existing !== b;
      const rarer =
        a.usage && b.usage ? (a.usage.written <= b.usage.written ? a.word : b.word) : b.word;
      splitPhrases.push({
        id: itemId("splitPhrases", [a.word, b.word]),
        group: "splitPhrases",
        action: "add-phrase",
        words: [a.word, b.word],
        phrase,
        phraseExists,
        preselected: a.learnedUnpinned && b.learnedUnpinned,
        reason: phraseExists
          ? { key: "dictionary.tidy.reasons.phraseExists", params: { phrase } }
          : {
              key: "dictionary.tidy.reasons.splitPhrase",
              params: { together: pair.together, count: pair.rarerRows, word: rarer },
            },
      });
      claim([a.word, b.word]);
    }
  }

  // ─── Ordinary words ───
  const ordinary: TidyItem[] = [];
  for (const info of infos) {
    if (!free(info)) continue;
    const kind = ordinaryKind(info);
    if (!kind) continue;
    ordinary.push({
      id: itemId("ordinary", [info.word]),
      group: "ordinary",
      action: "remove",
      words: [info.word],
      preselected: info.learnedUnpinned,
      reason:
        kind === "learner"
          ? { key: "dictionary.tidy.reasons.ordinaryLearner" }
          : {
              key: "dictionary.tidy.reasons.ordinaryHeard",
              params: { count: info.usage?.heard ?? 0 },
            },
    });
    claim([info.word]);
  }

  // ─── Likely typos ───
  const typos: TidyItem[] = [];
  const typosAvailable = usageAvailable && !!aggregates;
  if (typosAvailable) {
    const tokensByLength = new Map<number, DictionaryTidyToken[]>();
    for (const entry of aggregates.frequentTokens) {
      if (!entry || typeof entry.token !== "string" || entry.rows < TYPO_MIN_TOKEN_ROWS) continue;
      const length = entry.token.length;
      const bucket = tokensByLength.get(length);
      if (bucket) bucket.push(entry);
      else tokensByLength.set(length, [entry]);
    }
    for (const info of infos) {
      if (!free(info) || info.source !== "learned" || isProtected(info)) continue;
      if (common?.has(info.key)) continue;
      const usage = info.usage;
      if (!usage || usage.heard + usage.written > TYPO_MAX_USES) continue;
      // The closest: the smallest distance, a dictionary word before a History
      // token, then the one used most, then A–Z.
      let best: TypoCandidate | null = null;
      for (const other of infos) {
        if (other === info || other.key === info.key) continue;
        if (Math.abs(other.key.length - info.key.length) > 2) continue;
        const max = nearMax(info.key.length, other.key.length);
        const distance = editDistance(info.key, other.key, max);
        if (distance >= 1 && distance <= max) {
          const candidate = {
            target: other.word,
            existing: true,
            distance,
            weight: other.usage?.written ?? 0,
          };
          if (closerTypo(candidate, best)) best = candidate;
        }
      }
      const tokens = usageTokens(info.key);
      if (tokens.length === 1 && tokens[0] === info.key) {
        for (let length = info.key.length - 2; length <= info.key.length + 2; length += 1) {
          const max = nearMax(info.key.length, length);
          if (Math.abs(length - info.key.length) > max) continue;
          for (const entry of tokensByLength.get(length) ?? []) {
            if (entry.token === info.key) continue;
            const distance = editDistance(info.key, entry.token, max);
            if (distance >= 1 && distance <= max) {
              const candidate = {
                target: entry.token,
                existing: false,
                distance,
                weight: entry.rows,
              };
              if (closerTypo(candidate, best)) best = candidate;
            }
          }
        }
      }
      if (!best) continue;
      const found: TypoCandidate = best;
      typos.push(
        found.existing
          ? {
              id: itemId("typos", [info.word]),
              group: "typos",
              action: "respell",
              words: [info.word],
              to: found.target,
              toExisting: true,
              preselected: info.learnedUnpinned,
              reason: { key: "dictionary.tidy.reasons.typoWord", params: { target: found.target } },
            }
          : {
              id: itemId("typos", [info.word]),
              group: "typos",
              action: "remove",
              words: [info.word],
              to: matchCase(info.word, found.target),
              preselected: info.learnedUnpinned,
              reason: {
                key: "dictionary.tidy.reasons.typoToken",
                params: { target: found.target, count: found.weight },
              },
            }
      );
      claim([info.word]);
    }
  }

  // ─── Fragments ───
  const fragments: TidyItem[] = [];
  for (const info of infos) {
    if (!free(info) || isProtected(info)) continue;
    const kind = fragmentKind(info.word);
    if (!kind) continue;
    fragments.push({
      id: itemId("fragments", [info.word]),
      group: "fragments",
      action: "remove",
      words: [info.word],
      preselected: info.learnedUnpinned,
      reason: { key: `dictionary.tidy.reasons.fragment.${kind}` },
    });
    claim([info.word]);
  }

  // ─── Never heard in 90 days (informational: any group's words too) ───
  const neverHeard: TidyItem[] = [];
  if (usageAvailable) {
    for (const info of infos) {
      const usage = info.usage;
      if (info.source !== "learned" || isProtected(info) || !usage) continue;
      if (usage.heard !== 0 || usage.written !== 0) continue;
      if (!Number.isFinite(info.createdMs)) continue;
      if (now - info.createdMs <= NEVER_HEARD_MIN_AGE_DAYS * DAY_MS) continue;
      neverHeard.push({
        id: itemId("neverHeard", [info.word]),
        group: "neverHeard",
        action: "remove",
        words: [info.word],
        preselected: false,
        reason: {
          key: "dictionary.tidy.reasons.neverHeard",
          params: { createdAt: info.createdAt ?? "" },
        },
      });
    }
  }

  const group = (
    kind: TidyGroupKind,
    items: TidyItem[],
    unavailable: TidyGroup["unavailable"] = null
  ): TidyGroup => ({
    kind,
    items: items.slice(0, TIDY_GROUP_CAP),
    total: items.length,
    unavailable,
    informational: kind === "neverHeard",
  });
  return [
    group("variants", variants),
    group("plurals", plurals),
    group("splitPhrases", splitPhrases, aggregates ? null : "history"),
    group("ordinary", ordinary, usageAvailable ? null : "partial"),
    group("typos", typos, typosAvailable ? null : "history"),
    group("fragments", fragments),
    group("neverHeard", neverHeard, usageAvailable ? null : "history"),
  ];
}

/** Items that start selected, across every group. */
export function preselectedTidyItems(groups: readonly TidyGroup[]): TidyItem[] {
  return groups.flatMap((group) => group.items.filter((item) => item.preselected));
}

/** The words the non-informational groups name (the "N words need a look" count). */
export function tidyWordCount(groups: readonly TidyGroup[]): number {
  const words = new Set<string>();
  for (const group of groups) {
    if (group.informational) continue;
    for (const item of group.items) for (const word of item.words) words.add(word);
  }
  return words.size;
}

/** What an item's user choice does: "keep" a spelling (keep-one) or "change" instead of remove. */
export interface TidyChoice {
  /** keep-one: the spelling to keep; null keeps none. Defaults to the item's. */
  keep?: string | null;
  /** A likely typo: change it to `to` instead of removing it. */
  respell?: boolean;
}

/** The batch operations one item applies, with the user's choice. */
export function tidyItemOps(item: TidyItem, choice: TidyChoice = {}): DictionaryTidyOp[] {
  switch (item.action) {
    case "remove":
      if (choice.respell && item.to) {
        return [{ kind: "respell", from: item.words[0], to: item.to }];
      }
      return [{ kind: "remove", words: [...item.words] }];
    case "keep-one": {
      const keep = item.locked
        ? (item.keep ?? null)
        : choice.keep !== undefined
          ? choice.keep
          : (item.keep ?? null);
      if (keep === null) {
        return item.allowNone ? [{ kind: "remove", words: [...item.words] }] : [];
      }
      if (!item.words.includes(keep)) return [];
      return item.words
        .filter((word) => word !== keep)
        .map((word) => ({ kind: "merge" as const, from: word, into: keep }));
    }
    case "respell":
      return item.to ? [{ kind: "respell", from: item.words[0], to: item.to }] : [];
    case "add-phrase":
      return item.phrase
        ? [{ kind: "add-phrase", phrase: item.phrase, parts: [...item.words] }]
        : [];
    default:
      return [];
  }
}

// ─── Planning a batch ───
// Main runs a batch's operations in the order given, each through the
// dictionary's own operations (database.js, applyDictionaryTidy). Collected
// from several items, the choices could undo each other there: "remove X"
// before "respell typo → X" renames the typo to X, so X is back; a chain
// ("a → b", "b → c") in the wrong order re-creates b. planTidyBatch gives every
// word one fate first, by exact spelling (main finds a word by its exact
// spelling before its key), and emits a batch with no such order:
//   1. each phrase to add (adding it removes its parts);
//   2. every surviving move as a respell from its exact source to its final
//      destination (main renames when that's free and merges into it when it
//      exists, so a merge never runs before its target does);
//   3. one removal with every removed word, so Undo restores them together.

/** A batch as main should run it, and what it left out. */
export interface TidyBatchPlan {
  ops: DictionaryTidyOp[];
  /** Words kept because the batch's choices for them conflict. */
  skipped: number;
}

type TidyFate = { kind: "remove" } | { kind: "move"; to: string } | { kind: "conflict" };

/** Where a spelling lands: a word the batch or the dictionary knows, or a new spelling. */
interface TidyHop {
  node: string | null;
  spelling: string;
}

/**
 * The batch main should run for these choices. Each word named gets one fate:
 * removed (a removal, or a phrase's part), moved (respell or merge), or kept.
 * - A removal and a move of the same word: the removal wins. Duplicates collapse.
 * - Two moves of one word to different places, or moves in a cycle ("a → b",
 *   "b → a", longer ones too): conflicting choices, all skipped, the words
 *   kept and counted in `skipped`. Never a move onto itself.
 * - A move follows its destination's own fate to the end (the exact spelling
 *   first; else the one word with its key, as main resolves it, unless that
 *   word is moving to this very spelling too); one that ends at a removed word
 *   becomes a removal of its source.
 * - A phrase to add whose spelling the batch removes or moves isn't added;
 *   its parts are still removed. A move into a part is a move into a removed word.
 * `liveWords` are the dictionary's words (exact spellings) as the page shows them.
 */
export function planTidyBatch(
  ops: readonly DictionaryTidyOp[],
  liveWords: readonly string[] = []
): TidyBatchPlan {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const order = new Map<string, number>();
  const see = (word: string) => {
    if (!order.has(word)) order.set(word, order.size);
  };
  const removed = new Set<string>();
  const destinations = new Map<string, string[]>();
  const phrases = new Map<string, string[]>();

  for (const op of Array.isArray(ops) ? ops : []) {
    switch (op?.kind) {
      case "remove":
        for (const word of (Array.isArray(op.words) ? op.words : []).map(text)) {
          if (!word) continue;
          see(word);
          removed.add(word);
        }
        break;
      case "merge":
      case "respell": {
        const from = text(op.from);
        const to = text(op.kind === "merge" ? op.into : op.to);
        if (!from || !to || from === to) break;
        see(from);
        const list = destinations.get(from) ?? [];
        if (!list.includes(to)) list.push(to);
        destinations.set(from, list);
        break;
      }
      case "add-phrase": {
        const phrase = text(op.phrase);
        const phraseKey = dictionaryWordKey(phrase);
        if (!phraseKey) break;
        const list = phrases.get(phrase) ?? [];
        for (const part of (Array.isArray(op.parts) ? op.parts : []).map(text)) {
          // Main never removes a part spelled like the phrase.
          if (!part || dictionaryWordKey(part) === phraseKey) continue;
          see(part);
          removed.add(part);
          if (!list.includes(part)) list.push(part);
        }
        if (list.length > 0) phrases.set(phrase, list);
        break;
      }
      default:
        break;
    }
  }

  // Every spelling the batch or the dictionary knows, by key.
  const known = new Set<string>([...liveWords.map(text).filter(Boolean), ...order.keys()]);
  const byKey = new Map<string, string[]>();
  for (const word of known) {
    const key = dictionaryWordKey(word);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(word);
    else byKey.set(key, [word]);
  }
  const resolve = (spelling: string, from: string | null): TidyHop => {
    if (known.has(spelling)) return { node: spelling, spelling };
    const candidates = (byKey.get(dictionaryWordKey(spelling)) ?? []).filter(
      (word) => word !== from
    );
    // No word with its key: a new spelling. Several: main picks one; removals run last.
    if (candidates.length !== 1) return { node: null, spelling };
    const [node] = candidates;
    const own = destinations.get(node);
    if (!removed.has(node) && own?.length === 1 && own[0] === spelling) {
      // That word moves to this very spelling too: both end there.
      return { node: null, spelling };
    }
    return { node, spelling };
  };

  // Fates: a removal wins; destinations landing on one word are one choice.
  const fates = new Map<string, TidyFate>();
  for (const word of order.keys()) {
    if (removed.has(word)) {
      fates.set(word, { kind: "remove" });
      continue;
    }
    const list = destinations.get(word);
    if (!list) continue;
    const landings = new Map<string, string>();
    for (const to of list) {
      const hop = resolve(to, word);
      if (hop.node === word) continue;
      const landing = hop.node !== null ? `word:${hop.node}` : `new:${hop.spelling}`;
      if (!landings.has(landing)) landings.set(landing, to);
    }
    if (landings.size === 0) continue;
    fates.set(
      word,
      landings.size > 1 ? { kind: "conflict" } : { kind: "move", to: [...landings.values()][0] }
    );
  }

  // Each move's next word (null: a new spelling or nothing the batch moves).
  const edges = new Map<string, TidyHop>();
  for (const [word, fate] of fates) {
    if (fate.kind === "move") edges.set(word, resolve(fate.to, word));
  }
  const isMove = (word: string | null): word is string =>
    word !== null && fates.get(word)?.kind === "move";

  // Cycles: every move in one is a conflict.
  const visit = new Map<string, "open" | "done">();
  for (const start of edges.keys()) {
    if (visit.has(start)) continue;
    const path: string[] = [];
    let current: string | null = start;
    while (isMove(current) && !visit.has(current)) {
      visit.set(current, "open");
      path.push(current);
      current = edges.get(current)?.node ?? null;
    }
    if (current !== null && visit.get(current) === "open") {
      for (const word of path.slice(path.indexOf(current))) fates.set(word, { kind: "conflict" });
    }
    for (const word of path) visit.set(word, "done");
  }

  // Final destinations: followed to a kept word or a new spelling, or to a removal.
  const moves: { from: string; to: string; depth: number; index: number }[] = [];
  const converted = new Set<string>();
  for (const [word, fate] of fates) {
    if (fate.kind !== "move") continue;
    let current = word;
    let depth = 0;
    let to: string | null = null;
    for (;;) {
      const hop = edges.get(current) ?? { node: null, spelling: current };
      depth += 1;
      if (hop.node === null) {
        to = hop.spelling;
        break;
      }
      const next = fates.get(hop.node);
      if (next?.kind === "remove") break;
      if (next?.kind === "move") {
        current = hop.node;
        continue;
      }
      to = hop.node;
      break;
    }
    if (to === null) converted.add(word);
    else if (to !== word) moves.push({ from: word, to, depth, index: order.get(word) ?? 0 });
  }
  // The word a chain's last step renames goes first; the rest then merge into it.
  moves.sort((a, b) => a.depth - b.depth || a.index - b.index);

  // Phrases: not added when the batch removes or moves the phrase itself.
  const phraseOps: DictionaryTidyOp[] = [];
  const coveredParts = new Set<string>();
  for (const [phrase, parts] of phrases) {
    const hop = resolve(phrase, null);
    const own = hop.node !== null ? fates.get(hop.node) : undefined;
    if (own?.kind === "remove" || own?.kind === "move") continue;
    phraseOps.push({ kind: "add-phrase", phrase, parts: [...parts] });
    for (const part of parts) coveredParts.add(part);
  }

  const removals = [...order.keys()].filter(
    (word) => converted.has(word) || (fates.get(word)?.kind === "remove" && !coveredParts.has(word))
  );
  let skipped = 0;
  for (const fate of fates.values()) if (fate.kind === "conflict") skipped += 1;

  return {
    ops: [
      ...phraseOps,
      ...moves.map(({ from, to }) => ({ kind: "respell" as const, from, to })),
      ...(removals.length > 0 ? [{ kind: "remove" as const, words: removals }] : []),
    ],
    skipped,
  };
}
