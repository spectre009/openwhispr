const test = require("node:test");
const assert = require("node:assert/strict");

const {
  editMarkTimes,
  formatClock,
  heardOffsetAt,
  heardPieces,
  heardTimeline,
  placeCorrection,
  segmentText,
  sentenceAtTime,
  sentenceStartAt,
  sentenceStartTimes,
  timeAtOffset,
  unitAtOffset,
  wordAnchors,
  wordPlayTime,
} = require("../../src/utils/historyPlaybackTimes.ts");

// The History player's estimated times, pure: a place in the heard text is
// its share of the text times the recording's length; a place in a review's
// correction is found through words both diffs matched in its sentence, and
// nothing is placed without one.

const HEARD = "so the auto recovery works. the user closed it, you know. then it was lost";
const FINAL = "So the auto recovery works. The user closed it. Then it was lost.";
const at = (text, word, from = 0) => {
  const index = text.indexOf(word, from);
  assert.ok(index >= 0, `"${word}" is in the text`);
  return index;
};

test("words and sentences: whitespace runs, unspaced scripts by character, ends at . ! ? and line breaks", () => {
  const { units, sentences } = segmentText("Hi there. Is it ok?\nNew line «quoted.» end");
  assert.deepEqual(
    units.map((unit) => "Hi there. Is it ok?\nNew line «quoted.» end".slice(unit.start, unit.end)),
    ["Hi", "there.", "Is", "it", "ok?", "New", "line", "«quoted.»", "end"]
  );
  assert.deepEqual(
    sentences.map((sentence) => [sentence.firstUnit, sentence.lastUnit]),
    [
      [0, 1],
      [2, 4],
      [5, 7],
      [8, 8],
    ]
  );
  const cjk = segmentText("你好。世界很大！OK");
  assert.deepEqual(
    cjk.units.map((unit) => "你好。世界很大！OK".slice(unit.start, unit.end)),
    ["你", "好。", "世", "界", "很", "大！", "OK"]
  );
  assert.equal(cjk.sentences.length, 3);
  assert.deepEqual(segmentText(""), { units: [], sentences: [] });
  assert.deepEqual(segmentText("   \n "), { units: [], sentences: [] });
});

test("times: a character's share of the text times the length; nothing without text or a known length", () => {
  const timeline = heardTimeline(HEARD, 74);
  assert.equal(timeline.text.length, 74);
  assert.equal(timeAtOffset(timeline, 0), 0);
  assert.equal(timeAtOffset(timeline, 37), 37);
  assert.equal(timeAtOffset(timeline, 500), 74, "clamped to the end");
  assert.equal(timeAtOffset(timeline, -3), 0);

  // A word plays from a little before it; the first can't go below 0.
  assert.equal(wordPlayTime(timeline, at(HEARD, "closed")), at(HEARD, "closed") - 0.3);
  assert.equal(wordPlayTime(timeline, at(HEARD, "closed") + 2), at(HEARD, "closed") - 0.3);
  assert.equal(wordPlayTime(timeline, 0), 0);

  // Sentences: their starts, and which one is playing.
  assert.deepEqual(sentenceStartTimes(timeline), [0, at(HEARD, "the user"), at(HEARD, "then")]);
  assert.equal(sentenceAtTime(timeline, 0), 0);
  assert.equal(sentenceAtTime(timeline, at(HEARD, "user")), 1);
  assert.equal(sentenceAtTime(timeline, 999), 2);
  assert.equal(sentenceAtTime(timeline, Number.NaN), 0);
  assert.equal(sentenceStartAt(timeline, at(HEARD, "lost")), at(HEARD, "then"));

  // Empty heard text, unknown or broken length: no timeline.
  assert.equal(heardTimeline("", 10), null);
  assert.equal(heardTimeline("  ", 10), null);
  assert.equal(heardTimeline(null, 10), null);
  assert.equal(heardTimeline(HEARD, 0), null);
  assert.equal(heardTimeline(HEARD, null), null);
  assert.equal(heardTimeline(HEARD, Number.POSITIVE_INFINITY), null);
  assert.equal(heardTimeline(HEARD, Number.NaN), null);

  // In whitespace, the word before it; before every word, the first.
  const segments = segmentText("  one two");
  assert.equal(unitAtOffset(segments, 0), 0);
  assert.equal(unitAtOffset(segments, 5), 0);
  assert.equal(unitAtOffset(segments, 6), 1);
  assert.equal(unitAtOffset(segmentText(""), 3), -1);
});

test("anchors: only words the diff matched, case-only changes included, never spaces or punctuation", () => {
  const anchors = wordAnchors(HEARD, FINAL);
  const pairs = anchors.after.map((after, index) => [
    FINAL.slice(after, after + 4),
    HEARD.slice(anchors.before[index], anchors.before[index] + 4),
  ]);
  assert.deepEqual(pairs.slice(0, 3), [
    ["So t", "so t"],
    ["the ", "the "],
    ["auto", "auto"],
  ]);
  assert.ok(
    anchors.after.every((after) => /[\p{L}\p{N}]/u.test(FINAL[after])),
    "every anchor is a word"
  );
  assert.ok(!pairs.some(([final]) => final.startsWith("you")), "removed words aren't anchors");
  assert.equal(wordAnchors("a".repeat(5000).split("").join(" "), "b ".repeat(5000)), null);
});

