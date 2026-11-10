const { EventEmitter } = require("node:events");

// A fake clock, helper process and lifecycle for createProcessInventory
// (test/helpers/processInventoryService.test.js, processInventoryLogCanary.test.js).

const T0 = Date.UTC(2026, 10, 10, 8, 0, 0);
const MB = 1024 * 1024;
const GB = 1024 * MB;

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock() {
  let now = T0;
  let mono = 0;
  let seq = 0;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, at: mono + ms, repeat: null });
      return { id, unref() {} };
    },
    clearTimeout(handle) {
      if (handle) pending.delete(handle.id);
    },
    setInterval(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, at: mono + ms, repeat: ms });
      return { id, unref() {} };
    },
    clearInterval(handle) {
      if (handle) pending.delete(handle.id);
    },
  };
  async function advance(ms) {
    const end = mono + ms;
    for (;;) {
      const next = [...pending.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now += timer.at - mono;
      mono = timer.at;
      if (timer.repeat) timer.at += timer.repeat;
      else pending.delete(id);
      timer.fn();
      await flush();
    }
    now += end - mono;
    mono = end;
    await flush();
  }
  return { timers, now: () => now, mono: () => mono, advance, pendingCount: () => pending.size };
}

class FakeChild extends EventEmitter {
  constructor(file, args, options = {}) {
    super();
    this.file = file;
    this.args = args;
    this.options = options;
    this.stream = args.includes("--stream");
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stdin = {
      ended: false,
      end: () => {
        this.stdin.ended = true;
        setImmediate(() => this.exit(0));
      },
    };
    this.killed = false;
    this.exitCode = null;
    this.pid = 4242;
  }
  write(text) {
    this.stdout.emit("data", this.stream ? text : Buffer.from(text));
  }
  answer(text) {
    this.write(text);
    this.exit(0);
  }
  kill() {
    this.killed = true;
    this.exit(null);
    return true;
  }
  exit(code) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    this.emit("close", code);
  }
}

function helperJson({ processes, gpu = null, mode = "once" }) {
  return `${JSON.stringify({
    v: 1,
    mode,
    root: 100,
    self: 999,
    at: T0,
    gpu: gpu ?? { status: "off", error: null, processesWithDedicated: null, engine: "off" },
    pdhInitMs: null,
    processes,
    sampleMs: 12,
    selfCpuMs: 15.6,
  })}\n`;
}

const helperRow = (fields) => ({
  pid: 100,
  ppid: 1,
  exe: "OpenWhispr.exe",
  createdAt: T0 - 3600_000,
  cpuSec: 10,
  ws: 100 * MB,
  priv: 200 * MB,
  peak: 150 * MB,
  handles: 1000,
  threads: 40,
  gdi: 40,
  user: 60,
  gpuDedicated: null,
  gpuShared: null,
  gpuUse: null,
  errors: [],
  ...fields,
});

const metric = ({ pid, type, created, cpuSec, wsKiB = 102400, serviceName, name }) => ({
  pid,
  type,
  serviceName,
  name,
  creationTime: created,
  cpu: { percentCPUUsage: 0, cumulativeCPUUsage: cpuSec, idleWakeupsPerSecond: 0 },
  memory: { workingSetSize: wsKiB, peakWorkingSetSize: wsKiB, privateBytes: wsKiB * 2 },
});

function makeHarness({
  platform = "win32",
  helperPath = "C:\\fake\\windows-process-stats.exe",
  deps = {},
} = {}) {
  const { createProcessInventory } = require("../../../src/helpers/processInventory");
  const clock = fakeClock();
  const spawned = [];
  const logs = [];
  const sent = [];
  const state = {
    busy: false,
    lifecycle: { state: "idle", inputKind: "dictation" },
    metrics: [
      metric({ pid: 100, type: "Browser", created: T0 - 3600_000, cpuSec: 10 }),
      metric({ pid: 110, type: "GPU", created: T0 - 3590_000, cpuSec: 50 }),
      metric({ pid: 120, type: "Tab", created: T0 - 3580_000, cpuSec: 100 }),
    ],
    context: {
      windows: new Map([[120, [{ role: "dictationWindow", visible: true, since: null }]]]),
    },
    stripMode: "frame",
  };
  const logger = {};
  for (const level of ["debug", "info", "warn", "error"]) {
    logger[level] = (message, meta, scope) => logs.push({ level, message, meta, scope });
  }
  const inventory = createProcessInventory({
    app: { getAppMetrics: () => state.metrics },
    platform,
    rootPid: 100,
    helperPath,
    spawn: (file, args, options) => {
      const child = new FakeChild(file, args, options);
      spawned.push(child);
      return child;
    },
    logger,
    isDictationBusy: () => state.busy,
    getDictationLifecycle: () => state.lifecycle,
    describeContext: () => state.context,
    getGraphics: () => ({ mode: "hardware", reason: null, glRenderer: "ANGLE (NVIDIA)" }),
    getStripMode: () => state.stripMode,
    send: (contents, payload) => sent.push({ contents, payload }),
    isVisible: (contents) => contents.visible !== false,
    timers: clock.timers,
    now: clock.now,
    mono: clock.mono,
    memory: { total: () => 64 * GB, free: () => 14 * GB },
    ...deps,
  });
  const dictation = (lifecycleState, { delivering = false } = {}) => {
    state.lifecycle = { state: lifecycleState, inputKind: "dictation" };
    state.busy = lifecycleState !== "idle" || delivering;
    inventory.handleDictationStateChanged();
  };
  return { inventory, clock, spawned, logs, sent, state, dictation };
}

function fakeContents(id, { visible = true } = {}) {
  return {
    id,
    visible,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    once() {},
    removeListener() {},
  };
}

module.exports = {
  GB,
  MB,
  T0,
  FakeChild,
  fakeClock,
  fakeContents,
  flush,
  helperJson,
  helperRow,
  makeHarness,
  metric,
};
