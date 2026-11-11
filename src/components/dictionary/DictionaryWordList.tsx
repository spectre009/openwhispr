import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { Check, Eye, EyeOff, MoreHorizontal, Pencil, Trash2, Users } from "../icons";
import { Input } from "../ui/input";
import { Tooltip } from "../ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import { formatRelativeTime } from "../../utils/dateFormatting";
import { isSpeechMissed } from "../../helpers/dictionaryUsage.js";
import type {
  DictionaryDivider,
  DictionaryListItem,
  DictionaryUsageCounts,
} from "../../utils/dictionaryList";
import type { DictionaryCategory } from "../../utils/dictionaryCategories";
import { COVERAGE_DOT_CLASS, COVERAGE_TEXT_CLASS } from "./coverageStyles";
import { APPEARANCE_KIND_BG, usageParts } from "./dictionaryLabels";
import DictionaryUsageExplainer from "./DictionaryUsageExplainer";
import DictionaryCategoryPill from "./DictionaryCategoryPill";
import { CATEGORY_NAME_KEYS, categoryKey } from "./categoryStyles";
import type { DictionaryRow } from "./dictionaryViewModel";
import type { EditFailure } from "./useDictionaryActions";
import { RowCheckbox } from "./RowCheckbox";

// One word list for the Dictionary page, in two modes chosen by its props:
//
// - `rows` (DictionaryRow[], dictionaryViewModel): the lists that hold
//   teammates' words (All words with shared words, All shared, a team list,
//   Hidden). A plain list with hover actions (Share, Edit, Delete; Edit, Hide
//   for me, Delete for everyone; Unhide), checkboxes for the selection bar,
//   and virtualized past VIRTUALIZE_AFTER_ROWS rows.
// - `items` (DictionaryListItem[], utils/dictionaryList): the personal
//   dictionary (Dictionary v2, PersonalDictionaryView). A multi-select
//   listbox with columns (source, category, usage, added, coverage), pins and
//   their order, send order's dividers and a word's detail.
//
// The two share the select-all key and the page's selection model (a Shift
// range, Esc clears), but not their rows: a shared row is acted on through
// the API, a personal one through the stored dictionary and main's word state.

// ─── Shared lists: rows ───

const ROW_HEIGHT = 38;
// Shorter lists render every row: virtualizing them saves nothing.
export const VIRTUALIZE_AFTER_ROWS = 200;
// Each hover action is 24px, with 2px between them and 8px to the row's edge.
const actionsWidth = (count: number): string => `${count * 26 + 6}px`;

// Latin layouts type "a" wherever their A key sits (AZERTY puts it on KeyQ);
// Cyrillic, Arabic and other layouts type their own letter there, so for them
// the physical key decides. A Latin letter on KeyA (AZERTY's Q) is never ⌘A.
function isSelectAllKey(event: KeyboardEvent<HTMLElement>): boolean {
  const key = event.key.toLowerCase();
  return key === "a" || (event.code === "KeyA" && !/^[a-z]$/.test(key));
}

export interface WordListSelection {
  isSelected: (key: string) => boolean;
  // Anything selected: every row shows its checkbox and the hover actions step aside.
  active: boolean;
  // extend is a Shift-click, which ticks the range from the last ticked row.
  onToggle: (row: DictionaryRow, extend: boolean) => void;
  onSelectAll: () => void;
  onClear: () => void;
}

export interface DictionaryRowsListProps {
  rows: DictionaryRow[];
  // Rows of the Hidden list, which can only be unhidden.
  hiddenList: boolean;
  // Resolves why the edit failed, to show under the open editor, or null to close it.
  onEdit: (row: DictionaryRow, word: string) => Promise<EditFailure | null>;
  onDelete: (row: DictionaryRow) => void;
  onHide: (row: DictionaryRow) => void;
  onDeleteForEveryone: (row: DictionaryRow) => void;
  onUnhide: (row: DictionaryRow) => void;
  // Personal rows only show Share once there is somewhere to share to. The
  // anchor is the clicked icon, which the share popover opens from.
  onShare?: (row: DictionaryRow, anchor: HTMLElement) => void;
  // Lists without bulk actions (Hidden) have no checkboxes.
  selection?: WordListSelection;
  // A paused list's words can be read, not changed: the rows have no actions.
  readOnly?: boolean;
  // The page's scroller, which a long list is virtualized against.
  getScrollElement?: () => HTMLElement | null;
}

// The row an action was taken on. Once it leaves the list (or its editor
// closes), focus lands nearby rather than on the page, so ⌘A keeps working.
interface PendingFocus {
  key: string;
  index: number;
  // A personal rename gets a new key; focus follows the new spelling.
  renamedTo?: string;
}

interface RowAction {
  // The tooltip stays short; the accessible name says which word it acts on.
  label: string;
  ariaLabel: string;
  icon: ReactNode;
  onClick: (anchor: HTMLElement) => void;
  destructive?: boolean;
}

function RowActionButton({ action }: { action: RowAction }): ReactElement {
  return (
    <Tooltip content={action.label}>
      <button
        type="button"
        aria-label={action.ariaLabel}
        onClick={(event) => action.onClick(event.currentTarget)}
        className={cn(
          "grid size-6 place-items-center rounded-[5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
          action.destructive
            ? "text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
            : "text-foreground/55 hover:bg-foreground/6 hover:text-foreground/85 dark:hover:bg-white/8"
        )}
      >
        {action.icon}
      </button>
    </Tooltip>
  );
}

const BADGE_CLASS =
  "max-w-32 truncate rounded-[4px] bg-foreground/6 px-1.5 py-px text-[10px] text-foreground/55 dark:bg-white/8";

