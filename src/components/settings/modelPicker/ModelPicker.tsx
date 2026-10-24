import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  HardDrive,
  Network,
  Search,
} from "../../icons";
import { Input } from "../../ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { cn } from "../../lib/utils";
import type {
  PickerGroup,
  PickerLink,
  PickerOptionBase,
  PickerSelectionSummary,
  PickerText,
} from "./options";

type Translate = (key: string, options?: Record<string, unknown>) => string;

function resolveText(t: Translate, text: PickerText | undefined): string {
  if (!text) return "";
  return "text" in text ? text.text : t(text.key, text.params);
}

/** A connection's or model's icon: brand logos for providers, glyphs for the rest. */
export function PickerIcon({ icon, className = "h-4 w-4" }: { icon: string; className?: string }) {
  const glyph = cn(className, "shrink-0 text-muted-foreground");
  if (icon === "cloud") return <Cloud aria-hidden="true" className={glyph} />;
  if (icon === "local") return <HardDrive aria-hidden="true" className={glyph} />;
  if (icon === "selfHosted") return <Network aria-hidden="true" className={glyph} />;
  if (icon === "enterprise") return <Building2 aria-hidden="true" className={glyph} />;
  return <ProviderIcon provider={icon} className={cn(className, "shrink-0")} />;
}

interface FlatOption<O extends PickerOptionBase> {
  option: O;
  group: PickerGroup<O>;
  label: string;
  sub: string;
  reason: string;
}

