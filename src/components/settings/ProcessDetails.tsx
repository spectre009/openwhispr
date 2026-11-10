import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Check, ChevronRight, Copy } from "../icons";
import { cn } from "../lib/utils";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import type { ProcessInventoryProcess } from "../../types/electron";
import { useOpenSettingsLink } from "./settingsLink";
import { Dash, Term } from "./ProcessHint";
import {
  formatProcessBytes,
  formatProcessDuration,
  formatProcessPercent,
  formatProcessTime,
  processRowText,
  reportRowOf,
} from "./processInventoryFormat";
import { formatCount } from "./storageFormat";
import { GROUP_STYLES, handleTrend, sparkValues } from "./processesView";
import {
  P,
  aboutParams,
  missingReason,
  roleName,
  type ProcessField,
  type ProcessPageContext,
} from "./processesText";

/** Where the graphics process's link lands: System › Diagnostics' graphics row (Diagnostics when it isn't shown). */
export const GRAPHICS_DIAGNOSTICS_DESTINATION = "system#system.diagnostics.graphics";

const OBJECT_LIMIT = 10_000;

/** A small line chart of one series; a missing reading breaks the line. */
export function Sparkline({
  values,
  className,
}: {
  values: ReadonlyArray<number | null>;
  className?: string;
}) {
  const numbers = values.filter((value): value is number => value !== null);
  if (numbers.length < 2) return null;
  const width = 96;
  const height = 20;
  // From 0, so a few MB of wobble on a large process stays a wobble.
  const max = Math.max(...numbers);
  const min = Math.min(0, ...numbers);
  const range = max - min || 1;
  const x = (index: number) => (values.length > 1 ? (index / (values.length - 1)) * width : 0);
  const y = (value: number) => height - 1 - ((value - min) / range) * (height - 2);
  const runs: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) runs.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  });
  if (current.length) runs.push(current.join(" "));
  return (
    <svg
      aria-hidden="true"
      data-process-sparkline=""
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0 overflow-visible rtl:-scale-x-100", className)}
    >
      {runs.map((points, index) =>
        points.includes(" ") ? (
          <polyline
            key={index}
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinejoin="round"
          />
        ) : (
          <circle
            key={index}
            cx={points.split(",")[0]}
            cy={points.split(",")[1]}
            r={1.2}
            fill="currentColor"
          />
        )
      )}
    </svg>
  );
}

function Panel({
  title,
  id,
  spark,
  note,
  children,
}: {
  title: string;
  id: string;
  spark?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-process-panel={id}
      className="rounded-lg border border-border/60 bg-background/60 px-3 py-2.5 dark:border-border-subtle/60 dark:bg-surface-1/60"
    >
      <h4 className="mb-2 flex min-h-5 items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        <span className="ms-auto">{spark}</span>
      </h4>
      <dl className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1.5 text-xs">
        {children}
      </dl>
      {note}
    </section>
  );
}

function Value({
  field,
  label,
  children,
}: {
  field: string;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-foreground/80">{label}</dt>
      <dd data-process-value={field} className="text-end font-medium tabular-nums text-foreground">
        {children}
      </dd>
    </>
  );
}

function Small({ children }: { children: ReactNode }) {
  return <small className="ms-1 text-[11px] font-normal text-muted-foreground">{children}</small>;
}

/**
 * A process's expanded row: what it does, why it's running and when it goes
 * away, then for a folded row the processes it includes (the program and its
 * console host); its memory, CPU & graphics, and Windows objects; then its
 * PID, type and age with Copy (and, for the graphics process, a link to
 * Diagnostics).
 */