function RowMeta({ row }: { row: DictionaryRow }): ReactElement | null {
  const { t } = useTranslation();
  const attribution =
    row.attribution === "you"
      ? t("dictionary.shared.attribution.you")
      : row.attribution === "former"
        ? t("dictionary.shared.attribution.former")
        : (row.attribution?.name ?? null);
  const unused = row.kind === "shared" && !row.usedInDictation;
  if (!row.badge && !attribution && !unused) return null;
  return (
    <span className="flex shrink-0 items-center gap-2">
      {unused && (
        <Tooltip content={t("dictionary.shared.notUsedTooltip")}>
          <span data-not-used="" className={cn(BADGE_CLASS, "text-warning")}>
            {t("dictionary.shared.notUsed")}
            <span className="sr-only">. {t("dictionary.shared.notUsedTooltip")}</span>
          </span>
        </Tooltip>
      )}
      {attribution && (
        <span dir="auto" className="max-w-32 truncate text-[11px] text-foreground/45">
          {attribution}
        </span>
      )}
      {row.badge && (
        <span dir="auto" className={BADGE_CLASS}>
          {row.otherLists > 0
            ? t("dictionary.shared.badgeMore", { list: row.badge, extra: row.otherLists })
            : row.badge}
        </span>
      )}
    </span>
  );
}

function RowEditor({
  row,
  onCommit,
  onCancel,
}: {
  row: DictionaryRow;
  onCommit: (word: string) => Promise<EditFailure | null>;
  onCancel: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const errorId = useId();
  const [value, setValue] = useState(row.word);
  const [error, setError] = useState<EditFailure | null>(null);
  const [saving, setSaving] = useState(false);

  // Enter keeps the focus here, so any failure stays on screen. Leaving the
  // field drops a refusal (the word can't be saved as typed), but a save that
  // failed stays open with its text and error, without pulling the focus back
  // from wherever the user went; Esc and Enter work again once they return.
  const commit = async (fromBlur: boolean): Promise<void> => {
    if (saving) return;
    if (fromBlur && error) {
      // A failed save stays open until the text changes, rather than retrying on every blur.
      if (error.refused) onCancel();
      return;
    }
    // An empty word is never sent: the editor stays open until it has one.
    if (value.trim() === "") {
      if (fromBlur) onCancel();
      return;
    }
    setSaving(true);
    let failure: EditFailure | null = null;
    try {
      failure = await onCommit(value.trim());
    } finally {
      setSaving(false);
    }
    if (!failure) return;
    if (fromBlur && failure.refused) {
      onCancel();
      return;
    }
    setError(failure);
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Input
        dir="auto"
        autoFocus
        value={value}
        // readOnly rather than disabled, so a refused save keeps the focus here.
        readOnly={saving}
        aria-label={t("dictionary.editWord", { word: row.word })}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit(false);
          if (event.key === "Escape") onCancel();
        }}
        onBlur={() => void commit(true)}
        className="h-7 min-w-0 flex-1 rounded-md text-xs"
      />
      {error && (
        <span id={errorId} className="shrink-0 text-[11px] text-destructive">
          {error.message}
        </span>
      )}
    </div>
  );
}

