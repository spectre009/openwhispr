// Launch at login, for ipcHandlers.js and main.js. setLoginItemSettings covers
// macOS and Windows; on Linux it does nothing, so an XDG autostart entry stands in
// (linuxAutostart.js). Decisions live in autoStartPolicy.js.

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const linuxAutostart = require("./linuxAutostart");
const {
  getLoginItemArgs,
  getLoginItemPath,
  resolveAutoStartState,
  needsHiddenFlagMigration,
  wasLaunchedHidden,
} = require("./autoStartPolicy");

const isLinux = () => process.platform === "linux";

// Where the per-user NSIS installer puts the app (electron-builder default).
function installedExePath() {
  if (!process.env.LOCALAPPDATA) return null;
  return path.join(process.env.LOCALAPPDATA, "Programs", "OpenWhispr", "OpenWhispr.exe");
}

function loginItemOptions() {
  const installed = process.platform === "win32" ? installedExePath() : null;
  const exePath = getLoginItemPath({
    platform: process.platform,
    isUnpackaged: Boolean(process.defaultApp),
    installedExePath: installed,
    installedExeExists: Boolean(installed) && fs.existsSync(installed),
  });
  const options = { args: getLoginItemArgs(process.platform) };
  if (exePath) options.path = exePath;
  return options;
}

function readLoginItemSettings() {
  return app.getLoginItemSettings(loginItemOptions());
}

function writeLoginItem(enabled) {
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: enabled });
}

// { enabled, requiresApproval } — requiresApproval is macOS-only.
function getAutoStartState() {
  if (isLinux()) {
    return { enabled: linuxAutostart.isAutostartEnabled(), requiresApproval: false };
  }
  return resolveAutoStartState({
    platform: process.platform,
    loginItemSettings: readLoginItemSettings(),
  });
}

function setAutoStartEnabled(enabled) {
  if (isLinux()) {
    linuxAutostart.setAutostartEnabled(enabled);
    return;
  }
  writeLoginItem(enabled);
}

function wasLaunchedAtLoginHidden() {
  return wasLaunchedHidden({
    platform: process.platform,
    argv: process.argv,
    loginItemSettings: process.platform === "darwin" ? app.getLoginItemSettings() : null,
  });
}

// Repairs an entry that still exists but no longer starts this executable, or
// starts it without the flag that sends it to the tray. True when it rewrote one.
function syncAutoStartEntry() {
  if (isLinux()) return linuxAutostart.syncAutostartEntry();

  const loginItemSettings = readLoginItemSettings();
  if (!needsHiddenFlagMigration({ platform: process.platform, loginItemSettings })) return false;

  writeLoginItem(true);
  return true;
}

module.exports = {
  getAutoStartState,
  setAutoStartEnabled,
  wasLaunchedAtLoginHidden,
  syncAutoStartEntry,
};
