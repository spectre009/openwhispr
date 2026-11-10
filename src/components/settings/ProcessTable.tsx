import { Fragment, useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "../icons";
import { cn } from "../lib/utils";
import type { ProcessInventoryProcess } from "../../types/electron";
import { Dash } from "./ProcessHint";
import { useHint } from "./useProcessHint";
import { ProcessDetails } from "./ProcessDetails";
import {
  formatProcessBytes,
  formatProcessPercent,
  formatProcessTime,
} from "./processInventoryFormat";
import {
  GROUP_STYLES,
  groupProcesses,
  type ProcessSort,
  type ProcessSortKey,
} from "./processesView";
import {
  P,
  missingReason,
  processState,
  processSubline,
  roleName,
  type ProcessPageContext,
} from "./processesText";

interface Column {
  id: "process" | ProcessSortKey | "started";
  label: string;
  term?: string;
  sortable: boolean;
  end: boolean;
}

// Started is the first column to give up room: hidden when the table itself is
// narrower than 48rem, so the process names and their exe keep the space.
const STARTED_VISIBILITY = "hidden @3xl:table-cell";

/** A column title: a sort button for the number columns, the term explained on hover and focus. */
function ColumnHeader({
  column,
  sort,
  onSort,
}: {
  column: Column;
  sort: ProcessSort;
  onSort: (key: ProcessSortKey) => void;
}) {
  const { t } = useTranslation();
  const hint = useHint<HTMLButtonElement>(column.term ? t(`${P}.terms.${column.term}`) : "", {
    describe: Boolean(column.term),
  });
  const sorted = column.sortable && sort.key === column.id;
  return (
    <th
      scope="col"
      data-process-column={column.id}
      aria-sort={
        column.sortable
          ? sorted
            ? sort.descending
              ? "descending"
              : "ascending"
            : "none"
          : undefined
      }
      className={cn(
        "whitespace-nowrap px-3 py-2 text-[11px] font-medium text-muted-foreground",
        column.end ? "text-end" : "text-start",
        column.id === "process" && "w-[38%]",
        column.id === "started" && STARTED_VISIBILITY,
        sorted && "text-foreground"
      )}
    >
      {column.sortable ? (
        <>
          <button
            type="button"
            {...(column.term ? hint.props : {})}
            data-process-sort={column.id}
            onClick={() => onSort(column.id as ProcessSortKey)}
            className="inline-flex items-center gap-1 rounded-sm underline decoration-muted-foreground/40 decoration-dotted underline-offset-[3px] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {column.label}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-3 w-3 transition-transform",
                !sorted && "opacity-30",
                sorted && !sort.descending && "rotate-180"
              )}
            />
          </button>
          {column.term && hint.nodes}
        </>
      ) : (
        column.label
      )}
    </th>
  );
}

/**
 * The grouped process table: App, Windows, Chromium services, Helpers, then
 * "Not running now". Sortable by in RAM, committed, CPU and graphics within
 * each group; a row opens to its details (grouped panels).
 */
