const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const KEY = "OPENWHISPR_CLOUD_DISABLED";

function loadEnvironmentManager(t, userDataDirectory) {
  const environmentPath = require.resolve("../../src/helpers/environment");
  const originalModule = require.cache[environmentPath];
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
      if (originalModule) require.cache[environmentPath] = originalModule;
      else delete require.cache[environmentPath];
    });
  }
}

function preserveKey(t) {
  const present = Object.hasOwn(process.env, KEY);
  const value = process.env[KEY];
  t.after(() => {
    if (present) process.env[KEY] = value;
    else delete process.env[KEY];
  });
}

test("the switch is on disk before saving reports success, and off again removes it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cloud-switch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  preserveKey(t);
  delete process.env[KEY];
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = dir;
  t.after(() => {
    process.resourcesPath = originalResourcesPath;
  });

  const EnvironmentManager = loadEnvironmentManager(t, dir);
  const manager = new EnvironmentManager();
  assert.equal(manager.getOpenWhisprCloudDisabled(), false);

  assert.deepEqual(await manager.saveOpenWhisprCloudDisabled(true), { success: true });
  assert.match(
    fs.readFileSync(path.join(dir, ".env"), "utf8"),
    /^OPENWHISPR_CLOUD_DISABLED=true$/m
  );
  assert.equal(manager.getOpenWhisprCloudDisabled(), true);

  await manager.saveOpenWhisprCloudDisabled(false);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, ".env"), "utf8"), /OPENWHISPR_CLOUD_DISABLED/);
  assert.equal(manager.getOpenWhisprCloudDisabled(), false);
});

test("a failed write rejects instead of reporting the switch saved", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cloud-switch-fail-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  preserveKey(t);
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = parent;
  t.after(() => {
    process.resourcesPath = originalResourcesPath;
  });

  // A userData directory that doesn't exist: the atomic write can't create its temp file.
  const missing = path.join(parent, "does-not-exist");
  const EnvironmentManager = loadEnvironmentManager(t, missing);
  const manager = new EnvironmentManager();
  await assert.rejects(manager.saveOpenWhisprCloudDisabled(true));
});
