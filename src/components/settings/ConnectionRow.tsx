import { useId, type ReactNode } from "react";
import { ChevronDown, Lock } from "../icons";
import { cn } from "../lib/utils";
import { useSettingsLayout } from "../ui/useSettingsLayout";

/**
 * One connection on a single line (Settings › AI Connections, "Saved, not in
 * use" and the folded group): logo, name, a key field or a status, actions,
 * and an optional toggle that opens the card's body under the line. On a
 * narrow page the field or status takes its own line below the name.
 */

export type RowStatusTone = "ok" | "muted" | "managed" | "busy";

export function RowStatus({ tone, children }: { tone: RowStatusTone; children: ReactNode }) {
  return (
    <span
      data-connection-status={tone}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs",
        tone === "ok" && "text-success",
        tone === "muted" && "text-muted-foreground",
        tone === "managed" && "text-primary",
        tone === "busy" && "text-warning"
      )}
    >
      {tone === "managed" && <Lock aria-hidden="true" className="h-3 w-3 shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function ConnectionRow({
  "data-setting-id": settingId,
  icon,
  name,
  nameDir,
  children,
  actions,
  toggleLabel,
  open = false,
  onToggle,
  body,
  below,
}: {
  /** Search anchor and "Manage keys" destination. */
  "data-setting-id": string;
  icon: ReactNode;
  name: string;
  /** "auto" for a name the user typed. */
  nameDir?: "auto";
  /** The line's main part: a key field, or a one-line status. */
  children?: ReactNode;
  /** Small actions at the end of the line (Remove, Get your API key, a link). */
  actions?: ReactNode;
  /** "Manage", "Set up" or "Sign in": opens `body` under the line. */
  toggleLabel?: string;
  open?: boolean;
  onToggle?: () => void;
  body?: ReactNode;
  /** Under the line, e.g. its usages that are off. */
  below?: ReactNode;
}) {
  const { isCompact } = useSettingsLayout();
  const bodyId = useId();
  const expandable = !!onToggle && !!toggleLabel;

  return (
    <div
      data-setting-id={settingId}
      data-connection-row=""
      className={cn("space-y-2", isCompact ? "px-3 py-2.5" : "px-4 py-2.5")}
    >
      <div className={cn("flex min-w-0 items-center gap-x-3 gap-y-2", isCompact && "flex-wrap")}>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background dark:border-white/10 dark:bg-surface-1">
          {icon}
        </div>
        <p
          dir={nameDir}
          className={cn(
            "truncate text-xs font-medium text-foreground",
            isCompact ? "min-w-0 flex-1" : "w-36 shrink-0"
          )}
        >
          {name}
        </p>
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            isCompact ? (children ? "order-last basis-full" : "hidden") : "flex-1"
          )}
        >
          {children}
        </div>
        {actions}
        {expandable && (
          <button
            type="button"
            data-connection-toggle=""
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={onToggle}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-xs text-link hover:underline"
          >
            {toggleLabel}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-3 w-3 shrink-0 transition-transform",
                !open && "-rotate-90 rtl:rotate-90"
              )}
            />
          </button>
        )}
      </div>
      {below}
      {expandable && open && body && (
        <div id={bodyId} data-connection-row-body="" className={cn(!isCompact && "ps-10")}>
          {body}
        </div>
      )}
    </div>
  );
}
