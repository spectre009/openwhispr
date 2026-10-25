import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  ChevronRight,
  KeyRound,
  Link,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Wrench,
  Zap,
} from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import ApiKeyInput from "../ui/ApiKeyInput";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import {
  cancelPendingSecretSave,
  flushPendingSecretSave,
  setStringSetting,
  useSettingsStore,
  type SettingsState,
} from "../../stores/settingsStore";
import type { PolicyDecisionSnapshot } from "../../stores/policyRules";
import {
  CUSTOM_CONNECTION_SLOTS,
  canonicalEndpoint,
  classifyDeployment,
  featuresUsingConnection,
  mergeConnectionModels,
  rewrittenEndpointUrl,
  validateEndpoint,
  type ConnectionUse,
  type CustomConnection,
  type CustomConnectionSlot,
  type ValidatedEndpoint,
} from "../../config/customConnection";
import { maskApiKey } from "../../utils/maskApiKey";
import type { CustomConnectionCheckResult } from "../../types/electron";
import { useOpenSettingsLink } from "./settingsLink";
import { ConnectionRow } from "./ConnectionRow";
import {
  USAGE_FEATURE_TITLE_KEYS,
  isActiveUsage,
  isCustomConnectionAllowed,
  type FeatureUsage,
  type UsageFeature,
} from "./connectionUsage";

/**
 * The custom connection on Settings › AI Connections (config/customConnection.js):
 * one Azure OpenAI or OpenAI-compatible endpoint with one key, shown as a card
 * while in use (or on a first run), a row while saved but unused, and as "Add
 * custom connection" while there is none. "Used by" is derived from the
 * features' own URL fields; main copies the key into the slots those features
 * read and compares them (booleans only). The key shows masked, and only a
 * field the user types into ever holds one.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

type DialogMode =
  | { kind: "add" }
  | { kind: "saveAs"; feature: UsageFeature; slot: CustomConnectionSlot; endpoint: string }
  | { kind: "edit"; focus: "name" | "endpoint" };

const featureName = (t: Translate, feature: UsageFeature) => t(USAGE_FEATURE_TITLE_KEYS[feature]);

const slotStoreKey = (slot: CustomConnectionSlot) =>
  CUSTOM_CONNECTION_SLOTS[slot] as keyof SettingsState;

const uniqueSlots = (uses: readonly ConnectionUse[]) => [...new Set(uses.map((use) => use.slot))];

/** Main is about to write these slots: a pending save from this window must not land after it. */
function cancelPendingSaves(slots: readonly CustomConnectionSlot[]) {
  for (const slot of slots) cancelPendingSecretSave(slotStoreKey(slot));
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** A starting name: the Azure resource's name, else the host. */
function suggestedName(validated: ValidatedEndpoint): string {
  if (!validated.ok) return "";
  const host = new URL(validated.origin).hostname;
  return validated.kind === "azure" ? host.split(".")[0] : host;
}

const found = (result: CustomConnectionCheckResult | null) =>
  (result?.deployments ?? []).map((deployment) => ({
    name: deployment.id,
    capability: classifyDeployment(deployment.model || deployment.id),
  }));

/** Whether each slot holds the connection's key, asked again whenever one of them changes. */
function useKeyMatches(slots: readonly CustomConnectionSlot[]) {
  const slotsKey = slots.join(",");
  const watched = useSettingsStore(
    useShallow((s) => [s.customConnectionApiKey, ...slots.map((slot) => s[slotStoreKey(slot)])])
  );
  const [matches, setMatches] = useState<Partial<Record<CustomConnectionSlot, boolean>>>({});
  useEffect(() => {
    const list = slotsKey ? (slotsKey.split(",") as CustomConnectionSlot[]) : [];
    if (list.length === 0) {
      setMatches({});
      return;
    }
    let cancelled = false;
    void (async () => {
      // Main compares what it holds: a key just typed in a feature's own field goes first.
      await Promise.all(list.map((slot) => flushPendingSecretSave(slotStoreKey(slot))));
      const result = await window.electronAPI?.customConnectionCompare?.({ slots: list });
      if (!cancelled) setMatches(result && typeof result === "object" ? result : {});
    })().catch(() => {
      if (!cancelled) setMatches({});
    });
    return () => {
      cancelled = true;
    };
  }, [slotsKey, watched]);
  return matches;
}

// ── Small parts ──────────────────────────────────────────────────────────────

function KindBadge({
  kind,
  detected = false,
}: {
  kind: ValidatedEndpoint["kind"];
  detected?: boolean;
}) {
  const { t } = useTranslation();
  const azure = kind === "azure";
  return (
    <span
      data-custom-connection-kind={kind}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] leading-4",
        azure
          ? "border-primary/25 bg-primary/8 text-primary dark:bg-primary/12"
          : "border-border/70 bg-muted/40 text-muted-foreground dark:border-white/10"
      )}
    >
      {azure && detected
        ? t("connections.custom.dialog.azureDetected")
        : t(azure ? "connections.custom.kinds.azure" : "connections.custom.kinds.openaiCompatible")}
    </span>
  );
}

