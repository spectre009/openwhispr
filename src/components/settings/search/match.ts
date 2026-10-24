import type { SettingDescriptorKind } from "./types";

/**
 * Settings search matching, kept pure: every token of the query has to match
 * somewhere, case- and diacritic-insensitive. A token scores by where it
 * matched: the title's start or a word in it (the UI language's title or the
 * English one), anywhere in the title, an alias, the current value, the
 * description, the breadcrumb.
 */

export interface SettingsSearchUnavailable {
  /** Why it can't be opened now, translated. */
  reason: string;
  /** The descriptor id that has to change first. */
  prerequisite?: string;
  prerequisiteTitle?: string;
}

export interface SettingsSearchEntry {
  id: string;
  kind: SettingDescriptorKind;
  /** The Settings page it opens (its icon heads the result); none for app pages. */
  pageId?: string;
  /** Its top-level nav item (a page or a parent like Dictation), or "elsewhere". */
  groupId: string;
  groupLabel: string;
  groupOrder: number;
  /** Registry order, the tie-breaker. */
  order: number;
  title: string;
  /** The English title, so English terms work in every UI language. */
  titleEn: string;
  description: string;
  /** Breadcrumb under the title: parent › page › block. */
  path: string[];
  aliases: string[];
  value?: string;
  /** Matched with the value, not shown (model ids, English names). */
  valueTerms?: string[];
  unavailable?: SettingsSearchUnavailable;
}

export interface SettingsSearchResult {
  entry: SettingsSearchEntry;
  score: number;
}

export interface SettingsSearchGroup {
  id: string;
  label: string;
  results: SettingsSearchResult[];
}

export interface SettingsSearchOutcome {
  groups: SettingsSearchGroup[];
  /** Every result in display order (groups in nav order, best first within each). */
  results: SettingsSearchResult[];
  /** Index in `results` of the best match, the one Enter opens. -1 when empty. */
  bestIndex: number;
}

const SCORE = {
  titleWord: 10,
  title: 7,
  alias: 6,
  value: 5,
  description: 3,
  path: 1,
  phrase: 5,
  exactTitle: 5,
  page: 1,
  unavailable: -1,
} as const;

const COMBINING_MARKS = /\p{M}+/gu;

/** Lowercase, compatibility-decomposed, without diacritics: "Résumé" → "resume". */
export function normalizeSearchText(text: string | undefined | null): string {
  if (!text) return "";
  return text.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();
}

