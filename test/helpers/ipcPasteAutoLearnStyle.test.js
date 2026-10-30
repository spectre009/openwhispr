const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Auto-learn is decided per paste, in main: main arms edit monitoring after
// every paste, so a styled paste (its text isn't what was said) must say so
// on the paste itself. A plain paste right after a styled one arms it again.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

let target;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = {
    sessionId: "test-session",
    _autoLearnMode: "add",
    _autoLearnSynced: true,
    _autoLearnPasteSeq: 0,
    _autoLearnArmed: Ctor.prototype._autoLearnArmed,
    stepHistory: { currentOwner: () => "signed-out" },
    textEditMonitor: null,
    selectionManager: null,
  };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.after(() => {
  Module._load = originalLoad;
});

function setupPaste(t) {
  const timers = [];
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  t.after(() => {
    global.setTimeout = originalSetTimeout;
  });
  const monitor = { started: [], stopped: 0 };
  target.textEditMonitor = {
    lastTargetPid: 42,
    activateTargetPid: async () => true,
    startMonitoring: (text) => monitor.started.push(text),
    stopMonitoring: () => {
      monitor.stopped += 1;
    },
  };
  const pasted = [];
  target.windowManager = { isOnboardingDemoActive: () => false };
  target.clipboardManager = {
    pasteText: async (text, options) => {
      pasted.push({ text, options });
    },
  };
  const flush = () => {
    for (const run of timers.splice(0)) run();
  };
  return { monitor, pasted, flush };
}

test("a styled paste arms no monitoring; the next plain paste does", async (t) => {
  const { monitor, pasted, flush } = setupPaste(t);
  const paste = handlers.get("paste-text");

  const styled = await paste({ sender: { id: 1 } }, "- Must support JSON.", {
    suppressAutoLearn: true,
    restoreClipboard: true,
  });
  assert.deepEqual(styled, { success: true, pasted: true });
  flush();
  assert.deepEqual(monitor.started, [], "no edit monitoring for a styled paste");
  assert.equal(monitor.stopped, 1, "nor may an earlier paste's monitor see the styled text");
  assert.equal(
    "suppressAutoLearn" in pasted[0].options,
    false,
    "the option stays in main; the clipboard never sees it"
  );
  assert.equal(pasted[0].options.restoreClipboard, true);

  const plain = await paste({ sender: { id: 1 } }, "We need JSON.", {});
  assert.deepEqual(plain, { success: true, pasted: true });
  flush();
  assert.deepEqual(monitor.started, ["We need JSON."], "a plain paste right after arms it");
});

test("a styled paste cancels monitoring a plain paste had only scheduled", async (t) => {
  const { monitor, flush } = setupPaste(t);
  const paste = handlers.get("paste-text");

  await paste({ sender: { id: 1 } }, "plain words", {});
  // The styled paste lands before the plain paste's 500 ms timer fires.
  await paste({ sender: { id: 1 } }, "- styled words", { suppressAutoLearn: true });
  flush();
  assert.deepEqual(monitor.started, [], "the plain paste's monitor never watches the styled text");
});

test("auto-learn switched off arms nothing, styled or not", async (t) => {
  const { monitor, flush } = setupPaste(t);
  target._autoLearnMode = "off";
  t.after(() => {
    target._autoLearnMode = "add";
  });
  await handlers.get("paste-text")({ sender: { id: 1 } }, "plain words", {});
  flush();
  assert.deepEqual(monitor.started, []);
});
