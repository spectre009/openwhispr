import { useTranslation } from "react-i18next";
import { AlertTriangle, ShieldCheck } from "../icons";
import { Button } from "../ui/button";
import { useSettingsStore } from "../../stores/settingsStore";
import { enterpriseProviderName } from "../../models/ModelRegistry";
import type { ManagedEnterpriseScopeResolution } from "../../types/enterpriseIdentity";

/**
 * What Live Recording and File Transcription show instead of their picker
 * while the managed setup answers them: the deployment (provider · model) with
 * "Use personal setup" unless the organization requires it, or why the managed
 * setup can't run. Nothing while the setup is personal.
 */
export function ManagedTranscriptionCard({
  managed,
}: {
  managed: ManagedEnterpriseScopeResolution;
}) {
  const { t } = useTranslation();
  const setSetupMode = useSettingsStore((s) => s.setEnterpriseTranscriptionSetupMode);

  if (managed.kind === "error") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3" role="alert">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="text-sm font-medium">
              {t("settingsPage.aiModels.managedEnterprise.errorTitle")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {managed.messageKey ? t(managed.messageKey) : managed.message}
            </p>
          </div>
        </div>
      </div>
    );
  }
  if (managed.kind !== "managed") return null;

  const required = managed.mode === "managed_required" || !managed.allowManualSetup;
  return (
    <div
      data-managed-transcription=""
      className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.03] p-3"
    >
      <div className="flex items-start gap-2.5">
        <div className="rounded-md bg-primary/10 p-1.5 text-primary">
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {t("settingsPage.aiModels.managedEnterprise.title")}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {enterpriseProviderName(managed.provider)} ·{" "}
            <span dir="ltr" className="font-mono">
              {managed.model}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("settingsPage.aiModels.managedEnterprise.description")}
          </p>
        </div>
      </div>
      {!required && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => setSetupMode("manual")}>
            {t("settingsPage.aiModels.managedEnterprise.usePersonalSetup")}
          </Button>
        </div>
      )}
    </div>
  );
}
