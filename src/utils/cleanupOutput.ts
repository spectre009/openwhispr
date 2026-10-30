import logger from "./logger";

const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });
const cleanupLabel =
  /^(?:Cleaned transcript:|\*\*Cleaned transcript:\*\*|\*\*Cleaned transcript\*\*:)$/i;

function comparisonTokens(text: string): string[] {
  // Keep contractions as one word when punctuation is discarded.
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/\p{P}/gu, " ");
  return Array.from(wordSegmenter.segment(normalized))
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

export function assertValidCleanupOutput(rawText: string, output: string): void {
  // Collapse stutters ("the the") so they don't read as saying a word twice.
  const originalTokens = comparisonTokens(rawText).filter(
    (token, index, all) => token !== all[index - 1]
  );
  const tokens: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (cleanupLabel.test(line.trim())) continue;
    for (const token of comparisonTokens(line)) tokens.push(token);
  }

  const halfLength = tokens.length / 2;
  if (!Number.isInteger(halfLength) || halfLength < 6) return;
  const copy = tokens.slice(0, halfLength);
  if (!copy.every((token, index) => token === tokens[index + halfLength])) return;
  // A speaker who really said it twice said most of its words twice: each word
  // in the copy uses up two of its occurrences in the raw transcript.
  const rawCounts = new Map<string, number>();
  for (const token of originalTokens) rawCounts.set(token, (rawCounts.get(token) ?? 0) + 1);
  let saidTwice = 0;
  for (const token of copy) {
    const remaining = rawCounts.get(token) ?? 0;
    if (remaining < 2) continue;
    rawCounts.set(token, remaining - 2);
    saidTwice++;
  }
  if (saidTwice * 2 > halfLength) return;

  logger.logReasoning("CLEANUP_OUTPUT_REJECTED", {
    reason: "duplicated_transcript",
    inputLength: rawText.length,
    outputLength: output.length,
  });
  throw repeatedTranscriptError();
}

// A reply that hands back the transcript, then a label, then the cleaned text
// ("…transcript…\n\nCleaned:\n…cleaned…"): the label on a line of its own, or
// leading the cleaned text on its line, optionally in Markdown bold or as a heading.
const cleanedLabel =
  /^(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:here(?:'|’)?s\s+the\s+|here\s+is\s+the\s+)?(?:cleaned(?:[\s-]*up)?|clean|corrected|edited|final)(?:\s+(?:transcript|version|text|transcription))?\s*(?::\s*(?:\*\*|__)?|(?:\*\*|__)\s*:)\s*(.*)$/iu;
// A label naming the transcript the reply repeated, above it.
const originalLabel =
  /^(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:original|raw|before|transcript)(?:\s+(?:transcript|version|text|transcription))?\s*(?::\s*(?:\*\*|__)?|(?:\*\*|__)\s*:)\s*$/iu;
// The repeated part must be the transcript: most of its words, in about its length.
const NEAR_COPY_OVERLAP = 0.85;

/** Shared words over all words (Dice on word counts), 0–1. */
function wordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of b) {
    const left = counts.get(token) ?? 0;
    if (left > 0) {
      counts.set(token, left - 1);
      shared++;
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * The text to paste for a cleanup reply. A reply that repeats the transcript,
 * then a "Cleaned:"-style label, then the cleaned text keeps only the cleaned
 * text; one with nothing after the label is rejected like a repeated
 * transcript. Everything else is checked by assertValidCleanupOutput and
 * returned as it came.
 */
export function finishCleanupOutput(rawText: string, output: string): string {
  if (typeof output !== "string") return output;
  const lines = output.split(/\r?\n/u);
  for (let index = lines.length - 1; index > 0; index--) {
    const label = cleanedLabel.exec(lines[index].trim());
    if (!label) continue;
    const before = lines
      .slice(0, index)
      .filter((line) => !originalLabel.test(line.trim()))
      .join("\n");
    const repeated = comparisonTokens(before);
    if (wordOverlap(repeated, comparisonTokens(rawText)) < NEAR_COPY_OVERLAP) continue;
    const cleaned = [label[1] ?? "", ...lines.slice(index + 1)].join("\n").trim();
    logger.logReasoning("CLEANUP_OUTPUT_LABELED_COPY", {
      kept: cleaned ? "cleaned" : "none",
      inputLength: rawText.length,
      outputLength: output.length,
      cleanedLength: cleaned.length,
    });
    if (!comparisonTokens(cleaned).length) throw repeatedTranscriptError();
    assertValidCleanupOutput(rawText, cleaned);
    return cleaned;
  }
  assertValidCleanupOutput(rawText, output);
  return output;
}

function repeatedTranscriptError(): Error {
  return Object.assign(
    new Error("AI cleanup repeated the transcript. The original text was kept."),
    {
      code: "CLEANUP_OUTPUT_INVALID",
      messageKey: "hooks.audioRecording.errorDescriptions.cleanupDuplicated",
    }
  );
}
