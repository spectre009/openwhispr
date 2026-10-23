// Glossary corrections: a deterministic fix applied to the speech-to-text
// output before cleanup. Each rule has a canonical form ("Little Buddy") and
// the spellings speech-to-text writes instead ("everybody", "littlebuddy").
//
// - `anywhere` spellings are never real words, so they are safe in every app
//   and at any position.
// - `start` spellings are real words ("everybody", "buddy"). They are replaced
//   only when they open the dictation, optionally after a kept greeting
//   ("Hello, everybody. I need…" → "Hello, Little Buddy. I need…"), and only
//   when the recording's target app is on the rule's app list. An unknown
//   target app never gets them.
//
// Rules live in main's `glossary_rules` table (see helpers/glossaryRules.js);
// this module only matches. A spoken snippet trigger always wins: a spelling
// that overlaps a trigger is left alone, so snippet expansion after cleanup
// still finds it.

import { findSnippetTriggerRanges, type Snippet } from "./snippets";

export type GlossaryScope = "anywhere" | "start";

export interface GlossarySpelling {
  text: string;
  scope: GlossaryScope;
}

export interface GlossaryRule {
  id: string;
  canonical: string;
  spellings: GlossarySpelling[];
  /** Target apps (exe names, matched case-insensitively) for `start` spellings. */
  apps: string[];
  enabled: boolean;
  /** Bumped on every change to this rule. */
  revision: number;
  createdAt?: string;
  updatedAt?: string;
}

/** The rule set as one versioned value; `revision` bumps on any change to any rule. */
export interface GlossarySnapshot {
  revision: number;
  rules: GlossaryRule[];
}

export interface GlossaryFiredRule {
  ruleId: string;
  /** The configured spelling that matched. */
  spelling: string;
  scope: GlossaryScope;
  /** The text as it appeared in the input. */
  from: string;
  /** The canonical form written in its place. */
  to: string;
  /** Offset of `from` in the input text. */
  index: number;
}

export interface GlossaryResult {
  text: string;
  fired: GlossaryFiredRule[];
}

export interface GlossaryOptions {
  /** The recording's target app (exe name), or null when unknown. */
  targetApp?: string | null;
  /** Snippet triggers in the text win over any glossary replacement. */
  snippets?: Snippet[] | null;
}

/** Greetings that may precede a `start` spelling and are kept as spoken. */
export const GLOSSARY_START_GREETINGS = [
  "all right",
  "alright",
  "hello",
  "okay",
  "hey",
  "hi",
  "ok",
  "so",
] as const;

const WORD_BEFORE = "(?<=^|[\\s\\p{P}\\p{S}])";
const WORD_AFTER = "(?=$|[\\s\\p{P}\\p{S}])";
// Opening quotes or brackets and whitespace may precede the first word.
const LEADING = "[\\s\"'“‘«(\\[]*";
// What separates a kept greeting from the spelling: spaces and the punctuation
// people dictate there ("Hello, everybody", "Hey - buddy", "Hi… everybody").
const GREETING_SEPARATOR = "[\\s,;:!.\\-–—…]+";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A multi-word spelling matches across any run of whitespace.
function phrasePattern(phrase: string): string {
  return phrase.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
}

