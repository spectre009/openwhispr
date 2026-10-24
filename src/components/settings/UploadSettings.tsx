import TranscriptionConfigEditor from "./TranscriptionConfigEditor";

/**
 * Settings › Notes & Uploads › File Transcription: the engine uploads and URL
 * downloads are transcribed with. Its own selection, or Recognition's values
 * where it has none (selectResolvedUploadTranscription; never a live-only
 * provider), and its own self-hosted server.
 */
export function UploadTranscriptionPanel() {
  return (
    <div data-setting-id="notes.upload.engine" className="space-y-3">
      <TranscriptionConfigEditor surface="fileTranscription" />
    </div>
  );
}
