import type {
  ProcessGroup,
  ProcessHistoryPoint,
  ProcessInventoryHistory,
  ProcessInventoryProcess,
} from "../../types/electron";

// Settings › Data › Processes & resources, the pure part: the table's groups
// and sort, each row's series from the 24-hour history (sparklines, the
// handle trend) and the stacked chart's model. React-free.

export const PROCESS_GROUPS: readonly ProcessGroup[] = ["app", "windows", "services", "helpers"];

/** Each group's colour: the memory bar, the chart and the row's dot. */
export const GROUP_STYLES: Record<ProcessGroup, { bg: string; text: string }> = {
  app: { bg: "bg-primary", text: "text-primary" },
  windows: { bg: "bg-cyan-500", text: "text-cyan-500" },
  services: { bg: "bg-emerald-500", text: "text-emerald-500" },
  helpers: { bg: "bg-amber-500", text: "text-amber-500" },
};

export type ProcessSortKey = "ws" | "priv" | "cpu" | "gpu";
export interface ProcessSort {
  key: ProcessSortKey;
  descending: boolean;
}

export function sortValue(row: ProcessInventoryProcess, key: ProcessSortKey): number | null {
  switch (key) {
    case "ws":
      return row.ws;
    case "priv":
      return row.priv;
    case "cpu":
      return row.cpuPct;
    case "gpu":
      return row.gpuDedicated;
  }
}

/** The groups in order, each with its rows sorted (unavailable values last); empty groups left out. */
export function groupProcesses(
  rows: readonly ProcessInventoryProcess[],
  sort: ProcessSort
): Array<{ group: ProcessGroup; rows: ProcessInventoryProcess[] }> {
  const direction = sort.descending ? -1 : 1;
  const compare = (a: ProcessInventoryProcess, b: ProcessInventoryProcess) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1;
    } else if (x !== y) {
      return (x - y) * direction;
    }
    return a.role.localeCompare(b.role) || a.pid - b.pid;
  };
  return PROCESS_GROUPS.map((group) => ({
    group,
    rows: rows
      .filter((row) => (PROCESS_GROUPS.includes(row.group) ? row.group : "helpers") === group)
      .sort(compare),
  })).filter((entry) => entry.rows.length > 0);
}

/** In RAM by group (the memory tile's bar); a group with no reading is left out. */
export function memoryByGroup(
  rows: readonly ProcessInventoryProcess[]
): Array<{ group: ProcessGroup; bytes: number; share: number }> {
  const sums = PROCESS_GROUPS.map((group) => ({
    group,
    bytes: rows
      .filter((row) => row.group === group && row.ws !== null)
      .reduce((sum, row) => sum + (row.ws as number), 0),
  }));
  const total = sums.reduce((sum, entry) => sum + entry.bytes, 0);
  return sums
    .filter((entry) => entry.bytes > 0)
    .map((entry) => ({ ...entry, share: total > 0 ? (entry.bytes / total) * 100 : 0 }));
}

type PointField = "ws" | "cpuPct" | "gpuDedicated" | "handles";

/** A process instance's history points (the same pid and start time), oldest first. */
export function instancePoints(
  history: ProcessInventoryHistory | null,
  key: string
): ProcessHistoryPoint[] {
  return history?.instances.find((instance) => instance.key === key)?.points ?? [];
}

/** A sparkline's values: the instance's history, then the live value when it's newer. */
export function sparkValues(
  history: ProcessInventoryHistory | null,
  key: string,
  field: PointField,
  live: { at: number; value: number | null } | null = null
): Array<number | null> {
  const points = instancePoints(history, key);
  const values = points.map((point) => point[field]);
  const lastAt = points.at(-1)?.at ?? -Infinity;
  if (live && live.at > lastAt) values.push(live.value);
  return values;
}

/** How the instance's handle count moved over its history, or null with under two readings. */
export function handleTrend(
  history: ProcessInventoryHistory | null,
  key: string
): { from: number; to: number; spanMs: number } | null {
  const points = instancePoints(history, key).filter((point) => point.handles !== null);
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  return { from: first.handles as number, to: last.handles as number, spanMs: last.at - first.at };
}