export function ProcessDetails({
  row,
  ctx,
}: {
  row: ProcessInventoryProcess;
  ctx: ProcessPageContext;
}) {
  const { t } = useTranslation();
  const openSettings = useOpenSettingsLink();
  const { copied, copyText, confirmCopied } = useCopyFeedback("");
  const { locale, snapshot, history, lastRecording, windowsNumbers } = ctx;
  const now = snapshot.at;
  const dash = (field: ProcessField) => <Dash reason={missingReason(field, row, ctx, t)} />;
  const bytes = (field: "ws" | "priv" | "peak") => {
    const value = row[field];
    return value === null ? dash(field) : formatProcessBytes(value, locale);
  };
  const percent = (field: "cpuPct" | "cpuAvg" | "gpuUse") => {
    const value = row[field];
    return value === null ? dash(field) : formatProcessPercent(value, locale);
  };
  const count = (field: "handles" | "gdi" | "user" | "threads") => {
    const value = row[field];
    return value === null ? dash(field) : formatCount(value, locale);
  };
  const term = (key: string, termKey: string) => (
    <Term text={t(`${P}.terms.${termKey}`)}>{t(`${P}.details.${key}`)}</Term>
  );
  const ofCore = <Small>{t(`${P}.tiles.ofOneCore`)}</Small>;
  const ofLimit = (
    <Small>{t(`${P}.details.ofLimit`, { limit: formatCount(OBJECT_LIMIT, locale) })}</Small>
  );

  let duringRecording: ReactNode;
  const usage = lastRecording?.processes.find((item) => item.key === row.key)?.recording ?? null;
  if (!lastRecording) duringRecording = <Dash reason={t(`${P}.lastRecording.none`)} />;
  else if (!usage) duringRecording = <Dash reason={t(`${P}.unavailable.notRecorded`)} />;
  else if (usage.cpuPct === null) {
    duringRecording = (
      <Dash
        reason={t(
          usage.change === "exited" ? `${P}.lastRecording.exited` : `${P}.unavailable.notRead`
        )}
      />
    );
  } else {
    duringRecording = (
      <>
        {formatProcessPercent(usage.cpuPct, locale)}
        {usage.partial && (
          <Small>
            <Term text={t(`${P}.lastRecording.appeared`)}>{t(`${P}.lastRecording.partial`)}</Term>
          </Small>
        )}
      </>
    );
  }

  let gpuMemory: ReactNode;
  if (row.gpuDedicated === null) gpuMemory = dash("gpuDedicated");
  else if (row.gpuDedicated === 0) {
    gpuMemory = <span className="font-normal text-muted-foreground">{t(`${P}.table.none`)}</span>;
  } else gpuMemory = formatProcessBytes(row.gpuDedicated, locale);

  const trend = windowsNumbers ? handleTrend(history, row.key) : null;
  const why = t(row.about.whyKey, aboutParams(row.about.whyParams, locale, now));
  const goesAway = t(row.about.goesAwayKey, aboutParams(row.about.goesAwayParams, locale, now));
  const uptime = row.createdAt !== null ? Math.max(0, (now - row.createdAt) / 1000) : null;

  const copy = async () => {
    if (await copyText(processRowText(reportRowOf(row, now)))) confirmCopied("");
  };

  return (
    <div className="space-y-3 pb-1 pt-0.5" data-process-details-body={row.key}>
      <dl
        data-process-about=""
        className="grid max-w-[860px] grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs leading-relaxed"
      >
        <dt className="text-muted-foreground">{t(`${P}.details.what`)}</dt>
        <dd data-process-about-what="" className="text-foreground/90">
          {t(row.about.whatKey)}
        </dd>
        <dt className="text-muted-foreground">{t(`${P}.details.why`)}</dt>
        <dd data-process-about-why="" className="text-foreground/90">
          {why}
        </dd>
        <dt className="text-muted-foreground">{t(`${P}.details.goesAway`)}</dt>
        <dd data-process-about-goes="" className="text-foreground/90">
          {goesAway}
        </dd>
      </dl>

      {row.includes && row.includes.length > 1 && (
        <table
          data-process-includes=""
          className="w-full max-w-[560px] border-collapse text-xs tabular-nums"
        >
          <thead>
            <tr className="border-b border-border/60 text-[11px] text-muted-foreground dark:border-white/5">
              <th scope="col" className="py-1 pe-3 text-start font-medium">
                {t(`${P}.details.includes`)}
              </th>
              <th scope="col" className="py-1 ps-3 text-end font-medium">
                {t(`${P}.table.ws`)}
              </th>
              {windowsNumbers && (
                <th scope="col" className="py-1 ps-3 text-end font-medium">
                  {t(`${P}.table.priv`)}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {row.includes.map((part) => (
              <tr
                key={part.key}
                data-process-part={part.key}
                data-process-part-role={part.role}
                className="border-b border-border/40 last:border-b-0 dark:border-white/[0.04]"
              >
                <td className="py-1.5 pe-3 align-top">
                  <bdi className="text-foreground/90">
                    {[
                      part.exe ?? roleName(t, part.role),
                      t(`${P}.table.pid`, { pid: part.pid }),
                    ].join(" · ")}
                  </bdi>
                  {part.role === "consoleHost" && (
                    <span className="block text-[11px] text-muted-foreground">
                      {t(`${P}.details.consoleHostNote`)}
                    </span>
                  )}
                </td>
                <td data-process-part-value="ws" className="py-1.5 ps-3 text-end align-top">
                  {part.ws === null ? dash("ws") : formatProcessBytes(part.ws, locale)}
                </td>
                {windowsNumbers && (
                  <td data-process-part-value="priv" className="py-1.5 ps-3 text-end align-top">
                    {part.priv === null ? dash("priv") : formatProcessBytes(part.priv, locale)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2.5">
        <Panel
          id="memory"
          title={t(`${P}.details.memory`)}
          spark={
            <Sparkline
              className={GROUP_STYLES[row.group]?.text}
              values={sparkValues(history, row.key, "ws", { at: now, value: row.ws })}
            />
          }
        >
          <Value field="ws" label={term("ws", "ws")}>
            {bytes("ws")}
          </Value>
          {windowsNumbers && (
            <Value field="priv" label={term("priv", "priv")}>
              {bytes("priv")}
            </Value>
          )}
          <Value field="peak" label={term("peak", "peak")}>
            {bytes("peak")}
          </Value>
          {windowsNumbers && (
            <Value field="gpuDedicated" label={term("gpuMemory", "gpuMemory")}>
              {gpuMemory}
            </Value>
          )}
        </Panel>

        <Panel
          id="cpu"
          // Off Windows the panel holds no graphics rows, so it is just "CPU".
          title={windowsNumbers ? t(`${P}.details.cpu`) : t(`${P}.history.metrics.cpu`)}
          spark={
            <Sparkline
              className="text-primary"
              values={sparkValues(history, row.key, "cpuPct", { at: now, value: row.cpuPct })}
            />
          }
        >
          <Value
            field="cpuPct"
            label={<Term text={t(`${P}.terms.cpu`)}>{t(`${P}.details.cpuNow`)}</Term>}
          >
            {row.cpuPct === null ? (
              dash("cpuPct")
            ) : (
              <>
                {formatProcessPercent(row.cpuPct, locale)}
                {ofCore}
              </>
            )}
          </Value>
          <Value field="cpuRecording" label={t(`${P}.details.cpuRecording`)}>
            {duringRecording}
          </Value>
          <Value field="cpuAvg" label={term("cpuAvg", "cpuAvg")}>
            {percent("cpuAvg")}
          </Value>
          <Value field="cpuSec" label={term("cpuTime", "cpuTime")}>
            {row.cpuSec === null ? dash("cpuSec") : formatProcessDuration(row.cpuSec, locale)}
          </Value>
          {windowsNumbers && (
            <Value field="gpuUse" label={term("gpuUse", "gpuUse")}>
              {percent("gpuUse")}
            </Value>
          )}
        </Panel>

        {windowsNumbers && (
          <Panel
            id="objects"
            title={t(`${P}.details.objects`)}
            note={
              <p
                data-process-leak-note=""
                className="mt-2 text-[11px] leading-relaxed text-muted-foreground"
              >
                {trend && trend.spanMs > 0 && (
                  <>
                    {t(`${P}.details.handleTrend`, {
                      from: formatCount(trend.from, locale),
                      to: formatCount(trend.to, locale),
                      duration: formatProcessDuration(trend.spanMs / 1000, locale),
                    })}{" "}
                  </>
                )}
                {t(`${P}.details.leakNote`)}
              </p>
            }
          >
            <Value field="handles" label={term("handles", "handles")}>
              {count("handles")}
            </Value>
            <Value field="gdi" label={term("gdi", "gdi")}>
              {count("gdi")}
              {row.gdi !== null && ofLimit}
            </Value>
            <Value field="user" label={term("user", "user")}>
              {count("user")}
              {row.user !== null && ofLimit}
            </Value>
            <Value field="threads" label={term("threads", "threads")}>
              {count("threads")}
            </Value>
          </Panel>
        )}
      </div>

      <div
        data-process-footer=""
        className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border/50 pt-2 text-[11px] text-muted-foreground dark:border-white/5"
      >
        <span className="tabular-nums">{t(`${P}.table.pid`, { pid: row.pid })}</span>
        {(row.type ?? row.exe) && <span>{row.type ?? row.exe}</span>}
        {row.createdAt !== null && (
          <span>
            {t(`${P}.details.startedAt`, { time: formatProcessTime(row.createdAt, locale, now) })}
          </span>
        )}
        {uptime !== null && (
          <span>
            {t(`${P}.details.runningFor`, { duration: formatProcessDuration(uptime, locale) })}
          </span>
        )}
        <span className="ms-auto flex items-center gap-1.5">
          {row.role === "gpu" && openSettings && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-link"
              data-process-graphics-link=""
              onClick={() => openSettings(GRAPHICS_DIAGNOSTICS_DESTINATION)}
            >
              {t(`${P}.details.graphicsDetails`)}
              <ChevronRight aria-hidden="true" className="ms-1 h-3 w-3 rtl:rotate-180" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            aria-label={copied ? t("common.copied") : t(`${P}.details.copyLabel`)}
            data-process-copy={row.key}
            onClick={() => void copy()}
          >
            {copied ? (
              <Check aria-hidden="true" className="me-1.5 h-3.5 w-3.5" />
            ) : (
              <Copy aria-hidden="true" className="me-1.5 h-3.5 w-3.5" />
            )}
            {copied ? t("common.copied") : t(`${P}.details.copy`)}
          </Button>
        </span>
      </div>
    </div>
  );
}