function CheckResult({
  result,
  name,
  kind,
  failing,
}: {
  result: CustomConnectionCheckResult;
  name: string;
  kind: ValidatedEndpoint["kind"];
  /** Features that fail while the key is rejected. */
  failing?: string;
}) {
  const { t } = useTranslation();
  let tone: "ok" | "info" | "bad" = "bad";
  let body: ReactNode;
  if (result.status === "ok") {
    const listed = result.discovery === "listed";
    tone = kind === "azure" && !listed ? "info" : "ok";
    if (kind !== "azure") body = t("connections.custom.check.ok", { name });
    else if (!listed) body = t("connections.custom.check.unlisted", { name });
    else {
      const deployments = (result.deployments ?? []).map((deployment) => deployment.id);
      body = (
        <>
          {t("connections.custom.check.listed", { name })}{" "}
          {deployments.length > 0 && (
            <>
              <BidiInterpolatedText
                text={t("connections.custom.check.deployments", {
                  deployments: BIDI_VALUE_TOKEN,
                })}
                value={<span className="font-mono">{deployments.join(", ")}</span>}
              />{" "}
            </>
          )}
          {t("connections.custom.check.azureRoutes")}
        </>
      );
    }
  } else if (result.status === "auth") {
    body = (
      <>
        {t("connections.custom.check.auth", { status: result.httpStatus ?? 401 })}
        {failing && <> {t("connections.custom.check.authFeatures", { features: failing })}</>}
      </>
    );
  } else if (result.status === "network") {
    body = result.httpStatus
      ? t("connections.custom.check.status", { name, status: result.httpStatus })
      : t("connections.custom.check.network", { name });
  } else if (result.status === "blocked") {
    body = t("connections.custom.check.blocked");
  } else {
    body = t("connections.custom.check.invalid");
  }
  return (
    <div
      data-check-status={result.status}
      data-check-discovery={result.discovery}
      role="status"
      className={cn(
        "rounded-md border px-3 py-2 text-xs leading-relaxed text-foreground/90",
        tone === "ok" && "border-success/30 bg-success/10",
        tone === "info" && "border-warning/30 bg-warning/10",
        tone === "bad" && "border-destructive/30 bg-destructive/10"
      )}
    >
      {body}
    </div>
  );
}

function UseChip({
  use,
  mismatch,
  onUpdate,
}: {
  use: ConnectionUse;
  mismatch: boolean;
  onUpdate: () => void;
}) {
  const { t } = useTranslation();
  const openSettings = useOpenSettingsLink();
  const title = featureName(t, use.feature);
  const off = !isActiveUsage(use.usage);
  return (
    <span
      data-connection-use={use.feature}
      data-key-mismatch={mismatch ? "" : undefined}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4",
        off
          ? "border-dashed border-border/60 text-muted-foreground/70"
          : "border-border/70 bg-muted/40 text-foreground/85 dark:border-white/10 dark:bg-surface-1",
        mismatch && "border-warning/50"
      )}
    >
      <button
        type="button"
        disabled={!openSettings}
        onClick={() => openSettings?.(use.usage.edit)}
        title={t("connections.endpoints.editIn", { feature: title })}
        className="inline-flex min-w-0 items-center gap-1 hover:text-foreground"
      >
        <span className="truncate">{title}</span>
        {use.model && (
          <span className="truncate text-muted-foreground">
            · <bdi dir="ltr">{use.model}</bdi>
          </span>
        )}
        {off && (
          <span className="truncate text-muted-foreground/80">
            · {t(`connections.usedBy.off.${use.usage.offReason ?? "disabled"}`)}
          </span>
        )}
      </button>
      {mismatch && (
        <>
          <span className="text-warning">· {t("connections.custom.differentKey")}</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            data-key-update={use.slot}
            onClick={onUpdate}
            className="text-link underline decoration-link/30 hover:decoration-link/60"
          >
            {t("connections.custom.actions.update")}
          </button>
        </>
      )}
    </span>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-3">
      <span className="pt-0.5 text-xs text-muted-foreground/80">{label}</span>
      <div className="min-w-0 text-xs">{children}</div>
    </div>
  );
}

