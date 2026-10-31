import { normalizeDbDate } from "../../utils/dateFormatting";
import type { DictionaryUsageWeek } from "../../types/electron";

// A word's weeks as the word panel says them (dictionary-word-usage): each
// week's numbers ("used", "speech got it", "fixed after speech", "changed
// after speech") and its `[start, end)` bounds from main, which the chart's
// tooltip shows and "Where it appeared" filters by.

export interface UsageWeekRange {
  start: string;
  end: string;
}

/** A week's numbers as the page says them. */
export function weekParts(week: DictionaryUsageWeek) {
  const ok = week.both ?? Math.max(0, week.written - week.missedRows);
  return {
    used: week.written,
    ok,
    fix: week.missedRows,
    chg: week.changed ?? Math.max(0, week.heard - ok),
  };
}

/** A week's bounds: its own end, else the next week's start, else a week on. */
export function weekRange(weeks: readonly DictionaryUsageWeek[], index: number): UsageWeekRange {
  const week = weeks[index];
  const end =
    week.end ??
    weeks[index + 1]?.start ??
    new Date(Date.parse(week.start) + 7 * 24 * 60 * 60 * 1000).toISOString();
  return { start: week.start, end };
}

/** "Aug 1 – Aug 7" (the last day the week includes), or one day. */
export function formatWeekRange(range: UsageWeekRange, locale: string): string {
  const format = (date: Date) =>
    date.toLocaleDateString(locale, { month: "short", day: "numeric" });
  const start = normalizeDbDate(range.start);
  const last = new Date(Math.max(start.getTime(), Date.parse(range.end) - 1));
  const a = format(start);
  const b = format(last);
  return a === b ? a : `${a} – ${b}`;
}
