// Estimated playback times for a dictation's text, for the History player.
// Word timings aren't stored, so a place in the speech-to-text text is
// guessed from where it sits: its character offset ÷ the text's length × the
// recording's length, and the UI says these times are estimated wherever it
// shows them. A place in a review's correction is found through anchors:
// words the diffs matched (correction → final output → speech-to-text), the
// nearest one in the caret's own sentence, earlier ones first. Without such
// an anchor nothing is placed; whitespace and punctuation never anchor. Pure.

import { diffText, tokenize, UNSPACED } from "./textDiff";

export interface TextUnit {
  start: number;
  end: number;
  /** Index into `sentences`. */
  sentence: number;
}

export interface TextSentence {
  start: number;
  end: number;
  firstUnit: number;
  lastUnit: number;
}

/** A text's words (whitespace-separated runs; one character each in unspaced scripts) and sentences. */
export interface TextSegments {
  units: TextUnit[];
  sentences: TextSentence[];
}

export interface HeardTimeline extends TextSegments {
  text: string;
  /** The recording's length, in seconds. */
  duration: number;
}

/** Words the diff matched, by token start: in `after` (ascending) and the same word in `before`. */
export interface WordAnchors {
  after: number[];
  before: number[];
}

/** A review's correction, aligned with the final output. */
export interface CorrectionPlacement {
  correction: string;
  segments: TextSegments;
  /** Correction (after) → final output (before). */
  toFinal: WordAnchors;
  /** Where the correction differs from the final output, as offsets in the correction. */
  edits: number[];
}

/** A piece of the heard text in a comparison, by offsets into it; `added` text isn't in it. */
export type HeardPiece =
  | { kind: "heard"; start: number; end: number }
  | { kind: "case"; start: number; end: number; now: string }
  | { kind: "removed"; start: number; end: number }
  | { kind: "added"; text: string };

/** A word click plays from this long before the word's estimated time. */
export const WORD_LEAD_SECONDS = 0.3;
/** Edit marks closer than this to an earlier one are left out. */
export const EDIT_MARK_GAP_SECONDS = 1.2;

