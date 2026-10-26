import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { ChevronRight } from "../icons";
import { SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { formatBytes } from "../../utils/formatBytes";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import {
  effectiveAudioRetentionDays,
  effectiveLocalHistoryEnabled,
} from "../../stores/policyRules";
import { effectiveRecordingRetentionDays } from "../../utils/retentionPeriods.js";
import { useSettingsVisible } from "./useSettingsVisible";
import { useOpenSettingsLink } from "./settingsLink";
import { useLogInfo } from "./useLogInfo";
import { STORAGE_LOGS_DESTINATION } from "./DiagnosticsSection";
import { logLevelLabel } from "./logSettingsFormat";
import { retentionPeriodLabel } from "./storageFormat";

/** Where the Recordings summary's "Manage in Storage" lands. */
export const STORAGE_RECORDINGS_DESTINATION = "storage#privacy.audioRetention";

function ManageInStorage({ destination }: { destination: string }) {
  const { t } = useTranslation();
  const openSettings = useOpenSettingsLink();
  if (!openSettings) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs text-link"
      onClick={() => openSettings(destination)}
    >
      {t("settingsPage.diagnostics.manage")}
      <ChevronRight aria-hidden="true" className="ms-1 h-3 w-3 rtl:rotate-180" />
    </Button>
  );
}

/**
 * Privacy & Data's summaries of what Storage manages: recordings (how long
 * they're kept, their size) and logs (the level in force, their size), each
 * linking to its section. They carry their own anchors, not the settings'.
 */
export default function PrivacyStorageSummary({ showing }: { showing: boolean }) {
  const { t } = useTranslation();
  const settingsVisible = useSettingsVisible();
  const active = showing && settingsVisible;
  const policy = usePolicySnapshot();
  const audioRetentionDays = useSettingsStore((s) => s.audioRetentionDays);
  const transcriptRetentionDays = useSettingsStore((s) => s.transcriptRetentionDays);
  const dataRetentionEnabled = useSettingsStore((s) => s.dataRetentionEnabled);
  const { info } = useLogInfo(active);
  const [usage, setUsage] = useState<{ fileCount: number; totalBytes: number } | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    Promise.resolve(window.electronAPI?.getAudioStorageUsage?.())
      .then((next) => {
        if (!cancelled && next && typeof next.fileCount === "number") setUsage(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active]);

  const keptDays = effectiveLocalHistoryEnabled(policy, dataRetentionEnabled)
    ? effectiveRecordingRetentionDays(
        effectiveAudioRetentionDays(policy, audioRetentionDays),
        transcriptRetentionDays
      )
    : 0;
  const retention =
    keptDays > 0
      ? t("settingsPage.privacy.recordingsSummary.kept", {
          period: retentionPeriodLabel(keptDays, t),
        })
      : t("settingsPage.privacy.recordingsSummary.notSaved");
  const recordingsLine = usage
    ? `${retention} · ${
        usage.fileCount > 0
          ? formatBytes(usage.totalBytes, 1)
          : t("settingsPage.storage.recordings.folder.empty")
      }`
    : retention;
  const logsLine = info
    ? `${logLevelLabel(info.effectiveLevel, t)} · ${formatBytes(info.totalBytes, 1)}`
    : t("common.loading");

  return (
    <>
      <SettingsPanelRow data-setting-id="privacy.recordingsSummary">
        <SettingsRow
          label={t("settingsPage.privacy.recordingsSummary.label")}
          description={recordingsLine}
        >
          <ManageInStorage destination={STORAGE_RECORDINGS_DESTINATION} />
        </SettingsRow>
      </SettingsPanelRow>
      <SettingsPanelRow data-setting-id="privacy.logsSummary">
        <SettingsRow label={t("settingsPage.privacy.logsSummary.label")} description={logsLine}>
          <ManageInStorage destination={STORAGE_LOGS_DESTINATION} />
        </SettingsRow>
      </SettingsPanelRow>
    </>
  );
}
