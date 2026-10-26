import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/dialog";
import { FolderOpen, Trash2 } from "../icons";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { formatBytes } from "../../utils/formatBytes";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import {
  effectiveAudioRetentionDays,
  effectiveLocalHistoryEnabled,
  maxAudioRetentionDays,
} from "../../stores/policyRules";
import {
  effectiveRecordingRetentionDays,
  recordingRetentionChoices,
} from "../../utils/retentionPeriods.js";
import { RECOMMENDED_RECORDING_QUALITY } from "../../utils/recordingQuality.js";
import type { RecordingPace, RecordingQuality } from "../../types/electron";
import {
  RECORDING_QUALITY_CHOICES,
  formatCount,
  formatMinutes,
  kbPerMinute,
  recordingEstimateBytes,
  retentionPeriodLabel,
} from "./storageFormat";

const SELECT_CLASS =
  "h-7 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-200";

type Usage = { fileCount: number; totalBytes: number };
type Notice = { tone: "ok" | "error"; text: string } | null;

interface RecordingsSectionProps {
  /** The page shows while Settings is visible: usage is read then, and after each action. */
  active: boolean;
  /** Dictations a day × their length, from main's inventory (estimates only). */
  pace: RecordingPace | null;
  /** The recordings folder with the user profile masked, from main's inventory. */
  folderPath: string | null;
  /** After Clear: the page measures again. */
  onChanged?: () => void;
}

/**
 * Storage › Recordings: how long recordings are kept (never longer than their
 * transcript), how new dictations are recorded (quality, with sizes a minute
 * and an estimate at the user's pace), the folder (Open) and Clear all.
 */
