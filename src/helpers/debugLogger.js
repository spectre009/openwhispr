const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const policy = require("./logPolicy");
const { setLogTextEnabled } = require("../utils/logText.js");

const {
  DAY_MS,
  LOG_LEVELS,
  LOG_LIMITS,
  TEXT_POLICY_MARKER,
  normalizeLevel,
  isLogFileName,
  isTextLogName,
  logFileName,
  logFileStartedAt,
} = policy;

const hasConsoleLogOptIn = () => (process.argv || []).includes("--console-logs");

// Set by local fork builds (electron-builder.local-win.json + selfhost.js).
const readSelfBuiltCommit = () => {
  try {
    return require("../../package.json").selfBuiltCommit || null;
  } catch {
    return null;
  }
};

// A message's level; "off" is a setting, never a message's level.
const messageLevel = (level) => {
  const normalized = normalizeLevel(level);
  return normalized && normalized !== "off" ? normalized : "info";
};

// The error()/fatal() form most callers use: (message, details, scope).
const SCOPE_ARG = /^[a-z][\w.-]{0,40}$/i;
const isScopedCall = (args) =>
  args.length === 3 &&
  typeof args[0] === "string" &&
  (args[1] === undefined || (args[1] !== null && typeof args[1] === "object")) &&
  typeof args[2] === "string" &&
  SCOPE_ARG.test(args[2]);

/**
 * The app's log (Settings › Storage › Logs). The level comes from the setting
 * (OPENWHISPR_LOG_LEVEL in .env: off, warn or debug; see logPolicy's
 * migration) unless a --log-level flag or an OPENWHISPR_LOG_LEVEL inherited
 * from the parent process overrides it. Any level but off writes one file per
 * start, debug-<timestamp>.log in <userData>/logs (debug-<timestamp>-text.log
 * while "Include dictated text" is on), which continues in a new file past 20 MB
 * or, for a -text file, after a day.
 *
 * Kept bounded at start, at each new file, every 6 hours and right after the
 * retention shortens, logging off or not: -text files go after 3 days, others
 * after the retention (7/14/30/90 days), then the oldest until the folder fits
 * in 100 MB. The file being written is never deleted. An entry is capped at
 * 16 KB, and entries are dropped (and counted) while more than 1 MB waits to be
 * written; a write error turns file logging off for the session. Logging never
 * throws into its callers.
 */
class DebugLogger {
  constructor() {
    this.inheritedEnvLevel = null;
    this.settingLevel = "warn";
    this.logLevel = "warn";
    this.overriddenBy = null;
    this.retentionDays = 7;
    this.includeText = false;
    this.retention = {
      maxAgeMs: 7 * DAY_MS,
      maxDirBytes: LOG_LIMITS.maxDirBytes,
      maxFileBytes: LOG_LIMITS.maxFileBytes,
      textMaxAgeMs: LOG_LIMITS.textMaxAgeMs,
      textRotateMs: LOG_LIMITS.textRotateMs,
    };
    this.limits = {
      maxEventBytes: LOG_LIMITS.maxEventBytes,
      maxQueuedBytes: LOG_LIMITS.maxQueuedBytes,
    };
    this.logsDir = null;
    this.logFile = null;
    this.logStream = null;
    this.logBytes = 0;
    this.logOpenedAt = 0;
    this.logIsText = false;
    this.openedFiles = new Set();
    this.started = false;
    this.fileLoggingEnabled = false;
    // A write error stops file logging until the app restarts.
    this.fileLoggingFailed = false;
    this.dropped = 0;
    this.maintenanceTimer = null;
    this.clearing = false;
    // Counts for the next file's first line (the start's housekeeping).
    this.pendingHeader = {};
    this.consoleLoggingEnabled = this.resolveConsoleLogging();
    this.resolveSettings();

    // IMPORTANT: Do NOT open the log file here! app.getPath() is unsafe before
    // app.whenReady(); ensureFileLogging() (main, once ready) or the first write
    // after that starts it.
  }

