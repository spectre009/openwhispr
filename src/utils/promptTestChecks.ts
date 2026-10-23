// The test set's checks on one cleanup output (Prompt Studio → Test set).
//
// - Always on: the transcript isn't repeated (assertValidCleanupOutput, the
//   validator a dictation with the built-in prompt runs). An empty reply or a
//   request error is its own outcome in the runner, never a failed check.
// - Per case: literal "must contain" and "must not contain", case-insensitive
//   unless the case asks to match case. Patterns can come later.
// - Style cases: bullet lines and numbered items, at least / at most.
// - Advisory: filler words left in the output are flagged but never fail a
//   case. German "um", a meaningful "eh" or a quoted filler are legitimate.

import { assertValidCleanupOutput } from "./cleanupOutput";

/** Fillers flagged as whole words, in any case. */
export const FILLER_WORDS = [
  "ee",
  "eh",
  "um",
  "umm",
  "uhm",
  "uh",
  "uhh",
  "ahh",
  "hmm",
  "hm",
  "mm",
  "mmm",
  "erm",
] as const;

const FILLER_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}'’])(?:${FILLER_WORDS.join("|")})(?![\\p{L}\\p{N}'’])`,
  "giu"
);

export interface LiteralCheck {
  text: string;
  /** null: the output isn't available (the validator rejected it), so it wasn't checked. */
  ok: boolean | null;
}

export interface CaseChecks {
  mustContain: string[];
  mustNotContain: string[];
  matchCase: boolean;
  /** Style cases: bullet lines and numbered items, at least / at most (null: unchecked). */
  styleChecks?: StyleCountChecks | null;
}

export interface StyleCountChecks {
  bulletsMin: number | null;
  bulletsMax: number | null;
  numberedMin: number | null;
  numberedMax: number | null;
}

export type StyleCountCheckKind = keyof StyleCountChecks;

export interface StyleCountCheck {
  kind: StyleCountCheckKind;
  limit: number;
  /** The count in the output; null when the output isn't available. */
  actual: number | null;
  ok: boolean | null;
}

export interface OutputChecks {
  /** False when the model repeated the transcript (the dictation validator's check). */
  notDuplicated: boolean;
  mustContain: LiteralCheck[];
  mustNotContain: LiteralCheck[];
  /** Style cases only: the bullet and numbered-item counts. */
  structure?: StyleCountCheck[];
  /** Advisory only: filler words still in the output, lowercased, in order. */
  fillers: string[];
  /** Every check that can fail passed (fillers never count). */
  passed: boolean;
}

const STYLE_COUNT_KINDS: readonly StyleCountCheckKind[] = [
  "bulletsMin",
  "bulletsMax",
  "numberedMin",
  "numberedMax",
];

// A bullet line starts with -, *, •, ‣, ◦ or –, then a space. A numbered item
// starts with digits and "." or ")", then a space.
const BULLET_LINE = /^\s*[-*•‣◦–]\s+\S/u;
const NUMBERED_LINE = /^\s*\d{1,3}[.)]\s+\S/u;

/** Lines of `text` that are bullet points. */
export function countBulletLines(text: string): number {
  if (typeof text !== "string") return 0;
  return text.split(/\r?\n/u).filter((line) => BULLET_LINE.test(line)).length;
}

/** Lines of `text` that are numbered items. */
export function countNumberedItems(text: string): number {
  if (typeof text !== "string") return 0;
  return text.split(/\r?\n/u).filter((line) => NUMBERED_LINE.test(line)).length;
}

/** The counts a case asks for, in a fixed order; none for a case without them. */
function styleCountChecks(
  checks: StyleCountChecks | null | undefined,
  output: string | null
): StyleCountCheck[] {
  if (!checks) return [];
  const bullets = output === null ? null : countBulletLines(output);
  const numbered = output === null ? null : countNumberedItems(output);
  const result: StyleCountCheck[] = [];
  for (const kind of STYLE_COUNT_KINDS) {
    const limit = checks[kind];
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) continue;
    const actual = kind.startsWith("bullets") ? bullets : numbered;
    const ok = actual === null ? null : kind.endsWith("Min") ? actual >= limit : actual <= limit;
    result.push({ kind, limit, actual, ok });
  }
  return result;
}

/** Filler words left in `text`, whole words only, each listed once. */
export function findFillers(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const seen = new Set<string>();
  for (const match of text.matchAll(FILLER_PATTERN)) seen.add(match[0].toLowerCase());
  return [...seen];
}

/** A literal substring test; case-insensitive unless `matchCase`. */
export function containsLiteral(text: string, literal: string, matchCase: boolean): boolean {
  if (!literal) return true;
  return matchCase ? text.includes(literal) : text.toLowerCase().includes(literal.toLowerCase());
}

/** Whether the dictation validator would reject `output` as a repeated `input`. */
export function isRepeatedTranscript(input: string, output: string): boolean {
  try {
    assertValidCleanupOutput(input, output);
    return false;
  } catch (error) {
    if ((error as { code?: string })?.code === "CLEANUP_OUTPUT_INVALID") return true;
    throw error;
  }
}

function summarize(checks: Omit<OutputChecks, "passed">): OutputChecks {
  const literalsPass = [...checks.mustContain, ...checks.mustNotContain].every(
    (check) => check.ok === true
  );
  const countsPass = (checks.structure ?? []).every((check) => check.ok === true);
  return { ...checks, passed: checks.notDuplicated && literalsPass && countsPass };
}

/** Every check on one completed output. `input` is what was sent (the corrected input). */
export function checkOutput(checks: CaseChecks, input: string, output: string): OutputChecks {
  const structure = styleCountChecks(checks.styleChecks, output);
  return summarize({
    notDuplicated: !isRepeatedTranscript(input, output),
    mustContain: checks.mustContain.map((text) => ({
      text,
      ok: containsLiteral(output, text, checks.matchCase),
    })),
    mustNotContain: checks.mustNotContain.map((text) => ({
      text,
      ok: !containsLiteral(output, text, checks.matchCase),
    })),
    ...(structure.length > 0 ? { structure } : {}),
    fillers: findFillers(output),
  });
}

/**
 * The checks of an output the provider's validator rejected as a repeated
 * transcript before it reached the runner: a dictation would have pasted its
 * input instead. The literal checks can't be evaluated.
 */
export function repeatedTranscriptChecks(checks: CaseChecks): OutputChecks {
  const structure = styleCountChecks(checks.styleChecks, null);
  return summarize({
    notDuplicated: false,
    mustContain: checks.mustContain.map((text) => ({ text, ok: null })),
    mustNotContain: checks.mustNotContain.map((text) => ({ text, ok: null })),
    ...(structure.length > 0 ? { structure } : {}),
    fillers: [],
  });
}
