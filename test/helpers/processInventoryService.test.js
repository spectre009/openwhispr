const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MB,
  T0,
  fakeContents,
  flush,
  helperJson,
  helperRow,
  makeHarness,
  metric,
} = require("./harness/processInventory");
const { MAX_OUTPUT_BYTES } = require("../../src/helpers/processInventory");

// The process inventory's collector (helpers/processInventory.js) with a fake
// helper, clock and dictation lifecycle: one shared single-flight run with a
// deadline and bounded output, nothing while a dictation is busy (a run in
// flight is cancelled and its late result dropped), the stream only for a
// visible subscriber, a recording's phases from getAppMetrics() at its
// boundaries, and the 30-minute snapshot line from the run that feeds it.

const GPU_OK = (count = 44) => ({
  status: "ok",
  error: null,
  processesWithDedicated: count,
  engine: "off",
});

const baseRows = (overrides = {}) => [
  helperRow({ pid: 100, cpuSec: 10, ...overrides[100] }),
  helperRow({ pid: 110, createdAt: T0 - 3590_000, gdi: 12, ...overrides[110] }),
  helperRow({ pid: 120, createdAt: T0 - 3580_000, gdi: 0, user: 0, ...overrides[120] }),
  helperRow({
    pid: 130,
    ppid: 100,
    exe: "windows-key-listener.exe",
    createdAt: T0 - 3500_000,
    ...overrides[130],
  }),
];

test("the first run comes a minute after start, reads graphics memory and writes the snapshot line", async () => {
  const h = makeHarness();
  h.inventory.start();
  await h.clock.advance(59_999);
  assert.equal(h.spawned.length, 0, "nothing at startup");
  await h.clock.advance(1);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0].args, ["--once", "--root", "100", "--gpu"]);
  h.spawned[0].answer(
    helperJson({ processes: baseRows({ 110: { gpuDedicated: 326 * MB } }), gpu: GPU_OK() })
  );
  await flush();

  const lines = h.logs.filter((entry) => entry.message === "Resource snapshot");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "info");
  assert.equal(lines[0].scope, "resources");
  assert.equal(typeof lines[0].meta, "string", "one line");
  assert.doesNotMatch(lines[0].meta, /\n/);
  const meta = JSON.parse(lines[0].meta);
  assert.equal(meta.gpuProcesses, 44);
  assert.equal(meta.gpuMB, 326);
  assert.deepEqual(
    meta.roles.map((row) => row.role),
    ["main", "gpu", "dictationWindow", "keyListener"]
  );

  const { snapshot, unavailable, history } = h.inventory.get();
  assert.equal(snapshot.source, "once");
  assert.deepEqual(unavailable, []);
  assert.equal(history.samples.length, 1);
  assert.equal(
    snapshot.processes.find((row) => row.role === "keyListener").exe,
    "windows-key-listener.exe"
  );
  assert.ok(snapshot.notRunning.some((item) => item.role === "whisperServer"));

  // The next runs skip graphics memory (PDH costs ~200 ms of CPU) until the next line is due.
  for (let run = 2; run <= 6; run++) {
    await h.clock.advance(5 * 60_000);
    assert.deepEqual(h.spawned.at(-1).args, ["--once", "--root", "100"], `run ${run}`);
    h.spawned.at(-1).answer(helperJson({ processes: baseRows() }));
    await flush();
  }
  assert.equal(h.logs.filter((entry) => entry.message === "Resource snapshot").length, 1);
  const carried = h.inventory.get().snapshot;
  assert.equal(carried.gpuAt, T0 + 60_000, "graphics memory carried from the run that read it");
  assert.equal(carried.processes.find((row) => row.role === "gpu").gpuDedicated, 326 * MB);
  await h.clock.advance(5 * 60_000);
  assert.deepEqual(h.spawned.at(-1).args, ["--once", "--root", "100", "--gpu"]);
  h.spawned.at(-1).answer(helperJson({ processes: baseRows(), gpu: GPU_OK(45) }));
  await flush();
  assert.equal(h.logs.filter((entry) => entry.message === "Resource snapshot").length, 2);
  assert.equal(h.inventory.get().history.samples.length, 7, "a history point every 5 minutes");
  await h.inventory.stop();
});

