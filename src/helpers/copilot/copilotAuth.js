// Signs in to GitHub Copilot with GitHub's device flow and keeps the token in
// the main process. The renderer gets the user code and the verification URL
// to show, never the token. A new sign-in is checked on its own Copilot
// runtime before it replaces the saved one, so a token without Copilot access
// is never saved.
//
// Every attempt has a flow id: cancel and retry name it, and a reply for an
// attempt that was replaced is dropped.
const crypto = require("crypto");
const { redactTokens } = require("./copilotRuntime");

const STATES = Object.freeze({
  SIGNED_OUT: "signedOut",
  WAITING: "waiting",
  CHECKING: "checking",
  SIGNED_IN: "signedIn",
  ERROR: "error",
});

// Device-flow failures (githubDeviceFlow.js codes) the panel words itself.
const DEVICE_FLOW_ERRORS = new Set([
  "code_expired",
  "oauth_denied",
  "device_flow_disabled",
  "token_exchange_failed",
  "rate_limited",
  "network",
]);

// What a failed Copilot check means for the new sign-in. Only a verdict on the
// account discards it; an outage keeps it so Retry can check again.
function classifyCheckFailure(error) {
  const type = String(error?.errorType || "").toLowerCase();
  const status = error?.statusCode;
  if (type === "authentication" || status === 401) return { code: "no_access", keep: false };
  if (type === "authorization" || type === "policy" || status === 403) {
    return { code: "policy_blocked", keep: false };
  }
  if (error?.code === "COPILOT_RUNTIME_FAILED") return { code: "runtime_failed", keep: true };
  return { code: "check_failed", keep: true };
}

function createCopilotAuth({
  deviceFlow,
  fetchUser,
  runtime,
  store,
  getClientId,
  broadcast = () => {},
  logger = null,
  newFlowId = () => crypto.randomUUID(),
}) {
  let flow = null;
  let status = { state: STATES.SIGNED_OUT, login: "" };
  const log = (level, message, meta) => logger?.[level]?.(message, meta, "copilot");

  function savedState() {
    const token = store.getToken();
    return token
      ? { state: STATES.SIGNED_IN, login: store.getLogin() || "" }
      : { state: STATES.SIGNED_OUT, login: "" };
  }

  function snapshot() {
    const waiting = status.state === STATES.WAITING;
    return {
      configured: !!getClientId(),
      ...status,
      ...(flow
        ? {
            flowId: flow.id,
            ...(waiting && flow.userCode
              ? {
                  userCode: flow.userCode,
                  verificationUri: flow.verificationUri,
                  expiresAt: flow.expiresAt,
                }
              : {}),
            canRetry: !!flow.candidate && status.state === STATES.ERROR,
          }
        : {}),
    };
  }

  function publish(next) {
    status = next;
    broadcast(snapshot());
  }

  function endFlow(target) {
    if (flow && (!target || flow === target)) {
      flow.controller.abort();
      flow = null;
    }
  }

  function isLive(target) {
    return flow === target && !target.controller.signal.aborted;
  }

  function init() {
    runtime.setToken(store.getToken() || "");
    status = savedState();
  }

  async function finishWithToken(target) {
    publish({ state: STATES.CHECKING, login: target.login || "" });
    try {
      if (!target.login) {
        const user = await fetchUser(target.candidate, { signal: target.controller.signal });
        if (!isLive(target)) return;
        target.login = user?.login || "";
      }
      await runtime.validateToken(target.candidate, { signal: target.controller.signal });
      if (!isLive(target)) return;
      await store.saveToken(target.candidate, target.login);
      if (!isLive(target)) return;
      runtime.setToken(target.candidate);
      flow = null;
      log("info", "Signed in to GitHub Copilot", { login: target.login });
      publish({ state: STATES.SIGNED_IN, login: target.login });
    } catch (error) {
      if (!isLive(target)) return;
      if (error?.code === "PERSIST_FAILED") {
        endFlow(target);
        publish({ ...savedState(), state: STATES.ERROR, error: "persist_failed" });
        return;
      }
      const verdict =
        error?.code === "USER_LOOKUP_FAILED"
          ? { code: "check_failed", keep: true }
          : classifyCheckFailure(error);
      log("warn", "GitHub Copilot sign-in check failed", {
        error: verdict.code,
        code: error?.code,
        errorType: error?.errorType,
        statusCode: error?.statusCode,
        message: redactTokens(error?.message).slice(0, 300),
      });
      if (!verdict.keep) endFlow(target);
      publish({ ...savedState(), state: STATES.ERROR, error: verdict.code });
    }
  }

  async function poll(target, authorization) {
    try {
      const result = await deviceFlow.pollForToken({
        clientId: target.clientId,
        deviceCode: authorization.deviceCode,
        intervalMs: authorization.intervalMs,
        expiresAt: authorization.expiresAt,
        signal: target.controller.signal,
      });
      if (!isLive(target)) return;
      target.candidate = result.token.access_token;
      await finishWithToken(target);
    } catch (error) {
      failFlow(target, error);
    }
  }

  function failFlow(target, error) {
    if (!isLive(target) || error?.code === "oauth_cancelled") return;
    const code = DEVICE_FLOW_ERRORS.has(error?.code) ? error.code : "token_exchange_failed";
    log("warn", "GitHub Copilot device flow failed", {
      error: code,
      source: error?.code,
      message: redactTokens(error?.message).slice(0, 300),
    });
    endFlow(target);
    publish({ ...savedState(), state: STATES.ERROR, error: code });
  }

  // Starts a sign-in and resolves once GitHub has handed out a user code (or
  // refused to). Polling for the token continues in the background and is
  // reported through broadcast.
  async function start() {
    const clientId = getClientId();
    if (!clientId) {
      publish({ ...savedState(), state: STATES.ERROR, error: "not_configured" });
      return snapshot();
    }
    endFlow();
    const target = { id: newFlowId(), clientId, controller: new AbortController(), candidate: "" };
    flow = target;
    let authorization;
    try {
      authorization = await deviceFlow.startDeviceAuthorization({
        clientId,
        signal: target.controller.signal,
      });
    } catch (error) {
      failFlow(target, error);
      return snapshot();
    }
    if (!isLive(target)) return snapshot();
    Object.assign(target, {
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      expiresAt: authorization.expiresAt,
    });
    publish({ ...savedState(), state: STATES.WAITING });
    poll(target, authorization);
    return snapshot();
  }

  function cancel(flowId) {
    if (!flow || (flowId && flow.id !== flowId)) return snapshot();
    endFlow();
    publish(savedState());
    return snapshot();
  }

  async function retry(flowId) {
    if (!flow || flow.id !== flowId || !flow.candidate) return snapshot();
    await finishWithToken(flow);
    return snapshot();
  }

  async function signOut() {
    endFlow();
    runtime.setToken("");
    await store.clearToken();
    log("info", "Signed out of GitHub Copilot");
    publish(savedState());
    return snapshot();
  }

  // A request the runtime refused because the token no longer works.
  function reportTokenRejected() {
    if (status.state !== STATES.SIGNED_IN) return;
    publish({ ...status, tokenRejected: true });
  }

  return {
    init,
    start,
    cancel,
    retry,
    signOut,
    getStatus: snapshot,
    reportTokenRejected,
  };
}

module.exports = { createCopilotAuth, STATES, classifyCheckFailure };
