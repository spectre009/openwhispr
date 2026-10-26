const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_ENV = ["OPENWHISPR_LOG_LEVEL", "OPENWHISPR_LOG_RETENTION_DAYS", "OPENWHISPR_LOG_TEXT"];

// A fresh logger whose userData is a temp folder; electron is stubbed, and the
// log settings come from `env` as if .env had loaded them.
function withLogger(env, run) {
  if (typeof env === "function") return withLogger({}, env);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugLogger-retention-"));
  const logsDir = path.join(tempDir, "logs");
  fs.mkdirSync(logsDir);
  const electronPath = require.resolve("electron");
  const loggerPath = require.resolve("../../src/helpers/debugLogger.js");
  const originalElectron = require.cache[electronPath];
  const originalLogger = require.cache[loggerPath];
  const savedEnv = Object.fromEntries(LOG_ENV.map((key) => [key, process.env[key]]));
  for (const key of LOG_ENV) delete process.env[key];
  Object.assign(process.env, env);
  require.cache[electronPath] = {
    exports: {
      app: {
        isReady: () => true,
        isPackaged: true,
        getPath: () => tempDir,
        getAppPath: () => "/mock/app",
        getVersion: () => "9.9.9-test",
      },
    },
  };
  delete require.cache[loggerPath];
  let logger = null;
  const finish = async () => {
    if (logger) {
      logger.stopMaintenance();
      await closeLogger(logger);
    }
    delete require.cache[loggerPath];
    if (originalLogger) require.cache[loggerPath] = originalLogger;
    if (originalElectron) require.cache[electronPath] = originalElectron;
    else delete require.cache[electronPath];
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  return Promise.resolve()
    .then(() => {
      logger = require(loggerPath);
      logger.consoleLoggingEnabled = false;
      return run(logger, logsDir);
    })
    .finally(finish);
}

function writeLog(dir, name, bytes, mtimeMs) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "x".repeat(bytes));
  const when = new Date(mtimeMs);
  fs.utimesSync(filePath, when, when);
  return filePath;
}

// debug-<ISO>.log named for a time `ago` ms back.
const stampName = (ago, suffix = "") =>
  `debug-${new Date(Date.now() - ago).toISOString().replace(/[:.]/g, "-")}${suffix}.log`;

async function closeLogger(logger) {
  const stream = logger.logStream;
  if (!stream) return;
  if (typeof stream.fd !== "number" && !stream.destroyed) {
    await new Promise((resolve) => {
      stream.once("open", resolve);
      stream.once("error", resolve);
    });
  }
  logger.close();
  await new Promise((resolve) => {
    if (stream.closed) resolve();
    else stream.once("close", resolve);
  });
}

// Until the current file exists on disk (streams open asynchronously).
async function opened(logger) {
  const stream = logger.logStream;
  if (stream && typeof stream.fd !== "number") {
    await new Promise((resolve) => stream.once("open", resolve));
  }
}

