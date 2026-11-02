import type {
  BuildInfoResult,
  GraphicsModeState,
  LogInfoResult,
  LogLevel,
  LogProblem,
  LogRetentionDays,
  LogSettingLevel,
} from "../../types/electron";
import { formatBytes } from "../../utils/formatBytes";
import { buildInfoText } from "./buildInfoFormat";

// Formatting for Storage › Logs and System › Diagnostics (LogsSection.tsx,
// DiagnosticsSection.tsx). React-free.

export const LOG_LEVEL_CHOICES: readonly LogSettingLevel[] = ["off", "warn", "debug"];
export const LOG_RETENTION_CHOICES: readonly LogRetentionDays[] = [7, 14, 30, 90];
/** Recent problems listed before "Show all". */
export const RECENT_PROBLEMS_FOLDED = 3;

const isChoice = (level: LogLevel): level is LogSettingLevel =>
  (LOG_LEVEL_CHOICES as readonly string[]).includes(level);

/** A level's name: one of the three choices, or the level an override asked for. */
export function logLevelLabel(
  level: LogLevel,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  return isChoice(level)
    ? t(`settingsPage.storage.logs.level.${level}`)
    : t("settingsPage.storage.logs.level.other", { level });
}

/** An override is in force and puts a level other than the setting's. */
export function overrideDiffers(
  info: Pick<LogInfoResult, "level" | "effectiveLevel" | "overriddenBy">
) {
  return info.overriddenBy !== null && info.effectiveLevel !== info.level;
}

function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Problems logged since local midnight. */
export function problemsToday(problems: readonly LogProblem[], now: number = Date.now()): number {
  const since = startOfLocalDay(now);
  return problems.filter((problem) => Date.parse(problem.time) >= since).length;
}

/** How many problems each area logged, most first (ties by name). */
export function problemCountsByArea(problems: readonly LogProblem[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const problem of problems) {
    const area = problem.area || "app";
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** "08:42" today, a short date and time before. */
export function formatProblemTime(iso: string, locale?: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const options: Intl.DateTimeFormatOptions =
    time >= startOfLocalDay(now)
      ? { timeStyle: "short" }
      : { dateStyle: "short", timeStyle: "short" };
  try {
    return new Date(time).toLocaleString(locale, options);
  } catch {
    return new Date(time).toLocaleString(undefined, options);
  }
}

const LEVEL_TEXT: Record<LogSettingLevel, string> = {
  off: "Off",
  warn: "Problems only (warnings and errors)",
  debug: "Everything (debug)",
};

const OVERRIDE_TEXT = {
  flag: "--log-level",
  env: "the OPENWHISPR_LOG_LEVEL environment variable",
} as const;

const OS_NAMES: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

/**
 * What System › Diagnostics says about the graphics mode: a warning for a
 * software fallback, a neutral note when a launch flag asked for software
 * drawing, nothing for hardware or while the mode is unknown.
 */
export function graphicsNotice(
  graphics: GraphicsModeState | null | undefined
): "fallback" | "requested" | null {
  if (graphics?.mode !== "software") return null;
  return graphics.reason === "requested" ? "requested" : "fallback";
}

/** Copy diagnostics' graphics lines (English). */
export function graphicsText(graphics: GraphicsModeState | null | undefined): string[] {
  if (!graphics || graphics.mode === "unknown") return ["Graphics: unknown"];
  let mode: string = graphics.mode;
  if (graphics.reason === "requested") {
    mode += graphics.requestedBy ? ` (requested by ${graphics.requestedBy})` : " (requested)";
  } else if (graphics.reason) {
    mode += ` (${graphics.reason})`;
  }
  const status = [
    graphics.gpuCompositing && `gpu_compositing ${graphics.gpuCompositing}`,
    graphics.rasterization && `rasterization ${graphics.rasterization}`,
  ].filter(Boolean);
  const lines = [`Graphics: ${[mode, ...status].join(", ")}`];
  if (graphics.glRenderer || graphics.displayType) {
    const renderer = graphics.glRenderer ?? "unknown";
    lines.push(
      `Graphics renderer: ${renderer}${graphics.displayType ? ` [${graphics.displayType}]` : ""}`
    );
  }
  return lines;
}

export interface DiagnosticsInput {
  build: BuildInfoResult | null;
  log: LogInfoResult;
  problems: readonly LogProblem[];
}

/**
 * Copy diagnostics: plain English lines for a bug report, whatever the UI
 * language. Settings, sizes, counts and the graphics mode only: no log lines,
 * keys or dictated text, and main has already masked the user profile in the
 * paths.
 */
export function diagnosticsText({ build, log, problems }: DiagnosticsInput): string {
  const lines = ["OpenWhispr diagnostics", ""];
  lines.push(build ? buildInfoText(build) : "Build: unknown");
  if (log.system) {
    const os = OS_NAMES[log.system.platform] ?? log.system.platform;
    lines.push(`OS: ${os} ${log.system.version ?? "unknown"} (${log.system.arch})`);
  }
  lines.push(...graphicsText(log.graphics));
  lines.push("");
  const setting = LEVEL_TEXT[log.level];
  if (log.overriddenBy) {
    const level = isChoice(log.effectiveLevel)
      ? LEVEL_TEXT[log.effectiveLevel]
      : log.effectiveLevel;
    lines.push(
      `Log level: ${level}, set by ${OVERRIDE_TEXT[log.overriddenBy]} (the setting is ${setting})`
    );
  } else {
    lines.push(`Log level: ${setting}`);
  }
  lines.push(
    `Keep logs for: ${log.retentionDays} days`,
    `Include dictated text: ${log.includeText ? "on" : "off"}`,
    `Logs folder: ${log.logsDir ?? "unknown"}`,
    `Log size: ${formatBytes(log.totalBytes)} in ${log.fileCount} ${log.fileCount === 1 ? "file" : "files"}`
  );
  const errors = problems.filter((problem) => problem.level !== "warn").length;
  const warnings = problems.length - errors;
  lines.push(`Recent problems: ${errors} errors, ${warnings} warnings`);
  for (const [area, count] of problemCountsByArea(problems)) lines.push(`  ${area}: ${count}`);
  return lines.join("\n");
}
