// One "Dictation start visuals" line per dictation start: when the pill and
// the recording's strip or frame were on screen, in ms after the key press,
// with the graphics mode. Main begins one per press (windowManager, keyed by
// the press trace's pressId, the same as the renderer's "Dictation start
// trace"); the dictation window reports its painted frames and the edge strip
// its show. Nothing here waits: marks are recorded as they arrive, and the
// line is written once everything expected is in, or after the deadline with
// what arrived. A press cancelled before anything showed writes nothing.

const START_VISUALS_DEADLINE_MS = 3000;
const SLOW_PILL_MS = 500;
const SLOW_FRAME_MS = 1000;
// A renderer mark further than this from the press is stale or bogus.
const MAX_MARK_SKEW_MS = 10_000;
const STRIP_MODES = new Set(["short", "full", "frame"]);
const RENDERER_MARKS = { pillPainted: "pillPainted", pillSettled: "pillSettled" };

/** Marks still expected: the pill always; once recording, its entrance's end and the strip. */
function missingStartVisuals(start) {
  const missing = [];
  if (start.pillPainted === undefined) missing.push("pill");
  if (start.recording !== undefined) {
    if (start.expectSettle && start.pillSettled === undefined) missing.push("settle");
    if (start.strip !== "off" && start.frame === undefined) missing.push("frame");
  }
  return missing;
}

function isStartVisualsComplete(start) {
  return start.recording !== undefined && missingStartVisuals(start).length === 0;
}

/**
 * Why a start's visuals were slow: the pill later than SLOW_PILL_MS after the
 * key, the strip later than SLOW_FRAME_MS (a mark still missing counts from
 * now; the strip only once the recording started), or a software fallback.
 */
function startVisualsSlowness(start, { now, graphics }) {
  const slow = [];
  if ((start.pillPainted ?? now) - start.keyAt > SLOW_PILL_MS) slow.push("pill");
  if (start.strip !== "off" && (start.frame !== undefined || start.recording !== undefined)) {
    if ((start.frame ?? now) - start.keyAt > SLOW_FRAME_MS) slow.push("frame");
  }
  if (graphics?.mode === "software" && graphics?.reason === "fallback") slow.push("graphics");
  return slow;
}

