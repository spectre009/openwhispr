const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/floatingIconPlacement.js");

const G95 = {
  id: 1217155111,
  label: "Odyssey G95NC",
  bounds: { x: 0, y: 0, width: 5672, height: 1596 },
  workArea: { x: 0, y: 0, width: 5672, height: 1548 },
};
const PG = {
  id: 2373425187,
  label: "PG32UQXR",
  bounds: { x: -16, y: -1596, width: 2836, height: 1596 },
  workArea: { x: -16, y: -1596, width: 2836, height: 1596 },
};
const M32 = {
  id: 1564834236,
  label: "M32P10",
  bounds: { x: 2820, y: -1602, width: 2837, height: 1596 },
  workArea: { x: 2820, y: -1602, width: 2837, height: 1596 },
};
const DISPLAYS = [PG, G95, M32];

test("positions normalize to the supported grid, keeping the legacy bottom-center spelling", async () => {
  const { normalizePanelPosition, PANEL_POSITIONS } = await load();

  assert.equal(PANEL_POSITIONS.length, 9);
  for (const position of PANEL_POSITIONS) assert.equal(normalizePanelPosition(position), position);
  assert.equal(normalizePanelPosition("bottom-center"), "center");
  assert.equal(normalizePanelPosition("top-middle"), "bottom-right");
  assert.equal(normalizePanelPosition(undefined), "bottom-right");
  assert.equal(normalizePanelPosition("nonsense"), "bottom-right");
});

test("only the top row docks against the window's top edge", async () => {
  const { panelDocksAtTop } = await load();

  assert.equal(panelDocksAtTop("top-left"), true);
  assert.equal(panelDocksAtTop("top-center"), true);
  assert.equal(panelDocksAtTop("middle-center"), false);
  assert.equal(panelDocksAtTop("center"), false);
  assert.equal(panelDocksAtTop("bogus"), false);
});

test("positions parse into a row and a column", async () => {
  const { parsePanelPosition, panelHorizontalAnchor } = await load();

  assert.deepEqual(parsePanelPosition("center"), { vertical: "bottom", horizontal: "center" });
  assert.deepEqual(parsePanelPosition("middle-center"), {
    vertical: "middle",
    horizontal: "center",
  });
  assert.deepEqual(parsePanelPosition("middle-left"), { vertical: "middle", horizontal: "left" });
  assert.deepEqual(parsePanelPosition("bottom-right"), {
    vertical: "bottom",
    horizontal: "right",
  });
  assert.equal(panelHorizontalAnchor("middle-center"), "center");
  assert.equal(panelHorizontalAnchor("middle-left"), "bottom-left");
  assert.equal(panelHorizontalAnchor("center"), "center");
});

test("the resting pill offset matches the rendered pill and its dock inset", async () => {
  const { PILL_RESTING_CENTER_OFFSET } = await load();
  const { VOICE_PILL_FOOTPRINT } = await import("../../src/helpers/voicePillPresentation.js");
  const DOCK_INSET_PX = 12; // .voice-pill-position-* bottom: 0.75rem

  assert.equal(PILL_RESTING_CENTER_OFFSET, DOCK_INSET_PX + VOICE_PILL_FOOTPRINT.idle.height / 2);
});

test("the resting pill point lies on the pill's side of the window", async () => {
  const { pillRestingPoint } = await load();
  const bounds = { x: 100, y: 200, width: 400, height: 500 };

  assert.deepEqual(pillRestingPoint(bounds, "bottom-left"), { x: 132, y: 668 });
  assert.deepEqual(pillRestingPoint(bounds, "bottom-right"), { x: 468, y: 668 });
  assert.deepEqual(pillRestingPoint(bounds, "middle-center"), { x: 300, y: 668 });
  assert.deepEqual(pillRestingPoint(bounds, "top-right"), { x: 468, y: 232 });
});

