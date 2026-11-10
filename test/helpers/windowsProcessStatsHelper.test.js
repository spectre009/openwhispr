const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const { parseHelperOutput } = require("../../src/helpers/processInventory");

// resources/windows-process-stats.c, compiled by compile:winprocstats, run
// against this test's own process: one JSON object for --once, JSON lines for
// --stream until stdin closes, structured errors and exit codes, and never
// itself in the tree. Skipped off Windows and when the helper isn't built.

const HELPER = path.join(__dirname, "..", "..", "resources", "bin", "windows-process-stats.exe");
const available = process.platform === "win32" && fs.existsSync(HELPER);
const skip = available ? false : "needs Windows and npm run compile:winprocstats";

test("--once reports this process with memory, CPU, handles and objects", { skip }, () => {
  const result = spawnSync(HELPER, ["--once", "--root", String(process.pid)], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(result.status, 0);
  const parsed = parseHelperOutput(result.stdout.trim());
  assert.equal(parsed.ok, true);
  const { sample } = parsed;
  assert.equal(sample.root, process.pid);
  assert.ok(sample.self > 0 && sample.self !== process.pid);
  assert.ok(!sample.processes.some((row) => row.pid === sample.self), "it excludes itself");
  const self = sample.processes.find((row) => row.pid === process.pid);
  assert.ok(self, "the root is listed");
  assert.match(self.exe, /^node(\.exe)?$/i);
  assert.ok(self.ws > 1024 * 1024 && self.priv > 0 && self.peak >= self.ws);
  assert.ok(self.handles > 0 && self.threads > 0);
  assert.ok(self.gdi !== null && self.user !== null);
  assert.ok(self.cpuSec > 0);
  const startedAt = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(self.createdAt - startedAt) < 5000, "creation time in ms since epoch");
  assert.equal(sample.gpu.status, "off");
  assert.equal(self.gpuDedicated, null, "not read: null, never 0");
});

test("errors are structured and exit with their codes", { skip }, () => {
  const run = (args) =>
    spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const missing = run(["--once", "--root", "4294967290"]);
  assert.equal(missing.status, 3);
  assert.deepEqual(parseHelperOutput(missing.stdout.trim()), {
    ok: false,
    error: "root_not_found",
  });
  for (const args of [
    ["--once"],
    ["--once", "--stream", "--root", "1"],
    ["--root", "x", "--once"],
    ["--bogus"],
  ]) {
    const bad = run(args);
    assert.equal(bad.status, 2, args.join(" "));
    assert.deepEqual(parseHelperOutput(bad.stdout.trim()), { ok: false, error: "bad_args" });
  }
});

test(
  "--stream prints a line per interval and exits when stdin closes",
  { skip, timeout: 20_000 },
  async () => {
    const child = spawn(
      HELPER,
      ["--stream", "--root", String(process.pid), "--interval", "1000", "--gpu"],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }
    );
    const lines = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    await new Promise((resolve) => {
      child.stdout.on("data", (text) => {
        buffer += text;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          lines.push(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        if (lines.length >= 2) resolve();
      });
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    const endedAt = Date.now();
    child.stdin.end();
    const code = await closed;
    assert.equal(code, 0);
    assert.ok(Date.now() - endedAt < 2000, "it stops promptly");
    const samples = lines.map((line) => parseHelperOutput(line));
    assert.ok(samples.every((sample) => sample.ok));
    const [first, second] = samples.map((sample) => sample.sample);
    // Graphics counters may be missing on a VM; then they fail with a code.
    assert.ok(["ok", "failed"].includes(first.gpu.status));
    if (first.gpu.status === "ok") {
      assert.ok(Number.isInteger(first.gpu.processesWithDedicated));
      assert.equal(first.gpu.engine, "pending", "no engine rate from a single collect");
      assert.ok(["ok", "pending", "failed"].includes(second.gpu.engine));
    } else {
      assert.match(first.gpu.error, /^[a-z_]+$/);
    }
  }
);

test(
  "a stream drops a child that exits between process listings",
  { skip, timeout: 20_000 },
  async () => {
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((resolve) => sleeper.once("spawn", resolve));
    const child = spawn(HELPER, ["--stream", "--root", String(process.pid), "--interval", "1000"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const samples = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    const next = () =>
      new Promise((resolve) => {
        const onData = (text) => {
          buffer += text;
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          child.stdout.off("data", onData);
          samples.push(parseHelperOutput(buffer.slice(0, newline)).sample);
          buffer = buffer.slice(newline + 1);
          resolve(samples.at(-1));
        };
        child.stdout.on("data", onData);
        onData("");
      });
    const listed = await next();
    assert.ok(
      listed.processes.some((row) => row.pid === sleeper.pid),
      "listed at the first sample"
    );
    sleeper.kill();
    await new Promise((resolve) => sleeper.once("exit", resolve));
    const after = await next();
    assert.ok(
      !after.processes.some((row) => row.pid === sleeper.pid),
      "gone at the next, unlisted sample"
    );
    assert.ok(after.processes.some((row) => row.pid === process.pid));
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
  }
);
