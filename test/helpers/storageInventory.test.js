const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// Settings › Storage's inventory in main (helpers/storageInventory.js): fixed
// resource ids whose paths main resolves (models through modelDirUtils), sizes
// measured without following links or junctions and cached for a minute,
// paths masked before they reach the renderer, actions by id only, and the
// app cache cleared through the session's cache calls, never its storage.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-inventory-"));
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => scratch, isReady: () => false, isPackaged: false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const inventoryModule = require("../../src/helpers/storageInventory");
Module._load = originalLoad;
const {
  APP_CACHE_DIRS,
  CLEARABLE_RESOURCE_IDS,
  INVENTORY_CACHE_MS,
  STORAGE_RESOURCE_IDS,
  createStorageInventory,
  defaultStorageResources,
  measurePath,
  createLimiter,
} = inventoryModule;

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function writeFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
}

// A home folder with OpenWhispr's data in it, as on Windows.
function makeHome(t, { selfhost = false } = {}) {
  const home = fs.mkdtempSync(path.join(scratch, "home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const userData = path.join(home, "AppData", "Roaming", "open-whispr");
  const homeCache = path.join(home, ".cache", "openwhispr");
  const relocated = path.join(home, "relocated-cache");
  writeFile(path.join(userData, "audio", "OpenWhispr-2026-10-25-08-00-00-1.webm"), 1000);
  writeFile(path.join(userData, "logs", "debug-2026-10-25T08-00-00-000Z.log"), 200);
  writeFile(path.join(userData, "transcriptions.db"), 4000);
  writeFile(path.join(userData, "transcriptions.db-wal"), 300);
  writeFile(path.join(userData, "Local Storage", "leveldb", "000003.log"), 50);
  writeFile(path.join(userData, ".env"), 10);
  writeFile(path.join(userData, "secure-keys", "OPENAI_API_KEY.enc"), 70);
  writeFile(path.join(userData, "Cache", "Cache_Data", "data_0"), 800);
  writeFile(path.join(userData, "GPUCache", "index"), 100);
  writeFile(path.join(userData, "IndexedDB", "big.ldb"), 5000);
  writeFile(path.join(relocated, "parakeet-models", "model.onnx"), 9000);
  writeFile(path.join(relocated, "models", "llm.gguf"), 600);
  writeFile(path.join(homeCache, "embedding-models", "model.onnx"), 400);
  writeFile(path.join(homeCache, "qdrant-data", "collection", "segment"), 2000);
  writeFile(path.join(home, ".openwhispr", "cli-bridge.json"), 5);
  if (selfhost) writeFile(path.join(home, "AppData", "Local", "OpenWhispr-selfhost", "x"), 7);
  const modelDirUtils = {
    getCacheRoot: () => relocated,
    getModelsDirForService: (service) => path.join(relocated, `${service}-models`),
  };
  return { home, userData, homeCache, relocated, modelDirUtils };
}

function resourcesFor(home, { platform = "win32", env = {} } = {}) {
  return defaultStorageResources({
    userData: home.userData,
    homeDir: home.home,
    platform,
    env: { LOCALAPPDATA: path.join(home.home, "AppData", "Local"), ...env },
    modelDirUtils: home.modelDirUtils,
  });
}

function inventoryFor(home, overrides = {}) {
  return createStorageInventory({
    resolveResources: () => resourcesFor(home, overrides),
    homeDir: home.home,
    platform: "win32",
    ...overrides,
  });
}

test("the fixed ids and where main finds them; models follow the relocated cache", (t) => {
  const home = makeHome(t);
  const resources = resourcesFor(home);
  const byId = Object.fromEntries(resources.map((resource) => [resource.id, resource]));
  assert.deepEqual(
    resources.map((resource) => resource.id),
    STORAGE_RESOURCE_IDS.filter((id) => id !== "selfhost"),
    "no selfhost folder, no selfhost row"
  );
  const parts = (id) => byId[id].parts.map((part) => part.path);
  assert.deepEqual(parts("recordings"), [path.join(home.userData, "audio")]);
  assert.deepEqual(parts("database"), [
    path.join(home.userData, "transcriptions.db"),
    path.join(home.userData, "transcriptions.db-wal"),
    path.join(home.userData, "transcriptions.db-shm"),
  ]);
  assert.deepEqual(parts("settings"), [
    path.join(home.userData, "Local Storage"),
    path.join(home.userData, ".env"),
  ]);
  assert.deepEqual(
    byId.models.parts.map((part) => [part.key, part.path]),
    [
      ["whisper", path.join(home.relocated, "whisper-models")],
      ["parakeet", path.join(home.relocated, "parakeet-models")],
      ["diarization", path.join(home.relocated, "diarization-models")],
      ["llm", path.join(home.relocated, "models")],
      ["embedding", path.join(home.homeCache, "embedding-models")],
    ]
  );
  assert.equal(byId.models.open.path, home.relocated);
  assert.deepEqual(parts("searchIndex"), [path.join(home.homeCache, "qdrant-data")]);
  assert.deepEqual(
    parts("appCache"),
    APP_CACHE_DIRS.map((name) => path.join(home.userData, name))
  );
  assert.ok(!APP_CACHE_DIRS.includes("IndexedDB") && !APP_CACHE_DIRS.includes("Local Storage"));
  assert.deepEqual(parts("cliBridge"), [path.join(home.home, ".openwhispr", "cli-bridge.json")]);

  const dev = resourcesFor(home, { env: { NODE_ENV: "development" } });
  const devById = Object.fromEntries(dev.map((resource) => [resource.id, resource]));
  assert.equal(devById.database.parts[0].path, path.join(home.userData, "transcriptions-dev.db"));
  assert.equal(devById.searchIndex.parts[0].path, path.join(home.homeCache, "qdrant-data-dev"));
});

test("the self-hosted builds folder is listed on Windows when it exists, never measured", async (t) => {
  const home = makeHome(t, { selfhost: true });
  assert.ok(resourcesFor(home).some((resource) => resource.id === "selfhost"));
  assert.ok(!resourcesFor(home, { platform: "linux" }).some((r) => r.id === "selfhost"));
  const result = await inventoryFor(home).inventory();
  const selfhost = result.items.find((item) => item.id === "selfhost");
  assert.equal(selfhost.bytes, null);
  assert.equal(selfhost.exists, true);
  assert.equal(
    selfhost.path,
    "%USERPROFILE%\\AppData\\Local\\OpenWhispr-selfhost".replace(/\\/g, path.sep)
  );
});

test("sizes per id, with the user profile masked in every path", async (t) => {
  const home = makeHome(t);
  const result = await inventoryFor(home).inventory();
  const item = (id) => result.items.find((entry) => entry.id === id);
  assert.equal(item("recordings").bytes, 1000);
  assert.equal(item("logs").bytes, 200);
  assert.equal(item("database").bytes, 4300, "the file and its WAL");
  assert.equal(item("database").target, "file");
  assert.equal(item("settings").bytes, 60);
  assert.equal(item("secrets").bytes, 70);
  assert.equal(item("models").bytes, 10000);
  assert.deepEqual(
    item("models").parts.map((part) => [part.key, part.bytes]),
    [
      ["whisper", 0],
      ["parakeet", 9000],
      ["diarization", 0],
      ["llm", 600],
      ["embedding", 400],
    ]
  );
  assert.equal(item("searchIndex").bytes, 2000);
  assert.equal(item("appCache").bytes, 900, "Chromium's caches, not its storage");
  assert.equal(item("cliBridge").bytes, 5);
  assert.equal(result.totalBytes, 1000 + 200 + 4300 + 60 + 70 + 10000 + 2000 + 900 + 5);
  assert.deepEqual(
    result.items.filter((entry) => entry.clearable).map((entry) => entry.id),
    [...CLEARABLE_RESOURCE_IDS]
  );
  const sep = path.sep;
  assert.equal(
    item("recordings").path,
    `%USERPROFILE%${sep}AppData${sep}Roaming${sep}open-whispr${sep}audio`
  );
  for (const entry of result.items) {
    for (const value of [entry.path, ...entry.paths]) {
      assert.ok(value.startsWith("%USERPROFILE%"), `${entry.id}: ${value}`);
      assert.ok(!value.includes(home.home), `${entry.id} leaks the home folder`);
    }
  }
  assert.equal(result.database.counts, null, "no database handle, no counts");
  assert.equal(result.recordingPace, null);
});

test("symbolic links and junctions are never followed", async (t) => {
  const home = makeHome(t);
  const outside = fs.mkdtempSync(path.join(scratch, "outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  writeFile(path.join(outside, "huge.bin"), 50000);
  const audio = path.join(home.userData, "audio");
  try {
    fs.symlinkSync(outside, path.join(audio, "linked"), "junction");
  } catch (error) {
    t.skip(`can't create a junction or link here: ${error.code}`);
    return;
  }
  const limit = createLimiter(4);
  const measured = await measurePath(audio, { limit });
  assert.deepEqual(measured, { exists: true, bytes: 1000, files: 1 });
  const direct = await measurePath(path.join(audio, "linked"), { limit });
  assert.equal(direct.bytes, 0, "a link itself counts as nothing");
});

test("measuring runs at most the given number of file operations at once", async () => {
  const limit = createLimiter(3);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
      })
    )
  );
  assert.equal(peak, 3);
});

