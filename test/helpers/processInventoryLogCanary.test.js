const test = require("node:test");
const assert = require("node:assert/strict");

const {
  T0,
  fakeContents,
  flush,
  helperJson,
  helperRow,
  makeHarness,
} = require("./harness/processInventory");
const {
  collectWindowRoles,
  createProcessInventory,
} = require("../../src/helpers/processInventory");

// Canary: nothing the helper, the OS or the user controls reaches a log line
// or the report Copy diagnostics prints: exe paths and names of other
// programs, command lines, window titles, hotkeys, raw helper errors and
// stderr. A marker rides through every field it could hide in, on the
// success and every failure path (bad JSON, a helper error, a timeout, too
// much output, a stream that exits, a spawn that throws).

const MARKER = "zqxcanary";

function everythingLogged(h) {
  return h.logs.map((entry) => `${entry.message} ${JSON.stringify(entry.meta)}`).join("\n");
}

const tainted = () => [
  helperRow({ pid: 100, commandLine: `OpenWhispr.exe --${MARKER}`, errors: [`${MARKER} denied`] }),
  helperRow({ pid: 110, createdAt: T0 - 3590_000 }),
  helperRow({ pid: 120, createdAt: T0 - 3580_000, user: 9000 }),
  helperRow({
    pid: 150,
    ppid: 100,
    exe: `C:\\Users\\${MARKER}\\AppData\\${MARKER}dir\\${MARKER}program.exe`,
    createdAt: T0 - 10_000,
    commandLine: `${MARKER}program.exe --token ${MARKER}`,
    title: `${MARKER} — Inbox`,
  }),
  helperRow({ pid: 130, ppid: 100, exe: "windows-key-listener.exe", createdAt: T0 - 3500_000 }),
];

test("no exe path, program name, command line, title, hotkey or raw error reaches a log line or the report", async () => {
  const h = makeHarness();
  h.state.context = {
    windows: collectWindowRoles({
      windowManager: {
        mainWindow: {
          isDestroyed: () => false,
          isVisible: () => true,
          getTitle: () => `${MARKER} title`,
          webContents: { getOSProcessId: () => 120, getURL: () => `file:///${MARKER}` },
        },
      },
    }),
    keyListeners: new Map([[130, `Control+${MARKER}`]]),
  };
  h.inventory.start();

  // Success with tainted fields, and a warning (USER objects) from it.
  await h.clock.advance(60_000);
  h.spawned.at(-1).answer(
    helperJson({
      processes: tainted(),
      gpu: { status: "ok", error: `${MARKER} pdh`, processesWithDedicated: 40, engine: "off" },
    })
  );
  await flush();
  // Failure paths: unreadable output, a helper error carrying free text, a
  // timeout, too much output.
  for (const answer of [
    `${MARKER} not json`,
    `{"v":1,"mode":"once","error":"${MARKER} C:\\\\Users\\\\${MARKER}"}`,
    null,
    `${MARKER}`.repeat(30_000),
  ]) {
    const pending = h.inventory.collectOnce();
    const child = h.spawned.at(-1);
    if (answer === null) await h.clock.advance(2_000);
    else if (answer.length > 200_000) child.write(answer);
    else child.answer(answer);
    await pending;
  }
  // A dictation, its recording cost line and its after-delivery reading.
  h.dictation("recording");
  await h.clock.advance(5_000);
  h.dictation("processing");
  h.dictation("idle");
  h.spawned
    .at(-1)
    .answer(
      helperJson({ processes: tainted(), gpu: { status: "ok", processesWithDedicated: 41 } })
    );
  await flush();
  // The stream: lines with tainted fields, then the helper exits on its own.
  const page = fakeContents(7);
  h.inventory.subscribe(page);
  const stream = h.spawned.at(-1);
  stream.write(helperJson({ processes: tainted(), mode: "stream" }));
  stream.write(`${MARKER} garbage\n`);
  await h.clock.advance(2_000);
  h.spawned.at(-1).exit(3);
  await h.clock.advance(30 * 60_000);
  await flush();

  const logged = everythingLogged(h);
  assert.ok(h.logs.some((entry) => entry.message === "Resource snapshot"));
  assert.ok(h.logs.some((entry) => entry.message === "Resource warning"));
  assert.ok(h.logs.some((entry) => entry.message === "Recording cost"));
  assert.ok(h.logs.some((entry) => entry.message === "Process stats helper run failed"));
  assert.doesNotMatch(logged, new RegExp(MARKER), "nothing tainted in any log line");
  assert.doesNotMatch(logged, /\\Users\\|\.exe|Control\+/);

  const report = JSON.stringify(h.inventory.get().report);
  assert.doesNotMatch(report, new RegExp(MARKER), "nothing tainted in the report");
  assert.doesNotMatch(report, /\.exe/);

  // The page (local) sees the helper's exe file name, never its path, and no command line.
  const ipc = JSON.stringify(h.inventory.get());
  assert.doesNotMatch(ipc, /\\Users\\|AppData|--token|Inbox|title/);
  for (const child of h.spawned) {
    assert.ok(!child.args.some((arg) => arg.includes(MARKER)));
  }
  await h.inventory.stop();
});

test("a spawn that throws, and stderr, never reach the log", async () => {
  const logs = [];
  const logger = {};
  for (const level of ["debug", "info", "warn", "error"]) {
    logger[level] = (message, meta) => logs.push(`${message} ${JSON.stringify(meta)}`);
  }
  const options = [];
  const inventory = createProcessInventory({
    app: { getAppMetrics: () => [] },
    platform: "win32",
    helperPath: `C:\\Users\\${MARKER}\\windows-process-stats.exe`,
    spawn: (_file, _args, spawnOptions) => {
      options.push(spawnOptions);
      throw new Error(`spawn C:\\Users\\${MARKER}\\windows-process-stats.exe ENOENT`);
    },
    logger,
    timers: {
      setTimeout: () => ({}),
      clearTimeout() {},
      setInterval: () => ({}),
      clearInterval() {},
    },
  });
  inventory.start();
  await inventory.collectOnce();
  inventory.subscribe(fakeContents(1));
  assert.ok(logs.length >= 1);
  assert.doesNotMatch(logs.join("\n"), new RegExp(MARKER));
  assert.ok(logs.some((line) => line.includes("spawn_failed")));
  await inventory.stop();

  // stderr is never even read: the helper's stdio ignores it, once and streaming.
  const h = makeHarness();
  h.inventory.start();
  h.inventory.collectOnce();
  h.inventory.subscribe(fakeContents(2));
  assert.equal(h.spawned.length, 2);
  for (const child of h.spawned) {
    assert.equal(child.options.stdio[2], "ignore", child.args.join(" "));
    assert.equal(child.options.windowsHide, true);
  }
  await h.inventory.stop();
});
