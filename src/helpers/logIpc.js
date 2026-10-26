// IPC for the log (Settings › Storage › Logs, and System's Diagnostics row).
// The renderer names settings, never paths: main owns the logs folder, reads
// recent problems itself and answers with the folder's user profile masked.
const fs = require("fs");
const os = require("os");
const path = require("path");
const policy = require("./logPolicy");
const { maskUserProfile } = require("./buildInfo");

// The OS, for Copy diagnostics (Electron's getSystemVersion, else Node's release).
function systemInfo() {
  let version = null;
  try {
    version =
      typeof process.getSystemVersion === "function" ? process.getSystemVersion() : os.release();
  } catch {
    version = null;
  }
  return { platform: process.platform, version: version || null, arch: process.arch };
}

const RECENT_PROBLEMS_MAX = 50;
// Recent problems read the newest files from their end, within these budgets.
const RECENT_READ_LIMITS = Object.freeze({
  perFileBytes: 256 * 1024,
  totalBytes: 1024 * 1024,
  maxFiles: 8,
});

async function readTail(filePath, size, maxBytes) {
  const start = Math.max(0, size - maxBytes);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    // Started mid-entry: skip to the next whole line.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * The last warnings, errors and fatal entries (newest first) from the newest
 * log files: time, level, area and the first line of the message.
 */
async function readRecentProblems(
  logsDir,
  { max = RECENT_PROBLEMS_MAX, limits = RECENT_READ_LIMITS } = {}
) {
  let names;
  try {
    names = (await fs.promises.readdir(logsDir)).filter((name) => policy.isLogFileName(name));
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    try {
      const stats = await fs.promises.stat(path.join(logsDir, name));
      if (stats.isFile()) files.push({ name, size: stats.size, mtimeMs: stats.mtimeMs });
    } catch {
      // gone meanwhile
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const problems = [];
  let budget = limits.totalBytes;
  for (const file of files.slice(0, limits.maxFiles)) {
    if (budget <= 0 || problems.length >= max) break;
    const take = Math.min(limits.perFileBytes, budget, file.size);
    budget -= take;
    try {
      problems.push(
        ...policy.parseProblemLines(await readTail(path.join(logsDir, file.name), file.size, take))
      );
    } catch {
      // unreadable: skip it
    }
  }
  return problems.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0)).slice(0, max);
}

/**
 * @param {object} deps
 * @param {object} deps.logger  debugLogger
 * @param {{ saveLogSettings: Function }} deps.environmentManager
 * @param {(channel: string, payload: unknown) => void} [deps.broadcast]  to every window
 * @param {(folder: string) => Promise<string>} [deps.openPath]  shell.openPath
 */
function createLogHandlers({
  logger,
  environmentManager,
  broadcast = () => {},
  openPath = async () => "",
  mask = (folder) => maskUserProfile(folder),
  readProblems = readRecentProblems,
  system = systemInfo,
}) {
  const logState = () => ({ level: logger.getLevel(), includeText: logger.includeText === true });
  const logInfo = () => {
    const info = logger.getLogInfo();
    return { ...info, logsDir: info.logsDir ? mask(info.logsDir) : null, system: system() };
  };

  return {
    logState,
    logInfo,

    // Validated before anything is written; then saved to .env, applied and
    // announced, so every window's logger takes the new level at once.
    async setLogSettings(input) {
      const changes = policy.validateLogSettings(input);
      await environmentManager.saveLogSettings(changes);
      logger.refreshLogLevel();
      broadcast("log-settings-changed", logState());
      return logInfo();
    },

    clearLogs: () => logger.clearLogs(),

    async recentProblems() {
      const logsDir = logger.getLogsDir();
      return logsDir ? readProblems(logsDir) : [];
    },

    async openLogsFolder() {
      const logsDir = logger.getLogsDir();
      if (!logsDir) return { success: false, error: "The logs folder isn't available yet" };
      try {
        await fs.promises.mkdir(logsDir, { recursive: true });
        const error = await openPath(logsDir);
        return error ? { success: false, error } : { success: true };
      } catch (error) {
        return { success: false, error: error?.message };
      }
    },
  };
}

function registerLogIpc({ ipcMain, ...deps }) {
  const handlers = createLogHandlers(deps);
  ipcMain.handle("get-log-level", () => handlers.logState().level);
  ipcMain.handle("get-log-state", () => handlers.logState());
  ipcMain.handle("log-info", () => handlers.logInfo());
  ipcMain.handle("set-log-settings", (_event, input) => handlers.setLogSettings(input));
  ipcMain.handle("clear-logs", () => handlers.clearLogs());
  ipcMain.handle("log-recent-problems", () => handlers.recentProblems());
  ipcMain.handle("open-logs-folder", () => handlers.openLogsFolder());
  return handlers;
}

module.exports = {
  RECENT_PROBLEMS_MAX,
  RECENT_READ_LIMITS,
  readRecentProblems,
  createLogHandlers,
  registerLogIpc,
};
