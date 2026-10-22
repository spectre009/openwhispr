// Builds the GitHub Copilot provider's main-process services: the runtime
// owner and the sign-in, wired to Electron, the encrypted token store and the
// windows.
const path = require("path");
const fs = require("fs");
const { app, net } = require("electron");
const debugLogger = require("../debugLogger");
const sidecarPidFile = require("../sidecarPidFile");
const { broadcastToWindows } = require("../windowBroadcast");
const { createGithubApi } = require("../connectors/githubApi");
const { createDeviceFlow } = require("../connectors/githubDeviceFlow");
const { createCopilotRuntime } = require("./copilotRuntime");
const { createCopilotAuth } = require("./copilotAuth");
const { COPILOT_OAUTH_CLIENT_ID } = require("../../config/copilot");

const RUNTIME_PACKAGE = `@github/copilot-sdk-${process.platform}-${process.arch}`;
const RUNTIME_EXE = process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime";

// In a packaged build the runtime must run from app.asar.unpacked: nothing
// inside app.asar can be spawned. Development lets the SDK find its own.
function resolvePackagedRuntimePath() {
  if (!app.isPackaged) return null;
  const exe = path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    ...RUNTIME_PACKAGE.split("/"),
    "prebuilds",
    `${process.platform}-${process.arch}`,
    RUNTIME_EXE
  );
  return fs.existsSync(exe) ? exe : null;
}

async function findRuntimePids(parentPid) {
  const psList = (await import("ps-list")).default;
  const processes = await psList();
  return processes
    .filter((proc) => proc.ppid === parentPid && /copilot-runtime/i.test(proc.name || ""))
    .map((proc) => proc.pid);
}

function createCopilotServices({ environmentManager }) {
  const fetchImpl = (url, init) => net.fetch(url, { ...init, useSessionCookies: false });
  const api = createGithubApi({ fetchImpl });

  const runtime = createCopilotRuntime({
    baseDirectory: path.join(app.getPath("userData"), "copilot-runtime"),
    resolveRuntimePath: resolvePackagedRuntimePath,
    findRuntimePids,
    pidFile: sidecarPidFile,
    logger: debugLogger,
  });

  async function fetchUser(token, { signal } = {}) {
    const result = await api.rest("GET", "/user", { token, signal });
    if (!result.ok || typeof result.data?.login !== "string") {
      throw Object.assign(new Error("Couldn't read the GitHub account"), {
        code: "USER_LOOKUP_FAILED",
        status: result.status,
      });
    }
    return { login: result.data.login };
  }

  const auth = createCopilotAuth({
    deviceFlow: createDeviceFlow({ api }),
    fetchUser,
    runtime,
    store: {
      getToken: () => environmentManager.getGithubCopilotToken(),
      getLogin: () => environmentManager.getGithubCopilotLogin(),
      saveToken: (token, login) => environmentManager.saveGithubCopilotToken(token, login),
      clearToken: () => environmentManager.clearGithubCopilotToken(),
    },
    getClientId: () => process.env.GITHUB_COPILOT_CLIENT_ID || COPILOT_OAUTH_CLIENT_ID,
    broadcast: (snapshot) => broadcastToWindows("copilot-auth-changed", snapshot),
    logger: debugLogger,
  });

  return { runtime, auth };
}

module.exports = { createCopilotServices, resolvePackagedRuntimePath, findRuntimePids };
