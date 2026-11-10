import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AlertTriangle, Check, Copy, Info } from "../icons";
import { cn } from "../lib/utils";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import type { ProcessInventorySnapshot, ProcessInventoryUnavailable } from "../../types/electron";
import { useSettingsVisible } from "./useSettingsVisible";
import { useProcessInventory } from "./useProcessInventory";
import { Dash, Term } from "./ProcessHint";
import { ProcessTable } from "./ProcessTable";
import { ProcessRecordingCard } from "./ProcessRecordingCard";
import { ProcessHistoryChart } from "./ProcessHistoryChart";
import {
  formatProcessBytes,
  formatProcessPercent,
  formatProcessTime,
  processesText,
} from "./processInventoryFormat";
import { formatCount } from "./storageFormat";
import {
  GROUP_STYLES,
  memoryByGroup,
  type ProcessSort,
  type ProcessSortKey,
} from "./processesView";
import { P, type ProcessPageContext } from "./processesText";

// The notices, in this order; "windowsOnly" is the one note for every
// Windows-only number off Windows (no per-cell dashes there).
const NOTICE_ORDER: readonly ProcessInventoryUnavailable[] = [
  "windowsOnly",
  "helperMissing",
  "helperFailed",
  "gpuCounters",
  "memory",
];

function SectionTitle({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-xs font-semibold tracking-tight text-foreground">{title}</h3>
      {aside}
    </div>
  );
}

