import * as React from "react";

import { cn } from "../lib/utils";
import { useSettingsVisible } from "../settings/useSettingsVisible";
import { Textarea, type TextareaProps } from "./textarea";

export interface AutoGrowTextareaProps extends TextareaProps {
  /** Rows it shows when short or empty; it grows past them with its content. Defaults to `rows`, else 3. */
  minRows?: number;
  /** A bare <textarea> with only the given classes, for fields not styled as `Textarea`. */
  unstyled?: boolean;
}

const SCROLLABLE = /^(auto|scroll|overlay)$/;

// Null without layout (a test DOM with no computed styles): nothing to measure.
function layoutView(el: HTMLElement): (Window & typeof globalThis) | null {
  const view = el.ownerDocument?.defaultView;
  return typeof view?.getComputedStyle === "function" ? view : null;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  const view = layoutView(el);
  if (!view) return null;
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (SCROLLABLE.test(view.getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

const px = (value: string) => parseFloat(value) || 0;

/**
 * Sets the height to the content. Returns false when the field isn't rendered
 * (display: none here or on an ancestor reads a scrollHeight of 0): its last
 * height stays, and it's measured again once shown.
 */
function fitToContent(el: HTMLTextAreaElement): boolean {
  const view = layoutView(el);
  if (!view || !el.scrollHeight) return false;
  // Collapsing to measure can shorten the page and move its scroller; put it back.
  const scroller = scrollParent(el);
  const scrollTop = scroller?.scrollTop ?? 0;
  const previous = el.style.height;
  el.style.height = "auto";
  const style = view.getComputedStyle(el);
  const content = el.scrollHeight;
  if (content <= 0) {
    el.style.height = previous;
    return false;
  }
  const height =
    style.boxSizing === "content-box"
      ? content - px(style.paddingTop) - px(style.paddingBottom)
      : content + px(style.borderTopWidth) + px(style.borderBottomWidth);
  el.style.height = `${Math.ceil(height)}px`;
  if (scroller && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
  return true;
}

// Styles that decide where text wraps, copied to an offscreen mirror to find the caret's line.
const MIRRORED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "lineHeight",
  "fontFamily",
  "fontFeatureSettings",
  "textAlign",
  "textTransform",
  "textIndent",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "direction",
  "unicodeBidi",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
] as const;

/** The caret's line, relative to the field's top border edge. */
function caretLine(el: HTMLTextAreaElement): { top: number; height: number } | null {
  const doc = el.ownerDocument;
  const view = layoutView(el);
  if (!view || !doc.body) return null;
  const style = view.getComputedStyle(el);
  const mirror = doc.createElement("div");
  for (const prop of MIRRORED) mirror.style[prop] = style[prop];
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "-9999px",
    height: "auto",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  });
  const end = el.selectionEnd ?? el.value.length;
  mirror.textContent = el.value.slice(0, end);
  const marker = doc.createElement("span");
  // The rest of the text, so the caret's line wraps as it does in the field.
  marker.textContent = el.value.slice(end) || ".";
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);
  const top = marker.offsetTop + px(style.borderTopWidth);
  doc.body.removeChild(mirror);
  const height = px(style.lineHeight) || px(style.fontSize) * 1.5;
  return { top, height };
}

const CARET_MARGIN = 8;

/** The field never scrolls itself, so its scroller follows the caret off the bottom (or top). */
function revealCaret(el: HTMLTextAreaElement) {
  if (el.ownerDocument.activeElement !== el) return;
  const scroller = scrollParent(el);
  const line = scroller && caretLine(el);
  if (!scroller || !line) return;
  const fieldTop = el.getBoundingClientRect().top;
  const viewTop = scroller.getBoundingClientRect().top;
  const viewBottom = viewTop + scroller.clientHeight;
  const top = fieldTop + line.top - CARET_MARGIN;
  const bottom = fieldTop + line.top + line.height + CARET_MARGIN;
  if (bottom > viewBottom) scroller.scrollTop += bottom - viewBottom;
  else if (top < viewTop) scroller.scrollTop -= viewTop - top;
}

/**
 * A textarea as tall as its content: it never scrolls inside, so the wheel
 * always reaches the page (Settings has one scroller). Measured again when its
 * value or width changes, when fonts load, and when it's shown again after
 * mounting or updating while hidden (Settings stays mounted when closed).
 */
const AutoGrowTextarea = React.forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(
  ({ minRows, unstyled = false, rows, className, onInput, ...props }, forwardedRef) => {
    const ref = React.useRef<HTMLTextAreaElement | null>(null);
    const setRef = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        ref.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef]
    );
    const visible = useSettingsVisible();

    const fit = React.useCallback((followCaret: boolean) => {
      const el = ref.current;
      if (!el) return;
      const before = el.style.height;
      if (fitToContent(el) && followCaret && el.style.height !== before) revealCaret(el);
    }, []);

    // Typing, a pasted or loaded value, a new font size, or Settings shown again.
    React.useLayoutEffect(() => {
      fit(true);
    }, [fit, props.value, props.placeholder, className, minRows, rows, visible]);

    // A width change rewraps the text; going from display: none to shown reads
    // as a width change too (a page or tab revealed inside a visible Settings).
    React.useEffect(() => {
      const el = ref.current;
      if (!el) return;
      let lastWidth = -1;
      const observer =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver((entries) => {
              const width = entries[entries.length - 1]?.contentRect.width ?? 0;
              if (width === lastWidth) return;
              lastWidth = width;
              fit(false);
            });
      observer?.observe(el);
      const fonts = el.ownerDocument.fonts;
      let active = true;
      const onFonts = () => {
        if (active) fit(false);
      };
      fonts?.ready?.then(onFonts, () => {});
      fonts?.addEventListener?.("loadingdone", onFonts);
      return () => {
        active = false;
        observer?.disconnect();
        fonts?.removeEventListener?.("loadingdone", onFonts);
      };
    }, [fit]);

    const handleInput: React.InputEventHandler<HTMLTextAreaElement> = (event) => {
      onInput?.(event);
      // Uncontrolled: no value prop to re-run the layout effect.
      if (props.value === undefined) fit(true);
    };

    const shared = {
      ...props,
      ref: setRef,
      rows: minRows ?? rows ?? 3,
      onInput: handleInput,
      className: cn(className, "resize-none overflow-hidden"),
    };
    return unstyled ? <textarea {...shared} /> : <Textarea {...shared} />;
  }
);
AutoGrowTextarea.displayName = "AutoGrowTextarea";

export { AutoGrowTextarea };
