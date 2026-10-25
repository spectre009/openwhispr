const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  BUILD_INFO_FILE,
  channelFor,
  createBuildInfoReader,
  gitEnv,
  maskUserProfile,
  parseBuildInfo,
} = require("../../src/helpers/buildInfo");

// System › This build's main side (src/helpers/buildInfo.js): a packaged app
// reads the build-info.json afterPack stamped, anything missing or malformed
// reading as unknown; a run from source asks git about the working tree, once.

const SHA = "616ead3b0d8d4c1e9f2a3b4c5d6e7f8091a2b3c4";
const VALID = {
  builtAt: "2026-10-25T07:45:12.345Z",
  commit: SHA,
  dirty: false,
  source: "selfhost",
  version: "1.10.3",
};
const RESOURCES = "C:\\Users\\alice\\AppData\\Local\\Programs\\OpenWhispr\\resources";
const EXE = "C:\\Users\\alice\\AppData\\Local\\Programs\\OpenWhispr\\OpenWhispr.exe";
const VERSIONS = { electron: "41.0.0", chrome: "146.0.7680.31", node: "24.11.1" };

function packagedReader({ file, packageJson = { selfBuilt: true }, ...overrides } = {}) {
  const reads = [];
  const reader = createBuildInfoReader({
    isPackaged: true,
    resourcesPath: RESOURCES,
    appPath: `${RESOURCES}\\app.asar`,
    exePath: EXE,
    version: "1.10.3",
    packageJson,
    versions: VERSIONS,
    homeDir: "C:\\Users\\alice",
    platform: "win32",
    readFile: async (filePath) => {
      reads.push(filePath);
      if (file === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return file;
    },
    exec: () => {
      throw new Error("a packaged app never runs git");
    },
    startedAtMs: Date.parse("2026-10-25T15:02:11.000Z"),
    uptime: () => 3725.9,
    ...overrides,
  });
  return { reader, reads };
}

// A fake execFile: answers by the git subcommand and records each call.
function fakeGit(answers) {
  const calls = [];
  const exec = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const answer = answers[args[0]];
    setImmediate(() =>
      answer instanceof Error ? callback(answer, "", "") : callback(null, answer ?? "", "")
    );
  };
  return { exec, calls };
}

function sourceReader(exec, overrides = {}) {
  return createBuildInfoReader({
    isPackaged: false,
    resourcesPath: "C:\\repo\\node_modules\\electron\\dist\\resources",
    appPath: "C:\\Git\\openwhispr",
    exePath: "C:\\Git\\openwhispr\\node_modules\\electron\\dist\\electron.exe",
    version: "1.10.3",
    packageJson: {},
    versions: VERSIONS,
    homeDir: "C:\\Users\\alice",
    platform: "win32",
    exec,
    readFile: async () => {
      throw new Error("a run from source has no build-info.json");
    },
    ...overrides,
  });
}

test("build-info.json: afterPack's fields parse as written", () => {
  assert.deepEqual(parseBuildInfo(JSON.stringify(VALID)), VALID);
  assert.deepEqual(parseBuildInfo(JSON.stringify({ ...VALID, commit: null, dirty: null })), {
    ...VALID,
    commit: null,
    dirty: null,
  });
});

test("build-info.json: invalid JSON or a non-object reads as nothing", () => {
  assert.equal(parseBuildInfo("{ not json"), null);
  assert.equal(parseBuildInfo(""), null);
  assert.equal(parseBuildInfo("[]"), null);
  assert.equal(parseBuildInfo("null"), null);
  assert.equal(parseBuildInfo('"2026-10-25T07:45:12Z"'), null);
});

test("build-info.json: each malformed field reads as unknown", () => {
  for (const [field, value] of [
    ["builtAt", "yesterday"],
    ["builtAt", "2026-10-25 07:45"],
    ["builtAt", "2026-13-45T99:99:99Z"],
    ["builtAt", 1761378312345],
    ["commit", SHA.slice(0, 8)],
    ["commit", SHA.toUpperCase()],
    ["commit", `${SHA}\n`],
    ["dirty", "true"],
    ["dirty", 1],
    ["source", "ci"],
    ["version", 3],
  ]) {
    const parsed = parseBuildInfo(JSON.stringify({ ...VALID, [field]: value }));
    assert.equal(parsed[field], null, `${field}: ${JSON.stringify(value)}`);
    for (const other of Object.keys(VALID).filter((key) => key !== field)) {
      assert.equal(parsed[other], VALID[other], `${other} survives a bad ${field}`);
    }
  }
});