test("the caret's sentence: through both diffs to the nearest matched word, earlier ones first", () => {
  const timeline = heardTimeline(HEARD, 74);
  const toHeard = wordAnchors(HEARD, FINAL);
  const correction = "So the auto-recovery works. The user closed the file. Then it was lost.";
  const placement = placeCorrection(FINAL, correction);

  // A matched word maps to itself; an added one to the word before it in its sentence.
  assert.equal(heardOffsetAt(placement, at(correction, "user"), toHeard), at(HEARD, "user"));
  assert.equal(heardOffsetAt(placement, at(correction, "user") + 2, toHeard), at(HEARD, "user"));
  assert.equal(heardOffsetAt(placement, at(correction, "file"), toHeard), at(HEARD, "closed"));
  // The caret after a sentence's period stays in that sentence.
  assert.equal(heardOffsetAt(placement, at(correction, "file.") + 5, toHeard), at(HEARD, "closed"));
  // From your cursor plays that sentence from its start.
  assert.equal(
    sentenceStartAt(timeline, heardOffsetAt(placement, at(correction, "file"), toHeard)),
    at(HEARD, "the user")
  );
  // A new first word of a sentence: the matched word after it.
  const leading = "So the auto recovery works. Sadly the user closed it. Then it was lost.";
  assert.equal(
    heardOffsetAt(placeCorrection(FINAL, leading), at(leading, "Sadly"), toHeard),
    at(HEARD, "the user")
  );

  // A sentence with nothing matched (a new one, or only punctuation kept): no place.
  const added = "So the auto recovery works. Brand new words here. Then it was lost.";
  assert.equal(heardOffsetAt(placeCorrection(FINAL, added), at(added, "new"), toHeard), null);
  const punctuation = "So the auto recovery works. Xyz, qq. Then it was lost.";
  assert.equal(
    heardOffsetAt(placeCorrection(FINAL, punctuation), at(punctuation, "qq"), toHeard),
    null
  );

  // A final word cleanup added has no heard word: the next matched one in the sentence is used.
  const cleanupAdded = heardTimeline("tell sam hello", 3);
  const cleanupAnchors = wordAnchors("tell sam hello", "Please tell Sam hello.");
  const own = placeCorrection("Please tell Sam hello.", "Please tell Sam hi.");
  assert.equal(heardOffsetAt(own, 0, cleanupAnchors), 0, "Please → tell");
  assert.equal(sentenceStartAt(cleanupAdded, 0), 0);

  // Without the heard alignment (too long): nothing.
  assert.equal(heardOffsetAt(placement, 0, null), null);
});

test("edit marks: each edit by its anchor word, close ones merged, whitespace-only edits left out", () => {
  const timeline = heardTimeline(HEARD, 74);
  const toHeard = wordAnchors(HEARD, FINAL);
  const correction = "So the auto-recovery works. The user closed the file. Then it was lost.";
  const placement = placeCorrection(FINAL, correction);
  assert.deepEqual(
    placement.edits.map((offset) => correction.slice(offset, offset + 4)),
    ["-rec", "the "]
  );
  const times = editMarkTimes(placement, toHeard, timeline);
  assert.deepEqual(times, [timeAtOffset(timeline, at(HEARD, "auto")), at(HEARD, "closed")]);
  // Merged when closer than the gap.
  assert.deepEqual(editMarkTimes(placement, toHeard, timeline, 100), [times[0]]);

  // Only a line break added: no mark.
  const spaced = "So the auto recovery works.\nThe user closed it. Then it was lost.";
  assert.deepEqual(placeCorrection(FINAL, spaced).edits, []);
  // An edit in a sentence with no anchor: no mark.
  const added = "So the auto recovery works. Brand new words here. Then it was lost.";
  assert.deepEqual(editMarkTimes(placeCorrection(FINAL, added), toHeard, timeline), []);
});

test("edge cases: empty texts and a correction that deletes everything place nothing", () => {
  assert.equal(placeCorrection(FINAL, ""), null);
  assert.equal(placeCorrection(FINAL, "   \n"), null);
  assert.equal(placeCorrection("", "anything"), null);
  assert.deepEqual(heardPieces("", FINAL), []);
  assert.equal(wordAnchors("", FINAL).after.length, 0);
});

test("heard pieces: the heard text by its own offsets, what replaced it as added text", () => {
  const pieces = heardPieces("ping little body now", "ping Little Buddy now");
  assert.deepEqual(pieces, [
    { kind: "heard", start: 0, end: 5 },
    { kind: "case", start: 5, end: 11, now: "Little" },
    { kind: "heard", start: 11, end: 12 },
    { kind: "removed", start: 12, end: 16 },
    { kind: "added", text: "Buddy" },
    { kind: "heard", start: 16, end: 20 },
  ]);
  // The heard text alone, and every heard character exactly once otherwise.
  assert.deepEqual(heardPieces(HEARD, null), [{ kind: "heard", start: 0, end: HEARD.length }]);
  const covered = heardPieces(HEARD, FINAL)
    .filter((piece) => piece.kind !== "added")
    .map((piece) => HEARD.slice(piece.start, piece.end))
    .join("");
  assert.equal(covered, HEARD);
});

test("clock: m:ss, h:mm:ss from an hour, 0:00 for nothing", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(14.9), "0:14");
  assert.equal(formatClock(71), "1:11");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(Number.NaN), "0:00");
  assert.equal(formatClock(-4), "0:00");
});
