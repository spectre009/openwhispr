import type {
  RecordingPace,
  RecordingQuality,
  StorageInventoryItem,
  StorageInventoryResult,
  StorageResourceId,
} from "../../types/electron";
import { RECORDING_KB_PER_MINUTE, estimateRecordingBytes } from "../../utils/recordingQuality.js";

// Formatting for Settings › Storage (StoragePage.tsx and its sections) and the
// Privacy & Data summaries. React-free.

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A retention period's name: "6 months" and "1 year" for 180 and 365 days, else days. */
export function retentionPeriodLabel(days: number, t: Translate): string {
  if (days === 365) return t("settingsPage.storage.retentionPeriods.oneYear");
  if (days === 180) return t("settingsPage.storage.retentionPeriods.sixMonths");
  return t("settingsPage.privacy.retentionDays", { count: days });
}

export const RECORDING_QUALITY_CHOICES: readonly RecordingQuality[] = [
  "smaller",
  "balanced",
  "original",
];

export const kbPerMinute = (quality: RecordingQuality): number => RECORDING_KB_PER_MINUTE[quality];

/** Bytes `days` of recordings take at the user's pace, or null without a pace. */
export function recordingEstimateBytes(
  quality: RecordingQuality,
  pace: RecordingPace | null,
  days: number
): number | null {
  if (!pace?.minutesPerDay || !(days > 0)) return null;
  return estimateRecordingBytes({ minutesPerDay: pace.minutesPerDay, days, quality });
}

/** "14 min" in the UI language. */
export function formatMinutes(minutes: number, locale?: string): string {
  const value = minutes >= 10 ? Math.round(minutes) : Math.round(minutes * 10) / 10;
  try {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "minute",
      unitDisplay: "short",
    }).format(value);
  } catch {
    return `${value} min`;
  }
}

export function formatCount(count: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale).format(count);
  } catch {
    return String(count);
  }
}

/** The size bar's segments in order; settings, keys and the CLI bridge share "other". */
export const STORAGE_BAR_SEGMENTS: ReadonlyArray<{
  key: "recordings" | "models" | "searchIndex" | "appCache" | "logs" | "database" | "other";
  ids: readonly StorageResourceId[];
  className: string;
}> = [
  { key: "recordings", ids: ["recordings"], className: "bg-primary" },
  { key: "models", ids: ["models"], className: "bg-teal-500" },
  { key: "searchIndex", ids: ["searchIndex"], className: "bg-violet-500" },
  { key: "appCache", ids: ["appCache"], className: "bg-slate-400" },
  { key: "logs", ids: ["logs"], className: "bg-amber-500" },
  { key: "database", ids: ["database"], className: "bg-emerald-500" },
  { key: "other", ids: ["settings", "secrets", "cliBridge"], className: "bg-zinc-500" },
];

export interface StorageBarSegment {
  key: (typeof STORAGE_BAR_SEGMENTS)[number]["key"];
  className: string;
  bytes: number;
  /** Percent of the measured total. */
  share: number;
}

/** Each segment's bytes and share of the measured total (unmeasured items count as 0). */
export function storageBarSegments(result: StorageInventoryResult | null): StorageBarSegment[] {
  if (!result) return [];
  const bytesOf = (ids: readonly StorageResourceId[]) =>
    result.items
      .filter((item) => ids.includes(item.id))
      .reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  const segments = STORAGE_BAR_SEGMENTS.map(({ key, ids, className }) => ({
    key,
    className,
    bytes: bytesOf(ids),
  }));
  const total = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  return segments.map((segment) => ({
    ...segment,
    share: total > 0 ? (segment.bytes / total) * 100 : 0,
  }));
}

/** Everything else, in this order (selfhost only when main lists it). */
export const EVERYTHING_ELSE_IDS: readonly StorageResourceId[] = [
  "settings",
  "secrets",
  "models",
  "searchIndex",
  "appCache",
  "cliBridge",
  "selfhost",
];

/** The item's path as shown: the first path, then the other parts' names. */
export function itemPathText(item: StorageInventoryItem | null): string {
  if (!item?.path) return "";
  const others = item.paths
    .filter((value): value is string => typeof value === "string" && value !== item.path)
    .map((value) => value.split(/[\\/]/).pop() ?? value);
  return others.length > 0 ? [item.path, ...others].join(" · ") : item.path;
}