test("packaged: reads build-info.json next to app.asar, plus the process facts", async () => {
  const { reader, reads } = packagedReader({ file: JSON.stringify({ ...VALID, dirty: true }) });
  const info = await reader();
  assert.deepEqual(reads, [path.join(RESOURCES, BUILD_INFO_FILE)]);
  assert.deepEqual(info, {
    version: "1.10.3",
    builtAt: VALID.builtAt,
    commit: SHA,
    dirty: true,
    source: "selfhost",
    commitSubject: null,
    channel: "selfhost-stable",
    startedAt: "2026-10-25T15:02:11.000Z",
    uptimeSec: 3725,
    exePath: "%USERPROFILE%\\AppData\\Local\\Programs\\OpenWhispr\\OpenWhispr.exe",
    electron: "41.0.0",
    chrome: "146.0.7680.31",
    node: "24.11.1",
  });
});

test("packaged: the file is read once; uptime is read on every request", async () => {
  let uptime = 10;
  const { reader, reads } = packagedReader({
    file: JSON.stringify(VALID),
    uptime: () => uptime,
  });
  assert.equal((await reader()).uptimeSec, 10);
  uptime = 70.4;
  assert.equal((await reader()).uptimeSec, 70);
  assert.equal(reads.length, 1);
});

test("packaged: a missing build-info.json (an older package) reads as unknown", async () => {
  const { reader } = packagedReader({ packageJson: {} });
  const info = await reader();
  assert.equal(info.builtAt, null);
  assert.equal(info.commit, null);
  assert.equal(info.dirty, null);
  assert.equal(info.source, null);
  assert.equal(info.channel, "release");
  assert.equal(info.version, "1.10.3", "the version comes from the app, not the stamp");
});

test("packaged: without a stamp, a self-built package still names its commit", async () => {
  const { reader } = packagedReader({
    packageJson: { selfBuilt: true, selfBuiltCommit: SHA },
  });
  const info = await reader();
  assert.equal(info.commit, SHA);
  assert.equal(info.builtAt, null);
  // Only a self-built package's own field counts, and only a full SHA
  const official = packagedReader({ packageJson: { selfBuiltCommit: SHA } });
  assert.equal((await official.reader()).commit, null);
  const short = packagedReader({ packageJson: { selfBuilt: true, selfBuiltCommit: "616ead3b" } });
  assert.equal((await short.reader()).commit, null);
});

test("packaged: invalid JSON and invalid fields read as unknown", async () => {
  const garbled = await packagedReader({ file: "{ builtAt: oops" }).reader();
  assert.deepEqual(
    [garbled.builtAt, garbled.commit, garbled.dirty, garbled.source],
    [null, null, null, null]
  );
  assert.equal(garbled.channel, "selfhost-stable");

  const bad = await packagedReader({
    file: JSON.stringify({ builtAt: "soon", commit: "HEAD", dirty: "no", source: "me" }),
    packageJson: {},
  }).reader();
  assert.deepEqual([bad.builtAt, bad.commit, bad.dirty, bad.source], [null, null, null, null]);
});

test("from source: HEAD, dirty state and subject come from git in the app path, once", async () => {
  const git = fakeGit({
    "rev-parse": `${SHA}\n`,
    status: " M src/components/SettingsPage.tsx\n",
    log: "feat(history): turn a review into a fix\n",
  });
  const reader = sourceReader(git.exec);
  const [first, second] = await Promise.all([reader(), reader()]);
  assert.deepEqual(first, second);
  assert.equal(first.channel, "source");
  assert.equal(first.builtAt, null, "running from source");
  assert.equal(first.source, null);
  assert.equal(first.commit, SHA);
  assert.equal(first.dirty, true);
  assert.equal(first.commitSubject, "feat(history): turn a review into a fix");
  assert.equal(first.exePath, "C:\\Git\\openwhispr\\node_modules\\electron\\dist\\electron.exe");

  await reader();
  assert.deepEqual(
    git.calls.map((call) => call.args),
    [
      ["rev-parse", "HEAD"],
      ["status", "--porcelain", "--untracked-files=no"],
      ["log", "-1", "--format=%s", SHA],
    ],
    "git runs once, however often it's asked"
  );
  for (const call of git.calls) {
    assert.equal(call.file, "git");
    assert.equal(call.options.cwd, "C:\\Git\\openwhispr");
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 10000, "a short timeout");
    assert.equal(call.options.windowsHide, true);
  }
});

test("from source: a clean tree is not dirty", async () => {
  const git = fakeGit({ "rev-parse": `${SHA}\n`, status: "", log: "fix: something\n" });
  const info = await sourceReader(git.exec)();
  assert.equal(info.dirty, false);
});

