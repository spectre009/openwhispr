const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { verifyWindowsProcessStats } = require("../../scripts/afterPack");

// The process stats helper has no prebuilt download and compile:winprocstats
// only warns without a compiler, so afterPack is what stops a Windows package
// from shipping without it.

function makeBinDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("passes when the Windows process stats helper is bundled", (t) => {
  const dir = makeBinDir(t);
  fs.writeFileSync(path.join(dir, "windows-process-stats.exe"), "");
  assert.doesNotThrow(() => verifyWindowsProcessStats(dir));
});

test("fails when the Windows process stats helper is missing", (t) => {
  const dir = makeBinDir(t);
  assert.throws(
    () => verifyWindowsProcessStats(dir),
    /missing .*windows-process-stats\.exe.*compile:winprocstats/
  );
});
