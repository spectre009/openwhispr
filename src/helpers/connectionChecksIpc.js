// IPC for Settings › AI Connections' connection checks (connectionChecks.js):
// `connection-checks-run({ descriptors, maxAgeMs, fresh })` answers the cached
// results still fenced and young enough, and queues the rest; each queued
// check's answer is broadcast as `connection-check-result` (`{ id, generation,
// result }`, or `dropped` / `invalidated`), which carries evidence and codes,
// never a key, a body or a provider's model list.
//
// Requests go out through Electron's proxy-aware net stack on their own
// in-memory session (no cookies, nothing shared with the app's windows), so a
// provider's answer can't set or read anything the app keeps.
const { session } = require("electron");
const openWhisprCloudGate = require("./openWhisprCloudGate");
const { broadcastToWindows } = require("./windowBroadcast");
const { tinfoilSecureFetch } = require("./tinfoilSecureClient");
const { createConnectionChecks, createSecretReader } = require("./connectionChecks");

const CHECK_PARTITION = "ow-connection-checks";

function createCheckFetch(fromPartition = (name) => session.fromPartition(name)) {
  let checkSession = null;
  return (url, init) => {
    // Created on first use, after the app is ready; `session-created` gives it
    // the Cloud switch's blocker like every other session.
    checkSession ??= fromPartition(CHECK_PARTITION);
    return checkSession.fetch(url, { ...init, credentials: "omit", useSessionCookies: false });
  };
}

/**
 * @param {object} deps
 * @param {import("electron").IpcMain} deps.ipcMain
 * @param {object} deps.environmentManager
 * @param {{ runtime: object, auth: object } | null} [deps.copilot]
 * @param {object} [deps.logger]
 */
function registerConnectionChecksIpc({
  ipcMain,
  environmentManager,
  copilot = null,
  logger = null,
  // Required here, not at load: environment.js reads Electron's app paths.
  onSecretChanged = require("./environment").onSecretChanged,
  cloudGate = openWhisprCloudGate,
  fetchImpl = createCheckFetch(),
  tinfoilFetch = tinfoilSecureFetch,
  emit = (payload) => broadcastToWindows("connection-check-result", payload),
}) {
  const checks = createConnectionChecks({
    readSecret: createSecretReader(environmentManager),
    fetchImpl,
    tinfoilFetch,
    copilot,
    cloudGate,
    logger,
    emit,
  });
  onSecretChanged?.((change) => checks.noteSecretsChanged(change));
  cloudGate.onCloudDisabledChange?.(() => checks.noteCloudSwitch());
  ipcMain.handle("connection-checks-run", (_event, request) => checks.run(request));
  return checks;
}

module.exports = { CHECK_PARTITION, createCheckFetch, registerConnectionChecksIpc };
