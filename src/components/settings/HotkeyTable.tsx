import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "../icons";
import { cn } from "../lib/utils";

// Settings › Hotkeys: every global hotkey in one table (Action · Hotkey · How ·
// a link to the feature). Presentational only: each row holds the hotkey's
// existing control (HotkeyListInput, the style hotkeys' read-only keys), so
// capture, validation, conflict checks and warnings stay where they were. Rows
// stack below a narrow container width.

const ROW_GRID =
  "grid grid-cols-1 gap-x-4 gap-y-2 @2xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.7fr)_minmax(0,0.75fr)_minmax(0,0.8fr)]";

/** A key as text (read-only), e.g. a style's key or Esc. */
export function HotkeyKbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      dir="ltr"
      className="inline-flex items-center rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-foreground"
    >
      {children}
    </kbd>
  );
}

/** A muted pill in the Hotkey column ("Not set", "Style off"). */
export function HotkeyStatePill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2 py-px text-[11px] text-muted-foreground dark:border-white/10">
      {children}
    </span>
  );
}

/** "Edit style ›", "Voice Assistant ›": opens where the hotkey's feature lives. */
export function HotkeyFeatureLink({
  label,
  onClick,
  title,
}: {
  label: string;
  onClick: () => void;
  /** A longer tooltip ("Open Email in Styles"); the visible label stays the name. */
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-0.5 text-xs text-link underline decoration-link/30 transition-colors hover:decoration-link/60"
    >
      {label}
      <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 rtl:rotate-180" />
    </button>
  );
}

export function HotkeyTable({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="@container">
      <div
        role="table"
        aria-label={label}
        data-hotkey-table=""
        className="divide-y divide-border/60 rounded-lg border border-border/70 bg-card/50 dark:divide-border-subtle/50 dark:border-border-subtle/70 dark:bg-surface-2/50"
      >
        <div role="rowgroup" className="hidden @2xl:block">
          <div
            role="row"
            className={cn(ROW_GRID, "px-4 py-2 text-[11px] font-medium text-muted-foreground/80")}
          >
            <span role="columnheader">{t("settingsHotkeys.columns.action")}</span>
            <span role="columnheader">{t("settingsHotkeys.columns.hotkey")}</span>
            <span role="columnheader">{t("settingsHotkeys.columns.how")}</span>
            <span role="columnheader" className="sr-only">
              {t("common.actions")}
            </span>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A group of rows (the style hotkeys), divided like the table's own rows. */
export function HotkeyTableGroup({
  children,
  "data-setting-id": settingId,
}: {
  children: ReactNode;
  /** Settings search anchor (see settings/search/registry.ts). */
  "data-setting-id"?: string;
}) {
  return (
    <div
      role="rowgroup"
      data-setting-id={settingId}
      className="divide-y divide-border/60 dark:divide-border-subtle/50"
    >
      {children}
    </div>
  );
}

export function HotkeyTableRow({
  rowId,
  action,
  description,
  how,
  actions,
  children,
  "data-setting-id": settingId,
}: {
  /** Names the row for tests and the live check (`data-hotkey-row`). */
  rowId: string;
  action: ReactNode;
  description?: ReactNode;
  /** Hold, Tap, "Hold, like dictation", "While recording". */
  how?: ReactNode;
  /** A link to the feature ("Edit style ›"). */
  actions?: ReactNode;
  /** The Hotkey column: the existing control, or the key as text, and its notes. */
  children: ReactNode;
  /** Settings search anchor (see settings/search/registry.ts). */
  "data-setting-id"?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="row"
      data-hotkey-row={rowId}
      data-setting-id={settingId}
      className={cn(ROW_GRID, "items-start px-4 py-3")}
    >
      <div role="rowheader" className="min-w-0 @2xl:pt-1">
        <p dir="auto" className="text-xs font-medium text-foreground">
          {action}
        </p>
        {description && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/80">
            {description}
          </p>
        )}
      </div>
      <div role="cell" className="min-w-0">
        {children}
      </div>
      <div
        role="cell"
        className="min-w-0 text-xs text-muted-foreground empty:hidden @2xl:pt-1 @2xl:empty:block"
      >
        {how && (
          <>
            <span className="@2xl:hidden">{t("settingsHotkeys.columns.how")}: </span>
            {how}
          </>
        )}
      </div>
      <div role="cell" className="min-w-0 empty:hidden @2xl:pt-1 @2xl:text-end @2xl:empty:block">
        {actions}
      </div>
    </div>
  );
}