/** The line's fields: ms after the key press, no text and no window titles. */
function summarizeStartVisuals(start, { now, graphics, outcome }) {
  const after = (at) =>
    Number.isFinite(at) ? Math.max(0, Math.round(at - start.keyAt)) : undefined;
  const stripOn = start.strip !== "off";
  const missing = missingStartVisuals(start);
  const fields = {
    pressId: start.pressId,
    keyTimeSource: start.keyTimeSource,
    pillShownAfterKeyMs: after(start.pillPainted),
    pillWasVisible: start.pillWasVisible,
    pillSettledAfterKeyMs: after(start.pillSettled),
    recordingAfterKeyMs: after(start.recording),
    frameShownAfterKeyMs: after(start.frame),
    frameWindow: stripOn ? start.frameWindow : "none",
    strip: stripOn ? start.strip : undefined,
    graphics: graphics?.mode ?? "unknown",
    graphicsReason: graphics?.reason ?? undefined,
    outcome,
    missing: missing.length > 0 ? missing : undefined,
    loggedAfterKeyMs: after(now),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/**
 * Collects one start at a time. `begin` at the press; `mark` for the dictation
 * window's frames; `recordingStarted` / `recordingEnded` / `cancelled` from the
 * lifecycle; `frameShown` from the edge strip. Each call is cheap and never
 * throws into the caller.
 */
class StartVisualsTracker {
  constructor({
    logger,
    getGraphics = () => null,
    now = Date.now,
    timers = { setTimeout, clearTimeout },
    deadlineMs = START_VISUALS_DEADLINE_MS,
  } = {}) {
    this._logger = logger;
    this._getGraphics = getGraphics;
    this._now = now;
    this._timers = timers;
    this._deadlineMs = deadlineMs;
    this._start = null;
    this._timer = null;
  }

  /** The press being collected, or null. */
  get pendingPressId() {
    return this._start?.pressId ?? null;
  }

  /**
   * A press that may start a recording. `strip` is the mode a recording would
   * show ("off" when none); `expectSettle` whether the dictation window runs
   * the pill's entrance. A press still pending is finished first.
   */
  begin({ pressId, keyAt, keyTimeSource, pillWasVisible, strip, expectSettle = true }) {
    this._finish("superseded");
    if (!Number.isFinite(pressId)) return;
    const now = this._now();
    this._start = {
      pressId,
      keyAt: Number.isFinite(keyAt) && Math.abs(now - keyAt) <= MAX_MARK_SKEW_MS ? keyAt : now,
      keyTimeSource: keyTimeSource === "os" ? "os" : "main",
      pillWasVisible: pillWasVisible === true,
      strip: STRIP_MODES.has(strip) ? strip : "off",
      expectSettle: expectSettle !== false,
    };
    this._timer = this._timers.setTimeout(() => {
      this._timer = null;
      this._finish("timeout");
    }, this._deadlineMs);
    this._timer?.unref?.();
  }

  /** A frame the dictation window painted: "pillPainted" or "pillSettled". */
  mark(pressId, kind, at) {
    const start = this._start;
    const field = Object.hasOwn(RENDERER_MARKS, kind) ? RENDERER_MARKS[kind] : null;
    if (!start || !field || pressId !== start.pressId || start[field] !== undefined) return false;
    if (!Number.isFinite(at) || Math.abs(at - start.keyAt) > MAX_MARK_SKEW_MS) return false;
    start[field] = at;
    this._finishIfComplete();
    return true;
  }

  recordingStarted(at = this._now()) {
    const start = this._start;
    if (!start || start.recording !== undefined) return;
    start.recording = at;
    this._finishIfComplete();
  }

  /** The recording's strip is on screen: `window` "new" or "reused". */
  frameShown({ window, at } = {}) {
    const start = this._start;
    if (!start || start.recording === undefined || start.frame !== undefined) return;
    start.frame = Number.isFinite(at) ? at : this._now();
    start.frameWindow = window === "new" ? "new" : "reused";
    this._finishIfComplete();
  }

  /** The recording ended before every mark arrived: written with what did. */
  recordingEnded() {
    if (this._start?.recording !== undefined) this._finish("stopped");
  }

  /** The press ended without a recording; dropped if nothing showed yet. */
  cancelled() {
    if (this._start && this._start.recording === undefined) this._finish("cancelled");
  }

  dispose() {
    this._clearTimer();
    this._start = null;
  }

  _finishIfComplete() {
    if (this._start && isStartVisualsComplete(this._start)) this._finish("complete");
  }

  _clearTimer() {
    if (this._timer) this._timers.clearTimeout(this._timer);
    this._timer = null;
  }

  _finish(outcome) {
    const start = this._start;
    if (!start) return null;
    this._start = null;
    this._clearTimer();
    if (outcome === "cancelled" && start.pillPainted === undefined && start.frame === undefined) {
      return null;
    }
    const now = this._now();
    let graphics = null;
    try {
      graphics = this._getGraphics?.() ?? null;
    } catch {
      graphics = null;
    }
    const fields = summarizeStartVisuals(start, { now, graphics, outcome });
    const slow = startVisualsSlowness(start, { now, graphics });
    try {
      if (slow.length > 0) {
        this._logger?.warn?.("Slow dictation start visuals", { ...fields, slow }, "window");
      } else {
        this._logger?.info?.("Dictation start visuals", fields, "window");
      }
    } catch {
      // logging never breaks a dictation
    }
    return { fields, slow };
  }
}

module.exports = {
  MAX_MARK_SKEW_MS,
  SLOW_FRAME_MS,
  SLOW_PILL_MS,
  START_VISUALS_DEADLINE_MS,
  StartVisualsTracker,
  isStartVisualsComplete,
  missingStartVisuals,
  startVisualsSlowness,
  summarizeStartVisuals,
};
