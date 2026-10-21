const test = require("node:test");
const assert = require("node:assert/strict");

const {
  drawRecordingBadge,
  formatRecordingElapsed,
} = require("../../src/helpers/trayRecordingBadge");

const pixel = (buffer, size, x, y) => {
  const i = (y * size + x) * 4;
  return { b: buffer[i], g: buffer[i + 1], r: buffer[i + 2], a: buffer[i + 3] };
};

for (const size of [16, 20, 24, 28, 32]) {
  test(`a ${size}px icon gets an opaque accent dot at the bottom right, inside a dark ring`, () => {
    const empty = Buffer.alloc(size * size * 4);
    const out = drawRecordingBadge(empty, size, "#ef3b3b");
    const center = Math.round(size - size * 0.24);
    assert.deepEqual(pixel(out, size, center, center), { b: 59, g: 59, r: 239, a: 255 });
    // The dot's outer edge is the ring's color, not the accent.
    const edge = pixel(out, size, center, size - 1);
    assert.ok(edge.r < 120, `ring at the bottom edge, got ${JSON.stringify(edge)}`);
    // The top left of the icon is untouched.
    assert.deepEqual(pixel(out, size, 1, 1), { b: 0, g: 0, r: 0, a: 0 });
    assert.equal(
      empty.every((v) => v === 0),
      true,
      "the input is not modified"
    );
  });
}

test("partially covered pixels stay premultiplied (no channel above alpha)", () => {
  const size = 24;
  const out = drawRecordingBadge(Buffer.alloc(size * size * 4), size, "#ffffff");
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    assert.ok(out[i] <= a && out[i + 1] <= a && out[i + 2] <= a, `pixel ${i / 4}`);
  }
});

test("the dot is drawn over the icon, not through it", () => {
  const size = 16;
  const opaqueWhite = Buffer.alloc(size * size * 4, 255);
  const out = drawRecordingBadge(opaqueWhite, size, "#22c55e");
  const c = Math.round(size - size * 0.24);
  assert.deepEqual(pixel(out, size, c, c), { b: 0x5e, g: 0xc5, r: 0x22, a: 255 });
  assert.deepEqual(pixel(out, size, 0, 0), { b: 255, g: 255, r: 255, a: 255 });
});

test("a bitmap of the wrong size is refused", () => {
  assert.throws(() => drawRecordingBadge(Buffer.alloc(10), 16, "#ef3b3b"));
});

test("elapsed time reads m:ss, then h:mm:ss", () => {
  assert.equal(formatRecordingElapsed(0), "0:00");
  assert.equal(formatRecordingElapsed(7_900), "0:07");
  assert.equal(formatRecordingElapsed(754_000), "12:34");
  assert.equal(formatRecordingElapsed(3_723_000), "1:02:03");
  assert.equal(formatRecordingElapsed(-5), "0:00");
  assert.equal(formatRecordingElapsed(undefined), "0:00");
});
