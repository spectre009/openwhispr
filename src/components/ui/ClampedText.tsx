import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../lib/utils";

interface ClampedTextProps {
  children: React.ReactNode;
  /** The box around the text (border, background, padding); the toggle sits inside it. */
  className?: string;
  /** Height of the collapsed text, in rem. */
  collapsedRem?: number;
}

const FADE = "linear-gradient(to bottom, #000 calc(100% - 2.5rem), transparent)";

function remPx(doc: Document): number {
  const view = doc.defaultView;
  const size =
    typeof view?.getComputedStyle === "function"
      ? parseFloat(view.getComputedStyle(doc.documentElement).fontSize)
      : NaN;
  return Number.isFinite(size) && size > 0 ? size : 16;
}

/**
 * Long read-only text, clamped with a fade and a "Show all" toggle instead of a
 * small inner scroller, so the wheel always scrolls the page (Settings has one
 * scroller). The toggle only appears when the text is taller than the clamp.
 * No height animation, so nothing moves for reduced-motion users either.
 */
export default function ClampedText({ children, className, collapsedRem = 12 }: ClampedTextProps) {
  const { t } = useTranslation();
  const id = React.useId();
  const clipRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const toggleRef = React.useRef<HTMLButtonElement>(null);
  const [overflows, setOverflows] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const collapsed = !expanded;

  const measure = React.useCallback(() => {
    const clip = clipRef.current;
    if (!clip) return;
    const full = clip.scrollHeight;
    // Not rendered (Settings or this page hidden), or no layout: keep what we had.
    if (!full) return;
    setOverflows(full > collapsedRem * remPx(clip.ownerDocument) + 1);
  }, [collapsedRem]);

  // New text after a render; cheap, and state only changes when the answer does.
  React.useLayoutEffect(() => {
    measure();
  });

  // Rewrapping at a new width, text that changes without a render, and being
  // shown after mounting while hidden (its size goes from 0 to real).
  React.useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(content);
    const fonts = content.ownerDocument.fonts;
    let active = true;
    const onFonts = () => {
      if (active) measure();
    };
    fonts?.ready?.then(onFonts, () => {});
    fonts?.addEventListener?.("loadingdone", onFonts);
    return () => {
      active = false;
      observer?.disconnect();
      fonts?.removeEventListener?.("loadingdone", onFonts);
    };
  }, [measure]);

  const toggle = () => {
    const collapsing = expanded;
    setExpanded(!expanded);
    // Collapsing a long text can leave the toggle far above the viewport.
    if (collapsing) {
      requestAnimationFrame(() => toggleRef.current?.scrollIntoView?.({ block: "nearest" }));
    }
  };

  const clamped = collapsed && overflows;
  return (
    <div className={className}>
      <div
        id={id}
        ref={clipRef}
        data-clamped-text={clamped ? "collapsed" : overflows ? "expanded" : "fits"}
        className={cn(collapsed && "overflow-hidden")}
        style={
          collapsed
            ? {
                maxHeight: `${collapsedRem}rem`,
                ...(overflows ? { maskImage: FADE, WebkitMaskImage: FADE } : null),
              }
            : undefined
        }
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {overflows && (
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={toggle}
          className="mt-2 rounded-sm text-xs font-medium text-primary hover:underline outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {expanded ? t("common.showLess") : t("common.showAll")}
        </button>
      )}
    </div>
  );
}
