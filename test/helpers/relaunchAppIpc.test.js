const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Settings' Restart (relaunch-app) and the tray's run the same restart
// (appRelaunch.js, tested on its own); here, that the IPC still runs it with
// main's updater and protocol, and that a meeting recording's start and stop
// rebuild the tray menu, whose Restart waits for it.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const restarts = [];

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
    handle: (channel, handler) => handlers.set(channel, handler),
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

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./appRelaunch") {
    return {
      relaunchApp: async (deps) => {
        restarts.push(deps);
        return "restarted";
      },
    };
  }
  if (
    parent?.filename === handlersModulePath &&
    (request.startsWith("./") || request.startsWith("../"))
  ) {
    return anything();
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

let IPCHandlers;
const updateManager = { name: "updater" };

test.before(() => {
  delete require.cache[handlersModulePath];
  IPCHandlers = require(handlersModulePath);
  const target = {
    updateManager,
    oauthProtocol: "openwhispr-dev",
    relaunchApp: IPCHandlers.prototype.relaunchApp,
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.after(() => {
  Module._load = originalLoad;
});

test("relaunch-app runs the shared restart with main's updater and protocol", async () => {
  restarts.length = 0;
  assert.equal(await handlers.get("relaunch-app")({}), "restarted");
  assert.deepEqual(restarts, [
    { app: electronStub.app, updateManager, protocol: "openwhispr-dev" },
  ]);
});

test("a meeting recording's start and stop rebuild the tray menu once each", () => {
  let rebuilds = 0;
  const handlersLike = {
    _meetingRecording: false,
    getTrayManager: () => ({ updateTrayMenu: () => (rebuilds += 1) }),
  };
  const set = (active) => IPCHandlers.prototype._setMeetingRecording.call(handlersLike, active);
  const recording = () => IPCHandlers.prototype.isMeetingRecording.call(handlersLike);

  assert.equal(recording(), false);
  set(true);
  set(true);
  assert.equal(recording(), true);
  assert.equal(rebuilds, 1, "once per change");
  set(false);
  set(false);
  assert.equal(recording(), false);
  assert.equal(rebuilds, 2);

  // Before the tray exists there is nothing to rebuild.
  handlersLike.getTrayManager = () => null;
  assert.doesNotThrow(() => set(true));
});