test("single flight: callers share a run, a run with graphics memory serves one without", async () => {
  const h = makeHarness();
  h.inventory.start();
  const first = h.inventory.collectOnce();
  const second = h.inventory.collectOnce();
  const withGpu = h.inventory.collectOnce({ gpu: true });
  assert.equal(h.spawned.length, 1, "one helper for both");
  h.spawned[0].answer(helperJson({ processes: baseRows() }));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, "the same snapshot");
  await flush();
  assert.equal(h.spawned.length, 2, "the graphics-memory request runs after, not alongside");
  assert.ok(h.spawned[1].args.includes("--gpu"));
  const shared = h.inventory.collectOnce();
  assert.equal(h.spawned.length, 2, "a run without graphics memory joins the one with it");
  h.spawned[1].answer(helperJson({ processes: baseRows(), gpu: GPU_OK() }));
  assert.equal((await withGpu).machine.gpuProcesses, 44);
  assert.equal((await shared).machine.gpuProcesses, 44);
  await h.inventory.stop();
});

test("the deadline kills a helper that never answers; Electron's numbers stand in and late output is dropped", async () => {
  const h = makeHarness();
  h.inventory.start();
  const pending = h.inventory.collectOnce();
  await h.clock.advance(1999);
  assert.equal(h.spawned[0].killed, false);
  await h.clock.advance(1);
  assert.equal(h.spawned[0].killed, true);
  const snapshot = await pending;
  assert.equal(snapshot.source, "electron");
  assert.equal(snapshot.processes.length, 3, "Electron's processes only");
  assert.equal(snapshot.processes[0].handles, null);
  assert.deepEqual(h.inventory.get().unavailable, ["helperFailed"]);
  assert.equal(snapshot.helper.error, "timeout");
  h.spawned[0].write(helperJson({ processes: baseRows() }));
  await flush();
  assert.equal(h.inventory.get().snapshot.source, "electron", "a late answer changes nothing");
  await h.inventory.stop();
});

test("output over 256 KB stops the helper", async () => {
  const h = makeHarness();
  h.inventory.start();
  const pending = h.inventory.collectOnce();
  h.spawned[0].write("x".repeat(MAX_OUTPUT_BYTES + 1));
  const snapshot = await pending;
  assert.equal(h.spawned[0].killed, true);
  assert.equal(snapshot.helper.error, "output_too_large");
  await h.inventory.stop();
});

test("never during a dictation: a run in flight is cancelled, its result dropped, ticks deferred", async () => {
  const h = makeHarness();
  h.inventory.start();
  await h.clock.advance(60_000);
  assert.equal(h.spawned.length, 1);
  h.dictation("preparing");
  assert.equal(h.spawned[0].killed, true, "a dictation starting cancels the run");
  h.spawned[0].write(helperJson({ processes: baseRows(), gpu: GPU_OK() }));
  await flush();
  assert.equal(h.inventory.get().snapshot, null, "its result is dropped");
  assert.equal(await h.inventory.collectOnce(), null);
  await h.clock.advance(10 * 60_000);
  h.dictation("recording");
  await h.clock.advance(10 * 60_000);
  h.dictation("processing");
  assert.equal(h.spawned.length, 1, "nothing spawned while busy");
  h.dictation("idle", { delivering: true });
  assert.equal(h.spawned.length, 1, "still delivering");
  h.dictation("idle");
  assert.equal(
    h.spawned.length,
    2,
    "after delivery: the deferred run, with graphics for the log line"
  );
  assert.ok(h.spawned[1].args.includes("--gpu"));
  await h.inventory.stop();
});

test("a 5-minute run a dictation cancels runs again once the dictation is delivered", async () => {
  const h = makeHarness();
  h.inventory.start();
  await h.clock.advance(60_000);
  assert.equal(h.spawned.length, 1);
  h.dictation("recording");
  assert.equal(h.spawned[0].killed, true);
  h.dictation("idle");
  assert.equal(h.spawned.length, 2, "the cancelled run runs again");
  assert.ok(h.spawned[1].args.includes("--once"));
  await h.inventory.stop();
});

