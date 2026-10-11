const test = require("node:test");
const assert = require("node:assert/strict");

const WindowsKeyManager = require("../../src/helpers/windowsKeyManager");
const { parseKeyEventLine } = WindowsKeyManager;

test("a timed key line carries the OS event time and the hook time", () => {
  assert.deepEqual(parseKeyEventLine("KEY_DOWN 1000 1012", 1030), {
    type: "KEY_DOWN",
    timing: { receivedAt: 1030, eventAt: 1000, hookAt: 1012 },
  });
});

test("a bare key line from an older listener binary still parses, without timing", () => {
  assert.deepEqual(parseKeyEventLine("KEY_UP", 50), {
    type: "KEY_UP",
    timing: { receivedAt: 50 },
  });
});

test("other listener output is not a key event", () => {
  for (const line of ["READY", "KEY_DOWNX", "KEY_DOWN 1 2 3", "KEY_DOWN 1", "key_down"]) {
    assert.equal(parseKeyEventLine(line, 0), null, line);
  }
});

test("key events are emitted with the key and their timing", () => {
  const manager = new WindowsKeyManager();
  const events = [];
  manager.on("key-down", (key, timing) => events.push(["down", key, timing.eventAt]));
  manager.on("key-up", (key, timing) => events.push(["up", key, timing.eventAt]));

  manager.handleOutputLine("KEY_DOWN 10 12", "F20");
  manager.handleOutputLine("KEY_UP", "F20");

  assert.deepEqual(events, [
    ["down", "F20", 10],
    ["up", "F20", undefined],
  ]);
});
