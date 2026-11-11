const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { deferred } = require("./harness/deferred");
// The real parser, taken before any test stubs dotenv's loader
const { parse: parseDotenv } = require("dotenv");

// #2585: the log level must survive every full .env rewrite. In the fork the
// level is Settings › Storage › Logs' setting (off, warn or debug), persisted
// with its retention and text switch.
const ENV_KEYS = [
  "OPENWHISPR_LOG_LEVEL",
  "OPENWHISPR_LOG_RETENTION_DAYS",
  "OPENWHISPR_LOG_TEXT",
  "DICTATION_KEY",
  "ACTIVATION_MODE",
];

function snapshotEnvironment() {
  return new Map(
    ENV_KEYS.map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
}

function restoreEnvironment(snapshot) {
  for (const [name, { present, value }] of snapshot) {
    if (present) process.env[name] = value;
    else delete process.env[name];
  }
}

function loadEnvironmentManager(t, userDataDirectory) {
  const environmentPath = require.resolve("../../src/helpers/environment");
  const originalEnvironmentModule = require.cache[environmentPath];
  const originalLoad = Module._load;
  delete require.cache[environmentPath];

  Module._load = function loadWithTestDependencies(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => userDataDirectory,
          getAppPath: () => userDataDirectory,
          isReady: () => false,
        },
        safeStorage: { isEncryptionAvailable: () => false },
      };
    }
    if (request === "./secretCrypto") return { isAvailable: () => false };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(environmentPath);
  } finally {
    Module._load = originalLoad;
    t.after(() => {
      if (originalEnvironmentModule) require.cache[environmentPath] = originalEnvironmentModule;
      else delete require.cache[environmentPath];
    });
  }
}

// Loads only the userData .env (as dotenv would at startup) so a developer's
// repo-root .env cannot leak into the test.
function installDotenvStub(t, userDataEnvPath) {
  const dotenvPath = require.resolve("dotenv");
  const originalDotenv = require.cache[dotenvPath];
  require.cache[dotenvPath] = {
    id: dotenvPath,
    filename: dotenvPath,
    loaded: true,
    exports: {
      config: ({ path: envPath, override }) => {
        if (envPath !== userDataEnvPath || !fs.existsSync(envPath)) return { parsed: {} };
        const parsed = parseDotenv(fs.readFileSync(envPath, "utf8"));
        for (const [name, value] of Object.entries(parsed)) {
          if (override || !Object.hasOwn(process.env, name)) process.env[name] = value;
        }
        return { parsed };
      },
    },
  };
  t.after(() => {
    if (originalDotenv) require.cache[dotenvPath] = originalDotenv;
    else delete require.cache[dotenvPath];
  });
}

function setup(t) {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-debug-log-level-"));
  const environmentSnapshot = snapshotEnvironment();
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  for (const name of ENV_KEYS) delete process.env[name];
  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });
  const envPath = path.join(userDataDirectory, ".env");
  installDotenvStub(t, envPath);
  return { EnvironmentManager: loadEnvironmentManager(t, userDataDirectory), envPath };
}

// Settings setters fire saveAllKeysToEnvFile() without awaiting it
function trackSaves(environmentManager) {
  const saveAllKeysToEnvFile = environmentManager.saveAllKeysToEnvFile.bind(environmentManager);
  const tracked = { last: null };
  environmentManager.saveAllKeysToEnvFile = () => (tracked.last = saveAllKeysToEnvFile());
  return tracked;
}

// Settings › Storage › Logs changes the level through set-log-settings
// (logIpc.js): validated, saved by EnvironmentManager.saveLogSettings, then
// applied and announced to every window (upstream's set-debug-logging toggle
// announced log-level-changed the same way). The fork's page replaced that toggle.
function loadLogSettingsHandler(environmentManager, onBroadcast = () => {}) {
  const { createLogHandlers } = require("../../src/helpers/logIpc");
  const logger = {
    refreshed: 0,
    includeText: false,
    getLevel: () => process.env.OPENWHISPR_LOG_LEVEL || "warn",
    refreshLogLevel() {
      this.refreshed += 1;
    },
    getLogInfo: () => ({ logsDir: null }),
  };
  const handlers = createLogHandlers({
    logger,
    environmentManager,
    broadcast: onBroadcast,
    mask: (folder) => folder,
    system: () => ({}),
  });
  return { setLogSettings: (input) => handlers.setLogSettings(input), logger };
}

test("debug logging enabled in Settings survives a settings save and the next launch", async (t) => {
  const { EnvironmentManager, envPath } = setup(t);
  // A level saved by Storage › Logs (Everything), or hand-added by an older build
  fs.writeFileSync(
    envPath,
    [
      "# OpenWhispr Environment Variables",
      "DICTATION_KEY=Fn",
      "ACTIVATION_MODE=tap",
      "",
      "# Debug logging setting",
      "OPENWHISPR_LOG_LEVEL=debug",
    ].join("\n")
  );

  const environmentManager = new EnvironmentManager();
  const saves = trackSaves(environmentManager);
  environmentManager.saveActivationMode("push");
  assert.ok(saves.last);
  await saves.last;

  const saved = parseDotenv(fs.readFileSync(envPath, "utf8"));
  assert.equal(saved.ACTIVATION_MODE, "push");
  assert.equal(saved.OPENWHISPR_LOG_LEVEL, "debug");

  // Next launch: a fresh process reads the level back from .env
  for (const name of ENV_KEYS) delete process.env[name];
  new EnvironmentManager();
  assert.equal(process.env.OPENWHISPR_LOG_LEVEL, "debug");
});

