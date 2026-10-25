const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { collectBuildInfo, writeBuildInfo } = require("../../scripts/afterPack");
const { BUILD_INFO_FILE, gitEnv, parseBuildInfo } = require("../../src/helpers/buildInfo");

// afterPack stamps build-info.json into every package's resources folder (next
// to app.asar): when it was packaged, from which commit of the folder being
// packaged, whether that tree had uncommitted changes, and who packaged it.

const SHA = "616ead3b0d8d4c1e9f2a3b4c5d6e7f8091a2b3c4";
const NOW = new Date("2026-10-25T07:45:12.345Z");

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function windowsContext(
  appOutDir,
  { projectDir = "C:\\project", metadata = {}, config = {} } = {}
) {
  fs.mkdirSync(path.join(appOutDir, "resources"), { recursive: true });
  return {
    electronPlatformName: "win32",
    appOutDir,
    packager: {
      projectDir,
      info: { projectDir, metadata: { version: "1.10.3", ...metadata } },
      appInfo: { version: "1.10.3", productFilename: "OpenWhispr" },
      config,
    },
  };
}

// A fake git: answers by subcommand, records where it was asked.
function fakeGit(answers) {
  const calls = [];
  const git = (args, cwd) => {
    calls.push({ args, cwd });
    return answers[args[0]] ?? null;
  };
  return { git, calls };
}

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { env: gitEnv(), stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

test("writes build-info.json next to app.asar, in the shape main reads", (t) => {
  const outDir = tempDir(t, "afterpack-stamp-");
  const context = windowsContext(outDir);
  const { git, calls } = fakeGit({ "rev-parse": `${SHA}\n`, status: "" });

  const info = collectBuildInfo(context, { now: NOW, git });
  const file = writeBuildInfo(context, info);

  assert.equal(file, path.join(outDir, "resources", BUILD_INFO_FILE));
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(written, {
    builtAt: "2026-10-25T07:45:12.345Z",
    commit: SHA,
    dirty: false,
    source: "npm",
    version: "1.10.3",
  });
  assert.deepEqual(parseBuildInfo(fs.readFileSync(file, "utf8")), written, "main reads it all");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["rev-parse", "HEAD"],
      ["status", "--porcelain", "--untracked-files=no"],
    ]
  );
  assert.ok(
    calls.every((call) => call.cwd === "C:\\project"),
    "git runs in the folder being packaged"
  );
});

test("a selfhost package (selfBuilt through extraMetadata) is marked selfhost", (t) => {
  const { git } = fakeGit({ "rev-parse": `${SHA}\n`, status: " M main.js\n" });
  const merged = collectBuildInfo(
    windowsContext(tempDir(t, "afterpack-stamp-"), { metadata: { selfBuilt: true } }),
    { now: NOW, git }
  );
  assert.equal(merged.source, "selfhost");
  assert.equal(merged.dirty, true);

  const fromConfig = collectBuildInfo(
    windowsContext(tempDir(t, "afterpack-stamp-"), {
      config: { extraMetadata: { selfBuilt: true } },
    }),
    { now: NOW, git }
  );
  assert.equal(fromConfig.source, "selfhost");
});

test("without git the package is still stamped, with an unknown commit", (t) => {
  const outDir = tempDir(t, "afterpack-stamp-");
  const context = windowsContext(outDir);
  const { git, calls } = fakeGit({});

  const info = collectBuildInfo(context, { now: NOW, git });
  writeBuildInfo(context, info);

  assert.deepEqual(info, {
    builtAt: "2026-10-25T07:45:12.345Z",
    commit: null,
    dirty: null,
    source: "npm",
    version: "1.10.3",
  });
  assert.equal(calls.length, 1, "no status without a HEAD");
  const written = parseBuildInfo(
    fs.readFileSync(path.join(outDir, "resources", BUILD_INFO_FILE), "utf8")
  );
  assert.equal(written.commit, null);
  assert.equal(written.builtAt, "2026-10-25T07:45:12.345Z");
});

test("anything but a full SHA from git counts as no commit", (t) => {
  const { git } = fakeGit({ "rev-parse": "fatal: not a git repository\n", status: "" });
  const info = collectBuildInfo(windowsContext(tempDir(t, "afterpack-stamp-")), {
    now: NOW,
    git,
  });
  assert.equal(info.commit, null);
  assert.equal(info.dirty, null);
});

test("macOS: the stamp goes into the app bundle's Contents/Resources", (t) => {
  const outDir = tempDir(t, "afterpack-stamp-mac-");
  const resources = path.join(outDir, "OpenWhispr.app", "Contents", "Resources");
  fs.mkdirSync(resources, { recursive: true });
  const context = {
    electronPlatformName: "darwin",
    appOutDir: outDir,
    packager: {
      projectDir: "/project",
      info: { metadata: {} },
      appInfo: { version: "1.10.3", productFilename: "OpenWhispr" },
    },
  };
  const info = collectBuildInfo(context, { now: NOW, git: fakeGit({}).git });
  assert.equal(writeBuildInfo(context, info), path.join(resources, BUILD_INFO_FILE));
  assert.ok(fs.existsSync(path.join(resources, BUILD_INFO_FILE)));
});

test(
  "real git: HEAD of the packaged folder, dirty only for tracked changes",
  { skip: !hasGit && "git is not installed" },
  (t) => {
    const repo = tempDir(t, "afterpack-repo-");
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: repo,
        env: gitEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "one\n");
    git("add", "tracked.txt");
    git(
      "-c",
      "user.name=OpenWhispr test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-verify",
      "-q",
      "-m",
      "init"
    );
    const head = git("rev-parse", "HEAD").trim();
    const stamp = () =>
      collectBuildInfo(windowsContext(tempDir(t, "afterpack-out-"), { projectDir: repo }), {
        now: NOW,
      });

    const clean = stamp();
    assert.equal(clean.commit, head, "the packaged folder's HEAD, not the process cwd's");
    assert.equal(clean.dirty, false);

    fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");
    assert.equal(stamp().dirty, false, "untracked files don't count");

    fs.writeFileSync(path.join(repo, "tracked.txt"), "two\n");
    assert.equal(stamp().dirty, true, "a modified tracked file does");

    const outside = tempDir(t, "afterpack-norepo-");
    const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
    // Keeps git from finding a repo above the temp folder (a versioned home)
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(outside);
    t.after(() => {
      if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    });
    const notARepo = collectBuildInfo(
      windowsContext(tempDir(t, "afterpack-out-"), { projectDir: outside }),
      { now: NOW }
    );
    assert.equal(notARepo.commit, null, "outside a repo the packaging still goes on");
    assert.equal(notARepo.dirty, null);
  }
);
