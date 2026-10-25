import type { BuildChannel, BuildInfoResult } from "../../types/electron";

// Formatting for System › This build (BuildInfoPanel.tsx). React-free.

/** The folder an executable path sits in (either separator). */
export function exeFolder(exePath: string | null | undefined): string | null {
  if (!exePath) return null;
  const cut = Math.max(exePath.lastIndexOf("\\"), exePath.lastIndexOf("/"));
  return cut > 0 ? exePath.slice(0, cut) : exePath;
}

function relativeFormat(locale?: string): Intl.RelativeTimeFormat {
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  }
}

/** "8 hours ago" in the UI language: minutes below an hour, hours below two days. */
export function formatAgo(seconds: number, locale?: string): string {
  const rtf = relativeFormat(locale);
  const elapsed = Math.max(0, Math.floor(seconds));
  if (elapsed < 60) return rtf.format(0, "second");
  if (elapsed < 3600) return rtf.format(-Math.floor(elapsed / 60), "minute");
  if (elapsed < 48 * 3600) return rtf.format(-Math.floor(elapsed / 3600), "hour");
  return rtf.format(-Math.floor(elapsed / 86400), "day");
}

/** Local date and time, or null for something that isn't a date. */
export function formatLocalDateTime(
  iso: string | null | undefined,
  locale?: string
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
  try {
    return date.toLocaleString(locale, options);
  } catch {
    return date.toLocaleString(undefined, options);
  }
}

/** "Electron 41.0.0 · Chromium 146.0.7680.31 · Node 24.11.1", leaving out what's unknown. */
export function engineText(info: Pick<BuildInfoResult, "electron" | "chrome" | "node">): string {
  return (
    [
      ["Electron", info.electron],
      ["Chromium", info.chrome],
      ["Node", info.node],
    ] as const
  )
    .filter(([, version]) => version)
    .map(([name, version]) => `${name} ${version}`)
    .join(" · ");
}

const CHANNEL_TEXT: Record<BuildChannel, string> = {
  "selfhost-stable": "self-built (selfhost Stable)",
  release: "official release",
  source: "running from source (selfhost Dev or npm run dev)",
};

function uptimeText(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Copy build info: plain English lines for a bug report, whatever the UI
 * language, with UTC times. Main has already replaced the user profile prefix
 * of the path, so no user name is copied.
 */
export function buildInfoText(info: BuildInfoResult, uptimeSec: number = info.uptimeSec): string {
  const built = info.builtAt ?? (info.channel === "source" ? "running from source" : "unknown");
  const lines = [
    `OpenWhispr ${info.version}`,
    `Channel: ${CHANNEL_TEXT[info.channel] ?? info.channel}`,
    `Built: ${built}`,
    `Commit: ${info.commit ?? "unknown"}${info.dirty ? " (uncommitted changes)" : ""}`,
  ];
  if (info.commitSubject) lines.push(`Subject: ${info.commitSubject}`);
  lines.push(
    `Running since: ${info.startedAt} (up ${uptimeText(uptimeSec)})`,
    `Installed at: ${exeFolder(info.exePath) ?? "unknown"}`,
    `Engine: ${engineText(info) || "unknown"}`
  );
  return lines.join("\n");
}
