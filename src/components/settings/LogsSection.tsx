import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/dialog";
import { Toggle } from "../ui/toggle";
import { BidiInterpolatedText, BIDI_VALUE_TOKEN } from "../ui/BidiInterpolatedText";
import { Copy, FolderOpen, Trash2 } from "../icons";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { formatBytes } from "../../utils/formatBytes";
import type { LogProblem, LogSettingsUpdate } from "../../types/electron";
import { useSettingsVisible } from "./useSettingsVisible";
import { useLogInfo } from "./useLogInfo";
import CopyDiagnosticsDialog from "./CopyDiagnosticsDialog";
import {
  LOG_LEVEL_CHOICES,
  LOG_RETENTION_CHOICES,
  RECENT_PROBLEMS_FOLDED,
  formatProblemTime,
  logLevelLabel,
  overrideDiffers,
} from "./logSettingsFormat";

const SELECT_CLASS =
  "h-7 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-200";

const OVERRIDE_SOURCES = {
  flag: { key: "settingsPage.storage.logs.level.overriddenFlag", source: "--log-level" },
  env: { key: "settingsPage.storage.logs.level.overriddenEnv", source: "OPENWHISPR_LOG_LEVEL" },
} as const;

type Notice = { tone: "ok" | "error"; text: string } | null;

