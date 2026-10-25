const test = require("node:test");
const assert = require("node:assert/strict");

const { diffText, tokenize } = require("../../src/utils/textDiff.ts");

// The History view's diff: words and punctuation, whitespace kept, case-only
// changes as their own kind, unspaced scripts by character, bounded work.

const parts = (before, after, options) => {
  const result = diffText(before, after, options);
  assert.equal(result.kind, "diff");
  return result.parts;
};

test("tokens: words with inner apostrophes, single punctuation marks, whitespace runs", () => {
  assert.deepEqual(tokenize("Don't stop, ok?\n\nC:\\Users"), [
    "Don't",
    " ",
    "stop",
    ",",
    " ",
    "ok",
    "?",
    "\n\n",
    "C",
    ":",
    "\\",
    "Users",
  ]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
});

test("identical text has no changes, and rebuilds exactly", () => {
  const text = "Hello there.\nGeneral Kenobi!";
  const result = diffText(text, text);
  assert.deepEqual(result, { kind: "diff", parts: [{ kind: "same", text }], changed: false });
  assert.deepEqual(diffText("", ""), { kind: "diff", parts: [], changed: false });
});

test("insertions and deletions read as whole words", () => {
  assert.deepEqual(parts("Hello world", "Hello big world"), [
    { kind: "same", text: "Hello " },
    { kind: "insert", text: "big " },
    { kind: "same", text: "world" },
  ]);
  assert.deepEqual(parts("Hello big world", "Hello world"), [
    { kind: "same", text: "Hello " },
    { kind: "delete", text: "big " },
    { kind: "same", text: "world" },
  ]);
  // A replaced phrase: what was removed, then what replaced it, joined across spaces.
  assert.deepEqual(parts("move it to little body now", "move it to Little Buddy now"), [
    { kind: "same", text: "move it to " },
    { kind: "case", text: "Little", was: "little" },
    { kind: "same", text: " " },
    { kind: "delete", text: "body" },
    { kind: "insert", text: "Buddy" },
    { kind: "same", text: " now" },
  ]);
  assert.deepEqual(parts("we are not shipping", "we are shipping today"), [
    { kind: "same", text: "we are " },
    { kind: "delete", text: "not " },
    { kind: "same", text: "shipping" },
    { kind: "insert", text: " today" },
  ]);
  assert.deepEqual(parts("the big cat", "a small dog"), [
    { kind: "delete", text: "the big cat" },
    { kind: "insert", text: "a small dog" },
  ]);
});

test("a case-only change is its own kind, never a delete and an insert", () => {
  const result = diffText("move voice assistant", "Move Voice Assistant");
  assert.equal(result.changed, true);
  assert.deepEqual(result.parts, [
    { kind: "case", text: "Move", was: "move" },
    { kind: "same", text: " " },
    { kind: "case", text: "Voice", was: "voice" },
    { kind: "same", text: " " },
    { kind: "case", text: "Assistant", was: "assistant" },
  ]);
});

test("punctuation is compared on its own", () => {
  assert.deepEqual(parts("hello world", "Hello, world."), [
    { kind: "case", text: "Hello", was: "hello" },
    { kind: "insert", text: "," },
    { kind: "same", text: " world" },
    { kind: "insert", text: "." },
  ]);
});

test("line breaks are kept and compared", () => {
  assert.deepEqual(parts("Hi Sam, thanks.", "Hi Sam,\n\nThanks."), [
    { kind: "same", text: "Hi Sam," },
    { kind: "delete", text: " " },
    { kind: "insert", text: "\n\n" },
    { kind: "case", text: "Thanks", was: "thanks" },
    { kind: "same", text: "." },
  ]);
  const rebuilt = parts("a\nb\nc", "a\nb\n\nc")
    .filter((part) => part.kind !== "delete")
    .map((part) => part.text)
    .join("");
  assert.equal(rebuilt, "a\nb\n\nc");
});

test("scripts without spaces compare by character", () => {
  assert.deepEqual(parts("今天天气很好", "今天天气不错"), [
    { kind: "same", text: "今天天气" },
    { kind: "delete", text: "很好" },
    { kind: "insert", text: "不错" },
  ]);
  assert.deepEqual(parts("東京へ行きます", "東京に行きます"), [
    { kind: "same", text: "東京" },
    { kind: "delete", text: "へ" },
    { kind: "insert", text: "に" },
    { kind: "same", text: "行きます" },
  ]);
});

test("right-to-left text diffs in logical order", () => {
  assert.deepEqual(parts("مرحبا بالعالم", "مرحبا بالعالم الجميل"), [
    { kind: "same", text: "مرحبا بالعالم" },
    { kind: "insert", text: " الجميل" },
  ]);
  assert.deepEqual(parts("שלום עולם", "שלום לכולם"), [
    { kind: "same", text: "שלום " },
    { kind: "delete", text: "עולם" },
    { kind: "insert", text: "לכולם" },
  ]);
});

test("the work is bounded: past the cap the result is 'replaced'", () => {
  const words = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
  const before = words("a", 2000);
  const after = words("b", 2000);
  assert.deepEqual(diffText(before, after), { kind: "replaced" });
  assert.deepEqual(diffText("one two three", "four five six", { maxCells: 4 }), {
    kind: "replaced",
  });
  // The common start and end don't count against the cap.
  const long = words("w", 20000);
  const edited = diffText(`${long} end`, `${long} END!`, { maxCells: 10 });
  assert.equal(edited.kind, "diff");
  assert.deepEqual(edited.parts.slice(1), [
    { kind: "case", text: "END", was: "end" },
    { kind: "insert", text: "!" },
  ]);
});

test("every input is rebuilt from its parts", () => {
  const pairs = [
    ["um so basically we're not shipping on friday", "We're not shipping on Friday."],
    ["open the open whisper repo", "Open the OpenWhispr repo."],
    ["", "Something new."],
    ["Something old.", ""],
    ["- one\n- two", "1. one\n2. two\n3. three"],
  ];
  for (const [before, after] of pairs) {
    const result = parts(before, after);
    const rebuild = (skip) =>
      result
        .filter((part) => part.kind !== skip)
        .map((part) => (skip === "insert" && part.kind === "case" ? part.was : part.text))
        .join("");
    assert.equal(rebuild("delete"), after, `after: ${after}`);
    assert.equal(rebuild("insert"), before, `before: ${before}`);
  }
});
