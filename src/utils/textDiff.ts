// Word-level differences between two versions of a dictation's text, for the
// History view: a step's output against the text it received, or what was
// heard against the final output. Pure.
//
// Words and punctuation are separate tokens and whitespace is kept as tokens,
// so line breaks a style adds show up. A word that only changed case is its
// own kind ("case"), so the UI can show it softly. Scripts written without
// spaces (Chinese, Japanese, Thai, …) compare character by character. The work
// is bounded: the common start and end are set aside, and when the rest would
// need more than `maxCells` comparisons the result is "replaced" and the UI
// shows the text as it is.

export type TextDiffPart =
  | { kind: "same"; text: string }
  | { kind: "insert"; text: string }
  | { kind: "delete"; text: string }
  | { kind: "case"; text: string; was: string };

export type TextDiff =
  | { kind: "diff"; parts: TextDiffPart[]; changed: boolean }
  /** Too large to compare word by word. */
  | { kind: "replaced" };

/** About 8 MB of comparison table and ~15 ms: a 1,000-word dictation rewritten throughout. */
export const DEFAULT_MAX_CELLS = 4_000_000;

/** Scripts written without spaces between words, as a regex character-class body. */
export const UNSPACED =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}";
const WORD_CHAR = `(?:(?![${UNSPACED}])[\\p{L}\\p{M}\\p{N}_])`;
const TOKEN = new RegExp(
  [
    `[${UNSPACED}]`,
    // Words keep inner apostrophes: "don't", "l'homme".
    `${WORD_CHAR}+(?:['’]${WORD_CHAR}+)*`,
    "\\s+",
    "[^]",
  ].join("|"),
  "gu"
);

/** Words, single punctuation marks, whitespace runs, and single characters of unspaced scripts. */
export function tokenize(text: string): string[] {
  return typeof text === "string" && text ? (text.match(TOKEN) ?? []) : [];
}

const fold = (token: string) => token.toLowerCase();

function matchPart(before: string, after: string): TextDiffPart {
  return before === after
    ? { kind: "same", text: after }
    : { kind: "case", text: after, was: before };
}

const isEdit = (part: TextDiffPart | undefined) =>
  part?.kind === "insert" || part?.kind === "delete";

// Reads as whole phrases: whitespace kept between two edits joins them, and in
// each run of edits what was removed comes before what replaced it.
function tidy(raw: TextDiffPart[]): TextDiffPart[] {
  const parts: TextDiffPart[] = [];
  raw.forEach((part, index) => {
    if (
      part.kind === "same" &&
      /^\s+$/.test(part.text) &&
      isEdit(raw[index - 1]) &&
      isEdit(raw[index + 1])
    ) {
      parts.push({ kind: "delete", text: part.text }, { kind: "insert", text: part.text });
    } else {
      parts.push(part);
    }
  });

  const out: TextDiffPart[] = [];
  let removed = "";
  let added = "";
  const flush = () => {
    if (removed) out.push({ kind: "delete", text: removed });
    if (added) out.push({ kind: "insert", text: added });
    removed = "";
    added = "";
  };
  for (const part of parts) {
    if (part.kind === "delete") removed += part.text;
    else if (part.kind === "insert") added += part.text;
    else {
      flush();
      const last = out[out.length - 1];
      if (part.kind === "same" && last?.kind === "same") last.text += part.text;
      else out.push(part);
    }
  }
  flush();
  return out;
}

/** The differences from `before` to `after`; see the contract above. */
export function diffText(
  before: string,
  after: string,
  { maxCells = DEFAULT_MAX_CELLS }: { maxCells?: number } = {}
): TextDiff {
  const a = tokenize(before);
  const b = tokenize(after);
  const fa = a.map(fold);
  const fb = b.map(fold);

  let start = 0;
  while (start < a.length && start < b.length && fa[start] === fb[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && fa[endA - 1] === fb[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > maxCells) return { kind: "replaced" };

  const raw: TextDiffPart[] = [];
  for (let i = 0; i < start; i += 1) raw.push(matchPart(a[i], b[i]));

  // lcs[i * width + j]: the longest common run of a[start + i..] and b[start + j..].
  const width = m + 1;
  const Table = Math.min(n, m) < 0xffff ? Uint16Array : Uint32Array;
  const lcs = new Table((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        fa[start + i] === fb[start + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && fa[start + i] === fb[start + j]) {
      raw.push(matchPart(a[start + i], b[start + j]));
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      raw.push({ kind: "delete", text: a[start + i] });
      i += 1;
    } else {
      raw.push({ kind: "insert", text: b[start + j] });
      j += 1;
    }
  }

  for (let k = 0; k < a.length - endA; k += 1) raw.push(matchPart(a[endA + k], b[endB + k]));

  const parts = tidy(raw);
  return { kind: "diff", parts, changed: parts.some((part) => part.kind !== "same") };
}