test("from source: no git (or no repo) reads as unknown without failing", async () => {
  const missing = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  const noGit = fakeGit({ "rev-parse": missing, status: missing, log: missing });
  const info = await sourceReader(noGit.exec)();
  assert.deepEqual([info.commit, info.dirty, info.commitSubject], [null, null, null]);
  assert.equal(noGit.calls.length, 1, "nothing else is asked without a HEAD");

  const throwing = await sourceReader(() => {
    throw new Error("spawn failed synchronously");
  })();
  assert.equal(throwing.commit, null);

  const statusFails = fakeGit({ "rev-parse": `${SHA}\n`, status: new Error("timeout"), log: "" });
  const partial = await sourceReader(statusFails.exec)();
  assert.equal(partial.commit, SHA);
  assert.equal(partial.dirty, null, "unknown, not clean");
  assert.equal(partial.commitSubject, null);
});

test("git runs without injected config or a redirected repo", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp/x'",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      GIT_EXEC_PATH: "C:\\elsewhere",
      GIT_TERMINAL_PROMPT: "1",
      GIT_DIR: "C:\\other\\.git",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      ELECTRON_RUN_AS_NODE: "1",
      OPENWHISPR_KEEP_ME: "yes",
    });
    const git = fakeGit({ "rev-parse": `${SHA}\n`, status: "", log: "" });
    await sourceReader(git.exec)();
    const env = git.calls[0].options.env;
    for (const name of [
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_EXEC_PATH",
      "GIT_TERMINAL_PROMPT",
      "GIT_DIR",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "ELECTRON_RUN_AS_NODE",
    ]) {
      assert.equal(env[name], undefined, `${name} is stripped`);
    }
    assert.equal(env.OPENWHISPR_KEEP_ME, "yes", "everything else passes through");
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0", "status never takes the index lock");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("gitEnv strips by name whatever the casing Windows reports", () => {
  const env = gitEnv({ Git_Dir: "x", git_config_key_3: "y", Path: "C:\\Windows" });
  assert.deepEqual(env, { Path: "C:\\Windows", GIT_OPTIONAL_LOCKS: "0" });
});

test("channel: how the app runs, never NODE_ENV or OPENWHISPR_CHANNEL", async () => {
  assert.equal(channelFor({ isPackaged: false, selfBuilt: true }), "source");
  assert.equal(channelFor({ isPackaged: true, selfBuilt: true }), "selfhost-stable");
  assert.equal(channelFor({ isPackaged: true, selfBuilt: false }), "release");

  const saved = { NODE_ENV: process.env.NODE_ENV, CHANNEL: process.env.OPENWHISPR_CHANNEL };
  try {
    // selfhost Dev sets both to production on purpose
    process.env.NODE_ENV = "production";
    process.env.OPENWHISPR_CHANNEL = "production";
    const git = fakeGit({ "rev-parse": `${SHA}\n`, status: "", log: "" });
    assert.equal((await sourceReader(git.exec)()).channel, "source");
    process.env.NODE_ENV = "development";
    const { reader } = packagedReader({ file: JSON.stringify(VALID) });
    assert.equal((await reader()).channel, "selfhost-stable");
  } finally {
    for (const [key, value] of [
      ["NODE_ENV", saved.NODE_ENV],
      ["OPENWHISPR_CHANNEL", saved.CHANNEL],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the user profile prefix is masked; other paths are left alone", () => {
  const home = "C:\\Users\\alice";
  assert.equal(
    maskUserProfile(
      "c:\\users\\ALICE\\AppData\\Local\\Programs\\OpenWhispr\\OpenWhispr.exe",
      home,
      "win32"
    ),
    "%USERPROFILE%\\AppData\\Local\\Programs\\OpenWhispr\\OpenWhispr.exe",
    "Windows paths compare without case"
  );
  assert.equal(maskUserProfile(home, `${home}\\`, "win32"), "%USERPROFILE%");
  assert.equal(
    maskUserProfile("C:\\Users\\alicebob\\OpenWhispr.exe", home, "win32"),
    "C:\\Users\\alicebob\\OpenWhispr.exe",
    "only at a folder boundary"
  );
  assert.equal(
    maskUserProfile("C:\\Program Files\\OpenWhispr\\OpenWhispr.exe", home, "win32"),
    "C:\\Program Files\\OpenWhispr\\OpenWhispr.exe"
  );
  assert.equal(
    maskUserProfile("/home/alice/Applications/OpenWhispr.AppImage", "/home/alice", "linux"),
    "~/Applications/OpenWhispr.AppImage"
  );
  assert.equal(
    maskUserProfile("/Home/alice/x", "/home/alice", "darwin"),
    "/Home/alice/x",
    "case matters outside Windows"
  );
  assert.equal(maskUserProfile(null, home, "win32"), null);
  assert.equal(maskUserProfile("C:\\x.exe", "", "win32"), "C:\\x.exe");
});
