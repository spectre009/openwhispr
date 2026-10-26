// Settings › Storage: every place OpenWhispr keeps data on this computer, by a
// fixed resource id. Main owns the paths: the renderer names an id, never a
// path, and gets the paths back with the user profile masked (Copy path copies
// that form). Sizes are measured asynchronously with bounded concurrency,
// without following symbolic links or junctions, and cached for a minute
// (Refresh bypasses the cache). Only recordings, logs and the app cache can be
// cleared here.

const fs = require("fs");
const os = require("os");
const path = require("path");
const debugLogger = require("./debugLogger");
const { maskUserProfile } = require("./buildInfo");

const STORAGE_RESOURCE_IDS = Object.freeze([
  "recordings",
  "logs",
  "database",
  "settings",
  "secrets",
  "models",
  "searchIndex",
  "appCache",
  "cliBridge",
  "selfhost",
]);
const CLEARABLE_RESOURCE_IDS = Object.freeze(["recordings", "logs", "appCache"]);
// Chromium's caches in userData. Its storage (Local Storage, IndexedDB, …) holds
// settings and data and is never part of this.
const APP_CACHE_DIRS = Object.freeze([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Shared Dictionary",
]);
const INVENTORY_CACHE_MS = 60 * 1000;
const MEASURE_CONCURRENCY = 8;
const PACE_WINDOW_DAYS = 30;
const DAY_MS = 86400000;

// The History database's tables shown on the Storage page, by what they hold.
const HISTORY_COUNT_TABLES = Object.freeze([
  ["dictations", "transcriptions"],
  ["stepRecords", "transcription_steps"],
  ["reviews", "dictation_feedback"],
  ["testCases", "prompt_test_cases"],
  ["dictionaryWords", "custom_dictionary"],
  ["glossaryRules", "glossary_rules"],
  ["notes", "notes"],
]);

const isStorageResourceId = (id) => typeof id === "string" && STORAGE_RESOURCE_IDS.includes(id);

function databaseFileName(nodeEnv = process.env.NODE_ENV) {
  return nodeEnv === "development" ? "transcriptions-dev.db" : "transcriptions.db";
}

function safeModelDirs(modelDirUtils, homeCache) {
  try {
    const cacheRoot = modelDirUtils.getCacheRoot();
    return {
      cacheRoot,
      whisper: modelDirUtils.getModelsDirForService("whisper"),
      parakeet: modelDirUtils.getModelsDirForService("parakeet"),
      diarization: modelDirUtils.getModelsDirForService("diarization"),
      llm: path.join(cacheRoot, "models"),
    };
  } catch {
    return {
      cacheRoot: homeCache,
      whisper: path.join(homeCache, "whisper-models"),
      parakeet: path.join(homeCache, "parakeet-models"),
      diarization: path.join(homeCache, "diarization-models"),
      llm: path.join(homeCache, "models"),
    };
  }
}

/**
 * The resources on this computer: each has its parts (`{ key, path }`, measured
 * and summed) and how Open works (`open`: a folder, or a file shown in its
 * folder; `create` makes a missing folder first). Models follow relocated
 * cache folders through modelDirUtils; the search index and the embedding
 * model stay in the home cache, where their managers read them.
 */
