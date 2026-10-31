// The Dictionary page's list as data: one item per dictionary word with what
// the page shows about it (source, pin, when it was added, heard/written, its
// speech-to-text coverage and place in the send order), the filters and their
// counts, the sorts, and where the send order's dividers go. Pure, so the
// view's rules are tested without rendering; never logged (the user's words).

import { dictionaryWordKey } from "./dictionaryWordKey.js";
import { normalizeDbDate } from "./dateFormatting";
import type { HintCoverage, HintSource } from "./dictionaryHints";
import type { DictionaryEntry, DictionaryWordUsage } from "../types/electron";

export type DictionaryFilter =
  "all" | "typed" | "learned" | "pinned" | "notSent" | "neverHeard" | "addedThisWeek";

export const DICTIONARY_FILTERS: readonly DictionaryFilter[] = [
  "all",
  "typed",
  "learned",
  "pinned",
  "notSent",
  "neverHeard",
  "addedThisWeek",
];

export type DictionarySort = "sendOrder" | "recent" | "alpha" | "mostHeard" | "leastHeard";

export const DICTIONARY_SORTS: readonly DictionarySort[] = [
  "sendOrder",
  "recent",
  "alpha",
  "mostHeard",
  "leastHeard",
];

/** Sorts and filters that need the heard/written counts. */
export const USAGE_SORTS: ReadonlySet<DictionarySort> = new Set(["mostHeard", "leastHeard"]);
export const USAGE_FILTERS: ReadonlySet<DictionaryFilter> = new Set(["neverHeard"]);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DictionaryUsageCounts {
  heard: number;
  written: number;
  missedRows: number;
}

export interface DictionaryListItem {
  word: string;
  key: string;
  source: "manual" | "learned";
  pinned: boolean;
  /** When it was added, as stored; null when unknown. */
  createdAt: string | null;
  /** The same in ms; NaN when unknown. */
  createdMs: number;
  /** Where the current speech setup puts it. */
  coverage: HintCoverage;
  /** Its place in the hint list's priority order (1 first); null when it isn't in it. */
  rank: number | null;
  /** The tier it's sent in. */
  hintSource: HintSource | null;
  /** Heard and written over 90 days; null when the counts aren't available. */
  usage: DictionaryUsageCounts | null;
  /** Its place in the stored dictionary. */
  order: number;
}

export interface CoverageEntry {
  term: string;
  source: HintSource;
  coverage: HintCoverage;
  rank: number;
}

export interface BuildListInput {
  /** The stored words, in stored order (the settings store's list). */
  words: readonly string[];
  /** Main's entries (source and dates); a word missing here reads as typed. */
  entries?: readonly DictionaryEntry[] | null;
  /** Lowercased learned words, when the entries haven't been read. */
  learned?: ReadonlySet<string> | null;
  pinned?: ReadonlySet<string> | null;
  /** buildSttHintFields' entries for the current speech setup. */
  coverage?: readonly CoverageEntry[] | null;
  /** The heard/written counts; null when they aren't available. */
  usage?: readonly DictionaryWordUsage[] | null;
  /** Keys never listed (the assistant's name). */
  hiddenKeys?: ReadonlySet<string>;
}

export function buildDictionaryListItems({
  words,
  entries,
  learned,
  pinned,
  coverage,
  usage,
  hiddenKeys,
}: BuildListInput): DictionaryListItem[] {
  const entryByWord = new Map<string, DictionaryEntry>();
  const entryByKey = new Map<string, DictionaryEntry>();
  for (const entry of entries ?? []) {
    if (typeof entry?.word !== "string") continue;
    if (!entryByWord.has(entry.word)) entryByWord.set(entry.word, entry);
    const key = dictionaryWordKey(entry.word);
    if (key && !entryByKey.has(key)) entryByKey.set(key, entry);
  }
  const coverageByKey = new Map<string, CoverageEntry>();
  for (const entry of coverage ?? []) {
    const key = dictionaryWordKey(entry.term);
    if (key && !coverageByKey.has(key)) coverageByKey.set(key, entry);
  }
  const usageByKey = usage ? new Map<string, DictionaryWordUsage>() : null;
  for (const counts of usage ?? []) {
    const key = dictionaryWordKey(counts.word);
    if (key && usageByKey && !usageByKey.has(key)) usageByKey.set(key, counts);
  }
  const items: DictionaryListItem[] = [];
  const seen = new Set<string>();
  words.forEach((word, order) => {
    if (typeof word !== "string" || seen.has(word)) return;
    const key = dictionaryWordKey(word);
    if (!key || hiddenKeys?.has(key)) return;
    seen.add(word);
    const entry = entryByWord.get(word) ?? entryByKey.get(key);
    const isLearned = entry
      ? entry.source === "learned"
      : !!learned?.has(word.trim().toLowerCase());
    const createdAt = entry?.createdAt ?? null;
    const createdMs = createdAt ? normalizeDbDate(createdAt).getTime() : NaN;
    const hint = coverageByKey.get(key);
    const counts = usageByKey?.get(key);
    items.push({
      word,
      key,
      source: isLearned ? "learned" : "manual",
      pinned: !!pinned?.has(key),
      createdAt,
      createdMs,
      coverage: hint?.coverage ?? "notSent",
      rank: hint?.rank ?? null,
      hintSource: hint?.source ?? null,
      usage: usageByKey
        ? {
            heard: counts?.heard ?? 0,
            written: counts?.written ?? 0,
            missedRows: counts?.missedRows ?? 0,
          }
        : null,
      order,
    });
  });
  return items;
}

