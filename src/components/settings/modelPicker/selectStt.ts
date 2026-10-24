import { useCallback, useContext } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore, type SettingsState } from "../../../stores/settingsStore";
import type { InferenceMode, LocalTranscriptionProvider } from "../../../types/electron";
import { requestSignIn } from "../../../utils/requestSignIn";
import { ToastContext } from "../../ui/useToast";
import type { PickerUnavailable } from "./options";
import {
  STT_SURFACE_CONTEXT,
  sttPickAvailability,
  type SttPick,
  type SttPickerContext,
  type SttSurface,
} from "./sttOptions";

/**
 * The speech-to-text selection adapter: every pick in a surface's model picker
 * (Recognition, Live Recording, File Transcription) goes through
 * `commitSttSelection`, never a bare setter call. It revalidates the pick
 * against the live context (policy, Cloud switch and sign-in, saved keys,
 * downloaded models, sherpa support), then makes the writes the old editor's
 * handlers made for that choice, through the same store setters, in the same
 * order:
 * - a pick that changes the mode shown does what that surface's mode card did:
 *   the mode, the legacy local flag (`useLocalWhisper` / `meetingUseLocalWhisper`
 *   / `uploadUseLocalWhisper`; dictation also through
 *   `updateTranscriptionSettings`, as before), the cloud mode, and for the
 *   enterprise mode (Recognition, File Transcription) the transcription setup
 *   mode "managed"; `onModeChange` (Recognition's toast) fires only then;
 * - a cloud model does what the provider tab's model list did:
 *   `switchCloudTranscriptionProvider` when the surface's stored provider (raw:
 *   live recording and uploads may inherit with "") is another one — which
 *   remembers the outgoing model per provider (`transcriptionModelByProvider`)
 *   — then the surface's model setter;
 * - a local model does what the local model list did: the surface's local
 *   provider ("whisper", "nvidia" for Parakeet and Oruk, "cohere"), then that
 *   engine's model key, skipped when it is already the selected one;
 * - OpenWhispr Cloud while signed out asks to sign in and writes nothing;
 * - the custom endpoint's entry opens its fields (a model entered there
 *   commits); when the surface already points at the endpoint and another mode
 *   is shown, it picks the mode, as the Cloud providers card did.
 * Nothing is written by opening the picker or by browsing, so inherited values
 * stay inherited until something is picked. The old handlers called no server
 * IPC themselves, and neither does this: local servers follow the stored
 * dictation selection (`useSettings`' `syncStartupPreferences` effect, on which
 * main stops the other engine's server, or both on a cloud pick, and sets the
 * pre-warm variables), exactly as after the old editor's writes.
 */

export interface SttCommitDeps {
  /** The picker context, read live at commit time. */
  context: SttPickerContext;
  /** The mode the editor shows (policy-effective, as the mode cards reconciled it). */
  effectiveMode: InferenceMode | null;
  /** The settings store, read at each write (setters and raw values). */
  store: () => SettingsState;
  requestSignIn: () => void;
  onModeChange?: (mode: InferenceMode) => void;
}

export type SttCommitResult =
  | { status: "committed"; modeChanged: boolean }
  | { status: "signIn" }
  /** An entry that only opens fields under the picker, or a link. */
  | { status: "browse" }
  | { status: "refused"; reason: PickerUnavailable | null };

/** The surface's stored (raw) cloud provider: "" means live recording or uploads inherit. */
export function rawSttCloudProvider(surface: SttSurface, s: SettingsState): string {
  if (surface === "liveRecording") return s.meetingCloudTranscriptionProvider;
  if (surface === "fileTranscription") return s.uploadCloudTranscriptionProvider;
  return s.cloudTranscriptionProvider;
}

function rawLocal(surface: SttSurface, s: SettingsState) {
  if (surface === "liveRecording") {
    return {
      provider: s.meetingLocalTranscriptionProvider,
      whisper: s.meetingWhisperModel,
      nvidia: s.meetingParakeetModel,
      cohere: s.meetingCohereModel,
    };
  }
  if (surface === "fileTranscription") {
    return {
      provider: s.uploadLocalTranscriptionProvider,
      whisper: s.uploadWhisperModel,
      nvidia: s.uploadParakeetModel,
      cohere: s.uploadCohereModel,
    };
  }
  return {
    provider: s.localTranscriptionProvider,
    whisper: s.whisperModel,
    nvidia: s.parakeetModel,
    cohere: s.cohereModel,
  };
}

/** The mode card's writes (TranscriptionSection / MeetingTranscriptionPanel / UploadTranscriptionPanel). */
function writeMode(surface: SttSurface, s: SettingsState, mode: InferenceMode) {
  const local = mode === "local";
  const cloudMode = mode === "openwhispr" ? "openwhispr" : "byok";
  switch (surface) {
    case "dictation":
      s.setTranscriptionMode(mode);
      s.setUseLocalWhisper(local);
      s.updateTranscriptionSettings({ useLocalWhisper: local });
      s.setCloudTranscriptionMode(cloudMode);
      if (mode === "enterprise") s.setEnterpriseTranscriptionSetupMode("managed");
      return;
    case "liveRecording":
      s.setMeetingTranscriptionMode(mode);
      s.setMeetingUseLocalWhisper(local);
      s.setMeetingCloudTranscriptionMode(cloudMode);
      return;
    case "fileTranscription":
      s.setUploadTranscriptionMode(mode);
      s.setUploadUseLocalWhisper(local);
      s.setUploadCloudTranscriptionMode(cloudMode);
      if (mode === "enterprise") s.setEnterpriseTranscriptionSetupMode("managed");
      return;
  }
}

