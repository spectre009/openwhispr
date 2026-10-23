const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// Style hotkeys survive a restart: the committed map is written to .env as
// DICTATION_STYLE_KEYS through saveAllKeysToEnvFile(), and at the next boot
// main reads it before any window exists and registers the keys with the
// dictation slot. Electron is a stub (a temp userData folder, a fake
// globalShortcut); nothing touches a real .env or registers a real hotkey.

const registered = new Map();
let userDataDirectory = null;

const electronStub = {
  app: {
    getPath: () => userDataDirectory,
    getAppPath: () => userDataDirectory,
    getVersion: () => "0.0.0",
    isReady: () => false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
  globalShortcut: {
    register(accelerator, callback) {
      if (registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      registered.delete(accelerator);
    },
    isRegistered(accelerator) {
      return registered.has(accelerator);
    },
    unregisterAll() {
      registered.clear();
    },
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
};

const ENV_KEYS = ["DICTATION_STYLE_KEYS", "DICTATION_KEY", "UI_LANGUAGE"];
const realDotenv = require("dotenv");

function load(t) {
  const snapshot = new Map(
    ENV_KEYS.map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
  for (const name of ENV_KEYS) delete process.env[name];
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const originalResourcesPath = process.resourcesPath;
  userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-style-hotkeys-"));
  process.resourcesPath = userDataDirectory;

  // .env files are only read through parse in this test: config() would load
  // the developer's own .env from the repository.
  const dotenvPath = require.resolve("dotenv");
  const originalDotenv = require.cache[dotenvPath];
  require.cache[dotenvPath] = {
    id: dotenvPath,
    filename: dotenvPath,
    loaded: true,
    exports: { config: () => ({ parsed: {} }), parse: realDotenv.parse },
  };

  const modules = ["environment", "hotkeyManager", "styleHotkeys"].map((name) =>
    require.resolve(`../../src/helpers/${name}`)
  );
  const originals = modules.map((id) => require.cache[id]);
  for (const id of modules) delete require.cache[id];
  const originalLoad = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (request === "./secretCrypto") return { isAvailable: () => false };
    return originalLoad.call(this, request, parent, isMain);
  };
  let loaded;
  try {
    loaded = {
      EnvironmentManager: require(modules[0]),
      HotkeyManager: require(modules[1]),
      createStyleHotkeys: require(modules[2]).createStyleHotkeys,
    };
  } finally {
    Module._load = originalLoad;
  }

  t.after(() => {
    modules.forEach((id, index) => {
      if (originals[index]) require.cache[id] = originals[index];
      else delete require.cache[id];
    });
    if (originalDotenv) require.cache[dotenvPath] = originalDotenv;
    else delete require.cache[dotenvPath];
    for (const [name, { present, value }] of snapshot) {
      if (present) process.env[name] = value;
      else delete process.env[name];
    }
    Object.defineProperty(process, "platform", originalPlatform);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
    registered.clear();
  });
  return loaded;
}

function makeService(loaded, environmentManager) {
  const hotkeyManager = new loaded.HotkeyManager();
  hotkeyManager.notifyActiveHotkey = () => {};
  hotkeyManager.notifyHotkeyFailure = () => {};
  const service = loaded.createStyleHotkeys({
    hotkeyManager,
    environmentManager,
    logger: { warn() {}, debug() {} },
  });
  return { hotkeyManager, service };
}

test("a style key is written to .env and registered again at the next boot", async (t) => {
  const loaded = load(t);
  const envPath = path.join(userDataDirectory, ".env");

  // First run: the dictation key is in .env and a style key is bound.
  process.env.DICTATION_KEY = "Control+`";
  const firstEnvironment = new loaded.EnvironmentManager();
  const first = makeService(loaded, firstEnvironment);
  first.service.loadFromEnv();
  first.hotkeyManager.setupShortcuts("Control+`", () => {});
  const result = await first.service.set("starter-teams", "Control+Alt+1");
  assert.equal(result.success, true);

  const written = fs.readFileSync(envPath, "utf8");
  assert.match(written, /^DICTATION_STYLE_KEYS=\{"Control\+Alt\+1":"starter-teams"\}$/m);
  assert.match(written, /^DICTATION_KEY=Control\+`$/m);

  // Restart: a fresh process reads .env before any window exists.
  registered.clear();
  for (const name of ENV_KEYS) delete process.env[name];
  Object.assign(process.env, realDotenv.parse(written));
  const secondEnvironment = new loaded.EnvironmentManager();
  const second = makeService(loaded, secondEnvironment);
  second.service.loadFromEnv();
  const callback = () => {};
  await second.hotkeyManager.initializeHotkey(
    { isDestroyed: () => false, webContents: { isLoading: () => false } },
    callback
  );

  assert.deepEqual(second.hotkeyManager.getSlotHotkeys("dictation"), [
    "Control+`",
    "Control+Alt+1",
  ]);
  assert.equal(second.hotkeyManager.getStyleIdForHotkey("Control+Alt+1"), "starter-teams");
  assert.equal(registered.has("Control+Alt+1"), true);
  const state = await second.service.finishBoot();
  assert.deepEqual(state.bindings, [
    { hotkey: "Control+Alt+1", styleId: "starter-teams", active: true, error: null },
  ]);
});

test("removing the last style key takes the line out of .env", async (t) => {
  const loaded = load(t);
  const envPath = path.join(userDataDirectory, ".env");
  process.env.DICTATION_STYLE_KEYS = JSON.stringify({ F21: "starter-email" });

  const environment = new loaded.EnvironmentManager();
  const { hotkeyManager, service } = makeService(loaded, environment);
  service.loadFromEnv();
  hotkeyManager.setupShortcuts("F8", () => {});
  assert.equal(hotkeyManager.getStyleIdForHotkey("F21"), "starter-email");

  const result = await service.syncStyles([]);
  assert.equal(result.success, true);
  assert.deepEqual(result.bindings, []);
  assert.equal(process.env.DICTATION_STYLE_KEYS, undefined);
  assert.doesNotMatch(fs.readFileSync(envPath, "utf8"), /DICTATION_STYLE_KEYS/);
  assert.equal(registered.has("F21"), false);
});
