const test = require("node:test");
const assert = require("node:assert/strict");

const { createCopilotAuth } = require("../../src/helpers/copilot/copilotAuth");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({
  clientId = "Ov23liTEST",
  validate = async () => ({ models: [] }),
  user = async () => ({ login: "octocat" }),
  poll,
  saved = { token: "", login: "" },
  saveError = null,
} = {}) {
  const broadcasts = [];
  const tokens = [];
  const store = {
    token: saved.token,
    login: saved.login,
    getToken() {
      return this.token;
    },
    getLogin() {
      return this.login;
    },
    async saveToken(token, login) {
      if (saveError) throw saveError;
      this.token = token;
      this.login = login;
    },
    async clearToken() {
      this.token = "";
      this.login = "";
    },
  };
  let resolvePoll;
  let rejectPoll;
  const deviceFlow = {
    async startDeviceAuthorization({ clientId: id }) {
      assert.equal(id, clientId);
      return {
        deviceCode: "device-123",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresAt: 1_000_000,
        intervalMs: 5000,
      };
    },
    pollForToken({ signal }) {
      if (poll) return poll({ signal });
      return new Promise((resolve, reject) => {
        resolvePoll = resolve;
        rejectPoll = reject;
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("cancelled"), { code: "oauth_cancelled" }))
        );
      });
    },
  };
  const runtime = {
    validateToken: async (token, options) => validate(token, options),
    setToken: (token) => tokens.push(token),
  };
  const auth = createCopilotAuth({
    deviceFlow,
    fetchUser: user,
    runtime,
    store,
    getClientId: () => clientId,
    broadcast: (snapshot) => broadcasts.push(snapshot),
    newFlowId: () => "flow-1",
  });
  auth.init();
  return {
    auth,
    store,
    broadcasts,
    tokens,
    grant: (token = "gho_new123456789") =>
      resolvePoll({ ok: true, token: { access_token: token } }),
    fail: (code) => rejectPoll(Object.assign(new Error(code), { code })),
  };
}

test("an app without a client id says it isn't configured", async () => {
  const { auth } = harness({ clientId: "" });
  const status = await auth.start();
  assert.equal(status.configured, false);
  assert.equal(status.state, "error");
  assert.equal(status.error, "not_configured");
});

test("sign-in shows the code, checks Copilot access, then saves the token", async () => {
  const validated = [];
  const h = harness({ validate: async (token) => validated.push(token) && { models: [] } });
  const started = await h.auth.start();
  assert.equal(started.state, "waiting");
  assert.equal(started.userCode, "ABCD-1234");
  assert.equal(started.verificationUri, "https://github.com/login/device");
  assert.equal(started.flowId, "flow-1");

  h.grant("gho_new123456789");
  await tick();
  await tick();
  assert.deepEqual(validated, ["gho_new123456789"]);
  assert.equal(h.store.token, "gho_new123456789");
  assert.equal(h.store.login, "octocat");
  assert.deepEqual(h.tokens, ["", "gho_new123456789"]);
  const final = h.auth.getStatus();
  assert.equal(final.state, "signedIn");
  assert.equal(final.login, "octocat");
  assert.ok(h.broadcasts.some((snapshot) => snapshot.state === "checking"));
  for (const snapshot of h.broadcasts) {
    assert.doesNotMatch(JSON.stringify(snapshot), /gho_/);
  }
});

test("an account without Copilot access is refused and nothing is saved", async () => {
  const noAccess = Object.assign(new Error("401"), {
    code: "COPILOT_SDK_ERROR",
    errorType: "authentication",
    statusCode: 401,
  });
  const h = harness({
    validate: async () => {
      throw noAccess;
    },
  });
  await h.auth.start();
  h.grant();
  await tick();
  await tick();
  const status = h.auth.getStatus();
  assert.equal(status.state, "error");
  assert.equal(status.error, "no_access");
  assert.equal(status.canRetry, undefined);
  assert.equal(h.store.token, "");
  assert.deepEqual(h.tokens, [""]);
});

test("an organization policy refusal is its own error", async () => {
  const policy = Object.assign(new Error("403"), {
    code: "COPILOT_SDK_ERROR",
    errorType: "policy",
  });
  const h = harness({
    validate: async () => {
      throw policy;
    },
  });
  await h.auth.start();
  h.grant();
  await tick();
  await tick();
  assert.equal(h.auth.getStatus().error, "policy_blocked");
});

test("a check that fails for an outage keeps the authorization for Retry", async () => {
  let attempts = 0;
  const h = harness({
    validate: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("spawn"), { code: "COPILOT_RUNTIME_FAILED" });
      }
      return { models: [] };
    },
  });
  await h.auth.start();
  h.grant("gho_keepme1234567");
  await tick();
  await tick();
  const failed = h.auth.getStatus();
  assert.equal(failed.error, "runtime_failed");
  assert.equal(failed.canRetry, true);
  assert.equal(failed.userCode, undefined);
  const retried = await h.auth.retry("flow-1");
  assert.equal(retried.state, "signedIn");
  assert.equal(h.store.token, "gho_keepme1234567");
});

test("cancel during the Copilot check saves nothing", async () => {
  let finishCheck;
  const h = harness({
    validate: (_token, { signal }) =>
      new Promise((resolve, reject) => {
        finishCheck = resolve;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  await h.auth.start();
  h.grant();
  await tick();
  assert.equal(h.auth.getStatus().state, "checking");
  const cancelled = h.auth.cancel("flow-1");
  assert.equal(cancelled.state, "signedOut");
  finishCheck({ models: [] });
  await tick();
  assert.equal(h.store.token, "");
  assert.equal(h.auth.getStatus().state, "signedOut");
});

test("a cancel for an attempt that was replaced is ignored", async () => {
  const h = harness();
  await h.auth.start();
  const status = h.auth.cancel("some-older-flow");
  assert.equal(status.state, "waiting");
});

test("an expired code and a denied request are reported", async () => {
  for (const code of ["code_expired", "oauth_denied"]) {
    const h = harness();
    await h.auth.start();
    h.fail(code);
    await tick();
    const status = h.auth.getStatus();
    assert.equal(status.state, "error");
    assert.equal(status.error, code);
    assert.equal(status.flowId, undefined);
  }
});

test("a token that can't be saved is reported and not used", async () => {
  const h = harness({ saveError: Object.assign(new Error("disk"), { code: "PERSIST_FAILED" }) });
  await h.auth.start();
  h.grant();
  await tick();
  await tick();
  assert.equal(h.auth.getStatus().error, "persist_failed");
  assert.deepEqual(h.tokens, [""]);
});

test("signing out clears the token and stops the runtime", async () => {
  const h = harness({ saved: { token: "gho_saved1234567", login: "octocat" } });
  assert.equal(h.auth.getStatus().state, "signedIn");
  assert.deepEqual(h.tokens, ["gho_saved1234567"]);
  const status = await h.auth.signOut();
  assert.equal(status.state, "signedOut");
  assert.equal(h.store.token, "");
  assert.deepEqual(h.tokens, ["gho_saved1234567", ""]);
});

test("a rejected token is flagged while signed in", () => {
  const h = harness({ saved: { token: "gho_saved1234567", login: "octocat" } });
  h.auth.reportTokenRejected();
  assert.equal(h.auth.getStatus().tokenRejected, true);
});
