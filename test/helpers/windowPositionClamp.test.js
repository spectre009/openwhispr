const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveHorizontalWindowDirection,
  WindowPositionUtil,
} = require("../../src/helpers/windowConfig");

// A 1512px laptop screen with a wider monitor mounted above it: x beyond 1512
// is dead space at the laptop's y range, even though the desktop spans further.
const LAPTOP = { workArea: { x: 0, y: 0, width: 1512, height: 949 } };

test("voice direction follows the overlay's actual half of the display", () => {
  assert.equal(
    resolveHorizontalWindowDirection({ x: 4, width: 96 }, LAPTOP, "bottom-right"),
    "left"
  );
  assert.equal(
    resolveHorizontalWindowDirection({ x: 1412, width: 96 }, LAPTOP, "bottom-left"),
    "right"
  );
});

test("center and unavailable geometry retain the established preference fallback", () => {
  assert.equal(
    resolveHorizontalWindowDirection({ x: 708, width: 96 }, LAPTOP, "bottom-left"),
    "left"
  );
  assert.equal(
    resolveHorizontalWindowDirection({ x: 708, width: 96 }, LAPTOP, "bottom-right"),
    "right"
  );
  assert.equal(resolveHorizontalWindowDirection(null, null, "bottom-left"), "left");
  assert.equal(resolveHorizontalWindowDirection(null, null, "bottom-right"), "right");
  assert.equal(resolveHorizontalWindowDirection({ x: 4, width: 96 }, LAPTOP, "center"), "right");
});

test("pulls a window parked beyond a display edge back into its work area", () => {
  const stranded = { x: 1472, y: 33, width: 96, height: 96 };
  assert.deepEqual(WindowPositionUtil.clampToWorkArea(stranded, LAPTOP), { x: 1416, y: 33 });
});

test("leaves a window already inside the work area untouched", () => {
  const inside = { x: 1412, y: 849, width: 96, height: 96 };
  assert.deepEqual(WindowPositionUtil.clampToWorkArea(inside, LAPTOP), { x: 1412, y: 849 });
});

// A monitor mounted above (or left of) the primary display has a negative origin
// in Electron's coordinate space. Flooring a computed position at zero lands the
// window on a row that display doesn't cover — beside the primary screen, where
// nothing is drawn and the overlay looks like it vanished.
const MONITOR_ABOVE = { workArea: { x: -451, y: -1440, width: 2560, height: 1440 } };

test("the panel lands on a monitor mounted above the primary display", () => {
  const position = WindowPositionUtil.getMainWindowPosition(MONITOR_ABOVE, null, "bottom-right");

  assert.deepEqual(position, { x: 1897, y: -124, width: 208, height: 120 });
  assert.ok(position.y < 0, "a display above the primary one needs a negative y");
});

test("every panel anchor stays inside a negative-origin display", () => {
  for (const anchor of ["bottom-right", "bottom-left", "center"]) {
    const { x, y, width, height } = WindowPositionUtil.getMainWindowPosition(
      MONITOR_ABOVE,
      null,
      anchor
    );
    const { workArea } = MONITOR_ABOVE;
    assert.ok(x >= workArea.x && x + width <= workArea.x + workArea.width, `${anchor} x`);
    assert.ok(y >= workArea.y && y + height <= workArea.y + workArea.height, `${anchor} y`);
  }
});

test("the meeting prompt also lands on a monitor above the primary display", () => {
  const { x, y, width, height } = WindowPositionUtil.getNotificationPosition(MONITOR_ABOVE);
  const { workArea } = MONITOR_ABOVE;

  assert.ok(y < 0, "the prompt must not be floored onto the primary display's rows");
  assert.ok(x >= workArea.x && x + width <= workArea.x + workArea.width);
  assert.ok(y >= workArea.y && y + height <= workArea.y + workArea.height);
});

test("a window larger than its display is pinned to the work area origin", () => {
  const tiny = { workArea: { x: 0, y: 25, width: 800, height: 600 } };
  const position = WindowPositionUtil.getMainWindowPosition(tiny, { width: 900, height: 700 });

  assert.equal(position.x, 0);
  assert.equal(position.y, 25);
});

test("clamps against negative-origin displays and falls back to bounds", () => {
  const external = { bounds: { x: -451, y: -1440, width: 2560, height: 1440 } };
  assert.deepEqual(
    WindowPositionUtil.clampToWorkArea({ x: -900, y: -2000, width: 400, height: 500 }, external),
    { x: -451, y: -1440 }
  );
});

// The 57" primary display under two 32" monitors, as Electron reports it.
const ULTRAWIDE = { workArea: { x: 0, y: 0, width: 5672, height: 1548 } };
const UPPER_LEFT = { workArea: { x: -16, y: -1596, width: 2836, height: 1596 } };

