// The OpenWhispr account & Cloud switch for connections the session blocker
// can't see: Node `ws` sockets, Node https downloads and the system browser.
// Each test proves the transport is never invoked for a blocked host.
const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const https = require("node:https");

const gate = require("../../src/helpers/openWhisprCloudGate");

const originalLoad = Module._load;

afterEach(() => {
  Module._load = originalLoad;
  gate.resetCloudGateForTests();
});

function loadFresh(modulePath, mocks) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

test("a streaming socket to a blocked host is refused before ws dials", () => {
  const dialed = [];
  class FakeWebSocket {
    constructor(address) {
      dialed.push(address);
    }
  }
  FakeWebSocket.OPEN = 1;
  const GuardedWebSocket = loadFresh("../../src/helpers/guardedWebSocket", { ws: FakeWebSocket });

  gate.setCloudDisabled(true);
  assert.throws(() => new GuardedWebSocket("wss://orukeet.gizmovoice.ai/v1/stream"), {
    code: gate.CLOUD_DISABLED_CODE,
  });
  assert.throws(() => new GuardedWebSocket(new URL("wss://api.openwhispr.com/x")), {
    code: gate.CLOUD_DISABLED_CODE,
  });
  assert.deepEqual(dialed, []);

  new GuardedWebSocket("wss://api.deepgram.com/v1/listen");
  assert.deepEqual(dialed, ["wss://api.deepgram.com/v1/listen"]);
  assert.equal(GuardedWebSocket.OPEN, 1);

  gate.setCloudDisabled(false);
  new GuardedWebSocket("wss://orukeet.gizmovoice.ai/v1/stream");
  assert.equal(dialed.length, 2);
});

test("an audio download from a blocked host never opens a Node request", async () => {
  const downloader = require("../../src/helpers/urlAudioDownloader");
  const orig = https.request;
  const calls = [];
  https.request = (parsed) => {
    calls.push(parsed.href);
    throw new Error("https.request must not be called");
  };
  try {
    gate.setCloudDisabled(true);
    await assert.rejects(downloader.download("https://api.openwhispr.com/audio.mp3", null, null), {
      code: gate.CLOUD_DISABLED_CODE,
    });
    assert.deepEqual(calls, []);
  } finally {
    https.request = orig;
  }
});

test("a redirect onto a blocked host stops at that hop", async () => {
  const downloader = require("../../src/helpers/urlAudioDownloader");
  const { EventEmitter } = require("node:events");
  const orig = https.request;
  const calls = [];
  https.request = (parsed, options, callback) => {
    calls.push(`${options.method} ${parsed.href}`);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = 302;
        res.headers = { location: "https://notes.openwhispr.com/x.mp3" };
        res.resume = () => {};
        res.destroy = () => {};
        callback(res);
      });
    };
    return req;
  };
  try {
    gate.setCloudDisabled(true);
    await assert.rejects(downloader.download("https://93.184.216.34/file.mp3", null, null), {
      code: gate.CLOUD_DISABLED_CODE,
    });
    assert.deepEqual(calls, ["HEAD https://93.184.216.34/file.mp3"]);
  } finally {
    https.request = orig;
  }
});

test("the system browser never opens an OpenWhispr link while the switch is off", async () => {
  const opened = [];
  const spawned = [];
  const { openExternalUrl } = loadFresh("../../src/helpers/externalUrlOpener", {
    electron: { shell: { openExternal: async (url) => opened.push(url) } },
    child_process: {
      ...require("node:child_process"),
      spawn: (command, args) => {
        spawned.push(args);
        throw new Error("spawn must not be called");
      },
    },
  });

  gate.setCloudDisabled(true);
  await assert.rejects(openExternalUrl("https://docs.openwhispr.com"), {
    code: gate.CLOUD_DISABLED_CODE,
  });
  await assert.rejects(openExternalUrl("https://openwhispr.com/auth/desktop-callback?x=1"), {
    code: gate.CLOUD_DISABLED_CODE,
  });
  assert.deepEqual(opened, []);
  assert.deepEqual(spawned, []);

  // Other links still open; mailto goes straight to the shell on every platform.
  await openExternalUrl("mailto:someone@example.com");
  assert.deepEqual(opened, ["mailto:someone@example.com"]);
});

test("cloud config requests are answered locally while off: no URL, no fetch, no error log", async () => {
  const { createCloudConfigRequestHandler } = require("../../src/helpers/cloudConfigRequest");
  const touched = [];
  const handler = createCloudConfigRequestHandler({
    getApiUrl: () => touched.push("getApiUrl") && "https://api.openwhispr.com",
    getAuthHeader: async () => touched.push("getAuthHeader") && {},
    proxyFetch: async () => touched.push("proxyFetch"),
    withPolicyHeaders: (headers) => headers,
    logger: { error: () => touched.push("logger.error") },
    configPath: "stt-config",
    isCloudDisabled: () => true,
  });
  assert.deepEqual(await handler({}), {
    success: false,
    error: "OpenWhispr Cloud is turned off",
    code: "CLOUD_DISABLED",
  });
  assert.deepEqual(touched, []);
});

test("calendar sign-in answers from a local page, never the openwhispr.com callback", async () => {
  let flowOptions;
  const GoogleCalendarOAuth = loadFresh("../../src/helpers/googleCalendarOAuth", {
    electron: { net: { fetch: async () => ({}) } },
    "./oauthLoopbackFlow": {
      runOAuthLoopbackFlow: (options) => {
        flowOptions = options;
        return Promise.resolve();
      },
      OAuthFlowError: class extends Error {},
    },
  });
  await new GoogleCalendarOAuth({}).startOAuthFlow();
  assert.equal(typeof flowOptions.renderResultPage, "function");

  const page = flowOptions.renderResultPage({ ok: true });
  assert.match(page, /Google Calendar is connected/);
  assert.doesNotMatch(page, /openwhispr\.com/);
  assert.match(flowOptions.renderResultPage({ ok: false }), /Google Calendar wasn&#39;t connected/);
});

test("Outlook calendar sign-in answers from a local page too", async () => {
  let flowOptions;
  const previousClientId = process.env.MICROSOFT_CALENDAR_CLIENT_ID;
  process.env.MICROSOFT_CALENDAR_CLIENT_ID = "test-client";
  try {
    const MicrosoftCalendarOAuth = loadFresh("../../src/helpers/microsoftCalendarOAuth", {
      electron: { net: { fetch: async () => ({}) } },
      "./oauthLoopbackFlow": {
        runOAuthLoopbackFlow: (options) => {
          flowOptions = options;
          return Promise.resolve();
        },
        OAuthFlowError: class extends Error {},
      },
    });
    await new MicrosoftCalendarOAuth({}).startOAuthFlow();
    assert.match(flowOptions.renderResultPage({ ok: true }), /Outlook Calendar is connected/);
  } finally {
    if (previousClientId === undefined) delete process.env.MICROSOFT_CALENDAR_CLIENT_ID;
    else process.env.MICROSOFT_CALENDAR_CLIENT_ID = previousClientId;
  }
});