function RowsWordList({
  rows,
  hiddenList,
  onEdit,
  onDelete,
  onHide,
  onDeleteForEveryone,
  onUnhide,
  onShare,
  selection,
  readOnly = false,
  getScrollElement,
}: DictionaryRowsListProps): ReactElement {
  const { t } = useTranslation();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  const pendingFocus = useRef<PendingFocus | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualized = rows.length > VIRTUALIZE_AFTER_ROWS && getScrollElement !== undefined;

  // The row being edited and the row holding focus stay rendered when they
  // scroll out of view, so neither the typed text nor the focus is lost.
  const pinned = [editingKey, focusedKey]
    .map((key) => (key === null ? -1 : rows.findIndex((row) => row.key === key)))
    .filter((index) => index >= 0)
    .join(",");
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = new Set(defaultRangeExtractor(range));
      for (const index of pinned ? pinned.split(",") : []) indexes.add(Number(index));
      return [...indexes].sort((left, right) => left - right);
    },
    [pinned]
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => getScrollElement?.() ?? null,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index].key,
    overscan: 12,
    scrollMargin,
    rangeExtractor,
    enabled: virtualized,
  });

  // Where the list starts inside the page's scroller, which moves as the
  // fields above it open and close.
  const measureScrollMargin = useCallback((): void => {
    const list = listRef.current;
    const scroller = getScrollElement?.();
    if (!list || !scroller || typeof list.getBoundingClientRect !== "function") return;
    const margin =
      list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setScrollMargin((previous) => (Math.abs(previous - margin) < 0.5 ? previous : margin));
  }, [getScrollElement]);

  // Measured once the list virtualizes, then whenever the page's content
  // resizes (a field above opening or closing), never on a scroll.
  useLayoutEffect(() => {
    const scroller = getScrollElement?.();
    if (!virtualized || !scroller) return;
    measureScrollMargin();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureScrollMargin);
    observer.observe(scroller.firstElementChild ?? scroller);
    return () => observer.disconnect();
  }, [virtualized, getScrollElement, measureScrollMargin]);

  // Hide and delete finish after a round trip, so this waits for the row to
  // go. Focus the user moved elsewhere meanwhile stays where they put it.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || editingKey === pending.key) return;
    const active = document.activeElement;
    const focusLost = !active || !document.body.contains(active);
    const focusRow = (row: DictionaryRow | undefined): void => {
      const element = row ? rowElements.current.get(row.key) : undefined;
      (element?.querySelector("button") ?? listRef.current)?.focus();
    };
    const index = rows.findIndex((row) => row.key === pending.key);
    if (index >= 0) {
      if (!focusLost) return;
      // A closed editor leaves the row in place; a rename's row leaves once the
      // dictionary saves, so focus keeps following it until then.
      focusRow(rows[index]);
      if (pending.renamedTo === undefined) pendingFocus.current = null;
      return;
    }
    pendingFocus.current = null;
    if (!focusLost) return;
    const renamed = rows.find((row) => row.word === pending.renamedTo);
    focusRow(renamed ?? rows[Math.min(pending.index, rows.length - 1)]);
  }, [rows, editingKey]);

  const focusNearAfter = (row: DictionaryRow, renamedTo?: string): void => {
    pendingFocus.current = {
      key: row.key,
      index: rows.findIndex((candidate) => candidate.key === row.key),
      renamedTo,
    };
  };

  // Only while the list itself has focus: the add field and the row editor keep
  // ⌘A for their text. preventDefault also keeps Edit → Select All from
  // selecting the page's text, in the Hidden list too, which has no selection.
  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if ((event.metaKey || event.ctrlKey) && isSelectAllKey(event)) {
      event.preventDefault();
      selection?.onSelectAll();
    } else if (event.key === "Escape" && selection?.active) {
      event.preventDefault();
      selection.onClear();
    }
  };

  const handleBlur = (event: FocusEvent<HTMLUListElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setFocusedKey(null);
  };

  const actionsFor = (row: DictionaryRow): RowAction[] => {
    const action = (
      labelKey: string,
      ariaLabelKey: string,
      icon: ReactNode,
      onClick: (anchor: HTMLElement) => void,
      destructive = false
    ): RowAction => ({
      label: t(labelKey),
      ariaLabel: t(ariaLabelKey, { word: row.word }),
      icon,
      onClick,
      destructive,
    });
    const edit = action(
      "dictionary.shared.actions.edit",
      "dictionary.editWord",
      <Pencil size={13} />,
      () => setEditingKey(row.key)
    );
    if (hiddenList) {
      return [
        action(
          "dictionary.shared.actions.unhide",
          "dictionary.shared.actions.unhideWord",
          <Eye size={13} />,
          () => {
            focusNearAfter(row);
            onUnhide(row);
          }
        ),
      ];
    }
    if (row.kind === "personal") {
      const share = onShare
        ? [
            action(
              "dictionary.shared.actions.share",
              "dictionary.shared.actions.shareWord",
              <Users size={13} />,
              (anchor) => onShare(row, anchor)
            ),
          ]
        : [];
      return [
        ...share,
        edit,
        action(
          "dictionary.shared.actions.delete",
          "dictionary.shared.actions.deleteWord",
          <Trash2 size={13} />,
          () => {
            focusNearAfter(row);
            onDelete(row);
          }
        ),
      ];
    }
    return [
      edit,
      action(
        "dictionary.shared.actions.hide",
        "dictionary.shared.actions.hideWord",
        <EyeOff size={13} />,
        () => {
          focusNearAfter(row);
          onHide(row);
        }
      ),
      action(
        "dictionary.shared.actions.deleteForEveryone",
        "dictionary.shared.actions.deleteForEveryoneWord",
        <Trash2 size={13} />,
        () => {
          focusNearAfter(row);
          onDeleteForEveryone(row);
        },
        true
      ),
    ];
  };

  const renderRow = (row: DictionaryRow, index: number, style?: CSSProperties): ReactElement => {
    const editing = editingKey === row.key;
    const selected = selection?.isSelected(row.key) ?? false;
    const showActions = !selection?.active && !readOnly;
    const actions = showActions ? actionsFor(row) : [];
    return (
      <li
        key={row.key}
        ref={(element) => {
          if (element) rowElements.current.set(row.key, element);
          else rowElements.current.delete(row.key);
        }}
        data-word={row.word}
        aria-setsize={virtualized ? rows.length : undefined}
        aria-posinset={virtualized ? index + 1 : undefined}
        onFocus={() => setFocusedKey(row.key)}
        style={
          showActions
            ? ({ ...style, "--row-actions-width": actionsWidth(actions.length) } as CSSProperties)
            : style
        }
        className={cn(
          "group relative -mx-2 flex h-[38px] items-center gap-2 rounded-md px-2",
          index < rows.length - 1 && "border-b border-foreground/4 dark:border-white/6",
          virtualized && "absolute inset-x-0 top-0",
          selected
            ? "bg-primary/8 dark:bg-primary/12"
            : "hover:bg-foreground/[0.025] dark:hover:bg-white/[0.03]"
        )}
      >
        {selection && (
          // A fixed column, so ticking the first row shifts nothing.
          <RowCheckbox
            checked={selected}
            label={t("dictionary.shared.selection.selectWord", { word: row.word })}
            onToggle={(event) => selection.onToggle(row, event.shiftKey)}
            className={cn(
              "size-5 shrink-0 justify-center transition-opacity duration-150",
              selection.active
                ? "opacity-100"
                : "opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
            )}
          />
        )}
        {editing ? (
          <RowEditor
            row={row}
            onCancel={() => setEditingKey(null)}
            onCommit={async (word) => {
              const failure = await onEdit(row, word);
              if (!failure) {
                focusNearAfter(row, row.kind === "personal" ? word : undefined);
                setEditingKey(null);
              }
              return failure;
            }}
          />
        ) : (
          <>
            <span
              dir="auto"
              className={cn(
                "min-w-0 flex-1 truncate text-xs text-foreground/75",
                // The hover actions sit over the row's end; the word stops short of them.
                showActions &&
                  "group-focus-within:pe-[var(--row-actions-width)] group-hover:pe-[var(--row-actions-width)]"
              )}
            >
              {row.word}
            </span>
            <span className={cn(showActions && "group-focus-within:hidden group-hover:hidden")}>
              <RowMeta row={row} />
            </span>
            {showActions && (
              <div className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                {actions.map((action) => (
                  <RowActionButton key={action.label} action={action} />
                ))}
              </div>
            )}
          </>
        )}
      </li>
    );
  };

  return (
    // Focusable so a click on a row gives the list focus for ⌘A.
    <ul
      ref={listRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className={cn("outline-none", virtualized && "relative")}
      style={virtualized ? { height: virtualizer.getTotalSize() } : undefined}
    >
      {virtualized
        ? virtualizer.getVirtualItems().map((item) =>
            renderRow(rows[item.index], item.index, {
              transform: `translateY(${item.start - scrollMargin}px)`,
            })
          )
        : rows.map((row, index) => renderRow(row, index))}
    </ul>
  );
}

// ─── The personal dictionary: items ───