test("a saved level persists as written; never set writes no line", async (t) => {
  const { EnvironmentManager, envPath } = setup(t);
  fs.writeFileSync(envPath, "DICTATION_KEY=Fn\n");

  const environmentManager = new EnvironmentManager();
  const saves = trackSaves(environmentManager);
  environmentManager.saveActivationMode("push");
  await saves.last;
  assert.doesNotMatch(fs.readFileSync(envPath, "utf8"), /OPENWHISPR_LOG_LEVEL/);

  // An older build's "debug off" value: kept verbatim, read as Problems only
  // (logPolicy.settingLevelFrom)
  process.env.OPENWHISPR_LOG_LEVEL = "info";
  environmentManager.saveActivationMode("tap");
  await saves.last;
  assert.equal(parseDotenv(fs.readFileSync(envPath, "utf8")).OPENWHISPR_LOG_LEVEL, "info");
});

test("Storage › Logs creates a missing settings file", async (t) => {
  const { EnvironmentManager, envPath } = setup(t);
  const notifications = [];
  const { setLogSettings, logger } = loadLogSettingsHandler(
    new EnvironmentManager(),
    (channel, state) => {
      notifications.push({
        channel,
        savedLevel: parseDotenv(fs.readFileSync(envPath, "utf8")).OPENWHISPR_LOG_LEVEL,
        level: state.level,
      });
    }
  );

  await setLogSettings({ level: "debug" });

  assert.equal(parseDotenv(fs.readFileSync(envPath, "utf8")).OPENWHISPR_LOG_LEVEL, "debug");
  assert.equal(logger.refreshed, 1, "the new level is applied once saved");
  assert.deepEqual(notifications, [
    { channel: "log-settings-changed", savedLevel: "debug", level: "debug" },
  ]);
});

test("a failed log level save reports failure, leaks nothing, and the next change persists", async (t) => {
  const { EnvironmentManager, envPath } = setup(t);
  process.env.OPENWHISPR_LOG_LEVEL = "warn";
  const environmentManager = new EnvironmentManager();
  const notifications = [];
  const { setLogSettings, logger } = loadLogSettingsHandler(environmentManager, (_, state) =>
    notifications.push(state.level)
  );
  t.mock.method(
    fsPromises,
    "writeFile",
    async () => {
      throw new Error("Disk write failed");
    },
    { times: 1 }
  );

  await assert.rejects(setLogSettings({ level: "debug" }), /Disk write failed/);
  assert.equal(fs.existsSync(envPath), false);
  assert.equal(process.env.OPENWHISPR_LOG_LEVEL, "warn", "the session keeps the saved level");
  assert.equal(logger.refreshed, 0, "nothing was applied");
  assert.deepEqual(notifications, [], "failed saves must not notify windows");

  // The next settings save writes the level that was saved, not the refused one.
  await environmentManager.saveAllKeysToEnvFile();
  assert.equal(parseDotenv(fs.readFileSync(envPath, "utf8")).OPENWHISPR_LOG_LEVEL, "warn");

  await setLogSettings({ level: "off" });
  assert.equal(parseDotenv(fs.readFileSync(envPath, "utf8")).OPENWHISPR_LOG_LEVEL, "off");
  assert.deepEqual(notifications, ["off"]);
});

for (const level of ["off", "debug"]) {
  // Upstream's toggle edited its one line in place; the fork's page saves like
  // every other setting, a rewrite from PERSISTED_KEYS that keeps them all.
  test(`setting the log level to ${level} keeps every other saved setting`, async (t) => {
    const { EnvironmentManager, envPath } = setup(t);
    fs.writeFileSync(envPath, "DICTATION_KEY=Fn\nACTIVATION_MODE=tap\nOPENWHISPR_LOG_LEVEL=warn\n");
    const { setLogSettings } = loadLogSettingsHandler(new EnvironmentManager());

    await setLogSettings({ level });

    const saved = parseDotenv(fs.readFileSync(envPath, "utf8"));
    assert.equal(saved.OPENWHISPR_LOG_LEVEL, level);
    assert.equal(saved.DICTATION_KEY, "Fn");
    assert.equal(saved.ACTIVATION_MODE, "tap");
  });

  test(`setting the log level to ${level} survives an in-flight settings save`, async (t) => {
    const { EnvironmentManager, envPath } = setup(t);
    fs.writeFileSync(envPath, `OPENWHISPR_LOG_LEVEL=${level === "off" ? "debug" : "off"}\n`);
    const environmentManager = new EnvironmentManager();
    const { setLogSettings } = loadLogSettingsHandler(environmentManager);
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const writeFile = fsPromises.writeFile;
    let heldWrite = false;
    t.mock.method(fsPromises, "writeFile", async (file, ...args) => {
      if (file === `${envPath}.tmp` && !heldWrite) {
        heldWrite = true;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      return writeFile(file, ...args);
    });

    const saves = trackSaves(environmentManager);
    environmentManager.saveActivationMode("push");
    await writeStarted.promise;
    let changeSettled = false;
    const change = setLogSettings({ level }).then((result) => {
      changeSettled = true;
      return result;
    });
    let settledBeforeWrite;
    try {
      await new Promise((resolve) => setImmediate(resolve));
      settledBeforeWrite = changeSettled;
    } finally {
      releaseWrite.resolve();
    }
    await Promise.all([change, saves.last]);

    const saved = parseDotenv(fs.readFileSync(envPath, "utf8"));
    assert.equal(saved.OPENWHISPR_LOG_LEVEL, level);
    assert.equal(saved.ACTIVATION_MODE, "push");
    assert.equal(settledBeforeWrite, false, "success must wait for queued persistence");

    for (const name of ENV_KEYS) delete process.env[name];
    new EnvironmentManager();
    assert.equal(process.env.OPENWHISPR_LOG_LEVEL, level);
  });
}
