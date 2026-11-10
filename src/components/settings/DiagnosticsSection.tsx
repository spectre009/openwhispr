import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { AlertTriangle, ChevronRight, Copy, RotateCw } from "../icons";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { formatBytes } from "../../utils/formatBytes";
import { useSettingsVisible } from "./useSettingsVisible";
import { useOpenSettingsLink } from "./settingsLink";
import { useLogInfo } from "./useLogInfo";
import { useProcessSummary } from "./useProcessInventory";
import CopyDiagnosticsDialog from "./CopyDiagnosticsDialog";
import { graphicsNotice, logLevelLabel, problemsToday } from "./logSettingsFormat";
import { formatProcessBytes } from "./processInventoryFormat";

/** Where "Manage in Storage" lands: the Logs section's first row. */
export const STORAGE_LOGS_DESTINATION = "storage#system.developer.debug";
/** Where "Open Processes & resources" lands. */
export const PROCESSES_DESTINATION = "processes";

/**
 * System › Diagnostics: a one-line summary of the log (level in force, how long
 * it's kept, its size, problems today) that links to Storage › Logs, one of
 * OpenWhispr's processes (in RAM · how many · graphics memory) that links to
 * Processes & resources, and Copy diagnostics. When Chromium fell back to
 * drawing on the CPU, a warning row with Restart OpenWhispr comes first; a
 * launch flag's software mode gets a neutral note instead.
 */
export default function DiagnosticsSection({ showing }: { showing: boolean }) {
  const { t, i18n } = useTranslation();
  const settingsVisible = useSettingsVisible();
  const openSettings = useOpenSettingsLink();
  const { info, problems, failed } = useLogInfo(showing && settingsVisible);
  const processes = useProcessSummary(showing && settingsVisible);
  const [copyOpen, setCopyOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const graphics = graphicsNotice(info?.graphics);

  const restart = () => {
    setRestarting(true);
    Promise.resolve(window.electronAPI?.relaunchApp?.()).catch(() => setRestarting(false));
  };

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

  const snapshot = processes?.snapshot ?? null;
  let processSummary: string;
  if (processes === undefined) processSummary = t("common.loading");
  else if (processes === null) processSummary = t("common.unknown");
  else if (!snapshot) processSummary = t("settingsPage.diagnostics.processes.notMeasured");
  else {
    const parts: string[] = [];
    if (snapshot.totals.ws !== null) {
      parts.push(
        t("settingsPage.diagnostics.processes.inRam", {
          size: formatProcessBytes(snapshot.totals.ws, i18n.language),
        })
      );
    }
    parts.push(t("settingsPage.processes.count", { count: snapshot.totals.processes }));
    if (snapshot.totals.gpuDedicated !== null) {
      parts.push(
        t("settingsPage.diagnostics.processes.graphicsMemory", {
          size: formatProcessBytes(snapshot.totals.gpuDedicated, i18n.language),
        })
      );
    }
    processSummary = parts.join(" · ");
  }

  return (
    <div>
      <SectionHeader title={t("settingsPage.diagnostics.title")} />
      <SettingsPanel data-setting-id="system.diagnostics">
        {graphics && (
          <SettingsPanelRow data-setting-id="system.diagnostics.graphics">
            <SettingsRow
              label={t("settingsPage.diagnostics.graphics.label")}
              description={
                graphics === "fallback" ? (
                  <span
                    data-graphics-notice="fallback"
                    className="flex items-start gap-1.5 text-warning"
                  >
                    <AlertTriangle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{t("settingsPage.diagnostics.graphics.fallback")}</span>
                  </span>
                ) : (
                  <span data-graphics-notice="requested">
                    {t("settingsPage.diagnostics.graphics.requested")}
                  </span>
                )
              }
            >
              {graphics === "fallback" ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={restarting}
                  onClick={restart}
                >
                  <RotateCw className="me-1.5 h-3.5 w-3.5" />
                  {t("settingsPage.diagnostics.graphics.restart")}
                </Button>
              ) : null}
            </SettingsRow>
          </SettingsPanelRow>
        )}
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
        <SettingsPanelRow data-setting-id="system.diagnostics.processes">
          <SettingsRow
            label={t("settingsPage.diagnostics.processes.label")}
            description={<span data-process-summary="">{processSummary}</span>}
          >
            {openSettings && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-link"
                onClick={() => openSettings(PROCESSES_DESTINATION)}
              >
                {t("settingsPage.diagnostics.processes.open")}
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
