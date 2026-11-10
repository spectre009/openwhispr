const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../..");

// These helpers call FreeConsole() when OpenWhispr starts them; an upstream
// prebuilt binary doesn't, so each build compiles the source first and keeps the
// download only for a host without a compiler.
for (const [name, script] of [
  ["windows-mic-listener", "build-windows-mic-listener.js"],
  ["windows-system-audio-helper", "build-windows-system-audio-helper.js"],
  ["windows-fast-paste", "build-windows-fast-paste.js"],
]) {
  test(`${name} builds current source before using a released fallback`, () => {
    const source = fs.readFileSync(path.join(root, "scripts", script), "utf8");
    const main = source.slice(source.indexOf("async function main()"));
    const compileIndex = main.indexOf("tryCompile()");
    const downloadIndex = main.indexOf("tryDownload()");

    assert.notEqual(compileIndex, -1, "main() should try local compilation");
    assert.notEqual(downloadIndex, -1, "main() should retain the download fallback");
    assert.ok(compileIndex < downloadIndex, "local compilation should run first");
    assert.match(source, new RegExp(`resources", "${name}\\.c"`));
  });
}

test("compile:native builds the mic listener and the system audio helper", () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(scripts["compile:winmic"], "node scripts/build-windows-mic-listener.js");
  assert.equal(scripts["compile:winsysaudio"], "node scripts/build-windows-system-audio-helper.js");
  const steps = scripts["compile:native"].split("&&").map((step) => step.trim());
  assert.ok(steps.includes("npm run compile:winmic"));
  assert.ok(steps.includes("npm run compile:winsysaudio"));
});

test("every Windows helper we own releases its console only when piped", () => {
  for (const name of [
    "windows-key-listener",
    "windows-mic-listener",
    "windows-process-stats",
    "windows-text-monitor",
    "windows-fast-paste",
    "windows-system-audio-helper",
  ]) {
    const source = fs.readFileSync(path.join(root, "resources", `${name}.c`), "utf8");
    assert.match(
      source,
      /GetFileType\(GetStdHandle\(STD_OUTPUT_HANDLE\)\) != FILE_TYPE_CHAR\)\s*\{?\s*FreeConsole\(\);/,
      name
    );
    assert.doesNotMatch(source, /AllocConsole|AttachConsole|GetConsoleWindow/, name);
  }
});