function Tile({
  id,
  label,
  value,
  unit,
  children,
}: {
  id: string;
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-process-tile={id}
      className="rounded-lg border border-border/70 bg-card/50 px-3.5 py-3 dark:border-border-subtle/70 dark:bg-surface-2/50"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-foreground">
        <span data-process-tile-value="">{value}</span>
        {unit && <small className="ms-1 text-xs font-normal text-muted-foreground">{unit}</small>}
      </div>
      {children}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[11px] leading-snug text-muted-foreground/80">{children}</p>;
}

function Tiles({
  snapshot,
  ctx,
  paused,
}: {
  snapshot: ProcessInventorySnapshot;
  ctx: ProcessPageContext;
  paused: boolean;
}) {
  const { t } = useTranslation();
  const { locale, windowsNumbers, unavailable } = ctx;
  const totals = snapshot.totals;
  const segments = memoryByGroup(snapshot.processes);
  const helperDown = snapshot.helper.status !== "ok";
  const gpuReason = helperDown
    ? t(`${P}.unavailable.helper`)
    : snapshot.helper.gpu === "failed"
      ? t(`${P}.unavailable.gpuCounters`)
      : t(`${P}.unavailable.gpuNotRead`);
  const mode = snapshot.machine.graphics?.mode;
  const subline = [t(`${P}.count`, { count: totals.processes })];
  if (windowsNumbers && totals.priv !== null) {
    subline.push(t(`${P}.tiles.committed`, { size: formatProcessBytes(totals.priv, locale) }));
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
      <Tile
        id="memory"
        label={<Term text={t(`${P}.terms.ws`)}>{t(`${P}.tiles.memory`)}</Term>}
        value={
          totals.ws === null || unavailable.includes("memory") ? (
            <Dash reason={t(`${P}.unavailable.memory`)} />
          ) : (
            formatProcessBytes(totals.ws, locale)
          )
        }
      >
        {segments.length > 0 && (
          <>
            <div
              aria-hidden="true"
              data-process-memory-bar=""
              className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-muted/50"
            >
              {segments.map((segment) => (
                <span
                  key={segment.group}
                  data-process-memory-segment={segment.group}
                  className={cn("h-full", GROUP_STYLES[segment.group].bg)}
                  style={{ width: `${Math.max(segment.share, 0.5)}%` }}
                />
              ))}
            </div>
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              {segments.map((segment) => (
                <li
                  key={segment.group}
                  data-process-memory-legend={segment.group}
                  className="flex items-center"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "me-1 inline-block h-2 w-2 rounded-sm",
                      GROUP_STYLES[segment.group].bg
                    )}
                  />
                  {t(`${P}.groups.${segment.group}`)}
                  <span className="ms-1 font-medium tabular-nums text-foreground">
                    {formatProcessBytes(segment.bytes, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <Note>
          <span data-process-tile-subline="">{subline.join(" · ")}</span>
        </Note>
        <Note>{t(`${P}.tiles.sumNote`)}</Note>
      </Tile>

      <Tile
        id="cpu"
        label={<Term text={t(`${P}.terms.cpu`)}>{t(`${P}.tiles.cpu`)}</Term>}
        value={
          totals.cpuPct === null ? (
            <Dash reason={t(`${P}.unavailable.firstSample`)} />
          ) : (
            formatProcessPercent(totals.cpuPct, locale)
          )
        }
        unit={totals.cpuPct === null ? undefined : t(`${P}.tiles.ofOneCore`)}
      >
        <Note>{paused ? t(`${P}.status.paused`) : t(`${P}.tiles.cpuNote`)}</Note>
      </Tile>

      {windowsNumbers && (
        <Tile
          id="graphics"
          label={<Term text={t(`${P}.terms.gpuMemory`)}>{t(`${P}.tiles.graphics`)}</Term>}
          value={
            totals.gpuDedicated === null ? (
              <Dash reason={gpuReason} />
            ) : (
              formatProcessBytes(totals.gpuDedicated, locale)
            )
          }
        >
          <Note>
            {t(`${P}.tiles.graphicsNote`)}
            {snapshot.gpuAt !== null && snapshot.gpuAt !== snapshot.at && (
              <>
                {" "}
                {t(`${P}.tiles.graphicsReadAt`, {
                  time: formatProcessTime(snapshot.gpuAt, locale, snapshot.at),
                })}
              </>
            )}
          </Note>
        </Tile>
      )}

      {windowsNumbers && (
        <Tile
          id="gpuProcesses"
          label={
            <>
              {t(`${P}.tiles.gpuProcesses`)}
              {(mode === "hardware" || mode === "software") && (
                <Badge
                  variant={mode === "hardware" ? "success" : "warning"}
                  className="px-1.5 py-0 text-[10px]"
                  data-process-graphics-mode={mode}
                >
                  {t(`${P}.tiles.modes.${mode}`)}
                </Badge>
              )}
            </>
          }
          value={
            snapshot.machine.gpuProcesses === null ? (
              <Dash reason={gpuReason} />
            ) : (
              formatCount(snapshot.machine.gpuProcesses, locale)
            )
          }
        >
          <Note>{t(`${P}.tiles.gpuProcessesUnit`)}</Note>
          <Note>{t(`${P}.tiles.gpuProcessesNote`)}</Note>
        </Tile>
      )}
    </div>
  );
}

/**
 * Settings › Data › Processes & resources: every process OpenWhispr runs, what
 * each one does and what it costs. While the page shows and Settings is
 * visible it subscribes to main's live samples (every 2 s); otherwise it
 * unsubscribes. During a dictation main measures nothing, and the page keeps
 * the last sample and says so.
 */
export default function ProcessesPage({ showing }: { showing: boolean }) {
  const { t, i18n } = useTranslation();
  const settingsVisible = useSettingsVisible();
  const { sample, history, failed } = useProcessInventory(showing && settingsVisible);
  const [sort, setSort] = useState<ProcessSort>({ key: "ws", descending: true });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const { copied, copyText, confirmCopied } = useCopyFeedback("");
  const [copyFailed, setCopyFailed] = useState(false);
  const locale = i18n.language;
  const snapshot = sample?.snapshot ?? null;
  const unavailable = sample?.unavailable ?? [];
  const paused = sample?.paused === true;
  const ctx: ProcessPageContext | null = snapshot
    ? {
        snapshot,
        history,
        lastRecording: sample?.lastRecording ?? null,
        unavailable,
        windowsNumbers: !unavailable.includes("windowsOnly"),
        locale,
      }
    : null;

  const onSort = (key: ProcessSortKey) =>
    setSort((current) =>
      current.key === key ? { key, descending: !current.descending } : { key, descending: true }
    );
  const onToggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // The English table Copy diagnostics includes, from main's latest report.
  const copyAll = async () => {
    setCopyFailed(false);
    let report = null;
    try {
      const result = await window.electronAPI?.getProcessInventory?.({ history: false });
      report = result?.report ?? null;
    } catch {
      report = null;
    }
    if (await copyText(processesText(report).join("\n"))) confirmCopied("");
    else setCopyFailed(true);
  };

  let status: ReactNode;
  if (!snapshot) {
    status = (
      <p
        data-process-status={failed ? "failed" : "loading"}
        className="text-xs text-muted-foreground"
      >
        {failed ? t(`${P}.status.failed`) : t(`${P}.status.loading`)}
      </p>
    );
  } else if (paused) {
    status = (
      <div
        role="status"
        data-process-status="paused"
        className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      >
        <Badge variant="warning" className="px-2 py-0 text-[11px]">
          {t(`${P}.status.paused`)}
        </Badge>
        <span>
          {t(`${P}.status.pausedDetail`, { time: formatProcessTime(snapshot.at, locale) })}
        </span>
      </div>
    );
  } else {
    status = (
      <p
        data-process-status={sample?.streaming ? "live" : "sampled"}
        className="text-xs text-muted-foreground"
      >
        {sample?.streaming
          ? t(`${P}.status.live`)
          : t(`${P}.status.sampledAt`, { time: formatProcessTime(snapshot.at, locale) })}
      </p>
    );
  }

  const notices = NOTICE_ORDER.filter((item) => unavailable.includes(item));

  return (
    <div className="space-y-6" data-processes-page="">
      <div
        role="group"
        aria-label={t(`${P}.summaryTitle`)}
        data-setting-id="data.processes.summary"
        className="space-y-2.5"
      >
        {status}
        {notices.map((notice) => (
          <p
            key={notice}
            data-process-notice={notice}
            className="flex items-start gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground dark:border-border-subtle/70"
          >
            {notice === "windowsOnly" ? (
              <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
              />
            )}
            <span>
              {t(`${P}.notices.${notice}`)}
              {notice === "helperFailed" && snapshot?.helper.error && (
                <code className="ms-1.5 rounded bg-muted px-1 py-px font-mono text-[10.5px]">
                  {snapshot.helper.error}
                </code>
              )}
            </span>
          </p>
        ))}
        {snapshot && ctx && <Tiles snapshot={snapshot} ctx={ctx} paused={paused} />}
      </div>

      <section data-setting-id="data.processes.table">
        <SectionTitle
          title={t(`${P}.table.title`)}
          aside={
            <span data-setting-id="data.processes.copy" className="flex items-center gap-2">
              {copyFailed && (
                <span role="status" className="text-xs text-destructive">
                  {t(`${P}.footnote.copyFailed`)}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                data-process-copy-all=""
                onClick={() => void copyAll()}
              >
                {copied ? (
                  <Check aria-hidden="true" className="me-1.5 h-3.5 w-3.5" />
                ) : (
                  <Copy aria-hidden="true" className="me-1.5 h-3.5 w-3.5" />
                )}
                {copied ? t("common.copied") : t(`${P}.footnote.copy`)}
              </Button>
            </span>
          }
        />
        {ctx && (
          <ProcessTable
            ctx={ctx}
            sort={sort}
            onSort={onSort}
            expanded={expanded}
            onToggle={onToggle}
          />
        )}
      </section>

      <section data-setting-id="data.processes.lastRecording">
        <SectionTitle
          title={t(`${P}.lastRecording.title`)}
          aside={
            <span className="text-[11px] text-muted-foreground">
              {t(`${P}.lastRecording.aside`)}
            </span>
          }
        />
        {/* Only once main has answered: before that "no recording" would be a guess. */}
        {sample && (
          <ProcessRecordingCard
            recording={sample.lastRecording ?? null}
            locale={locale}
            now={snapshot?.at ?? Date.now()}
            windowsNumbers={!unavailable.includes("windowsOnly")}
          />
        )}
      </section>

      <section data-setting-id="data.processes.history">
        <ProcessHistoryChart
          history={history}
          locale={locale}
          now={snapshot?.at ?? Date.now()}
          windowsNumbers={!unavailable.includes("windowsOnly")}
        />
      </section>

      <footer
        data-process-footnote=""
        className="space-y-1 border-t border-border/70 pt-4 text-[11px] leading-relaxed text-muted-foreground/80"
      >
        <p>{t(`${P}.footnote.terms`)}</p>
        <p>{t(`${P}.footnote.log`)}</p>
      </footer>
    </div>
  );
}
