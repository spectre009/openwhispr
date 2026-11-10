import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Check, Copy } from "../icons";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import type {
  BuildInfoResult,
  LogInfoResult,
  LogProblem,
  ProcessInventoryReport,
} from "../../types/electron";
import { diagnosticsText } from "./logSettingsFormat";

interface CopyDiagnosticsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  info: LogInfoResult | null;
  problems: readonly LogProblem[] | null;
}

/**
 * Copy diagnostics: shows exactly the text that will be copied (build, OS, the
 * graphics mode, log settings, the masked folder, sizes, problem counts by
 * area and the processes' latest numbers), then copies it.
 */
export default function CopyDiagnosticsDialog({
  open,
  onOpenChange,
  info,
  problems,
}: CopyDiagnosticsDialogProps) {
  const { t } = useTranslation();
  const [build, setBuild] = useState<BuildInfoResult | null>(null);
  // undefined until main answers (and when it can't): the section is left out.
  const [processes, setProcesses] = useState<ProcessInventoryReport | null | undefined>(undefined);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    Promise.resolve(window.electronAPI?.getBuildInfo?.())
      .then((next) => {
        if (!cancelled && next && typeof next === "object") setBuild(next);
      })
      .catch(() => {});
    // The latest sample only: opening the dialog never starts a run.
    Promise.resolve(window.electronAPI?.getProcessInventory?.({ history: false }))
      .then((next) => {
        if (!cancelled && next && typeof next === "object") setProcesses(next.report ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  const text = info
    ? diagnosticsText({ build, log: info, problems: problems ?? [], processes })
    : "";
  const { copied, copy } = useCopyFeedback(text);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settingsPage.diagnostics.copy.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("settingsPage.diagnostics.copy.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <pre
          dir="ltr"
          data-diagnostics-preview
          className="whitespace-pre-wrap break-all rounded-md border border-border/70 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground dark:bg-surface-raised/30"
        >
          {text || t("common.loading")}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button onClick={copy} disabled={!text}>
            {copied ? (
              <Check className="me-1.5 h-3.5 w-3.5" />
            ) : (
              <Copy className="me-1.5 h-3.5 w-3.5" />
            )}
            {copied ? t("common.copied") : t("common.copy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
