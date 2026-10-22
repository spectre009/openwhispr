// The "OpenWhispr account & Cloud" switch. Off, nothing may reach OpenWhispr's
// servers: the session blocker cancels Chromium traffic (renderer fetch and
// WebSocket, main net.fetch) and assertCloudAllowed guards Node-side
// connections, which no session hook sees.

const BLOCKED_DOMAINS = ["openwhispr.com", "gizmovoice.ai"];
// Explicit: a "*://" filter scheme matches http and https only, never ws/wss.
const FILTER_SCHEMES = ["http", "https", "ws", "wss"];
const BLOCKED_PROTOCOLS = new Set(FILTER_SCHEMES.map((scheme) => `${scheme}:`));

const CLOUD_DISABLED_CODE = "OPENWHISPR_CLOUD_DISABLED";
const ENV_KEY = "OPENWHISPR_CLOUD_DISABLED";

let explicitState = null;
let extraHosts = [];
let logger = null;
const listeners = new Set();
const loggedBlocks = new Set();
const blockedSessions = new WeakSet();

function isCloudDisabled() {
  if (explicitState !== null) return explicitState;
  return process.env[ENV_KEY] === "true";
}

function setCloudDisabled(disabled) {
  const next = Boolean(disabled);
  const changed = next !== isCloudDisabled();
  explicitState = next;
  if (!changed) return;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      // A failing listener must not stop the others.
    }
  }
}

function onCloudDisabledChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hosts beyond the built-in domains, from the raw API and auth URLs (a dev
 * build pointing at localhost:3000). Read from configuration, never from a
 * gated getter that already answers "" when the switch is off.
 */
function setExtraBlockedOrigins(urls) {
  const hosts = new Set();
  for (const value of urls || []) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (!isBlockedDomain(url.hostname)) hosts.add(url.host.toLowerCase());
    } catch {
      // Not a URL: nothing to add.
    }
  }
  extraHosts = [...hosts];
}

function configureCloudGate(options = {}) {
  if ("logger" in options) logger = options.logger || null;
}

function isBlockedDomain(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  return BLOCKED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isBlockedUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (!BLOCKED_PROTOCOLS.has(url.protocol)) return false;
  if (isBlockedDomain(url.hostname)) return true;
  return extraHosts.includes(url.host.toLowerCase());
}

function buildRequestFilterUrls() {
  const urls = [];
  for (const scheme of FILTER_SCHEMES) {
    for (const domain of BLOCKED_DOMAINS) {
      urls.push(`${scheme}://${domain}/*`, `${scheme}://*.${domain}/*`);
    }
    // Hostname only: the listener re-checks the port, so a wider filter is safe.
    for (const host of extraHosts) {
      urls.push(`${scheme}://${host.replace(/:\d+$/, "")}/*`);
    }
  }
  return urls;
}

function describeForLog(value) {
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(value).slice(0, 200);
  }
}

function logBlocked(method, value, source) {
  const key = `${method} ${describeForLog(value)}`;
  if (loggedBlocks.has(key)) return;
  loggedBlocks.add(key);
  logger?.info?.(`[cloud-off] blocked ${key}`, { source }, "cloud-gate");
}

/** Cancel decision for one request, separated from Electron for tests. */
function shouldCancelRequest(details) {
  if (!isCloudDisabled() || !isBlockedUrl(details?.url)) return false;
  logBlocked(details?.method || "GET", details.url, "session");
  return true;
}

/**
 * Electron allows one onBeforeRequest listener per session: this is the app's
 * only one. It is always installed and reads the live switch, so turning the
 * switch on or off needs no restart.
 */
function installCloudBlock(targetSession) {
  if (!targetSession?.webRequest || blockedSessions.has(targetSession)) return;
  blockedSessions.add(targetSession);
  targetSession.webRequest.onBeforeRequest(
    { urls: buildRequestFilterUrls() },
    (details, callback) => {
      callback(shouldCancelRequest(details) ? { cancel: true } : {});
    }
  );
}

function createCloudDisabledError(what) {
  const error = new Error(
    `OpenWhispr account & Cloud is turned off${what ? `: ${what} was not sent` : ""}`
  );
  error.code = CLOUD_DISABLED_CODE;
  return error;
}

/** For connections the session blocker can't see (Node https, ws, the system browser). */
function assertCloudAllowed(url, what = "request") {
  if (!isCloudDisabled() || !isBlockedUrl(url)) return;
  logBlocked(what, url, "node");
  throw createCloudDisabledError(what);
}

function isCloudDisabledError(error) {
  return error?.code === CLOUD_DISABLED_CODE;
}

function resetCloudGateForTests() {
  explicitState = null;
  extraHosts = [];
  logger = null;
  listeners.clear();
  loggedBlocks.clear();
}

module.exports = {
  BLOCKED_DOMAINS,
  CLOUD_DISABLED_CODE,
  ENV_KEY,
  assertCloudAllowed,
  buildRequestFilterUrls,
  configureCloudGate,
  createCloudDisabledError,
  installCloudBlock,
  isBlockedUrl,
  isCloudDisabled,
  isCloudDisabledError,
  onCloudDisabledChange,
  resetCloudGateForTests,
  setCloudDisabled,
  setExtraBlockedOrigins,
  shouldCancelRequest,
};