function defaultStorageResources({
  userData,
  logsDir,
  audioDir,
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
  modelDirUtils = require("./modelDirUtils"),
  exists = fs.existsSync,
}) {
  const homeCache = path.join(homeDir, ".cache", "openwhispr");
  const models = safeModelDirs(modelDirUtils, homeCache);
  const dbPath = path.join(userData, databaseFileName(env.NODE_ENV));
  const envFile = path.join(userData, ".env");
  const resources = [
    {
      id: "recordings",
      parts: [{ key: "audio", path: audioDir || path.join(userData, "audio") }],
      open: { action: "open", create: true },
    },
    {
      id: "logs",
      parts: [{ key: "logs", path: logsDir || path.join(userData, "logs") }],
      open: { action: "open", create: true },
    },
    {
      id: "database",
      parts: [
        { key: "db", path: dbPath },
        { key: "wal", path: `${dbPath}-wal` },
        { key: "shm", path: `${dbPath}-shm` },
      ],
      open: { action: "show" },
    },
    {
      id: "settings",
      parts: [
        { key: "localStorage", path: path.join(userData, "Local Storage") },
        { key: "env", path: envFile },
      ],
      open: { action: "show" },
    },
    {
      id: "secrets",
      parts: [{ key: "secureKeys", path: path.join(userData, "secure-keys") }],
      open: { action: "open" },
    },
    {
      id: "models",
      parts: [
        { key: "whisper", path: models.whisper },
        { key: "parakeet", path: models.parakeet },
        { key: "diarization", path: models.diarization },
        { key: "llm", path: models.llm },
        { key: "embedding", path: path.join(homeCache, "embedding-models") },
      ],
      open: { action: "open", path: models.cacheRoot, create: true },
    },
    {
      id: "searchIndex",
      parts: [
        {
          key: "qdrant",
          path: path.join(
            homeCache,
            env.NODE_ENV === "development" ? "qdrant-data-dev" : "qdrant-data"
          ),
        },
      ],
      open: { action: "open" },
    },
    {
      id: "appCache",
      parts: APP_CACHE_DIRS.map((name) => ({ key: name, path: path.join(userData, name) })),
      open: { action: "show" },
    },
    {
      id: "cliBridge",
      parts: [{ key: "bridge", path: path.join(homeDir, ".openwhispr", "cli-bridge.json") }],
      open: { action: "show" },
    },
  ];
  // This fork's selfhost.js keeps releases and a build worktree here (Windows).
  // Listed when present, never measured: the worktree holds node_modules.
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    const selfhostDir = path.join(localAppData, "OpenWhispr-selfhost");
    if (exists(selfhostDir)) {
      resources.push({
        id: "selfhost",
        parts: [{ key: "selfhost", path: selfhostDir }],
        open: { action: "open" },
        measure: false,
      });
    }
  }
  return resources;
}

/** Runs at most `max` of the given tasks at once. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

/**
 * A file's size, or a folder's total. Symbolic links and junctions count as
 * nothing and are never followed; unreadable entries are skipped.
 */
async function measurePath(target, { limit, fsImpl = fs }) {
  let stats;
  try {
    stats = await limit(() => fsImpl.promises.lstat(target));
  } catch {
    return { exists: false, bytes: 0, files: 0 };
  }
  if (stats.isSymbolicLink()) return { exists: true, bytes: 0, files: 0 };
  if (stats.isFile()) return { exists: true, bytes: stats.size, files: 1 };
  if (!stats.isDirectory()) return { exists: true, bytes: 0, files: 0 };

  let bytes = 0;
  let files = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await limit(() => fsImpl.promises.readdir(dir, { withFileTypes: true }));
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        // A junction reads as a symbolic link here too: never followed.
        if (entry.isSymbolicLink()) return;
        const full = path.join(dir, entry.name);
        let entryStats;
        try {
          entryStats = await limit(() => fsImpl.promises.lstat(full));
        } catch {
          return;
        }
        if (entryStats.isSymbolicLink()) return;
        if (entryStats.isDirectory()) {
          await walk(full);
        } else if (entryStats.isFile()) {
          bytes += entryStats.size;
          files++;
        }
      })
    );
  };
  await walk(target);
  return { exists: true, bytes, files };
}

/**
 * How many dictations, step records, reviews, test cases, dictionary words,
 * glossary rules and notes the History database holds (rows not deleted), in
 * one query over the tables that exist. Null when the database is closed.
 */
function countHistoryRecords(db) {
  if (!db) return null;
  try {
    const names = HISTORY_COUNT_TABLES.map(([, table]) => table);
    const present = new Map(
      db
        .prepare(
          `SELECT m.name AS name,
             EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'deleted_at') AS live
           FROM sqlite_master m
           WHERE m.type = 'table' AND m.name IN (${names.map(() => "?").join(", ")})`
        )
        .all(...names)
        .map((row) => [row.name, row.live === 1])
    );
    const columns = HISTORY_COUNT_TABLES.filter(([, table]) => present.has(table)).map(
      ([key, table]) =>
        `(SELECT COUNT(*) FROM "${table}"${present.get(table) ? " WHERE deleted_at IS NULL" : ""}) AS "${key}"`
    );
    const row = columns.length > 0 ? db.prepare(`SELECT ${columns.join(", ")}`).get() : {};
    return Object.fromEntries(
      HISTORY_COUNT_TABLES.map(([key]) => [key, typeof row[key] === "number" ? row[key] : 0])
    );
  } catch (error) {
    debugLogger.warn("Couldn't count history records", { error: error.message }, "storage");
    return null;
  }
}

