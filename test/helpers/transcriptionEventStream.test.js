const test = require("node:test");
const assert = require("node:assert/strict");

const { createTranscriptionEventParser } = require("../../src/helpers/transcriptionEventStream.js");

const event = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

test("deltas build the text and transcript.text.done ends it with its own text", () => {
  const parser = createTranscriptionEventParser();
  assert.equal(parser.push(event({ type: "transcript.text.delta", delta: "Hello " })), false);
  assert.equal(parser.started, true);
  assert.equal(parser.push(event({ type: "transcript.text.delta", delta: "wrld" })), false);
  assert.equal(parser.text(), "Hello wrld");
  assert.equal(parser.push(event({ type: "transcript.text.done", text: "Hello world" })), true);
  assert.equal(parser.done, true);
  assert.equal(parser.text(), "Hello world");
  assert.deepEqual(parser.stats().eventTypes, {
    "transcript.text.delta": 2,
    "transcript.text.done": 1,
  });
});

test("[DONE] completes with the collected text", () => {
  const parser = createTranscriptionEventParser();
  parser.push(event({ type: "transcript.text.segment", text: "one " }));
  parser.push(event({ type: "transcript.text.segment", text: "two" }));
  assert.equal(parser.push("data: [DONE]\n\n"), true);
  assert.equal(parser.text(), "one two");
});

test("an event split across chunks and lines is read whole", () => {
  const parser = createTranscriptionEventParser();
  const whole = event({ type: "transcript.text.delta", delta: "split" });
  parser.push(whole.slice(0, 12));
  assert.equal(parser.started, false);
  parser.push(whole.slice(12));
  assert.equal(parser.text(), "split");
  // One event's JSON spread over two data lines.
  parser.push('data: {"type":"transcript.text.delta",\ndata: "delta":" more"}\n\n');
  assert.equal(parser.text(), "split more");
});

test("comments and other events never start the answer", () => {
  const parser = createTranscriptionEventParser();
  parser.push(": keep-alive\n\n");
  parser.push(event({ type: "session.created" }));
  assert.equal(parser.started, false);
  assert.equal(parser.done, false);
  parser.push(event({ type: "transcript.text.delta", delta: "go" }));
  assert.equal(parser.started, true);
});

test("a last line without a newline is read when the body ends", () => {
  const parser = createTranscriptionEventParser();
  parser.push(`data: ${JSON.stringify({ type: "transcript.text.done", text: "tail" })}`);
  assert.equal(parser.done, false);
  assert.equal(parser.end(), true);
  assert.equal(parser.text(), "tail");
});

test("nothing after the terminal event changes the text", () => {
  const parser = createTranscriptionEventParser();
  parser.push(
    event({ type: "transcript.text.done", text: "final" }) +
      event({ type: "transcript.text.delta", delta: " extra" })
  );
  parser.push(event({ type: "transcript.text.delta", delta: " more" }));
  assert.equal(parser.text(), "final");
});
