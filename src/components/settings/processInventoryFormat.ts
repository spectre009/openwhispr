import type {
  ProcessGroup,
  ProcessInventoryReport,
  ProcessInventoryReportRow,
} from "../../types/electron";

// Copy diagnostics' Processes section (logSettingsFormat.ts's diagnosticsText):
// the process inventory's allowlisted report (roles, PIDs and numbers; main's
// processInventory.js builds it) as a plain-text table. English whatever the
// UI language, with UTC times, like the rest of Copy diagnostics. React-free.

const MB = 1024 * 1024;
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
  for (const row of sortedRows(report.processes)) {
    lines.push(tableLine(COLUMNS.map((column) => column.value(row))));
  }
  return lines;
}
