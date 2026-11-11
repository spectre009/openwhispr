import { EnterpriseAudioSettings } from "./EnterpriseAudioSettings";
import { ManagedTranscriptionCard } from "./ManagedTranscriptionCard";
import TranscriptionConfigEditor from "./TranscriptionConfigEditor";
import { useSttManagedResolution } from "./modelPicker/useSttPickerContext";

/**
 * Settings › Notes & Uploads › File Transcription: the engine uploads and URL
 * downloads are transcribed with. Its own selection, or Recognition's values
 * where it has none (selectResolvedUploadTranscription; never a live-only
 * provider), and its own self-hosted server. While the organization's managed
 * setup answers uploads (#2989), its card shows instead of the picker.
 */
export function UploadTranscriptionPanel() {
  const managed = useSttManagedResolution("fileTranscription");
  return (
    <div data-setting-id="notes.upload.engine" className="space-y-3">
      <EnterpriseAudioSettings />
      <ManagedTranscriptionCard managed={managed} />
      {managed.kind === "manual" && <TranscriptionConfigEditor surface="fileTranscription" />}
    </div>
  );
}