const UNIT = new RegExp(
  `[${UNSPACED}][^\\s${UNSPACED}\\p{L}\\p{M}\\p{N}]*|(?:(?![${UNSPACED}])\\S)+`,
  "gu"
);
// A unit that ends a sentence, closing quotes and brackets allowed after the mark.
const SENTENCE_END = /[.!?。！？…‽][\p{Pe}\p{Pf}"'»]*$/u;
const LINE_BREAK = /[\n\r]/;
const isWord = (token: string) => /[\p{L}\p{N}]/u.test(token);

/** Words and sentences of `text`: a sentence ends at . ! ? (and their CJK forms) or a line break. */
export function segmentText(text: string): TextSegments {
  const units: TextUnit[] = [];
  const sentences: TextSentence[] = [];
  if (typeof text !== "string" || !text) return { units, sentences };
  let first = -1;
  const close = () => {
    if (first < 0) return;
    const last = units.length - 1;
    sentences.push({
      start: units[first].start,
      end: units[last].end,
      firstUnit: first,
      lastUnit: last,
    });
    first = -1;
  };
  let previousEnd = 0;
  for (const match of text.matchAll(UNIT)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (first >= 0 && LINE_BREAK.test(text.slice(previousEnd, start))) close();
    if (first < 0) first = units.length;
    units.push({ start, end, sentence: sentences.length });
    previousEnd = end;
    if (SENTENCE_END.test(match[0])) close();
  }
  close();
  return { units, sentences };
}

/** The heard text's words and sentences with a length to place them in; null without either. */
export function heardTimeline(
  text: string | null | undefined,
  duration: number | null | undefined
): HeardTimeline | null {
  if (typeof text !== "string" || typeof duration !== "number") return null;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const segments = segmentText(text);
  if (segments.units.length === 0) return null;
  return { text, duration, ...segments };
}

/** The estimated time of a character offset in the heard text. */
export function timeAtOffset(timeline: HeardTimeline, offset: number): number {
  const length = timeline.text.length;
  const at = Math.min(Math.max(0, offset), length);
  return (at / length) * timeline.duration;
}

/** The unit containing `offset`, else the last one before it (the first when none is); -1 without units. */
export function unitAtOffset(segments: TextSegments, offset: number): number {
  const { units } = segments;
  if (units.length === 0) return -1;
  let lo = 0;
  let hi = units.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (units[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The sentence index of the heard text estimated to be playing at `seconds`. */
export function sentenceAtTime(timeline: HeardTimeline, seconds: number): number {
  const at = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const offset = (at / timeline.duration) * timeline.text.length;
  return timeline.units[unitAtOffset(timeline, offset)].sentence;
}

/** Each sentence's estimated start, in seconds. */
export function sentenceStartTimes(timeline: HeardTimeline): number[] {
  return timeline.sentences.map((sentence) => timeAtOffset(timeline, sentence.start));
}

/** Where a click on the word at `offset` plays from: a little before its estimated time. */
export function wordPlayTime(timeline: HeardTimeline, offset: number): number {
  const unit = timeline.units[unitAtOffset(timeline, offset)];
  return Math.max(0, timeAtOffset(timeline, unit.start) - WORD_LEAD_SECONDS);
}

/** The estimated start of the sentence holding `offset` in the heard text. */
export function sentenceStartAt(timeline: HeardTimeline, offset: number): number {
  const unit = timeline.units[unitAtOffset(timeline, offset)];
  return timeAtOffset(timeline, timeline.sentences[unit.sentence].start);
}

/** The words the diff from `before` to `after` matched (case-only changes included); null when too long to compare. */
export function wordAnchors(before: string, after: string): WordAnchors | null {
  const diff = diffText(before, after);
  if (diff.kind !== "diff") return null;
  const anchors: WordAnchors = { after: [], before: [] };
  let a = 0;
  let b = 0;
  for (const part of diff.parts) {
    if (part.kind === "same") {
      let k = 0;
      for (const token of tokenize(part.text)) {
        if (isWord(token)) {
          anchors.before.push(a + k);
          anchors.after.push(b + k);
        }
        k += token.length;
      }
      a += part.text.length;
      b += part.text.length;
    } else if (part.kind === "case") {
      if (isWord(part.text)) {
        anchors.before.push(a);
        anchors.after.push(b);
      }
      a += part.was.length;
      b += part.text.length;
    } else if (part.kind === "delete") {
      a += part.text.length;
    } else {
      b += part.text.length;
    }
  }
  return anchors;
}

// First index whose value is >= target (or > target with `strict`).
function bound(values: readonly number[], target: number, strict = false): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? values[mid] <= target : values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The `before` offset of the word matched at `after` offset `at`; undefined when it isn't one. */
export function anchorAt(anchors: WordAnchors, at: number): number | undefined {
  const index = bound(anchors.after, at);
  return anchors.after[index] === at ? anchors.before[index] : undefined;
}

/** The correction aligned with the final output; null when either is empty or too long to compare. */
export function placeCorrection(finalText: string, correction: string): CorrectionPlacement | null {
  if (typeof finalText !== "string" || typeof correction !== "string") return null;
  if (!finalText.trim() || !correction.trim()) return null;
  const diff = diffText(finalText, correction);
  if (diff.kind !== "diff") return null;
  const toFinal = wordAnchors(finalText, correction);
  if (!toFinal) return null;
  const edits: number[] = [];
  let b = 0;
  let regionStart = -1;
  let regionText = "";
  const closeRegion = () => {
    if (regionStart >= 0 && regionText.trim()) edits.push(regionStart);
    regionStart = -1;
    regionText = "";
  };
  for (const part of diff.parts) {
    if (part.kind === "same" || part.kind === "case") {
      closeRegion();
      b += part.text.length;
      continue;
    }
    if (regionStart < 0) regionStart = b;
    regionText += part.text;
    if (part.kind === "insert") b += part.text.length;
  }
  closeRegion();
  return { correction, segments: segmentText(correction), toFinal, edits };
}

/**
 * Where `caret` in the correction was said: the heard-text offset of the
 * nearest word in the caret's sentence that both diffs matched (earlier words
 * first, then later ones). Null when that sentence has none.
 */
export function heardOffsetAt(
  placement: CorrectionPlacement,
  caret: number,
  toHeard: WordAnchors | null
): number | null {
  if (!toHeard) return null;
  const { segments, toFinal } = placement;
  const unit = unitAtOffset(segments, caret);
  if (unit < 0) return null;
  const sentence = segments.sentences[segments.units[unit].sentence];
  const lo = bound(toFinal.after, sentence.start);
  const hi = bound(toFinal.after, sentence.end);
  const split = Math.min(Math.max(bound(toFinal.after, caret, true), lo), hi);
  const tryAt = (index: number) => anchorAt(toHeard, toFinal.before[index]);
  for (let index = split - 1; index >= lo; index -= 1) {
    const heard = tryAt(index);
    if (heard !== undefined) return heard;
  }
  for (let index = split; index < hi; index += 1) {
    const heard = tryAt(index);
    if (heard !== undefined) return heard;
  }
  return null;
}

/** Estimated times of the correction's edits, each placed by its anchor word; close ones merged. */
export function editMarkTimes(
  placement: CorrectionPlacement,
  toHeard: WordAnchors | null,
  timeline: HeardTimeline,
  minGap = EDIT_MARK_GAP_SECONDS
): number[] {
  const times: number[] = [];
  for (const offset of placement.edits) {
    const heard = heardOffsetAt(placement, offset, toHeard);
    if (heard === null) continue;
    const time = timeAtOffset(timeline, heard);
    if (times.every((kept) => Math.abs(kept - time) > minGap)) times.push(time);
  }
  return times.sort((a, b) => a - b);
}

/**
 * The heard text compared with `other` (null: the heard text alone), as
 * pieces by offsets into the heard text; null when too long to compare.
 */
export function heardPieces(heard: string, other: string | null): HeardPiece[] | null {
  if (!heard) return [];
  if (other === null) return [{ kind: "heard", start: 0, end: heard.length }];
  const diff = diffText(heard, other);
  if (diff.kind !== "diff") return null;
  const pieces: HeardPiece[] = [];
  let a = 0;
  for (const part of diff.parts) {
    if (part.kind === "insert") {
      pieces.push({ kind: "added", text: part.text });
      continue;
    }
    const length = part.kind === "case" ? part.was.length : part.text.length;
    if (part.kind === "same") pieces.push({ kind: "heard", start: a, end: a + length });
    else if (part.kind === "case")
      pieces.push({ kind: "case", start: a, end: a + length, now: part.text });
    else pieces.push({ kind: "removed", start: a, end: a + length });
    a += length;
  }
  return pieces;
}

/** m:ss (h:mm:ss from an hour), for estimated times and the seek bar's spoken value. */
export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
