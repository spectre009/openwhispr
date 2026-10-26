const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LOG_TEXT_MAX_CHARS,
  isLogTextEnabled,
  logText,
  setLogTextEnabled,
} = require("../../src/utils/logText.js");

// What a log line may say about dictated text (utils/logText.js): its size,
// and the first 80 characters only while "Include dictated text" is on.

test("by default a log line gets the text's size, never the text", (t) => {
  setLogTextEnabled(false);
  t.after(() => setLogTextEnabled(false));
  assert.equal(isLogTextEnabled(), false);
  assert.deepEqual(logText("Send the report to Dana tomorrow."), { chars: 33, words: 6 });
  assert.deepEqual(logText("  two   words \n"), { chars: 15, words: 2 });
  assert.deepEqual(logText(""), { chars: 0, words: 0 });
  // Anything that isn't a string counts as empty; nothing of it is read.
  assert.deepEqual(logText(null), { chars: 0, words: 0 });
  assert.deepEqual(logText(undefined), { chars: 0, words: 0 });
  assert.deepEqual(logText({ text: "hidden" }), { chars: 0, words: 0 });
  assert.deepEqual(logText(Buffer.from("hidden")), { chars: 0, words: 0 });
});

test("with dictated text on, the first 80 characters come along", (t) => {
  setLogTextEnabled(true);
  t.after(() => setLogTextEnabled(false));
  assert.equal(isLogTextEnabled(), true);
  assert.deepEqual(logText("Short note"), { chars: 10, words: 2, text: "Short note" });
  const long = "word ".repeat(40);
  const summary = logText(long);
  assert.equal(summary.chars, 200);
  assert.equal(summary.words, 40);
  assert.equal(summary.text, long.slice(0, LOG_TEXT_MAX_CHARS));
  assert.equal(LOG_TEXT_MAX_CHARS, 80);
  // Characters, not UTF-16 units: an emoji is never cut in half.
  const emoji = "😀".repeat(100);
  assert.equal(Array.from(logText(emoji).text).length, 80);
  assert.equal(logText("").text, undefined, "nothing to show for empty text");
});

test("only a real true turns it on", (t) => {
  t.after(() => setLogTextEnabled(false));
  for (const value of ["true", 1, {}, null, undefined]) {
    setLogTextEnabled(value);
    assert.equal(isLogTextEnabled(), false, String(value));
  }
  setLogTextEnabled(true);
  assert.equal(isLogTextEnabled(), true);
});
