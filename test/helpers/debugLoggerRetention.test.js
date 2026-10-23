const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DAY_MS = 24 * 60 * 60 * 1000;

// A fresh logger whose userData is a temp folder; electron is stubbed.
function withLogger(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugLogger-retention-"));
  const logsDir = path.join(tempDir, "logs");
  fs.mkdirSync(logsDir);
  const electronPath = require.resolve("electron");
  const loggerPath = require.resolve("../../src/helpers/debugLogger.js");
  const originalElectron = require.cache[electronPath];
  const originalLogger = require.cache[loggerPath];
  require.cache[electronPath] = {
    exports: {
      app: {
        isReady: () => true,
        getPath: () => tempDir,
        getAppPath: () => "/mock/app",
        getVersion: () => "9.9.9-test",
      },
    },
  };
  delete require.cache[loggerPath];
  const finish = () => {
    delete require.cache[loggerPath];
    if (originalLogger) require.cache[loggerPath] = originalLogger;
    if (originalElectron) require.cache[electronPath] = originalElectron;
    else delete require.cache[electronPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  return Promise.resolve()
    .then(() => run(require(loggerPath), logsDir))
    .finally(finish);
}

function writeLog(dir, name, bytes, mtimeMs) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "x".repeat(bytes));
  const when = new Date(mtimeMs);
  fs.utimesSync(filePath, when, when);
  return filePath;
}

async function closeLogger(logger) {
  const stream = logger.logStream;
  if (!stream) return;
  if (typeof stream.fd !== "number") await new Promise((resolve) => stream.once("open", resolve));
  logger.close();
  await new Promise((resolve) => stream.once("finish", resolve));
}

test("logs older than 30 days are deleted; recent logs and other files are kept", () =>
  withLogger((logger, logsDir) => {
    const now = Date.now();
    writeLog(logsDir, "debug-old.log", 10, now - 40 * DAY_MS);
    writeLog(logsDir, "debug-recent.log", 10, now - 1 * DAY_MS);
    writeLog(logsDir, "notes.log", 10, now - 40 * DAY_MS);
    writeLog(logsDir, "debug-old.txt", 10, now - 40 * DAY_MS);

    assert.deepEqual(logger.pruneLogs(logsDir, { now }), ["debug-old.log"]);
    assert.deepEqual(fs.readdirSync(logsDir).sort(), [
      "debug-old.txt",
      "debug-recent.log",
      "notes.log",
    ]);
  }));

test("over the folder cap, the oldest logs go first and the current file is never deleted", () =>
  withLogger((logger, logsDir) => {
    const now = Date.now();
    writeLog(logsDir, "debug-a.log", 100, now - 4 * 3600_000);
    writeLog(logsDir, "debug-b.log", 100, now - 3 * 3600_000);
    writeLog(logsDir, "debug-c.log", 100, now - 2 * 3600_000);
    logger.logFile = writeLog(logsDir, "debug-current.log", 100, now - 1 * 3600_000);

    logger.retention.maxDirBytes = 250;
    assert.deepEqual(logger.pruneLogs(logsDir, { now }), ["debug-a.log", "debug-b.log"]);

    // A cap smaller than the current file alone still keeps the current file.
    logger.retention.maxDirBytes = 50;
    assert.deepEqual(logger.pruneLogs(logsDir, { now }), ["debug-c.log"]);
    assert.deepEqual(fs.readdirSync(logsDir), ["debug-current.log"]);
    logger.logFile = null;
  }));

test("starting file logging applies retention before opening the new file", () =>
  withLogger(async (logger, logsDir) => {
    writeLog(logsDir, "debug-stale.log", 10, Date.now() - 31 * DAY_MS);
    logger.initializeFileLogging();
    assert.equal(fs.existsSync(path.join(logsDir, "debug-stale.log")), false);
    assert.ok(logger.getLogPath().startsWith(logsDir));
    await closeLogger(logger);
  }));

test("past the file size limit, logging continues in a new file that names the previous one", () =>
  withLogger(async (logger, _logsDir) => {
    logger.initializeFileLogging();
    const first = logger.getLogPath();
    logger.retention.maxFileBytes = 4000;

    for (let i = 0; i < 100 && logger.getLogPath() === first; i += 1) {
      logger.info("filler line", { i, padding: "y".repeat(100) });
    }

    const second = logger.getLogPath();
    assert.notEqual(second, first, "rotated to a new file");
    assert.ok(path.basename(second).startsWith("debug-"));
    await closeLogger(logger);
    assert.ok(fs.existsSync(first), "the previous file is kept");
    const contents = fs.readFileSync(second, "utf8");
    assert.match(contents, /Log file continued/);
    assert.ok(contents.includes(path.basename(first)));
  }));
