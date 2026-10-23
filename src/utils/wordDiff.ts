// Word-level differences between two texts, for the test set's side-by-side
// results: a longest common subsequence over words, with whitespace kept as
// written so each side renders as its own text. Words compare exactly, so a
// change in punctuation or case shows as a change.

export type WordDiffKind = "same" | "removed" | "added";

export interface WordDiffSegment {
  text: string;
  kind: WordDiffKind;
}

export interface WordDiff {
  /** The first text, with words missing from the second marked "removed". */
  a: WordDiffSegment[];
  /** The second text, with words missing from the first marked "added". */
  b: WordDiffSegment[];
}

// Above this many word pairs the table would cost more than it's worth
// (dictations are short); the texts are then marked as changed whole.
const MAX_CELLS = 1_000_000;

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

const isSpace = (token: string) => /^\s+$/.test(token);

function merge(segments: WordDiffSegment[]): WordDiffSegment[] {
  const out: WordDiffSegment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && last.kind === segment.kind) last.text += segment.text;
    else out.push({ ...segment });
  }
  return out;
}

// Whitespace between two changed words joins their highlight, so a changed
// run reads as one; whitespace next to an unchanged word stays unmarked.
function render(tokens: string[], keep: boolean[], changed: WordDiffKind): WordDiffSegment[] {
  const kinds: WordDiffKind[] = [];
  let wordIndex = 0;
  for (const token of tokens) {
    if (isSpace(token)) {
      kinds.push("same");
      continue;
    }
    kinds.push(keep[wordIndex] ? "same" : changed);
    wordIndex += 1;
  }
  const segments = tokens.map((token, index) => {
    if (!isSpace(token)) return { text: token, kind: kinds[index] };
    const before = kinds[index - 1];
    const after = kinds[index + 1];
    return { text: token, kind: before === changed && after === changed ? changed : "same" };
  });
  return merge(segments);
}

export function diffWords(a: string, b: string): WordDiff {
  const tokensA = tokenize(a ?? "");
  const tokensB = tokenize(b ?? "");
  const wordsA = tokensA.filter((token) => !isSpace(token));
  const wordsB = tokensB.filter((token) => !isSpace(token));
  const n = wordsA.length;
  const m = wordsB.length;

  if (a === b) {
    return {
      a: render(tokensA, new Array(n).fill(true), "removed"),
      b: render(tokensB, new Array(m).fill(true), "added"),
    };
  }
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    return {
      a: render(tokensA, new Array(n).fill(false), "removed"),
      b: render(tokensB, new Array(m).fill(false), "added"),
    };
  }

  // lengths[i][j]: the longest common subsequence of wordsA[i..] and wordsB[j..].
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        wordsA[i] === wordsB[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }

  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (wordsA[i] === wordsB[j]) {
      keepA[i] = true;
      keepB[j] = true;
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return { a: render(tokensA, keepA, "removed"), b: render(tokensB, keepB, "added") };
}