export function tokenizeQuery(query: string): string[] {
  return normalizeSearchText(query)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

const isWordChar = (char: string | undefined) => !!char && /[\p{L}\p{N}]/u.test(char);

/** At the start of the text or of a word in it. */
function matchesWordStart(haystack: string, needle: string): boolean {
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    if (index === 0 || !isWordChar(haystack[index - 1])) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

interface PreparedEntry {
  entry: SettingsSearchEntry;
  titles: string[];
  aliases: string[];
  value: string;
  description: string;
  path: string;
}

const prepared = new WeakMap<SettingsSearchEntry, PreparedEntry>();

function prepare(entry: SettingsSearchEntry): PreparedEntry {
  let result = prepared.get(entry);
  if (!result) {
    result = {
      entry,
      titles: [normalizeSearchText(entry.title), normalizeSearchText(entry.titleEn)],
      aliases: entry.aliases.map(normalizeSearchText),
      value: normalizeSearchText([entry.value, ...(entry.valueTerms ?? [])].join(" ")),
      description: normalizeSearchText(entry.description),
      path: normalizeSearchText(entry.path.join(" ")),
    };
    prepared.set(entry, result);
  }
  return result;
}

function scoreToken(entry: PreparedEntry, token: string): number {
  let best = 0;
  for (const title of entry.titles) {
    if (matchesWordStart(title, token)) return SCORE.titleWord;
    if (title.includes(token)) best = SCORE.title;
  }
  if (best) return best;
  if (entry.aliases.some((alias) => alias.includes(token))) return SCORE.alias;
  if (entry.value.includes(token)) return SCORE.value;
  if (entry.description.includes(token)) return SCORE.description;
  if (entry.path.includes(token)) return SCORE.path;
  return 0;
}

/** The entry's score for these tokens, or null when one of them matches nowhere. */
export function scoreSettingsEntry(entry: SettingsSearchEntry, tokens: string[]): number | null {
  if (tokens.length === 0) return null;
  const target = prepare(entry);
  let score = 0;
  for (const token of tokens) {
    const tokenScore = scoreToken(target, token);
    if (!tokenScore) return null;
    score += tokenScore;
  }
  const phrase = tokens.join(" ");
  if (target.titles.some((title) => title === phrase)) score += SCORE.exactTitle;
  if (
    tokens.length > 1 &&
    (target.titles.some((title) => title.includes(phrase)) ||
      target.aliases.some((alias) => alias.includes(phrase)))
  ) {
    score += SCORE.phrase;
  }
  if (entry.kind === "page") score += SCORE.page;
  if (entry.unavailable) score += SCORE.unavailable;
  return score;
}

const byScore = (a: SettingsSearchResult, b: SettingsSearchResult) =>
  b.score - a.score || a.entry.order - b.entry.order;

/** The DOM id of a result in the results listbox (the field's aria-activedescendant). */
export const settingsSearchOptionId = (listId: string, index: number) => `${listId}-${index}`;

/** Matches by score, best first: the Ctrl+K palette's Settings group. */
export function rankSettings(
  index: readonly SettingsSearchEntry[],
  query: string,
  limit = Infinity
): SettingsSearchResult[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const results: SettingsSearchResult[] = [];
  for (const entry of index) {
    const score = scoreSettingsEntry(entry, tokens);
    if (score !== null) results.push({ entry, score });
  }
  return results.sort(byScore).slice(0, limit);
}

/** Matches grouped by top-level nav item in nav order, best first within a group. */
export function searchSettings(
  index: readonly SettingsSearchEntry[],
  query: string,
  { limit = 80 }: { limit?: number } = {}
): SettingsSearchOutcome {
  const ranked = rankSettings(index, query, limit);
  const groups = new Map<string, SettingsSearchGroup & { order: number }>();
  for (const result of ranked) {
    const { groupId, groupLabel, groupOrder } = result.entry;
    let group = groups.get(groupId);
    if (!group) {
      group = { id: groupId, label: groupLabel, order: groupOrder, results: [] };
      groups.set(groupId, group);
    }
    group.results.push(result);
  }
  const ordered = [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ id, label, results }) => ({ id, label, results }));
  const results = ordered.flatMap((group) => group.results);
  const best = ranked[0];
  return { groups: ordered, results, bestIndex: best ? results.indexOf(best) : -1 };
}

/**
 * Source ranges of `text` the query's tokens match, merged, for highlighting.
 * Works on the normalized text and maps back, so "resume" marks "Résumé".
 * Single ASCII letters and digits are skipped: they'd mark half the title.
 */
export function highlightRanges(text: string, query: string): Array<[number, number]> {
  const tokens = tokenizeQuery(query).filter((token) => !/^[a-z0-9]$/.test(token));
  if (!text || tokens.length === 0) return [];
  let normalized = "";
  const sourceStart: number[] = [];
  const sourceEnd: number[] = [];
  let offset = 0;
  for (const char of text) {
    const folded = normalizeSearchText(char);
    for (let i = 0; i < folded.length; i++) {
      sourceStart.push(offset);
      sourceEnd.push(offset + char.length);
    }
    normalized += folded;
    offset += char.length;
  }
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    let index = normalized.indexOf(token);
    while (index >= 0) {
      ranges.push([sourceStart[index], sourceEnd[index + token.length - 1]]);
      index = normalized.indexOf(token, index + token.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
