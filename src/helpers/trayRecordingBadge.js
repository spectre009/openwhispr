// Draws the recording dot onto a tray icon bitmap. Pure: works on the raw
// pixels Electron's nativeImage.toBitmap() returns (BGRA, premultiplied alpha,
// row-major, no padding), so main can rebuild the badged icon at each size and
// tests can check the pixels.

const RING = Object.freeze([17, 19, 23]);

function parseHex(hex) {
  const n = Number.parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Source-over in premultiplied space: out = src + dst * (1 - srcAlpha).
function blend(buffer, index, rgb, alpha) {
  if (alpha <= 0) return;
  const keep = 1 - alpha;
  buffer[index] = Math.round(rgb[2] * alpha + buffer[index] * keep);
  buffer[index + 1] = Math.round(rgb[1] * alpha + buffer[index + 1] * keep);
  buffer[index + 2] = Math.round(rgb[0] * alpha + buffer[index + 2] * keep);
  buffer[index + 3] = Math.round(255 * alpha + buffer[index + 3] * keep);
}

// How much of the pixel at (x, y) lies inside a circle, from 4x4 samples.
function coverage(x, y, cx, cy, radius) {
  let inside = 0;
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      const dx = x + (sx + 0.5) / 4 - cx;
      const dy = y + (sy + 0.5) / 4 - cy;
      if (dx * dx + dy * dy <= radius * radius) inside += 1;
    }
  }
  return inside / 16;
}

/**
 * Returns a copy of `bitmap` (size × size) with a dot in `accent` at the
 * bottom right: about 45% of the icon wide, inside a dark ring so it reads on
 * a light or dark taskbar and on the icon itself.
 */
function drawRecordingBadge(bitmap, size, accent) {
  if (!Buffer.isBuffer(bitmap) || bitmap.length !== size * size * 4) {
    throw new Error(`expected a ${size}x${size} BGRA bitmap`);
  }
  const out = Buffer.from(bitmap);
  const color = parseHex(accent);
  const outer = size * 0.24;
  const ring = Math.max(1, size / 16);
  const cx = size - outer;
  const cy = size - outer;
  const top = Math.max(0, Math.floor(cy - outer - 1));
  const left = Math.max(0, Math.floor(cx - outer - 1));
  for (let y = top; y < size; y += 1) {
    for (let x = left; x < size; x += 1) {
      const index = (y * size + x) * 4;
      blend(out, index, RING, coverage(x, y, cx, cy, outer));
      blend(out, index, color, coverage(x, y, cx, cy, outer - ring));
    }
  }
  return out;
}

/** "0:07", "12:34", "1:02:03": the recording time shown in the tray tooltip. */
function formatRecordingElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
  return `${minutes}:${seconds}`;
}

module.exports = { drawRecordingBadge, formatRecordingElapsed };
