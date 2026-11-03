// Restarting OpenWhispr, shared by Settings' Restart buttons (the relaunch-app
// IPC) and the tray's Restart items, so both take the same path.

const path = require("path");
const { getRelaunchOptions, getRelaunchWaiter } = require("./autoStartPolicy");

/**
 * Quits and starts OpenWhispr again. Under `npm run dev` the Vite server dies
 * with Electron, so a relaunched dev instance would have no renderer: it only
 * quits there. A staged update restarts through the updater; an AppImage is
 * started from outside once this process is gone (getRelaunchWaiter).
 *
 * @param {object} deps
 * @param {object} deps.app  Electron's app (quit, relaunch)
 * @param {object} deps.updateManager  hasStagedUpdate, installUpdate, deferInstallOnQuit
 * @param {string} deps.protocol  the OAuth deep-link scheme, dropped from the relaunch args
 */
async function relaunchApp({
  app,
  updateManager,
  protocol,
  env = process.env,
  argv = process.argv,
  pid = process.pid,
  spawn = (...args) => require("child_process").spawn(...args),
}) {
  if (env.NODE_ENV === "development") return app.quit();
  // Once Squirrel.Mac holds a downloaded update it installs it on this quit regardless
  // of any flag, so the updater owns that restart instead of racing app.relaunch().
  if (updateManager.hasStagedUpdate()) {
    const { success } = await updateManager.installUpdate().catch(() => ({ success: false }));
    if (success) return;
  }
  updateManager.deferInstallOnQuit();
  const { launcherPath, args } = getRelaunchOptions({
    argv,
    protocol,
    appImagePath: env.APPIMAGE,
  });
  if (launcherPath) {
    const waiter = getRelaunchWaiter({ launcherPath, args, pid });
    spawn(waiter.file, waiter.args, {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(launcherPath), // never inside the directory being removed
    }).unref();
  } else {
    app.relaunch({ args });
  }
  app.quit();
}

module.exports = { relaunchApp };