// Until the stream has written everything queued.
async function flushed(logger) {
  for (let i = 0; i < 200 && logger.logStream?.writableLength > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("at Problems only (the default), logs older than 7 days are deleted; others are kept", () =>
  withLogger((logger, logsDir) => {
    const now = Date.now();
    assert.equal(logger.retentionDays, 7);
    writeLog(logsDir, "debug-old.log", 10, now - 8 * DAY_MS);
    writeLog(logsDir, "debug-recent.log", 10, now - 6 * DAY_MS);
    writeLog(logsDir, "notes.log", 10, now - 40 * DAY_MS);
    writeLog(logsDir, "debug-old.txt", 10, now - 40 * DAY_MS);

    assert.deepEqual(logger.pruneLogs(logsDir, { now }), ["debug-old.log"]);
    assert.deepEqual(fs.readdirSync(logsDir).sort(), [
      "debug-old.txt",
      "debug-recent.log",
      "notes.log",
    ]);
  }));

test("Everything keeps 30 days by default; a chosen retention wins", async () => {
  await withLogger({ OPENWHISPR_LOG_LEVEL: "debug" }, (logger) => {
    assert.equal(logger.retentionDays, 30);
  });
  await withLogger(
    { OPENWHISPR_LOG_LEVEL: "debug", OPENWHISPR_LOG_RETENTION_DAYS: "14" },
    (logger) => assert.equal(logger.retentionDays, 14)
  );
  await withLogger({ OPENWHISPR_LOG_RETENTION_DAYS: "5" }, (logger) => {
    assert.equal(logger.retentionDays, 7, "an unknown value reads as the default");
  });
});

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

test("files with dictated text go 3 days after they began, whatever the retention", () =>
  withLogger({ OPENWHISPR_LOG_RETENTION_DAYS: "90" }, (logger, logsDir) => {
    const now = Date.now();
    // Began 4 days ago, last written an hour ago: still past the 3 days.
    const stale = stampName(4 * DAY_MS, "-text");
    writeLog(logsDir, stale, 10, now - 3600_000);
    const fresh = stampName(2 * DAY_MS, "-text");
    writeLog(logsDir, fresh, 10, now - 3600_000);
    const plain = stampName(30 * DAY_MS);
    writeLog(logsDir, plain, 10, now - 29 * DAY_MS);
    // The active -text file stays, however old.
    const active = stampName(5 * DAY_MS, "-text");
    logger.logFile = writeLog(logsDir, active, 10, now - 5 * DAY_MS);

    assert.deepEqual(logger.pruneLogs(logsDir, { now }), [stale]);
    assert.deepEqual(fs.readdirSync(logsDir).sort(), [active, fresh, plain].sort());
    logger.logFile = null;
  }));

test("starting applies retention before the first file, and its first line says what it did", () =>
  withLogger(async (logger, logsDir) => {
    writeLog(logsDir, ".text-policy-1", 1, Date.now());
    writeLog(logsDir, "debug-stale.log", 10, Date.now() - 8 * DAY_MS);
    logger.initializeFileLogging();
    assert.equal(fs.existsSync(path.join(logsDir, "debug-stale.log")), false);
    const logFile = logger.getLogPath();
    assert.ok(logFile.startsWith(logsDir));
    await closeLogger(logger);
    const firstLine = fs.readFileSync(logFile, "utf8").split("\n")[0];
    assert.match(firstLine, /\[INFO\] System Info \{/);
    const header = JSON.parse(firstLine.slice(firstLine.indexOf("{")));
    assert.equal(header.appVersion, "9.9.9-test");
    assert.equal(header.removedOldLogs, 1);
    assert.deepEqual(header.logging, {
      level: "warn",
      effectiveLevel: "warn",
      overriddenBy: null,
      retentionDays: 7,
      includeText: false,
    });
  }));

test("the first start of this version treats older logs as holding dictated text, once", () =>
  withLogger(async (logger, logsDir) => {
    const now = Date.now();
    const old = writeLog(logsDir, stampName(5 * DAY_MS), 10, now - 4 * DAY_MS);
    const recentName = stampName(DAY_MS);
    writeLog(logsDir, recentName, 10, now - DAY_MS);

    logger.ensureFileLogging();
    assert.equal(fs.existsSync(old), false, "past 3 days: deleted");
    const renamed = recentName.replace(/\.log$/, "-text.log");
    assert.ok(fs.existsSync(path.join(logsDir, renamed)), "the rest now carry -text");
    assert.ok(fs.existsSync(path.join(logsDir, ".text-policy-1")), "the marker records it");

    const logFile = logger.getLogPath();
    await closeLogger(logger);
    const header = JSON.parse(
      fs
        .readFileSync(logFile, "utf8")
        .split("\n")[0]
        .replace(/^[^{]*/, "")
    );
    assert.equal(header.textPolicyRemoved, 1, "the first line reports it");

    // Never again: a marker present means a plain old log is just a log.
    const later = writeLog(logsDir, stampName(5 * DAY_MS), 10, now - 4 * DAY_MS);
    assert.equal(logger.applyTextPolicyOnce(logsDir), null);
    assert.ok(fs.existsSync(later));
  }));

test("Off writes nothing new but still prunes, at start and when retention shortens", () =>
  withLogger(
    { OPENWHISPR_LOG_LEVEL: "off", OPENWHISPR_LOG_RETENTION_DAYS: "30" },
    (logger, logsDir) => {
      const now = Date.now();
      writeLog(logsDir, ".text-policy-1", 1, now);
      writeLog(logsDir, "debug-40d.log", 10, now - 40 * DAY_MS);
      writeLog(logsDir, "debug-20d.log", 10, now - 20 * DAY_MS);
      writeLog(logsDir, "debug-10d.log", 10, now - 10 * DAY_MS);

      logger.ensureFileLogging();
      logger.warn("Not written anywhere");
      assert.equal(logger.getLogPath(), null);
      assert.deepEqual(fs.readdirSync(logsDir).sort(), [
        ".text-policy-1",
        "debug-10d.log",
        "debug-20d.log",
      ]);

      process.env.OPENWHISPR_LOG_RETENTION_DAYS = "14";
      logger.refreshLogLevel();
      assert.deepEqual(fs.readdirSync(logsDir).sort(), [".text-policy-1", "debug-10d.log"]);

      // The 6-hour pass runs while Off too.
      process.env.OPENWHISPR_LOG_RETENTION_DAYS = "7";
      logger.resolveSettings();
      logger.runMaintenance();
      assert.deepEqual(fs.readdirSync(logsDir), [".text-policy-1"]);
    }
  ));

test("past the file size limit, logging continues in a new file that names the previous one", () =>
  withLogger(async (logger, _logsDir) => {
    logger.initializeFileLogging();
    const first = logger.getLogPath();
    logger.retention.maxFileBytes = 4000;

    for (let i = 0; i < 100 && logger.getLogPath() === first; i += 1) {
      logger.warn("filler line", { i, padding: "y".repeat(100) });
    }

    const second = logger.getLogPath();
    assert.notEqual(second, first, "rotated to a new file");
    assert.ok(path.basename(second).startsWith("debug-"));
    await closeLogger(logger);
    assert.ok(fs.existsSync(first), "the previous file is kept");
    const header = fs.readFileSync(second, "utf8").split("\n")[0];
    assert.match(header, /System Info/);
    assert.ok(header.includes(`"continues":"${path.basename(first)}"`));
    assert.ok(header.includes('"reason":"size"'));
  }));

test("a -text file continues in a new one once it's a day old", () =>
  withLogger({ OPENWHISPR_LOG_TEXT: "true" }, async (logger) => {
    logger.initializeFileLogging();
    const first = logger.getLogPath();
    assert.match(path.basename(first), /-text\.log$/);

    // The 6-hour pass notices a day-old file even if nothing is written.
    logger.runMaintenance({ now: logger.logOpenedAt + 23 * 3600_000 });
    assert.equal(logger.getLogPath(), first);
    logger.runMaintenance({ now: logger.logOpenedAt + 24 * 3600_000 });
    const second = logger.getLogPath();
    assert.notEqual(second, first);
    assert.match(path.basename(second), /-text\.log$/);

    // So does the next write.
    logger.logOpenedAt -= 24 * 3600_000;
    logger.warn("after a day");
    assert.notEqual(logger.getLogPath(), second);
  }));

test("turning dictated text on or off starts a new file named for it", () =>
  withLogger(async (logger) => {
    logger.initializeFileLogging();
    const plain = logger.getLogPath();
    assert.doesNotMatch(path.basename(plain), /-text/);

    process.env.OPENWHISPR_LOG_TEXT = "true";
    logger.refreshLogLevel();
    const withText = logger.getLogPath();
    assert.match(path.basename(withText), /-text\.log$/);

    delete process.env.OPENWHISPR_LOG_TEXT;
    logger.refreshLogLevel();
    const after = logger.getLogPath();
    assert.doesNotMatch(path.basename(after), /-text/);
    assert.notEqual(after, plain);
  }));

test("switching the level live opens and closes the file", () =>
  withLogger({ OPENWHISPR_LOG_LEVEL: "off" }, async (logger, logsDir) => {
    logger.ensureFileLogging();
    assert.equal(logger.getLogPath(), null);

    process.env.OPENWHISPR_LOG_LEVEL = "debug";
    logger.refreshLogLevel();
    const file = logger.getLogPath();
    assert.ok(file, "Everything opens a file");
    logger.debug("step detail");

    const stream = logger.logStream;
    process.env.OPENWHISPR_LOG_LEVEL = "off";
    logger.refreshLogLevel();
    assert.equal(logger.getLogPath(), null, "Off closes it");
    logger.error("after off");
    if (!stream.closed) await new Promise((resolve) => stream.once("close", resolve));
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /step detail/);
    assert.doesNotMatch(text, /after off/);
    assert.equal(fs.readdirSync(logsDir).filter((n) => n.startsWith("debug-")).length, 1);
  }));

test("an entry over 16 KB is cut with a note of its size", () =>
  withLogger(async (logger) => {
    logger.initializeFileLogging();
    const file = logger.getLogPath();
    logger.warn("huge", { blob: "z".repeat(40 * 1024) });
    logger.warn("next entry");
    await closeLogger(logger);
    const text = fs.readFileSync(file, "utf8");
    const start = text.lastIndexOf("\n", text.indexOf("[WARN] huge")) + 1;
    const marker = /… \[entry cut at 16384 of \d+ bytes\]\n/g;
    marker.lastIndex = start;
    const cut = marker.exec(text);
    assert.ok(cut, "the entry says it was cut");
    assert.ok(Buffer.byteLength(text.slice(start, cut.index + cut[0].length)) <= 16 * 1024);
    assert.match(text.slice(cut.index), /next entry/);
  }));

test("while 1 MB waits to be written, entries are dropped and counted once relieved", () =>
  withLogger(async (logger) => {
    logger.initializeFileLogging();
    const file = logger.getLogPath();
    logger.limits.maxQueuedBytes = 2000;
    for (let i = 0; i < 50; i += 1) logger.warn("burst", { i, padding: "q".repeat(200) });
    assert.ok(logger.dropped > 0, "some entries were dropped");
    await flushed(logger);
    logger.warn("after the burst");
    await closeLogger(logger);
    const text = fs.readFileSync(file, "utf8");
    const counts = text.match(/Dropped (\d+) log entries while the disk fell behind/g) || [];
    assert.equal(counts.length, 1, "one counter line");
    assert.match(text, /after the burst/);
  }));

test("a write error turns file logging off for the session, with one console error", () =>
  withLogger(async (logger) => {
    logger.initializeFileLogging();
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args);
    try {
      logger.logStream.emit(
        "error",
        Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" })
      );
      logger.logStream?.emit?.("error", new Error("again"));
      assert.equal(logger.getLogPath(), null);
      assert.doesNotThrow(() => logger.error("still fine"));
      process.env.OPENWHISPR_LOG_LEVEL = "debug";
      logger.refreshLogLevel();
      assert.equal(logger.getLogPath(), null, "no new file this session");
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][1]), /ENOSPC/);
  }));

