const test = require("node:test");
const assert = require("node:assert/strict");

const { startEventLoopStallMonitor } = require("../../src/helpers/eventLoopStallMonitor");

function harness() {
  let clock = 0;
  let tick = null;
  const logs = [];
  const log = (level) => (message, meta) => logs.push({ level, message, ...meta });
  const stop = startEventLoopStallMonitor({
    logger: { debug: log("debug"), warn: log("warn") },
    label: "main",
    now: () => clock,
    setIntervalFn: (callback) => {
      tick = callback;
      return { unref() {} };
    },
    clearIntervalFn: () => {
      tick = null;
    },
  });
  // Fires the interval after `elapsed` ms, as a blocked thread would: late.
  const fireAfter = (elapsed) => {
    clock += elapsed;
    tick();
  };
  return { logs, fireAfter, stop, isRunning: () => tick !== null };
}

test("an on-time interval logs nothing", () => {
  const { logs, fireAfter } = harness();
  fireAfter(200);
  fireAfter(240);
  assert.deepEqual(logs, []);
});

test("a late interval logs the stall: debug when short, warn from a second", () => {
  const { logs, fireAfter } = harness();
  fireAfter(200 + 300);
  fireAfter(200 + 1500);
  assert.deepEqual(logs, [
    { level: "debug", message: "Event loop stalled", process: "main", stallMs: 300 },
    { level: "warn", message: "Event loop stalled", process: "main", stallMs: 1500 },
  ]);
});

test("drift as long as a machine sleep is logged as a likely suspend, not a stall", () => {
  const { logs, fireAfter } = harness();
  fireAfter(200 + 45000);
  assert.deepEqual(logs, [
    {
      level: "debug",
      message: "Event loop timer delayed past suspend threshold",
      process: "main",
      delayMs: 45000,
    },
  ]);
});

test("stopping the monitor clears its interval", () => {
  const { stop, isRunning } = harness();
  stop();
  assert.equal(isRunning(), false);
});
