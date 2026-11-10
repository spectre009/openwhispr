import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ProcessInventoryRecording, ProcessPhaseUsage } from "../../types/electron";
import { Dash, Term } from "./ProcessHint";
import {
  formatProcessBytes,
  formatProcessDuration,
  formatProcessPercent,
  formatProcessTime,
} from "./processInventoryFormat";
import { P, roleName } from "./processesText";

const STRIP_LABELS: Record<string, string> = {
  off: "settingsPage.general.floatingIcon.edgeStripOff",
  short: "settingsPage.general.floatingIcon.edgeStripShort",
  full: "settingsPage.general.floatingIcon.edgeStripFull",
  frame: "settingsPage.general.floatingIcon.edgeStripFrame",
};

const KIND_KEYS = new Set(["dictation", "assistant", "translation"]);

/**
 * What the last recording cost: CPU per process while recording (start to
 * stop), then while processing and delivering, and graphics memory read
 * after delivery (not a peak). A process that appeared or exited during a
 * phase is marked partial, never shown as 0. Off Windows there's no graphics
 * memory column (the page's one note covers it).
 */
export function ProcessRecordingCard({
  recording,
  locale,
  now,
  windowsNumbers = true,
}: {
  recording: ProcessInventoryRecording | null;
  locale: string;
  now: number;
  windowsNumbers?: boolean;
}) {
  const { t } = useTranslation();
  if (!recording) {
    return (
      <p data-process-recording="none" className="text-xs text-muted-foreground">
        {t(`${P}.lastRecording.none`)}
      </p>
    );
  }
  // Main measures CPU over 0.2 s or more; a shorter phase has no numbers to show.
  const processingTooShort = recording.processingMs !== null && recording.processingMs < 200;

  const usageCell = (usage: ProcessPhaseUsage | null, phase: "recording" | "processing") => {
    if (phase === "processing" && processingTooShort) {
      return <Dash reason={t(`${P}.lastRecording.tooShort`)} />;
    }
    if (!usage) {
      return (
        <Dash
          reason={t(
            phase === "recording" ? `${P}.unavailable.notRecorded` : `${P}.lastRecording.exited`
          )}
        />
      );
    }
    const partial = usage.partial ? (
      <small
        className="ms-1 text-[11px] text-muted-foreground"
        data-process-partial={usage.change ?? ""}
      >
        <Term
          text={t(
            usage.change === "exited" ? `${P}.lastRecording.exited` : `${P}.lastRecording.appeared`
          )}
        >
          {t(`${P}.lastRecording.partial`)}
        </Term>
      </small>
    ) : null;
    if (usage.cpuPct === null) {
      return (
        <>
          <Dash
            reason={t(
              usage.change === "exited" ? `${P}.lastRecording.exited` : `${P}.unavailable.notRead`
            )}
          />
          {partial}
        </>
      );
    }
    return (
      <>
        {formatProcessPercent(usage.cpuPct, locale)}
        {partial}
      </>
    );
  };

  const delivered = recording.afterDelivery;
  // Read only while the page is open; when it wasn't, the line below says so.
  const gpuColumn = windowsNumbers && delivered.status !== "pageClosed";
  const gpuCell = (bytes: number | null): ReactNode => {
    if (delivered.status !== "ok") {
      return <Dash reason={t(`${P}.lastRecording.afterDelivery.${delivered.status}`)} />;
    }
    if (bytes === null) return <Dash reason={t(`${P}.unavailable.gpuNotRead`)} />;
    if (bytes === 0) {
      return <span className="text-muted-foreground/70">{t(`${P}.table.none`)}</span>;
    }
    return formatProcessBytes(bytes, locale);
  };

  const rows = [...recording.processes].sort(
    (a, b) =>
      (b.recording?.cpuPct ?? -1) - (a.recording?.cpuPct ?? -1) ||
      (b.processing?.cpuPct ?? -1) - (a.processing?.cpuPct ?? -1)
  );
  const sum = (phase: "recording" | "processing") => {
    const values = rows
      .map((row) => row[phase]?.cpuPct)
      .filter((value): value is number => typeof value === "number");
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const roleCounts = new Map<string, number>();
  for (const row of rows) roleCounts.set(row.role, (roleCounts.get(row.role) ?? 0) + 1);

  const facts: string[] = [formatProcessTime(recording.at, locale, now)];
  if (recording.recordingMs !== null) {
    facts.push(formatProcessDuration(recording.recordingMs / 1000, locale));
  }
  if (KIND_KEYS.has(recording.inputKind)) {
    facts.push(t(`${P}.lastRecording.kinds.${recording.inputKind}`));
  }
  const strip = STRIP_LABELS[recording.strip] ? t(STRIP_LABELS[recording.strip]) : null;
  const edge = strip
    ? [
        t(`${P}.lastRecording.screenEdge`, { mode: strip }),
        recording.strip !== "off"
          ? t(`${P}.lastRecording.frameWindow.${recording.frameWindow}`)
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const processingHeader =
    recording.processingMs !== null
      ? `${t(`${P}.lastRecording.processing`)} (${formatProcessDuration(recording.processingMs / 1000, locale)})`
      : t(`${P}.lastRecording.processing`);

  return (
    <div
      data-process-recording=""
      className="rounded-lg border border-border/70 bg-card/50 dark:border-border-subtle/70 dark:bg-surface-2/50"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border/60 px-3 py-2 text-xs dark:border-border-subtle/50">
        <span data-process-recording-facts="" className="font-medium text-foreground">
          {facts.join(" · ")}
        </span>
        {edge && (
          <span data-process-recording-edge="" className="text-muted-foreground">
            {edge}
          </span>
        )}
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border/60 dark:border-border-subtle/50">
            <th
              scope="col"
              className="px-3 py-2 text-start text-[11px] font-medium text-muted-foreground"
            >
              {t(`${P}.lastRecording.process`)}
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-end text-[11px] font-medium text-muted-foreground"
            >
              {t(`${P}.lastRecording.recording`)}
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-end text-[11px] font-medium text-muted-foreground"
            >
              {processingHeader}
            </th>
            {gpuColumn && (
              <th
                scope="col"
                className="px-3 py-2 text-end text-[11px] font-medium text-muted-foreground"
              >
                {t(`${P}.lastRecording.gpuAfter`)}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              data-process-recording-row={row.key}
              className="border-b border-border/40 dark:border-white/[0.04]"
            >
              <th scope="row" className="px-3 py-1.5 text-start font-normal text-foreground">
                {roleName(t, row.role)}
                {(roleCounts.get(row.role) ?? 0) > 1 && (
                  <span className="ms-1.5 text-[11px] text-muted-foreground">
                    {t(`${P}.table.pid`, { pid: row.pid })}
                  </span>
                )}
              </th>
              <td data-process-phase="recording" className="px-3 py-1.5 text-end tabular-nums">
                {usageCell(row.recording, "recording")}
              </td>
              <td data-process-phase="processing" className="px-3 py-1.5 text-end tabular-nums">
                {usageCell(row.processing, "processing")}
              </td>
              {gpuColumn && (
                <td data-process-phase="gpu" className="px-3 py-1.5 text-end tabular-nums">
                  {gpuCell(row.gpuAfterDelivery)}
                </td>
              )}
            </tr>
          ))}
          <tr data-process-recording-total="" className="font-medium">
            <th scope="row" className="px-3 py-1.5 text-start font-medium text-foreground">
              {t(`${P}.lastRecording.total`)}
            </th>
            <td className="px-3 py-1.5 text-end tabular-nums">
              {sum("recording") === null
                ? ""
                : formatProcessPercent(sum("recording") as number, locale)}
            </td>
            <td className="px-3 py-1.5 text-end tabular-nums">
              {sum("processing") === null
                ? ""
                : formatProcessPercent(sum("processing") as number, locale)}
            </td>
            {gpuColumn && (
              <td className="px-3 py-1.5 text-end tabular-nums">
                {delivered.status === "ok" && delivered.gpuDedicated !== null
                  ? formatProcessBytes(delivered.gpuDedicated, locale)
                  : ""}
              </td>
            )}
          </tr>
        </tbody>
      </table>
      <div className="space-y-0.5 border-t border-border/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground dark:border-border-subtle/50">
        {windowsNumbers && (
          <p data-process-after-delivery={delivered.status}>
            {delivered.status === "ok"
              ? t(`${P}.lastRecording.afterDelivery.ok`, {
                  time: formatProcessTime(delivered.at ?? now, locale, now),
                })
              : t(`${P}.lastRecording.afterDelivery.${delivered.status}`)}
            {delivered.status === "ok" && delivered.gpuProcesses !== null && (
              <> {t(`${P}.lastRecording.gpuProcesses`, { count: delivered.gpuProcesses })}</>
            )}
          </p>
        )}
        {recording.overlapped && <p>{t(`${P}.lastRecording.overlapped`)}</p>}
        <p>{t(`${P}.lastRecording.note`)}</p>
      </div>
    </div>
  );
}
