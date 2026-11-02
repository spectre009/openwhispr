const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// The log IPC (helpers/logIpc.js) wired to the real logger and environment
// manager over a temp userData: settings validated before anything is written,
// saved to .env through the manager's own save, applied live and announced;
// an inherited OPENWHISPR_LOG_LEVEL or a --log-level flag still wins, and the
// answer says why; recent problems read from the newest files within a budget.

const LOG_ENV = ["OPENWHISPR_LOG_LEVEL", "OPENWHISPR_LOG_RETENTION_DAYS", "OPENWHISPR_LOG_TEXT"];
const MODULES = ["debugLogger", "environment", "logIpc", "buildInfo", "logPolicy"].map((name) =>
  require.resolve(`../../src/helpers/${name}`)
);
// dotenv's tips go to stdout, which carries the test runner's own messages.
process.env.DOTENV_CONFIG_QUIET = "true";

function setup(t, { argv = [], inherited } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-log-ipc-"));
  const savedEnv = Object.fromEntries(LOG_ENV.map((key) => [key, process.env[key]]));
  for (const key of LOG_ENV) delete process.env[key];
  const savedArgv = process.argv;
  process.argv = ["electron", ".", ...argv];
  const savedResources = process.resourcesPath;
  process.resourcesPath = userData;
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          isReady: () => true,
          isPackaged: true,
          getPath: () => userData,
          getAppPath: () => userData,
          getVersion: () => "9.9.9-test",
        },
        safeStorage: { isEncryptionAvailable: () => false },
      };
    }
    if (request === "./secretCrypto") return { isAvailable: () => false };
    return originalLoad.call(this, request, parent, isMain);
  };
  for (const file of MODULES) delete require.cache[file];
  const logger = require("../../src/helpers/debugLogger");
  logger.consoleLoggingEnabled = false;
  if (inherited !== undefined) logger.captureInheritedEnv({ OPENWHISPR_LOG_LEVEL: inherited });
  const EnvironmentManager = require("../../src/helpers/environment");
  const { createLogHandlers } = require("../../src/helpers/logIpc");
  const environmentManager = new EnvironmentManager();
  logger.ensureFileLogging();
  const broadcasts = [];
  const handlers = createLogHandlers({
    logger,
    environmentManager,
    broadcast: (channel, payload) => broadcasts.push([channel, payload]),
    mask: (folder) => folder.replace(userData, "%USERDATA%"),
  });
  t.after(async () => {
    logger.stopMaintenance();
    await logger.closeSession();
    Module._load = originalLoad;
    for (const file of MODULES) delete require.cache[file];
    process.argv = savedArgv;
    process.resourcesPath = savedResources;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const envFile = () => {
    try {
      return fs.readFileSync(path.join(userData, ".env"), "utf8");
    } catch {
      return "";
    }
  };
  return { userData, logger, handlers, broadcasts, envFile };
}

test("set-log-settings refuses anything but the offered values, and writes nothing", async (t) => {
  const { handlers, envFile, broadcasts } = setup(t);
  for (const input of [
    { level: "info" },
    { retentionDays: 3 },
    { includeText: "yes" },
    { level: "debug", folder: "C:\\elsewhere" },
    null,
  ]) {
    await assert.rejects(handlers.setLogSettings(input), TypeError, JSON.stringify(input));
  }
  assert.equal(envFile(), "");
  assert.deepEqual(broadcasts, []);
});

test("each setting is saved to .env, applied at once and announced to every window", async (t) => {
  const { handlers, envFile, broadcasts, logger } = setup(t);
  let info = handlers.logInfo();
  assert.equal(info.level, "warn", "unset reads as Problems only");
  assert.equal(info.retentionDays, 7);
  assert.equal(info.logsDir, path.join("%USERDATA%", "logs"));
  assert.ok(info.system.platform);

  info = await handlers.setLogSettings({ level: "debug" });
  assert.match(envFile(), /^OPENWHISPR_LOG_LEVEL=debug$/m);
  assert.equal(info.effectiveLevel, "debug");
  assert.equal(info.retentionDays, 30, "Everything keeps 30 days until one is picked");
  assert.equal(logger.isDebugEnabled(), true);
  assert.deepEqual(broadcasts.at(-1), [
    "log-settings-changed",
    { level: "debug", includeText: false },
  ]);

  info = await handlers.setLogSettings({ retentionDays: 14, includeText: true });
  assert.match(envFile(), /^OPENWHISPR_LOG_RETENTION_DAYS=14$/m);
  assert.match(envFile(), /^OPENWHISPR_LOG_TEXT=true$/m);
  assert.equal(info.includeText, true);
  assert.match(info.currentFile, /-text\.log$/, "a new file, named for the text");
  assert.deepEqual(broadcasts.at(-1), [
    "log-settings-changed",
    { level: "debug", includeText: true },
  ]);

  info = await handlers.setLogSettings({ level: "off", includeText: false });
  assert.match(envFile(), /^OPENWHISPR_LOG_LEVEL=off$/m);
  assert.doesNotMatch(envFile(), /OPENWHISPR_LOG_TEXT/);
  assert.equal(info.currentFile, null, "Off writes no file");
  assert.equal(handlers.logState().level, "off");
});

test("an inherited OPENWHISPR_LOG_LEVEL wins and is never saved as the setting", async (t) => {
  const { handlers, envFile, logger } = setup(t, { inherited: "info" });
  assert.equal(process.env.OPENWHISPR_LOG_LEVEL, undefined, "taken out of process.env");
  let info = handlers.logInfo();
  assert.deepEqual([info.level, info.effectiveLevel, info.overriddenBy], ["warn", "info", "env"]);
  info = await handlers.setLogSettings({ level: "debug" });
  assert.deepEqual([info.level, info.effectiveLevel, info.overriddenBy], ["debug", "info", "env"]);
  assert.match(envFile(), /^OPENWHISPR_LOG_LEVEL=debug$/m, "the setting is still saved");
  assert.equal(logger.getLevel(), "info");
  // Saving something else never writes the inherited value.
  await handlers.setLogSettings({ retentionDays: 90 });
  assert.match(envFile(), /^OPENWHISPR_LOG_LEVEL=debug$/m);
});

test("a --log-level flag wins over both", async (t) => {
  const { handlers } = setup(t, { argv: ["--log-level=error"], inherited: "debug" });
  const info = await handlers.setLogSettings({ level: "off" });
  assert.deepEqual([info.level, info.effectiveLevel, info.overriddenBy], ["off", "error", "flag"]);
  assert.ok(info.currentFile, "the flag's level keeps a file");
});

test("recent problems come from the newest files, newest first, within the read budget", async (t) => {
  const { userData } = setup(t);
  const { readRecentProblems } = require("../../src/helpers/logIpc");
  const dir = path.join(userData, "logs-problems");
  fs.mkdirSync(dir);
  const line = (minute, level, rest) =>
    `[2026-10-25T08:${String(minute).padStart(2, "0")}:00.000Z] [${level}]${rest}\n`;
  const older = path.join(dir, "debug-older.log");
  fs.writeFileSync(older, line(1, "ERROR", '[audio] Old failure {\n  "x": 1\n}'));
  fs.utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const newer = path.join(dir, "debug-newer.log");
  fs.writeFileSync(
    newer,
    "x".repeat(5000) +
      "\n" +
      line(2, "WARN", "[clipboard] Paste held back") +
      line(3, "INFO", " Not a problem") +
      line(4, "FATAL", "[renderer] Crashed")
  );
  fs.writeFileSync(path.join(dir, "notes.log"), line(5, "ERROR", " not ours"));

  const problems = await readRecentProblems(dir);
  assert.deepEqual(
    problems.map((problem) => [
      problem.time.slice(11, 16),
      problem.level,
      problem.area,
      problem.message,
    ]),
    [
      ["08:04", "fatal", "renderer", "Crashed"],
      ["08:02", "warn", "clipboard", "Paste held back"],
      ["08:01", "error", "audio", "Old failure"],
    ]
  );

  // A file's tail only: a budget smaller than the file skips its start.
  const tail = await readRecentProblems(dir, {
    limits: { perFileBytes: 200, totalBytes: 200, maxFiles: 8 },
  });
  assert.deepEqual(
    tail.map((problem) => problem.message),
    ["Crashed", "Paste held back"]
  );
  assert.deepEqual(await readRecentProblems(dir, { max: 1 }), [problems[0]]);
  assert.deepEqual(await readRecentProblems(path.join(dir, "missing")), []);
});

test("Clear logs and Open folder go through the logger; the folder exists to open", async (t) => {
  const { handlers, userData, logger } = setup(t);
  fs.writeFileSync(path.join(userData, "logs", "debug-old.log"), "x");
  const result = await handlers.clearLogs();
  assert.ok(result.deleted >= 1);
  assert.deepEqual(result.failed, []);
  assert.ok(logger.getLogPath(), "Problems only keeps writing, in a new file");

  const opened = [];
  const { createLogHandlers } = require("../../src/helpers/logIpc");
  const withShell = createLogHandlers({
    logger,
    environmentManager: {},
    openPath: async (folder) => {
      opened.push(folder);
      return "";
    },
  });
  assert.deepEqual(await withShell.openLogsFolder(), { success: true });
  assert.deepEqual(opened, [path.join(userData, "logs")]);
  const failing = createLogHandlers({
    logger,
    environmentManager: {},
    openPath: async () => "No application is associated",
  });
  assert.deepEqual(await failing.openLogsFolder(), {
    success: false,
    error: "No application is associated",
  });
});

test("log-info carries the graphics mode for Diagnostics; a failing reader answers null", async (t) => {
  const { logger } = setup(t);
  const { createLogHandlers } = require("../../src/helpers/logIpc");
  const state = { mode: "software", reason: "fallback", gpuCompositing: "disabled_software" };
  const withMode = createLogHandlers({ logger, environmentManager: {}, graphics: () => state });
  assert.deepEqual(withMode.logInfo().graphics, state);
  assert.equal(createLogHandlers({ logger, environmentManager: {} }).logInfo().graphics, null);
  const failing = createLogHandlers({
    logger,
    environmentManager: {},
    graphics: () => {
      throw new Error("not yet");
    },
  });
  assert.equal(failing.logInfo().graphics, null);
  assert.ok(failing.logInfo().system.platform, "the rest still answers");
});

test("main.js takes the inherited level before any .env loads; selfhost Dev no longer forces debug", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "..", "main.js"), "utf8");
  const capture = main.indexOf("captureInheritedEnv(process.env)");
  assert.ok(capture > 0, "main.js captures it");
  assert.ok(capture < main.indexOf('require("dotenv")'), "before the first dotenv load");
  const selfhost = fs.readFileSync(
    path.join(__dirname, "..", "..", "scripts", "selfhost.js"),
    "utf8"
  );
  const devStart = selfhost.slice(selfhost.indexOf("function startDevElectron"));
  assert.doesNotMatch(devStart.slice(0, devStart.indexOf("\n}\n")), /OPENWHISPR_LOG_LEVEL:/);
});
