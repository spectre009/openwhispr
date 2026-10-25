// What a History review suggests for the step it blames: which fix applies,
// the canonical form a glossary correction would write (from the review's
// correction, aligned with the words the user selected) and literal checks
// for a test case (from what the correction adds and removes). Pure; the user
// confirms every suggestion before anything is saved.

import { diffText, tokenize, type TextDiffPart } from "./textDiff";
import type { GlossaryRule } from "./glossary";
import type { HistoryReviewStage, TranscriptionStepRecord } from "../types/electron";

export type HistoryFixKind = "recognition" | "glossary" | "cleanup" | "style" | "delivery";

/** At most this many suggested checks of each kind. */
export const MAX_SUGGESTED_CHECKS = 3;
const MAX_PHRASE_WORDS = 6;
const MAX_PHRASE_CHARS = 80;

// Spaces and sentence punctuation, which never start or end a spelling or a check.
const EDGE_CHAR = /[\s.,;:!?…，。！？；：、]/u;
const EDGES = /^[\s.,;:!?…，。！？；：、]+|[\s.,;:!?…，。！？；：、]+$/gu;

const fold = (text: string) => text.toLowerCase();
const isWordToken = (token: string) => /[\p{L}\p{N}]/u.test(token);
const isSpaceToken = (token: string) => /^\s+$/u.test(token);
const breaksLine = (token: string) => /[\n\r]/.test(token);

/** The recorded step a review blames (its seq), or null: Delivery, Not sure, or not one of the row's steps. */
export function blamedStepIndex(
  stage: HistoryReviewStage | null | undefined,
  steps: readonly TranscriptionStepRecord[]
): number | null {
  if (!stage || typeof stage.seq !== "number" || !Number.isInteger(stage.seq)) return null;
  return steps[stage.seq]?.kind === stage.kind ? stage.seq : null;
}

/** The fix a blamed step suggests; null for Not sure and for steps without one. */
export function historyFixKind(
  stage: HistoryReviewStage | null | undefined,
  steps: readonly TranscriptionStepRecord[]
): HistoryFixKind | null {
  if (!stage) return null;
  if (stage.kind === "delivery") return "delivery";
  if (blamedStepIndex(stage, steps) === null) return null;
  switch (stage.kind) {
    case "stt":
      return "recognition";
    case "glossary":
      return "glossary";
    case "cleanup":
      return "cleanup";
    case "style":
      return "style";
    default:
      return null;
  }
}

/** A selected span without the spaces and sentence punctuation at its edges; null when nothing is left. */
export function trimSpan(
  text: string,
  start: number,
  end: number
): { start: number; end: number } | null {
  if (typeof text !== "string" || start < 0 || end > text.length) return null;
  while (start < end && EDGE_CHAR.test(text[start])) start += 1;
  while (end > start && EDGE_CHAR.test(text[end - 1])) end -= 1;
  return start < end ? { start, end } : null;
}

/** Selected words as a spelling or a check: one space between words, no edge punctuation. */
export function cleanPhrase(text: string): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").replace(EDGES, "") : "";
}

/** How main compares glossary spellings: spaces collapsed, any case. */
export function glossarySpellingKey(text: string): string {
  return typeof text === "string" ? fold(text.trim().replace(/\s+/g, " ")) : "";
}

/** The rule that already has this spelling, if any. */
export function glossaryRuleWithSpelling(
  rules: readonly GlossaryRule[],
  spelling: string
): GlossaryRule | null {
  const key = glossarySpellingKey(spelling);
  if (!key) return null;
  return (
    rules.find(
      (rule) =>
        Array.isArray(rule.spellings) &&
        rule.spellings.some((candidate) => glossarySpellingKey(candidate.text) === key)
    ) ?? null
  );
}

export interface FiredGlossaryRule {
  ruleId: string;
  from: string | null;
  to: string | null;
}

/** The glossary rules that fired on a dictation (its glossary steps' detail), once each. */
export function firedGlossaryRules(steps: readonly TranscriptionStepRecord[]): FiredGlossaryRule[] {
  const seen = new Set<string>();
  const fired: FiredGlossaryRule[] = [];
  for (const step of steps) {
    if (step.kind !== "glossary" || step.outcome !== "ok") continue;
    for (const rule of step.detail?.rulesFired ?? []) {
      if (!rule?.ruleId || seen.has(rule.ruleId)) continue;
      seen.add(rule.ruleId);
      fired.push({ ruleId: rule.ruleId, from: rule.from ?? null, to: rule.to ?? null });
    }
  }
  return fired;
}

/**
 * The words of `correction` that replace `output.slice(start, end)`, for a
 * glossary correction's canonical form. Null unless that's a clean
 * replacement: the selection is whole words, doesn't cut a changed run in
 * two, and the correction writes something other than the selected words
 * (a change of case alone isn't a correction the glossary can make).
 */
