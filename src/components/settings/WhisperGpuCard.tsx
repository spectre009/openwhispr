import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { DownloadProgressBar } from "../ui/DownloadProgressBar";
import { Check, CircleAlert, Zap } from "../icons";
import type { DownloadProgress } from "../../hooks/useModelDownload";
import { getCachedPlatform } from "../../utils/platform";
import { pickWhisperGpuBackend } from "../../utils/whisperGpuPack";
import { useSettingsVisible } from "./useSettingsVisible";

interface GpuWarningRowProps {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  onRemove: () => void;
  children?: ReactNode;
}

function GpuWarningRow({
  title,
  description,
  actionLabel,
  onAction,
  onRemove,
  children,
}: GpuWarningRowProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlert size={15} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>
          {children}
          <Button onClick={onAction} size="sm" className="mt-2 h-7 px-3 text-xs">
            {actionLabel}
          </Button>
        </div>
      </div>
      <Button
        onClick={onRemove}
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
      >
        {t("gpu.remove")}
      </Button>
    </div>
  );
}

/**
 * whisper.cpp's GPU acceleration pack (CUDA on NVIDIA, Vulkan elsewhere, named in its lines): offer
 * the pack this GPU can run, show its download, whether the running server is
 * actually on the GPU (never inferred from a download), a GPU→CPU fallback and
 * the whisper-server error line main saved with it (#1736), and Remove. Shown
 * under a speech-to-text picker while a Whisper model is selected; mounting it
 * is what reads the status (none on macOS, which runs Metal). Moved unchanged
 * from the old speech-to-text model picker's Whisper tab.
 */
