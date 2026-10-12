const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../../scripts/selfhost/core.js");

const dataOf = (overrides = {}) => {
  const data = {};
  for (const p of core.DATA_PATHS) data[p] = `hash-of-${p}`;
  return { ...data, ...overrides };
};

test("release ids sort chronologically and carry the short sha", () => {
  const id = core.releaseId(new Date(2026, 9, 11, 9, 5, 7), "0123456789abcdef");
  assert.equal(id, "20261011-090507-01234567");
  const later = core.releaseId(new Date(2026, 9, 11, 10, 0, 0), "ffffffff00000000");
  assert.deepEqual([later, id].sort(), [id, later]);
});

test("retention keeps the newest entries and never prunes a pinned one", () => {
  const ids = ["20261001-a", "20261002-b", "20261003-c", "20261004-d", "20261005-e"];
  assert.deepEqual(core.selectPrunable(ids, { keep: 3 }), ["20261001-a", "20261002-b"]);
  assert.deepEqual(core.selectPrunable(ids, { keep: 3, pinned: ["20261001-a"] }), ["20261002-b"]);
  assert.deepEqual(core.selectPrunable(ids, { keep: 10 }), []);
});

test("the Run entry starts the installed exe hidden, like the official app", () => {
  assert.equal(
    core.runEntryValue("C:\\Apps\\OpenWhispr.exe"),
    '"C:\\Apps\\OpenWhispr.exe" --hidden'
  );
});

test("StartupApproved marks a disabled startup app with an odd first byte", () => {
  assert.equal(core.isStartupApprovedDisabled("030000000000000000000000"), true);
  assert.equal(core.isStartupApprovedDisabled("020000000000000000000000"), false);
  assert.equal(core.isStartupApprovedDisabled("060000000000000000000000"), false);
  assert.equal(core.isStartupApprovedDisabled(null), false);
});

test("the renderer build is settled only once the latest build in the newest session finished", () => {
  assert.equal(core.rendererBuildSettled(""), false);
  assert.equal(core.rendererBuildSettled("===== t1 start\nbuild started\n"), false);
  assert.equal(core.rendererBuildSettled("===== t1 start\nbuild started\nbuilt in 2s\n"), true);
  assert.equal(
    core.rendererBuildSettled("===== t1 start\nbuild started\nbuilt in 2s\nbuild started\n"),
    false,
    "a rebuild in progress is not settled"
  );
  assert.equal(
    core.rendererBuildSettled("===== t1 start\nbuild started\nbuilt in 2s\n===== t2 start\n"),
    false,
    "a new watcher session has not built yet"
  );
});

test("the helper fingerprint follows build inputs and ignores everything else", () => {
  const tree = (overrides = {}) =>
    [
      ["100644 blob aaa", "scripts/build-windows-key-listener.js"],
      ["100644 blob bbb", "scripts/download-qdrant.js"],
      ["100644 blob ccc", "scripts/lib/download-utils.js"],
      ["100644 blob ddd", "resources/windows-key-listener.c"],
      ["100644 blob eee", "package.json"],
      ["100644 blob fff", "src/App.jsx"],
      ["100644 blob ggg", "scripts/selfhost/core.js"],
    ]
      .map(([meta, p]) => `${overrides[p] || meta}\t${p}`)
      .join("\n");

  const base = core.helperFingerprint(tree());
  assert.equal(core.helperFingerprint(tree({ "src/App.jsx": "100644 blob 999" })), base);
  assert.equal(
    core.helperFingerprint(tree({ "scripts/selfhost/core.js": "100644 blob 999" })),
    base
  );
  for (const p of [
    "scripts/build-windows-key-listener.js",
    "scripts/download-qdrant.js",
    "scripts/lib/download-utils.js",
    "resources/windows-key-listener.c",
    "package.json",
  ]) {
    assert.notEqual(core.helperFingerprint(tree({ [p]: "100644 blob 999" })), base, p);
  }
});

test("a compile-first helper that was downloaded instead is reported", () => {
  const log = [
    "[windows-key-listener] Successfully built with MSVC",
    "[windows-text-monitor] Successfully downloaded prebuilt binary",
  ].join("\n");
  assert.deepEqual(core.helpersNotCompiled(log), ["windows-text-monitor"]);
  assert.deepEqual(
    core.helpersNotCompiled(
      "[windows-key-listener] Successfully built with MSVC\n[windows-text-monitor] Successfully built with MSVC"
    ),
    []
  );
});

