import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { isModeAllowedByPolicy } from "../../stores/policyRules";
import { requestSignIn } from "../../utils/requestSignIn";
import { useOpenWhisprCloudDisabled } from "../../stores/openWhisprCloudStore";
import { Button } from "../ui/button";
import { SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import TranscriptionConfigEditor from "./TranscriptionConfigEditor";
import { sttVisibleModes } from "./modelPicker/sttOptions";
import { useSttEffectiveMode } from "./modelPicker/useSttPickerContext";

export function MeetingSpeakerDetectionRow() {
  const { t } = useTranslation();
  const speakerDiarizationEnabled = useSettingsStore((s) => s.speakerDiarizationEnabled);
  const setSpeakerDiarizationEnabled = useSettingsStore((s) => s.setSpeakerDiarizationEnabled);

  return (
    <SettingsRow
      data-setting-id="notes.recording.speakerDetection"
      label={t("settings.meeting.speakerDetection.title")}
      description={t("settings.meeting.speakerDetection.description")}
    >
      <Toggle checked={speakerDiarizationEnabled} onChange={setSpeakerDiarizationEnabled} />
    </SettingsRow>
  );
}

function MeetingEchoCancellationRow() {
  const { t } = useTranslation();
  const meetingAecEnabled = useSettingsStore((s) => s.meetingAecEnabled);
  const setMeetingAecEnabled = useSettingsStore((s) => s.setMeetingAecEnabled);

  return (
    <SettingsRow
      data-setting-id="notes.recording.echoCancellation"
      label={t("settingsPage.transcription.aec.toggle.title")}
      description={t("settingsPage.transcription.aec.toggle.description")}
    >
      <Toggle checked={meetingAecEnabled} onChange={setMeetingAecEnabled} />
    </SettingsRow>
  );
}

export function MeetingTranscriptionPanel() {
  const { t } = useTranslation();
  const policySnapshot = usePolicySnapshot();
  const cloudDisabled = useOpenWhisprCloudDisabled();
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const meetingTranscriptionMode = useSettingsStore((s) => s.meetingTranscriptionMode);
  const effectiveTranscriptionMode = useSttEffectiveMode("liveRecording");

  // Only true when the org's policy actually allows the enterprise
  // transcription mode — an empty list can also mean e.g. a self-hosted-only
  // policy, where this specific explanation would be false.
  const emptyListIsEnterpriseOnly =
    sttVisibleModes("liveRecording", meetingTranscriptionMode, {
      policy: policySnapshot,
      cloudDisabled,
    }).length === 0 && isModeAllowedByPolicy(policySnapshot, "transcription", "enterprise");

  return (
    <div data-setting-id="notes.recording.engine" className="space-y-3">
      {emptyListIsEnterpriseOnly && (
        <p className="text-sm text-muted-foreground">
          {t("settingsPage.transcription.meetingEnterpriseOnly")}
        </p>
      )}
      <TranscriptionConfigEditor surface="liveRecording" />

      {effectiveTranscriptionMode === "openwhispr" && !isSignedIn && !cloudDisabled && (
        <p className="text-sm text-muted-foreground">
          {t("settingsPage.transcription.meetingCloudSignedOut")}{" "}
          <Button variant="link" className="h-auto p-0" onClick={requestSignIn}>
            {t("common.signIn")}
          </Button>
        </p>
      )}
      <MeetingSpeakerDetectionRow />
      <MeetingEchoCancellationRow />
    </div>
  );
}
