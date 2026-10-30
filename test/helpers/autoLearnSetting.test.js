const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyAutoLearnSetting,
  normalizeAutoLearnMode,
  DEFAULT_AUTO_LEARN_MODE,
} = require("../../src/helpers/autoLearnSetting");

test("the default mode is Suggest", () => {
  assert.equal(DEFAULT_AUTO_LEARN_MODE, "suggest");
});

test("reports a change between modes", () => {
  assert.deepEqual(applyAutoLearnSetting("suggest", "off"), { changed: true, mode: "off" });
  assert.deepEqual(applyAutoLearnSetting("off", "add"), { changed: true, mode: "add" });
  assert.deepEqual(applyAutoLearnSetting("add", "suggest"), { changed: true, mode: "suggest" });
});

test("is idempotent when the mode is unchanged — #1080 dual-window mount sync", () => {
  for (const mode of ["suggest", "add", "off"]) {
    assert.deepEqual(applyAutoLearnSetting(mode, mode), { changed: false, mode });
  }
});

test("an older window's boolean maps as the migration does: on is Suggest, off is Off", () => {
  assert.deepEqual(applyAutoLearnSetting("off", true), { changed: true, mode: "suggest" });
  assert.deepEqual(applyAutoLearnSetting("suggest", false), { changed: true, mode: "off" });
});

test("an unknown value reads as Suggest, never as on-ish truthiness", () => {
  for (const value of [undefined, null, 1, 0, "on", "OFF", "", {}]) {
    assert.equal(normalizeAutoLearnMode(value), "suggest", String(value));
  }
  assert.deepEqual(applyAutoLearnSetting("off", "bogus"), { changed: true, mode: "suggest" });
});