test("display preferences normalize to cursor, primary or an id", async () => {
  const { normalizeFloatingIconDisplay, isFloatingIconDisplayLocked } = await load();

  assert.equal(normalizeFloatingIconDisplay("primary"), "primary");
  assert.equal(normalizeFloatingIconDisplay("1217155111"), "1217155111");
  assert.equal(normalizeFloatingIconDisplay(1217155111), "1217155111");
  assert.equal(normalizeFloatingIconDisplay("cursor"), "cursor");
  assert.equal(normalizeFloatingIconDisplay("left monitor"), "cursor");
  assert.equal(normalizeFloatingIconDisplay(undefined), "cursor");
  assert.equal(isFloatingIconDisplayLocked("cursor"), false);
  assert.equal(isFloatingIconDisplayLocked("primary"), true);
  assert.equal(isFloatingIconDisplayLocked("1217155111"), true);
});

test("a locked display resolves by id, falling back to its label, then the primary", async () => {
  const { resolvePreferredDisplay } = await load();
  const resolve = (preference, label, displays = DISPLAYS) =>
    resolvePreferredDisplay({ preference, label, displays, primaryDisplay: G95 });

  assert.equal(resolve("cursor", ""), null);
  assert.deepEqual(resolve("primary", ""), { display: G95, matchedBy: "primary" });
  assert.deepEqual(resolve(String(PG.id), "PG32UQXR"), { display: PG, matchedBy: "id" });
  assert.deepEqual(resolve(String(PG.id), ""), { display: PG, matchedBy: "id" });

  // The id changed (reboot, driver reset): the label finds the monitor again.
  assert.deepEqual(resolve("42", "M32P10"), { display: M32, matchedBy: "label" });

  // The id now names a different monitor: the label wins.
  assert.deepEqual(resolve(String(PG.id), "M32P10"), { display: M32, matchedBy: "label" });

  // Disconnected, or a label shared by two monitors: the primary display.
  assert.deepEqual(resolve(String(PG.id), "PG32UQXR", [G95, M32]), {
    display: G95,
    matchedBy: "fallback",
  });
  const twins = [G95, { ...M32, id: 7 }, { ...M32, id: 8 }];
  assert.deepEqual(resolve("42", "M32P10", twins), { display: G95, matchedBy: "fallback" });
});

test("an id match is kept when the display reports no label to contradict it", async () => {
  const { resolvePreferredDisplay } = await load();
  const unnamed = { ...PG, label: "" };

  assert.deepEqual(
    resolvePreferredDisplay({
      preference: String(PG.id),
      label: "PG32UQXR",
      displays: [unnamed, G95],
      primaryDisplay: G95,
    }),
    { display: unnamed, matchedBy: "id" }
  );
});

test("work-area hit testing excludes the far edges", async () => {
  const { isPointInWorkArea } = await load();

  assert.equal(isPointInWorkArea({ x: 0, y: 0 }, G95), true);
  assert.equal(isPointInWorkArea({ x: 5671, y: 1547 }, G95), true);
  assert.equal(isPointInWorkArea({ x: 5672, y: 100 }, G95), false);
  assert.equal(isPointInWorkArea({ x: 100, y: -1 }, G95), false);
  assert.equal(isPointInWorkArea({ x: 100, y: -1 }, PG), true);
});

test("monitors are described by where they sit relative to the primary display", async () => {
  const { relativeDisplayDirection } = await load();
  const primary = G95.bounds;

  assert.equal(relativeDisplayDirection(PG.bounds, primary), "above-left");
  assert.equal(relativeDisplayDirection(M32.bounds, primary), "above-right");
  assert.equal(
    relativeDisplayDirection({ x: 1800, y: -1440, width: 2560, height: 1440 }, primary),
    "above"
  );
  assert.equal(
    relativeDisplayDirection({ x: -1920, y: 0, width: 1920, height: 1080 }, primary),
    "left"
  );
  assert.equal(
    relativeDisplayDirection({ x: 5672, y: 900, width: 1920, height: 1080 }, primary),
    "right"
  );
  assert.equal(
    relativeDisplayDirection({ x: 2000, y: 1596, width: 1920, height: 1080 }, primary),
    "below"
  );
  assert.equal(relativeDisplayDirection(primary, primary), null);
});
