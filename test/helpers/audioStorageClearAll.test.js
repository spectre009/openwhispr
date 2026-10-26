const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// Clear all recordings (audioStorage.js clearAllRecordings, behind
// `delete-all-audio` and Storage's Clear): counts only the files it deleted,
// clears the audio flag of exactly those rows, and says how many are left.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-clear-recordings-"));
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => scratch, isReady: () => false, isPackaged: false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const AudioStorageManager = require("../../src/helpers/audioStorage");
Module._load = originalLoad;

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function setup(t) {
  const audioDir = fs.mkdtempSync(path.join(scratch, "audio-"));
  t.after(() => fs.rmSync(audioDir, { recursive: true, force: true }));
  const write = (name) => fs.writeFileSync(path.join(audioDir, name), Buffer.alloc(512));
  const flagged = [];
  const databaseManager = { clearAudioFlags: (ids) => flagged.push(...ids) };
  return { audioDir, write, flagged, databaseManager, manager: new AudioStorageManager(audioDir) };
}

test("the id in a recording's file name", () => {
  const { transcriptionIdFromAudioFile } = AudioStorageManager;
  assert.equal(transcriptionIdFromAudioFile("OpenWhispr-2026-10-25-08-42-11-123.webm"), 123);
  assert.equal(transcriptionIdFromAudioFile("77.webm"), 77, "legacy name");
  assert.equal(transcriptionIdFromAudioFile("OpenWhispr-notes.webm"), null);
});

test("every file deleted: every one counted and flagged", (t) => {
  const { write, flagged, databaseManager, manager } = setup(t);
  write("OpenWhispr-2026-10-25-08-42-11-1.webm");
  write("OpenWhispr-2026-10-25-08-43-11-2.webm");
  write("3.webm");
  write("readme.txt");

  assert.deepEqual(manager.clearAllRecordings(databaseManager), { deleted: 3, failed: 0 });
  assert.deepEqual(flagged.sort(), [1, 2, 3]);
  assert.deepEqual(manager.getStorageUsage(), { fileCount: 0, totalBytes: 0 });
});

test("a file that can't be deleted keeps its row's flag and is reported", (t) => {
  const { audioDir, write, flagged, databaseManager, manager } = setup(t);
  write("OpenWhispr-2026-10-25-08-42-11-10.webm");
  write("OpenWhispr-2026-10-25-08-43-11-11.webm");
  // A folder named like a recording: unlink refuses it on every platform.
  fs.mkdirSync(path.join(audioDir, "OpenWhispr-2026-10-25-08-44-11-12.webm"));

  const result = manager.clearAllRecordings(databaseManager);
  assert.deepEqual(result, { deleted: 2, failed: 1 });
  assert.deepEqual(flagged.sort(), [10, 11], "row 12 still has its file, so it keeps its flag");
  assert.ok(fs.existsSync(path.join(audioDir, "OpenWhispr-2026-10-25-08-44-11-12.webm")));
});

test("nothing deleted, nothing flagged; a missing folder is just empty", (t) => {
  const { flagged, databaseManager } = setup(t);
  const missing = new AudioStorageManager(path.join(scratch, "gone", "audio"));
  fs.rmSync(path.join(scratch, "gone"), { recursive: true, force: true });
  assert.deepEqual(missing.clearAllRecordings(databaseManager), { deleted: 0, failed: 0 });
  assert.deepEqual(flagged, []);
});

test("the sweep deletes only expired files and clears only their flags", (t) => {
  const { audioDir, write, flagged, databaseManager, manager } = setup(t);
  write("OpenWhispr-2026-01-01-08-00-00-5.webm");
  write("OpenWhispr-2026-10-25-08-00-00-6.webm");
  const old = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(path.join(audioDir, "OpenWhispr-2026-01-01-08-00-00-5.webm"), old, old);

  assert.deepEqual(manager.cleanupExpiredAudio(30, databaseManager), { deleted: 1, kept: 1 });
  assert.deepEqual(flagged, [5]);
});
