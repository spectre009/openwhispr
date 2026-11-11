const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// GPU fallback warnings go to the app's log, which keeps warnings at its
// default level (Problems only) and writes nothing when logging is Off, so
// they need no file of their own (#2554).

const modulePath = require.resolve("../../src/helpers/gpuFallbackLog");
const originalLoad = Module._load;
const warned = [];
let userDataDir;

Module._load = function loadWithStubs(request, parent, isMain) {
  if (parent?.filename === modulePath && request === "electron") {
    return { app: { getPath: () => userDataDir, getVersion: () => "9.9.9" } };
  }
  if (parent?.filename === modulePath && request === "./debugLogger") {
    return { warn: (message, meta) => warned.push({ message, meta }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function launch() {
  delete require.cache[modulePath];
  return require(modulePath);
}

test.beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-fallback-log-"));
  warned.length = 0;
});

test.afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test.after(() => {
  Module._load = originalLoad;
});

test("a warning goes to the app's log and nowhere else", () => {
  const { warnGpuFallback } = launch();
  warnGpuFallback("Whisper CUDA enabled but cannot be used", { reason: "pack needs update" });

  assert.deepEqual(warned, [
    { message: "Whisper CUDA enabled but cannot be used", meta: { reason: "pack needs update" } },
  ]);
  assert.equal(fs.existsSync(path.join(userDataDir, "logs", "gpu-fallback.log")), false);
});