// The Dictionary's word list: a multi-select listbox (↑/↓ move, Space
// selects, Shift extends, Enter opens the word, F2 edits, Delete removes, C
// opens the focused row's category menu; the listbox's description says so),
// one row per word with its checkbox, pin, source, category, how often it was used over
// 90 days (speech got it, fixed after speech, as a two-tone bar), when it was
// added and where the speech model has it. In send order, dividers mark where
// the model stops reading and where the request stops. Rows are memoized and
// skip layout off screen, so a thousand words filter smoothly. The usage
// column's ⓘ explains the numbers.
//
// In send order over the whole list it has two sections (`sections`): the
// pinned words, "Always sent first", in pin order, each with its rank and a
// drag handle (HTML5 drag and drop with a drop line; Alt+↑/↓ and Alt+Home
// move the focused one; its ⋯ menu has Move to top, up and down), then
// "Everything else" under its header. One listbox throughout, so the keys,
// selection and ranges work across both.
//
// A row's category pill isn't a tab stop (one per listbox): C on the focused
// row opens its menu with the current choice focused, and closing it (a pick,
// Esc, a click away) puts focus back on the listbox with the same active row.

/** Where a move sends a pinned word. */
export type PinMove = "top" | "up" | "down";

export interface DictionaryWordListSections {
  /** The first `pinnedCount` items are the pinned words, in pin order. */
  pinnedCount: number;
  /** Shown in the pinned section when nothing is pinned. */
  emptyPinned: ReactNode;
  /** "Everything else": its title, how it's ordered and the order control. */
  restHeader: ReactNode;
}

export interface DictionaryItemsListProps {
  items: readonly DictionaryListItem[];
  dividers: readonly DictionaryDivider[];
  selected: ReadonlySet<string>;
  focusedWord: string | null;
  openWord: string | null;
  editingWord: string | null;
  /** The listbox's accessible name. */
  label: string;
  onFocusWord: (word: string) => void;
  onToggle: (word: string, options?: { range?: boolean; only?: boolean }) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onOpen: (word: string) => void;
  onStartEdit: (word: string) => void;
  onCommitEdit: (word: string, next: string) => Promise<boolean>;
  onCancelEdit: () => void;
  /** An edit saved with Enter: focus goes back to the list. */
  onEditSubmitted: () => void;
  onSetPinned: (word: string, pinned: boolean) => void;
  onRemove: (word: string) => void;
  onEscape: () => boolean;
  /** A category picked from a row's pill (null: back to automatic). */
  onSetCategory?: (word: string, category: DictionaryCategory | null) => void;
  /** Send order's sections; null or absent: one list, pinned rows inline. */
  sections?: DictionaryWordListSections | null;
  /** Moves a pinned word to `index` in the pin order (0 first): one reorder. */
  onMovePinned?: (word: string, index: number) => void;
}

const ROW_GRID =
  "grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 @2xl:grid-cols-[1.25rem_minmax(0,1fr)_6rem_minmax(0,9rem)_minmax(0,13rem)_5rem_9.5rem_2rem]";

// The listbox's keys, as aria-keyshortcuts names them (dictionary.list.keyboardHelp says them).
const KEY_SHORTCUTS = [
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "Space",
  "Shift+Space",
  "Control+A",
  "Enter",
  "F2",
  "Delete",
  "C",
  "Alt+ArrowUp",
  "Alt+ArrowDown",
  "Alt+Home",
  "Escape",
].join(" ");

