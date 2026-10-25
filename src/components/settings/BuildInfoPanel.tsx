import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Check, Copy } from "../icons";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { useSettingsLayout } from "../ui/useSettingsLayout";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { useSettingsVisible } from "./useSettingsVisible";
import type { BuildInfoResult } from "../../types/electron";
import {
  buildInfoText,
  engineText,
  exeFolder,
  formatAgo,
  formatLocalDateTime,
} from "./buildInfoFormat";

const MINUTE_MS = 60_000;

interface BuildInfoPanelProps {
  /** The System page is on screen; with Settings visible, relative times tick. */
  showing: boolean;
  /** Shown until main answers, or when it can't. */
  fallbackVersion: string;
  updateAvailable: boolean;
  updatesSupported: boolean;
}

interface Loaded {
  info: BuildInfoResult;
  receivedAt: number;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}

/**
 * System › This build: version, when and from which commit it was built, since
 * when it runs and from where (`get-build-info`), and Copy build info.
 */
export default function BuildInfoPanel({
  showing,
  fallbackVersion,
  updateAvailable,
  updatesSupported,
}: BuildInfoPanelProps) {
  const { t, i18n } = useTranslation();
  const { isCompact } = useSettingsLayout();
  const settingsVisible = useSettingsVisible();
  const active = showing && settingsVisible;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.electronAPI?.getBuildInfo?.())
      .then((info) => {
        if (cancelled) return;
        if (info && typeof info === "object") setLoaded({ info, receivedAt: Date.now() });
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, [active]);

  const info = loaded?.info ?? null;
  const locale = i18n.language;
  const unknown = t("common.unknown");
  const blank = !info && !failed ? t("settingsPage.general.updates.versionPlaceholder") : unknown;
  const uptimeSec = loaded
    ? loaded.info.uptimeSec + Math.max(0, now - loaded.receivedAt) / 1000
    : 0;
  const copyText = info ? buildInfoText(info, uptimeSec) : "";
  const { copied, copy } = useCopyFeedback(copyText);

  const withAgo = (iso: string | null, elapsedSec: number) => {
    const time = formatLocalDateTime(iso, locale);
    if (!time) return null;
    return t("settingsPage.general.build.withRelative", {
      time,
      relative: formatAgo(elapsedSec, locale),
    });
  };

  const runningFromSource = info?.channel === "source";
  let built: string = blank;
  if (info) {
    built = runningFromSource
      ? t("settingsPage.general.build.runningFromSource")
      : (withAgo(info.builtAt, (now - Date.parse(info.builtAt ?? "")) / 1000) ?? unknown);
  }
  const runningSince = info ? (withAgo(info.startedAt, uptimeSec) ?? unknown) : blank;
  const folder = exeFolder(info?.exePath);
  const engine = info ? engineText(info) : "";

  let tag: React.ReactNode = null;
  if (runningFromSource) {
    tag = <Badge variant="warning">{t("settingsPage.general.build.runningFromSource")}</Badge>;
  } else if (info?.channel === "selfhost-stable") {
    tag = <Badge variant="outline">{t("settingsPage.general.updates.badges.selfBuilt")}</Badge>;
  } else if (info?.channel === "release" && updateAvailable) {
    tag = <Badge variant="success">{t("settingsPage.general.updates.badges.update")}</Badge>;
  } else if (info?.channel === "release" && updatesSupported) {
    tag = <Badge variant="outline">{t("settingsPage.general.updates.badges.latest")}</Badge>;
  }

  return (
    <div>
      <SectionHeader title={t("settingsPage.general.build.title")} />
      <SettingsPanel data-setting-id="system.updates.version">
        <SettingsPanelRow>
          <dl
            data-build-info
            className={`grid gap-x-4 gap-y-2 text-xs ${
              isCompact ? "grid-cols-1" : "grid-cols-[10rem_minmax(0,1fr)]"
            }`}
          >
            <Field label={t("settingsPage.general.build.version")}>
              <span className="flex flex-wrap items-center gap-2">
                <span dir="ltr" className="font-mono tabular-nums">
                  {info?.version || fallbackVersion || blank}
                </span>
                {tag}
              </span>
            </Field>
            <Field label={t("settingsPage.general.build.built")}>{built}</Field>
            <Field label={t("settingsPage.general.build.commit")}>
              {info?.commit ? (
                <span className="break-words">
                  <span dir="ltr" className="font-mono">
                    {info.commit.slice(0, 8)}
                  </span>
                  {info.dirty && (
                    <span className="text-warning">
                      {" · "}
                      {t("settingsPage.general.build.uncommittedChanges")}
                    </span>
                  )}
                  {info.commitSubject && (
                    <span className="text-muted-foreground">
                      {" · "}
                      <bdi>{info.commitSubject}</bdi>
                    </span>
                  )}
                </span>
              ) : (
                blank
              )}
            </Field>
            <Field label={t("settingsPage.general.build.runningSince")}>{runningSince}</Field>
            <Field label={t("settingsPage.general.build.installedAt")}>
              {folder ? (
                <span dir="ltr" className="block break-all font-mono text-muted-foreground">
                  {folder}
                </span>
              ) : (
                blank
              )}
            </Field>
            <Field label={t("settingsPage.general.build.engine")}>
              {engine ? (
                <span dir="ltr" className="text-muted-foreground">
                  {engine}
                </span>
              ) : (
                blank
              )}
            </Field>
          </dl>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.general.build.copyLabel")}
            description={t("settingsPage.general.build.copyDescription")}
          >
            <Button variant="outline" size="sm" onClick={copy} disabled={!info}>
              {copied ? (
                <Check className="me-1.5 h-3.5 w-3.5" />
              ) : (
                <Copy className="me-1.5 h-3.5 w-3.5" />
              )}
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}
