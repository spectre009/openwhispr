// What the running app was built from, for System › This build (`get-build-info`).
//
// A packaged app reads build-info.json, which scripts/afterPack.js stamps next to
// app.asar at packaging time; anything missing or malformed in it reads as
// unknown. A run from source (selfhost Dev, `npm run dev`) asks git about the
// working tree instead, once, on the first request. Electron is required lazily,
// so afterPack and selfhost.js share the file name, the parsing and the git rules.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const BUILD_INFO_FILE = "build-info.json";
const BUILD_SOURCES = ["selfhost", "npm"];
const GIT_TIMEOUT_MS = 5000;
const MAX_SUBJECT_CHARS = 200;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// The main process's start (wall clock), however late this module loads.
const PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);

// Variables a parent shell or agent may inject (Copilot's git config injection,
// a hook's GIT_DIR) that would point git somewhere other than the folder asked
// about. GIT_OPTIONAL_LOCKS=0 keeps `git status` off the index lock, so it never
// gets in the way of a commit in the same tree.
const STRIPPED_ENV = new Set([
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXEC_PATH",
  "GIT_TERMINAL_PROMPT",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ELECTRON_RUN_AS_NODE",
]);

function gitEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    const name = key.toUpperCase();
    if (STRIPPED_ENV.has(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) continue;
    clean[key] = value;
  }
  clean.GIT_OPTIONAL_LOCKS = "0";
  return clean;
}

const isIsoUtc = (value) =>
  typeof value === "string" && ISO_UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
const shaOrNull = (value) => (typeof value === "string" && SHA_PATTERN.test(value) ? value : null);
const booleanOrNull = (value) => (typeof value === "boolean" ? value : null);

// build-info.json's fields; each one that isn't what afterPack writes reads as
// null (unknown). Null when the text isn't a JSON object at all.
function parseBuildInfo(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return {
    builtAt: isIsoUtc(data.builtAt) ? data.builtAt : null,
    commit: shaOrNull(data.commit),
    dirty: booleanOrNull(data.dirty),
    source: BUILD_SOURCES.includes(data.source) ? data.source : null,
    version: typeof data.version === "string" && data.version ? data.version : null,
  };
}

// Resolves to git's stdout, or null when git is missing, fails or times out.
function runGit(args, cwd, exec = execFile) {
  return new Promise((resolve) => {
    try {
      exec(
        "git",
        args,
        {
          cwd,
          env: gitEnv(),
          encoding: "utf8",
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout) => resolve(error ? null : String(stdout ?? ""))
      );
    } catch {
      resolve(null);
    }
  });
}

// HEAD of the working tree at `cwd`, whether tracked files have uncommitted
// changes, and the commit's subject; nulls where git can't say.
async function readWorkingTree(cwd, exec = execFile) {
  const commit = shaOrNull((await runGit(["rev-parse", "HEAD"], cwd, exec))?.trim());
  if (!commit) return { commit: null, dirty: null, commitSubject: null };
  const [status, subject] = await Promise.all([
    runGit(["status", "--porcelain", "--untracked-files=no"], cwd, exec),
    runGit(["log", "-1", "--format=%s", commit], cwd, exec),
  ]);
  return {
    commit,
    dirty: status === null ? null : status.trim().length > 0,
    commitSubject: subject?.trim().slice(0, MAX_SUBJECT_CHARS) || null,
  };
}

// The user profile prefix becomes %USERPROFILE% (~ outside Windows), so a path
// shown or copied for a bug report doesn't carry the user name.
function maskUserProfile(filePath, homeDir = os.homedir(), platform = process.platform) {
  if (typeof filePath !== "string" || !filePath) return null;
  const home = typeof homeDir === "string" ? homeDir.replace(/[\\/]+$/, "") : "";
  if (!home) return filePath;
  const windows = platform === "win32";
  const head = filePath.slice(0, home.length);
  const rest = filePath.slice(home.length);
  const sameHead = windows ? head.toLowerCase() === home.toLowerCase() : head === home;
  const atBoundary = rest === "" || (windows ? /^[\\/]/ : /^\//).test(rest);
  if (!sameHead || !atBoundary) return filePath;
  return `${windows ? "%USERPROFILE%" : "~"}${rest}`;
}

// selfhost Dev sets NODE_ENV and OPENWHISPR_CHANNEL to production on purpose, so
// the channel comes from how the app runs, never from those.
function channelFor({ isPackaged, selfBuilt }) {
  if (!isPackaged) return "source";
  return selfBuilt ? "selfhost-stable" : "release";
}

function createBuildInfoReader({
  isPackaged,
  resourcesPath,
  appPath,
  exePath,
  version,
  packageJson = {},
  versions = process.versions,
  homeDir = os.homedir(),
  platform = process.platform,
  exec = execFile,
  readFile = (file) => fs.promises.readFile(file, "utf8"),
  startedAtMs = PROCESS_STARTED_AT_MS,
  uptime = () => process.uptime(),
}) {
  const selfBuilt = packageJson?.selfBuilt === true;

  const readPackaged = async () => {
    let stamp = null;
    try {
      stamp = parseBuildInfo(await readFile(path.join(resourcesPath, BUILD_INFO_FILE)));
    } catch {
      stamp = null;
    }
    return {
      builtAt: stamp?.builtAt ?? null,
      // A self-built package also records its commit in package.json.
      commit: stamp?.commit ?? (selfBuilt ? shaOrNull(packageJson.selfBuiltCommit) : null),
      dirty: stamp?.dirty ?? null,
      source: stamp?.source ?? null,
      commitSubject: null,
    };
  };

  const readSource = async () => ({
    builtAt: null,
    source: null,
    ...(await readWorkingTree(appPath, exec)),
  });

  let details = null;
  return async function getBuildInfo() {
    if (!details) details = isPackaged ? readPackaged() : readSource();
    const { builtAt, commit, dirty, source, commitSubject } = await details;
    return {
      version,
      builtAt,
      commit,
      dirty,
      source,
      commitSubject,
      channel: channelFor({ isPackaged, selfBuilt }),
      startedAt: new Date(startedAtMs).toISOString(),
      uptimeSec: Math.max(0, Math.floor(uptime())),
      exePath: maskUserProfile(exePath, homeDir, platform),
      electron: versions?.electron ?? null,
      chrome: versions?.chrome ?? null,
      node: versions?.node ?? null,
    };
  };
}

let defaultReader = null;

function getBuildInfo() {
  if (!defaultReader) {
    const { app } = require("electron");
    let packageJson = {};
    try {
      packageJson = require("../../package.json");
    } catch {
      packageJson = {};
    }
    defaultReader = createBuildInfoReader({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      exePath: app.getPath("exe"),
      version: app.getVersion(),
      packageJson,
    });
  }
  return defaultReader();
}

module.exports = {
  BUILD_INFO_FILE,
  BUILD_SOURCES,
  gitEnv,
  parseBuildInfo,
  runGit,
  readWorkingTree,
  maskUserProfile,
  channelFor,
  createBuildInfoReader,
  getBuildInfo,
};