/**
 * The user's pace, for recording size estimates: dictations a day over the
 * last 30 days of history (or since the first one in that window) times their
 * average recorded length. Null without a database or without any history.
 */
function readRecordingPace(db, { now = Date.now(), windowDays = PACE_WINDOW_DAYS } = {}) {
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS dictations,
           MIN(created_at) AS earliest,
           AVG(CASE WHEN audio_duration_ms > 0 THEN audio_duration_ms END) AS averageMs
         FROM transcriptions
         WHERE deleted_at IS NULL AND created_at >= datetime(?, 'unixepoch', ?)`
      )
      .get(Math.floor(now / 1000), `-${windowDays} days`);
    if (!row || !(row.dictations > 0)) return null;
    // SQLite's CURRENT_TIMESTAMP is UTC without a zone; a synced row may carry ISO.
    const earliestText = String(row.earliest);
    const earliest = Date.parse(
      earliestText.includes("T") ? earliestText : `${earliestText.replace(" ", "T")}Z`
    );
    const spanDays = Number.isFinite(earliest)
      ? Math.min(windowDays, Math.max(1, (now - earliest) / DAY_MS))
      : windowDays;
    const perDay = row.dictations / spanDays;
    const averageSeconds = row.averageMs > 0 ? row.averageMs / 1000 : null;
    return {
      windowDays,
      spanDays: Math.round(spanDays * 10) / 10,
      dictations: row.dictations,
      perDay: Math.round(perDay * 10) / 10,
      averageSeconds: averageSeconds === null ? null : Math.round(averageSeconds * 10) / 10,
      minutesPerDay:
        averageSeconds === null ? null : Math.round(((perDay * averageSeconds) / 60) * 10) / 10,
    };
  } catch (error) {
    debugLogger.warn("Couldn't read the recording pace", { error: error.message }, "storage");
    return null;
  }
}

/**
 * @param {object} deps
 * @param {() => Array} deps.resolveResources  defaultStorageResources(...) in the app
 * @param {() => object|null} [deps.getDatabase]  the open better-sqlite3 handle
 * @param {(folder: string) => Promise<string>} [deps.openPath]  shell.openPath
 * @param {(file: string) => void} [deps.showItemInFolder]  shell.showItemInFolder
 * @param {() => {deleted:number, failed:number}} [deps.clearRecordings]
 * @param {() => {deleted:number, failed:string[]}} [deps.clearLogs]  debugLogger.clearLogs
 * @param {() => object} [deps.getSession]  session.defaultSession
 */
function createStorageInventory({
  resolveResources,
  getDatabase = () => null,
  openPath = async () => "",
  showItemInFolder = () => {},
  clearRecordings = () => ({ deleted: 0, failed: 0 }),
  clearLogs = () => ({ deleted: 0, failed: [] }),
  getSession = () => null,
  homeDir = os.homedir(),
  platform = process.platform,
  mask = (target) => maskUserProfile(target, homeDir, platform),
  fsImpl = fs,
  now = () => Date.now(),
  ttlMs = INVENTORY_CACHE_MS,
  concurrency = MEASURE_CONCURRENCY,
}) {
  let cache = null;
  let inFlight = null;
  let generation = 0;

  const findResource = (id) =>
    isStorageResourceId(id) ? (resolveResources().find((item) => item.id === id) ?? null) : null;

  const exists = (target) => {
    try {
      return fsImpl.existsSync(target);
    } catch {
      return false;
    }
  };

  async function measureAll() {
    const limit = createLimiter(concurrency);
    const resources = resolveResources();
    const items = await Promise.all(
      resources.map(async (resource) => {
        const primary = resource.open?.path ?? resource.parts[0].path;
        const base = {
          id: resource.id,
          path: mask(primary),
          paths: resource.parts.map((part) => mask(part.path)),
          target: resource.open?.action === "show" ? "file" : "folder",
          clearable: CLEARABLE_RESOURCE_IDS.includes(resource.id),
        };
        if (resource.measure === false) {
          return { ...base, exists: exists(primary), bytes: null, files: null, parts: [] };
        }
        const parts = await Promise.all(
          resource.parts.map(async (part) => ({
            key: part.key,
            ...(await measurePath(part.path, { limit, fsImpl })),
          }))
        );
        return {
          ...base,
          exists: parts.some((part) => part.exists),
          bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
          files: parts.reduce((sum, part) => sum + part.files, 0),
          parts: parts.map(({ key, bytes, exists: partExists }) => ({
            key,
            bytes,
            exists: partExists,
          })),
        };
      })
    );
    const db = getDatabase();
    return {
      measuredAt: new Date(now()).toISOString(),
      totalBytes: items.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
      items,
      database: { counts: countHistoryRecords(db) },
      recordingPace: readRecordingPace(db, { now: now() }),
    };
  }

  const invalidate = () => {
    generation++;
    cache = null;
  };

  return {
    async inventory({ refresh = false } = {}) {
      if (!refresh && cache && now() - cache.at < ttlMs) return { ...cache.result, cached: true };
      if (!inFlight || inFlight.generation !== generation) {
        const started = { generation, at: now() };
        const promise = measureAll().then((result) => {
          if (started.generation === generation) cache = { at: started.at, result };
          return result;
        });
        inFlight = { generation, promise };
        promise.then(
          () => {
            if (inFlight?.promise === promise) inFlight = null;
          },
          () => {
            if (inFlight?.promise === promise) inFlight = null;
          }
        );
      }
      return { ...(await inFlight.promise), cached: false };
    },

    invalidate,

    // Opens a resource's folder, or shows its file in its folder.
    async open(id) {
      const resource = findResource(id);
      if (!resource) return { success: false, error: "unknown" };
      try {
        if (resource.open.action === "show") {
          const target = [resource.open.path, ...resource.parts.map((part) => part.path)]
            .filter(Boolean)
            .find(exists);
          if (!target) return { success: false, error: "missing" };
          showItemInFolder(target);
          return { success: true };
        }
        const folder = resource.open.path ?? resource.parts[0].path;
        if (resource.open.create) await fsImpl.promises.mkdir(folder, { recursive: true });
        else if (!exists(folder)) return { success: false, error: "missing" };
        const error = await openPath(folder);
        return error ? { success: false, error } : { success: true };
      } catch (error) {
        return { success: false, error: error?.message };
      }
    },

    // Recordings (the fixed Clear all), logs (Clear logs) and the app cache
    // (Chromium's HTTP and code caches: never its storage) only.
    async clear(id) {
      if (!CLEARABLE_RESOURCE_IDS.includes(id)) return { success: false, error: "not-clearable" };
      invalidate();
      try {
        if (id === "recordings") {
          const { deleted, failed } = await clearRecordings();
          return { success: failed === 0, deleted, failed };
        }
        if (id === "logs") {
          const result = await clearLogs();
          const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
          return { success: failed === 0, deleted: result?.deleted ?? 0, failed };
        }
        const appSession = getSession();
        if (!appSession) return { success: false, error: "unavailable" };
        await appSession.clearCache();
        await appSession.clearCodeCaches({});
        debugLogger.info("App cache cleared", {}, "storage");
        return { success: true };
      } catch (error) {
        debugLogger.warn("Storage clear failed", { id, error: error?.message }, "storage");
        return { success: false, error: error?.message };
      }
    },
  };
}

function registerStorageInventoryIpc({ ipcMain, ...deps }) {
  const inventory = createStorageInventory(deps);
  ipcMain.handle("storage-inventory", (_event, options) =>
    inventory.inventory({ refresh: options?.refresh === true })
  );
  ipcMain.handle("storage-open", (_event, id) => inventory.open(id));
  ipcMain.handle("storage-clear", (_event, id) => inventory.clear(id));
  return inventory;
}

module.exports = {
  STORAGE_RESOURCE_IDS,
  CLEARABLE_RESOURCE_IDS,
  APP_CACHE_DIRS,
  INVENTORY_CACHE_MS,
  HISTORY_COUNT_TABLES,
  isStorageResourceId,
  databaseFileName,
  defaultStorageResources,
  createLimiter,
  measurePath,
  countHistoryRecords,
  readRecordingPace,
  createStorageInventory,
  registerStorageInventoryIpc,
};
