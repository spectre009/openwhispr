import type {
  ProcessGroup,
  ProcessInventoryPart,
  ProcessInventoryProcess,
  ProcessInventoryReport,
  ProcessInventoryReportRow,
} from "../../types/electron";

// Copy diagnostics' Processes section (logSettingsFormat.ts's diagnosticsText):
// the process inventory's allowlisted report (roles, PIDs and numbers; main's
// processInventory.js builds it) as a plain-text table. English whatever the
// UI language, with UTC times, like the rest of Copy diagnostics. Below it, the
// same numbers in the UI language for Settings › Data › Processes & resources.
// React-free.

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const GROUP_ORDER: readonly ProcessGroup[] = ["app", "windows", "services", "helpers"];

const HELPER_TEXT: Record<ProcessInventoryReport["helper"], string> = {
  ok: "ok",
  missing: "missing (no helper programs, handles, GDI/USER objects or graphics memory)",
  failed: "failed (no helper programs, handles, GDI/USER objects or graphics memory)",
  unsupported: "Windows only (no helper programs, handles, GDI/USER objects or graphics memory)",
};

const SOURCE_TEXT: Record<ProcessInventoryReport["source"], string> = {
  once: "the 5-minute run",
  stream: "the live view",
  electron: "Electron's numbers only",
};

/** "160.4 MB"; "1.12 GB" from 1 GB; "n/a" when unavailable (never 0). */
export function bytesText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "n/a";
  return bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${(bytes / MB).toFixed(1)} MB`;
}

/** "% of one core": "0.4%", "35%". */
export function percentText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

/** "45 s", "23 min", "3.4 h". */
export function durationText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "n/a";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

const countText = (value: number | null | undefined) =>
  value === null || value === undefined ? "n/a" : String(value);

function agoText(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)} s ago` : `${durationText(seconds)} ago`;
}

const COLUMNS: ReadonlyArray<{
  title: string;
  width: number;
  left?: boolean;
  value: (row: ProcessInventoryReportRow) => string;
}> = [
  { title: "Role", width: 18, left: true, value: (row) => row.role },
  { title: "PID", width: 7, value: (row) => countText(row.pid) },
  { title: "In RAM", width: 10, value: (row) => bytesText(row.ws) },
  { title: "Committed", width: 10, value: (row) => bytesText(row.priv) },
  { title: "CPU now", width: 8, value: (row) => percentText(row.cpuPct) },
  { title: "CPU avg", width: 8, value: (row) => percentText(row.cpuAvg) },
  { title: "CPU time", width: 9, value: (row) => durationText(row.cpuSec) },
  { title: "Graphics", width: 9, value: (row) => bytesText(row.gpuDedicated) },
  { title: "Handles", width: 8, value: (row) => countText(row.handles) },
  { title: "GDI", width: 6, value: (row) => countText(row.gdi) },
  { title: "USER", width: 6, value: (row) => countText(row.user) },
  { title: "Threads", width: 8, value: (row) => countText(row.threads) },
  { title: "Running", width: 8, value: (row) => durationText(row.uptimeSec) },
];

function tableLine(cells: string[]): string {
  return cells
    .map((cell, index) => {
      const column = COLUMNS[index];
      return column.left ? cell.padEnd(column.width) : cell.padStart(column.width);
    })
    .join(" ")
    .trimEnd();
}

/** A row, then the processes it includes (the program and its console host), indented. */
function rowLines(row: ProcessInventoryReportRow): string[] {
  const lines = [tableLine(COLUMNS.map((column) => column.value(row)))];
  for (const part of row.includes ?? []) {
    const cells = COLUMNS.map((column) => column.value(part));
    cells[0] = `  ${cells[0]}`;
    lines.push(tableLine(cells));
  }
  return lines;
}

function sortedRows(rows: readonly ProcessInventoryReportRow[]): ProcessInventoryReportRow[] {
  return [...rows].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || (b.ws ?? -1) - (a.ws ?? -1)
  );
}

/**
 * The Processes section's lines: when it was sampled, the sums, the graphics
 * card's process count, then one row per process. `null`: not sampled yet.
 */