function comparable(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

const GREETING_PATTERN = GLOSSARY_START_GREETINGS.map(phrasePattern).join("|");

export function normalizeAppName(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/** Whether a rule's `start` spellings may apply in this target app. */
export function ruleAppliesToApp(rule: GlossaryRule, targetApp: string | null | undefined) {
  const app = normalizeAppName(targetApp);
  return !!app && Array.isArray(rule.apps) && rule.apps.some((a) => normalizeAppName(a) === app);
}

function usableSpellings(rule: GlossaryRule, scope: GlossaryScope): string[] {
  if (!Array.isArray(rule.spellings)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const spelling of rule.spellings) {
    if (spelling?.scope !== scope || typeof spelling.text !== "string") continue;
    const key = comparable(spelling.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(spelling.text.trim());
  }
  // Longest first, so "little buddies" wins over "buddies".
  return out.sort((a, b) => b.length - a.length);
}

/** Rules that can change text at all: enabled, with a canonical form and a spelling. */
export function activeGlossaryRules(rules: GlossaryRule[] | null | undefined): GlossaryRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.filter(
    (rule) =>
      rule &&
      rule.enabled !== false &&
      typeof rule.canonical === "string" &&
      rule.canonical.trim().length > 0 &&
      Array.isArray(rule.spellings) &&
      rule.spellings.length > 0
  );
}

/** Canonical forms of the active rules: the only glossary text that joins hint lists. */
export function glossaryCanonicalTerms(rules: GlossaryRule[] | null | undefined): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const rule of activeGlossaryRules(rules)) {
    const term = rule.canonical.trim();
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

interface Candidate {
  start: number;
  end: number;
  rule: GlossaryRule;
  spelling: string;
  scope: GlossaryScope;
}

function findSpelling(spellings: string[], matched: string): string | undefined {
  const key = comparable(matched);
  return spellings.find((s) => comparable(s) === key);
}

function anywhereCandidates(text: string, rule: GlossaryRule): Candidate[] {
  const spellings = usableSpellings(rule, "anywhere");
  if (spellings.length === 0) return [];
  const regex = new RegExp(
    `${WORD_BEFORE}(?:${spellings.map(phrasePattern).join("|")})${WORD_AFTER}`,
    "giu"
  );
  const out: Candidate[] = [];
  for (const match of text.matchAll(regex)) {
    const spelling = findSpelling(spellings, match[0]);
    if (!spelling || match.index === undefined) continue;
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      rule,
      spelling,
      scope: "anywhere",
    });
  }
  return out;
}

function startCandidate(text: string, rule: GlossaryRule): Candidate | null {
  const spellings = usableSpellings(rule, "start");
  if (spellings.length === 0) return null;
  const regex = new RegExp(
    `^(${LEADING})(?:(?:${GREETING_PATTERN})${GREETING_SEPARATOR})?(${spellings
      .map(phrasePattern)
      .join("|")})${WORD_AFTER}`,
    "iu"
  );
  const match = regex.exec(text);
  if (!match) return null;
  const matched = match[2];
  const spelling = findSpelling(spellings, matched);
  if (!spelling) return null;
  const start = match[0].length - matched.length;
  return { start, end: match[0].length, rule, spelling, scope: "start" };
}

/**
 * Applies the glossary to a transcript. Pure: the same rules, text and target
 * app always give the same result. Every replacement writes the rule's
 * canonical form exactly; surrounding text and punctuation are kept.
 */
export function applyGlossary(
  text: string,
  rules: GlossaryRule[] | null | undefined,
  { targetApp = null, snippets = null }: GlossaryOptions = {}
): GlossaryResult {
  if (typeof text !== "string" || !text) return { text: text ?? "", fired: [] };
  const active = activeGlossaryRules(rules);
  if (active.length === 0) return { text, fired: [] };

  const candidates: Candidate[] = [];
  for (const rule of active) {
    candidates.push(...anywhereCandidates(text, rule));
    if (ruleAppliesToApp(rule, targetApp)) {
      const atStart = startCandidate(text, rule);
      if (atStart) candidates.push(atStart);
    }
  }
  if (candidates.length === 0) return { text, fired: [] };

  const triggers = findSnippetTriggerRanges(text, snippets);
  const overlapsTrigger = (c: Candidate) =>
    triggers.some((range) => c.start < range.end && range.start < c.end);

  candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const chosen: Candidate[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    if (overlapsTrigger(candidate)) continue;
    // Already written exactly as the canonical form: nothing to correct.
    if (text.slice(candidate.start, candidate.end) === candidate.rule.canonical.trim()) continue;
    chosen.push(candidate);
    cursor = candidate.end;
  }
  if (chosen.length === 0) return { text, fired: [] };

  let out = "";
  let last = 0;
  const fired: GlossaryFiredRule[] = [];
  for (const candidate of chosen) {
    const canonical = candidate.rule.canonical.trim();
    out += text.slice(last, candidate.start) + canonical;
    fired.push({
      ruleId: candidate.rule.id,
      spelling: candidate.spelling,
      scope: candidate.scope,
      from: text.slice(candidate.start, candidate.end),
      to: canonical,
      index: candidate.start,
    });
    last = candidate.end;
  }
  out += text.slice(last);
  return { text: out, fired };
}
