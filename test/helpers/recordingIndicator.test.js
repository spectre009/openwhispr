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
  assert.deepEqual([...RECORDING_INDICATOR_STYLES], ["classic", "tinted", "solid", "beacon"]);
  for (const value of [undefined, null, "", "Beacon", "rec", 3]) {
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