test("without the page open, nothing reads graphics memory after a dictation", async () => {
  const h = makeHarness();
  h.inventory.start();
  h.dictation("recording");
  await h.clock.advance(3_000);
  h.dictation("processing");
  h.dictation("idle");
  assert.equal(h.spawned.length, 0, "no helper run after delivery");
  const record = h.inventory.get().lastRecording;
  assert.equal(record.afterDelivery.status, "pageClosed");
  assert.ok(record.processes.every((item) => item.gpuAfterDelivery === null));
  const lines = h.logs.filter((entry) => entry.message === "Recording cost");
  assert.equal(lines.length, 1);
  const meta = JSON.parse(lines[0].meta);
  assert.equal(meta.gpuAfterDelivery, "pageClosed");
  assert.deepEqual(meta.gpuAfterDeliveryMB, {});
  await h.inventory.stop();
});

test("a recording's cost: CPU at its boundaries, graphics memory after delivery while the page is open, one debug line", async () => {
  const h = makeHarness();
  h.inventory.start();
  h.inventory.subscribe(fakeContents(9));
  assert.equal(h.spawned.length, 1, "the page's stream");
  h.dictation("preparing");
  assert.equal(h.spawned[0].stdin.ended, true, "a dictation stops the stream");
  h.dictation("recording");
  await h.clock.advance(10_000);
  h.state.metrics = [
    metric({ pid: 100, type: "Browser", created: T0 - 3600_000, cpuSec: 10.17 }),
    metric({ pid: 110, type: "GPU", created: T0 - 3590_000, cpuSec: 53.5 }),
    metric({ pid: 120, type: "Tab", created: T0 - 3580_000, cpuSec: 102.1 }),
    metric({ pid: 140, type: "Tab", created: T0 + 5_000, cpuSec: 0.05 }),
  ];
  h.state.context = {
    windows: new Map([
      [120, [{ role: "dictationWindow", visible: true, since: null }]],
      [140, [{ role: "edgeStrip", visible: true, since: null, mode: "frame" }]],
    ]),
    recording: true,
  };
  h.dictation("processing");
  await h.clock.advance(2_000);
  h.state.metrics = h.state.metrics.map((item) =>
    item.pid === 120
      ? metric({ pid: 120, type: "Tab", created: T0 - 3580_000, cpuSec: 102.3 })
      : item
  );
  h.dictation("idle", { delivering: true });
  await h.clock.advance(500);
  h.dictation("idle");
  assert.equal(h.spawned.length, 2, "the stream resumes; no run of its own");
  assert.ok(h.spawned[1].args.includes("--stream"));
  assert.equal(h.inventory.get().lastRecording.afterDelivery.status, "pending");
  h.spawned[1].write(
    helperJson({
      processes: [
        ...baseRows({ 110: { gpuDedicated: 478 * MB } }),
        helperRow({ pid: 140, ppid: 100, createdAt: T0 + 5_000, gdi: 0, user: 0 }),
      ],
      gpu: GPU_OK(46),
      mode: "stream",
    })
  );
  await flush();

  const record = h.inventory.get().lastRecording;
  assert.equal(record.recordingMs, 10_000);
  assert.equal(record.processingMs, 2_500);
  assert.equal(record.strip, "frame");
  assert.equal(record.frameWindow, "new");
  const byRole = Object.fromEntries(record.processes.map((item) => [item.role, item]));
  assert.equal(byRole.dictationWindow.recording.cpuPct, 21);
  assert.equal(byRole.gpu.recording.cpuPct, 35);
  assert.equal(byRole.edgeStrip.recording.partial, true);
  assert.equal(byRole.edgeStrip.recording.change, "appeared");
  assert.equal(byRole.dictationWindow.processing.cpuPct, 8);
  assert.equal(byRole.gpu.gpuAfterDelivery, 478 * MB);
  assert.deepEqual(record.afterDelivery.status, "ok");
  assert.equal(record.afterDelivery.gpuProcesses, 46);

  const lines = h.logs.filter((entry) => entry.message === "Recording cost");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "debug");
  const meta = JSON.parse(lines[0].meta);
  assert.deepEqual(meta.recordingCpu, { main: 1.7, gpu: 35, dictationWindow: 21, edgeStrip: 1 });
  assert.deepEqual(meta.partial, ["edgeStrip"]);
  assert.deepEqual(meta.gpuAfterDeliveryMB, { gpu: 478 });
  assert.equal(meta.frameWindow, "new");
  assert.equal(h.inventory.get().history.recordings.length, 1);
  await h.inventory.stop();
});