export function alignCorrection(
  output: string,
  start: number,
  end: number,
  correction: string
): string | null {
  if (typeof output !== "string" || typeof correction !== "string" || !correction.trim()) {
    return null;
  }
  const span = trimSpan(output, start, end);
  if (!span) return null;
  ({ start, end } = span);

  const bounds = new Set<number>([0]);
  let offset = 0;
  for (const token of tokenize(output)) {
    offset += token.length;
    bounds.add(offset);
  }
  if (!bounds.has(start) || !bounds.has(end)) return null;

  const diff = diffText(output, correction);
  if (diff.kind !== "diff") return null;

  let s = 0;
  let c = 0;
  let from: number | null = null;
  let to: number | null = null;
  // The insertion right after a selected deletion is what replaced it.
  let afterSelectedDelete = false;
  for (const part of diff.parts) {
    const sLength =
      part.kind === "insert" ? 0 : part.kind === "case" ? part.was.length : part.text.length;
    const cLength = part.kind === "delete" ? 0 : part.text.length;
    const s0 = s;
    const s1 = s + sLength;
    const c0 = c;
    const c1 = c + cLength;
    s = s1;
    c = c1;

    if (part.kind === "insert") {
      if (afterSelectedDelete || (s0 > start && s0 < end)) {
        if (from === null) from = c0;
        to = c1;
      }
      afterSelectedDelete = false;
      continue;
    }
    afterSelectedDelete = false;
    if (s1 <= start || s0 >= end) continue;

    if (part.kind === "delete") {
      // Only spaces of a deleted run may lie outside the selection.
      if (
        output.slice(s0, Math.max(s0, start)).trim() ||
        output.slice(Math.min(s1, end), s1).trim()
      ) {
        return null;
      }
      if (from === null) from = c0;
      to = c1;
      afterSelectedDelete = true;
      continue;
    }
    // Unchanged (or only recased) text maps one to one.
    if (from === null) from = c0 + Math.min(cLength, Math.max(start, s0) - s0);
    to = c0 + Math.min(cLength, Math.min(end, s1) - s0);
  }
  if (from === null || to === null || to <= from) return null;

  const canonical = cleanPhrase(correction.slice(from, to));
  if (
    !canonical ||
    glossarySpellingKey(canonical) === glossarySpellingKey(output.slice(start, end))
  ) {
    return null;
  }
  return canonical;
}

interface SideToken {
  text: string;
  edited: boolean;
}

// Each text as tokens, marked where the correction changed it.
function diffSides(parts: TextDiffPart[]): { output: SideToken[]; correction: SideToken[] } {
  const output: SideToken[] = [];
  const correction: SideToken[] = [];
  const push = (side: SideToken[], text: string, edited: boolean) => {
    for (const token of tokenize(text)) side.push({ text: token, edited });
  };
  for (const part of parts) {
    if (part.kind === "same") {
      push(output, part.text, false);
      push(correction, part.text, false);
    } else if (part.kind === "case") {
      push(output, part.was, false);
      push(correction, part.text, false);
    } else if (part.kind === "delete") {
      push(output, part.text, true);
    } else {
      push(correction, part.text, true);
    }
  }
  return { output, correction };
}

// The nearest word before or after `index`, across spaces only.
function neighborWord(tokens: SideToken[], index: number, step: 1 | -1): number | null {
  let k = index + step;
  while (
    k >= 0 &&
    k < tokens.length &&
    isSpaceToken(tokens[k].text) &&
    !breaksLine(tokens[k].text)
  ) {
    k += step;
  }
  return k >= 0 && k < tokens.length && isWordToken(tokens[k].text) ? k : null;
}

const joinTokens = (tokens: SideToken[], from: number, to: number) =>
  tokens
    .slice(from, to + 1)
    .map((token) => token.text)
    .join("");

/**
 * Each changed run of words on one side, as a check: a single word takes the
 * word next to it, so it reads as a phrase. A phrase the other text already
 * contains (in any case) would never fail, so it's left out.
 */
function changedPhrases(tokens: SideToken[], other: string): string[] {
  const runs: Array<[number, number]> = [];
  let first = -1;
  let last = -1;
  const close = () => {
    if (first >= 0) runs.push([first, last]);
    first = -1;
    last = -1;
  };
  tokens.forEach((token, index) => {
    if (!token.edited || breaksLine(token.text)) {
      close();
      return;
    }
    if (isWordToken(token.text)) {
      if (first < 0) first = index;
      last = index;
    }
  });
  close();

  const otherFolded = fold(other);
  const phrases: string[] = [];
  for (const [a, b] of runs) {
    const words = tokens.slice(a, b + 1).filter((token) => isWordToken(token.text)).length;
    if (words > MAX_PHRASE_WORDS) continue;
    const candidates = [joinTokens(tokens, a, b)];
    if (words === 1) {
      const next = neighborWord(tokens, b, 1);
      const previous = next === null ? neighborWord(tokens, a, -1) : null;
      if (next !== null) candidates.unshift(joinTokens(tokens, a, next));
      else if (previous !== null) candidates.unshift(joinTokens(tokens, previous, b));
    }
    const pick = candidates.find(
      (phrase) => phrase.length <= MAX_PHRASE_CHARS && !otherFolded.includes(fold(phrase))
    );
    if (pick) phrases.push(pick);
  }
  return phrases;
}

export interface SuggestedChecks {
  /** Words the correction has and the output lacks. */
  mustContain: string[];
  /** Words the output has and the correction dropped. */
  mustNotContain: string[];
}

/**
 * Literal checks a test case could make, from a word diff of what was pasted
 * against the review's correction: words the correction adds must be there,
 * words it removes must not. At most `max` of each, in text order, case as
 * written, each phrase once (in any case) across both lists.
 */
export function suggestTestChecks(
  output: string,
  correction: string,
  { max = MAX_SUGGESTED_CHECKS }: { max?: number } = {}
): SuggestedChecks {
  const none: SuggestedChecks = { mustContain: [], mustNotContain: [] };
  if (typeof output !== "string" || typeof correction !== "string") return none;
  if (!correction.trim() || output === correction) return none;
  const diff = diffText(output, correction);
  if (diff.kind !== "diff" || !diff.changed) return none;
  const sides = diffSides(diff.parts);
  const seen = new Set<string>();
  const take = (phrases: string[]) => {
    const kept: string[] = [];
    for (const phrase of phrases) {
      const key = fold(phrase);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(phrase);
      if (kept.length >= max) break;
    }
    return kept;
  };
  return {
    mustContain: take(changedPhrases(sides.correction, output)),
    mustNotContain: take(changedPhrases(sides.output, correction)),
  };
}