// ── The panel: a card's content, and a row's body ────────────────────────────

/**
 * The connection's controls and details: on its card under the name, kind and
 * host (`header="full"`), or opened under its row, whose line already shows
 * those (`header="actions"`: Check connection and the ⋯ menu only).
 */
function ConnectionPanel({
  connection,
  uses,
  usages,
  allowed,
  header,
}: {
  connection: CustomConnection;
  uses: readonly ConnectionUse[];
  usages: readonly FeatureUsage[];
  allowed: boolean;
  header: "full" | "actions";
}) {
  const { t } = useTranslation();
  const openSettings = useOpenSettingsLink();
  const key = useSettingsStore((s) => s.customConnectionApiKey);
  const updateCustomConnection = useSettingsStore((s) => s.updateCustomConnection);
  const removeCustomConnection = useSettingsStore((s) => s.removeCustomConnection);
  const validated = validateEndpoint(connection.endpoint);
  const matches = useKeyMatches(uniqueSlots(uses));
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CustomConnectionCheckResult | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [removeState, setRemoveState] = useState<"inUse" | "confirm" | null>(null);
  const [editing, setEditing] = useState<"name" | "endpoint" | null>(null);
  const [error, setError] = useState("");
  const active = uses.filter((use) => isActiveUsage(use.usage));
  const models = mergeConnectionModels(
    connection.models,
    uses.map((use) => ({ name: use.model, capability: use.capability }))
  );

  const check = async () => {
    setChecking(true);
    setResult(null);
    setError("");
    try {
      const next = await window.electronAPI?.customConnectionCheck?.({
        endpoint: connection.endpoint,
      });
      setResult(next ?? null);
      if (next?.status === "ok" && next.deployments?.length) {
        updateCustomConnection({ models: mergeConnectionModels(connection.models, found(next)) });
      }
    } catch {
      setError(t("connections.custom.actionFailed"));
    } finally {
      setChecking(false);
    }
  };

  const update = async (slot: CustomConnectionSlot) => {
    setError("");
    try {
      cancelPendingSaves([slot]);
      await window.electronAPI?.customConnectionApplyKey?.({ slots: [slot] });
    } catch {
      setError(t("connections.custom.actionFailed"));
    }
  };

  // The key goes first: a setting left behind can still be removed again.
  const remove = async () => {
    setError("");
    try {
      await window.electronAPI?.customConnectionDeleteKey?.();
      removeCustomConnection();
    } catch {
      setError(t("connections.custom.actionFailed"));
    }
  };

  const actions = (
    <>
      {allowed && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={checking || !validated.ok}
          onClick={() => void check()}
          data-custom-connection-check=""
        >
          <Zap className="h-3 w-3" />
          {t(checking ? "connections.custom.actions.checking" : "connections.custom.actions.check")}
        </Button>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          className="shrink-0 rounded-md p-1 text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/30"
          aria-label={t("connections.custom.actions.more", { name: connection.name })}
          data-custom-connection-menu=""
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-xs">
          {allowed && (
            <>
              <DropdownMenuItem onSelect={() => setEditing("name")}>
                <Pencil className="me-1.5 h-3.5 w-3.5" />
                {t("connections.custom.actions.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing("endpoint")}>
                <Wrench className="me-1.5 h-3.5 w-3.5" />
                {t("connections.custom.actions.editEndpoint")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setReplaceOpen(true)}>
                <KeyRound className="me-1.5 h-3.5 w-3.5" />
                {t("connections.custom.actions.replaceKey")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            className="text-destructive"
            data-custom-connection-remove=""
            onSelect={() => setRemoveState(active.length > 0 ? "inUse" : "confirm")}
          >
            <Trash2 className="me-1.5 h-3.5 w-3.5" />
            {t("connections.custom.actions.remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <div data-custom-connection="" className="flex min-w-0 flex-col gap-3">
      {header === "full" ? (
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-primary dark:border-white/10 dark:bg-surface-1">
            <Link className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="min-w-0 truncate text-sm font-medium text-foreground" dir="auto">
                {connection.name}
              </p>
              <KindBadge kind={validated.kind} />
              {!allowed && <ManagedBadge />}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <bdi dir="ltr" className="font-mono">
                {endpointHost(connection.endpoint)}
              </bdi>
            </p>
          </div>
          {actions}
        </div>
      ) : (
        <div className="flex min-w-0 items-center justify-end gap-2.5">{actions}</div>
      )}

      <div className="space-y-2">
        <MetaRow label={t("connections.custom.fields.key")}>
          <div className="flex flex-wrap items-center gap-2">
            {key ? (
              <span
                data-custom-connection-key=""
                className="inline-flex items-center gap-1.5 rounded border border-border/60 bg-background px-2 py-0.5 dark:border-white/10 dark:bg-surface-1"
              >
                <KeyRound className="h-3 w-3 text-muted-foreground/70" />
                <span dir="ltr" className="font-mono text-foreground/80">
                  {maskApiKey(key)}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">{t("connections.status.noKey")}</span>
            )}
            {allowed && (
              <button
                type="button"
                data-custom-connection-replace=""
                onClick={() => setReplaceOpen(true)}
                className="text-link underline decoration-link/30 hover:decoration-link/60"
              >
                {t(
                  key ? "connections.custom.actions.replace" : "connections.custom.actions.addKey"
                )}
              </button>
            )}
          </div>
        </MetaRow>
        <MetaRow label={t("connections.usedBy.label")}>
          {uses.length === 0 ? (
            <span className="text-muted-foreground/70">{t("connections.usedBy.none")}</span>
          ) : (
            <div className="flex flex-wrap gap-1.5" data-connection-used-by="">
              {uses.map((use) => (
                <UseChip
                  key={use.feature}
                  use={use}
                  mismatch={!!key && matches[use.slot] === false}
                  onUpdate={() => void update(use.slot)}
                />
              ))}
            </div>
          )}
        </MetaRow>
        <MetaRow label={t("connections.custom.fields.models")}>
          <p className="text-muted-foreground" data-custom-connection-models="">
            {models.speech.length === 0 && models.language.length === 0 ? (
              t("connections.custom.models.none")
            ) : (
              <>
                {models.speech.length > 0 && (
                  <>
                    {t("connections.custom.models.speech")}{" "}
                    <bdi dir="ltr" className="font-mono">
                      {models.speech.join(", ")}
                    </bdi>
                  </>
                )}
                {models.speech.length > 0 && models.language.length > 0 && " · "}
                {models.language.length > 0 && (
                  <>
                    {t("connections.custom.models.language")}{" "}
                    <bdi dir="ltr" className="font-mono">
                      {models.language.join(", ")}
                    </bdi>
                  </>
                )}
              </>
            )}
          </p>
        </MetaRow>
      </div>

      {!validated.ok && validated.error && (
        <p className="text-xs text-destructive">
          {t(`connections.custom.errors.${validated.error}`)}
        </p>
      )}
      {result && (
        <CheckResult
          result={result}
          name={connection.name}
          kind={validated.kind}
          failing={active.map((use) => featureName(t, use.feature)).join(", ")}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {replaceOpen && (
        <ReplaceKeyDialog
          connection={connection}
          uses={uses}
          onClose={() => setReplaceOpen(false)}
        />
      )}
      {removeState === "inUse" && (
        <Dialog open onOpenChange={(open) => !open && setRemoveState(null)}>
          <DialogContent className="sm:max-w-[460px]" data-custom-connection-in-use="">
            <DialogHeader>
              <DialogTitle>
                {t("connections.custom.remove.inUseTitle", { name: connection.name })}
              </DialogTitle>
              <DialogDescription>
                {t("connections.custom.remove.inUseDescription")}
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-1.5">
              {active.map((use) => (
                <li key={use.feature}>
                  <button
                    type="button"
                    data-in-use-feature={use.feature}
                    disabled={!openSettings}
                    onClick={() => {
                      setRemoveState(null);
                      openSettings?.(use.usage.edit);
                    }}
                    className="inline-flex items-center gap-1 text-sm text-link underline decoration-link/30 hover:decoration-link/60"
                  >
                    {featureName(t, use.feature)}
                    {use.model && (
                      <>
                        {" · "}
                        <bdi dir="ltr">{use.model}</bdi>
                      </>
                    )}
                    <ChevronRight aria-hidden="true" className="h-3 w-3 rtl:rotate-180" />
                  </button>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button type="button" onClick={() => setRemoveState(null)}>
                {t("common.close")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <ConfirmDialog
        open={removeState === "confirm"}
        onOpenChange={(open) => !open && setRemoveState(null)}
        title={t("connections.custom.remove.title", { name: connection.name })}
        description={t("connections.custom.remove.description")}
        variant="destructive"
        confirmText={t("connections.actions.remove")}
        cancelText={t("common.cancel")}
        onConfirm={() => void remove()}
      />
      {editing && (
        <ConnectionDialog
          mode={{ kind: "edit", focus: editing }}
          connection={connection}
          usages={usages}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ManagedBadge() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-[11px] leading-4 text-primary">
      {t("common.managedByOrg")}
    </span>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

function ReplaceKeyDialog({
  connection,
  uses,
  onClose,
}: {
  connection: CustomConnection;
  uses: readonly ConnectionUse[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const features = [...new Set(uses.map((use) => use.feature))];

  const replace = async () => {
    const next = key.trim();
    if (!next) return;
    setSaving(true);
    setError("");
    try {
      const slots = uniqueSlots(uses);
      cancelPendingSaves(slots);
      await window.electronAPI?.customConnectionSaveKey?.({ key: next, applyTo: slots });
      onClose();
    } catch {
      setError(t("connections.custom.actionFailed"));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]" data-custom-connection-replace-dialog="">
        <DialogHeader>
          <DialogTitle>
            {t("connections.custom.replace.title", { name: connection.name })}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">
              {t("connections.custom.replace.label")}
            </span>
            <Input
              type="password"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder={t("connections.custom.replace.placeholder")}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void replace();
              }}
              className="h-9 font-mono text-sm"
            />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {features.length > 0
              ? t("connections.custom.replace.features", { name: connection.name })
              : t("connections.custom.replace.noFeatures", { name: connection.name })}
          </p>
          {features.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-replace-features="">
              {features.map((feature) => (
                <span
                  key={feature}
                  data-replace-feature={feature}
                  className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] text-foreground/85 dark:border-white/10 dark:bg-surface-1"
                >
                  {featureName(t, feature)}
                </span>
              ))}
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!key.trim() || saving}
            onClick={() => void replace()}
            data-replace-confirm=""
          >
            {t("connections.custom.replace.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EndpointPreview({ raw, validated }: { raw: string; validated: ValidatedEndpoint }) {
  const { t } = useTranslation();
  if (!raw.trim()) return null;
  if (!validated.ok) {
    return (
      <p className="text-xs text-destructive" data-endpoint-error={validated.error}>
        {t(`connections.custom.errors.${validated.error}`)}
      </p>
    );
  }
  const speech =
    validated.kind === "azure"
      ? `${validated.origin}/openai/deployments/<deployment>/audio/transcriptions`
      : `${validated.speechBase}/audio/transcriptions`;
  const route = (label: string, url: string) => (
    <p className="flex min-w-0 flex-wrap items-center gap-1">
      <span>{label}</span>
      <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 rtl:rotate-180" />
      <bdi dir="ltr" className="min-w-0 break-all font-mono">
        {url}
      </bdi>
    </p>
  );
  return (
    <div
      data-endpoint-preview={validated.kind}
      className="space-y-1 rounded-md border border-border/60 bg-background px-3 py-2 text-xs leading-relaxed text-muted-foreground dark:border-white/10 dark:bg-surface-1"
    >
      <KindBadge kind={validated.kind} detected />
      {route(t("connections.custom.dialog.languageModels"), validated.languageBase)}
      {route(t("connections.custom.dialog.speechToText"), speech)}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-foreground">{label}</p>
      {children}
    </div>
  );
}

function ConnectionDialog({
  mode,
  connection,
  usages,
  onClose,
}: {
  mode: DialogMode;
  connection: CustomConnection | null;
  usages: readonly FeatureUsage[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const setCustomConnection = useSettingsStore((s) => s.setCustomConnection);
  const updateCustomConnection = useSettingsStore((s) => s.updateCustomConnection);
  const sourceKey = useSettingsStore((s) =>
    mode.kind === "saveAs" ? String(s[slotStoreKey(mode.slot)] ?? "") : ""
  );
  const editing = mode.kind === "edit" && !!connection;
  const [name, setName] = useState(() =>
    mode.kind === "edit"
      ? (connection?.name ?? "")
      : mode.kind === "saveAs"
        ? suggestedName(validateEndpoint(mode.endpoint))
        : ""
  );
  const [endpoint, setEndpoint] = useState(() =>
    mode.kind === "edit"
      ? (connection?.endpoint ?? "")
      : mode.kind === "saveAs"
        ? mode.endpoint
        : ""
  );
  const [newKey, setNewKey] = useState("");
  const [useSource, setUseSource] = useState(mode.kind === "saveAs");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CustomConnectionCheckResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const validated = validateEndpoint(endpoint);
  const keyFromSource = mode.kind === "saveAs" && useSource && !!sourceKey.trim();
  const sourceFeature = mode.kind === "saveAs" ? featureName(t, mode.feature) : "";

  const runCheck = async () => {
    if (!validated.ok) return;
    setChecking(true);
    setResult(null);
    setError("");
    try {
      const args: { endpoint: string; key?: string; fromSlot?: CustomConnectionSlot } = {
        endpoint: canonicalEndpoint(validated),
      };
      if (keyFromSource && mode.kind === "saveAs") {
        await flushPendingSecretSave(slotStoreKey(mode.slot));
        args.fromSlot = mode.slot;
      } else if (newKey.trim()) {
        args.key = newKey.trim();
      }
      setResult((await window.electronAPI?.customConnectionCheck?.(args)) ?? null);
    } catch {
      setError(t("connections.custom.actionFailed"));
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (!validated.ok || !name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const nextEndpoint = canonicalEndpoint(validated);
      const settings = useSettingsStore.getState();
      if (editing && connection) {
        if (nextEndpoint !== connection.endpoint) {
          // Every feature on the connection moves with it; its models and keys stay.
          const fields = new Map<string, string>();
          for (const use of featuresUsingConnection(usages, connection, settings)) {
            const current = String(settings[use.urlField as keyof SettingsState] ?? "");
            fields.set(use.urlField, rewrittenEndpointUrl(current, use.capability, validated));
          }
          for (const [field, value] of fields) {
            setStringSetting(field as keyof SettingsState, value);
          }
        }
        updateCustomConnection({
          name: name.trim(),
          endpoint: nextEndpoint,
          models: mergeConnectionModels(connection.models, found(result)),
        });
      } else {
        // The key first: a connection is never saved pointing at a key that isn't there.
        if (keyFromSource && mode.kind === "saveAs") {
          await flushPendingSecretSave(slotStoreKey(mode.slot));
          await window.electronAPI?.customConnectionCopyKey?.({ fromSlot: mode.slot });
        } else if (newKey.trim()) {
          await window.electronAPI?.customConnectionSaveKey?.({ key: newKey.trim(), applyTo: [] });
        }
        const draft = {
          name: name.trim(),
          endpoint: nextEndpoint,
          models: { language: [], speech: [] },
        };
        const used = featuresUsingConnection(usages, draft, settings).map((use) => ({
          name: use.model,
          capability: use.capability,
        }));
        setCustomConnection({
          ...draft,
          models: mergeConnectionModels(draft.models, [...used, ...found(result)]),
        });
      }
      onClose();
    } catch {
      setError(t("connections.custom.dialog.saveFailed"));
      setSaving(false);
    }
  };

  const title =
    mode.kind === "edit"
      ? t("connections.custom.dialog.editTitle", { name: connection?.name ?? "" })
      : t(
          mode.kind === "saveAs"
            ? "connections.custom.dialog.saveAsTitle"
            : "connections.custom.dialog.addTitle"
        );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[560px]" data-custom-connection-dialog={mode.kind}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {mode.kind === "saveAs" && (
            <DialogDescription>
              {t("connections.custom.dialog.saveAsFrom", { feature: sourceFeature })}
            </DialogDescription>
          )}
          {editing && (
            <DialogDescription>
              {t("connections.custom.dialog.editNote", { name: connection?.name ?? "" })}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-4">
          <Field label={t("connections.custom.fields.name")}>
            <Input
              value={name}
              dir="auto"
              autoFocus={mode.kind !== "edit" || mode.focus === "name"}
              onChange={(event) => setName(event.target.value)}
              aria-label={t("connections.custom.fields.name")}
              className="h-9"
            />
          </Field>
          <Field label={t("connections.custom.fields.endpoint")}>
            <Input
              value={endpoint}
              dir="ltr"
              autoFocus={mode.kind === "edit" && mode.focus === "endpoint"}
              spellCheck={false}
              autoComplete="off"
              placeholder="https://<resource>.openai.azure.com/"
              onChange={(event) => {
                setEndpoint(event.target.value);
                setResult(null);
              }}
              aria-label={t("connections.custom.fields.endpoint")}
              aria-invalid={!!endpoint.trim() && !validated.ok}
              className="h-9 font-mono text-sm"
            />
            <EndpointPreview raw={endpoint} validated={validated} />
            <p className="text-xs leading-relaxed text-muted-foreground/80">
              {t("connections.custom.dialog.endpointHelp")}
            </p>
          </Field>
          {mode.kind !== "edit" && (
            <Field label={t("connections.custom.fields.apiKey")}>
              {keyFromSource ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span
                    data-source-key=""
                    className="inline-flex items-center gap-1.5 rounded border border-border/60 bg-background px-2 py-0.5 dark:border-white/10 dark:bg-surface-1"
                  >
                    <KeyRound className="h-3 w-3 text-muted-foreground/70" />
                    <span dir="ltr" className="font-mono text-foreground/80">
                      {maskApiKey(sourceKey)}
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    {t("connections.custom.dialog.sourceKey", { feature: sourceFeature })}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setUseSource(false);
                      setResult(null);
                    }}
                    className="ms-auto text-link underline decoration-link/30 hover:decoration-link/60"
                  >
                    {t("connections.custom.dialog.useDifferentKey")}
                  </button>
                </div>
              ) : (
                <ApiKeyInput
                  apiKey={newKey}
                  setApiKey={(value) => {
                    setNewKey(value);
                    setResult(null);
                  }}
                  label=""
                  helpText=""
                  ariaLabel={t("connections.custom.fields.apiKey")}
                  replace
                />
              )}
              <p className="text-xs leading-relaxed text-muted-foreground/80">
                {keyFromSource
                  ? t("connections.custom.dialog.sourceKeyHelp", { feature: sourceFeature })
                  : t("connections.custom.dialog.keyHelp")}
              </p>
            </Field>
          )}
          {result && <CheckResult result={result} name={name.trim()} kind={validated.kind} />}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!validated.ok || checking}
            onClick={() => void runCheck()}
            data-dialog-check=""
          >
            <Zap className="h-3.5 w-3.5" />
            {t(
              checking ? "connections.custom.actions.checking" : "connections.custom.actions.check"
            )}
          </Button>
          <Button
            type="button"
            disabled={!validated.ok || !name.trim() || saving}
            onClick={() => void save()}
            data-dialog-save=""
          >
            {t("connections.custom.dialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Exports ──────────────────────────────────────────────────────────────────

interface CustomConnectionProps {
  connection: CustomConnection;
  uses: readonly ConnectionUse[];
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
}

/** The connection's card (In use, or a first run's), under Connections. */
export function CustomConnectionCard({ connection, uses, usages, policy }: CustomConnectionProps) {
  return (
    <div
      data-setting-id="connections.custom"
      data-connection-card=""
      className="min-w-0 rounded-lg border border-border/70 bg-card/50 p-3.5 dark:border-border-subtle/70 dark:bg-surface-2/50"
    >
      <ConnectionPanel
        connection={connection}
        uses={uses}
        usages={usages}
        allowed={isCustomConnectionAllowed(policy)}
        header="full"
      />
    </div>
  );
}

/**
 * The connection on one line (Saved, not in use): name, kind and host, and
 * "Manage", which opens the card's content under it. Its uses (all off) show
 * as dimmed chips while it's closed; open, the content lists them.
 */
export function CustomConnectionRow({ connection, uses, usages, policy }: CustomConnectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const allowed = isCustomConnectionAllowed(policy);
  return (
    <ConnectionRow
      data-setting-id="connections.custom"
      icon={<Link className="h-4 w-4 text-primary" />}
      name={connection.name}
      nameDir="auto"
      toggleLabel={t("connections.rows.manage")}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      body={
        <ConnectionPanel
          connection={connection}
          uses={uses}
          usages={usages}
          allowed={allowed}
          header="actions"
        />
      }
      below={
        !open && uses.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs" data-connection-used-by="">
            <span className="text-muted-foreground">{t("connections.usedBy.label")}</span>
            {uses.map((use) => (
              <UseChip key={use.feature} use={use} mismatch={false} onUpdate={() => {}} />
            ))}
          </div>
        ) : undefined
      }
    >
      <KindBadge kind={validateEndpoint(connection.endpoint).kind} />
      {!allowed && <ManagedBadge />}
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        <bdi dir="ltr" className="font-mono">
          {endpointHost(connection.endpoint)}
        </bdi>
      </span>
    </ConnectionRow>
  );
}

/**
 * "Add custom connection" while there is none, or, where policy allows no
 * custom endpoint, a note saying so (either way the `connections.custom` anchor).
 */
export function AddCustomConnection({
  usages,
  policy,
}: {
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);

  if (!isCustomConnectionAllowed(policy)) {
    return (
      <div data-setting-id="connections.custom">
        <p className="text-xs text-muted-foreground" data-custom-connection-managed="">
          {t("connections.custom.managed")}
        </p>
      </div>
    );
  }
  return (
    <div data-setting-id="connections.custom">
      <button
        type="button"
        data-custom-connection-add=""
        onClick={() => setAdding(true)}
        className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-lg border border-dashed border-border/70 px-3.5 py-3 text-start text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground dark:border-white/15"
      >
        <Plus className="h-4 w-4 shrink-0" />
        <span className="font-medium">{t("connections.custom.add")}</span>
        <span className="min-w-0 text-muted-foreground/80">{t("connections.custom.addHint")}</span>
      </button>
      {adding && (
        <ConnectionDialog
          mode={{ kind: "add" }}
          connection={null}
          usages={usages}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/**
 * "Save as connection" on a custom endpoint row (Self-hosted & custom
 * endpoints): the connection starts from that feature's endpoint and key. A row
 * whose endpoint the connection can't take says why instead.
 */
export function SaveAsConnection({
  usage,
  usages,
}: {
  usage: FeatureUsage;
  usages: readonly FeatureUsage[];
}) {
  const { t } = useTranslation();
  const source = usage.customEndpoint;
  const url = useSettingsStore((s) => (source ? String(s[source.urlField] ?? "") : ""));
  const [open, setOpen] = useState(false);
  if (!source || !url.trim()) return null;
  const validated = validateEndpoint(url);
  if (!validated.ok) {
    return (
      <p className="text-xs text-muted-foreground/80" data-save-as-refused={validated.error}>
        {t("connections.custom.saveAsRefused")} {t(`connections.custom.errors.${validated.error}`)}
      </p>
    );
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs"
        data-save-as-connection={usage.feature}
        onClick={() => setOpen(true)}
      >
        {t("connections.custom.actions.saveAs")}
      </Button>
      {open && (
        <ConnectionDialog
          mode={{
            kind: "saveAs",
            feature: usage.feature,
            slot: source.slot,
            endpoint: canonicalEndpoint(validated),
          }}
          connection={null}
          usages={usages}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