test("the middle row centers the resting pill on the work area", () => {
  // Window bottom = work-area center (774) + 32 (12px dock inset + half the 40px pill).
  assert.deepEqual(WindowPositionUtil.getMainWindowPosition(ULTRAWIDE, null, "middle-center"), {
    x: 2732,
    y: 686,
    width: 208,
    height: 120,
  });
  assert.deepEqual(WindowPositionUtil.getMainWindowPosition(ULTRAWIDE, null, "middle-left"), {
    x: 4,
    y: 686,
    width: 208,
    height: 120,
  });
  assert.deepEqual(WindowPositionUtil.getMainWindowPosition(ULTRAWIDE, null, "middle-right"), {
    x: 5460,
    y: 686,
    width: 208,
    height: 120,
  });
  assert.deepEqual(WindowPositionUtil.getMainWindowPosition(UPPER_LEFT, null, "middle-center"), {
    x: 1298,
    y: -886,
    width: 208,
    height: 120,
  });
});

test("the middle row keeps its bottom edge for any window height", () => {
  const grown = WindowPositionUtil.getMainWindowPosition(
    ULTRAWIDE,
    { width: 466, height: 562 },
    "middle-center"
  );
  assert.equal(grown.y + grown.height, 806);
});

test("legacy bottom positions are unchanged", () => {
  assert.deepEqual(WindowPositionUtil.getMainWindowPosition(ULTRAWIDE, null, "center"), {
    x: 2732,
    y: 1424,
    width: 208,
    height: 120,
  });
  assert.deepEqual(WindowPositionUtil.getMainWindowPosition(ULTRAWIDE, null, "bottom-left"), {
    x: 4,
    y: 1424,
    width: 208,
    height: 120,
  });
});

test("a grown surface keeps the resting pill's anchor and stays on its display", () => {
  const base = { x: 2732, y: 686, width: 208, height: 120 };
  assert.deepEqual(
    WindowPositionUtil.anchorToRestingBounds(
      base,
      { width: 400, height: 500 },
      "middle-center",
      ULTRAWIDE
    ),
    { x: 2636, y: 306, width: 400, height: 500 }
  );
  const right = { x: 5460, y: 686, width: 208, height: 120 };
  assert.deepEqual(
    WindowPositionUtil.anchorToRestingBounds(
      right,
      { width: 400, height: 500 },
      "middle-right",
      ULTRAWIDE
    ),
    { x: 5268, y: 306, width: 400, height: 500 }
  );
  // Taller than the space above the pill: clamped to the top of the work area.
  assert.deepEqual(
    WindowPositionUtil.anchorToRestingBounds(
      base,
      { width: 466, height: 900 },
      "middle-center",
      ULTRAWIDE
    ),
    { x: 2603, y: 0, width: 466, height: 900 }
  );
});

test("middle positions take the same voice direction as their column", () => {
  assert.equal(resolveHorizontalWindowDirection(null, null, "middle-left"), "left");
  assert.equal(resolveHorizontalWindowDirection(null, null, "middle-right"), "right");
  assert.equal(
    resolveHorizontalWindowDirection({ x: 4, width: 96 }, LAPTOP, "middle-center"),
    "right"
  );
});

test("the top row docks the window at the top of the work area", () => {
  assert.deepEqual(WindowPositionUtil.getMainWindowPosition(ULTRAWIDE, null, "top-center"), {
    x: 2732,
    y: 4,
    width: 208,
    height: 120,
  });
  assert.deepEqual(WindowPositionUtil.getMainWindowPosition(ULTRAWIDE, null, "top-left"), {
    x: 4,
    y: 4,
    width: 208,
    height: 120,
  });
  assert.deepEqual(WindowPositionUtil.getMainWindowPosition(UPPER_LEFT, null, "top-right"), {
    x: 2608,
    y: -1592,
    width: 208,
    height: 120,
  });
  // A grown window keeps the top edge, so surfaces open downward.
  const grown = WindowPositionUtil.getMainWindowPosition(
    ULTRAWIDE,
    { width: 466, height: 562 },
    "top-center"
  );
  assert.equal(grown.y, 4);
});

test("a grown surface under a top-row pill keeps its top edge", () => {
  const base = { x: 2732, y: 4, width: 208, height: 120 };
  assert.deepEqual(
    WindowPositionUtil.anchorToRestingBounds(
      base,
      { width: 400, height: 500 },
      "top-center",
      ULTRAWIDE
    ),
    { x: 2636, y: 4, width: 400, height: 500 }
  );
  assert.deepEqual(
    WindowPositionUtil.anchorToRestingBounds(
      { x: 5460, y: 4, width: 208, height: 120 },
      { width: 400, height: 500 },
      "top-right",
      ULTRAWIDE
    ),
    { x: 5268, y: 4, width: 400, height: 500 }
  );
});