// Where a drop on a row lands: above it, or below it past its middle. A row
// without a measured height (no layout) takes it above, as the line shows.
function dropPosition(event: DragEvent<HTMLElement>): "before" | "after" {
  const rect = event.currentTarget.getBoundingClientRect();
  return rect.height > 0 && event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

/**
 * "405 · speech 256 · fixed 149" with a two-tone bar (green: speech got it,
 * amber: fixed after speech), "not used" when the final text never had it,
 * "—" without counts.
 */
export function UsageCell({ usage }: { usage: DictionaryUsageCounts | null }) {
  const { t } = useTranslation();
  if (!usage) {
    return <span className="text-muted-foreground/70">—</span>;
  }
  const { used, ok, fix, chg } = usageParts(usage);
  const missed = isSpeechMissed(usage);
  const title = [
    t("dictionary.list.usageTitle", { count: used, ok, fix, chg }),
    missed ? t("dictionary.list.missedHint") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const width = (n: number) =>
    used > 0 && n > 0 ? `${Math.max(4, Math.round((n / used) * 100))}%` : "0%";
  return (
    <span className="flex min-w-0 items-center gap-2" title={title} data-dictionary-usage>
      <span
        aria-hidden
        className="flex h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-muted dark:bg-white/10"
      >
        <span className={cn("h-full", APPEARANCE_KIND_BG.ok)} style={{ width: width(ok) }} />
        <span className={cn("h-full", APPEARANCE_KIND_BG.fix)} style={{ width: width(fix) }} />
      </span>
      {used === 0 ? (
        <span className="truncate text-muted-foreground">{t("dictionary.list.notUsed")}</span>
      ) : (
        <span
          className={cn(
            "truncate tabular-nums",
            missed ? "text-foreground/85" : "text-foreground/75"
          )}
        >
          <b className="font-semibold text-foreground/90">{used}</b>
          {" · "}
          {t("dictionary.list.usageSpeech", { count: ok })}
          {fix > 0 && (
            <>
              {" · "}
              <span className="text-warning">
                {t("dictionary.list.usageFixed", { count: fix })}
              </span>
            </>
          )}
        </span>
      )}
    </span>
  );
}

function EditField({
  word,
  onCommit,
  onCancel,
  onSubmitted,
}: {
  word: string;
  onCommit: (next: string) => Promise<boolean>;
  onCancel: () => void;
  onSubmitted: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(word);
  const [saving, setSaving] = useState(false);
  const done = useRef(false);
  const commit = async (): Promise<boolean> => {
    if (done.current || saving) return false;
    const next = value.trim();
    if (!next || next === word) {
      done.current = true;
      onCancel();
      return false;
    }
    setSaving(true);
    const ok = await onCommit(next).finally(() => setSaving(false));
    if (ok) done.current = true;
    return ok;
  };
  return (
    <Input
      dir="auto"
      autoFocus
      value={value}
      disabled={saving}
      aria-label={t("dictionary.detail.renameLabel", { word })}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          void commit().then((ok) => {
            if (ok) onSubmitted();
          });
        } else if (event.key === "Escape") {
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => void commit()}
      className="h-7 text-xs"
    />
  );
}

/** A pinned row's drag handlers; stable across renders (rows are memoized). */
interface PinDragHandlers {
  onDragStart: (word: string, event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (word: string, event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (word: string, event: DragEvent<HTMLDivElement>) => void;
  onDrop: (word: string, event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onMove: (word: string, move: PinMove) => void;
}

/** A pinned row in "Always sent first": its rank, and where a drop would land. */
interface PinnedRowState {
  rank: number;
  count: number;
  drop: "before" | "after" | null;
  dragging: boolean;
}

interface RowProps {
  id: string;
  item: DictionaryListItem;
  checked: boolean;
  focused: boolean;
  open: boolean;
  editing: boolean;
  onRowClick: (word: string, event: MouseEvent) => void;
  onCheck: (word: string, event: MouseEvent) => void;
  onStartEdit: (word: string) => void;
  onCommitEdit: (word: string, next: string) => Promise<boolean>;
  onCancelEdit: () => void;
  onEditSubmitted: () => void;
  onSetPinned: (word: string, pinned: boolean) => void;
  onSetCategory?: ((word: string, category: DictionaryCategory | null) => void) | null;
  /** This row's category menu is open, and whether the list's C opened it. */
  categoryMenu?: "mouse" | "key" | null;
  onCategoryMenuChange?: (word: string, open: boolean) => void;
  onCategoryMenuClosed?: () => void;
  /** Only in "Always sent first". */
  pin?: PinnedRowState | null;
  drag?: PinDragHandlers | null;
}

/** A pinned row's ⋯ menu: where to move it, and Edit spelling. */
function PinnedRowMenu({
  word,
  rank,
  count,
  onMove,
  onStartEdit,
}: {
  word: string;
  rank: number;
  count: number;
  onMove: (word: string, move: PinMove) => void;
  onStartEdit: (word: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={t("dictionary.pins.menu", { word })}
          title={t("dictionary.pins.menu", { word })}
          data-pin-menu={word}
          className="p-1 text-foreground/45 opacity-0 transition-opacity hover:text-foreground/75 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal size={13} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem
          disabled={rank <= 1}
          data-pin-move="top"
          onSelect={() => onMove(word, "top")}
        >
          {t("dictionary.pins.moveTop")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={rank <= 1}
          data-pin-move="up"
          onSelect={() => onMove(word, "up")}
        >
          {t("dictionary.pins.moveUp")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={rank >= count}
          data-pin-move="down"
          onSelect={() => onMove(word, "down")}
        >
          {t("dictionary.pins.moveDown")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onStartEdit(word)}>
          {t("dictionary.editWord", { word })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const Row = memo(function Row({
  id,
  item,
  checked,
  focused,
  open,
  editing,
  onRowClick,
  onCheck,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onEditSubmitted,
  onSetPinned,
  onSetCategory = null,
  categoryMenu = null,
  onCategoryMenuChange,
  onCategoryMenuClosed,
  pin = null,
  drag = null,
}: RowProps) {
  const { t, i18n } = useTranslation();
  const coverageText =
    item.coverage === "notSent" || item.rank == null
      ? t("dictionary.coverage.row.notSent")
      : t(`dictionary.coverage.row.${item.coverage}`, { rank: item.rank });
  const source = t(
    item.source === "manual" ? "dictionary.source.typed" : "dictionary.source.learned"
  );
  const added = item.createdAt ? formatRelativeTime(item.createdAt, t, i18n.language) : "";
  const usage = item.usage;
  const ranked = !!pin && !!drag;
  const rowLabel = ranked
    ? t("dictionary.pins.rowLabel", {
        word: item.word,
        rank: pin.rank,
        source,
        coverage: coverageText,
      })
    : t("dictionary.list.rowLabel", {
        word: item.word,
        source,
        coverage: coverageText,
      });

  return (
    <div
      id={id}
      role="option"
      aria-selected={checked}
      aria-label={
        onSetCategory
          ? t("dictionary.categories.rowLabel", {
              label: rowLabel,
              category: t(CATEGORY_NAME_KEYS[categoryKey(item.category)]),
            })
          : rowLabel
      }
      data-dictionary-row={item.word}
      data-category={categoryKey(item.category)}
      data-coverage={item.coverage}
      data-pin-rank={ranked ? pin.rank : undefined}
      data-drop={ranked && pin.drop ? pin.drop : undefined}
      draggable={ranked && !editing ? true : undefined}
      onDragStart={ranked ? (event) => drag.onDragStart(item.word, event) : undefined}
      onDragOver={ranked ? (event) => drag.onDragOver(item.word, event) : undefined}
      onDragLeave={ranked ? (event) => drag.onDragLeave(item.word, event) : undefined}
      onDrop={ranked ? (event) => drag.onDrop(item.word, event) : undefined}
      onDragEnd={ranked ? () => drag.onDragEnd() : undefined}
      onClick={(event) => onRowClick(item.word, event)}
      onDoubleClick={(event) => {
        event.preventDefault();
        onStartEdit(item.word);
      }}
      className={cn(
        ROW_GRID,
        "group relative min-h-10 cursor-pointer border-b border-border/50 px-3 py-1.5 text-xs transition-colors duration-100 last:border-b-0 dark:border-white/8",
        "[content-visibility:auto] [contain-intrinsic-size:auto_40px]",
        checked ? "bg-primary/8 dark:bg-primary/12" : "hover:bg-muted/50 dark:hover:bg-white/4",
        open &&
          "shadow-[inset_3px_0_0_var(--color-primary)] rtl:shadow-[inset_-3px_0_0_var(--color-primary)]",
        focused && "outline-2 -outline-offset-2 outline-ring/60",
        ranked && pin.dragging && "opacity-45",
        ranked && pin.drop === "before" && "shadow-[inset_0_2px_0_var(--color-primary)]",
        ranked && pin.drop === "after" && "shadow-[inset_0_-2px_0_var(--color-primary)]"
      )}
    >
      <span
        aria-hidden="true"
        onClick={(event) => {
          event.stopPropagation();
          onCheck(item.word, event);
        }}
        className={cn(
          "grid h-4 w-4 place-items-center rounded border transition-colors",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background group-hover:border-foreground/40"
        )}
      >
        {checked && <Check size={10} />}
      </span>

      <div className="flex min-w-0 items-center gap-2">
        {ranked && (
          <>
            <span
              aria-hidden="true"
              data-pin-grip
              title={t("dictionary.pins.dragHint")}
              className="-me-1 shrink-0 cursor-grab select-none text-[11px] leading-none tracking-[-2px] text-muted-foreground/70 active:cursor-grabbing"
            >
              ⋮⋮
            </span>
            <span
              aria-hidden="true"
              data-pin-rank-label
              className="w-6 shrink-0 text-[11.5px] tabular-nums text-primary"
            >
              {t("dictionary.pins.rank", { rank: pin.rank })}
            </span>
          </>
        )}
        <button
          type="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            onSetPinned(item.word, !item.pinned);
          }}
          aria-pressed={item.pinned}
          aria-label={t(item.pinned ? "dictionary.pins.unpin" : "dictionary.pins.pin", {
            word: item.word,
          })}
          title={t(item.pinned ? "dictionary.pins.pinnedHint" : "dictionary.pins.pinHint")}
          className={cn(
            "w-4 shrink-0 text-xs leading-none transition-opacity duration-150",
            item.pinned
              ? "text-primary"
              : "text-foreground/35 opacity-0 hover:text-foreground/60 group-hover:opacity-100"
          )}
        >
          {item.pinned ? "★" : "☆"}
        </button>
        {editing ? (
          <div className="min-w-0 flex-1">
            <EditField
              word={item.word}
              onCommit={(next) => onCommitEdit(item.word, next)}
              onCancel={onCancelEdit}
              onSubmitted={onEditSubmitted}
            />
          </div>
        ) : (
          <span dir="auto" className="min-w-0 truncate text-[13px] text-foreground/85">
            {item.word}
          </span>
        )}
      </div>

      <span
        className={cn(
          "hidden justify-self-start rounded-full border px-1.5 py-px text-[10.5px] @2xl:inline",
          item.source === "manual"
            ? "border-border text-foreground/80"
            : "border-border/60 text-muted-foreground"
        )}
      >
        {source}
      </span>

      <span
        className={cn(
          "min-w-0 @2xl:block",
          // Below @2xl the column is hidden; while its menu is open (the C key)
          // the pill stays laid out as a zero-size anchor at the row's end, so
          // the menu opens by the word rather than in the window's corner.
          categoryMenu !== null
            ? "pointer-events-none absolute end-3 top-1/2 size-0 overflow-hidden @2xl:pointer-events-auto @2xl:static @2xl:size-auto @2xl:overflow-visible"
            : "hidden"
        )}
        data-dictionary-row-category
      >
        {onSetCategory ? (
          <DictionaryCategoryPill
            word={item.word}
            category={item.category}
            source={item.categorySource}
            onChange={onSetCategory}
            variant="row"
            open={categoryMenu !== null}
            onOpenChange={(open) => onCategoryMenuChange?.(item.word, open)}
            focusCheckedOnOpen={categoryMenu === "key"}
            onCloseFocus={onCategoryMenuClosed}
          />
        ) : null}
      </span>

      <span className="hidden min-w-0 @2xl:block">
        <UsageCell usage={usage} />
      </span>

      <span className="hidden truncate text-muted-foreground @2xl:block">
        {added ? t("dictionary.list.added", { when: added }) : ""}
      </span>

      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 justify-self-end @2xl:justify-self-start",
          COVERAGE_TEXT_CLASS[item.coverage]
        )}
        title={t("dictionary.coverage.estimatedTooltip")}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
            COVERAGE_DOT_CLASS[item.coverage]
          )}
        />
        <span className="truncate">{coverageText}</span>
      </span>

      <span className="hidden justify-self-end @2xl:block">
        {!editing &&
          (ranked ? (
            <PinnedRowMenu
              word={item.word}
              rank={pin.rank}
              count={pin.count}
              onMove={drag.onMove}
              onStartEdit={onStartEdit}
            />
          ) : (
            <button
              type="button"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                onStartEdit(item.word);
              }}
              aria-label={t("dictionary.editWord", { word: item.word })}
              title={t("dictionary.editWord", { word: item.word })}
              className="p-1 text-foreground/40 opacity-0 transition-opacity hover:text-foreground/70 group-hover:opacity-100"
            >
              <Pencil size={11} />
            </button>
          ))}
      </span>
    </div>
  );
});

const ItemsWordList = forwardRef<HTMLDivElement, DictionaryItemsListProps>(function ItemsWordList(
  {
    items,
    dividers,
    selected,
    focusedWord,
    openWord,
    editingWord,
    label,
    onFocusWord,
    onToggle,
    onSelectAll,
    onClearSelection,
    onOpen,
    onStartEdit,
    onCommitEdit,
    onCancelEdit,
    onEditSubmitted,
    onSetPinned,
    onRemove,
    onEscape,
    onSetCategory,
    sections = null,
    onMovePinned,
  },
  ref
) {
  const { t } = useTranslation();
  const prefix = useId();
  const [listFocused, setListFocused] = useState(false);
  const rowId = useCallback(
    (index: number) => `${prefix.replace(/:/g, "")}-dictionary-row-${index}`,
    [prefix]
  );
  const keysHelpId = `${prefix.replace(/:/g, "")}-dictionary-keys`;
  const focusedIndex = focusedWord ? items.findIndex((item) => item.word === focusedWord) : -1;
  const pinnedCount = sections ? Math.max(0, Math.min(sections.pinnedCount, items.length)) : 0;

  // The listbox, for the forwarded ref and for taking focus back from a row's menu.
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const setListboxRef = useCallback(
    (node: HTMLDivElement | null) => {
      listboxRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );

  // The focused row stays in view as it moves.
  useEffect(() => {
    if (focusedIndex < 0 || typeof document === "undefined") return;
    document.getElementById(rowId(focusedIndex))?.scrollIntoView?.({ block: "nearest" });
  }, [focusedIndex, rowId]);

  // Handlers that rows keep across renders (rows are memoized).
  const latest = useRef({ onFocusWord, onToggle, onOpen });
  latest.current = { onFocusWord, onToggle, onOpen };
  const onRowClick = useCallback((word: string, event: MouseEvent) => {
    const { onFocusWord, onToggle, onOpen } = latest.current;
    onFocusWord(word);
    if (event.shiftKey) onToggle(word, { range: true });
    else if (event.ctrlKey || event.metaKey) onToggle(word);
    else onOpen(word);
  }, []);
  const onCheck = useCallback((word: string, event: MouseEvent) => {
    const { onFocusWord, onToggle } = latest.current;
    onFocusWord(word);
    onToggle(word, { range: event.shiftKey });
  }, []);

  // ─── A row's category menu: C on the focused row, or a click on its pill ───
  // One menu at a time, held here; closing it (a pick, Esc, a click away)
  // gives focus back to the listbox, whose active row is still that row.
  const [categoryMenu, setCategoryMenu] = useState<{
    word: string;
    via: "mouse" | "key";
  } | null>(null);
  const onCategoryMenuChange = useCallback((word: string, open: boolean) => {
    if (open) {
      // The mouse opened it: the row becomes the active one, as C's is.
      latest.current.onFocusWord(word);
      setCategoryMenu({ word, via: "mouse" });
    } else {
      setCategoryMenu((current) => (current?.word === word ? null : current));
    }
  }, []);
  const onCategoryMenuClosed = useCallback(() => {
    listboxRef.current?.focus({ preventScroll: true });
  }, []);
  // A row that leaves the list (filtered out, removed) takes its menu with it.
  const menuWord = categoryMenu?.word ?? null;
  useEffect(() => {
    if (menuWord !== null && !items.some((item) => item.word === menuWord)) {
      setCategoryMenu(null);
    }
  }, [items, menuWord]);

  // ─── Moving a pinned word: a drop, Alt+↑/↓, Move to top ───
  const latestPins = useRef({ items, pinnedCount, onMovePinned });
  latestPins.current = { items, pinnedCount, onMovePinned };
  const pinnedIndex = useCallback((word: string) => {
    const { items, pinnedCount } = latestPins.current;
    return items.slice(0, pinnedCount).findIndex((item) => item.word === word);
  }, []);
  const movePinned = useCallback(
    (word: string, to: number) => {
      const { pinnedCount, onMovePinned } = latestPins.current;
      const from = pinnedIndex(word);
      const target = Math.max(0, Math.min(pinnedCount - 1, to));
      if (!onMovePinned || from < 0 || target === from) return;
      onMovePinned(word, target);
    },
    [pinnedIndex]
  );
  const [dragWord, setDragWord] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ word: string; position: "before" | "after" } | null>(null);
  const dragRef = useRef<string | null>(null);
  const dropRef = useRef(drop);
  dropRef.current = drop;
  const dragHandlers = useMemo<PinDragHandlers>(() => {
    const endDrag = () => {
      dragRef.current = null;
      setDragWord(null);
      setDrop(null);
    };
    return {
      onDragStart: (word, event) => {
        dragRef.current = word;
        setDragWord(word);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          try {
            event.dataTransfer.setData("text/plain", word);
          } catch {
            // Some drag sources refuse data; the drag still works from here.
          }
        }
      },
      onDragOver: (word, event) => {
        if (!dragRef.current) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        const position = dropPosition(event);
        const current = dropRef.current;
        if (current?.word !== word || current.position !== position) {
          setDrop({ word, position });
        }
      },
      onDragLeave: (word, event) => {
        // Moving onto a part of the same row isn't leaving it.
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setDrop((current) => (current?.word === word ? null : current));
      },
      onDrop: (word, event) => {
        const dragged = dragRef.current;
        endDrag();
        if (!dragged) return;
        event.preventDefault();
        const from = pinnedIndex(dragged);
        const target = pinnedIndex(word);
        if (from < 0 || target < 0) return;
        let to = dropPosition(event) === "after" ? target + 1 : target;
        if (from < to) to -= 1;
        movePinned(dragged, to);
      },
      onDragEnd: endDrag,
      onMove: (word, move) => {
        const from = pinnedIndex(word);
        if (from < 0) return;
        movePinned(word, move === "top" ? 0 : move === "up" ? from - 1 : from + 1);
      },
    };
  }, [movePinned, pinnedIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    if (event.altKey) {
      // Alt+↑/↓ move the focused pinned word one place, Alt+Home to the top.
      const inPinned = focusedIndex >= 0 && focusedIndex < pinnedCount;
      if (!inPinned || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const word = items[focusedIndex].word;
      const to =
        event.key === "ArrowUp"
          ? focusedIndex - 1
          : event.key === "ArrowDown"
            ? focusedIndex + 1
            : event.key === "Home"
              ? 0
              : null;
      if (to === null) return;
      event.preventDefault();
      movePinned(word, to);
      return;
    }
    const move = (index: number) => {
      const next = items[Math.max(0, Math.min(items.length - 1, index))];
      if (!next) return;
      onFocusWord(next.word);
      if (event.shiftKey && !selected.has(next.word)) onToggle(next.word, { range: true });
    };
    const current = focusedIndex;
    if ((event.ctrlKey || event.metaKey) && isSelectAllKey(event)) {
      event.preventDefault();
      onSelectAll();
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(current < 0 ? 0 : current + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(current < 0 ? 0 : current - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(items.length - 1);
        break;
      case " ":
        if (current >= 0) {
          event.preventDefault();
          onToggle(items[current].word, { range: event.shiftKey });
        }
        break;
      case "Enter":
        if (current >= 0) {
          event.preventDefault();
          onOpen(items[current].word);
        }
        break;
      case "F2":
        if (current >= 0) {
          event.preventDefault();
          onStartEdit(items[current].word);
        }
        break;
      case "Delete":
        if (current >= 0) {
          event.preventDefault();
          onRemove(items[current].word);
        }
        break;
      case "Escape":
        if (onEscape()) {
          event.preventDefault();
          event.stopPropagation();
        } else if (selected.size > 0) {
          event.preventDefault();
          onClearSelection();
        }
        break;
      default:
        // C opens the focused row's category menu (the C key on a layout
        // whose letters aren't Latin too). Not with Shift; Ctrl, Alt and
        // Meta returned above.
        if (
          (event.key === "c" ||
            event.key === "C" ||
            (event.code === "KeyC" && !/^[a-z]$/i.test(event.key))) &&
          !event.shiftKey &&
          current >= 0 &&
          onSetCategory
        ) {
          event.preventDefault();
          setCategoryMenu({ word: items[current].word, via: "key" });
        }
        break;
    }
  };

  const dividerAt = new Map(dividers.map((divider) => [divider.index, divider]));

  const renderRow = (item: DictionaryListItem, index: number) => {
    const divider = dividerAt.get(index);
    const inPinned = !!sections && index < pinnedCount && !!onMovePinned;
    return (
      <div key={item.word} role="presentation">
        {divider && (
          <div
            role="presentation"
            data-dictionary-divider={divider.kind}
            className="flex items-center gap-3 border-y border-warning/30 bg-warning/8 px-3 py-1.5 text-[11.5px] text-warning before:flex-1 before:border-t before:border-dashed before:border-warning/50 after:flex-1 after:border-t after:border-dashed after:border-warning/50"
          >
            {t(`dictionary.list.divider.${divider.kind}`, { count: divider.count })}
          </div>
        )}
        <Row
          id={rowId(index)}
          item={item}
          checked={selected.has(item.word)}
          focused={index === focusedIndex && listFocused}
          open={item.word === openWord}
          editing={item.word === editingWord}
          onRowClick={onRowClick}
          onCheck={onCheck}
          onStartEdit={onStartEdit}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
          onEditSubmitted={onEditSubmitted}
          onSetPinned={onSetPinned}
          onSetCategory={onSetCategory}
          categoryMenu={categoryMenu?.word === item.word ? categoryMenu.via : null}
          onCategoryMenuChange={onCategoryMenuChange}
          onCategoryMenuClosed={onCategoryMenuClosed}
          pin={
            inPinned
              ? {
                  rank: index + 1,
                  count: pinnedCount,
                  drop: drop?.word === item.word ? drop.position : null,
                  dragging: dragWord === item.word,
                }
              : null
          }
          drag={inPinned ? dragHandlers : null}
        />
      </div>
    );
  };

  return (
    <div className="@container">
      {/* What the listbox's keys do, read with it (aria-describedby). */}
      <span id={keysHelpId} className="sr-only" data-dictionary-keys-help>
        {t("dictionary.list.keyboardHelp")}
      </span>
      <div
        className={cn(
          ROW_GRID,
          "hidden border-b border-border/60 bg-muted/40 px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground @2xl:grid dark:border-white/10 dark:bg-white/3"
        )}
        data-dictionary-list-header
      >
        <span aria-hidden="true" />
        <span aria-hidden="true">{t("dictionary.list.columns.word")}</span>
        <span aria-hidden="true">{t("dictionary.list.columns.source")}</span>
        <span aria-hidden="true">{t("dictionary.list.columns.category")}</span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true">{t("dictionary.list.columns.heard")}</span>
          <DictionaryUsageExplainer className="normal-case tracking-normal" />
        </span>
        <span aria-hidden="true">{t("dictionary.list.columns.added")}</span>
        <span aria-hidden="true">{t("dictionary.list.columns.speech")}</span>
        <span aria-hidden="true" />
      </div>
      <div
        ref={setListboxRef}
        role="listbox"
        tabIndex={0}
        aria-multiselectable="true"
        aria-label={label}
        aria-describedby={keysHelpId}
        aria-keyshortcuts={KEY_SHORTCUTS}
        aria-activedescendant={focusedIndex >= 0 ? rowId(focusedIndex) : undefined}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          setListFocused(true);
          if (focusedIndex < 0 && items.length > 0) onFocusWord(items[0].word);
        }}
        onBlur={(event) => {
          if (event.target === event.currentTarget) setListFocused(false);
        }}
        data-dictionary-list
        className="focus-visible:outline-none"
      >
        {sections ? (
          <>
            <div
              role="group"
              aria-label={t("dictionary.pins.sectionTitle")}
              data-dictionary-section="pinned"
              className="bg-primary/[0.03] dark:bg-primary/[0.05]"
            >
              {pinnedCount === 0 ? (
                <div
                  role="presentation"
                  data-dictionary-pins-empty
                  className="border-b border-border/50 px-3 py-3 text-xs leading-relaxed text-muted-foreground dark:border-white/8"
                >
                  {sections.emptyPinned}
                </div>
              ) : (
                items.slice(0, pinnedCount).map((item, index) => renderRow(item, index))
              )}
            </div>
            <div
              role="group"
              aria-label={t("dictionary.order.restTitle")}
              data-dictionary-section="rest"
            >
              <div
                role="presentation"
                data-dictionary-rest-header
                className="border-b border-border/60 bg-muted/30 px-3 py-2 dark:border-white/10 dark:bg-white/3"
              >
                {sections.restHeader}
              </div>
              {items.slice(pinnedCount).map((item, index) => renderRow(item, pinnedCount + index))}
            </div>
          </>
        ) : (
          items.map((item, index) => renderRow(item, index))
        )}
      </div>
    </div>
  );
});

export type DictionaryWordListProps = DictionaryRowsListProps | DictionaryItemsListProps;

const isRowsList = (props: DictionaryWordListProps): props is DictionaryRowsListProps =>
  "rows" in props;

/**
 * The Dictionary's word list: `rows` renders a shared list (RowsWordList),
 * `items` the personal dictionary's listbox (ItemsWordList), which takes the ref.
 */
export const DictionaryWordList = forwardRef<HTMLDivElement, DictionaryWordListProps>(
  function DictionaryWordList(props, ref) {
    return isRowsList(props) ? <RowsWordList {...props} /> : <ItemsWordList {...props} ref={ref} />;
  }
);

export default DictionaryWordList;
