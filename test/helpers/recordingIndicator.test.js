const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/recordingIndicator.js");

// Deterministic so a failure names the same color on every run.
function seededColors(count) {
  let seed = 0x2f6e2b1;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  return Array.from(
    { length: count },
    () => `#${(next() & 0xffffff).toString(16).padStart(6, "0")}`
  );
}

test("styles normalize to the known set, defaulting to classic", async () => {
  const { normalizeRecordingIndicatorStyle, RECORDING_INDICATOR_STYLES } = await load();
  for (const style of RECORDING_INDICATOR_STYLES) {
    assert.equal(normalizeRecordingIndicatorStyle(style), style);
  }
  assert.deepEqual(
    [...RECORDING_INDICATOR_STYLES],
    ["classic", "tinted", "solid", "beacon", "rec"]
  );
  for (const value of [undefined, null, "", "Beacon", "REC", 3]) {
    assert.equal(normalizeRecordingIndicatorStyle(value), "classic");
  }
});

test("colors keep curated ids and lowercase custom hex, defaulting to red", async () => {
  const { normalizeRecordingIndicatorColor, resolveRecordingAccent, RECORDING_INDICATOR_COLORS } =
    await load();
  for (const id of Object.keys(RECORDING_INDICATOR_COLORS)) {
    assert.equal(normalizeRecordingIndicatorColor(id), id);
    assert.equal(resolveRecordingAccent(id), RECORDING_INDICATOR_COLORS[id]);
  }
  assert.equal(normalizeRecordingIndicatorColor(" #A1B2C3 "), "#a1b2c3");
  assert.equal(resolveRecordingAccent("#a1b2c3"), "#a1b2c3");
  for (const value of [
    undefined,
    42,
    "",
    "#abc",
    "#gggggg",
    "rgb(1,2,3)",
    "constructor",
    "toString",
  ]) {
    assert.equal(normalizeRecordingIndicatorColor(value), "red");
  }
  assert.equal(resolveRecordingAccent("nonsense"), RECORDING_INDICATOR_COLORS.red);
});

test("contrast ratio matches WCAG reference points", async () => {
  const { contrastRatio } = await load();
  assert.equal(Number(contrastRatio("#000000", "#ffffff").toFixed(2)), 21);
  assert.equal(Number(contrastRatio("#777777", "#ffffff").toFixed(2)), 4.48);
  assert.equal(contrastRatio("#3466e2", "#3466e2"), 1);
});

test("filled accents always get a foreground with at least 3:1 contrast", async () => {
  const { pickForeground, contrastRatio, RECORDING_INDICATOR_COLORS, MIN_GRAPHIC_CONTRAST } =
    await load();
  const colors = [
    ...Object.values(RECORDING_INDICATOR_COLORS),
    ...seededColors(500),
    "#000000",
    "#ffffff",
    "#ffff00",
    "#00ffff",
    "#767676",
  ];
  for (const accent of colors) {
    const fg = pickForeground(accent);
    assert.ok(
      contrastRatio(accent, fg) >= MIN_GRAPHIC_CONTRAST,
      `${accent} with ${fg} is ${contrastRatio(accent, fg).toFixed(2)}:1`
    );
  }
});

test("the default red keeps white glyphs, amber and green switch to dark ones", async () => {
  const { pickForeground, RECORDING_INDICATOR_COLORS } = await load();
  assert.equal(pickForeground(RECORDING_INDICATOR_COLORS.red), "#ffffff");
  assert.equal(pickForeground(RECORDING_INDICATOR_COLORS.blue), "#ffffff");
  assert.equal(pickForeground(RECORDING_INDICATOR_COLORS.amber), "#111317");
  assert.equal(pickForeground(RECORDING_INDICATOR_COLORS.green), "#111317");
});

test("tinted accents reach 3:1 on both theme surfaces", async () => {
  const { resolveTintedAccent, contrastRatio, RECORDING_SURFACES, RECORDING_INDICATOR_COLORS } =
    await load();
  const colors = [
    ...Object.values(RECORDING_INDICATOR_COLORS),
    ...seededColors(500),
    RECORDING_SURFACES.dark,
    RECORDING_SURFACES.light,
    "#000080",
    "#ffff99",
  ];
  for (const surface of Object.values(RECORDING_SURFACES)) {
    for (const accent of colors) {
      const tint = resolveTintedAccent(accent, surface);
      assert.ok(
        contrastRatio(tint, surface) >= 3,
        `${accent} on ${surface} became ${tint} at ${contrastRatio(tint, surface).toFixed(2)}:1`
      );
    }
  }
});

test("tinted accents that already contrast are left alone", async () => {
  const { resolveTintedAccent, RECORDING_SURFACES, RECORDING_INDICATOR_COLORS } = await load();
  assert.equal(
    resolveTintedAccent(RECORDING_INDICATOR_COLORS.red, RECORDING_SURFACES.dark),
    RECORDING_INDICATOR_COLORS.red
  );
  assert.notEqual(resolveTintedAccent("#000080", RECORDING_SURFACES.dark), "#000080");
});

