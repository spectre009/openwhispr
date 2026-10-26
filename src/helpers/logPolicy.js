// Rules for the debug log (debugLogger.js) and its settings on Storage › Logs:
// levels and their migration, retention, file names and reading back recent
// problems. Pure (no Electron), so tests and the IPC share them.

const DAY_MS = 24 * 60 * 60 * 1000;

const LOG_LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

// What Storage › Logs offers: Off, Problems only (warn and above), Everything (debug).
const LOG_SETTING_LEVELS = Object.freeze(["off", "warn", "debug"]);
const RETENTION_DAY_OPTIONS = Object.freeze([7, 14, 30, 90]);

const LOG_LIMITS = Object.freeze({
  maxDirBytes: 100 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  // One entry, and what may wait in the stream's buffer before entries are dropped.
  maxEventBytes: 16 * 1024,
  maxQueuedBytes: 1024 * 1024,
  // Files that may hold dictated text: deleted after 3 days whatever the
  // retention, and a new one begins once the current one is a day old.
  textMaxAgeMs: 3 * DAY_MS,
  textRotateMs: DAY_MS,
  maintenanceIntervalMs: 6 * 60 * 60 * 1000,
});

const LOG_FILE_PATTERN = /^debug-.*\.log$/;
const TEXT_LOG_PATTERN = /-text\.log$/;
// Written once the logs that predate the text boundary were handled (see debugLogger).
const TEXT_POLICY_MARKER = ".text-policy-1";

/** A level by name, `off` included; null for anything else. */
function normalizeLevel(value) {
  if (value === undefined || value === null || value === "") return null;
  const lower = String(value).trim().toLowerCase();
  if (lower === "off") return "off";
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, lower) ? lower : null;
}

/**
 * The saved setting (OPENWHISPR_LOG_LEVEL in .env) as one of the three choices,
 * read without rewriting the file: debug and trace are Everything; unset, info,
 * error, fatal and anything unknown are Problems only.
 */
function settingLevelFrom(raw) {
  const level = normalizeLevel(raw);
  if (level === "off") return "off";
  if (level === "debug" || level === "trace") return "debug";
  return "warn";
}

/** Kept 30 days at Everything, 7 otherwise, until the user picks. */
function defaultRetentionDays(settingLevel) {
  return settingLevel === "debug" ? 30 : 7;
}

function retentionDaysFrom(raw, settingLevel) {
  const days = Number.parseInt(String(raw ?? ""), 10);
  return RETENTION_DAY_OPTIONS.includes(days) ? days : defaultRetentionDays(settingLevel);
}

function includeTextFrom(raw) {
  return (
    String(raw ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

/**
 * The level in force: a --log-level flag, then an OPENWHISPR_LOG_LEVEL the
 * process inherited from its parent's environment, then the setting.
 * `overriddenBy` names the override whenever one is in force.
 */
function resolveEffectiveLevel({ flag, env, setting }) {
  const fromFlag = normalizeLevel(flag);
  if (fromFlag) return { level: fromFlag, overriddenBy: "flag" };
  const fromEnv = normalizeLevel(env);
  if (fromEnv) return { level: fromEnv, overriddenBy: "env" };
  return { level: settingLevelFrom(setting), overriddenBy: null };
}

/** The --log-level flag's value, or null. */
function readArgLogLevel(argv = process.argv || []) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--log-level" && argv[i + 1]) return argv[i + 1];
    if (typeof arg === "string" && arg.startsWith("--log-level=")) return arg.split("=", 2)[1];
  }
  return null;
}

const SETTING_KEYS = new Set(["level", "retentionDays", "includeText"]);

/**
 * `set-log-settings` input: any of { level, retentionDays, includeText }, each
 * one of the offered values. Throws on anything else, without echoing it.
 */
function validateLogSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Log settings must be an object");
  }
  const keys = Object.keys(input);
  if (keys.length === 0) throw new TypeError("No log setting to change");
  const unknown = keys.filter((key) => !SETTING_KEYS.has(key));
  if (unknown.length) throw new TypeError(`Unknown log setting: ${unknown.join(", ")}`);
  const result = {};
  if ("level" in input) {
    if (!LOG_SETTING_LEVELS.includes(input.level)) throw new TypeError("Invalid log level");
    result.level = input.level;
  }
  if ("retentionDays" in input) {
    if (!RETENTION_DAY_OPTIONS.includes(input.retentionDays)) {
      throw new TypeError("Invalid log retention");
    }
    result.retentionDays = input.retentionDays;
  }
  if ("includeText" in input) {
    if (typeof input.includeText !== "boolean") throw new TypeError("Invalid include-text value");
    result.includeText = input.includeText;
  }
  return result;
}

const isLogFileName = (name) => LOG_FILE_PATTERN.test(name);
const isTextLogName = (name) => TEXT_LOG_PATTERN.test(name);

/** debug-<ISO with : and . as ->[-n][-text].log */
function logFileName(date, { text = false, n = 0 } = {}) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `debug-${stamp}${n ? `-${n}` : ""}${text ? "-text" : ""}.log`;
}

/** When a log file was started, from its name; null when the name doesn't say. */
function logFileStartedAt(name) {
  const match = /^debug-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (!match) return null;
  const [, day, hours, minutes, seconds, millis] = match;
  const ms = Date.parse(`${day}T${hours}:${minutes}:${seconds}.${millis}Z`);
  return Number.isNaN(ms) ? null : ms;
}

// "[2026-10-25T15:02:11.123Z] [WARN][scope][source] message {" — an entry's first line.
const ENTRY_LINE =
  /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\] \[(WARN|ERROR|FATAL)\]((?:\[[^\]\s]*\])*) ?(.*)$/;
const PROBLEM_MESSAGE_MAX = 200;

function problemMessage(rest) {
  let message = rest.replace(/^(?:ERROR|FATAL): /, "");
  // The entry's JSON details start on this line and continue below it.
  message = message.replace(/\s*[{[]\s*$/, "").trim();
  return Array.from(message).slice(0, PROBLEM_MESSAGE_MAX).join("");
}

/**
 * Warnings, errors and fatal entries in log text, oldest first: time, level,
 * area (the entry's scope, else its source) and the first line of the message,
 * at most 200 characters. Details on the following lines are never read.
 */
function parseProblemLines(text) {
  const problems = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = ENTRY_LINE.exec(line);
    if (!match) continue;
    const [, time, level, tags, rest] = match;
    const area = /\[([^\]\s]+)\]/.exec(tags)?.[1] ?? null;
    problems.push({ time, level: level.toLowerCase(), area, message: problemMessage(rest) });
  }
  return problems;
}

module.exports = {
  DAY_MS,
  LOG_LEVELS,
  LOG_SETTING_LEVELS,
  RETENTION_DAY_OPTIONS,
  LOG_LIMITS,
  LOG_FILE_PATTERN,
  TEXT_POLICY_MARKER,
  normalizeLevel,
  settingLevelFrom,
  defaultRetentionDays,
  retentionDaysFrom,
  includeTextFrom,
  resolveEffectiveLevel,
  readArgLogLevel,
  validateLogSettings,
  isLogFileName,
  isTextLogName,
  logFileName,
  logFileStartedAt,
  parseProblemLines,
};