test("data hashes cover every data path and treat a missing file as null", () => {
  const hashes = core.dataHashes((p) => (p.endsWith("noteUndo.js") ? null : `content ${p}`));
  assert.deepEqual(Object.keys(hashes), core.DATA_PATHS);
  assert.equal(hashes["src/helpers/noteUndo.js"], null);
  assert.equal(hashes["src/helpers/database.js"], core.sha256("content src/helpers/database.js"));
});

test("writers are recorded once per sha, dirtiness and data code", () => {
  const writer = { sha: "a".repeat(40), dirty: false, data: dataOf() };
  let writers = core.addWriter([], writer);
  writers = core.addWriter(writers, writer);
  assert.equal(writers.length, 1);
  writers = core.addWriter(writers, {
    ...writer,
    dirty: true,
    data: dataOf({ "src/helpers/database.js": "x" }),
  });
  assert.equal(writers.length, 2);
});

test("data guard: same data code or a committed ancestor writer is allowed", () => {
  const target = { sha: "t", data: dataOf({ "src/helpers/database.js": "new" }) };
  const sameCode = {
    sha: "other-branch",
    dirty: false,
    data: dataOf({ "src/helpers/database.js": "new" }),
  };
  const ancestor = { sha: "old", dirty: false, data: dataOf() };
  const decision = core.guardDecision({
    writers: [sameCode, ancestor],
    target,
    isAncestor: (writerSha) => writerSha === "old",
  });
  assert.deepEqual(decision, { allowed: true, blockers: [] });
});

test("data guard: going back to older data code is refused, naming the changed files", () => {
  const newer = { sha: "new", dirty: false, data: dataOf({ "src/helpers/database.js": "v2" }) };
  const target = { sha: "old", data: dataOf() };
  const decision = core.guardDecision({ writers: [newer], target, isAncestor: () => false });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.blockers[0].paths, ["src/helpers/database.js"]);
  assert.match(
    core.renderGuardRefusal({ targetLabel: "old", blockers: decision.blockers }),
    /--accept-data-risk/
  );
});

test("data guard: an uncommitted Dev change to data code refuses even for a descendant", () => {
  const dirtyDev = {
    sha: "base",
    dirty: true,
    data: dataOf({ "src/stores/settingsStore.ts": "wip" }),
  };
  const target = { sha: "child", data: dataOf({ "src/stores/settingsStore.ts": "committed" }) };
  const decision = core.guardDecision({ writers: [dirtyDev], target, isAncestor: () => true });
  assert.equal(decision.allowed, false);
});

test("data guard: Dev that only touched renderer code never blocks going back to Stable", () => {
  const dev = { sha: "feature", dirty: true, data: dataOf() };
  const stable = { sha: "main", data: dataOf() };
  assert.equal(
    core.guardDecision({ writers: [dev], target: stable, isAncestor: () => false }).allowed,
    true
  );
});

test("rollback steps name the release, installer and snapshots", () => {
  const text = core.renderRollbackSteps({
    release: { id: "r1", sha: "abcdef0123", subject: "fix", installer: "C:\\r1\\setup.exe" },
    snapshots: [
      { id: "s1", pinned: true, writers: [{ sha: "1c123e87aa", label: "official 1.10.2" }] },
    ],
    paths: { dataDir: "D", backupsDir: "B", qdrantDir: "Q" },
  });
  assert.match(text, /r1 \(abcdef01 fix\)/);
  assert.match(text, /"C:\\r1\\setup\.exe" \/S \/currentuser/);
  assert.match(text, /s1 \[pinned\]: writers 1c123e87 \(official 1\.10\.2\)/);
  assert.match(core.renderRollbackSteps({ release: null }), /No earlier/);
});

test("arguments: command, flags in camelCase, --cdp port, positionals", () => {
  assert.deepEqual(core.parseArgs(["ship", "main~1", "--accept-data-risk", "--test"]), {
    command: "ship",
    options: { positional: ["main~1"], acceptDataRisk: true, test: true },
  });
  assert.deepEqual(core.parseArgs(["dev", "--cdp", "9333"]), {
    command: "dev",
    options: { positional: [], cdpPort: 9333 },
  });
  assert.equal(core.parseArgs([]).command, "status");
});
