const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { relaunchApp } = require("../../src/helpers/appRelaunch");

// The restart Settings (relaunch-app) and the tray share, without Electron:
// every call it makes on the app, the updater and the spawned waiter.
function restart({ env = {}, staged = false, install = { success: true }, argv } = {}) {
  const calls = [];
  const app = {
    quit: () => calls.push(["quit"]),
    relaunch: (options) => calls.push(["relaunch", options]),
  };
  const updateManager = {
    hasStagedUpdate: () => {
      calls.push(["hasStagedUpdate"]);
      return staged;
    },
    installUpdate: async () => {
      calls.push(["installUpdate"]);
      if (install instanceof Error) throw install;
      return install;
    },
    deferInstallOnQuit: () => calls.push(["deferInstallOnQuit"]),
  };
  const spawn = (file, args, options) => {
    calls.push(["spawn", file, args, options]);
    return { unref: () => calls.push(["unref"]) };
  };
  const done = relaunchApp({
    app,
    updateManager,
    protocol: "openwhispr",
    env,
    argv: argv ?? ["/opt/OpenWhispr/openwhispr"],
    pid: 4242,
    spawn,
  });
  return { calls, done };
}

test("under npm run dev it only quits: the Vite server dies with Electron", async () => {
  const { calls, done } = restart({ env: { NODE_ENV: "development" }, staged: true });
  await done;
  assert.deepEqual(calls, [["quit"]]);
});

test("a staged update restarts through the updater", async () => {
  const { calls, done } = restart({ staged: true });
  await done;
  assert.deepEqual(calls, [["hasStagedUpdate"], ["installUpdate"]], "the updater quits");
});

test("an update that can't install falls back to a plain relaunch", async () => {
  for (const install of [{ success: false }, new Error("no update")]) {
    const { calls, done } = restart({ staged: true, install });
    await done;
    assert.deepEqual(calls, [
      ["hasStagedUpdate"],
      ["installUpdate"],
      ["deferInstallOnQuit"],
      ["relaunch", { args: [] }],
      ["quit"],
    ]);
  }
});

test("a plain relaunch drops --hidden and a deep link, and defers the update install", async () => {
  const { calls, done } = restart({
    argv: [
      "/opt/OpenWhispr/openwhispr",
      "--hidden",
      "openwhispr://auth?code=1",
      "--log-level=debug",
    ],
  });
  await done;
  assert.deepEqual(calls, [
    ["hasStagedUpdate"],
    ["deferInstallOnQuit"],
    ["relaunch", { args: ["--log-level=debug"] }],
    ["quit"],
  ]);
});

test("an AppImage is started again from outside, once this process is gone", async () => {
  const appImage = "/home/me/Apps/OpenWhispr.AppImage";
  const { calls, done } = restart({
    env: { APPIMAGE: appImage },
    argv: ["/tmp/.mount_x/openwhispr", "--hidden"],
  });
  await done;
  assert.deepEqual(calls, [
    ["hasStagedUpdate"],
    ["deferInstallOnQuit"],
    [
      "spawn",
      "/bin/sh",
      ["-c", 'while kill -0 "$0"; do sleep 0.2; done; exec "$@"', "4242", appImage],
      { detached: true, stdio: "ignore", cwd: path.dirname(appImage) },
    ],
    ["unref"],
    ["quit"],
  ]);
});