test("cached for a minute; Refresh and a clear measure again", async (t) => {
  const home = makeHome(t);
  let now = 1_000_000;
  let resolves = 0;
  const inventory = createStorageInventory({
    resolveResources: () => {
      resolves++;
      return resourcesFor(home);
    },
    homeDir: home.home,
    platform: "win32",
    now: () => now,
    clearLogs: () => ({ deleted: 1, failed: [] }),
  });
  const first = await inventory.inventory();
  assert.equal(first.cached, false);
  now += INVENTORY_CACHE_MS - 1;
  assert.equal((await inventory.inventory()).cached, true);
  assert.equal(resolves, 1);
  assert.equal((await inventory.inventory({ refresh: true })).cached, false, "Refresh bypasses");
  assert.equal(resolves, 2);
  now += INVENTORY_CACHE_MS;
  assert.equal((await inventory.inventory()).cached, false, "a minute later it measures again");
  assert.equal(resolves, 3);
  await inventory.clear("logs");
  assert.equal((await inventory.inventory()).cached, false, "a clear drops the cache");
  // Two requests at once share one measurement.
  await inventory.inventory({ refresh: true });
  const before = resolves;
  await Promise.all([
    inventory.inventory({ refresh: true }),
    inventory.inventory({ refresh: true }),
  ]);
  assert.equal(resolves, before + 1);
});

