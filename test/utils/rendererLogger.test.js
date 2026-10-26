const test = require("node:test");
const assert = require("node:assert/strict");

// The renderer's logger (utils/logger.ts) follows main's log settings: the
// level in force and "Include dictated text" come from `get-log-state` once and
// then from the `log-settings-changed` broadcast, in every window, so a change
// on Storage › Logs applies without a reload.

test("the renderer logger takes a changed setting from the broadcast", async (t) => {
  const sent = [];
  let state = { level: "warn", includeText: false };
  let listener = null;
  const originalWindow = globalThis.window;
  globalThis.window = {
    electronAPI: {
      getLogState: async () => state,
      onLogSettingsChanged: (callback) => {
        listener = callback;
        return () => {};
      },
      log: async (entry) => {
        sent.push(`${entry.level}:${entry.message}`);
      },
    },
  };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  const loggerModule = await import("../../src/utils/logger.ts");
  const logger = loggerModule.default?.default ?? loggerModule.default;
  const logTextModule = await import("../../src/utils/logText.js");
  const { isLogTextEnabled } = logTextModule.default ?? logTextModule;

  await logger.debug("step detail");
  await logger.warn("a problem");
  assert.deepEqual(sent, ["warn:a problem"], "Problems only: no debug lines");
  assert.equal(isLogTextEnabled(), false);
  assert.equal(typeof listener, "function", "subscribed once it asked main");

  state = { level: "debug", includeText: true };
  listener(state);
  await logger.debug("now kept");
  assert.equal(sent.at(-1), "debug:now kept");
  assert.equal(isLogTextEnabled(), true, "dictated text follows the switch");

  // Off still sends warnings and errors on: main keeps them for its console.
  listener({ level: "off", includeText: false });
  await logger.info("dropped");
  await logger.error("still sent");
  assert.deepEqual(sent.slice(-1), ["error:still sent"]);
  assert.equal(isLogTextEnabled(), false);
});
