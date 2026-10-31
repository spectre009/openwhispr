import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil } from "../icons";
import { Input } from "../ui/input";
import { cn } from "../lib/utils";
import { formatRelativeTime } from "../../utils/dateFormatting";
import { isSpeechMissed } from "../../helpers/dictionaryUsage.js";
import type { DictionaryDivider, DictionaryListItem } from "../../utils/dictionaryList";
import { COVERAGE_DOT_CLASS, COVERAGE_TEXT_CLASS } from "./coverageStyles";

// The Dictionary's word list: a multi-select listbox (↑/↓ move, Space
// selects, Shift extends, Enter opens the word, F2 edits, Delete removes),
// one row per word with its checkbox, pin, source, heard/written, when it
// was added and where the speech model has it. In send order, dividers mark
// where the model stops reading and where the request stops. Rows are memoized
// and skip layout off screen, so a thousand words filter smoothly.

export interface DictionaryWordListProps {
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
}

const ROW_GRID =
  "grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 @2xl:grid-cols-[1.25rem_minmax(0,1fr)_6.5rem_9rem_5rem_9.5rem_2rem]";

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
  const missed = usage ? isSpeechMissed(usage) : false;
  const usageText = usage
    ? t("dictionary.list.heardWritten", { heard: usage.heard, written: usage.written })
    : "—";

  return (
    <div
      id={id}
      role="option"
      aria-selected={checked}
      aria-label={t("dictionary.list.rowLabel", {
        word: item.word,
        source,
        coverage: coverageText,
      })}
      data-dictionary-row={item.word}
      data-coverage={item.coverage}
      onClick={(event) => onRowClick(item.word, event)}
      onDoubleClick={(event) => {
        event.preventDefault();
        onStartEdit(item.word);
      }}
      className={cn(
        ROW_GRID,
        "group min-h-10 cursor-pointer border-b border-border/50 px-3 py-1.5 text-xs transition-colors duration-100 last:border-b-0 dark:border-white/8",
        "[content-visibility:auto] [contain-intrinsic-size:auto_40px]",
        checked ? "bg-primary/8 dark:bg-primary/12" : "hover:bg-muted/50 dark:hover:bg-white/4",
        open &&
          "shadow-[inset_3px_0_0_var(--color-primary)] rtl:shadow-[inset_-3px_0_0_var(--color-primary)]",
        focused && "outline-2 -outline-offset-2 outline-ring/60"
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
          "hidden truncate tabular-nums @2xl:block",
          !usage
            ? "text-muted-foreground/70"
            : missed
              ? "text-warning"
              : usage.heard === 0 && usage.written === 0
                ? "text-muted-foreground"
                : "text-foreground/75"
        )}
        title={missed ? t("dictionary.list.missedHint") : undefined}
      >
        {usageText}
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
        {!editing && (
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
        )}
      </span>
    </div>
  );
});

const DictionaryWordList = forwardRef<HTMLDivElement, DictionaryWordListProps>(
  function DictionaryWordList(
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
    const focusedIndex = focusedWord ? items.findIndex((item) => item.word === focusedWord) : -1;

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

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
      if (event.altKey) return;
      const move = (index: number) => {
        const next = items[Math.max(0, Math.min(items.length - 1, index))];
        if (!next) return;
        onFocusWord(next.word);
        if (event.shiftKey && !selected.has(next.word)) onToggle(next.word, { range: true });
      };
      const current = focusedIndex;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
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
          break;
      }
    };

    const dividerAt = new Map(dividers.map((divider) => [divider.index, divider]));

    return (
      <div className="@container">
        <div
          aria-hidden="true"
          className={cn(
            ROW_GRID,
            "hidden border-b border-border/60 bg-muted/40 px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground @2xl:grid dark:border-white/10 dark:bg-white/3"
          )}
        >
          <span />
          <span>{t("dictionary.list.columns.word")}</span>
          <span>{t("dictionary.list.columns.source")}</span>
          <span>{t("dictionary.list.columns.heard")}</span>
          <span>{t("dictionary.list.columns.added")}</span>
          <span>{t("dictionary.list.columns.speech")}</span>
          <span />
        </div>
        <div
          ref={ref}
          role="listbox"
          tabIndex={0}
          aria-multiselectable="true"
          aria-label={label}
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
          {items.map((item, index) => {
            const divider = dividerAt.get(index);
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
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);

export default DictionaryWordList;