  /**
   * Called by main.js before any .env file is loaded: an OPENWHISPR_LOG_LEVEL
   * the process inherited overrides the setting. It's taken out of
   * process.env, which then holds only the setting from .env (so saving .env
   * never turns the override into the setting).
   */
  captureInheritedEnv(env = process.env) {
    const raw = env.OPENWHISPR_LOG_LEVEL;
    delete env.OPENWHISPR_LOG_LEVEL;
    this.inheritedEnvLevel = normalizeLevel(raw);
    this.resolveSettings();
    return this.inheritedEnvLevel;
  }

  resolveSettings() {
    const env = process.env;
    this.settingLevel = policy.settingLevelFrom(env.OPENWHISPR_LOG_LEVEL);
    const effective = policy.resolveEffectiveLevel({
      flag: policy.readArgLogLevel(),
      env: this.inheritedEnvLevel,
      setting: this.settingLevel,
    });
    this.logLevel = effective.level;
    this.overriddenBy = effective.overriddenBy;
    this.retentionDays = policy.retentionDaysFrom(
      env.OPENWHISPR_LOG_RETENTION_DAYS,
      this.settingLevel
    );
    this.retention.maxAgeMs = this.retentionDays * DAY_MS;
    this.includeText = policy.includeTextFrom(env.OPENWHISPR_LOG_TEXT);
    setLogTextEnabled(this.includeText);
    // Off keeps warnings and errors on the console (where it's on), and files stop.
    this.fileLevelValue = this.logLevel === "off" ? null : LOG_LEVELS[this.logLevel];
    this.consoleLevelValue = this.logLevel === "off" ? LOG_LEVELS.warn : LOG_LEVELS[this.logLevel];
    this.levelValue = this.consoleLevelValue;
  }

  resolveConsoleLogging() {
    // Packaged Windows apps can inherit the launching shell's standard handles.
    return process.platform !== "win32" || !app?.isPackaged || hasConsoleLogOptIn();
  }

  wantsFile() {
    return this.fileLevelValue !== null && !this.fileLoggingFailed;
  }

  getLogsDir() {
    if (this.logsDir) return this.logsDir;
    if (!app?.isReady?.()) return null;
    try {
      return path.join(app.getPath("userData"), "logs");
    } catch {
      return null;
    }
  }

  /**
   * Once the app is ready: the start's housekeeping (older logs and retention,
   * whatever the level), the 6-hour timer, and the log file unless logging is
   * off. Safe to call again.
   */
  ensureFileLogging() {
    if (!this.started) {
      if (!app?.isReady?.()) return;
      const logsDir = this.getLogsDir();
      if (!logsDir) return;
      // The .env files have loaded by now (main.js): start from the saved settings.
      this.resolveSettings();
      this.started = true;
      this.logsDir = logsDir;
      if (fs.existsSync(logsDir)) {
        const textPolicyRemoved = this.applyTextPolicyOnce(logsDir);
        const removed = this.pruneLogs(logsDir).length;
        if (textPolicyRemoved !== null) this.pendingHeader.textPolicyRemoved = textPolicyRemoved;
        if (removed) this.pendingHeader.removedOldLogs = removed;
      }
      this.startMaintenance();
    }
    if (this.wantsFile() && !this.logStream) this.openSession();
  }

  /** Kept for callers and tests: starts file logging if the level wants it. */
  initializeFileLogging() {
    this.ensureFileLogging();
  }