export function ProcessTable({
  ctx,
  sort,
  onSort,
  expanded,
  onToggle,
}: {
  ctx: ProcessPageContext;
  sort: ProcessSort;
  onSort: (key: ProcessSortKey) => void;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const { snapshot, locale, windowsNumbers } = ctx;
  const rows = snapshot.processes;
  const groups = groupProcesses(rows, sort);
  const maxWs = Math.max(0, ...rows.map((row) => row.ws ?? 0));

  const columns: Column[] = [
    { id: "process", label: t(`${P}.table.process`), sortable: false, end: false },
    { id: "ws", label: t(`${P}.table.ws`), term: "ws", sortable: true, end: true },
    ...(windowsNumbers
      ? [
          {
            id: "priv",
            label: t(`${P}.table.priv`),
            term: "priv",
            sortable: true,
            end: true,
          } as Column,
        ]
      : []),
    { id: "cpu", label: t(`${P}.table.cpu`), term: "cpu", sortable: true, end: true },
    ...(windowsNumbers
      ? [
          {
            id: "gpu",
            label: t(`${P}.table.gpu`),
            term: "gpuMemory",
            sortable: true,
            end: true,
          } as Column,
        ]
      : []),
    { id: "started", label: t(`${P}.table.started`), sortable: false, end: false },
  ];

  const cell = (row: ProcessInventoryProcess, id: Column["id"]): ReactNode => {
    switch (id) {
      case "ws":
        return row.ws === null ? (
          <Dash reason={missingReason("ws", row, ctx, t)} />
        ) : (
          <>
            {formatProcessBytes(row.ws, locale)}
            <span
              aria-hidden="true"
              className={cn(
                "ms-1.5 inline-block h-1.5 rounded-full align-middle opacity-80",
                GROUP_STYLES[row.group]?.bg
              )}
              style={{ width: `${maxWs > 0 ? Math.max(2, (row.ws / maxWs) * 40) : 0}px` }}
            />
          </>
        );
      case "priv":
        return row.priv === null ? (
          <Dash reason={missingReason("priv", row, ctx, t)} />
        ) : (
          <span className="text-muted-foreground">{formatProcessBytes(row.priv, locale)}</span>
        );
      case "cpu":
        return row.cpuPct === null ? (
          <Dash reason={missingReason("cpuPct", row, ctx, t)} />
        ) : (
          formatProcessPercent(row.cpuPct, locale)
        );
      case "gpu":
        if (row.gpuDedicated === null) {
          return <Dash reason={missingReason("gpuDedicated", row, ctx, t)} />;
        }
        return row.gpuDedicated === 0 ? (
          <span className="text-muted-foreground/70">{t(`${P}.table.none`)}</span>
        ) : (
          formatProcessBytes(row.gpuDedicated, locale)
        );
      case "started":
        return row.createdAt === null ? null : (
          <span className="text-muted-foreground">
            {formatProcessTime(row.createdAt, locale, snapshot.at)}
          </span>
        );
      default:
        return null;
    }
  };

  const groupHeader = (key: string, label: string) => (
    <tr data-process-group={key}>
      <th
        scope="colgroup"
        colSpan={columns.length}
        className="px-3 pb-1.5 pt-3.5 text-start text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80"
      >
        {label}
      </th>
    </tr>
  );

  return (
    <div className="@container overflow-x-auto rounded-lg border border-border/70 bg-card/50 dark:border-border-subtle/70 dark:bg-surface-2/50">
      <table data-process-table="" className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border/60 dark:border-border-subtle/50">
            {columns.map((column) => (
              <ColumnHeader key={column.id} column={column} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map(({ group, rows: groupRows }) => (
            <Fragment key={group}>
              {groupHeader(group, t(`${P}.groups.${group}`))}
              {groupRows.map((row) => {
                const open = expanded.has(row.key);
                const detailsId = `${baseId}-${row.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
                const state = processState(row, t);
                return (
                  <Fragment key={row.key}>
                    <tr
                      data-process-row={row.key}
                      data-process-role={row.role}
                      onClick={(event) => {
                        if (
                          (event.target as HTMLElement).closest("button, a, [data-process-term]")
                        ) {
                          return;
                        }
                        onToggle(row.key);
                      }}
                      className={cn(
                        "cursor-pointer border-b border-border/40 hover:bg-muted/40 dark:border-white/[0.04] dark:hover:bg-white/[0.025]",
                        open && "bg-muted/40 dark:bg-white/[0.035]"
                      )}
                    >
                      {columns.map((column) =>
                        column.id === "process" ? (
                          <td key="process" className="px-3 py-2 align-middle">
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-controls={open ? detailsId : undefined}
                              data-process-toggle={row.key}
                              onClick={() => onToggle(row.key)}
                              className="flex w-full items-start gap-2 rounded-sm text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                            >
                              {open ? (
                                <ChevronDown
                                  aria-hidden="true"
                                  className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground"
                                />
                              ) : (
                                <ChevronRight
                                  aria-hidden="true"
                                  className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground rtl:rotate-180"
                                />
                              )}
                              <span
                                aria-hidden="true"
                                className={cn(
                                  "mt-1 inline-block h-2 w-2 shrink-0 rounded-full",
                                  GROUP_STYLES[row.group]?.bg
                                )}
                              />
                              {/* flex-1 plus the sub-line's w-0 min-w-full: a long exe name
                                  truncates instead of widening the column past the page. */}
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-medium text-foreground">
                                    {t(row.about.nameKey)}
                                  </span>
                                  {state && (
                                    <span
                                      data-process-state=""
                                      className="rounded-full border border-border/70 px-1.5 text-[10.5px] leading-4 text-muted-foreground dark:border-white/10"
                                    >
                                      {state}
                                    </span>
                                  )}
                                </span>
                                {/* The line follows the page's direction so it sits under the
                                    name; bdi keeps the exe name and PID in their own order. */}
                                <span className="block w-0 min-w-full truncate text-[11px] text-muted-foreground/80">
                                  <bdi>{processSubline(row, t)}</bdi>
                                </span>
                              </span>
                            </button>
                          </td>
                        ) : (
                          <td
                            key={column.id}
                            data-process-cell={column.id}
                            className={cn(
                              "whitespace-nowrap px-3 py-2 align-middle tabular-nums",
                              column.end ? "text-end" : "text-start",
                              column.id === "started" && STARTED_VISIBILITY
                            )}
                          >
                            {cell(row, column.id)}
                          </td>
                        )
                      )}
                    </tr>
                    {open && (
                      <tr
                        id={detailsId}
                        data-process-details={row.key}
                        className="border-b border-border/40 bg-muted/40 dark:border-white/[0.04] dark:bg-white/[0.035]"
                      >
                        <td colSpan={columns.length} className="px-3 pb-3 ps-8">
                          <ProcessDetails row={row} ctx={ctx} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
          {snapshot.notRunning.length > 0 && (
            <>
              {groupHeader("notRunning", t(`${P}.groups.notRunning`))}
              {snapshot.notRunning.map((item) => (
                <tr
                  key={item.role}
                  data-process-not-running={item.role}
                  className="border-b border-border/30 last:border-b-0 dark:border-white/[0.03]"
                >
                  <td className="px-3 py-1.5 ps-[2.125rem] text-muted-foreground">
                    {roleName(t, item.role)}
                  </td>
                  <td
                    colSpan={columns.length - 1}
                    className="px-3 py-1.5 text-[11px] text-muted-foreground/80"
                  >
                    {t(item.startsKey)}
                  </td>
                </tr>
              ))}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
