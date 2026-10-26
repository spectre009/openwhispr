import { setLogTextEnabled } from "./logText.js";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

// Main's level in force. "off" stops main's files; warnings and errors still go
// to main, which shows them on its console where that's on.
const normalizeLevel = (value?: string | null): LogLevel | null => {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "off") return "warn";
  return lower in LOG_LEVELS ? (lower as LogLevel) : null;
};

const defaultLevel: LogLevel = "info";

let cachedLevel: LogLevel | null = null;
let levelPromise: Promise<LogLevel> | null = null;
let subscribed = false;

// Every window takes a changed setting at once (Storage › Logs broadcasts it).
const applyState = (state?: { level?: string | null; includeText?: boolean } | null) => {
  const level = normalizeLevel(state?.level);
  if (level) cachedLevel = level;
  setLogTextEnabled(state?.includeText === true);
};

const subscribe = () => {
  if (subscribed || typeof window === "undefined") return;
  const onChanged = window.electronAPI?.onLogSettingsChanged;
  if (typeof onChanged !== "function") return;
  subscribed = true;
  try {
    onChanged((state) => {
      levelPromise = null;
      applyState(state);
    });
  } catch {
    subscribed = false;
  }
};

const resolveLogLevel = async (): Promise<LogLevel> => {
  if (cachedLevel) {
    return cachedLevel;
  }
  if (!levelPromise) {
    levelPromise = (async () => {
      subscribe();
      if (typeof window !== "undefined" && window.electronAPI?.getLogState) {
        try {
          const state = await window.electronAPI.getLogState();
          applyState(state);
          if (cachedLevel) return cachedLevel;
        } catch {
          // Fall back to the level alone
        }
      }
      if (typeof window !== "undefined" && window.electronAPI?.getLogLevel) {
        try {
          const level = normalizeLevel(await window.electronAPI.getLogLevel());
          if (level) {
            cachedLevel = level;
            return level;
          }
        } catch {
          // Fall back to default level
        }
      }
      cachedLevel = defaultLevel;
      return cachedLevel;
    })();
  }
  return levelPromise;
};

const shouldLog = (level: LogLevel, current: LogLevel) => {
  return LOG_LEVELS[level] >= LOG_LEVELS[current];
};

const logToConsole = (level: LogLevel, message: string, meta?: any, scope?: string) => {
  const levelTag = `[${level.toUpperCase()}]`;
  const scopeTag = scope ? `[${scope}]` : "";
  const consoleFn =
    level === "error" || level === "fatal"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  if (meta !== undefined) {
    consoleFn(`${levelTag}${scopeTag} ${message}`, meta);
  } else {
    consoleFn(`${levelTag}${scopeTag} ${message}`);
  }
};

const log = async (level: LogLevel, message: string, meta?: any, scope?: string) => {
  const currentLevel = await resolveLogLevel();
  if (!shouldLog(level, currentLevel)) return;

  if (typeof window !== "undefined" && window.electronAPI?.log) {
    try {
      await window.electronAPI.log({
        level,
        message: String(message),
        meta,
        scope,
        source: "renderer",
      });
      return;
    } catch {
      // Fall back to console
    }
  }

  logToConsole(level, String(message), meta, scope);
};

const logger = {
  trace: (message: string, meta?: any, scope?: string) => log("trace", message, meta, scope),
  debug: (message: string, meta?: any, scope?: string) => log("debug", message, meta, scope),
  info: (message: string, meta?: any, scope?: string) => log("info", message, meta, scope),
  warn: (message: string, meta?: any, scope?: string) => log("warn", message, meta, scope),
  error: (message: string, meta?: any, scope?: string) => log("error", message, meta, scope),
  fatal: (message: string, meta?: any, scope?: string) => log("fatal", message, meta, scope),
  logReasoning: (stage: string, details?: any) => log("debug", stage, details, "reasoning"),
  refreshLogLevel: () => {
    cachedLevel = null;
    levelPromise = null;
  },
};

export default logger;
