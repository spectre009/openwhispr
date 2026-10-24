/**
 * Landing on a setting after a search: wait for its anchor to mount and show
 * (sections and sub-tabs mount lazily and switch in an effect), open what
 * hides it, scroll it into view and flash it. Never changes a setting. Kept
 * free of React so it runs against happy-dom in tests.
 */

import { SETTINGS_LAYER_ATTRIBUTE } from "../settingsLayerPolicy";

export const SETTING_ANCHOR_ATTRIBUTE = "data-setting-id";
/** Set on the element while it flashes; the live check and tests read it. */
export const SEARCH_FLASH_ATTRIBUTE = "data-search-flash";
/** The Settings content scroller; tall anchors align to its top instead of its middle. */
export const SETTINGS_SCROLLER_ATTRIBUTE = "data-settings-scroller";
/** A collapsible trigger inside an anchor that reveal may open. */
export const SETTING_EXPAND_ATTRIBUTE = "data-setting-expand";
/**
 * A page's body (SettingsPage keeps visited pages mounted, hidden): an anchor
 * on another page is a copy, e.g. the VAD block on Recognition and Live Recording.
 */
export const SETTINGS_PAGE_ATTRIBUTE = "data-settings-page-id";

export const SEARCH_FLASH_MS = 1600;
const WAIT_TIMEOUT_MS = 2000;
// How long a visible parent waits for the row itself (it may render a frame later).
const FALLBACK_GRACE_MS = 350;
const POLL_INTERVAL_MS = 50;

export interface RevealSettingOptions {
  /** Where anchors are looked up: the Settings layer. */
  root: ParentNode;
  anchor: string;
  /** A stable parent to land on while `anchor` doesn't render in the current state. */
  fallbackAnchor?: string;
  /** Anchors of collapsed blocks to open first (`<details>` or an `aria-expanded` trigger). */
  expand?: readonly string[];
  /**
   * The page the setting lives on. Visited pages stay mounted (hidden), so an
   * anchor inside another page's body doesn't count, even while that page is
   * still the one showing.
   */
  page?: string;
  signal?: AbortSignal;
  reducedMotion?: boolean;
  timeoutMs?: number;
  fallbackGraceMs?: number;
  flashMs?: number;
  /** Replaced in tests, where nothing has layout. */
  isVisible?: (element: Element) => boolean;
  now?: () => number;
}

export function isElementVisible(element: Element): boolean {
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === "function") return check.call(element);
  return element.getClientRects().length > 0;
}