interface ModelPickerProps<O extends PickerOptionBase> {
  groups: readonly PickerGroup<O>[];
  selectedId: string | null;
  summary: PickerSelectionSummary;
  onSelect: (option: O) => void;
  /** Follows an unavailable entry's link (or a link entry). */
  onLink: (link: PickerLink) => void;
  /** Whether a link can be followed here (Settings links hide outside Settings). */
  canFollow?: (link: PickerLink) => boolean;
  /** Extra lines under a group's header (a list that's loading or failed). */
  groupNotes?: Readonly<Record<string, ReactNode>>;
  /** Accessible name of the button and the list. */
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Replaces the button with other content the menu opens from (note
   * formatting's inherited fields, each with Override); it gets `openMenu`.
   */
  renderAnchor?: (openMenu: () => void) => ReactNode;
  className?: string;
}

/**
 * The model picker: a button showing the selection (logo · model, then
 * connection · account) that opens a menu with a filter field and the
 * options grouped by connection. Type to filter, ↑/↓ to move, Enter to pick,
 * Esc closes the menu only (it's a Radix popover, so Settings' Esc and close
 * rules see it). Unavailable entries stay listed and focusable with their
 * reason; they can't be picked, but their link can be followed. Generic over
 * the option type: the language-model and speech-to-text pickers share it.
 */
export default function ModelPicker<O extends PickerOptionBase>({
  groups,
  selectedId,
  summary,
  onSelect,
  onLink,
  canFollow = () => true,
  groupNotes,
  label,
  open: controlledOpen,
  onOpenChange,
  renderAnchor,
  className,
}: ModelPickerProps<O>) {
  const { t } = useTranslation();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const flat = useMemo<FlatOption<O>[]>(
    () =>
      groups.flatMap((group) =>
        group.options.map((option) => ({
          option,
          group,
          label: resolveText(t, option.label),
          sub: resolveText(t, option.sub),
          reason:
            option.available === true
              ? ""
              : t(option.available.reasonKey, option.available.reasonParams),
        }))
      ),
    [groups, t]
  );

  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return flat;
    return flat.filter((entry) => {
      const haystack = [
        entry.label,
        entry.sub,
        entry.reason,
        resolveText(t, entry.group.title),
        ...(entry.option.terms ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [flat, query, t]);

  // Opening starts on the current selection, with an empty filter.
  const setOpen = useCallback(
    (next: boolean) => {
      if (next) {
        setQuery("");
        setActiveIndex(
          Math.max(
            0,
            flat.findIndex((entry) => entry.option.id === selectedId)
          )
        );
      }
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange, flat, selectedId]
  );

  // A new filter starts on its first match; clearing it, on the selection.
  const changeQuery = (value: string) => {
    setQuery(value);
    setActiveIndex(
      value.trim()
        ? 0
        : Math.max(
            0,
            flat.findIndex((entry) => entry.option.id === selectedId)
          )
    );
  };

  const active = visible[Math.min(activeIndex, visible.length - 1)];
  const optionDomId = (id: string) => `${listId}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const activeDomId = active ? optionDomId(active.option.id) : undefined;

  useEffect(() => {
    if (!open || !activeDomId) return;
    listRef.current?.ownerDocument
      .getElementById(activeDomId)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeDomId]);

  const follow = (link: PickerLink) => {
    setOpen(false);
    onLink(link);
  };

  const choose = (entry: FlatOption<O> | undefined) => {
    if (!entry) return;
    const { option } = entry;
    if (option.available !== true) {
      if (option.available.link && canFollow(option.available.link)) {
        follow(option.available.link);
      }
      return;
    }
    if (option.action === "link") {
      if (option.link && canFollow(option.link)) follow(option.link);
      return;
    }
    setOpen(false);
    onSelect(option);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (visible.length === 0) return;
    const current = Math.min(Math.max(activeIndex, 0), visible.length - 1);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(activeIndex < 0 ? 0 : Math.min(visible.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(0, current - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(visible.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    }
  };

  const title = resolveText(t, summary.title);
  const sub = resolveText(t, summary.sub);
  const warning = resolveText(t, summary.warning);

  let lastGroup: string | null = null;
  const rows: ReactNode[] = [];
  visible.forEach((entry, index) => {
    const { option, group } = entry;
    if (group.id !== lastGroup) {
      lastGroup = group.id;
      const meta = resolveText(t, group.meta);
      rows.push(
        <div
          key={`g:${group.id}`}
          role="presentation"
          data-picker-group={group.id}
          className="flex items-center gap-2 px-2.5 pb-1 pt-2.5 text-[11px] text-muted-foreground"
        >
          <span className="font-medium uppercase tracking-wide">{resolveText(t, group.title)}</span>
          {meta && <span className="ms-auto truncate">{meta}</span>}
        </div>
      );
      const note = groupNotes?.[group.id];
      if (note && !query.trim()) {
        rows.push(
          <div key={`n:${group.id}`} role="presentation" className="px-2.5 pb-1">
            {note}
          </div>
        );
      }
    }
    const unavailable = option.available === true ? null : option.available;
    const isSelected = option.id === selectedId;
    const isActive = entry === active;
    const link = unavailable?.link;
    rows.push(
      <div
        key={option.id}
        id={optionDomId(option.id)}
        role="option"
        aria-selected={isSelected}
        aria-disabled={unavailable ? true : undefined}
        data-option-id={option.id}
        data-active={isActive ? "" : undefined}
        onMouseMove={() => {
          if (!isActive) setActiveIndex(index);
        }}
        onClick={() => {
          if (!unavailable) choose(entry);
        }}
        className={cn(
          "mx-1 flex items-start gap-2.5 rounded-md px-2 py-1.5 text-start",
          isActive && "bg-muted dark:bg-surface-raised",
          unavailable ? "cursor-default" : "cursor-pointer"
        )}
      >
        <span className={cn("mt-0.5", unavailable && "opacity-50")}>
          <PickerIcon icon={option.icon} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-xs",
              unavailable ? "text-muted-foreground" : "font-medium text-foreground"
            )}
          >
            {entry.label}
          </span>
          {(entry.sub || unavailable) && (
            <span className="block text-[11px] leading-snug text-muted-foreground">
              {unavailable ? entry.reason : entry.sub}
              {link && canFollow(link) && (
                <button
                  type="button"
                  tabIndex={-1}
                  data-picker-link=""
                  onClick={(event) => {
                    event.stopPropagation();
                    follow(link);
                  }}
                  className="ms-1 inline-flex items-center gap-0.5 text-link underline decoration-link/30 hover:decoration-link/60"
                >
                  {t(link.labelKey)}
                  <ChevronRight aria-hidden="true" className="h-3 w-3 rtl:rotate-180" />
                </button>
              )}
            </span>
          )}
        </span>
        {option.action === "link" && option.link && (
          <ChevronRight
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
          />
        )}
        {isSelected && (
          <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        )}
      </div>
    );
  });

  const trigger = (
    <button
      type="button"
      aria-label={`${label}: ${title}${sub ? `, ${sub}` : ""}`}
      data-model-picker-trigger=""
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-md border border-border/70 bg-input px-2.5 py-1.5 text-start transition-colors hover:border-border-hover dark:border-border-subtle/60 dark:bg-surface-1",
        className
      )}
    >
      <PickerIcon icon={summary.icon} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{title}</span>
        {(warning || sub) && (
          <span
            className={cn(
              "flex min-w-0 items-center gap-1 text-[11px]",
              warning ? "text-warning" : "text-muted-foreground"
            )}
          >
            {warning && <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0" />}
            <span className="truncate">{warning ? `${sub} · ${warning}` : sub}</span>
          </span>
        )}
      </span>
      <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {renderAnchor ? (
        <PopoverAnchor asChild>
          <div>{renderAnchor(() => setOpen(true))}</div>
        </PopoverAnchor>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}
      <PopoverContent
        data-model-picker-menu=""
        className="w-[var(--radix-popover-trigger-width)] min-w-[320px] max-w-[min(480px,calc(100vw-24px))] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="flex items-center gap-2 border-b border-border/70 px-2.5 dark:border-border-subtle/60">
          <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            dir="auto"
            ref={inputRef}
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("modelPicker.filterPlaceholder")}
            aria-label={t("modelPicker.filterPlaceholder")}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={activeDomId}
            className="h-9 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          className="max-h-[min(420px,var(--radix-popover-content-available-height))] overflow-y-auto pb-1"
        >
          {rows.length > 0 ? (
            rows
          ) : (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {query.trim()
                ? t("modelPicker.noMatches", { query: query.trim() })
                : t("common.managedByOrg")}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