// --- The 24-hour chart --------------------------------------------------------

export type HistoryMetric = "memory" | "graphics" | "cpu";

const METRIC_FIELD: Record<HistoryMetric, PointField> = {
  memory: "ws",
  graphics: "gpuDedicated",
  cpu: "cpuPct",
};

// Points further apart than this are drawn as a gap. History keeps one every
// 5 minutes; graphics memory is read every 30 minutes without the page open.
const GAP_MS: Record<HistoryMetric, number> = {
  memory: 12 * 60 * 1000,
  cpu: 12 * 60 * 1000,
  graphics: 40 * 60 * 1000,
};

export interface HistoryChartSample {
  at: number;
  values: Record<ProcessGroup, number>;
  total: number;
}

export interface HistoryGroupStats {
  now: number | null;
  max: number | null;
  average: number | null;
}

export interface HistoryChartModel {
  start: number;
  end: number;
  samples: HistoryChartSample[];
  /** Runs of consecutive samples (indexes into `samples`); a gap starts a new run. */
  segments: number[][];
  max: number;
  maxAt: number | null;
  recordings: number[];
  stats: Record<ProcessGroup | "total", HistoryGroupStats>;
}

const emptyValues = (): Record<ProcessGroup, number> => ({
  app: 0,
  windows: 0,
  services: 0,
  helpers: 0,
});

function statsOf(values: number[]): HistoryGroupStats {
  if (!values.length) return { now: null, max: null, average: null };
  return {
    now: values[values.length - 1],
    max: Math.max(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

/**
 * The chart's model for one metric: per sample, each group's sum over the
 * instances that had a reading; a sample nobody had a reading at is left
 * out, and samples further apart than the metric's gap break the line.
 */
export function buildHistoryChart(
  history: ProcessInventoryHistory | null,
  metric: HistoryMetric,
  now: number
): HistoryChartModel {
  const span = history?.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const start = now - span;
  const field = METRIC_FIELD[metric];
  const byAt = new Map<number, { values: Record<ProcessGroup, number>; seen: boolean }>();
  for (const at of history?.samples ?? []) {
    if (at >= start && at <= now) byAt.set(at, { values: emptyValues(), seen: false });
  }
  for (const instance of history?.instances ?? []) {
    const group = PROCESS_GROUPS.includes(instance.group) ? instance.group : "helpers";
    for (const point of instance.points) {
      const value = point[field];
      const slot = byAt.get(point.at);
      if (!slot || value === null || value === undefined || !Number.isFinite(value)) continue;
      slot.values[group] += value;
      slot.seen = true;
    }
  }
  const samples: HistoryChartSample[] = [...byAt.entries()]
    .filter(([, slot]) => slot.seen)
    .sort(([a], [b]) => a - b)
    .map(([at, slot]) => ({
      at,
      values: slot.values,
      total: PROCESS_GROUPS.reduce((sum, group) => sum + slot.values[group], 0),
    }));

  const segments: number[][] = [];
  samples.forEach((sample, index) => {
    const previous = samples[index - 1];
    if (!previous || sample.at - previous.at > GAP_MS[metric]) segments.push([index]);
    else segments[segments.length - 1].push(index);
  });

  let max = 0;
  let maxAt: number | null = null;
  for (const sample of samples) {
    if (sample.total > max || maxAt === null) {
      max = sample.total;
      maxAt = sample.at;
    }
  }

  const stats = {
    total: statsOf(samples.map((sample) => sample.total)),
  } as Record<ProcessGroup | "total", HistoryGroupStats>;
  for (const group of PROCESS_GROUPS) {
    stats[group] = statsOf(samples.map((sample) => sample.values[group]));
  }

  return {
    start,
    end: now,
    samples,
    segments,
    max,
    maxAt,
    recordings: (history?.recordings ?? [])
      .map((recording) => recording.at)
      .filter((at) => at >= start && at <= now),
    stats,
  };
}