test("a dictation starting before the last one's graphics reading cancels it, and the line still comes", async () => {
  const h = makeHarness();
  h.inventory.start();
  h.inventory.subscribe(fakeContents(9));
  h.dictation("recording");
  await h.clock.advance(3_000);
  h.dictation("processing");
  h.dictation("idle");
  assert.equal(h.spawned.length, 2, "the stream resumed and hasn't answered yet");
  h.dictation("recording");
  assert.equal(h.spawned[1].stdin.ended, true);
  const record = h.inventory.get().lastRecording;
  assert.equal(record.afterDelivery.status, "cancelled");
  assert.equal(h.logs.filter((entry) => entry.message === "Recording cost").length, 1);
  await h.inventory.stop();
});

test("the stream: only for a visible subscriber, paused for a dictation, stopped on unsubscribe", async () => {
  const h = makeHarness();
  h.inventory.start();
  const hidden = fakeContents(1, { visible: false });
  h.inventory.subscribe(hidden);
  assert.equal(h.spawned.length, 0, "a hidden page streams nothing");
  const page = fakeContents(2);
  const first = h.inventory.subscribe(page);
  assert.equal(first.paused, false);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0].args, ["--stream", "--root", "100", "--interval", "2000", "--gpu"]);
  const stream = h.spawned[0];
  stream.write(helperJson({ processes: baseRows(), gpu: GPU_OK(), mode: "stream" }));
  await h.clock.advance(2_000);
  stream.write(
    helperJson({ processes: baseRows({ 100: { cpuSec: 10.04 } }), gpu: GPU_OK(), mode: "stream" })
  );
  const samples = h.sent.filter((entry) => entry.contents === page);
  assert.ok(samples.length >= 2);
  assert.equal(h.sent.filter((entry) => entry.contents === hidden).length, samples.length);
  const latest = samples.at(-1).payload.snapshot;
  assert.equal(latest.source, "stream");
  assert.equal(latest.cpuIntervalSec, 2);
  assert.equal(latest.processes.find((row) => row.role === "keyListener").cpuPct, 0);

  h.dictation("recording");
  assert.equal(stream.stdin.ended, true, "a dictation stops the stream");
  assert.equal(h.sent.at(-1).payload.paused, true);
  const before = h.sent.length;
  stream.write(helperJson({ processes: baseRows(), gpu: GPU_OK(), mode: "stream" }));
  assert.equal(h.sent.length, before, "a line after the stop is dropped");
  h.dictation("idle");
  assert.equal(h.spawned.length, 2, "it resumes after delivery");
  assert.equal(
    h.spawned.filter((child) => child.args.includes("--once")).length,
    0,
    "the stream answers after delivery"
  );
  h.spawned[1].write(helperJson({ processes: baseRows(), gpu: GPU_OK(47), mode: "stream" }));
  assert.equal(h.inventory.get().lastRecording.afterDelivery.status, "ok");

  h.inventory.unsubscribe(page);
  assert.equal(h.spawned[1].stdin.ended, true, "the last visible subscriber left");
  await h.inventory.stop();
});

test("a stream that goes quiet is restarted, and rests after three failures", async () => {
  const h = makeHarness();
  h.inventory.start();
  h.inventory.subscribe(fakeContents(1));
  const streams = () => h.spawned.filter((child) => child.stream);
  assert.equal(streams().length, 1);
  await h.clock.advance(8_000);
  assert.equal(streams()[0].stdin.ended, true, "stalled: stopped");
  await h.clock.advance(2_000);
  assert.equal(streams().length, 2, "restarted");
  streams()[1].write('{"v":1,"mode":"stream","error":"root_not_found"}\n');
  await h.clock.advance(10_000);
  assert.equal(streams().length, 3);
  streams()[2].exit(1);
  await h.clock.advance(4 * 60_000);
  assert.equal(streams().length, 3, "three failures in a row: resting");
  h.inventory.subscribe(fakeContents(9));
  assert.equal(streams().length, 3, "another page doesn't cut the rest short");
  assert.ok(h.inventory.get().unavailable.includes("helperFailed"));
  await h.clock.advance(60_000);
  assert.equal(streams().length, 4, "tried again after 5 minutes");
  await h.inventory.stop();
});