export default function WhisperGpuCard() {
  const { t } = useTranslation();
  const [gpuBackend, setGpuBackend] = useState<"cuda" | "vulkan" | null>(null);
  const [gpuDownloaded, setGpuDownloaded] = useState(false);
  // Settings stays mounted while closed; the live GPU status polls only while it's shown.
  const settingsVisible = useSettingsVisible();
  const [gpuDownloading, setGpuDownloading] = useState(false);
  const [gpuProgress, setGpuProgress] = useState<DownloadProgress>({
    downloadedBytes: 0,
    totalBytes: 0,
    percentage: 0,
  });
  const [gpuDismissed, setGpuDismissed] = useState(false);
  // The pack fell back to CPU on this machine (persisted by main until retried)
  const [gpuFailed, setGpuFailed] = useState(false);
  // The whisper-server error line main saved with that failure (#1736)
  const [gpuFailReason, setGpuFailReason] = useState<string | null>(null);
  // An older release installed the pack and this version can't use it (#2424)
  const [gpuNeedsUpdate, setGpuNeedsUpdate] = useState(false);
  // Why the last pack download failed (cleared by the next attempt)
  const [gpuDownloadError, setGpuDownloadError] = useState<string | null>(null);
  // The running download was started before Settings was last opened, so no
  // pending call here will report its end: its status is polled instead
  const [gpuResumedDownload, setGpuResumedDownload] = useState(false);
  const gpuDownloadCancelledRef = useRef(false);
  // A server reload with the new backend is in flight (Vulkan cold starts are slow)
  const [gpuActivating, setGpuActivating] = useState(false);
  // Live truth from the running server; "active" is never inferred from a download
  const [gpuActive, setGpuActive] = useState(false);
  // The pack's backend, named in every status line (#1982)
  const gpuBackendName = gpuBackend === "cuda" ? "CUDA" : "Vulkan";

  const readGpuStatus = useCallback(async () => {
    try {
      const [cuda, vulkan] = await Promise.all([
        window.electronAPI?.getCudaWhisperStatus?.(),
        window.electronAPI?.getVulkanWhisperStatus?.(),
      ]);
      // No pack to show or offer hides the card. A re-read can land here after
      // another card removed the pack this one shows, so reset, never keep it.
      const backend = pickWhisperGpuBackend(cuda, vulkan);
      const status = backend === "cuda" ? cuda : backend === "vulkan" ? vulkan : null;
      setGpuBackend(backend);
      setGpuDownloaded(!!status?.downloaded);
      setGpuFailed(!!status?.gpuFailed);
      setGpuFailReason(status?.gpuFailReason ?? null);
      setGpuNeedsUpdate(!!status?.needsUpdate);
      // A failed attempt's error must not outlive the state it was about
      setGpuDownloadError(null);
      // A download is still running that no pending call here may report the
      // end of: one started before Settings was opened, or on another card
      if (status?.downloading) {
        setGpuDownloading(true);
        setGpuResumedDownload(true);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (getCachedPlatform() === "darwin") return;
    readGpuStatus();
    // Retry on the fallback pop-up, or Remove on another card, changes the
    // packs or the saved failure while this card stays mounted (#1736)
    return window.electronAPI?.onWhisperGpuStatusChanged?.(readGpuStatus);
  }, [readGpuStatus]);

  useEffect(() => {
    if (!gpuDownloading || !gpuBackend) return;
    const subscribe =
      gpuBackend === "cuda"
        ? window.electronAPI?.onCudaDownloadProgress
        : window.electronAPI?.onVulkanWhisperDownloadProgress;
    return subscribe?.((data) => setGpuProgress(data));
  }, [gpuDownloading, gpuBackend]);

  useEffect(() => {
    if (!gpuResumedDownload || !gpuBackend) return;
    const id = setInterval(async () => {
      try {
        const status =
          gpuBackend === "cuda"
            ? await window.electronAPI?.getCudaWhisperStatus?.()
            : await window.electronAPI?.getVulkanWhisperStatus?.();
        if (!status || status.downloading) return;
        setGpuResumedDownload(false);
        setGpuDownloading(false);
        setGpuDownloaded(status.downloaded);
        setGpuFailed(!!status.gpuFailed);
        setGpuNeedsUpdate(!!status.needsUpdate);
      } catch {}
    }, 1000);
    return () => clearInterval(id);
  }, [gpuResumedDownload, gpuBackend]);

  // Live server state: "GPU acceleration active" reflects what the server is
  // actually running on, not just that a pack is on disk (a crashed GPU server
  // silently falls back to CPU). Faster poll while an activation is in flight.
  // Polls again at once when a re-read switches the card to another pack.
  useEffect(() => {
    if (!settingsVisible) return;
    if (!gpuDownloaded) return;
    const poll = () => {
      window.electronAPI
        ?.whisperServerStatus?.()
        .then((status) => {
          setGpuActive(!!status?.gpuAccelerated);
          if (status?.gpuAccelerated) setGpuActivating(false);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, gpuActivating ? 1000 : 5000);
    return () => clearInterval(id);
  }, [gpuDownloaded, gpuActivating, gpuBackend, settingsVisible]);

  // Safety valve: a Vulkan cold start can take up to ~2 minutes (see #698);
  // past that the live status or a fallback notification settles the state.
  useEffect(() => {
    if (!gpuActivating) return;
    const timeout = setTimeout(() => setGpuActivating(false), 150_000);
    return () => clearTimeout(timeout);
  }, [gpuActivating]);

  // Main falls back to CPU (and remembers it) when a GPU server crashes. It
  // saves the failure before it notifies, so the re-read shows the pack main
  // now reports in use, exactly as reopening Settings would (#1736).
  useEffect(() => {
    const onFallback = () => {
      setGpuFailed(true);
      // Never show the previous failure's reason while the new one loads
      setGpuFailReason(null);
      setGpuActivating(false);
      setGpuActive(false);
      readGpuStatus();
    };
    const disposeCuda = window.electronAPI?.onCudaFallbackNotification?.(onFallback);
    const disposeVulkan = window.electronAPI?.onGpuFallbackNotification?.(onFallback);
    return () => {
      disposeCuda?.();
      disposeVulkan?.();
    };
  }, [readGpuStatus]);

  const handleGpuDownload = async () => {
    setGpuDownloading(true);
    setGpuDownloadError(null);
    gpuDownloadCancelledRef.current = false;
    try {
      const result =
        gpuBackend === "cuda"
          ? await window.electronAPI?.downloadCudaWhisperBinary?.()
          : await window.electronAPI?.downloadVulkanWhisperBinary?.();
      if (result?.success) {
        setGpuDownloaded(true);
        setGpuFailed(false);
        setGpuNeedsUpdate(false);
        // Main reloads the server with the new backend only when one is loaded;
        // otherwise the pack simply engages on the next dictation.
        setGpuActivating(!!result.willRestart);
      } else if (result && !gpuDownloadCancelledRef.current) {
        setGpuDownloadError(result.error ?? "");
      }
    } finally {
      setGpuDownloading(false);
    }
  };

  const handleGpuRetry = async () => {
    setGpuFailed(false);
    const result = await window.electronAPI?.whisperGpuRetry?.();
    setGpuActivating(!!result?.willRestart);
  };

  const handleGpuDelete = async () => {
    const result =
      gpuBackend === "cuda"
        ? await window.electronAPI?.deleteCudaWhisperBinary?.()
        : await window.electronAPI?.deleteVulkanWhisperBinary?.();
    if (result?.success) {
      setGpuDownloaded(false);
      setGpuFailed(false);
      setGpuNeedsUpdate(false);
      setGpuDownloadError(null);
      setGpuActivating(false);
      setGpuActive(false);
    }
  };

  const handleGpuCancel = async () => {
    gpuDownloadCancelledRef.current = true;
    if (gpuBackend === "cuda") await window.electronAPI?.cancelCudaWhisperDownload?.();
    else await window.electronAPI?.cancelVulkanWhisperDownload?.();
    setGpuDownloading(false);
  };

  return (
    <>
      {gpuDownloading && (
        <div>
          <DownloadProgressBar modelName="GPU acceleration" progress={gpuProgress} />
          <div className="px-2.5 pb-1 flex justify-end">
            <button
              onClick={handleGpuCancel}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("gpu.cancel")}
            </button>
          </div>
        </div>
      )}

      {!gpuDismissed && !gpuDownloading && gpuBackend && (
        <div
          className={`rounded-md border p-2.5 ${
            (gpuDownloaded ? gpuFailed : gpuNeedsUpdate)
              ? "border-warning/40 bg-warning/5"
              : "border-border bg-surface-1"
          }`}
        >
          {gpuDownloaded ? (
            gpuFailed ? (
              <GpuWarningRow
                title={t("gpu.activationFailed")}
                description={t("gpu.activationFailedDescription")}
                actionLabel={t("gpu.retryActivation")}
                onAction={handleGpuRetry}
                onRemove={handleGpuDelete}
              >
                {gpuFailReason && (
                  <p
                    dir="ltr"
                    className="mt-1 wrap-break-word font-mono text-[11px] leading-snug text-muted-foreground"
                  >
                    {gpuFailReason}
                  </p>
                )}
              </GpuWarningRow>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  {gpuActivating ? (
                    <>
                      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-primary animate-pulse" />
                      <span className="text-xs font-medium text-foreground">
                        {t("gpu.activatingBackend", { backend: gpuBackendName })}
                      </span>
                    </>
                  ) : gpuActive ? (
                    <>
                      <Check size={13} className="text-success" />
                      <span className="text-xs font-medium text-foreground">
                        {t("gpu.activeBackend", { backend: gpuBackendName })}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-primary" />
                      <span className="text-xs font-medium text-foreground">
                        {t("gpu.readyBackend", { backend: gpuBackendName })}
                      </span>
                    </>
                  )}
                </div>
                <Button
                  onClick={handleGpuDelete}
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                >
                  {t("gpu.remove")}
                </Button>
              </div>
            )
          ) : gpuNeedsUpdate ? (
            <GpuWarningRow
              title={t("gpu.redownloadNeeded")}
              description={t("gpu.redownloadNeededDescription")}
              actionLabel={t("gpu.redownloadButton")}
              onAction={handleGpuDownload}
              onRemove={handleGpuDelete}
            />
          ) : (
            <div className="flex items-start gap-2.5">
              <Zap size={13} className="text-primary shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground">
                  {t("gpu.transcriptionBanner")}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                  {t(gpuBackend === "cuda" ? "gpu.cudaDescription" : "gpu.vulkanDescription")}
                </p>
                <div className="flex items-center gap-2 mt-1.5">
                  <Button
                    onClick={handleGpuDownload}
                    size="sm"
                    variant="default"
                    className="h-6 px-2.5 text-xs"
                  >
                    {t("gpu.enableBackend", { backend: gpuBackendName })}
                  </Button>
                  <button
                    onClick={() => setGpuDismissed(true)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t("gpu.dismiss")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {!gpuDownloaded && gpuDownloadError !== null && (
            <p className="mt-2 text-xs leading-snug text-destructive">
              {t("gpu.downloadFailed")}
              {gpuDownloadError && ` ${gpuDownloadError}`}
            </p>
          )}
        </div>
      )}
    </>
  );
}