test("Clear logs closes the file, deletes every log it can and starts a new one", () =>
  withLogger(async (logger, logsDir) => {
    writeLog(logsDir, ".text-policy-1", 1, Date.now());
    writeLog(logsDir, "debug-a.log", 10, Date.now());
    writeLog(logsDir, stampName(0, "-text"), 10, Date.now());
    logger.initializeFileLogging();
    const before = logger.getLogPath();
    logger.warn("before clearing");

    const result = await logger.clearLogs();
    assert.deepEqual(result, { deleted: 3, failed: [] });
    const after = logger.getLogPath();
    assert.ok(after && after !== before, "a fresh file");
    await opened(logger);
    const left = fs.readdirSync(logsDir).sort();
    assert.deepEqual(left, [".text-policy-1", path.basename(after)].sort());
  }));

test("Clear logs reports what it couldn't delete", () =>
  withLogger(async (logger, logsDir) => {
    writeLog(logsDir, ".text-policy-1", 1, Date.now());
    writeLog(logsDir, "debug-a.log", 10, Date.now());
    writeLog(logsDir, "debug-b.log", 10, Date.now());
    const realUnlink = fs.unlinkSync;
    fs.unlinkSync = (target) => {
      if (path.basename(target) === "debug-b.log") {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      }
      return realUnlink(target);
    };
    try {
      process.env.OPENWHISPR_LOG_LEVEL = "off";
      logger.resolveSettings();
      logger.ensureFileLogging();
      assert.deepEqual(await logger.clearLogs(), { deleted: 1, failed: ["debug-b.log"] });
      assert.equal(logger.getLogPath(), null, "Off stays off");
    } finally {
      fs.unlinkSync = realUnlink;
    }
  }));

test("log info sums the folder and names the current file", () =>
  withLogger(
    { OPENWHISPR_LOG_LEVEL: "debug", OPENWHISPR_LOG_TEXT: "true" },
    async (logger, logsDir) => {
      writeLog(logsDir, ".text-policy-1", 1, Date.now());
      writeLog(logsDir, "debug-a.log", 1000, Date.now());
      logger.initializeFileLogging();
      await opened(logger);
      const info = logger.getLogInfo();
      assert.equal(info.level, "debug");
      assert.equal(info.effectiveLevel, "debug");
      assert.equal(info.overriddenBy, null);
      assert.equal(info.retentionDays, 30);
      assert.equal(info.includeText, true);
      assert.equal(info.fileCount, 2);
      assert.ok(info.totalBytes >= 1000);
      assert.equal(info.currentFile, path.basename(logger.getLogPath()));
      assert.equal(info.logsDir, logsDir);
    }
  ));
