#!/usr/bin/env node
/**
 * Self-hosting for this fork on Windows: a packaged Stable install as the daily
 * driver, and an opt-in Dev mode that runs the working tree. Both share the
 * installed app's data folder (%APPDATA%\open-whispr) and its file:// settings,
 * so only one runs at a time.
 *
 *   node scripts/selfhost.js status
 *   node scripts/selfhost.js dev [--restart] [--cdp <port>] [--accept-data-risk]
 *   node scripts/selfhost.js stable [--accept-data-risk]
 *   node scripts/selfhost.js ship [<ref>] [--test | --no-checks] [--dry-run] [--accept-data-risk]
 *   node scripts/selfhost.js stop
 *   node scripts/selfhost.js check <ref | release-id>
 *   node scripts/selfhost.js adopt-snapshot <snapshot-id>
 *   node scripts/selfhost.js init      # one-time setup (upstream remote, state, legacy backups)
 *
 * `ship` builds in a dedicated worktree (%LOCALAPPDATA%\OpenWhispr-selfhost\build)
 * with its own node_modules and resources/bin, so the working tree and a running
 * Dev mode are never touched until the short install window. Every ship backs up
 * the data folder and archives its installer; rollback is manual (`status` prints
 * the steps). A data guard refuses to run code on data that different code has
 * migrated. Decisions live in scripts/selfhost/core.js.
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("./selfhost/core");

const REPO = path.resolve(__dirname, "..");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const HOME = path.join(LOCALAPPDATA, "OpenWhispr-selfhost");
const BUILD_DIR = path.join(HOME, "build");
const RELEASES_DIR = path.join(HOME, "releases");
const BACKUPS_DIR = path.join(HOME, "backups");
const LOG_DIR = path.join(HOME, "logs");
const STATE_FILE = path.join(HOME, "state.json");
const LOCK_FILE = path.join(HOME, "selfhost.lock");
const LEGACY_DIR = path.join(LOCALAPPDATA, "OpenWhispr-dogfood");
const INSTALL_DIR = path.join(LOCALAPPDATA, "Programs", "OpenWhispr");
const INSTALLED_EXE = path.join(INSTALL_DIR, "OpenWhispr.exe");
const DATA_DIR = path.join(APPDATA, "open-whispr");
const QDRANT_DIR = path.join(os.homedir(), ".cache", "openwhispr", "qdrant-data");
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STARTUP_APPROVED_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const UPSTREAM_URL = "https://github.com/OpenWhispr/openwhispr.git";
// "prepare 1.10.2": the commit the official 1.10.2 installer was built from.
const OFFICIAL_COMMIT = "1c123e87";
const PINNED_STOCK_SNAPSHOT = "open-whispr-20261010-225051";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const NPM_CLI = path.join(
  path.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js"
);
const KEEP_RELEASES = 5;
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const STOP_TIMEOUT_MS = 20000;
const ALIVE_CHECK_MS = 10000;
const RENDERER_BUILD_TIMEOUT_MS = 300000;
const RENDERER_QUIET_MS = 3000;

const log = (message) => console.log(`[selfhost] ${message}`);
const warn = (message) => console.warn(`[selfhost] warning: ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- environment

// Variables a parent shell or agent may inject that must not leak into git,
// npm or the app (e.g. Copilot's git config injection, ELECTRON_RUN_AS_NODE).
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  for (const key of [
    "GIT_EXEC_PATH",
    "ELECTRON_RUN_AS_NODE",
    "NODE_ENV",
    "OPENWHISPR_CHANNEL",
    "OW_DEBUG_CDP",
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function run(command, args, { cwd = REPO, env = cleanEnv(), allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(
      `${path.basename(command)} ${args.join(" ")} failed (${result.status})\n${output}`
    );
  }
  return result;
}

const git = (args, cwd = REPO) => run("git", args, { cwd }).stdout.trim();
const gitOk = (args, cwd = REPO) => run("git", args, { cwd, allowFailure: true }).status === 0;

function gitShow(sha, filePath, cwd = REPO) {
  const result = run("git", ["show", `${sha}:${filePath}`], { cwd, allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

// A long step whose output goes to its own log file; failures show the tail.
function runLogged(label, command, args, { cwd, logFile, env = cleanEnv(), verbatim = false }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, "a");
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} ${label}\n`);
  const started = Date.now();
  log(`${label}...`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (result.error || result.status !== 0) {
    const tail = fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(-30).join("\n");
    throw new Error(`${label} failed after ${seconds}s (log: ${logFile})\n${tail}`);
  }
  log(`${label} done in ${seconds}s`);
}

const npmArgs = (...args) => [NPM_CLI, ...args];

// ---------------------------------------------------------------------- state

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readState() {
  return {
    writers: [],
    installedRelease: null,
    lastKnownGood: null,
    build: {},
    ...readJson(STATE_FILE, {}),
  };
}

const saveState = (state) => writeJson(STATE_FILE, state);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(command) {
  fs.mkdirSync(HOME, { recursive: true });
  const existing = readJson(LOCK_FILE, null);
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    throw new Error(`another selfhost ${existing.command} is running (pid ${existing.pid})`);
  }
  writeJson(LOCK_FILE, { pid: process.pid, command, at: new Date().toISOString() });
  return () => {
    if (readJson(LOCK_FILE, null)?.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  };
}

// ------------------------------------------------------------------ processes

function listProcesses() {
  const script = `
$repo = '${REPO.replace(/'/g, "''")}\\'
$install = '${INSTALL_DIR.replace(/'/g, "''")}\\'
$cmp = [StringComparison]::OrdinalIgnoreCase
$found = Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and ($_.ExecutablePath.StartsWith($repo, $cmp) -or $_.ExecutablePath.StartsWith($install, $cmp))) -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($repo, $cmp) -ge 0)
} | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
ConvertTo-Json -InputObject @($found) -Compress`;
  const out = run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]).stdout.trim();
  return out ? JSON.parse(out) : [];
}

function classify(processes = listProcesses()) {
  const lower = (s) => (s || "").toLowerCase();
  const under = (p, dir) => lower(p.ExecutablePath).startsWith(lower(dir) + "\\");
  const cmd = (p) => p.CommandLine || "";
  const isMain = (p) => !/--type=/.test(cmd(p));
  const stable = processes.filter((p) => under(p, INSTALL_DIR));
  const devHelpers = processes.filter((p) => under(p, path.join(REPO, "resources", "bin")));
  const devElectron = processes.filter(
    (p) => p.Name === "electron.exe" && under(p, path.join(REPO, "node_modules"))
  );
  const nodeFromRepo = processes.filter((p) => p.Name === "node.exe");
  return {
    stable,
    stableMains: stable.filter((p) => p.Name === "OpenWhispr.exe" && isMain(p)),
    devElectron,
    devMains: devElectron.filter(isMain),
    devHelpers,
    launchers: nodeFromRepo.filter((p) => /run-electron\.js/i.test(cmd(p))),
    watchers: nodeFromRepo.filter((p) => /vite[\\/]bin[\\/]vite\.js/i.test(cmd(p))),
  };
}

function killTree(pid) {
  spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(pid)], {
    windowsHide: true,
    stdio: "ignore",
  });
}

// Kill, then re-query until gone; orphaned helpers whose parent died are killed one by one.
async function stopVerified(label, select) {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  let killed = 0;
  for (;;) {
    const remaining = select(classify());
    if (remaining.length === 0) {
      if (killed) log(`${label} stopped`);
      return;
    }
    if (Date.now() > deadline) {
      const list = remaining.map((p) => `${p.Name}#${p.ProcessId}`).join(", ");
      throw new Error(`${label} did not stop: ${list}`);
    }
    for (const p of remaining) killTree(p.ProcessId);
    killed += remaining.length;
    await sleep(500);
  }
}

const stopStable = () => stopVerified("Stable", (c) => c.stable);
const stopDevApp = () =>
  stopVerified("Dev app", (c) => [...c.launchers, ...c.devElectron, ...c.devHelpers]);
const stopWatcher = () => stopVerified("renderer watcher", (c) => c.watchers);

async function stopEverything() {
  await stopDevApp();
  await stopWatcher();
  await stopStable();
}

async function confirmAlive(label, select) {
  await sleep(ALIVE_CHECK_MS);
  const mains = select(classify());
  if (mains.length === 0) {
    throw new Error(
      `${label} exited within ${ALIVE_CHECK_MS / 1000}s (lost the single-instance lock or crashed)`
    );
  }
  log(`${label} is running (pid ${mains.map((p) => p.ProcessId).join(", ")})`);
}

// ---------------------------------------------------------- native module ABI

function electronExe(root) {
  const pathFile = path.join(root, "node_modules", "electron", "path.txt");
  const relative = fs.readFileSync(pathFile, "utf8").trim();
  return path.join(root, "node_modules", "electron", "dist", relative);
}

function sqliteLoadsInElectron(root) {
  const probe = spawnSync(
    electronExe(root),
    ["-e", "const D=require('better-sqlite3');new D(':memory:').close()"],
    { cwd: root, env: cleanEnv({ ELECTRON_RUN_AS_NODE: "1" }), windowsHide: true }
  );
  return probe.status === 0;
}

// `npm test` rebuilds better-sqlite3 for Node, and @electron/rebuild then skips it
// because build/Release/.forge-meta still says Electron.
function ensureSqliteForElectron(root, logFile) {
  if (sqliteLoadsInElectron(root)) return;
  log("better-sqlite3 is not built for Electron; rebuilding");
  fs.rmSync(path.join(root, "node_modules", "better-sqlite3", "build", "Release", ".forge-meta"), {
    force: true,
  });
  const args = [path.join(root, "node_modules", "electron-builder", "cli.js"), "install-app-deps"];
  if (logFile) runLogged("install-app-deps", process.execPath, args, { cwd: root, logFile });
  else run(process.execPath, args, { cwd: root });
  if (!sqliteLoadsInElectron(root))
    throw new Error("better-sqlite3 still does not load in Electron");
}

// ------------------------------------------------------------- data guarding

function dataOfCommit(sha) {
  return core.dataHashes((filePath) => gitShow(sha, filePath));
}

function dataOfWorkingTree() {
  return core.dataHashes((filePath) => {
    const full = path.join(REPO, filePath);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  });
}

function commitTarget(sha, label) {
  return { sha, dirty: false, data: dataOfCommit(sha), label };
}

function devTarget() {
  const sha = git(["rev-parse", "HEAD"]);
  const data = dataOfWorkingTree();
  const dirty = core.changedDataPaths(dataOfCommit(sha), data).length > 0;
  return { sha, dirty, data, label: "Dev" };
}

function isAncestor(a, b) {
  return gitOk(["merge-base", "--is-ancestor", a, b]);
}

function runGuard(target, { acceptDataRisk } = {}) {
  const state = readState();
  const decision = core.guardDecision({ writers: state.writers, target, isAncestor });
  if (decision.allowed) return;
  const message = core.renderGuardRefusal({
    targetLabel: core.describeWriter(target),
    blockers: decision.blockers,
  });
  if (!acceptDataRisk) throw new Error(message);
  warn(`${message}\n(continuing: --accept-data-risk)`);
}

function recordWriter(target) {
  const state = readState();
  const { label, sha, dirty, data } = target;
  state.writers = core.addWriter(state.writers, { sha, dirty, data, label });
  saveState(state);
}

// ------------------------------------------------------- installed app / login

function readInstalledPackage() {
  const asarPath = path.join(INSTALL_DIR, "resources", "app.asar");
  if (!fs.existsSync(asarPath)) return null;
  const asar = require(path.join(REPO, "node_modules", "@electron", "asar"));
  return JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
}

function installedTarget() {
  const pkg = readInstalledPackage();
  if (!pkg) throw new Error(`no installed app at ${INSTALL_DIR}`);
  if (pkg.selfBuiltCommit) return commitTarget(pkg.selfBuiltCommit, `Stable ${pkg.version}`);
  return commitTarget(git(["rev-parse", OFFICIAL_COMMIT]), `official ${pkg.version}`);
}

function regQuery(key, value) {
  const result = run("reg.exe", ["query", key, "/v", value], { allowFailure: true });
  if (result.status !== 0) return null;
  const line = result.stdout.split(/\r?\n/).find((l) => /\bREG_(SZ|BINARY|EXPAND_SZ)\b/.test(l));
  return line ? line.split(/REG_(?:SZ|BINARY|EXPAND_SZ)/)[1].trim() : null;
}

function ensureLoginEntry() {
  const wanted = core.runEntryValue(INSTALLED_EXE);
  if (regQuery(RUN_KEY, core.RUN_VALUE) !== wanted) {
    run("reg.exe", ["add", RUN_KEY, "/v", core.RUN_VALUE, "/t", "REG_SZ", "/d", wanted, "/f"]);
    log(`login entry ${core.RUN_VALUE} → ${wanted}`);
  }
  if (regQuery(RUN_KEY, core.LEGACY_DOGFOOD_RUN_VALUE) !== null) {
    run("reg.exe", ["delete", RUN_KEY, "/v", core.LEGACY_DOGFOOD_RUN_VALUE, "/f"]);
    log(`removed the legacy "${core.LEGACY_DOGFOOD_RUN_VALUE}" login entry`);
  }
  fs.rmSync(path.join(LEGACY_DIR, "start-at-login.vbs"), { force: true });
  if (core.isStartupApprovedDisabled(regQuery(STARTUP_APPROVED_KEY, core.RUN_VALUE))) {
    warn("OpenWhispr is disabled in Task Manager → Startup apps, so it won't start at login");
  }
}

function startStableProcess() {
  spawn(INSTALLED_EXE, ["--hidden"], {
    cwd: INSTALL_DIR,
    env: cleanEnv(),
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  }).unref();
}

// ------------------------------------------------------------------ Dev mode

const DIST_INDEX = path.join(REPO, "src", "dist", "index.html");
const WATCH_LOG = path.join(LOG_DIR, "renderer-watch.log");

function openAppendLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `\n===== ${new Date().toISOString()} start\n`);
  return fs.openSync(file, "a");
}

function rendererSettled() {
  if (!fs.existsSync(DIST_INDEX) || !fs.existsSync(WATCH_LOG)) return false;
  return core.rendererBuildSettled(fs.readFileSync(WATCH_LOG, "utf8"));
}

async function ensureRendererWatch() {
  if (classify().watchers.length === 0) {
    const out = openAppendLog(WATCH_LOG);
    spawn(
      process.execPath,
      [path.join(REPO, "node_modules", "vite", "bin", "vite.js"), "build", "--watch"],
      {
        cwd: path.join(REPO, "src"),
        env: cleanEnv({ NODE_ENV: "production" }),
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out],
      }
    ).unref();
    log(`renderer watcher started (log: ${WATCH_LOG})`);
  }
  const deadline = Date.now() + RENDERER_BUILD_TIMEOUT_MS;
  let lastSize = -1;
  let quietSince = Date.now();
  for (;;) {
    const size = fs.existsSync(WATCH_LOG) ? fs.statSync(WATCH_LOG).size : 0;
    if (size !== lastSize) {
      lastSize = size;
      quietSince = Date.now();
    }
    if (rendererSettled() && Date.now() - quietSince >= RENDERER_QUIET_MS) return;
    if (Date.now() > deadline) throw new Error(`renderer build did not settle; see ${WATCH_LOG}`);
    await sleep(500);
  }
}

function startDevElectron({ cdpPort }) {
  const logFile = path.join(LOG_DIR, "dev-electron.log");
  const offset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const out = openAppendLog(logFile);
  const env = cleanEnv({
    NODE_ENV: "production",
    OPENWHISPR_CHANNEL: "production",
    OPENWHISPR_LOG_LEVEL: process.env.OPENWHISPR_LOG_LEVEL || "debug",
  });
  if (cdpPort) env.OW_DEBUG_CDP = String(cdpPort);
  spawn(process.execPath, [path.join(REPO, "scripts", "run-electron.js")], {
    cwd: REPO,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  }).unref();
  log(`Dev Electron starting (log: ${logFile})`);
  return { logFile, offset };
}

function readFrom(file, offset) {
  const fd = fs.openSync(file, "r");
  try {
    const length = Math.max(0, fs.fstatSync(fd).size - offset);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

async function commandDev(options) {
  const running = classify();
  if (running.devMains.length && !options.restart) {
    log("Dev is already running; use `dev --restart` to apply main-process changes");
    return;
  }
  const target = devTarget();
  runGuard(target, options);
  await stopStable();
  ensureSqliteForElectron(REPO);
  if (options.restart) await stopDevApp();
  await ensureRendererWatch();
  const started = startDevElectron(options);
  await confirmAlive("Dev", (c) => c.devMains);
  if (core.devStartFailed(readFrom(started.logFile, started.offset))) {
    throw new Error(
      `Dev is running but could not load its window (see ${started.logFile}); ` +
        "run `selfhost dev --restart`, or `selfhost stable` to go back"
    );
  }
  recordWriter(target);
}

// ---------------------------------------------------------------- Stable mode

async function commandStable(options) {
  const target = installedTarget();
  runGuard(target, options);
  await stopDevApp();
  await stopWatcher();
  if (classify().stableMains.length) {
    log("Stable is already running");
  } else {
    startStableProcess();
    await confirmAlive("Stable", (c) => c.stableMains);
  }
  recordWriter(target);
}

// ----------------------------------------------------------------------- ship

function resolveCommit(ref) {
  return git(["rev-parse", "--verify", `${ref}^{commit}`]);
}

function upstreamRef() {
  if (!gitOk(["rev-parse", "--verify", "upstream/HEAD"])) {
    throw new Error("no upstream remote; run `node scripts/selfhost.js init` once");
  }
  return "upstream/HEAD";
}

function preflight(sha) {
  if (
    !gitShow(sha, "electron-builder.local-win.json") ||
    !/selfBuilt/.test(gitShow(sha, "src/updater.js") || "")
  ) {
    throw new Error(
      `${sha.slice(0, 8)} predates self-host support (no electron-builder.local-win.json or updater guard); ` +
        "a build of it would offer upstream updates"
    );
  }
  const base = git(["merge-base", sha, upstreamRef()]);
  const changed = git([
    "diff",
    "--name-only",
    base,
    sha,
    "--",
    ...core.DOWNLOAD_FIRST_HELPER_SOURCES,
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  if (changed.length) {
    throw new Error(
      `this commit changes ${changed.join(", ")}, but the build downloads those helpers from upstream ` +
        "releases, so the change would not ship. Make their build scripts compile from source first."
    );
  }
}

function vcvarsPath() {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (fs.existsSync(vswhere)) {
    const install = run(vswhere, [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ]).stdout.trim();
    const candidate = install && path.join(install, "VC", "Auxiliary", "Build", "vcvars64.bat");
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error("MSVC (vcvars64.bat) not found; the native helpers must compile from source");
}

function prepareBuildCheckout(sha, logFile) {
  if (!fs.existsSync(path.join(BUILD_DIR, ".git"))) {
    fs.mkdirSync(HOME, { recursive: true });
    runLogged("create build worktree", "git", ["worktree", "add", "--detach", BUILD_DIR, sha], {
      cwd: REPO,
      logFile,
    });
  }
  git(["checkout", "--detach", "--force", sha], BUILD_DIR);
  git(["clean", "-fd"], BUILD_DIR);
  const envFile = path.join(REPO, ".env");
  if (fs.existsSync(envFile)) fs.copyFileSync(envFile, path.join(BUILD_DIR, ".env"));
  else fs.rmSync(path.join(BUILD_DIR, ".env"), { force: true });
}

// npm ci deletes node_modules, so Electron's and FFmpeg's downloaded binaries go
// too (npm blocks their install scripts); the fingerprint is saved only once the
// whole operation succeeded.
function prepareDependencies(logFile) {
  const state = readState();
  const lockId = git(["rev-parse", "HEAD:package-lock.json"], BUILD_DIR);
  const hasModules = fs.existsSync(path.join(BUILD_DIR, "node_modules", "electron", "path.txt"));
  if (state.build.depsFingerprint === lockId && hasModules) {
    ensureSqliteForElectron(BUILD_DIR, logFile);
    return;
  }
  state.build.depsFingerprint = null;
  saveState(state);
  runLogged("npm ci", process.execPath, npmArgs("ci", `--registry=${NPM_REGISTRY}`), {
    cwd: BUILD_DIR,
    logFile,
  });
  for (const script of ["electron/install.js", "ffmpeg-static/install.js"]) {
    runLogged(`node ${script}`, process.execPath, [path.join(BUILD_DIR, "node_modules", script)], {
      cwd: BUILD_DIR,
      logFile,
    });
  }
  ensureSqliteForElectron(BUILD_DIR, logFile);
  const next = readState();
  next.build.depsFingerprint = lockId;
  saveState(next);
}

// The build scripts trust whatever is already in resources/bin (timestamps,
// skipped version pins), so it is rebuilt from scratch whenever its inputs change.
function refreshHelpersIfNeeded() {
  const fingerprint = core.helperFingerprint(git(["ls-tree", "-r", "HEAD"], BUILD_DIR));
  const binDir = path.join(BUILD_DIR, "resources", "bin");
  const state = readState();
  if (state.build.helperFingerprint === fingerprint && fs.existsSync(binDir)) {
    return { fingerprint, wiped: false };
  }
  fs.rmSync(binDir, { recursive: true, force: true });
  state.build.helperFingerprint = null;
  saveState(state);
  log("helper binaries will be rebuilt for this commit");
  return { fingerprint, wiped: true };
}

function runGate(options, logFile) {
  if (options.noChecks) {
    warn("skipping typecheck and lint (--no-checks)");
    return;
  }
  runLogged("typecheck", process.execPath, npmArgs("run", "typecheck"), {
    cwd: BUILD_DIR,
    logFile,
  });
  runLogged("lint", process.execPath, npmArgs("run", "lint"), { cwd: BUILD_DIR, logFile });
  if (!options.test) return;
  runLogged(
    "rebuild better-sqlite3 for Node",
    process.execPath,
    npmArgs("rebuild", "better-sqlite3"),
    {
      cwd: BUILD_DIR,
      logFile,
    }
  );
  try {
    runLogged("tests", process.execPath, npmArgs("test"), {
      cwd: BUILD_DIR,
      logFile,
      env: cleanEnv({ REQUIRE_DB_TESTS: "1" }),
    });
  } finally {
    ensureSqliteForElectron(BUILD_DIR, logFile);
  }
}

function buildInstaller(sha, logs) {
  const distDir = path.join(BUILD_DIR, "dist");
  fs.rmSync(distDir, { recursive: true, force: true });
  const node = `"${process.execPath}"`;
  const npm = `${node} "${NPM_CLI}"`;
  const prebuild = `call "${vcvarsPath()}" >nul && ${npm} run prebuild:win`;
  runLogged(
    "prebuild (native helpers + downloads)",
    "cmd.exe",
    ["/d", "/s", "/c", `"${prebuild}"`],
    {
      cwd: BUILD_DIR,
      logFile: logs.prebuild,
      verbatim: true,
    }
  );
  runLogged("renderer build", process.execPath, npmArgs("run", "build:renderer"), {
    cwd: BUILD_DIR,
    logFile: logs.build,
  });
  runLogged(
    "electron-builder",
    process.execPath,
    [
      path.join(BUILD_DIR, "node_modules", "electron-builder", "cli.js"),
      "--win",
      "--config",
      "electron-builder.local-win.json",
      "-c.npmRebuild=false",
      `-c.extraMetadata.selfBuiltCommit=${sha}`,
    ],
    { cwd: BUILD_DIR, logFile: logs.build }
  );
  const installers = fs
    .readdirSync(distDir)
    .filter((name) => /setup.*\.exe$/i.test(name))
    .map((name) => path.join(distDir, name));
  if (installers.length !== 1)
    throw new Error(`expected one installer in ${distDir}, found ${installers.length}`);
  return installers[0];
}

function robocopy(from, to) {
  const result = spawnSync(
    "robocopy.exe",
    [from, to, "/MIR", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"],
    { windowsHide: true, encoding: "utf8" }
  );
  // robocopy: 0–7 success (bit flags), 8+ failure.
  if (result.error || result.status >= 8) {
    throw new Error(`robocopy ${from} → ${to} failed (${result.status})\n${result.stdout || ""}`);
  }
}

function takeSnapshot(id, reason) {
  const dir = path.join(BACKUPS_DIR, id);
  robocopy(DATA_DIR, path.join(dir, "data"));
  writeJson(path.join(dir, "snapshot.json"), {
    id,
    reason,
    createdAt: new Date().toISOString(),
    writers: readState().writers,
  });
  log(`data snapshot ${id}`);
  return id;
}

async function runInstaller(installer) {
  log("installing (silent)...");
  const child = spawn(installer, ["/S", "/currentuser"], { windowsHide: true, stdio: "ignore" });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killTree(child.pid);
      reject(
        new Error(
          `the installer did not finish within ${INSTALL_TIMEOUT_MS / 60000} min; see \`selfhost status\` for rollback steps`
        )
      );
    }, INSTALL_TIMEOUT_MS);
    child.on("error", reject);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  if (code !== 0) throw new Error(`the installer exited with ${code}`);
}

function newestLog(after) {
  const dir = path.join(DATA_DIR, "logs");
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).mtimeMs >= after)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

async function verifyStable(sha, startedAt) {
  const problems = [];
  const pkg = readInstalledPackage();
  if (pkg?.selfBuiltCommit !== sha || pkg?.selfBuilt !== true) {
    problems.push(
      `installed app.asar has selfBuiltCommit ${pkg?.selfBuiltCommit}, expected ${sha}`
    );
  }
  await confirmAlive("Stable", (c) => c.stableMains).catch((error) => problems.push(error.message));

  let logChecked = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const file = newestLog(startedAt);
    if (file && fs.readFileSync(file, "utf8").includes(sha)) {
      logChecked = true;
      break;
    }
    await sleep(1000);
  }
  if (!logChecked) {
    if (newestLog(startedAt))
      problems.push("the new log's System Info line does not show the shipped commit");
    else warn("no new log file (file logging is off), so the System Info check was skipped");
  }

  const listenerDeadline = Date.now() + 20000;
  let listener = false;
  while (!listener && Date.now() < listenerDeadline) {
    listener = classify().stable.some((p) =>
      /windows-key-listener\.exe$/i.test(p.ExecutablePath || "")
    );
    if (!listener) await sleep(1000);
  }
  if (!listener) problems.push("the push-to-talk key listener is not running");
  return problems;
}

function listReleases() {
  if (!fs.existsSync(RELEASES_DIR)) return [];
  return fs
    .readdirSync(RELEASES_DIR)
    .map((id) => readJson(path.join(RELEASES_DIR, id, "release.json"), null))
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function listSnapshots() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  const pinned = new Set([PINNED_STOCK_SNAPSHOT]);
  return fs
    .readdirSync(BACKUPS_DIR)
    .map((id) => {
      const meta = readJson(path.join(BACKUPS_DIR, id, "snapshot.json"), null);
      return meta ? { ...meta, id, pinned: pinned.has(id) || meta.pinned === true } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.id.localeCompare(a.id));
}

function prune() {
  const state = readState();
  const pinned = [state.installedRelease, state.lastKnownGood, PINNED_STOCK_SNAPSHOT];
  for (const id of core.selectPrunable(
    listReleases().map((r) => r.id),
    { keep: KEEP_RELEASES, pinned }
  )) {
    fs.rmSync(path.join(RELEASES_DIR, id), { recursive: true, force: true });
    log(`pruned release ${id}`);
  }
  const snapshotIds = listSnapshots()
    .filter((s) => !s.pinned)
    .map((s) => s.id);
  for (const id of core.selectPrunable(snapshotIds, { keep: KEEP_RELEASES, pinned })) {
    fs.rmSync(path.join(BACKUPS_DIR, id), { recursive: true, force: true });
    log(`pruned snapshot ${id}`);
  }
}

async function commandShip(options) {
  const startedAt = Date.now();
  const ref = options.positional[0] || "HEAD";
  const sha = resolveCommit(ref);
  const subject = git(["log", "-1", "--format=%s", sha]);
  const branch = ref === "HEAD" ? git(["rev-parse", "--abbrev-ref", "HEAD"]) : ref;
  log(`shipping ${sha.slice(0, 8)} "${subject}" (${branch})`);
  if (git(["status", "--porcelain"]))
    log("note: uncommitted changes in the working tree are not shipped");

  preflight(sha);
  const target = commitTarget(sha, "Stable");
  runGuard(target, options);
  if (!fs.existsSync(INSTALLED_EXE))
    throw new Error(`no installed app at ${INSTALL_DIR} to install over`);

  const id = core.releaseId(new Date(), sha);
  if (options.dryRun) {
    log(
      `dry run: would build ${id} in ${BUILD_DIR}, gate ${options.noChecks ? "none" : options.test ? "typecheck + lint + tests" : "typecheck + lint"}, then stop both modes, snapshot ${DATA_DIR}, install, and verify`
    );
    return;
  }

  const logDir = path.join(LOG_DIR, id);
  const logs = {
    setup: path.join(logDir, "setup.log"),
    gate: path.join(logDir, "gate.log"),
    prebuild: path.join(logDir, "prebuild.log"),
    build: path.join(logDir, "build.log"),
  };
  log(`build logs: ${logDir}`);

  prepareBuildCheckout(sha, logs.setup);
  prepareDependencies(logs.setup);
  const helpers = refreshHelpersIfNeeded();
  runGate(options, logs.gate);
  ensureSqliteForElectron(BUILD_DIR, logs.setup);
  const installer = buildInstaller(sha, logs);
  if (helpers.wiped) {
    const notCompiled = core.helpersNotCompiled(fs.readFileSync(logs.prebuild, "utf8"));
    if (notCompiled.length) {
      throw new Error(
        `${notCompiled.join(", ")} did not compile from source (see ${logs.prebuild})`
      );
    }
  }
  const state = readState();
  state.build.helperFingerprint = helpers.fingerprint;
  saveState(state);

  const releaseDir = path.join(RELEASES_DIR, id);
  fs.mkdirSync(releaseDir, { recursive: true });
  const archived = path.join(releaseDir, path.basename(installer));
  fs.copyFileSync(installer, archived);
  const release = {
    id,
    sha,
    branch,
    subject,
    builtAt: new Date().toISOString(),
    installer: archived,
    predecessor: state.installedRelease,
    snapshot: null,
    verified: false,
  };
  writeJson(path.join(releaseDir, "release.json"), release);
  const buildSeconds = Math.round((Date.now() - startedAt) / 1000);
  log(`built ${id} in ${buildSeconds}s`);

  runGuard(target, options);
  const downStartedAt = Date.now();
  await stopEverything();
  release.snapshot = takeSnapshot(id, `before installing ${id}`);
  writeJson(path.join(releaseDir, "release.json"), release);
  await runInstaller(archived);
  ensureLoginEntry();
  const launchedAt = Date.now();
  startStableProcess();
  const problems = await verifyStable(sha, launchedAt);
  recordWriter(target);

  const next = readState();
  next.installedRelease = id;
  release.verified = problems.length === 0;
  if (release.verified) next.lastKnownGood = id;
  saveState(next);
  writeJson(path.join(releaseDir, "release.json"), release);
  prune();

  const total = Math.round((Date.now() - startedAt) / 1000);
  const down = Math.round((launchedAt - downStartedAt) / 1000);
  if (problems.length) {
    throw new Error(`installed ${id}, but verification failed:\n  - ${problems.join("\n  - ")}`);
  }
  log(`✔ shipped ${id}: ${total}s end to end, ${down}s without dictation, Stable verified`);
}

// ------------------------------------------------------------------- status

function describeMode(c) {
  if (c.stableMains.length)
    return `Stable (pid ${c.stableMains.map((p) => p.ProcessId).join(", ")})`;
  if (c.devMains.length) return `Dev (pid ${c.devMains.map((p) => p.ProcessId).join(", ")})`;
  return "not running";
}

function commandStatus() {
  const c = classify();
  log(
    `running: ${describeMode(c)}; renderer watcher: ${c.watchers.length ? "running" : "stopped"}`
  );
  const head = git(["rev-parse", "HEAD"]);
  let pkg = null;
  try {
    pkg = readInstalledPackage();
  } catch (error) {
    warn(`could not read the installed app: ${error.message}`);
  }
  if (!pkg) log(`installed: none at ${INSTALL_DIR}`);
  else if (pkg.selfBuiltCommit) {
    const same = pkg.selfBuiltCommit === head ? "same as HEAD" : `HEAD is ${head.slice(0, 8)}`;
    log(`installed: self-built ${pkg.version} @ ${pkg.selfBuiltCommit.slice(0, 8)} (${same})`);
  } else log(`installed: official ${pkg.version}`);

  log(`login entry: ${regQuery(RUN_KEY, core.RUN_VALUE) || "none"}`);
  if (regQuery(RUN_KEY, core.LEGACY_DOGFOOD_RUN_VALUE))
    log(`legacy login entry: "${core.LEGACY_DOGFOOD_RUN_VALUE}" (removed by the first ship)`);
  if (core.isStartupApprovedDisabled(regQuery(STARTUP_APPROVED_KEY, core.RUN_VALUE))) {
    warn("disabled in Task Manager → Startup apps");
  }

  const state = readState();
  log(
    `data writers: ${state.writers.map(core.describeWriter).join(", ") || "none recorded (run init)"}`
  );
  const releases = listReleases();
  for (const r of releases.slice(-KEEP_RELEASES).reverse()) {
    const flags = [
      r.id === state.installedRelease && "installed",
      r.id === state.lastKnownGood && "last known good",
      !r.verified && "unverified",
    ].filter(Boolean);
    log(
      `release ${r.id} ${r.sha.slice(0, 8)} ${r.subject}${flags.length ? ` [${flags.join(", ")}]` : ""}`
    );
  }
  if (fs.existsSync(path.join(BUILD_DIR, ".git"))) {
    log(`build checkout: ${BUILD_DIR} @ ${git(["rev-parse", "--short", "HEAD"], BUILD_DIR)}`);
  }
  const installedIndex = releases.findIndex((r) => r.id === state.installedRelease);
  const previous =
    releases
      .slice(0, Math.max(0, installedIndex))
      .reverse()
      .find((r) => r.verified) || null;
  console.log(
    core.renderRollbackSteps({
      release: previous,
      snapshots: listSnapshots(),
      paths: { dataDir: DATA_DIR, backupsDir: BACKUPS_DIR, qdrantDir: QDRANT_DIR },
    })
  );
}

// ------------------------------------------------------- check / adopt / init

function commandCheck(options) {
  const ref = options.positional[0];
  if (!ref) throw new Error("usage: selfhost check <ref | release-id>");
  const release = listReleases().find((r) => r.id === ref);
  const sha = release ? release.sha : resolveCommit(ref);
  const target = commitTarget(sha, release ? `release ${release.id}` : ref);
  const decision = core.guardDecision({ writers: readState().writers, target, isAncestor });
  if (decision.allowed) {
    log(`${core.describeWriter(target)} may run on the current data`);
    return;
  }
  console.log(
    core.renderGuardRefusal({
      targetLabel: core.describeWriter(target),
      blockers: decision.blockers,
    })
  );
  process.exitCode = 1;
}

function commandAdoptSnapshot(options) {
  const id = options.positional[0];
  const meta = id && readJson(path.join(BACKUPS_DIR, id, "snapshot.json"), null);
  if (!meta) throw new Error(`no snapshot "${id}" in ${BACKUPS_DIR}`);
  const state = readState();
  state.writers = meta.writers || [];
  saveState(state);
  log(`data writers reset to snapshot ${id}: ${state.writers.map(core.describeWriter).join(", ")}`);
}

function migrateLegacyBackups(officialWriter) {
  const legacyBackups = path.join(LEGACY_DIR, "backups");
  if (!fs.existsSync(legacyBackups)) return;
  for (const name of fs.readdirSync(legacyBackups)) {
    const dest = path.join(BACKUPS_DIR, name);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    fs.mkdirSync(dest);
    fs.renameSync(path.join(legacyBackups, name), path.join(dest, "data"));
    const stock = name === PINNED_STOCK_SNAPSHOT;
    writeJson(path.join(dest, "snapshot.json"), {
      id: name,
      reason: stock ? "official 1.10.2 data, taken before Dev mode first ran" : "dogfood backup",
      createdAt: fs.statSync(path.join(dest, "data")).mtime.toISOString(),
      pinned: stock,
      writers: stock ? [officialWriter] : [],
    });
    log(`moved legacy backup ${name}${stock ? " (pinned)" : ""}`);
  }
}

function commandInit() {
  fs.mkdirSync(HOME, { recursive: true });
  if (!gitOk(["remote", "get-url", "upstream"])) {
    git(["remote", "add", "upstream", UPSTREAM_URL]);
    log(`added remote upstream → ${UPSTREAM_URL}`);
  }
  if (!gitOk(["rev-parse", "--verify", "upstream/HEAD"])) {
    run("git", ["fetch", "upstream", "--no-tags"], { cwd: REPO });
    git(["remote", "set-head", "upstream", "--auto"]);
    log("fetched upstream");
  }

  const officialSha = git(["rev-parse", `${OFFICIAL_COMMIT}^{commit}`]);
  const officialWriter = {
    ...commitTarget(officialSha, "official 1.10.2"),
    at: new Date().toISOString(),
  };
  migrateLegacyBackups(officialWriter);

  const state = readState();
  if (state.writers.length === 0) {
    // Dev mode has run this checkout's commits on the live data since 2026-10-10;
    // their data code matches HEAD's (none of them touched the data paths).
    const head = git(["rev-parse", "HEAD"]);
    state.writers = core.addWriter([officialWriter], commitTarget(head, "Dev (dogfood)"));
    saveState(state);
    log(`seeded data writers: ${state.writers.map(core.describeWriter).join(", ")}`);
  }
  log("init done");
}

// ---------------------------------------------------------------------- main

async function main() {
  if (process.platform !== "win32") throw new Error("selfhost.js is Windows-only");
  const { command, options } = core.parseArgs(process.argv.slice(2));
  const mutating = new Set(["dev", "stable", "ship", "stop", "adopt-snapshot", "init"]);
  const release = mutating.has(command) && !options.dryRun ? acquireLock(command) : () => {};
  try {
    switch (command) {
      case "status":
        return commandStatus();
      case "dev":
        return await commandDev(options);
      case "stable":
        return await commandStable(options);
      case "ship":
        return await commandShip(options);
      case "stop":
        return await stopEverything();
      case "check":
        return commandCheck(options);
      case "adopt-snapshot":
        return commandAdoptSnapshot(options);
      case "init":
        return commandInit();
      default:
        throw new Error(`unknown command "${command}"`);
    }
  } finally {
    release();
  }
}

main().catch((error) => {
  console.error(`[selfhost] ${error.message}`);
  process.exit(1);
});