/** Whether an item passes a filter. Usage filters pass nothing without counts. */
export function matchesDictionaryFilter(
  item: DictionaryListItem,
  filter: DictionaryFilter,
  now: number = Date.now()
): boolean {
  switch (filter) {
    case "typed":
      return item.source === "manual";
    case "learned":
      return item.source === "learned";
    case "pinned":
      return item.pinned;
    case "notSent":
      return item.coverage === "notSent";
    case "neverHeard":
      // Not in a dictation for 90 days: neither heard nor written.
      return !!item.usage && item.usage.heard === 0 && item.usage.written === 0;
    case "addedThisWeek":
      return Number.isFinite(item.createdMs) && now - item.createdMs <= WEEK_MS;
    default:
      return true;
  }
}

/** Each filter's count over the whole list (the chips). */
export function dictionaryFilterCounts(
  items: readonly DictionaryListItem[],
  now: number = Date.now()
): Record<DictionaryFilter, number> {
  const counts = Object.fromEntries(DICTIONARY_FILTERS.map((f) => [f, 0])) as Record<
    DictionaryFilter,
    number
  >;
  for (const item of items) {
    for (const filter of DICTIONARY_FILTERS) {
      if (matchesDictionaryFilter(item, filter, now)) counts[filter] += 1;
    }
  }
  return counts;
}

/** Whether a word contains the search (case-insensitive, as the key compares). */
export function matchesDictionarySearch(item: DictionaryListItem, query: string): boolean {
  const needle = dictionaryWordKey(query);
  return !needle || item.key.includes(needle);
}

const COVERAGE_ORDER: Record<HintCoverage, number> = { read: 0, unread: 1, notSent: 2 };

function makeCollator(locale?: string): Intl.Collator {
  return new Intl.Collator(locale, { sensitivity: "base", numeric: true });
}

/**
 * The list in one order. Send order: what the model reads first (likely
 * read, then sent but likely not read, then not sent), each by its place in
 * the hint list's priority order. Heard sorts fall back to send order
 * without counts.
 */
export function sortDictionaryItems(
  items: readonly DictionaryListItem[],
  sort: DictionarySort,
  locale?: string
): DictionaryListItem[] {
  const collator = makeCollator(locale);
  const byAlpha = (a: DictionaryListItem, b: DictionaryListItem) =>
    collator.compare(a.word, b.word) || a.order - b.order;
  const bySend = (a: DictionaryListItem, b: DictionaryListItem) =>
    COVERAGE_ORDER[a.coverage] - COVERAGE_ORDER[b.coverage] ||
    (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
    a.order - b.order;
  const list = [...items];
  const hasUsage = list.some((item) => item.usage);
  switch (sort) {
    case "recent":
      return list.sort((a, b) => {
        const am = Number.isFinite(a.createdMs) ? a.createdMs : -Infinity;
        const bm = Number.isFinite(b.createdMs) ? b.createdMs : -Infinity;
        return bm - am || b.order - a.order;
      });
    case "alpha":
      return list.sort(byAlpha);
    case "mostHeard":
      if (!hasUsage) return list.sort(bySend);
      return list.sort(
        (a, b) =>
          (b.usage?.heard ?? 0) - (a.usage?.heard ?? 0) ||
          (b.usage?.written ?? 0) - (a.usage?.written ?? 0) ||
          byAlpha(a, b)
      );
    case "leastHeard":
      if (!hasUsage) return list.sort(bySend);
      return list.sort(
        (a, b) =>
          (a.usage?.heard ?? 0) - (b.usage?.heard ?? 0) ||
          (a.usage?.written ?? 0) - (b.usage?.written ?? 0) ||
          byAlpha(a, b)
      );
    default:
      return list.sort(bySend);
  }
}

export type DictionaryDividerKind = "unread" | "notSent";

export interface DictionaryDivider {
  /** The divider goes before the item at this index. */
  index: number;
  kind: DictionaryDividerKind;
  /** How many listed items are past it with this coverage. */
  count: number;
}

/**
 * Where the speech model stops, over items in send order: before the first
 * sent-but-unread item ("stops reading here") and before the first unsent
 * one ("not sent beyond here"), only where something precedes it.
 */
export function sendOrderDividers(items: readonly DictionaryListItem[]): DictionaryDivider[] {
  const dividers: DictionaryDivider[] = [];
  for (const kind of ["unread", "notSent"] as const) {
    const index = items.findIndex((item) => item.coverage === kind);
    if (index > 0) {
      dividers.push({
        index,
        kind,
        count: items.filter((item) => item.coverage === kind).length,
      });
    }
  }
  return dividers;
}

export interface DictionaryListQuery {
  filter: DictionaryFilter;
  sort: DictionarySort;
  search: string;
  now?: number;
  locale?: string;
}

/** The items shown: filtered, searched and sorted, with the send order's dividers. */
export function viewDictionaryList(
  items: readonly DictionaryListItem[],
  { filter, sort, search, now = Date.now(), locale }: DictionaryListQuery
): { items: DictionaryListItem[]; dividers: DictionaryDivider[] } {
  const shown = sortDictionaryItems(
    items.filter(
      (item) => matchesDictionaryFilter(item, filter, now) && matchesDictionarySearch(item, search)
    ),
    sort,
    locale
  );
  const sendOrder = sort === "sendOrder" || (USAGE_SORTS.has(sort) && !shown.some((i) => i.usage));
  return { items: shown, dividers: sendOrder ? sendOrderDividers(shown) : [] };
}
