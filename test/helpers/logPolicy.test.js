const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../../src/helpers/logPolicy");

// The rules behind Storage › Logs (helpers/logPolicy.js): the three choices and
// how older settings read, overrides, retention, validation, file names and
// reading recent problems back.

test("the saved level reads as one of three choices, without rewriting .env", () => {
  const cases = [
    [undefined, "warn"],
    ["", "warn"],
    ["info", "warn"],
    ["INFO", "warn"],
    ["warn", "warn"],
    ["error", "warn"],
    ["fatal", "warn"],
    ["verbose", "warn"],
    ["debug", "debug"],
    ["trace", "debug"],
    [" Debug ", "debug"],
    ["off", "off"],
    ["OFF", "off"],
  ];
  for (const [raw, expected] of cases)
    assert.equal(policy.settingLevelFrom(raw), expected, String(raw));
});

test("a --log-level flag, then an inherited variable, override the setting", () => {
  assert.deepEqual(policy.resolveEffectiveLevel({ setting: "debug" }), {
    level: "debug",
    overriddenBy: null,
  });
  assert.deepEqual(policy.resolveEffectiveLevel({ setting: "info" }), {
    level: "warn",
    overriddenBy: null,
  });
  assert.deepEqual(policy.resolveEffectiveLevel({ env: "info", setting: "off" }), {
    level: "info",
    overriddenBy: "env",
  });
  assert.deepEqual(policy.resolveEffectiveLevel({ flag: "off", env: "debug", setting: "debug" }), {
    level: "off",
    overriddenBy: "flag",
  });
  // Something that isn't a level overrides nothing.
  assert.deepEqual(policy.resolveEffectiveLevel({ flag: "loud", env: "", setting: "off" }), {
    level: "off",
    overriddenBy: null,
  });
});

test("the flag is read in both spellings", () => {
  assert.equal(policy.readArgLogLevel(["electron", ".", "--log-level=debug"]), "debug");
  assert.equal(policy.readArgLogLevel(["electron", ".", "--log-level", "trace"]), "trace");
  assert.equal(policy.readArgLogLevel(["electron", "."]), null);
});

test("retention: 7 days at Problems only and Off, 30 at Everything, until chosen", () => {
  assert.equal(policy.retentionDaysFrom(undefined, "warn"), 7);
  assert.equal(policy.retentionDaysFrom(undefined, "off"), 7);
  assert.equal(policy.retentionDaysFrom(undefined, "debug"), 30);
  assert.equal(policy.retentionDaysFrom("90", "warn"), 90);
  assert.equal(policy.retentionDaysFrom("14", "debug"), 14);
  assert.equal(policy.retentionDaysFrom("3", "debug"), 30, "only the offered values");
  assert.deepEqual([...policy.RETENTION_DAY_OPTIONS], [7, 14, 30, 90]);
  assert.equal(policy.includeTextFrom("true"), true);
  assert.equal(policy.includeTextFrom("1"), false);
  assert.equal(policy.includeTextFrom(undefined), false);
});

test("set-log-settings accepts the offered values only, and names nothing it got", () => {
  assert.deepEqual(policy.validateLogSettings({ level: "off" }), { level: "off" });
  assert.deepEqual(
    policy.validateLogSettings({ level: "debug", retentionDays: 90, includeText: true }),
    { level: "debug", retentionDays: 90, includeText: true }
  );
  const rejects = [
    null,
    "debug",
    [],
    {},
    { level: "info" },
    { level: "trace" },
    { retentionDays: 31 },
    { retentionDays: "7" },
    { includeText: "true" },
    { level: "warn", path: "C:\\Windows" },
  ];
  for (const input of rejects) {
    assert.throws(() => policy.validateLogSettings(input), TypeError, JSON.stringify(input));
  }
  assert.throws(
    () => policy.validateLogSettings({ level: "sk-secret-value" }),
    (error) => !error.message.includes("sk-secret-value")
  );
});

test("file names carry their start time and the -text mark", () => {
  const date = new Date("2026-10-25T15:02:11.123Z");
  assert.equal(policy.logFileName(date), "debug-2026-10-25T15-02-11-123Z.log");
  assert.equal(policy.logFileName(date, { text: true }), "debug-2026-10-25T15-02-11-123Z-text.log");
  assert.equal(
    policy.logFileName(date, { n: 2, text: true }),
    "debug-2026-10-25T15-02-11-123Z-2-text.log"
  );
  assert.equal(
    policy.logFileStartedAt("debug-2026-10-25T15-02-11-123Z-2-text.log"),
    date.getTime()
  );
  assert.equal(policy.logFileStartedAt("debug-old.log"), null);
  assert.equal(policy.isTextLogName("debug-2026-10-25T15-02-11-123Z-text.log"), true);
  assert.equal(policy.isTextLogName("debug-2026-10-25T15-02-11-123Z.log"), false);
  assert.equal(policy.isLogFileName("debug-x.log"), true);
  assert.equal(policy.isLogFileName("notes.log"), false);
});

test("recent problems: warnings and errors only, their area and first line, at most 200 characters", () => {
  const long = "x".repeat(300);
  const text = [
    '[2026-10-25T08:00:00.000Z] [INFO] System Info {"appVersion":"1.0.0"}',
    "[2026-10-25T08:17:00.000Z] [WARN][clipboard] Paste held back: modifier keys still down {",
    '  "waitedMs": 1500',
    "}",
    "[2026-10-25T08:42:00.000Z] [ERROR][transcription][renderer] Speech-to-text failed",
    "[2026-10-25T09:00:00.000Z] [ERROR] ERROR: Failed to open settings: {",
    '  "message": "secret detail on the next line"',
    "}",
    "[2026-10-25T09:05:00.000Z] [ERROR][environment] ERROR: Failed to decrypt secret",
    "[2026-10-25T09:10:00.000Z] [FATAL][renderer] " + long,
    "[2026-10-25T09:11:00.000Z] [DEBUG][audio] not a problem",
    "garbage line [WARN] in the middle",
  ].join("\n");
  assert.deepEqual(policy.parseProblemLines(text), [
    {
      time: "2026-10-25T08:17:00.000Z",
      level: "warn",
      area: "clipboard",
      message: "Paste held back: modifier keys still down",
    },
    {
      time: "2026-10-25T08:42:00.000Z",
      level: "error",
      area: "transcription",
      message: "Speech-to-text failed",
    },
    {
      time: "2026-10-25T09:00:00.000Z",
      level: "error",
      area: null,
      message: "Failed to open settings:",
    },
    {
      time: "2026-10-25T09:05:00.000Z",
      level: "error",
      area: "environment",
      message: "Failed to decrypt secret",
    },
    {
      time: "2026-10-25T09:10:00.000Z",
      level: "fatal",
      area: "renderer",
      message: "x".repeat(200),
    },
  ]);
});
