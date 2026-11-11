import { DICTIONARY_ECHO_CODE } from "../utils/dictionaryEchoFilter.js";
import { EMPTY_TRANSCRIPT_CODE } from "../utils/emptyDictation.js";
import { IPC_ERROR_FIELDS } from "./ipcErrorFields.js";

// How a transcription failure ends, for batch recordings and re-uploaded
// streaming ones alike. Silence is not reported. A transcript discarded as an
// echo of the dictionary prompt, audio Cloud found no speech in, or a
// provider's answer with no text reads as silence, but its recording is kept
// for a manual retry like any real failure's, or the utterance vanishes
// (#1547). How a silent dictation then ends (quietly or with "We didn't catch
// that") is emptyDictation.js's rule, by its length.
export const transcriptionFailureOutcome = (error) => {
  if (
    error.code === DICTIONARY_ECHO_CODE ||
    error.code === "NO_SPEECH_DETECTED" ||
    error.code === EMPTY_TRANSCRIPT_CODE
  ) {
    return { noAudio: true, keepAudio: true, report: null };
  }
  if (error.message === "No audio detected") {
    return { noAudio: true, keepAudio: false, report: null };
  }
  const report = {
    title: error.selectionEditFatal ? "Selection Edit Failed" : "Transcription Error",
    ...(error.selectionEditFatal ? { selectionEditFatal: true } : {}),
    description: error.selectionEditFatal
      ? error.message
      : `Transcription failed: ${error.message}`,
  };
  for (const key of IPC_ERROR_FIELDS) {
    if (error[key] !== undefined) report[key] = error[key];
  }
  // A transcript that outlived a later failure gets the pill's View Transcript.
  if (error.transcript) report.transcript = error.transcript;
  return { noAudio: false, keepAudio: true, report };
};