test("CSS vars carry the accent, its foreground and both tints", async () => {
  const { recordingIndicatorCssVars } = await load();
  assert.deepEqual(recordingIndicatorCssVars("red"), {
    "--recording-accent": "#ef3b3b",
    "--recording-on-accent": "#ffffff",
    "--recording-tint-dark": "#ef3b3b",
    "--recording-tint-light": "#ef3b3b",
  });
  const amber = recordingIndicatorCssVars("amber");
  assert.equal(amber["--recording-on-accent"], "#111317");
  assert.notEqual(amber["--recording-tint-light"], "#f5a524");
  assert.equal(recordingIndicatorCssVars("garbage")["--recording-accent"], "#ef3b3b");
});

test("only a recording pill that owns its chrome takes a style", async () => {
  const { resolveRecordingChromeStyle } = await load();
  assert.equal(resolveRecordingChromeStyle({ style: "beacon", state: "recording" }), "beacon");
  assert.equal(resolveRecordingChromeStyle({ style: "tinted", state: "recording" }), "tinted");
  assert.equal(resolveRecordingChromeStyle({ style: "classic", state: "recording" }), null);
  assert.equal(resolveRecordingChromeStyle({ style: "bogus", state: "recording" }), null);
  for (const state of ["idle", "hover", "processing", "thinking", "unavailable"]) {
    assert.equal(resolveRecordingChromeStyle({ style: "solid", state }), null, state);
  }
  assert.equal(
    resolveRecordingChromeStyle({ style: "solid", state: "recording", integratedWithPanel: true }),
    null
  );
  assert.equal(
    resolveRecordingChromeStyle({ style: "solid", state: "recording", liquidFused: true }),
    null
  );
});

test("edge strip settings normalize to the known values, defaulting to off on the pill's monitor", async () => {
  const {
    normalizeRecordingEdgeStrip,
    normalizeRecordingEdgeStripDisplays,
    normalizeRecordingIndicatorSettings,
  } = await load();
  for (const mode of ["off", "short", "full"])
    assert.equal(normalizeRecordingEdgeStrip(mode), mode);
  for (const value of [undefined, null, "", "top", "Short", 1]) {
    assert.equal(normalizeRecordingEdgeStrip(value), "off");
  }
  for (const displays of ["pill", "all"]) {
    assert.equal(normalizeRecordingEdgeStripDisplays(displays), displays);
  }
  for (const value of [undefined, "primary", "ALL", 0]) {
    assert.equal(normalizeRecordingEdgeStripDisplays(value), "pill");
  }
  const DEFAULTS = {
    color: "red",
    strip: "off",
    displays: "pill",
    tray: false,
    colorByMode: false,
    assistantColor: "purple",
    translationColor: "cyan",
    reminderMinutes: 0,
  };
  assert.deepEqual(normalizeRecordingIndicatorSettings(null), DEFAULTS);
  assert.deepEqual(
    normalizeRecordingIndicatorSettings({
      style: "beacon",
      color: "#ABCDEF",
      strip: "short",
      displays: "all",
      extra: 1,
    }),
    { ...DEFAULTS, color: "#abcdef", strip: "short", displays: "all" }
  );
});

test("the strip hugs the top of the whole display, short and centered or full width", async () => {
  const { resolveEdgeStripBounds, EDGE_STRIP_HEIGHT } = await load();
  // The 57" primary: 25% of 5672 is 1418, clamped to 1400.
  const g95 = {
    bounds: { x: 0, y: 0, width: 5672, height: 1596 },
    workArea: { x: 0, y: 0, width: 5672, height: 1548 },
  };
  assert.deepEqual(resolveEdgeStripBounds(g95, "short"), {
    x: 2136,
    y: 0,
    width: 1400,
    height: EDGE_STRIP_HEIGHT,
  });
  assert.deepEqual(resolveEdgeStripBounds(g95, "full"), {
    x: 0,
    y: 0,
    width: 5672,
    height: EDGE_STRIP_HEIGHT,
  });
  // A monitor above and left of the primary keeps its negative origin.
  const upper = { bounds: { x: -16, y: -1596, width: 2836, height: 1596 } };
  assert.deepEqual(resolveEdgeStripBounds(upper, "short"), {
    x: -16 + 1064,
    y: -1596,
    width: 709,
    height: 8,
  });
  assert.deepEqual(resolveEdgeStripBounds(upper, "full"), {
    x: -16,
    y: -1596,
    width: 2836,
    height: 8,
  });
  // A small display gets at least 480 DIP, never more than its own width.
  assert.equal(
    resolveEdgeStripBounds({ bounds: { x: 0, y: 0, width: 1280, height: 800 } }, "short").width,
    480
  );
  assert.deepEqual(
    resolveEdgeStripBounds({ bounds: { x: 10, y: 20, width: 400, height: 300 } }, "short"),
    {
      x: 10,
      y: 20,
      width: 400,
      height: 8,
    }
  );
  assert.equal(resolveEdgeStripBounds(g95, "off"), null);
  assert.equal(resolveEdgeStripBounds(null, "short"), null);
});

