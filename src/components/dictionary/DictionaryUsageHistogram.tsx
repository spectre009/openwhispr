import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { normalizeDbDate } from "../../utils/dateFormatting";
import type { DictionaryUsageWeek } from "../../types/electron";
import { APPEARANCE_KIND_BG, APPEARANCE_KIND_TEXT } from "./dictionaryLabels";
import { formatWeekRange, weekParts, weekRange, type UsageWeekRange } from "./usageWeeks";

// A word's 13 weeks (the word panel's usage card): one stacked bar a week,
// green for speech got it, amber for fixed after speech, red for changed after
// speech. Each bar is a button named with its numbers; hovering or focusing it
// shows the week's range and counts, and clicking it lists that week's
// dictations under "Where it appeared" (again to clear). The range shown and
// the filter applied are the week's own `[start, end)` bounds from main.

export default function DictionaryUsageHistogram({
  weeks,
  selected,
  onSelect,
}: {
  weeks: DictionaryUsageWeek[];
  /** The week whose dictations are listed, by its start. */
  selected: string | null;
  onSelect: (range: UsageWeekRange | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const [active, setActive] = useState<number | null>(null);
  const parts = weeks.map(weekParts);
  const max = Math.max(1, ...parts.map((part) => part.used + part.chg));
  const totals = parts.reduce(
    (sum, part) => ({
      used: sum.used + part.used,
      ok: sum.ok + part.ok,
      fix: sum.fix + part.fix,
      chg: sum.chg + part.chg,
    }),
    { used: 0, ok: 0, fix: 0, chg: 0 }
  );
  const month = (iso: string) =>
    normalizeDbDate(iso).toLocaleDateString(i18n.language, { month: "short" });
  const shown = active !== null ? weeks[active] : null;
  const shownParts = active !== null ? parts[active] : null;
  // The tooltip leans inward at the edges so it stays inside the card.
  const edge =
    active === null
      ? "middle"
      : active < 3
        ? "start"
        : active > weeks.length - 4
          ? "end"
          : "middle";

  return (
    <div>
      <div
        role="group"
        aria-label={t("dictionary.detail.usage.chartLabel", totals)}
        className="relative mt-1"
        data-dictionary-usage-chart
      >
        {shown && shownParts && (
          <div
            aria-hidden="true"
            data-usage-tooltip
            className={cn(
              "pointer-events-none absolute top-full z-10 mt-2 w-52 rounded-lg border border-border bg-popover px-2.5 py-2 text-[11.5px] text-popover-foreground shadow-lg",
              edge === "start" && "start-0",
              edge === "end" && "end-0",
              edge === "middle" && "-translate-x-1/2 rtl:translate-x-1/2"
            )}
            style={
              edge === "middle" && active !== null
                ? { insetInlineStart: `${((active + 0.5) / weeks.length) * 100}%` }
                : undefined
            }
          >
            <p className="font-semibold text-foreground">
              {t("dictionary.detail.usage.weekOf", {
                range: formatWeekRange(weekRange(weeks, active as number), i18n.language),
              })}
            </p>
            {(
              [
                ["used", t("dictionary.kinds.used"), shownParts.used, "text-foreground/85"],
                ["ok", t("dictionary.kinds.ok"), shownParts.ok, APPEARANCE_KIND_TEXT.ok],
                ["fix", t("dictionary.kinds.fix"), shownParts.fix, APPEARANCE_KIND_TEXT.fix],
                ["chg", t("dictionary.kinds.chg"), shownParts.chg, APPEARANCE_KIND_TEXT.chg],
              ] as const
            ).map(([key, label, value, color]) => (
              <p key={key} className="mt-0.5 flex justify-between gap-3">
                <span className={color}>{label}</span>
                <span className="font-semibold tabular-nums">{value}</span>
              </p>
            ))}
            {shownParts.used + shownParts.chg > 0 && (
              <p className="mt-1 text-[10.5px] text-muted-foreground">
                {t(
                  selected === shown.start
                    ? "dictionary.detail.usage.clickToClear"
                    : "dictionary.detail.usage.clickToList"
                )}
              </p>
            )}
          </div>
        )}
        <div className="flex h-14 items-end gap-[3px]">
          {weeks.map((week, index) => {
            const part = parts[index];
            const range = weekRange(weeks, index);
            const label = t("dictionary.detail.usage.weekLabel", {
              range: formatWeekRange(range, i18n.language),
              used: part.used,
              ok: part.ok,
              fix: part.fix,
              chg: part.chg,
            });
            const isSelected = selected === week.start;
            const height = (n: number) => `${(n / max) * 100}%`;
            return (
              <button
                key={week.start}
                type="button"
                aria-label={label}
                aria-pressed={isSelected}
                data-usage-week={index}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive((current) => (current === index ? null : current))}
                onFocus={() => setActive(index)}
                onBlur={() => setActive((current) => (current === index ? null : current))}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && active === index) {
                    event.stopPropagation();
                    setActive(null);
                  }
                }}
                onClick={() => onSelect(isSelected ? null : range)}
                className={cn(
                  "flex h-full flex-1 flex-col-reverse items-stretch gap-px rounded-sm px-px transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  isSelected ? "bg-primary/12" : "hover:bg-muted/60 dark:hover:bg-white/5"
                )}
              >
                {part.ok > 0 && (
                  <span
                    className={cn("block rounded-[2px]", APPEARANCE_KIND_BG.ok)}
                    style={{ height: height(part.ok) }}
                  />
                )}
                {part.fix > 0 && (
                  <span
                    className={cn("block rounded-[2px]", APPEARANCE_KIND_BG.fix)}
                    style={{ height: height(part.fix) }}
                  />
                )}
                {part.chg > 0 && (
                  <span
                    className={cn("block rounded-[2px]", APPEARANCE_KIND_BG.chg)}
                    style={{ height: height(part.chg) }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-muted-foreground" aria-hidden>
        <span>{weeks.length > 0 ? month(weeks[0].start) : ""}</span>
        <span>{weeks.length > 6 ? month(weeks[Math.floor(weeks.length / 2)].start) : ""}</span>
        <span>{weeks.length > 0 ? month(weeks[weeks.length - 1].start) : ""}</span>
      </div>
      <div
        className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-muted-foreground"
        aria-hidden
      >
        {(["ok", "fix", "chg"] as const).map((kind) => (
          <span key={kind} className="flex items-center gap-1">
            <span className={cn("inline-block h-2 w-2 rounded-sm", APPEARANCE_KIND_BG[kind])} />
            {t(`dictionary.kinds.${kind}`)}
          </span>
        ))}
      </div>
    </div>
  );
}
