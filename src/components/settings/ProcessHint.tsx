import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { useHint } from "./useProcessHint";

// Processes & resources' explanations: a term (in RAM, committed, handles…)
// on hover and keyboard focus, and why a number shows "—" on hover.

/** A term with its explanation on hover and keyboard focus (dotted underline). */
export function Term({
  text,
  children,
  className,
}: {
  text: string;
  children: ReactNode;
  className?: string;
}) {
  const hint = useHint<HTMLSpanElement>(text);
  return (
    <>
      <span
        {...hint.props}
        tabIndex={0}
        data-process-term=""
        className={cn(
          "cursor-help rounded-sm underline decoration-muted-foreground/50 decoration-dotted underline-offset-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          className
        )}
      >
        {children}
      </span>
      {hint.nodes}
    </>
  );
}

/** "—" for a number that isn't available, with why on hover (and for screen readers). */
export function Dash({ reason }: { reason: string }) {
  const hint = useHint<HTMLSpanElement>(reason, { describe: false });
  return (
    <span
      ref={hint.props.ref}
      onMouseEnter={hint.props.onMouseEnter}
      onMouseLeave={hint.props.onMouseLeave}
      data-process-dash={reason}
      className="cursor-help text-muted-foreground/70"
    >
      <span aria-hidden="true">—</span>
      <span className="sr-only">{reason}</span>
      {hint.nodes}
    </span>
  );
}
