const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { parseDbTimestamp } = require("./dbTimestamp");

// The History id a recording file belongs to ("OpenWhispr-<date>-<time>-<id>.webm",
// or a legacy "<id>.webm"), or null when the name carries none.
function transcriptionIdFromAudioFile(file) {
  const basename = path.basename(file, ".webm");
  const id = basename.slice(basename.lastIndexOf("-") + 1);
  return /^\d+$/.test(id) ? Number(id) : null;
}

class AudioStorageManager {
  constructor(audioDir = path.join(app.getPath("userData"), "audio")) {
    this.audioDir = audioDir;
    this.ensureAudioDir();
  }

  ensureAudioDir() {
    try {
      fs.mkdirSync(this.audioDir, { recursive: true });
    } catch (error) {
      debugLogger.error(
        "Failed to create audio directory",
        { error: error.message },
        "audio-storage"
      );
    }
  }

  _buildFilename(transcriptionId, timestamp) {
    if (timestamp) {
      // Named in the user's own wall clock, so the stored instant has to be
      // resolved before it is read -- a bare SQLite timestamp is UTC, not local.
      const d = parseDbTimestamp(timestamp);
      if (d) {
        const pad = (n) => String(n).padStart(2, "0");
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
        return `OpenWhispr-${date}-${time}-${transcriptionId}.webm`;
      }
    }
    return `OpenWhispr-${transcriptionId}.webm`;
  }

  saveAudio(transcriptionId, audioBuffer, timestamp) {
    try {
      const filename = this._buildFilename(transcriptionId, timestamp);
      const filePath = path.join(this.audioDir, filename);
      fs.writeFileSync(filePath, audioBuffer);
      debugLogger.debug(
        "Audio saved",
        { transcriptionId, filename, size: audioBuffer.length },
        "audio-storage"
      );
      return { success: true, path: filePath };
    } catch (error) {
      debugLogger.error(
        "Failed to save audio",
        { transcriptionId, error: error.message },
        "audio-storage"
      );
      return { success: false };
    }
  }

  getAudioPath(transcriptionId) {
    try {
      const files = fs.readdirSync(this.audioDir);
      const match = files.find(
        (f) => f.endsWith(`-${transcriptionId}.webm`) || f === `${transcriptionId}.webm`
      );
      if (match) return path.join(this.audioDir, match);
    } catch {}
    return null;
  }

  getAudioBuffer(transcriptionId) {
    const filePath = this.getAudioPath(transcriptionId);
    if (!filePath) return null;
    try {
      return fs.readFileSync(filePath);
    } catch (error) {
      debugLogger.error(
        "Failed to read audio",
        { transcriptionId, error: error.message },
        "audio-storage"
      );
      return null;
    }
  }

  deleteAudio(transcriptionId) {
    try {
      const filePath = this.getAudioPath(transcriptionId);
      if (filePath) {
        fs.unlinkSync(filePath);
        debugLogger.debug("Audio deleted", { transcriptionId }, "audio-storage");
      }
      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Failed to delete audio",
        { transcriptionId, error: error.message },
        "audio-storage"
      );
      return { success: false };
    }
  }

  cleanupExpiredAudio(retentionDays, databaseManager) {
    try {
      const cutoffMs = Date.now() - retentionDays * 86400000;
      const files = fs.readdirSync(this.audioDir).filter((f) => f.endsWith(".webm"));
      const expiredIds = [];
      let deleted = 0;
      let kept = 0;

      for (const file of files) {
        const filePath = path.join(this.audioDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs < cutoffMs) {
            fs.unlinkSync(filePath);
            const id = transcriptionIdFromAudioFile(file);
            if (id !== null) expiredIds.push(id);
            deleted++;
          } else {
            kept++;
          }
        } catch (error) {
          debugLogger.error(
            "Failed to process audio file during cleanup",
            { file, error: error.message },
            "audio-storage"
          );
        }
      }

      if (expiredIds.length > 0 && databaseManager) {
        databaseManager.clearAudioFlags(expiredIds);
      }

      debugLogger.info("Audio cleanup complete", { deleted, kept, retentionDays }, "audio-storage");
      return { deleted, kept };
    } catch (error) {
      debugLogger.error("Audio cleanup failed", { error: error.message }, "audio-storage");
      return { deleted: 0, kept: 0 };
    }
  }

  /**
   * Deletes every recording file it can. Counts only files actually deleted,
   * and names the History ids whose files went (`deletedIds`), so their rows'
   * audio flag can be cleared and no other.
   */
  deleteAllAudio() {
    let files;
    try {
      files = fs.readdirSync(this.audioDir).filter((f) => f.endsWith(".webm"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        debugLogger.error("Failed to delete all audio", { error: error.message }, "audio-storage");
      }
      return { deleted: 0, failed: 0, deletedIds: [] };
    }
    const deletedIds = [];
    let deleted = 0;
    let failed = 0;
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(this.audioDir, file));
      } catch (error) {
        // Gone already (another window, the sweep): that's deleted too.
        if (error.code !== "ENOENT") {
          failed++;
          debugLogger.error(
            "Failed to delete audio file",
            { file, error: error.message },
            "audio-storage"
          );
          continue;
        }
      }
      deleted++;
      const id = transcriptionIdFromAudioFile(file);
      if (id !== null) deletedIds.push(id);
    }
    debugLogger.info("All audio deleted", { deleted, failed }, "audio-storage");
    return { deleted, failed, deletedIds };
  }

  /**
   * Clear all recordings: deletes the files, then clears the audio flag of
   * the rows whose files were deleted (a file that couldn't be deleted keeps
   * its row's flag). Says how many went and how many are left.
   */
  clearAllRecordings(databaseManager) {
    const { deleted, failed, deletedIds } = this.deleteAllAudio();
    if (deletedIds.length > 0 && databaseManager) {
      try {
        databaseManager.clearAudioFlags(deletedIds);
      } catch (error) {
        debugLogger.error(
          "Failed to clear audio flags after delete-all",
          { error: error.message },
          "audio-storage"
        );
      }
    }
    return { deleted, failed };
  }

  getAudioDir() {
    return this.audioDir;
  }

  getStorageUsage() {
    try {
      const files = fs.readdirSync(this.audioDir).filter((f) => f.endsWith(".webm"));
      let totalBytes = 0;
      for (const file of files) {
        try {
          const stats = fs.statSync(path.join(this.audioDir, file));
          totalBytes += stats.size;
        } catch {
          // Skip files that can't be stat'd
        }
      }
      return { fileCount: files.length, totalBytes };
    } catch (error) {
      debugLogger.error("Failed to get storage usage", { error: error.message }, "audio-storage");
      return { fileCount: 0, totalBytes: 0 };
    }
  }
}

module.exports = AudioStorageManager;
module.exports.transcriptionIdFromAudioFile = transcriptionIdFromAudioFile;
