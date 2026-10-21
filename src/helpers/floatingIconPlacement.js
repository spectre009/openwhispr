// Where the floating dictation icon rests: which display, and where on it.
// Pure and dependency-free so main (via require), the renderer and the tests
// share one parser.

// Positions on a grid of rows ("top", "middle", "bottom") and columns ("left",
// "center", "right"), spelled "<row>-<column>". Bottom-center keeps its legacy
// spelling "center", the value upstream builds store and read.
export const DEFAULT_PANEL_POSITION = "bottom-right";
export const PANEL_POSITIONS = Object.freeze([
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "center",
  "bottom-right",
]);

export function normalizePanelPosition(value) {
  if (value === "bottom-center") return "center";
  return PANEL_POSITIONS.includes(value) ? value : DEFAULT_PANEL_POSITION;
}

export function parsePanelPosition(value) {
  const position = normalizePanelPosition(value);
  if (position === "center") return { vertical: "bottom", horizontal: "center" };
  const [vertical, horizontal] = position.split("-");
  return { vertical, horizontal };
}

// The horizontal anchor in the spelling the resize math and the renderer's
// resize mask already use: the pill's side of the window, or its center.
export function panelHorizontalAnchor(value) {
  const { horizontal } = parsePanelPosition(value);
  return horizontal === "center" ? "center" : `bottom-${horizontal}`;
}

// The top row docks the pill against the window's top edge and grows surfaces
// downward; the other rows dock it against the bottom edge and grow upward.
export function panelDocksAtTop(value) {
  return parsePanelPosition(value).vertical === "top";
}

// Distance from the native window's docked edge to the resting pill's center:
// the 12px dock inset (.voice-pill-position-* in dictation-panel.css) plus half
// of the 40px idle pill (VOICE_PILL_FOOTPRINT.idle in voicePillPresentation.js).
// The middle row puts this point on the work area's center.
export const PILL_RESTING_CENTER_OFFSET = 32;
const PILL_RESTING_HALF_WIDTH = 20;
const PILL_DOCK_INSET = 12;

// The resting pill's center inside window bounds. It identifies the display a
// window belongs to: unlike an edge point, it never lies on a neighbouring
// display while the window is grown or clamped.
export function pillRestingPoint(bounds, value) {
  const { horizontal } = parsePanelPosition(value);
  const inset = PILL_DOCK_INSET + PILL_RESTING_HALF_WIDTH;
  const x =
    horizontal === "left"
      ? bounds.x + inset
      : horizontal === "right"
        ? bounds.x + bounds.width - inset
        : bounds.x + bounds.width / 2;
  const y = panelDocksAtTop(value)
    ? bounds.y + PILL_RESTING_CENTER_OFFSET
    : bounds.y + bounds.height - PILL_RESTING_CENTER_OFFSET;
  return { x: Math.round(x), y: Math.round(y) };
}

// Which display hosts the icon: the one under the mouse cursor (the original
// behaviour), the primary display, or one specific display by Electron id.
export const FLOATING_ICON_DISPLAY_CURSOR = "cursor";
export const FLOATING_ICON_DISPLAY_PRIMARY = "primary";

export function normalizeFloatingIconDisplay(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (text === FLOATING_ICON_DISPLAY_PRIMARY) return FLOATING_ICON_DISPLAY_PRIMARY;
  if (typeof text === "string" && /^-?\d+$/.test(text)) return text;
  return FLOATING_ICON_DISPLAY_CURSOR;
}

export function isFloatingIconDisplayLocked(value) {
  return normalizeFloatingIconDisplay(value) !== FLOATING_ICON_DISPLAY_CURSOR;
}

/**
 * Resolve a locked display preference against the connected displays.
 *
 * Windows display ids hash the adapter and output, so they survive layout
 * changes but not necessarily reboots or driver resets; the remembered label
 * (the monitor's EDID name) guards an id that now names a different monitor
 * and finds the monitor again when its id changed. Anything unresolvable
 * falls back to the primary display without forgetting the preference.
 *
 * Returns null for the cursor preference, which the caller resolves itself.
 */
export function resolvePreferredDisplay({ preference, label, displays, primaryDisplay }) {
  const normalized = normalizeFloatingIconDisplay(preference);
  if (normalized === FLOATING_ICON_DISPLAY_CURSOR) return null;
  if (normalized === FLOATING_ICON_DISPLAY_PRIMARY) {
    return { display: primaryDisplay, matchedBy: "primary" };
  }

  const list = Array.isArray(displays) ? displays : [];
  const wantedLabel = typeof label === "string" ? label.trim() : "";
  const byId = list.find((display) => String(display.id) === normalized);
  const byIdLabel = typeof byId?.label === "string" ? byId.label.trim() : "";
  if (byId && (!wantedLabel || !byIdLabel || byIdLabel === wantedLabel)) {
    return { display: byId, matchedBy: "id" };
  }

  if (wantedLabel) {
    const byLabel = list.filter(
      (display) => typeof display.label === "string" && display.label.trim() === wantedLabel
    );
    if (byLabel.length === 1) return { display: byLabel[0], matchedBy: "label" };
  }

  return { display: primaryDisplay, matchedBy: "fallback" };
}

export function isPointInWorkArea(point, display) {
  const area = display?.workArea || display?.bounds;
  if (!area || !point) return false;
  return (
    point.x >= area.x &&
    point.x < area.x + area.width &&
    point.y >= area.y &&
    point.y < area.y + area.height
  );
}

// Where a monitor sits relative to the primary one ("above-left", "right", …),
// for naming it in Settings: monitor names alone ("M32P10") rarely say which
// physical screen they are, and Electron's DIP sizes give no exact resolution.
// Null when it overlaps the primary display's middle.
export function relativeDisplayDirection(bounds, primaryBounds) {
  const vertical =
    bounds.y + bounds.height <= primaryBounds.y
      ? "above"
      : bounds.y >= primaryBounds.y + primaryBounds.height
        ? "below"
        : null;
  const centerX = bounds.x + bounds.width / 2;
  const horizontal =
    centerX < primaryBounds.x + primaryBounds.width / 3
      ? "left"
      : centerX > primaryBounds.x + (primaryBounds.width * 2) / 3
        ? "right"
        : null;
  return [vertical, horizontal].filter(Boolean).join("-") || null;
}