export function processesText(report: ProcessInventoryReport | null): string[] {
  if (!report) return ["Processes: not sampled yet (the first sample runs a minute after start)"];
  const totals = report.totals;
  const cpu =
    totals.cpuPct === null
      ? "CPU n/a (needs two samples)"
      : `CPU ${percentText(totals.cpuPct)} of one core${
          report.cpuIntervalSec ? ` over the last ${durationText(report.cpuIntervalSec)}` : ""
        }`;
  const lines = [
    `Processes: ${totals.processes}, sampled ${new Date(report.at).toISOString()} (${agoText(report.ageSec)}, ${SOURCE_TEXT[report.source] ?? report.source})`,
    `Sum of all processes: ${bytesText(totals.ws)} in RAM, ${bytesText(totals.priv)} committed, ${cpu}, graphics memory ${bytesText(totals.gpuDedicated)}`,
  ];
  if (report.gpuAt !== null && report.gpuAt !== report.at) {
    const gpuAge = report.ageSec + Math.max(0, (report.at - report.gpuAt) / 1000);
    lines.push(
      `Graphics memory read: ${new Date(report.gpuAt).toISOString()} (${agoText(gpuAge)})`
    );
  }
  if (report.gpuProcesses !== null) {
    lines.push(`Processes on this PC holding graphics memory: ${report.gpuProcesses}`);
  }
  if (report.helper !== "ok") {
    const reason = report.helperError ? ` [${report.helperError}]` : "";
    lines.push(`Windows numbers: ${HELPER_TEXT[report.helper] ?? report.helper}${reason}`);
  }
  lines.push(tableLine(COLUMNS.map((column) => column.title)));
  for (const row of sortedRows(report.processes)) lines.push(...rowLines(row));
  return lines;
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const whole = (value: unknown): number | null =>
  Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;

function reportFieldsOf(
  item: ProcessInventoryProcess | ProcessInventoryPart,
  group: ProcessGroup,
  at: number
): ProcessInventoryReportRow {
  const cpuSec = finite(item.cpuSec);
  return {
    role: item.role,
    group,
    pid: whole(item.pid),
    ws: finite(item.ws),
    priv: finite(item.priv),
    peak: finite(item.peak),
    cpuPct: finite(item.cpuPct),
    cpuAvg: finite(item.cpuAvg),
    cpuSec: cpuSec === null ? null : Math.round(cpuSec * 10) / 10,
    gpuDedicated: finite(item.gpuDedicated),
    gpuShared: finite(item.gpuShared),
    gpuUse: finite(item.gpuUse),
    handles: whole(item.handles),
    threads: whole(item.threads),
    gdi: whole(item.gdi),
    user: whole(item.user),
    uptimeSec:
      finite(item.createdAt) && (item.createdAt as number) > 0
        ? Math.max(0, Math.round((at - (item.createdAt as number)) / 1000))
        : null,
  };
}

/**
 * A page row as the report's allowlisted row (roles, PIDs and numbers only,
 * as main's buildReport makes it, with a folded row's parts), for the row's Copy.
 */
export function reportRowOf(row: ProcessInventoryProcess, at: number): ProcessInventoryReportRow {
  const item = reportFieldsOf(row, row.group, at);
  if (row.includes?.length) {
    item.includes = row.includes.map((part) => reportFieldsOf(part, row.group, at));
  }
  return item;
}

/** One process as Copy diagnostics' table: the column titles, then its row (and its parts). English. */
export function processRowText(row: ProcessInventoryReportRow): string {
  return [tableLine(COLUMNS.map((column) => column.title)), ...rowLines(row)].join("\n");
}

// --- The page's numbers, in the UI language --------------------------------

function unitText(value: number, unit: string, digits: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "short",
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${unit}`;
  }
}

/** "512 kB", "5.2 MB", "151 MB", "1.12 GB" in the UI language (1024-based, as Windows counts). */
export function formatProcessBytes(bytes: number, locale?: string): string {
  const value = Math.max(0, bytes);
  if (value >= GB) return unitText(value / GB, "gigabyte", 2, locale);
  if (value >= MB) {
    const mb = value / MB;
    return unitText(mb, "megabyte", mb < 10 ? 1 : 0, locale);
  }
  return unitText(value / KB, "kilobyte", 0, locale);
}

/** % of one core in the UI language: "0.4%", "35%". */
export function formatProcessPercent(value: number, locale?: string): string {
  const digits = Math.abs(value) < 10 ? 1 : 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: digits,
    }).format(value / 100);
  } catch {
    return `${value.toFixed(digits)}%`;
  }
}

/** "45 sec", "23 min", "3.4 hr", "2.5 days" in the UI language. */
export function formatProcessDuration(seconds: number, locale?: string): string {
  const value = Math.max(0, seconds);
  if (value < 90) return unitText(Math.round(value), "second", 0, locale);
  if (value < 90 * 60) return unitText(Math.round(value / 60), "minute", 0, locale);
  if (value < 48 * 3600) return unitText(value / 3600, "hour", 1, locale);
  return unitText(value / 86400, "day", 1, locale);
}

/** A time in the UI language: the clock alone today, with the date on another day. */
export function formatProcessTime(at: number, locale?: string, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  try {
    return date.toLocaleString(
      locale,
      sameDay
        ? { hour: "numeric", minute: "2-digit" }
        : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    );
  } catch {
    return date.toISOString();
  }
}