test("actions take an id, never a path: Open, Show in folder, and unknown ids refused", async (t) => {
  const home = makeHome(t);
  const opened = [];
  const shown = [];
  const inventory = inventoryFor(home, {
    openPath: async (target) => {
      opened.push(target);
      return "";
    },
    showItemInFolder: (target) => shown.push(target),
  });
  assert.deepEqual(await inventory.open("recordings"), { success: true });
  assert.deepEqual(await inventory.open("database"), { success: true });
  assert.deepEqual(await inventory.open("models"), { success: true });
  assert.deepEqual(opened, [path.join(home.userData, "audio"), home.relocated]);
  assert.deepEqual(shown, [path.join(home.userData, "transcriptions.db")]);
  for (const bad of [home.userData, "C:\\Windows", "../audio", "", null, { id: "logs" }]) {
    assert.deepEqual(await inventory.open(bad), { success: false, error: "unknown" }, String(bad));
  }
  assert.equal(opened.length, 2, "nothing else was opened");

  fs.rmSync(path.join(home.userData, "secure-keys"), { recursive: true });
  assert.deepEqual(await inventory.open("secrets"), { success: false, error: "missing" });
  fs.rmSync(path.join(home.userData, "audio"), { recursive: true });
  assert.deepEqual(await inventory.open("recordings"), { success: true }, "created first");
  assert.ok(fs.existsSync(path.join(home.userData, "audio")));
});

test("only recordings, logs and the app cache clear; the app cache only through the session's caches", async (t) => {
  const home = makeHome(t);
  const calls = [];
  const session = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        async (...args) => {
          calls.push([name, args]);
        },
    }
  );
  const inventory = inventoryFor(home, {
    getSession: () => session,
    clearRecordings: () => ({ deleted: 3, failed: 1 }),
    clearLogs: () => ({ deleted: 2, failed: ["debug-a.log"] }),
  });
  assert.deepEqual(await inventory.clear("appCache"), { success: true });
  assert.deepEqual(calls, [
    ["clearCache", []],
    ["clearCodeCaches", [{}]],
  ]);
  assert.ok(!calls.some(([name]) => name === "clearStorageData"));
  assert.deepEqual(await inventory.clear("recordings"), { success: false, deleted: 3, failed: 1 });
  assert.deepEqual(await inventory.clear("logs"), { success: false, deleted: 2, failed: 1 });
  for (const id of [
    "database",
    "settings",
    "secrets",
    "models",
    "searchIndex",
    "cliBridge",
    "selfhost",
    "x",
  ]) {
    assert.deepEqual(await inventory.clear(id), { success: false, error: "not-clearable" }, id);
  }
  assert.equal(calls.length, 2, "nothing else touched the session");
});
