// Pure decisions for scripts/selfhost.js, kept free of processes, git and the
// file system so they can be unit-tested (test/scripts/selfhostCore.test.js).

const crypto = require("crypto");

// Files whose code changes stored data: schema DDL (database.js, noteUndo.js),
// inputs the database migrations import (builtinActions.js, templatePrompts.js),
// settings migrations that delete legacy keys (settingsStore.ts) and secret
// storage (environment.js, secretCrypto.js). Advisory: a refusal names them, but
// an unchanged list never proves that two builds are compatible.
const DATA_PATHS = [
  "src/helpers/database.js",
  "src/helpers/noteUndo.js",
  "src/helpers/builtinActions.js",
  "src/helpers/templatePrompts.js",
  "src/stores/settingsStore.ts",
  "src/helpers/environment.js",
  "src/helpers/secretCrypto.js",
];

// Helpers that build-*.js / download-*.js download from upstream releases before
// (or instead of) compiling, so a fork edit to their source would not ship.
const DOWNLOAD_FIRST_HELPER_SOURCES = [
  "resources/windows-fast-paste.c",
  "resources/windows-mic-listener.c",
  "resources/windows-system-audio-helper.c",
];

// Helpers that compile from source first. After resources/bin is wiped, the
// prebuild log must show each one compiled, not downloaded.
const COMPILED_HELPERS = ["windows-key-listener", "windows-text-monitor"];

