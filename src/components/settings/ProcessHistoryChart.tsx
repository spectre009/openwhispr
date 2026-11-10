import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import type { ProcessInventoryHistory } from "../../types/electron";
import {
  formatProcessBytes,
  formatProcessPercent,
  formatProcessTime,
} from "./processInventoryFormat";
import {
  GROUP_STYLES,
  PROCESS_GROUPS,
  buildHistoryChart,
  type HistoryChartModel,
  type HistoryMetric,
} from "./processesView";
import { P } from "./processesText";

const METRICS: readonly HistoryMetric[] = ["memory", "graphics", "cpu"];
const WIDTH = 1000;
const HEIGHT = 120;
// A lone sample (a gap on both sides) is drawn as a bar one history interval wide.
const LONE_SAMPLE_MS = 5 * 60 * 1000;

function Areas({ model }: { model: HistoryChartModel }) {
  const span = model.end - model.start || 1;
  const top = model.max > 0 ? model.max * 1.1 : 1;
  const x = (at: number) => ((at - model.start) / span) * WIDTH;
  const y = (value: number) => HEIGHT - (value / top) * HEIGHT;
  const shapes: ReactElement[] = [];
  model.segments.forEach((indexes, segmentIndex) => {
    const samples = indexes.map((index) => model.samples[index]);
    let base = samples.map(() => 0);
    for (const group of PROCESS_GROUPS) {
      const upper = samples.map((sample, i) => base[i] + sample.values[group]);
      const key = `${segmentIndex}-${group}`;
      const className = cn(GROUP_STYLES[group].text, "fill-current opacity-60");
      if (samples.length === 1) {
        const width = Math.max(2, (LONE_SAMPLE_MS / span) * WIDTH);
        shapes.push(
          <rect
            key={key}
            className={className}
            x={x(samples[0].at) - width / 2}
            y={y(upper[0])}
            width={width}
            height={Math.max(0, y(base[0]) - y(upper[0]))}
          />
        );
      } else {
        const forward = samples.map((sample, i) => `${x(sample.at)},${y(upper[i])}`);
        const back = samples.map((sample, i) => `${x(sample.at)},${y(base[i])}`).reverse();
        shapes.push(
          <polygon key={key} className={className} points={[...forward, ...back].join(" ")} />
        );
      }
      base = upper;
    }
  });
  return (
    <>
      <line
        x1={0}
        x2={WIDTH}
        y1={y(model.max)}
        y2={y(model.max)}
        className="stroke-border"
        strokeDasharray="4 4"
        vectorEffect="non-scaling-stroke"
      />
      {shapes}
      {model.recordings.map((at, index) => (
        <rect
          key={`recording-${index}`}
          data-process-history-recording=""
          className="fill-destructive"
          x={x(at) - 1.5}
          y={0}
          width={3}
          height={7}
        />
      ))}
    </>
  );
}

/**
 * The last 24 hours, stacked by group: memory in RAM, graphics memory or CPU
 * (graphics only on Windows). Recordings are marked along the top; times
 * nothing was measured stay gaps. The numbers are also in a table for screen
 * readers.
 */
export function ProcessHistoryChart({
  history,
  locale,
  now,
  windowsNumbers = true,
}: {
  history: ProcessInventoryHistory | null;
  locale: string;
  now: number;
  windowsNumbers?: boolean;
}) {
  const { t } = useTranslation();
  const metrics = windowsNumbers ? METRICS : METRICS.filter((item) => item !== "graphics");
  const [chosen, setMetric] = useState<HistoryMetric>("memory");
  const metric = metrics.includes(chosen) ? chosen : "memory";
  const model = useMemo(() => buildHistoryChart(history, metric, now), [history, metric, now]);
  const format = (value: number | null) =>
    value === null
      ? "—"
      : metric === "cpu"
        ? formatProcessPercent(value, locale)
        : formatProcessBytes(value, locale);
  const metricLabel = t(`${P}.history.metrics.${metric}`);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
    formatProcessTime(model.start + (model.end - model.start) * fraction, locale, now)
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-tight text-foreground">
          {t(`${P}.history.title`)}
        </h3>
        <div
          role="group"
          aria-label={t(`${P}.history.show`)}
          className="inline-flex overflow-hidden rounded-md border border-border/70 dark:border-border-subtle"
        >
          {metrics.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={metric === item}
              data-process-history-metric={item}
              onClick={() => setMetric(item)}
              className={cn(
                "border-e border-border/70 px-2.5 py-1 text-[11px] last:border-e-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 dark:border-border-subtle",
                metric === item
                  ? "bg-muted text-foreground dark:bg-surface-raised"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(`${P}.history.metrics.${item}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border/70 bg-card/50 px-3 py-2.5 dark:border-border-subtle/70 dark:bg-surface-2/50">
        {model.samples.length === 0 ? (
          <p
            data-process-history="empty"
            className="py-6 text-center text-xs text-muted-foreground"
          >
            {t(`${P}.history.empty`)}
          </p>
        ) : (
          <figure data-process-history={metric} className="m-0">
            <div className="relative">
              <span
                aria-hidden="true"
                className="absolute start-0 top-0 text-[10px] tabular-nums text-muted-foreground"
              >
                {format(model.max)}
                {metric === "cpu" && ` ${t(`${P}.tiles.ofOneCore`)}`}
              </span>
              <svg
                aria-hidden="true"
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                preserveAspectRatio="none"
                className="block h-32 w-full rtl:-scale-x-100"
              >
                <Areas model={model} />
              </svg>
            </div>
            <div
              aria-hidden="true"
              className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground"
            >
              {ticks.map((tick, index) => (
                <span key={index}>{tick}</span>
              ))}
            </div>
            <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {PROCESS_GROUPS.filter((group) => (model.stats[group].max ?? 0) > 0).map((group) => (
                <span
                  key={group}
                  data-process-history-legend={group}
                  className="inline-flex items-center gap-1.5"
                >
                  <span
                    aria-hidden="true"
                    className={cn("inline-block h-2 w-2 rounded-sm", GROUP_STYLES[group].bg)}
                  />
                  {t(`${P}.groups.${group}`)}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="inline-block h-2 w-0.5 bg-destructive" />
                {t(`${P}.history.recordingCount`, { count: model.recordings.length })}
              </span>
              {model.maxAt !== null && (
                <span data-process-history-summary="" className="ms-auto">
                  {t(`${P}.history.summary`, {
                    max: format(model.max),
                    time: formatProcessTime(model.maxAt, locale, now),
                  })}
                </span>
              )}
            </figcaption>
            <table data-process-history-table="" className="sr-only">
              <caption>{t(`${P}.history.tableCaption`, { metric: metricLabel })}</caption>
              <thead>
                <tr>
                  <td />
                  <th scope="col">{t(`${P}.history.now`)}</th>
                  <th scope="col">{t(`${P}.history.highest`)}</th>
                  <th scope="col">{t(`${P}.history.average`)}</th>
                </tr>
              </thead>
              <tbody>
                {[...PROCESS_GROUPS, "total" as const].map((group) => (
                  <tr key={group} data-process-history-row={group}>
                    <th scope="row">
                      {group === "total" ? t(`${P}.history.total`) : t(`${P}.groups.${group}`)}
                    </th>
                    <td>{format(model.stats[group].now)}</td>
                    <td>{format(model.stats[group].max)}</td>
                    <td>{format(model.stats[group].average)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </figure>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        {t(windowsNumbers ? `${P}.history.note` : `${P}.history.noteBasic`)}
      </p>
    </div>
  );
}