/** The surface's cloud-model setter (the old picker's `onCloudModelSelect`). */
export function sttCloudModelSetter(surface: SttSurface, s: SettingsState) {
  if (surface === "liveRecording") return s.setMeetingCloudTranscriptionModel;
  if (surface === "fileTranscription") return s.setUploadCloudTranscriptionModel;
  return s.setCloudTranscriptionModel;
}

/** A model from a provider's list (TranscriptionModelPicker's handleCloudModelSelect). */
export function writeSttCloudModel(
  surface: SttSurface,
  store: () => SettingsState,
  provider: string,
  model: string
) {
  if (provider !== rawSttCloudProvider(surface, store())) {
    store().switchCloudTranscriptionProvider(STT_SURFACE_CONTEXT[surface], provider);
  }
  sttCloudModelSetter(surface, store())(model);
}

/** A model from the local list (handleWhisperModelSelect / handleParakeetModelSelect). */
function writeLocalModel(
  surface: SttSurface,
  store: () => SettingsState,
  provider: string,
  model: string
) {
  const raw = rawLocal(surface, store());
  const selected =
    raw.provider === "nvidia" ? raw.nvidia : raw.provider === "cohere" ? raw.cohere : raw.whisper;
  // The model card ignored a click on the selected model.
  if (model === selected) return;
  const s = store();
  const localProvider = provider as LocalTranscriptionProvider;
  if (surface === "liveRecording") {
    s.setMeetingLocalTranscriptionProvider(localProvider);
    const next = store();
    if (provider === "nvidia") next.setMeetingParakeetModel(model);
    else if (provider === "cohere") next.setMeetingCohereModel(model);
    else next.setMeetingWhisperModel(model);
  } else if (surface === "fileTranscription") {
    s.setUploadLocalTranscriptionProvider(localProvider);
    const next = store();
    if (provider === "nvidia") next.setUploadParakeetModel(model);
    else if (provider === "cohere") next.setUploadCohereModel(model);
    else next.setUploadWhisperModel(model);
  } else {
    s.setLocalTranscriptionProvider(localProvider);
    const next = store();
    if (provider === "nvidia") next.setParakeetModel(model);
    else if (provider === "cohere") next.setCohereModel(model);
    else next.setWhisperModel(model);
  }
}

export function commitSttSelection(
  surface: SttSurface,
  pick: SttPick,
  deps: SttCommitDeps
): SttCommitResult {
  if (pick.action === "link") return { status: "browse" };

  // The custom endpoint's entry: its fields open; a model entered there commits.
  // A surface already on the endpoint (another mode shown) gets the mode back.
  const modeOnly = pick.action === "configureCustom";
  if (
    modeOnly &&
    (deps.context.current.cloudProvider !== "custom" || deps.effectiveMode === "providers")
  ) {
    return { status: "browse" };
  }

  const availability = sttPickAvailability(surface, pick, deps.context);
  if (availability !== true) {
    if (availability?.link?.kind === "signIn") {
      deps.requestSignIn();
      return { status: "signIn" };
    }
    return { status: "refused", reason: availability };
  }

  const modeChanged = pick.mode !== deps.effectiveMode;
  if (modeChanged) writeMode(surface, deps.store(), pick.mode);
  if (pick.mode === "providers" && pick.provider && !modeOnly) {
    writeSttCloudModel(surface, deps.store, pick.provider, pick.model);
  } else if (pick.mode === "local" && pick.provider) {
    writeLocalModel(surface, deps.store, pick.provider, pick.model);
  }
  if (modeChanged) deps.onModeChange?.(pick.mode);
  return { status: "committed", modeChanged };
}

export interface UseSttSelectionOptions {
  /** Reads the picker context (and the mode shown) as they are now. */
  readContext: () => { context: SttPickerContext; effectiveMode: InferenceMode | null };
  onModeChange?: (mode: InferenceMode) => void;
}

/**
 * The adapter wired to the live store: the context and the mode shown are
 * re-read at commit time, and a refused pick explains why in a toast (when a
 * toast host is mounted).
 */
export function useSttSelection(
  surface: SttSurface,
  { readContext, onModeChange }: UseSttSelectionOptions
): (pick: SttPick) => SttCommitResult {
  const { t } = useTranslation();
  const toasts = useContext(ToastContext);
  return useCallback(
    (pick: SttPick) => {
      const { context, effectiveMode } = readContext();
      const result = commitSttSelection(surface, pick, {
        context,
        effectiveMode,
        store: useSettingsStore.getState,
        requestSignIn,
        onModeChange,
      });
      if (result.status === "refused") {
        toasts?.toast({
          title: t("modelPicker.refused.title"),
          description: t(
            result.reason?.reasonKey ?? "modelPicker.refused.unavailable",
            result.reason?.reasonParams
          ),
          variant: "destructive",
          duration: 4000,
        });
      }
      return result;
    },
    [surface, readContext, onModeChange, t, toasts]
  );
}
