import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { ChevronRight, Copy } from "../icons";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { formatBytes } from "../../utils/formatBytes";
import { useSettingsVisible } from "./useSettingsVisible";
import { useOpenSettingsLink } from "./settingsLink";
import { useLogInfo } from "./useLogInfo";
import CopyDiagnosticsDialog from "./CopyDiagnosticsDialog";
import { logLevelLabel, problemsToday } from "./logSettingsFormat";

/** Where "Manage in Storage" lands: the Logs section's first row. */
export const STORAGE_LOGS_DESTINATION = "storage#system.developer.debug";

/**
 * System › Diagnostics: a one-line summary of the log (level in force, how long
 * it's kept, its size, problems today) that links to Storage › Logs, and Copy
 * diagnostics.
 */
export default function DiagnosticsSection({ showing }: { showing: boolean }) {
  const { t } = useTranslation();
  const settingsVisible = useSettingsVisible();
  const openSettings = useOpenSettingsLink();
  const { info, problems, failed } = useLogInfo(showing && settingsVisible);
  const [copyOpen, setCopyOpen] = useState(false);

  let summary: string;
  if (info) {
    summary = t("settingsPage.diagnostics.summary", {
      level: logLevelLabel(info.effectiveLevel, t),
      days: t("settingsPage.privacy.retentionDays", { count: info.retentionDays }),
      size: formatBytes(info.totalBytes, 1),
      problems: t("settingsPage.diagnostics.problemsToday", {
        count: problemsToday(problems ?? []),
      }),
    });
  } else {
    summary = failed ? t("common.unknown") : t("common.loading");
  }

  return (
    <div>
      <SectionHeader title={t("settingsPage.diagnostics.title")} />
      <SettingsPanel data-setting-id="system.diagnostics">
        <SettingsPanelRow>
          <SettingsRow label={t("settingsPage.diagnostics.logs")} description={summary}>
            {openSettings && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-link"
                onClick={() => openSettings(STORAGE_LOGS_DESTINATION)}
              >
                {t("settingsPage.diagnostics.manage")}
                <ChevronRight aria-hidden="true" className="ms-1 h-3 w-3 rtl:rotate-180" />
              </Button>
            )}
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.diagnostics.copy.label")}
            description={t("settingsPage.diagnostics.copy.description")}
          >
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={!info}
              onClick={() => setCopyOpen(true)}
            >
              <Copy className="me-1.5 h-3.5 w-3.5" />
              {t("settingsPage.diagnostics.copy.button")}
            </Button>
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>
      <CopyDiagnosticsDialog
        open={copyOpen}
        onOpenChange={setCopyOpen}
        info={info}
        problems={problems}
      />
    </div>
  );
}
