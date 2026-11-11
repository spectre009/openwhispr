const test = require("node:test");
const assert = require("node:assert/strict");

// Upstream (#2584) re-read the level on a "log-level-changed" broadcast from its
// Settings debug toggle. The fork's Storage › Logs owns the setting and
// broadcasts the whole log state ("log-settings-changed", logIpc.js), which a
// window's logger subscribes to when it first reads its level: the same
// guarantee, through the fork's channel.
test("a log-level change from main reaches a window that already cached its level", async () => {
  let mainLevel = "info";
  let onSettingsChanged = null;
  const sent = [];
  globalThis.window = {
    electronAPI: {
      getLogState: async () => ({ level: mainLevel, includeText: false }),
      getLogLevel: async () => mainLevel,
      onLogSettingsChanged: (callback) => {
        onSettingsChanged = callback;
        return () => {};
      },
      log: async (entry) => {
        sent.push(entry.message);
      },
    },
  };

  const mod = await import("../../src/utils/logger.ts");
  const logger = mod.default.default ?? mod.default;

  await logger.debug("before toggle");
  assert.deepEqual(sent, [], "info level drops debug lines");
  assert.equal(typeof onSettingsChanged, "function", "logger subscribes once it reads its level");

  mainLevel = "debug";
  await logger.debug("cached level still info");
  assert.deepEqual(sent, [], "without the event the window keeps its cached level");

  onSettingsChanged({ level: mainLevel, includeText: false });
  await logger.debug("after toggle");
  assert.deepEqual(sent, ["after toggle"]);
});
