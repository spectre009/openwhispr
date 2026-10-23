import { cn } from "../lib/utils";

interface StyleBadgeProps {
  style: { emoji: string; name: string };
  /** Where the pill's popovers open: the badge sits on the same side. */
  side: "above" | "below";
  align: "left" | "right" | "center";
}

/**
 * The running dictation's style ("💬 Teams chat"), next to the pill while it
 * records and is processed, so a wrong style is caught before the paste.
 * Read-only: it never takes the pointer from the pill.
 */
export function StyleBadge({ style, side, align }: StyleBadgeProps) {
  return (
    <span
      role="status"
      data-dictation-style-badge=""
      className={cn(
        "pointer-events-none absolute z-10 flex max-w-[184px] items-center gap-1 whitespace-nowrap rounded-full border border-border/60 bg-surface-1 px-2 py-0.5 text-[11px] font-medium leading-4 text-foreground shadow-[var(--shadow-card)]",
        side === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        align === "left" ? "left-0" : align === "right" ? "right-0" : "left-1/2 -translate-x-1/2"
      )}
    >
      {style.emoji && (
        <span aria-hidden="true" className="shrink-0">
          {style.emoji}
        </span>
      )}
      <span dir="auto" className="min-w-0 truncate">
        {style.name}
      </span>
    </span>
  );
}
