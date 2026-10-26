import { useState } from "react";
import type React from "react";

interface PillTooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  /**
   * Shown without hover, in place of `content`, while set: a short status the
   * pill must say on its own (a long-running dictation that Esc now cancels).
   */
  notice?: React.ReactNode;
  emoji?: string;
  align?: "left" | "right" | "center";
  // Toward the window's open side: above a pill docked at the bottom edge,
  // below one docked at the top.
  side?: "above" | "below";
  disabled?: boolean;
}

/**
 * Minimal hover tooltip for the dictation pill. The pill window is tiny and
 * frameless, so this stays lighter than the app-wide Radix tooltip and can be
 * aligned against the pill's docked edge.
 */
export function PillTooltip({
  children,
  content,
  notice,
  emoji,
  align = "center",
  side = "above",
  disabled = false,
}: PillTooltipProps): React.JSX.Element {
  const [isVisible, setIsVisible] = useState(false);

  const alignClass =
    align === "right" ? "right-0" : align === "left" ? "left-0" : "left-1/2 -translate-x-1/2";

  const arrowClass =
    align === "right" ? "right-3" : align === "left" ? "left-3" : "left-1/2 -translate-x-1/2";

  const below = side === "below";
  const hasNotice = notice !== undefined && notice !== null && notice !== false;
  const shown = !disabled && (hasNotice || isVisible);

  return (
    <div className="relative inline-block">
      <div onMouseEnter={() => setIsVisible(true)} onMouseLeave={() => setIsVisible(false)}>
        {children}
      </div>
      {shown && (
        <div
          role={hasNotice ? "status" : undefined}
          className={`absolute ${below ? "top-full mt-2" : "bottom-full mb-2"} ${alignClass} px-1.5 py-1 text-[10px] text-popover-foreground bg-popover border border-border z-10 shadow-lg transition-opacity duration-150 ${
            hasNotice
              ? "w-max max-w-[184px] whitespace-normal text-center leading-tight rounded-lg"
              : "whitespace-nowrap rounded-full"
          }`}
        >
          {emoji && !hasNotice && <span className="me-1">{emoji}</span>}
          {hasNotice ? notice : content}
          <div
            className={`absolute ${
              below
                ? "bottom-full border-b-2 border-b-popover"
                : "top-full border-t-2 border-t-popover"
            } ${arrowClass} w-0 h-0 border-l-2 border-r-2 border-transparent`}
          ></div>
        </div>
      )}
    </div>
  );
}
