// How the floating icon shows that the microphone is live: a style and a
// color. Pure and dependency-free so main (via require), the renderer and the
// tests share one parser and one set of contrast rules.

export const DEFAULT_RECORDING_INDICATOR_STYLE = "classic";
export const RECORDING_INDICATOR_STYLES = Object.freeze(["classic", "tinted", "solid", "beacon"]);

export function normalizeRecordingIndicatorStyle(value) {
  return RECORDING_INDICATOR_STYLES.includes(value) ? value : DEFAULT_RECORDING_INDICATOR_STYLE;
}

export const DEFAULT_RECORDING_INDICATOR_COLOR = "red";
export const RECORDING_INDICATOR_COLORS = Object.freeze({
  red: "#ef3b3b",
  coral: "#ff6a3d",
  amber: "#f5a524",
  green: "#22c55e",
  cyan: "#06b6d4",
  blue: "#3466e2",
  purple: "#8b5cf6",
  pink: "#ec4899",
});

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** A curated color id, or a custom color stored as lowercase "#rrggbb". */
export function normalizeRecordingIndicatorColor(value) {
  if (typeof value !== "string") return DEFAULT_RECORDING_INDICATOR_COLOR;
  const color = value.trim().toLowerCase();
  if (Object.hasOwn(RECORDING_INDICATOR_COLORS, color) || HEX_COLOR.test(color)) return color;
  return DEFAULT_RECORDING_INDICATOR_COLOR;
}

export function resolveRecordingAccent(value) {
  const color = normalizeRecordingIndicatorColor(value);
  return RECORDING_INDICATOR_COLORS[color] ?? color;
}

function channels(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

export function relativeLuminance(hex) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// WCAG's minimum for meaningful graphics (the icon and the waveform bars).
export const MIN_GRAPHIC_CONTRAST = 3;
const LIGHT_GLYPH = "#ffffff";
const DARK_GLYPH = "#111317";

/**
 * Glyphs on a filled accent: white wherever it reaches 3:1, which keeps the
 * familiar white-on-red look; dark otherwise. One of the two always clears
 * 3:1 — a color too light for white has luminance above 0.3, which gives the
 * dark glyph at least 6:1 — so no custom color can make the icon unreadable.
 */
export function pickForeground(accent) {
  return contrastRatio(accent, LIGHT_GLYPH) >= MIN_GRAPHIC_CONTRAST ? LIGHT_GLYPH : DARK_GLYPH;
}

// The pill's surface-1 in each theme (index.css; the dark one is
// oklch(0.25 0.007 260) in sRGB). Tinted draws accent glyphs on it.
export const RECORDING_SURFACES = Object.freeze({ dark: "#202225", light: "#fafafa" });

function mix(from, to, amount) {
  const a = channels(from);
  const b = channels(to);
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
}

/**
 * Tinted draws the accent itself on the pill's surface, so an accent too
 * close to that surface (navy on charcoal, pale yellow on white) is lightened
 * or darkened in small steps until it reaches 3:1.
 */
export function resolveTintedAccent(accent, surface) {
  if (contrastRatio(accent, surface) >= MIN_GRAPHIC_CONTRAST) return accent;
  const target = relativeLuminance(surface) < 0.5 ? "#ffffff" : "#000000";
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(accent, target, step / 20);
    if (contrastRatio(candidate, surface) >= MIN_GRAPHIC_CONTRAST) return candidate;
  }
  return target;
}

/** The custom properties every styled surface (pill, cancel skin) reads. */
export function recordingIndicatorCssVars(color) {
  const accent = resolveRecordingAccent(color);
  return {
    "--recording-accent": accent,
    "--recording-on-accent": pickForeground(accent),
    "--recording-tint-dark": resolveTintedAccent(accent, RECORDING_SURFACES.dark),
    "--recording-tint-light": resolveTintedAccent(accent, RECORDING_SURFACES.light),
  };
}

/**
 * The style a surface should paint, or null for today's chrome. Only a pill
 * that owns its own chrome while recording takes a style: inside the Live
 * Transcript panel, and while the cancel button's fused skin draws the
 * surface, the pill stays headless — the skin then asks with no flags set.
 */
export function resolveRecordingChromeStyle({
  style,
  state,
  integratedWithPanel = false,
  liquidFused = false,
}) {
  const normalized = normalizeRecordingIndicatorStyle(style);
  if (normalized === "classic" || state !== "recording") return null;
  if (integratedWithPanel || liquidFused) return null;
  return normalized;
}