test("off Windows: Electron's numbers only, without spawning anything", async () => {
  const h = makeHarness({ platform: "linux" });
  h.state.metrics = h.state.metrics.map((item) => ({ ...item, memory: undefined }));
  h.inventory.start();
  const snapshot = await h.inventory.collectOnce({ gpu: true });
  assert.equal(h.spawned.length, 0);
  assert.equal(snapshot.source, "electron");
  assert.equal(snapshot.processes[0].ws, null, "no memory reported is null, never 0");
  assert.equal(snapshot.totals.ws, null);
  assert.deepEqual(h.inventory.get().unavailable, ["windowsOnly", "memory"]);
  assert.deepEqual(snapshot.notRunning, []);
  h.inventory.subscribe(fakeContents(1));
  await h.clock.advance(4_000);
  assert.ok(h.sent.length >= 3, "the page still updates from Electron's numbers");
  await h.inventory.stop();
});

test("a missing helper says so and falls back to Electron's numbers", async () => {
  const h = makeHarness({ helperPath: null });
  h.inventory.start();
  const snapshot = await h.inventory.collectOnce();
  assert.equal(h.spawned.length, 0);
  assert.equal(snapshot.helper.status, "missing");
  assert.deepEqual(h.inventory.get().unavailable, ["helperMissing"]);
  await h.inventory.stop();
});

test("get never starts a run; stop ends the stream and every timer", async () => {
  const h = makeHarness();
  h.inventory.start();
  const empty = h.inventory.get({ history: false });
  assert.equal(empty.snapshot, null);
  assert.equal(empty.history, null);
  assert.equal(empty.report, null);
  assert.equal(h.spawned.length, 0);
  h.inventory.subscribe(fakeContents(1));
  await h.inventory.stop();
  assert.equal(h.spawned[0].stdin.ended, true);
  assert.equal(h.clock.pendingCount(), 0);
  await h.clock.advance(60 * 60_000);
  assert.equal(h.spawned.length, 1);
  assert.equal(await h.inventory.collectOnce(), null);
});

test("warnings are logged from the sample that crosses a threshold", async () => {
  const h = makeHarness();
  h.inventory.start();
  const pending = h.inventory.collectOnce();
  h.spawned[0].answer(helperJson({ processes: baseRows({ 120: { user: 9100 } }) }));
  await pending;
  const warnings = h.logs.filter((entry) => entry.message === "Resource warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, "warn");
  assert.deepEqual(warnings[0].meta, {
    kind: "userObjects",
    role: "dictationWindow",
    pid: 120,
    count: 9100,
    limit: 10_000,
  });
  await h.inventory.stop();
});

test("a console host is folded into its program before history, warnings and the snapshot line see it", async () => {
  const h = makeHarness();
  h.inventory.start();
  const conhost = helperRow({
    pid: 131,
    ppid: 130,
    exe: "conhost.exe",
    createdAt: T0 - 3499_000,
    ws: 8 * MB,
    user: 5000,
  });
  await h.clock.advance(60_000);
  h.spawned[0].answer(helperJson({ processes: [...baseRows(), conhost], gpu: GPU_OK() }));
  await flush();

  const { snapshot, history } = h.inventory.get();
  const listener = snapshot.processes.find((row) => row.role === "keyListener");
  assert.deepEqual(
    listener.includes.map((part) => [part.pid, part.role]),
    [
      [130, "keyListener"],
      [131, "consoleHost"],
    ]
  );
  assert.equal(listener.ws, 108 * MB);
  assert.equal(snapshot.processes.length, 4, "no row of its own");
  assert.equal(snapshot.totals.processes, 5);
  assert.deepEqual(
    history.instances.map((entry) => entry.pid),
    [100, 110, 120, 130],
    "history follows the key listener's own instance"
  );
  assert.equal(history.instances[3].points[0].ws, 108 * MB);

  const line = JSON.parse(h.logs.find((entry) => entry.message === "Resource snapshot").meta);
  assert.deepEqual(
    line.roles.map((row) => row.role),
    ["main", "gpu", "dictationWindow", "keyListener"]
  );
  assert.equal(line.roles[3].wsMB, 108);
  assert.equal(line.processes, 5);
  const warning = h.logs.find((entry) => entry.message === "Resource warning");
  assert.deepEqual(warning.meta, {
    kind: "userObjects",
    role: "keyListener",
    pid: 130,
    count: 5060,
    limit: 10_000,
  });
  await h.inventory.stop();
});