  openSession() {
    const logsDir = this.logsDir;
    if (!logsDir || this.logStream || this.clearing) return;
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      // A fresh folder has nothing from before the text boundary.
      const textPolicyRemoved = this.applyTextPolicyOnce(logsDir);
      if (textPolicyRemoved) this.pendingHeader.textPolicyRemoved = textPolicyRemoved;
      this.openLogFile(logsDir);
      this.fileLoggingEnabled = true;
      const header = this.pendingHeader;
      this.pendingHeader = {};
      this.writeHeader(header);
    } catch (error) {
      this.disableFileLogging(error);
    }
  }

  // The file stops being written (logging turned off, or Clear logs). Resolves
  // once it's closed, so it can be deleted.
  closeSession() {
    const stream = this.logStream;
    this.logStream = null;
    this.logFile = null;
    this.logIsText = false;
    this.fileLoggingEnabled = false;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => {
      if (stream.closed || stream.destroyed) {
        resolve();
        return;
      }
      stream.once("close", resolve);
      stream.once("error", resolve);
      try {
        stream.end();
      } catch {
        resolve();
      }
    });
  }

  // `previous` is the file just left by a rotation: a new name never reuses it,
  // or any name this process opened, even within the same millisecond (its
  // stream may not have created it yet).
  openLogFile(logsDir, previous = null) {
    const now = new Date();
    const text = this.includeText;
    const taken = (candidate) =>
      candidate === previous || this.openedFiles.has(candidate) || fs.existsSync(candidate);
    let candidate = path.join(logsDir, logFileName(now, { text }));
    for (let n = 1; taken(candidate); n += 1) {
      candidate = path.join(logsDir, logFileName(now, { text, n }));
    }
    this.openedFiles.add(candidate);
    const stream = fs.createWriteStream(candidate, { flags: "a" });
    stream.on("error", (error) => this.disableFileLogging(error));
    stream.on("drain", () => this.flushDropped());
    this.logFile = candidate;
    this.logStream = stream;
    this.logBytes = 0;
    this.logOpenedAt = now.getTime();
    this.logIsText = text;
  }

  // Disk full, no permission, a folder that can't be made: file logging stops
  // for this session, said once on the console.
  disableFileLogging(error) {
    if (this.fileLoggingFailed) return;
    this.fileLoggingFailed = true;
    this.fileLoggingEnabled = false;
    const stream = this.logStream;
    this.logStream = null;
    this.logFile = null;
    try {
      stream?.destroy();
    } catch {
      // already gone
    }
    try {
      console.error("OpenWhispr stopped writing its log file for this session:", error?.message);
    } catch {
      // nowhere to say it
    }
  }

  /**
   * Logs from before the text boundary carry dictated text without a -text
   * name. The first start of this version deletes those older than 3 days and
   * names the rest -text, so the 3-day rule keeps applying to them; a marker
   * file records it. Returns how many it deleted, or null if it already ran.
   */
  applyTextPolicyOnce(logsDir, { now = Date.now() } = {}) {
    const marker = path.join(logsDir, TEXT_POLICY_MARKER);
    if (fs.existsSync(marker)) return null;
    let removed = 0;
    let names = [];
    try {
      names = fs.readdirSync(logsDir).filter((name) => isLogFileName(name) && !isTextLogName(name));
    } catch {
      names = [];
    }
    for (const name of names) {
      const filePath = path.join(logsDir, name);
      if (filePath === this.logFile) continue;
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;
        if (now - stats.mtimeMs > this.retention.textMaxAgeMs) {
          fs.unlinkSync(filePath);
          removed += 1;
          continue;
        }
        const renamed = path.join(logsDir, name.replace(/\.log$/, "-text.log"));
        if (!fs.existsSync(renamed)) fs.renameSync(filePath, renamed);
      } catch {
        // In use by another instance: the age rules still reach it later.
      }
    }
    try {
      fs.writeFileSync(
        marker,
        `Logs from before ${new Date(now).toISOString()} were treated as holding dictated text (${removed} deleted).\n`
      );
    } catch {
      // Tried again at the next start.
    }
    return removed;
  }

  /**
   * Deletes this logger's files (debug-*.log): -text ones older than 3 days
   * (from when they began), others older than the retention, then the oldest
   * until the rest fit in retention.maxDirBytes. Never the file being written.
   * Returns the names it deleted; a file it can't delete (another instance
   * holds it) is skipped.
   */
  pruneLogs(logsDir = this.logsDir, { now = Date.now() } = {}) {
    const removed = [];
    if (!logsDir) return removed;
    let entries;
    try {
      entries = fs
        .readdirSync(logsDir)
        .filter((name) => isLogFileName(name))
        .map((name) => {
          const filePath = path.join(logsDir, name);
          try {
            const stats = fs.statSync(filePath);
            return stats.isFile()
              ? { name, filePath, size: stats.size, mtimeMs: stats.mtimeMs }
              : null;
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && entry.filePath !== this.logFile);
    } catch {
      return removed;
    }

    const remove = (entry) => {
      try {
        fs.unlinkSync(entry.filePath);
        removed.push(entry.name);
        return true;
      } catch {
        return false;
      }
    };

    const expired = (entry) => {
      if (isTextLogName(entry.name)) {
        const began = Math.min(logFileStartedAt(entry.name) ?? entry.mtimeMs, entry.mtimeMs);
        return now - began > this.retention.textMaxAgeMs;
      }
      return now - entry.mtimeMs > this.retention.maxAgeMs;
    };

    const kept = [];
    for (const entry of entries) {
      if (expired(entry) && remove(entry)) continue;
      kept.push(entry);
    }

    let currentBytes = 0;
    if (this.logFile) {
      try {
        currentBytes = fs.statSync(this.logFile).size;
      } catch {
        currentBytes = this.logBytes;
      }
    }
    let total = currentBytes + kept.reduce((sum, entry) => sum + entry.size, 0);
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of kept) {
      if (total <= this.retention.maxDirBytes) break;
      if (remove(entry)) total -= entry.size;
    }
    return removed;
  }

  // The current file is full (retention.maxFileBytes), a -text file is a day
  // old, or "Include dictated text" changed: continue in a new file and apply
  // retention again, so a long-running app stays within its budget.
  rotateLogFile(reason = "size") {
    const previous = this.logFile;
    const stream = this.logStream;
    if (!previous || !stream) return;
    try {
      const logsDir = path.dirname(previous);
      this.logStream = null;
      this.logFile = null;
      stream.end();
      const removed = this.pruneLogs(logsDir);
      this.openLogFile(logsDir, previous);
      this.writeHeader({
        continues: path.basename(previous),
        reason,
        ...(removed.length ? { removedOldLogs: removed.length } : {}),
      });
    } catch (error) {
      this.disableFileLogging(error);
    }
  }

  startMaintenance() {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(
      () => this.runMaintenance(),
      LOG_LIMITS.maintenanceIntervalMs
    );
    this.maintenanceTimer.unref?.();
  }

  stopMaintenance() {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }

  // Every 6 hours: a day-old -text file continues in a new one (which prunes),
  // else retention runs on its own, logging off or not.
  runMaintenance({ now = Date.now() } = {}) {
    try {
      if (
        this.logStream &&
        this.logIsText &&
        now - this.logOpenedAt >= this.retention.textRotateMs
      ) {
        this.rotateLogFile("age");
        return;
      }
      if (this.logsDir && fs.existsSync(this.logsDir)) this.pruneLogs(this.logsDir, { now });
    } catch {
      // Tried again at the next tick.
    }
  }

  /**
   * Re-reads the settings (after .env loads or the user changes them) and
   * applies them: opens or closes the file for the new level, starts a new
   * file when "Include dictated text" changed, and prunes at once when the
   * retention got shorter.
   */
  refreshLogLevel() {
    const previous = {
      retentionDays: this.retentionDays,
      includeText: this.includeText,
    };
    this.resolveSettings();
    if (!this.started) return;
    if (!this.wantsFile()) {
      if (this.logStream) this.closeSession();
    } else if (!this.logStream) {
      this.openSession();
    } else if (previous.includeText !== this.includeText) {
      this.rotateLogFile("text");
      return;
    }
    if (this.retentionDays < previous.retentionDays && this.logsDir) {
      this.pruneLogs(this.logsDir);
    }
  }

  getLevel() {
    return this.logLevel;
  }

  /** What Storage › Logs shows (sizes read from the folder). */
  getLogInfo() {
    let totalBytes = 0;
    let fileCount = 0;
    const logsDir = this.getLogsDir();
    if (logsDir) {
      try {
        for (const name of fs.readdirSync(logsDir)) {
          if (!isLogFileName(name)) continue;
          try {
            const stats = fs.statSync(path.join(logsDir, name));
            if (!stats.isFile()) continue;
            totalBytes += stats.size;
            fileCount += 1;
          } catch {
            // gone meanwhile
          }
        }
      } catch {
        // no folder yet
      }
    }
    return {
      level: this.settingLevel,
      effectiveLevel: this.logLevel,
      overriddenBy: this.overriddenBy,
      retentionDays: this.retentionDays,
      includeText: this.includeText,
      totalBytes,
      fileCount,
      currentFile: this.logFile ? path.basename(this.logFile) : null,
      logsDir,
    };
  }

  /**
   * Clear logs: closes the current file, deletes every debug-*.log it can and
   * starts a new file if logging is on. Returns what it deleted and the names
   * it couldn't.
   */
  async clearLogs() {
    const logsDir = this.getLogsDir();
    // Nothing reopens the file until every log is gone.
    this.clearing = true;
    await this.closeSession();
    const failed = [];
    let deleted = 0;
    if (logsDir) {
      let names = [];
      try {
        names = fs.readdirSync(logsDir).filter((name) => isLogFileName(name));
      } catch {
        names = [];
      }
      for (const name of names) {
        try {
          fs.unlinkSync(path.join(logsDir, name));
          deleted += 1;
        } catch {
          failed.push(name);
        }
      }
    }
    this.clearing = false;
    if (this.started && this.wantsFile()) this.openSession();
    return { deleted, failed };
  }

  isDebugEnabled() {
    return this.levelValue <= LOG_LEVELS.debug;
  }

  shouldLog(level) {
    const value = LOG_LEVELS[messageLevel(level)];
    const toFile = this.fileLevelValue !== null && value >= this.fileLevelValue;
    return toFile || value >= this.consoleLevelValue;
  }

  serializeValue(value) {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(value.code ? { code: value.code } : {}),
        ...(value.stack ? { stack: value.stack } : {}),
        ...value,
      };
    }
    return value;
  }

  formatArgs(args) {
    return args
      .map((arg) => {
        if (arg !== null && typeof arg === "object") {
          try {
            return JSON.stringify(this.serializeValue(arg), null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(" ");
  }

  formatMeta(meta) {
    if (meta === undefined) return "";
    if (typeof meta === "string") return meta;
    try {
      return JSON.stringify(this.serializeValue(meta), null, 2);
    } catch {
      return String(meta);
    }
  }

  // An entry over the cap keeps its start and says how big it was.
  capEntry(line) {
    const max = this.limits.maxEventBytes;
    if (line.length * 3 <= max) return line;
    const bytes = Buffer.byteLength(line);
    if (bytes <= max) return line;
    const marker = ` … [entry cut at ${max} of ${bytes} bytes]\n`;
    const kept = Buffer.from(line)
      .subarray(0, Math.max(0, max - Buffer.byteLength(marker)))
      .toString("utf8")
      .replace(/\uFFFD$/, "");
    return kept + marker;
  }

  // Straight to the file, whatever the level (headers, the dropped count).
  writeLine(rawLine) {
    const stream = this.logStream;
    if (!stream) return;
    const line = this.capEntry(rawLine);
    const bytes = Buffer.byteLength(line);
    if (stream.writableLength + bytes > this.limits.maxQueuedBytes) {
      this.dropped += 1;
      return;
    }
    if (this.dropped) this.flushDropped();
    stream.write(line);
    this.logBytes += bytes;
    if (this.logBytes > this.retention.maxFileBytes) {
      this.rotateLogFile("size");
    } else if (this.logIsText && Date.now() - this.logOpenedAt >= this.retention.textRotateMs) {
      this.rotateLogFile("age");
    }
  }

  // Once the disk catches up, one line says how many entries were dropped.
  flushDropped() {
    const stream = this.logStream;
    if (!this.dropped || !stream) return;
    if (stream.writableLength >= this.limits.maxQueuedBytes) return;
    const count = this.dropped;
    this.dropped = 0;
    const line = `[${new Date().toISOString()}] [WARN][logger] Dropped ${count} log entries while the disk fell behind\n`;
    stream.write(line);
    this.logBytes += Buffer.byteLength(line);
  }

  writeHeader(extra = {}) {
    if (!this.logStream) return;
    let meta;
    try {
      meta = {
        appVersion: app.getVersion(),
        platform: process.platform,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        appPath: app.getAppPath(),
        userDataPath: app.getPath("userData"),
        resourcesPath: process.resourcesPath,
        environment: process.env.NODE_ENV,
        selfBuiltCommit: readSelfBuiltCommit(),
      };
    } catch {
      meta = { platform: process.platform };
    }
    meta.logging = {
      level: this.settingLevel,
      effectiveLevel: this.logLevel,
      overriddenBy: this.overriddenBy,
      retentionDays: this.retentionDays,
      includeText: this.includeText,
    };
    // One line, so the first line of a file says everything about it.
    let json;
    try {
      json = JSON.stringify({ ...meta, ...extra });
    } catch {
      json = "{}";
    }
    this.writeLine(`[${new Date().toISOString()}] [INFO] System Info ${json}\n`);
  }

  write(level, message, meta, scope, source) {
    try {
      const normalized = messageLevel(level);
      const value = LOG_LEVELS[normalized];
      const toConsole = this.consoleLoggingEnabled && value >= this.consoleLevelValue;
      const toFile = this.fileLevelValue !== null && value >= this.fileLevelValue;
      if (!toConsole && !toFile) return;

      if (toFile && !this.started) this.ensureFileLogging();

      const scopeTag = scope ? `[${scope}]` : "";
      const sourceTag = source ? `[${source}]` : "";
      const levelTag = `[${normalized.toUpperCase()}]`;

      if (toConsole) {
        const consoleFn =
          normalized === "error" || normalized === "fatal"
            ? console.error
            : normalized === "warn"
              ? console.warn
              : console.log;

        if (meta !== undefined) {
          // Pass the prefix as a %s arg, not as a format string. See CodeQL js/tainted-format-string.
          consoleFn("%s", `${levelTag}${scopeTag}${sourceTag} ${message}`, meta);
        } else {
          consoleFn(`${levelTag}${scopeTag}${sourceTag} ${message}`);
        }
      }

      if (toFile && this.logStream) {
        const baseLine = `[${new Date().toISOString()}] ${levelTag}${scopeTag}${sourceTag} ${message}`;
        const metaText = this.formatMeta(meta);
        this.writeLine(metaText ? `${baseLine} ${metaText}\n` : `${baseLine}\n`);
      }
    } catch {
      // Logging never breaks the caller.
    }
  }

  log(...args) {
    this.write("debug", this.formatArgs(args));
  }

  debug(message, meta, scope, source) {
    this.write("debug", message, meta, scope, source);
  }

  trace(message, meta, scope, source) {
    this.write("trace", message, meta, scope, source);
  }

  info(message, meta, scope, source) {
    this.write("info", message, meta, scope, source);
  }

  warn(message, meta, scope, source) {
    this.write("warn", message, meta, scope, source);
  }

  logReasoning(stage, details) {
    this.debug(stage, details, "reasoning");
  }

  error(...args) {
    if (isScopedCall(args)) {
      this.write("error", `ERROR: ${args[0]}`, args[1], args[2]);
      return;
    }
    this.write("error", `ERROR: ${this.formatArgs(args)}`);
  }

  fatal(...args) {
    if (isScopedCall(args)) {
      this.write("fatal", `FATAL: ${args[0]}`, args[1], args[2]);
      return;
    }
    this.write("fatal", `FATAL: ${this.formatArgs(args)}`);
  }

  logEntry(entry) {
    if (!entry || typeof entry !== "object") return;
    const normalized = messageLevel(entry.level);
    const message = entry.message ? String(entry.message) : "";
    const scope = entry.scope ? String(entry.scope) : undefined;
    const source = entry.source ? String(entry.source) : "renderer";
    this.write(normalized, message, entry.meta, scope, source);
  }

  logFFmpegDebug(context, ffmpegPath, additionalInfo = {}) {
    if (!this.isDebugEnabled()) return;

    const debugInfo = {
      context,
      ffmpegPath,
      exists: ffmpegPath ? fs.existsSync(ffmpegPath) : false,
      platform: process.platform,
      ...additionalInfo,
    };

    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      try {
        const stats = fs.statSync(ffmpegPath);
        debugInfo.fileInfo = {
          size: stats.size,
          isFile: stats.isFile(),
          // Skip X_OK check on Windows (not reliable)
          isExecutable: process.platform !== "win32" ? !!(stats.mode & fs.constants.X_OK) : false,
          executableCheckSkipped: process.platform === "win32",
          permissions: stats.mode.toString(8),
          modified: stats.mtime,
        };
      } catch (e) {
        debugInfo.statError = e.message;
      }
    }

    // Check parent directory permissions
    if (ffmpegPath) {
      const dir = path.dirname(ffmpegPath);
      try {
        fs.accessSync(dir, fs.constants.R_OK);
        debugInfo.dirReadable = true;
      } catch (e) {
        debugInfo.dirReadable = false;
        debugInfo.dirError = e.message;
      }
    }

    // Platform-specific path checks
    let possiblePaths = [];
    if (process.platform === "win32") {
      possiblePaths = [
        ffmpegPath,
        ffmpegPath?.replace(/app\.asar([/\\])/, "app.asar.unpacked$1"),
        path.join(
          process.resourcesPath || "",
          "app.asar.unpacked",
          "node_modules",
          "ffmpeg-static",
          "ffmpeg.exe"
        ),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
      ].filter(Boolean);
    } else {
      possiblePaths = [
        ffmpegPath,
        ffmpegPath?.replace("app.asar", "app.asar.unpacked"),
        path.join(
          process.resourcesPath || "",
          "app.asar.unpacked",
          "node_modules",
          "ffmpeg-static",
          "ffmpeg"
        ),
        "/usr/local/bin/ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/bin/ffmpeg",
      ].filter(Boolean);
    }

    debugInfo.pathChecks = possiblePaths.map((p) => ({
      path: p,
      exists: fs.existsSync(p),
      normalized: path.normalize(p),
    }));

    this.debug(`FFmpeg Debug - ${context}`, debugInfo, "ffmpeg");
  }

  logAudioData(context, audioBlob) {
    if (!this.isDebugEnabled()) return;

    const audioInfo = {
      context,
      type: audioBlob?.type || "unknown",
      size: audioBlob?.size || 0,
      constructor: audioBlob?.constructor?.name || "unknown",
    };

    if (audioBlob instanceof ArrayBuffer) {
      audioInfo.byteLength = audioBlob.byteLength;
      // Check first few bytes
      const view = new Uint8Array(audioBlob, 0, Math.min(16, audioBlob.byteLength));
      audioInfo.firstBytes = Array.from(view)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    } else if (audioBlob instanceof Uint8Array) {
      audioInfo.byteLength = audioBlob.byteLength;
      const view = audioBlob.slice(0, Math.min(16, audioBlob.byteLength));
      audioInfo.firstBytes = Array.from(view)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    }

    this.debug("Audio Data Debug", audioInfo, "audio");
  }

  logProcessStart(command, args, options = {}) {
    if (!this.isDebugEnabled()) return;

    this.debug(
      "Starting process",
      {
        command,
        args,
        cwd: options.cwd || process.cwd(),
        env: {
          FFMPEG_PATH: options.env?.FFMPEG_PATH,
          FFMPEG_EXECUTABLE: options.env?.FFMPEG_EXECUTABLE,
          FFMPEG_BINARY: options.env?.FFMPEG_BINARY,
          PATH_preview: options.env?.PATH?.substring(0, 200) + "...",
        },
      },
      "process"
    );
  }

  // Raw process output can echo what was dictated: only its kind and size.
  logProcessOutput(processName, type, data) {
    if (!this.isDebugEnabled()) return;

    const output = data == null ? "" : String(data).trim();
    if (output) {
      this.debug(`${processName} ${type}`, { chars: output.length }, "process");
    }
  }

  logWhisperPipeline(stage, details) {
    if (!this.isDebugEnabled()) return;
    this.debug(`Whisper Pipeline - ${stage}`, details, "whisper");
  }

  logSTTPipeline(stage, details) {
    if (!this.isDebugEnabled()) return;
    this.debug(`STT Pipeline - ${stage}`, details, "stt");
  }

  getLogPath() {
    return this.logFile;
  }

  isEnabled() {
    return this.isDebugEnabled();
  }

  close() {
    this.stopMaintenance();
    if (this.logStream) {
      this.log("📝 Debug logger closing");
      this.logStream.end();
      this.logStream = null;
    }
  }
}

// Singleton instance
const debugLogger = new DebugLogger();

module.exports = debugLogger;