function ProblemList({ problems, locale }: { problems: readonly LogProblem[]; locale: string }) {
  const { t } = useTranslation();
  return (
    <ul data-log-problems className="mt-2 space-y-1.5">
      {problems.map((problem, index) => (
        <li
          key={`${problem.time}-${index}`}
          data-log-problem={problem.level}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
        >
          <span className="tabular-nums text-muted-foreground">
            {formatProblemTime(problem.time, locale)}
          </span>
          <Badge
            variant={problem.level === "warn" ? "warning" : "destructive"}
            className="px-1.5 py-0 text-[10px]"
          >
            {t(`settingsPage.storage.logs.problems.levels.${problem.level}`)}
          </Badge>
          <span dir="ltr" className="text-muted-foreground">
            {problem.area ?? "app"}
          </span>
          <span dir="ltr" className="min-w-0 basis-full break-words text-foreground sm:basis-auto">
            {problem.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Storage › Logs: what to log, how long to keep it, whether it may include
 * dictated text, its size and folder (Open, Clear logs), recent problems and
 * Copy diagnostics. Reads main when the page shows and after each action.
 */
export default function LogsSection({ showing }: { showing: boolean }) {
  const { t, i18n } = useTranslation();
  const settingsVisible = useSettingsVisible();
  const { info, setInfo, problems, failed, refresh } = useLogInfo(showing && settingsVisible);
  const [saving, setSaving] = useState(false);
  // The setting whose save failed, said under its own row.
  const [saveFailed, setSaveFailed] = useState<keyof LogSettingsUpdate | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const save = async (update: LogSettingsUpdate) => {
    if (!window.electronAPI?.setLogSettings) return;
    setSaving(true);
    setSaveFailed(null);
    try {
      const next = await window.electronAPI.setLogSettings(update);
      if (next && typeof next === "object") setInfo(next);
      void refresh();
    } catch {
      setSaveFailed(Object.keys(update)[0] as keyof LogSettingsUpdate);
    } finally {
      setSaving(false);
    }
  };

  const clearLogs = async () => {
    setNotice(null);
    try {
      const result = await window.electronAPI?.clearLogs?.();
      if (result?.failed?.length) {
        setNotice({
          tone: "error",
          text: t("settingsPage.storage.logs.clear.partial", { names: result.failed.join(", ") }),
        });
      } else {
        setNotice({ tone: "ok", text: t("settingsPage.storage.logs.clear.done") });
      }
    } catch {
      setNotice({ tone: "error", text: t("settingsPage.storage.logs.clear.failed") });
    }
    void refresh();
  };

  const openFolder = async () => {
    try {
      const result = await window.electronAPI?.openLogsFolder?.();
      if (result && !result.success) {
        setNotice({ tone: "error", text: t("settingsPage.storage.logs.folder.openFailed") });
      }
    } catch {
      setNotice({ tone: "error", text: t("settingsPage.storage.logs.folder.openFailed") });
    }
  };

  const locale = i18n.language;
  const blank = failed ? t("common.unknown") : t("common.loading");
  const sizeText = info
    ? `${formatBytes(info.totalBytes, 1)} · ${t("settingsPage.storage.logs.fileCount", {
        count: info.fileCount,
      })}`
    : "";
  const override = info && overrideDiffers(info) ? OVERRIDE_SOURCES[info.overriddenBy!] : null;
  const allProblems = problems ?? [];
  const shownProblems = showAll ? allProblems : allProblems.slice(0, RECENT_PROBLEMS_FOLDED);
  const saveError = (field: keyof LogSettingsUpdate) =>
    saveFailed === field ? (
      <p role="alert" className="mt-2 text-xs text-destructive">
        {t("settingsPage.storage.logs.saveFailed")}
      </p>
    ) : null;

  return (
    <div data-storage-section="logs">
      <div className="mb-3">
        <h3 className="flex flex-wrap items-baseline gap-x-2 text-xs font-semibold tracking-tight text-foreground">
          {t("settingsPage.storage.logs.title")}
          {sizeText && <span className="font-normal text-muted-foreground">{sizeText}</span>}
        </h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
          {t("settingsPage.storage.logs.description")}
        </p>
      </div>

      <SettingsPanel>
        <SettingsPanelRow data-setting-id="system.developer.debug">
          <SettingsRow
            label={t("settingsPage.storage.logs.level.label")}
            description={t("settingsPage.storage.logs.level.description")}
          >
            <select
              aria-label={t("settingsPage.storage.logs.level.label")}
              value={info?.level ?? ""}
              disabled={!info || saving}
              onChange={(event) =>
                void save({ level: event.target.value as LogSettingsUpdate["level"] })
              }
              className={SELECT_CLASS}
            >
              {!info && <option value="">{blank}</option>}
              {LOG_LEVEL_CHOICES.map((level) => (
                <option key={level} value={level}>
                  {logLevelLabel(level, t)}
                </option>
              ))}
            </select>
          </SettingsRow>
          {override && info && (
            <p
              data-log-override={info.overriddenBy}
              className="mt-2 text-xs leading-relaxed text-warning"
            >
              <BidiInterpolatedText
                text={t(override.key, {
                  level: logLevelLabel(info.effectiveLevel, t),
                  source: BIDI_VALUE_TOKEN,
                })}
                value={override.source}
              />
            </p>
          )}
          {saveError("level")}
        </SettingsPanelRow>

        <SettingsPanelRow data-setting-id="storage.logs.retention">
          <SettingsRow
            label={t("settingsPage.storage.logs.retention.label")}
            description={t("settingsPage.storage.logs.retention.description")}
          >
            <select
              aria-label={t("settingsPage.storage.logs.retention.label")}
              value={info?.retentionDays ?? ""}
              disabled={!info || saving}
              onChange={(event) =>
                void save({
                  retentionDays: Number(event.target.value) as LogSettingsUpdate["retentionDays"],
                })
              }
              className={SELECT_CLASS}
            >
              {!info && <option value="">{blank}</option>}
              {LOG_RETENTION_CHOICES.map((days) => (
                <option key={days} value={days}>
                  {t("settingsPage.privacy.retentionDays", { count: days })}
                </option>
              ))}
            </select>
          </SettingsRow>
          {saveError("retentionDays")}
        </SettingsPanelRow>

        <SettingsPanelRow data-setting-id="storage.logs.text">
          <SettingsRow
            label={t("settingsPage.storage.logs.text.label")}
            description={t("settingsPage.storage.logs.text.description")}
          >
            <Toggle
              ariaLabel={t("settingsPage.storage.logs.text.label")}
              checked={info?.includeText === true}
              disabled={!info || saving}
              onChange={(includeText) => void save({ includeText })}
            />
          </SettingsRow>
          {saveError("includeText")}
        </SettingsPanelRow>

        <SettingsPanelRow data-setting-id="system.developer.logs">
          <SettingsRow
            label={t("settingsPage.storage.logs.folder.label")}
            description={
              <>
                <span className="block">
                  {info
                    ? info.fileCount > 0
                      ? sizeText
                      : t("settingsPage.storage.logs.folder.empty")
                    : blank}
                </span>
                {info?.logsDir && (
                  <span dir="ltr" className="block break-all font-mono text-[11px]">
                    {info.logsDir}
                  </span>
                )}
                {info?.currentFile && (
                  <span className="block">
                    <BidiInterpolatedText
                      text={t("settingsPage.storage.logs.folder.current", {
                        name: BIDI_VALUE_TOKEN,
                      })}
                      value={<span className="font-mono text-[11px]">{info.currentFile}</span>}
                    />
                  </span>
                )}
              </>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={openFolder}>
                <FolderOpen className="me-1.5 h-3.5 w-3.5" />
                {t("settingsPage.storage.logs.folder.open")}
              </Button>
              <span data-setting-id="storage.logs.clear">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs text-destructive hover:text-destructive"
                  disabled={!info || info.fileCount === 0}
                  onClick={() => setConfirmClear(true)}
                >
                  <Trash2 className="me-1.5 h-3.5 w-3.5" />
                  {t("settingsPage.storage.logs.clear.button")}
                </Button>
              </span>
            </div>
          </SettingsRow>
          {notice && (
            <p
              role="status"
              data-log-notice={notice.tone}
              className={`mt-2 text-xs leading-relaxed ${
                notice.tone === "error" ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {notice.text}
            </p>
          )}
        </SettingsPanelRow>

        <SettingsPanelRow data-setting-id="storage.logs.problems">
          <p className="text-xs font-medium text-foreground">
            {t("settingsPage.storage.logs.problems.label")}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
            {problems === null
              ? blank
              : allProblems.length === 0
                ? t("settingsPage.storage.logs.problems.none")
                : t("settingsPage.storage.logs.problems.description")}
          </p>
          {shownProblems.length > 0 && <ProblemList problems={shownProblems} locale={locale} />}
          {allProblems.length > RECENT_PROBLEMS_FOLDED && (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="mt-2 text-xs text-link underline decoration-link/30 hover:decoration-link/60"
            >
              {showAll
                ? t("common.showLess")
                : t("settingsPage.storage.logs.problems.showAll", { total: allProblems.length })}
            </button>
          )}
        </SettingsPanelRow>

        <SettingsPanelRow data-setting-id="storage.logs.diagnostics">
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

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t("settingsPage.storage.logs.clear.title")}
        description={t("settingsPage.storage.logs.clear.description")}
        confirmText={t("settingsPage.storage.logs.clear.button")}
        cancelText={t("common.cancel")}
        variant="destructive"
        onConfirm={() => void clearLogs()}
      />
      <CopyDiagnosticsDialog
        open={copyOpen}
        onOpenChange={setCopyOpen}
        info={info}
        problems={problems}
      />
    </div>
  );
}