const RUN_VALUE = "com.gizmolabs.openwhispr";
const LEGACY_DOGFOOD_RUN_VALUE = "OpenWhispr (dogfood)";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function releaseId(date, sha) {
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stamp}-${sha.slice(0, 8)}`;
}

// ids sort chronologically (timestamp prefix). Keeps the newest `keep`, plus any pinned id.
function selectPrunable(ids, { keep, pinned = [] }) {
  const pinnedSet = new Set(pinned.filter(Boolean));
  const sorted = [...ids].sort();
  const excess = sorted.length - keep;
  if (excess <= 0) return [];
  return sorted.slice(0, excess).filter((id) => !pinnedSet.has(id));
}

function runEntryValue(exePath) {
  return `"${exePath}" --hidden`;
}

// StartupApproved\Run holds a REG_BINARY per entry; Task Manager and Settings set
// an odd first byte (03) when the user disables a startup app.
function isStartupApprovedDisabled(hexBytes) {
  if (!hexBytes) return false;
  const first = parseInt(hexBytes.slice(0, 2), 16);
  return Number.isFinite(first) && first % 2 === 1;
}

// Vite's watch log: settled when the newest session's latest build finished.
// Callers also wait for the log to go quiet: the watcher can rebuild several times
// in a row (seen right after a reboot), and each rebuild empties src/dist.
function rendererBuildSettled(logText) {
  if (!logText) return false;
  const session = logText.slice(Math.max(0, logText.lastIndexOf("===== ")));
  const lastStart = session.lastIndexOf("build started");
  const lastDone = session.lastIndexOf("built in");
  return lastDone !== -1 && lastDone > lastStart;
}

// main.js logs this and keeps running when the window can't load, so an alive
// process alone doesn't prove Dev started.
function devStartFailed(logText) {
  return /Failed to start app/.test(logText || "");
}

// Files that decide which helper binaries end up in resources/bin.
function isHelperInput(filePath) {
  return (
    /^scripts\/(build|download)-[^/]+\.js$/.test(filePath) ||
    filePath.startsWith("scripts/lib/") ||
    (filePath.startsWith("resources/") && !filePath.startsWith("resources/bin/")) ||
    filePath === "package.json"
  );
}

// `git ls-tree -r <sha>` lines: "<mode> <type> <object>\t<path>".
function parseLsTree(output) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [, , objectId] = line.slice(0, tab).split(" ");
      return { path: line.slice(tab + 1), objectId };
    });
}

function helperFingerprint(lsTreeOutput) {
  const lines = parseLsTree(lsTreeOutput)
    .filter((entry) => isHelperInput(entry.path))
    .map((entry) => `${entry.objectId} ${entry.path}`)
    .sort();
  return sha256(lines.join("\n"));
}

// Names of compile-first helpers the prebuild log does not show as compiled.
function helpersNotCompiled(prebuildLog) {
  return COMPILED_HELPERS.filter(
    (name) => !new RegExp(`\\[${name}\\] Successfully built with`).test(prebuildLog)
  );
}

// { path: contentHash } for DATA_PATHS; readFile returns null for a missing file.
function dataHashes(readFile) {
  const hashes = {};
  for (const filePath of DATA_PATHS) {
    const content = readFile(filePath);
    hashes[filePath] = content == null ? null : sha256(content);
  }
  return hashes;
}

function changedDataPaths(a, b) {
  return DATA_PATHS.filter((p) => (a?.[p] ?? null) !== (b?.[p] ?? null));
}

function writerKey(writer) {
  return `${writer.sha}|${writer.dirty ? "dirty" : "clean"}|${sha256(JSON.stringify(writer.data || {}))}`;
}

function addWriter(writers, writer, now = new Date()) {
  const key = writerKey(writer);
  if (writers.some((w) => writerKey(w) === key)) return writers;
  return [...writers, { ...writer, at: now.toISOString() }];
}

// May `target` run on data every recorded writer has touched? Allowed when the
// writer had the same data code, or when it is a committed ancestor of the target
// (migrations only run forward). Older, diverged or uncommitted data code refuses.
// isAncestor(writerSha, targetSha) comes from git.
function guardDecision({ writers, target, isAncestor }) {
  const blockers = [];
  for (const writer of writers) {
    const paths = changedDataPaths(writer.data, target.data);
    if (paths.length === 0) continue;
    if (!writer.dirty && isAncestor(writer.sha, target.sha)) continue;
    blockers.push({ writer, paths });
  }
  return { allowed: blockers.length === 0, blockers };
}

function describeWriter(writer) {
  const label = writer.label ? ` (${writer.label})` : "";
  const dirty = writer.dirty ? " with uncommitted data-code changes" : "";
  return `${writer.sha.slice(0, 8)}${label}${dirty}`;
}

function renderGuardRefusal({ targetLabel, blockers }) {
  const lines = [
    `Refusing to run ${targetLabel} on the current data: different code has migrated it.`,
  ];
  for (const { writer, paths } of blockers) {
    lines.push(
      `  - written by ${describeWriter(writer)}; data code differs in: ${paths.join(", ")}`
    );
  }
  lines.push(
    "Restore a compatible data snapshot first (`selfhost status` lists them), or pass",
    "--accept-data-risk if the difference is harmless (for example, the uncommitted Dev",
    "change is exactly what this build contains)."
  );
  return lines.join("\n");
}

function renderRollbackSteps({ release, snapshots, paths }) {
  if (!release) return "No earlier self-built release to roll back to.";
  const lines = [
    `Manual rollback to ${release.id} (${release.sha.slice(0, 8)} ${release.subject}):`,
    "  1. node scripts/selfhost.js stop",
    `  2. robocopy "${paths.dataDir}" "${paths.backupsDir}\\pre-rollback-<timestamp>" /MIR /R:1 /W:1`,
    `  3. node scripts/selfhost.js check ${release.id}`,
    "     If it refuses, restore a snapshot whose writers it accepts:",
    `       robocopy "${paths.backupsDir}\\<snapshot>\\data" "${paths.dataDir}" /MIR /R:1 /W:1`,
    `       delete "${paths.qdrantDir}" so the search index rebuilds`,
    "       node scripts/selfhost.js adopt-snapshot <snapshot>",
    "     Anything dictated since that snapshot is lost.",
    `  4. "${release.installer}" /S /currentuser`,
    "  5. node scripts/selfhost.js stable",
  ];
  if (snapshots?.length) {
    lines.push("  Snapshots (newest first):");
    for (const s of snapshots) {
      const writers = (s.writers || []).map(describeWriter).join(", ") || "unknown";
      lines.push(`    ${s.id}${s.pinned ? " [pinned]" : ""}: writers ${writers}`);
    }
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const options = { positional: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--cdp") {
      options.cdpPort = Number(rest[i + 1]);
      i += 1;
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      options[name] = true;
    } else {
      options.positional.push(arg);
    }
  }
  return { command, options };
}

module.exports = {
  DATA_PATHS,
  DOWNLOAD_FIRST_HELPER_SOURCES,
  COMPILED_HELPERS,
  RUN_VALUE,
  LEGACY_DOGFOOD_RUN_VALUE,
  sha256,
  releaseId,
  selectPrunable,
  runEntryValue,
  isStartupApprovedDisabled,
  rendererBuildSettled,
  devStartFailed,
  isHelperInput,
  parseLsTree,
  helperFingerprint,
  helpersNotCompiled,
  dataHashes,
  changedDataPaths,
  addWriter,
  guardDecision,
  describeWriter,
  renderGuardRefusal,
  renderRollbackSteps,
  parseArgs,
};
