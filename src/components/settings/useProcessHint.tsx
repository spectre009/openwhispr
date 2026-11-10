import { useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

// Processes & resources' explanations (ProcessHint.tsx's Term and Dash, the
// table's column titles): shown on hover and keyboard focus, portaled to the
// body so the table's cells never clip them. Only visual: the text reaches
// screen readers as the element's description (or the dash's hidden text).

const TOOLTIP_WIDTH = 280;
const MARGIN = 8;

interface Placement {
  top: number;
  left: number;
  above: boolean;
}

/** The tooltip itself, in the body. */
function portalTooltip(placement: Placement, text: string) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-hidden="true"
      data-process-tooltip=""
      className="pointer-events-none fixed z-[9999] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs font-normal normal-case leading-relaxed tracking-normal text-popover-foreground shadow-lg"
      style={{
        top: placement.top,
        left: placement.left,
        width: "max-content",
        maxWidth: TOOLTIP_WIDTH,
        transform: placement.above ? "translate(-50%, -100%)" : "translateX(-50%)",
      }}
    >
      {text}
    </div>,
    document.body
  );
}

/**
 * Hover and focus handlers that show `text` under (or above) the element,
 * plus the nodes to render beside it: the hidden description and the tooltip.
 */
export function useHint<T extends HTMLElement>(text: string, { describe = true } = {}) {
  const id = useId();
  const ref = useRef<T>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || typeof window === "undefined") return;
    const half = TOOLTIP_WIDTH / 2;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, half + MARGIN),
      Math.max(half + MARGIN, window.innerWidth - half - MARGIN)
    );
    const above = rect.bottom + 120 > window.innerHeight && rect.top > 120;
    setPlacement({ top: above ? rect.top - 6 : rect.bottom + 6, left, above });
  };
  const hide = () => setPlacement(null);
  return {
    props: {
      ref,
      "aria-describedby": describe ? id : undefined,
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: show,
      onBlur: hide,
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Escape" && placement) {
          event.preventDefault();
          hide();
        }
      },
    },
    nodes: (
      <>
        {describe && (
          <span id={id} hidden>
            {text}
          </span>
        )}
        {placement && portalTooltip(placement, text)}
      </>
    ),
  };
}