const escapeAttributeValue = (value: string) => value.replace(/["\\]/g, "\\$&");

/** The first rendered, visible element carrying this anchor (on `page`, if it's on a page). */
export function findVisibleAnchor(
  root: ParentNode,
  anchor: string,
  isVisible: (element: Element) => boolean = isElementVisible,
  page?: string
): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>(
    `[${SETTING_ANCHOR_ATTRIBUTE}="${escapeAttributeValue(anchor)}"]`
  );
  for (const candidate of Array.from(candidates)) {
    if (page) {
      const body = candidate.closest(`[${SETTINGS_PAGE_ATTRIBUTE}]`);
      if (body && body.getAttribute(SETTINGS_PAGE_ATTRIBUTE) !== page) continue;
    }
    if (candidate.isConnected && isVisible(candidate)) return candidate;
  }
  return null;
}

/** Opens a collapsed block the way a user would; true once it is open. */
function expandBlock(element: HTMLElement): boolean {
  if (element.tagName === "DETAILS") {
    const details = element as HTMLDetailsElement;
    if (!details.open) details.open = true;
    return true;
  }
  const trigger =
    element.getAttribute("aria-expanded") === "false"
      ? element
      : element.querySelector<HTMLElement>(`[${SETTING_EXPAND_ATTRIBUTE}][aria-expanded="false"]`);
  trigger?.click();
  return true;
}

let flashing: { element: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

/** Highlights an element for a moment; a new flash ends the previous one. */
export function flashElement(element: HTMLElement, durationMs = SEARCH_FLASH_MS): void {
  if (flashing) {
    clearTimeout(flashing.timer);
    flashing.element.removeAttribute(SEARCH_FLASH_ATTRIBUTE);
    flashing = null;
  }
  // Re-reading layout restarts the animation when the same element flashes again.
  void element.offsetWidth;
  element.setAttribute(SEARCH_FLASH_ATTRIBUTE, "");
  const timer = setTimeout(() => {
    element.removeAttribute(SEARCH_FLASH_ATTRIBUTE);
    if (flashing?.element === element) flashing = null;
  }, durationMs);
  flashing = { element, timer };
}

function scrollToAnchor(element: HTMLElement, reducedMotion: boolean): void {
  const scroller = element.closest(`[${SETTINGS_SCROLLER_ATTRIBUTE}]`);
  const viewport = scroller?.clientHeight || window.innerHeight || 0;
  const height = element.getBoundingClientRect?.().height ?? 0;
  // A block taller than most of the view starts at its top rather than its middle.
  const block: ScrollLogicalPosition = viewport && height > viewport * 0.7 ? "start" : "center";
  element.scrollIntoView?.({ block, behavior: reducedMotion ? "auto" : "smooth" });
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Resolves with the element it landed on (the anchor, or its fallback parent
 * when the row isn't rendered in this state), or null when neither showed up
 * in time or the reveal was aborted (a newer navigation).
 */
export function revealSetting(options: RevealSettingOptions): Promise<HTMLElement | null> {
  const {
    root,
    anchor,
    fallbackAnchor,
    expand = [],
    page,
    signal,
    reducedMotion = prefersReducedMotion(),
    timeoutMs = WAIT_TIMEOUT_MS,
    fallbackGraceMs = FALLBACK_GRACE_MS,
    flashMs = SEARCH_FLASH_MS,
    isVisible = isElementVisible,
    now = () => Date.now(),
  } = options;

  return new Promise((resolve) => {
    const startedAt = now();
    let fallbackSince: number | null = null;
    let done = false;
    const expanded = new Set<string>();
    let observer: MutationObserver | null = null;
    let frame: number | null = null;
    const interval = setInterval(() => check(), POLL_INTERVAL_MS);

    const finish = (element: HTMLElement | null) => {
      if (done) return;
      done = true;
      observer?.disconnect();
      clearInterval(interval);
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", onAbort);
      if (element) {
        scrollToAnchor(element, reducedMotion);
        flashElement(element, flashMs);
      }
      resolve(element);
    };
    const onAbort = () => finish(null);

    function check() {
      if (done) return;
      if (signal?.aborted) return finish(null);
      for (const id of expand) {
        if (expanded.has(id)) continue;
        const block = findVisibleAnchor(root, id, isVisible, page);
        if (block && expandBlock(block)) expanded.add(id);
      }
      const target = findVisibleAnchor(root, anchor, isVisible, page);
      if (target) return finish(target);
      const elapsed = now() - startedAt;
      if (fallbackAnchor) {
        const parent = findVisibleAnchor(root, fallbackAnchor, isVisible, page);
        if (parent) {
          fallbackSince ??= now();
          if (now() - fallbackSince >= fallbackGraceMs || elapsed >= timeoutMs) {
            return finish(parent);
          }
        } else {
          fallbackSince = null;
        }
      }
      if (elapsed >= timeoutMs) finish(null);
    }

    const tick = () => {
      frame = null;
      check();
      if (!done && typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(tick);
      }
    };

    signal?.addEventListener("abort", onAbort);
    if (typeof MutationObserver === "function") {
      observer = new MutationObserver(() => check());
      observer.observe(root as Node, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          "class",
          "hidden",
          "style",
          "open",
          "aria-expanded",
          SETTING_ANCHOR_ATTRIBUTE,
        ],
      });
    }
    tick();
  });
}

// Controls that act on arrow keys: landing focus there would let the next key change a setting.
const ARROW_KEY_CONTROL =
  'input, select, textarea, button, [contenteditable="true"], [role="slider"], [role="radio"], [role="radiogroup"], [role="switch"], [role="tablist"], [role="tab"], [role="listbox"], [role="combobox"], [role="menu"], [role="spinbutton"]';

/**
 * After a search lands on a setting, focus goes to it when nothing in Settings
 * has focus (a palette result leaves focus on the body): the flashed row
 * itself (focusable only until it loses focus), or the layer root when the
 * row is a control. Focus the user put in Settings (the search field) stays.
 */
export function focusLandedSetting(layer: HTMLElement, element: HTMLElement | null): void {
  const doc = layer.ownerDocument;
  const active = doc.activeElement;
  if (layer.hasAttribute("inert")) return;
  if (active && active !== doc.body && active !== layer) {
    // In Settings already, or in a dialog over it that hands focus back itself.
    if (layer.contains(active)) return;
    if (
      active.closest('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')
    )
      return;
  }
  const target =
    element && element.isConnected && layer.contains(element) && !element.matches(ARROW_KEY_CONTROL)
      ? element
      : layer;
  if (target !== layer && !target.hasAttribute("tabindex")) {
    target.setAttribute("tabindex", "-1");
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
  }
  target.focus({ preventScroll: true });
}

/**
 * The palette closing after a Settings result: Radix would return focus to
 * what had it before the palette (often inert under Settings now, which leaves
 * focus on the body). Focus lands in Settings instead: on the flashed row if
 * the reveal already finished, else the layer root (the reveal moves it on).
 */
export function focusSettingsAfterPalette(doc: Document): void {
  const layer = doc.querySelector<HTMLElement>(`[${SETTINGS_LAYER_ATTRIBUTE}]`);
  if (!layer) return;
  const active = doc.activeElement;
  if (active && active !== doc.body && active !== layer && layer.contains(active)) return;
  focusLandedSetting(layer, layer.querySelector<HTMLElement>(`[${SEARCH_FLASH_ATTRIBUTE}]`));
}