test("a frame covers the display's work area, above the taskbar", async () => {
  const { resolveEdgeStripBounds } = await load();
  const g95 = {
    bounds: { x: 0, y: 0, width: 5672, height: 1596 },
    workArea: { x: 0, y: 0, width: 5672, height: 1548 },
  };
  assert.deepEqual(resolveEdgeStripBounds(g95, "frame"), { x: 0, y: 0, width: 5672, height: 1548 });
  const upper = { bounds: { x: -16, y: -1596, width: 2836, height: 1596 } };
  assert.deepEqual(
    resolveEdgeStripBounds(upper, "frame"),
    upper.bounds,
    "no work area: the bounds"
  );
});

test("the tray setting reaches main only when it is exactly true", async () => {
  const { normalizeRecordingIndicatorSettings } = await load();
  assert.equal(normalizeRecordingIndicatorSettings({ tray: true }).tray, true);
  for (const tray of [undefined, "true", 1, false]) {
    assert.equal(normalizeRecordingIndicatorSettings({ tray }).tray, false);
  }
  assert.equal(normalizeRecordingIndicatorSettings({ strip: "frame" }).strip, "frame");
});

test("color by mode picks the assistant and translation colors, never dictation's", async () => {
  const { resolveRecordingModeColor, normalizeRecordingModeColor } = await load();
  const on = {
    color: "green",
    colorByMode: true,
    assistantColor: "pink",
    translationColor: "#0A0B0C",
  };
  assert.equal(resolveRecordingModeColor(on, "assistant"), "pink");
  assert.equal(resolveRecordingModeColor(on, "translation"), "#0a0b0c");
  assert.equal(resolveRecordingModeColor(on, "dictation"), "green");
  assert.equal(resolveRecordingModeColor(on, null), "green");
  assert.equal(resolveRecordingModeColor({ ...on, colorByMode: "true" }, "assistant"), "green");
  assert.equal(
    resolveRecordingModeColor({ color: "green", colorByMode: true }, "assistant"),
    "purple",
    "an unset mode color falls back to its default"
  );
  assert.equal(resolveRecordingModeColor(undefined, "assistant"), "red");
  assert.equal(normalizeRecordingModeColor("bogus", "translation"), "cyan");
  assert.equal(normalizeRecordingModeColor(" Amber ", "assistant"), "amber");
});

test("reminder intervals are off or 2, 3, 5 or 10 minutes", async () => {
  const { normalizeRecordingReminderMinutes, RECORDING_REMINDER_MINUTES } = await load();
  assert.deepEqual([...RECORDING_REMINDER_MINUTES], [0, 2, 3, 5, 10]);
  for (const minutes of [2, "3", 5, "10"]) {
    assert.equal(normalizeRecordingReminderMinutes(minutes), Number(minutes));
  }
  for (const value of [undefined, null, "", 1, 4, -2, "x", 2.5]) {
    assert.equal(normalizeRecordingReminderMinutes(value), 0);
  }
});

test("the next reminder lands on the next whole interval from the start", async () => {
  const { nextRecordingReminderDelay } = await load();
  const start = 1_000_000;
  const at = (elapsed, minutes = 3) =>
    nextRecordingReminderDelay({ startedAt: start, now: start + elapsed, minutes });
  assert.equal(at(0), 180_000);
  assert.equal(at(179_999), 1);
  assert.equal(at(180_000), 180_000, "exactly on a mark schedules the following one");
  assert.equal(at(1_000_000), 80_000, "marks missed during sleep are skipped, not replayed");
  assert.equal(at(-5000), 180_000, "a clock behind the start waits a whole interval");
  assert.equal(at(1000, 0), null);
  assert.equal(nextRecordingReminderDelay({ startedAt: null, now: start, minutes: 3 }), null);
});

test("the pill's elapsed time reads m:ss, then h + minutes past an hour", async () => {
  const { formatPillElapsed } = await load();
  assert.equal(formatPillElapsed(0), "0:00");
  assert.equal(formatPillElapsed(7_900), "0:07");
  assert.equal(formatPillElapsed(65_000), "1:05");
  assert.equal(formatPillElapsed(3_599_999), "59:59");
  assert.equal(formatPillElapsed(3_600_000), "1h00");
  assert.equal(formatPillElapsed(3_720_000), "1h02");
  assert.equal(formatPillElapsed(-5), "0:00");
  assert.equal(formatPillElapsed(Number.NaN), "0:00");
});

test("a reported start time is kept only when it is near the present", async () => {
  const { resolveRecordingStartedAt } = await load();
  const now = 5_000_000;
  assert.equal(resolveRecordingStartedAt(now - 2000, now), now - 2000);
  assert.equal(resolveRecordingStartedAt(now - 10_000, now), now - 10_000);
  assert.equal(resolveRecordingStartedAt(now - 10_001, now), now);
  assert.equal(resolveRecordingStartedAt(now + 800, now), now, "never in the future");
  assert.equal(resolveRecordingStartedAt(now + 1001, now), now);
  for (const value of [undefined, null, Number.NaN, Infinity, "x"]) {
    assert.equal(resolveRecordingStartedAt(value, now), now);
  }
  assert.equal(resolveRecordingStartedAt(String(now - 500), now), now - 500);
});