export default function RecordingsSection({
  active,
  pace,
  folderPath,
  onChanged,
}: RecordingsSectionProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const policy = usePolicySnapshot();
  const audioRetentionDays = useSettingsStore((s) => s.audioRetentionDays);
  const setAudioRetentionDays = useSettingsStore((s) => s.setAudioRetentionDays);
  const transcriptRetentionDays = useSettingsStore((s) => s.transcriptRetentionDays);
  const dataRetentionEnabled = useSettingsStore((s) => s.dataRetentionEnabled);
  const recordingQuality = useSettingsStore((s) => s.recordingQuality);
  const setRecordingQuality = useSettingsStore((s) => s.setRecordingQuality);

  const cap = maxAudioRetentionDays(policy);
  const enforcedDays = effectiveAudioRetentionDays(policy, audioRetentionDays);
  const historyOn = effectiveLocalHistoryEnabled(policy, dataRetentionEnabled);
  const keptDays = effectiveRecordingRetentionDays(enforcedDays, transcriptRetentionDays);
  const choices = recordingRetentionChoices(enforcedDays, cap);

  const [usage, setUsage] = useState<Usage | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const readUsage = useCallback(async () => {
    try {
      const next = await window.electronAPI?.getAudioStorageUsage?.();
      if (next && typeof next.fileCount === "number") setUsage(next);
    } catch {
      // keeps the last reading
    }
  }, []);

  useEffect(() => {
    if (active) void readUsage();
  }, [active, readUsage]);

  const usageText = (value: Usage) =>
    `${formatBytes(value.totalBytes, 1)} · ${t("settingsPage.storage.logs.fileCount", {
      count: value.fileCount,
    })}`;

  const clearAll = async () => {
    setNotice(null);
    try {
      const result = await window.electronAPI?.deleteAllAudio?.();
      const remaining = await window.electronAPI?.getAudioStorageUsage?.();
      if (remaining && typeof remaining.fileCount === "number") setUsage(remaining);
      if (result && result.failed > 0) {
        setNotice({
          tone: "error",
          text: t("settingsPage.storage.recordings.clear.partial", {
            remaining: remaining ? usageText(remaining) : "",
          }),
        });
      } else {
        setNotice({ tone: "ok", text: t("settingsPage.storage.recordings.clear.done") });
      }
    } catch {
      setNotice({ tone: "error", text: t("settingsPage.storage.recordings.clear.failed") });
    }
    onChanged?.();
  };

  const openFolder = async () => {
    try {
      const result = await window.electronAPI?.openRecordingsFolder?.();
      if (result && !result.success) {
        setNotice({ tone: "error", text: t("settingsPage.storage.recordings.folder.openFailed") });
      }
    } catch {
      setNotice({ tone: "error", text: t("settingsPage.storage.recordings.folder.openFailed") });
    }
  };

  const showEstimates = historyOn && keptDays > 0;
  const period = retentionPeriodLabel(keptDays, t);

  return (
    <div data-storage-section="recordings">
      <div className="mb-3">
        <h3 className="flex flex-wrap items-baseline gap-x-2 text-xs font-semibold tracking-tight text-foreground">
          {t("settingsPage.storage.recordings.title")}
          {usage && usage.fileCount > 0 && (
            <span className="font-normal text-muted-foreground">{usageText(usage)}</span>
          )}
        </h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
          {t("settingsPage.storage.recordings.description")}
        </p>
      </div>

      <SettingsPanel>
        <SettingsPanelRow data-setting-id="privacy.audioRetention">
          <SettingsRow
            label={t("settingsPage.storage.recordings.retention.label")}
            description={t("settingsPage.storage.recordings.retention.description")}
          >
            <select
              aria-label={t("settingsPage.storage.recordings.retention.label")}
              value={enforcedDays}
              onChange={(event) => {
                const days = parseInt(event.target.value, 10);
                if (cap !== null && days > cap) return;
                setAudioRetentionDays(days);
              }}
              className={SELECT_CLASS}
            >
              {choices.map(({ days, disabled }) => (
                <option key={days} value={days} disabled={disabled}>
                  {days === 0
                    ? t("settingsPage.storage.recordings.retention.off")
                    : retentionPeriodLabel(days, t)}
                </option>
              ))}
            </select>
          </SettingsRow>
          <div className="mt-2 space-y-1 text-xs leading-relaxed text-muted-foreground">
            {!historyOn && (
              <p data-recordings-note="historyOff" className="text-warning">
                {t("settingsPage.storage.recordings.retention.historyOff")}
              </p>
            )}
            <p data-recordings-note="transcript">
              {t("settingsPage.storage.recordings.retention.neverLonger")}
            </p>
            {keptDays > 0 && keptDays < enforcedDays && (
              <p data-recordings-note="effective">
                {t("settingsPage.storage.recordings.retention.effective", { period })}
              </p>
            )}
          </div>
        </SettingsPanelRow>

        <SettingsPanelRow data-setting-id="storage.recordings.quality">
          <p className="text-xs font-medium text-foreground">
            {t("settingsPage.storage.recordings.quality.label")}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
            {t("settingsPage.storage.recordings.quality.description")}
          </p>
          <div
            role="radiogroup"
            aria-label={t("settingsPage.storage.recordings.quality.label")}
            className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3"
          >
            {RECORDING_QUALITY_CHOICES.map((quality: RecordingQuality) => {
              const selected = quality === recordingQuality;
              const estimate = showEstimates
                ? recordingEstimateBytes(quality, pace, keptDays)
                : null;
              return (
                <button
                  key={quality}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-recording-quality={quality}
                  onClick={() => setRecordingQuality(quality)}
                  className={`rounded-md border px-3 py-2 text-start transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                    selected
                      ? "border-primary bg-primary/10"
                      : "border-border/70 bg-surface-1/60 hover:border-border-hover"
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-foreground">
                    {t(`settingsPage.storage.recordings.quality.${quality}.name`)}
                    {quality === RECOMMENDED_RECORDING_QUALITY && (
                      <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                        {t("common.recommended")}
                      </Badge>
                    )}
                    {quality === "original" && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                        {t("settingsPage.storage.recordings.quality.default")}
                      </Badge>
                    )}
                  </span>
                  <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                    {t(`settingsPage.storage.recordings.quality.${quality}.detail`)}
                  </span>
                  <span
                    data-quality-size
                    className="mt-1.5 block text-xs tabular-nums text-foreground"
                  >
                    {t("settingsPage.storage.recordings.quality.perMinute", {
                      size: formatCount(kbPerMinute(quality), locale),
                    })}
                  </span>
                  {estimate !== null && (
                    <span
                      data-quality-estimate
                      className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground"
                    >
                      {t("settingsPage.storage.recordings.quality.estimate", {
                        size: formatBytes(estimate, 1),
                        period,
                      })}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <p data-recordings-pace className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {!showEstimates
              ? t("settingsPage.storage.recordings.quality.noEstimateKept")
              : pace?.minutesPerDay
                ? t("settingsPage.storage.recordings.quality.pace", {
                    minutes: formatMinutes(pace.minutesPerDay, locale),
                  })
                : t("settingsPage.storage.recordings.quality.noPace")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
            {t("settingsPage.storage.recordings.quality.measured")}
          </p>
        </SettingsPanelRow>

        <SettingsPanelRow data-setting-id="privacy.audioStorage">
          <SettingsRow
            label={t("settingsPage.storage.recordings.folder.label")}
            description={
              <>
                <span className="block">
                  {usage
                    ? usage.fileCount > 0
                      ? usageText(usage)
                      : t("settingsPage.storage.recordings.folder.empty")
                    : t("common.loading")}
                </span>
                {folderPath && (
                  <span dir="ltr" className="block break-all font-mono text-[11px]">
                    {folderPath}
                  </span>
                )}
              </>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <span data-setting-id="storage.recordings.folder">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={openFolder}>
                  <FolderOpen className="me-1.5 h-3.5 w-3.5" />
                  {t("settingsPage.storage.recordings.folder.open")}
                </Button>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs text-destructive hover:text-destructive"
                disabled={!usage || usage.fileCount === 0}
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 className="me-1.5 h-3.5 w-3.5" />
                {t("settingsPage.storage.recordings.clear.button")}
              </Button>
            </div>
          </SettingsRow>
          {notice && (
            <p
              role="status"
              data-recordings-notice={notice.tone}
              className={`mt-2 text-xs leading-relaxed ${
                notice.tone === "error" ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {notice.text}
            </p>
          )}
        </SettingsPanelRow>
      </SettingsPanel>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t("settingsPage.storage.recordings.clear.title")}
        description={t("settingsPage.storage.recordings.clear.description")}
        confirmText={t("settingsPage.storage.recordings.clear.button")}
        cancelText={t("common.cancel")}
        variant="destructive"
        onConfirm={() => void clearAll()}
      />
    </div>
  );
}
