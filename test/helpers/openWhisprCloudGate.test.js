const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");

const gate = require("../../src/helpers/openWhisprCloudGate");

const originalEnv = process.env.OPENWHISPR_CLOUD_DISABLED;

afterEach(() => {
  gate.resetCloudGateForTests();
  if (originalEnv === undefined) delete process.env.OPENWHISPR_CLOUD_DISABLED;
  else process.env.OPENWHISPR_CLOUD_DISABLED = originalEnv;
});

test("blocks OpenWhispr's domains and their subdomains on every web scheme", () => {
  for (const url of [
    "https://openwhispr.com/",
    "https://auth.openwhispr.com/api/auth/get-session",
    "https://api.openwhispr.com/v1/x",
    "http://docs.openwhispr.com",
    "wss://api.openwhispr.com/stream",
    "ws://notes.openwhispr.com/",
    "wss://orukeet.gizmovoice.ai/v1/audio/transcriptions/stream",
    "https://gizmovoice.ai/",
    "https://AUTH.OpenWhispr.COM/",
    "https://auth.openwhispr.com./trailing-dot",
  ]) {
    assert.equal(gate.isBlockedUrl(url), true, url);
  }
});

test("does not block look-alike hosts, other services or non-web schemes", () => {
  for (const url of [
    "https://notopenwhispr.com/",
    "https://openwhispr.com.example.net/",
    "https://api.groq.com/openai/v1",
    "https://openrouter.ai/api/v1",
    "https://github.com/OpenWhispr/openwhispr/issues",
    "https://discord.gg/yZWC9WTtX7",
    "mailto:support@openwhispr.com",
    "file:///C:/openwhispr.com/x",
    "not a url",
    "",
  ]) {
    assert.equal(gate.isBlockedUrl(url), false, url);
  }
});

test("blocks an overridden API or auth origin by host and port only", () => {
  gate.setExtraBlockedOrigins([
    "http://localhost:3000",
    "https://api.openwhispr.com",
    "",
    "nonsense",
  ]);
  assert.equal(gate.isBlockedUrl("http://localhost:3000/api/auth/get-session"), true);
  assert.equal(gate.isBlockedUrl("ws://localhost:3000/socket"), true);
  // Local sidecars on other ports (llama-server, Qdrant) stay reachable.
  assert.equal(gate.isBlockedUrl("http://localhost:8080/v1/chat"), false);
  assert.equal(gate.isBlockedUrl("http://127.0.0.1:3000/"), false);
});

test("the request filter names ws and wss explicitly and never uses a * scheme", () => {
  gate.setExtraBlockedOrigins(["http://localhost:3000"]);
  const urls = gate.buildRequestFilterUrls();
  for (const scheme of ["http", "https", "ws", "wss"]) {
    for (const host of ["openwhispr.com", "*.openwhispr.com", "gizmovoice.ai", "*.gizmovoice.ai"]) {
      assert.ok(urls.includes(`${scheme}://${host}/*`), `${scheme}://${host}/*`);
    }
    assert.ok(urls.includes(`${scheme}://localhost/*`));
  }
  assert.equal(
    urls.some((url) => url.startsWith("*://")),
    false
  );
});

test("the switch reads the persisted value until set, then follows it", () => {
  delete process.env.OPENWHISPR_CLOUD_DISABLED;
  assert.equal(gate.isCloudDisabled(), false);
  process.env.OPENWHISPR_CLOUD_DISABLED = "true";
  assert.equal(gate.isCloudDisabled(), true);
  gate.setCloudDisabled(false);
  assert.equal(gate.isCloudDisabled(), false);
});

test("listeners hear real changes only", () => {
  const seen = [];
  gate.onCloudDisabledChange((value) => seen.push(value));
  gate.setCloudDisabled(true);
  gate.setCloudDisabled(true);
  gate.setCloudDisabled(false);
  assert.deepEqual(seen, [true, false]);
});

test("requests are cancelled only while the switch is off, and logged once per path", () => {
  const logs = [];
  gate.configureCloudGate({ logger: { info: (message) => logs.push(message) } });
  const details = { method: "GET", url: "https://auth.openwhispr.com/api/auth/get-session?x=1" };

  gate.setCloudDisabled(false);
  assert.equal(gate.shouldCancelRequest(details), false);

  gate.setCloudDisabled(true);
  assert.equal(gate.shouldCancelRequest(details), true);
  assert.equal(gate.shouldCancelRequest(details), true);
  assert.equal(gate.shouldCancelRequest({ method: "GET", url: "https://api.groq.com/x" }), false);

  assert.deepEqual(logs, [
    "[cloud-off] blocked GET https://auth.openwhispr.com/api/auth/get-session",
  ]);
});

test("installs one listener per session, which cancels by the live switch", () => {
  const registrations = [];
  const fakeSession = {
    webRequest: {
      onBeforeRequest: (filter, listener) => registrations.push({ filter, listener }),
    },
  };
  gate.installCloudBlock(fakeSession);
  gate.installCloudBlock(fakeSession);
  assert.equal(registrations.length, 1);
  assert.ok(registrations[0].filter.urls.includes("wss://*.gizmovoice.ai/*"));

  const answer = (url) => {
    let response;
    registrations[0].listener({ method: "GET", url }, (value) => {
      response = value;
    });
    return response;
  };
  assert.deepEqual(answer("https://auth.openwhispr.com/api/auth/get-session"), {});
  gate.setCloudDisabled(true);
  assert.deepEqual(answer("https://auth.openwhispr.com/api/auth/get-session"), { cancel: true });
  assert.deepEqual(answer("https://api.groq.com/openai/v1/models"), {});
});

test("assertCloudAllowed throws a coded error for blocked hosts while off", () => {
  gate.assertCloudAllowed("https://api.openwhispr.com/x", "test");
  gate.setCloudDisabled(true);
  gate.assertCloudAllowed("https://api.groq.com/x", "test");
  assert.throws(
    () => gate.assertCloudAllowed("wss://orukeet.gizmovoice.ai/stream", "streaming connection"),
    (error) => {
      assert.equal(error.code, gate.CLOUD_DISABLED_CODE);
      assert.equal(gate.isCloudDisabledError(error), true);
      assert.match(error.message, /streaming connection was not sent/);
      return true;
    }
  );
});
