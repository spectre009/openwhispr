import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  ChevronDown,
  Cloud,
  Download,
  Lock,
  Network,
  Search,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import ApiKeyInput from "../ui/ApiKeyInput";
import { GetApiKeyLink } from "../ui/GetApiKeyLink";
import { ProviderIcon } from "../ui/ProviderIcon";
import { ConfirmDialog } from "../ui/dialog";
import { Progress } from "../ui/progress";
import { Toggle } from "../ui/toggle";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { useSettingsLayout } from "../ui/useSettingsLayout";
import { cn } from "../lib/utils";
import { useDialogs } from "../../hooks/useDialogs";
import { LOCAL_MODELS_CHANGED_EVENT, useModelDownload } from "../../hooks/useModelDownload";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { useSettingsStore } from "../../stores/settingsStore";
import { useStyleStore } from "../../stores/styleStore";
import { syncCopilotAuthStatus, useCopilotStore } from "../../stores/copilotStore";
import { useOpenWhisprCloudDisabled } from "../../stores/openWhisprCloudStore";
import {
  getManagedScopeResolution,
  useEnterpriseIdentityStore,
} from "../../stores/enterpriseIdentityStore";
import {
  isModeAllowedByPolicy,
  isProviderAllowedByPolicy,
  type PolicyDecisionSnapshot,
} from "../../stores/policyRules";
import { selectableStyles } from "../../config/styles/library";
import { COPILOT_PROVIDER_ID } from "../../config/copilot";
import {
  PARAKEET_MODEL_INFO,
  WHISPER_MODEL_INFO,
  enterpriseProviderName,
} from "../../models/ModelRegistry";
import {
  getASRModelOrganization,
  LOCAL_ASR_ORGANIZATIONS,
} from "../../helpers/localASROrganization";
import { formatBytes } from "../../utils/formatBytes";
import { maskApiKey } from "../../utils/maskApiKey";
import type {
  LocalLLMModelStatus,
  ParakeetModelResult,
  WhisperModelResult,
} from "../../types/electron";
import type { ManagedEnterpriseScope } from "../../types/enterpriseIdentity";
import {
  featuresUsingConnection,
  type ConnectionUse,
  type CustomConnection,
} from "../../config/customConnection";
import CopilotSignIn from "./CopilotSignIn";
import GpuDeviceSelector from "./GpuDeviceSelector";
import { SettingsLink } from "./ManageKeysLink";
import { useOpenSettingsLink } from "./settingsLink";
import { useSettingsVisible } from "./useSettingsVisible";
import { ConnectionRow, RowStatus } from "./ConnectionRow";
import {
  NO_VISIT,
  stepVisit,
  type ConnectionGroupsInput,
  type ConnectionId,
  type ConnectionsVisit,
} from "./connectionGroups";
import {
  CONNECTION_PROVIDERS,
  findConnectionProvider,
  hasSavedConnection,
  type ConnectionCredential,
  type ConnectionProviderDef,
  type ConnectionProviderId,
} from "./connectionProviders";
import {
  USAGE_FEATURE_TITLE_KEYS,
  computeConnectionUsage,
  endpointUsages,
  enterpriseUsages,
  isActiveUsage,
  isCustomConnectionAllowed,
  usagesOfLocalModel,
  usagesOfProvider,
  type FeatureUsage,
  type LocalModelEngine,
  type UsageFeature,
} from "./connectionUsage";
import {
  AddCustomConnection,
  CustomConnectionCard,
  CustomConnectionRow,
  SaveAsConnection,
} from "./CustomConnectionCard";
import { ConnectionsHealthSummary, ModelMark } from "./ConnectionCheckParts";
import {
  ConnectionHealthContext,
  useHealthNow,
  type ConnectionHealthContextValue,
} from "./connectionCheckContext";
import { useHealthControls } from "./connectionCheckControls";
import {
  CONNECTION_CHECK_MAX_AGE_MS,
  buildCheckPlan,
  connectionsFlag,
  modelMark,
  pickerHealthMap,
  type CheckPlan,
  type OwnerHealth,
} from "./connectionHealth";
import {
  forgetConnectionResults,
  publishConnectionHealth,
  runConnectionChecks,
  subscribeConnectionChecks,
  useConnectionHealthStore,
} from "../../stores/connectionHealthStore";

/**
 * Settings › AI Connections & Local Models: every shared credential and
 * sign-in and the custom connection (CustomConnectionCard.tsx), grouped by
 * whether a feature uses them (connectionGroups.ts), the per-feature custom
 * and self-hosted endpoints, downloaded models, and the enterprise setup, each
 * with where it's used right now (connectionUsage.ts). The language-model
 * pickers on feature pages take no keys and link here instead; speech-to-text
 * pickers keep their key fields, which edit the same store fields through the
 * same setters as this page. Keys only ever show masked, and replacing one
 * never reveals the old one.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

const STT_FEATURES: ReadonlySet<UsageFeature> = new Set([
  "recognition",
  "liveRecording",
  "fileTranscription",
]);

function featureTitle(t: Translate, feature: UsageFeature): string {
  return t(USAGE_FEATURE_TITLE_KEYS[feature]);
}

function featureList(t: Translate, usages: readonly FeatureUsage[]): string {
  return usages.map((usage) => featureTitle(t, usage.feature)).join(", ");
}

/** Whether policy lets the user bring their own key for this provider anywhere. */
function providerAllowed(policy: PolicyDecisionSnapshot, provider: ConnectionProviderDef): boolean {
  return (
    (provider.llm &&
      isModeAllowedByPolicy(policy, "llm", "providers") &&
      isProviderAllowedByPolicy(policy, "llm", provider.id)) ||
    (provider.transcription &&
      isModeAllowedByPolicy(policy, "transcription", "providers") &&
      isProviderAllowedByPolicy(policy, "transcription", provider.id))
  );
}

// ── Small parts ──────────────────────────────────────────────────────────────

type PillTone = "ok" | "muted" | "managed" | "busy";

function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      data-connection-status={tone}
      className={cn(
        "inline-flex max-w-[60%] shrink-0 items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] leading-4",
        tone === "ok" && "border-success/30 bg-success/10 text-success",
        tone === "muted" &&
          "border-border/70 bg-muted/40 text-muted-foreground dark:border-white/10",
        tone === "managed" && "border-primary/25 bg-primary/8 text-primary dark:bg-primary/12",
        tone === "busy" && "border-warning/30 bg-warning/10 text-warning"
      )}
    >
      {tone === "managed" && <Lock aria-hidden="true" className="h-3 w-3 shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

function usageNote(t: Translate, usage: FeatureUsage): string {
  if (usage.kind === "off") return t(`connections.usedBy.off.${usage.offReason ?? "disabled"}`);
  if (usage.kind === "inherited" && usage.from) {
    return t("connections.usedBy.inherits", { feature: featureTitle(t, usage.from) });
  }
  if (usage.kind === "fallback" && usage.from) {
    return t("connections.usedBy.fallback", { feature: featureTitle(t, usage.from) });
  }
  return "";
}

/** A feature using a connection; opens where that feature picks its model. */
function UsageChip({
  usage,
  mark = null,
}: {
  usage: FeatureUsage;
  mark?: "offered" | "missing" | null;
}) {
  const { t } = useTranslation();
  const openSettings = useOpenSettingsLink();
  const title = featureTitle(t, usage.feature);
  const note = usageNote(t, usage);
  const className = cn(
    "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4",
    usage.kind === "off"
      ? "border-dashed border-border/60 text-muted-foreground/70"
      : "border-border/70 bg-muted/40 text-foreground/85 dark:border-white/10 dark:bg-surface-1",
    mark === "missing" && "border-destructive/50 text-destructive"
  );
  const content = (
    <>
      <span className="truncate">{title}</span>
      {mark && usage.model && (
        <span className="truncate text-muted-foreground">
          · <bdi dir="ltr">{usage.model}</bdi>
        </span>
      )}
      {note && <span className="truncate text-muted-foreground/80">· {note}</span>}
      <ModelMark mark={mark} />
    </>
  );
  const data = {
    "data-usage-feature": usage.feature,
    "data-usage-kind": usage.kind,
    ...(mark ? { "data-model-check": mark } : {}),
  };
  if (!openSettings) {
    return (
      <span className={className} {...data}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openSettings(usage.edit)}
      title={t("connections.endpoints.editIn", { feature: title })}
      className={cn(className, "hover:border-border-hover hover:text-foreground")}
      {...data}
    >
      {content}
    </button>
  );
}

function UsedBy({
  usages,
  health = null,
}: {
  usages: readonly FeatureUsage[];
  /** The connection's check: chips get ✓/✕ for models it compared. */
  health?: OwnerHealth | null;
}) {
  const { t } = useTranslation();
  if (usages.length === 0) {
    return <p className="text-xs text-muted-foreground/70">{t("connections.usedBy.none")}</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" data-connection-used-by="">
      <span className="text-muted-foreground">{t("connections.usedBy.label")}</span>
      {usages.map((usage) => (
        <UsageChip
          key={usage.feature}
          usage={usage}
          mark={modelMark(health, usage.feature, usage.model)}
        />
      ))}
    </div>
  );
}

function ConnectionCard({
  settingId,
  icon,
  name,
  pill,
  usages,
  health = null,
  problem,
  lastUse,
  footer,
  children,
}: {
  /** Search anchor; a card that isn't a search target has none. */
  settingId?: string;
  icon: ReactNode;
  name: string;
  pill?: ReactNode;
  usages: readonly FeatureUsage[];
  /** Its check, for the model chips. */
  health?: OwnerHealth | null;
  /** What its check found wrong, at the bottom. */
  problem?: ReactNode;
  /**
   * Stage B's "Last recorded use: <feature>, OK / failed" line, by the same
   * descriptor ids as the checks (connectionHealth.ts). Nothing passes it yet.
   */
  lastUse?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-setting-id={settingId || undefined}
      data-connection-card=""
      data-connection-health-tone={health?.tone}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border border-border/70 bg-card/50 p-3.5 dark:border-border-subtle/70 dark:bg-surface-2/50",
        health?.tone === "danger" && "border-destructive/40 dark:border-destructive/40",
        health?.tone === "warning" && "border-warning/40 dark:border-warning/40"
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background dark:border-white/10 dark:bg-surface-1">
          {icon}
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</p>
        {pill}
      </div>
      {children}
      <UsedBy usages={usages} health={health} />
      {problem}
      {lastUse && <div data-connection-last-use="">{lastUse}</div>}
      {footer && <div className="flex flex-wrap items-center gap-3">{footer}</div>}
    </div>
  );
}

// ── Cards and rows ───────────────────────────────────────────────────────────

/** In use and a first run's starters are cards; the other groups list rows. */
type ConnectionView = "card" | "row";

interface RemoveRequest {
  provider: ConnectionProviderDef;
  credential: ConnectionCredential;
  clear: () => void;
}

interface ProviderConnectionProps {
  provider: ConnectionProviderId;
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
  onRemove: (request: RemoveRequest) => void;
  "data-setting-id": string;
}

function useProviderCredentials(provider: ConnectionProviderDef) {
  const values = useSettingsStore(
    useShallow((s) => provider.credentials.map((credential) => s[credential.key] ?? ""))
  );
  const setters = useSettingsStore(
    useShallow((s) => provider.credentials.map((credential) => s[credential.setter]))
  );
  const endpoint = useSettingsStore((s) =>
    provider.endpoint ? (s[provider.endpoint.key] ?? "") : ""
  );
  return { values, setters, endpoint };
}

type ProviderStatus = "managed" | "ready" | "endpointNeeded" | "notConnected";

/**
 * What the pill or row says: connected only with a key and, where the
 * provider has one, a valid endpoint (a key alone "needs its endpoint").
 */
function providerStatus(
  provider: ConnectionProviderDef,
  allowed: boolean,
  values: readonly string[],
  endpoint: string
): ProviderStatus {
  if (!allowed) return "managed";
  if (!values.some((value) => !!value.trim())) return "notConnected";
  if (provider.endpoint && provider.endpoint.validate(endpoint) !== null) return "endpointNeeded";
  return "ready";
}

const STATUS_TONE: Record<ProviderStatus, PillTone> = {
  managed: "managed",
  ready: "ok",
  endpointNeeded: "busy",
  notConnected: "muted",
};

const STATUS_LABEL_KEY: Record<ProviderStatus, string> = {
  managed: "common.managedByOrg",
  ready: "connections.status.keySaved",
  endpointNeeded: "connections.status.endpointNeeded",
  notConnected: "connections.status.notConnected",
};

/**
 * A provider's resource endpoint (Azure Speech), a plain setting shown in
 * full: written as typed, tidied when the field is left (a bare host reads as
 * https, a valid one is kept as its origin), and what's wrong with it said
 * under it once the field is left.
 */
function ProviderEndpointField({
  provider,
  endpoint,
  allowed,
  focusRequest = 0,
}: {
  provider: ConnectionProviderDef;
  endpoint: string;
  allowed: boolean;
  /** Each new value focuses the field (a check's "Edit endpoint"). */
  focusRequest?: number;
}) {
  const { t } = useTranslation();
  const field = provider.endpoint;
  const setEndpoint = useSettingsStore((s) => (field ? s[field.setter] : undefined));
  const inputId = useId();
  const errorId = useId();
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (focusRequest > 0) document.getElementById(inputId)?.focus();
  }, [focusRequest, inputId]);
  if (!field || !setEndpoint) return null;
  const reason = endpoint.trim() ? field.validate(endpoint) : null;
  const shownReason = !editing && reason;
  if (!allowed) {
    return endpoint ? (
      <p dir="ltr" className="truncate font-mono text-xs text-muted-foreground">
        {endpoint}
      </p>
    ) : null;
  }
  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="block text-xs font-medium text-foreground">
        {t(field.labelKey)}
      </label>
      <Input
        id={inputId}
        dir="ltr"
        value={endpoint}
        placeholder={field.placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={shownReason ? true : undefined}
        aria-describedby={shownReason ? errorId : undefined}
        onFocus={() => setEditing(true)}
        onChange={(event) => setEndpoint(event.target.value)}
        onBlur={() => {
          setEditing(false);
          const next = field.normalize(endpoint);
          if (next !== endpoint) setEndpoint(next);
        }}
        className="h-8 font-mono text-xs"
      />
      {shownReason && (
        <p id={errorId} className="text-xs text-destructive">
          {t(`${field.errorKeyPrefix}.${shownReason}`)}
        </p>
      )}
    </div>
  );
}

function RemoveKeyButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-8 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
      onClick={onClick}
    >
      {t("connections.actions.remove")}
    </Button>
  );
}

/**
 * A provider's credentials, on its card or opened under its row: its
 * endpoint field when it has one, then a replace-only field and Remove for
 * each credential, or (where policy forbids the provider) the masked values
 * with no editor. `editRequest` opens a single key's replace field (a
 * check's "Replace key"); `endpointFocus` focuses the endpoint field.
 */
function ProviderCredentials({
  provider,
  values,
  setters,
  endpoint,
  allowed,
  onRemove,
  editRequest = 0,
  endpointFocus = 0,
}: {
  provider: ConnectionProviderDef;
  values: readonly string[];
  setters: ReadonlyArray<(value: string) => void>;
  endpoint: string;
  allowed: boolean;
  onRemove: (request: RemoveRequest) => void;
  editRequest?: number;
  endpointFocus?: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {provider.endpoint && (
        <ProviderEndpointField
          provider={provider}
          endpoint={endpoint}
          allowed={allowed}
          focusRequest={endpointFocus}
        />
      )}
      {provider.credentials.map((credential, index) => {
        const value = values[index];
        const label = credential.labelKey
          ? t(credential.labelKey)
          : provider.endpoint && allowed
            ? t("common.apiKey")
            : undefined;
        return (
          <div key={credential.key} className="space-y-1">
            {label && <p className="text-xs font-medium text-foreground">{label}</p>}
            {allowed ? (
              <div className="flex items-center gap-1.5">
                <ApiKeyInput
                  className="min-w-0 flex-1"
                  apiKey={value}
                  setApiKey={setters[index]}
                  label=""
                  helpText=""
                  ariaLabel={`${provider.name}: ${label ?? t("common.apiKey")}`}
                  replace
                  editRequest={provider.credentials.length === 1 ? editRequest : 0}
                />
                {value && (
                  <RemoveKeyButton
                    onClick={() =>
                      onRemove({ provider, credential, clear: () => setters[index]("") })
                    }
                  />
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {value ? (
                  <span dir="ltr" className="font-mono">
                    {maskApiKey(value)}
                  </span>
                ) : (
                  t("connections.status.noKey")
                )}
              </p>
            )}
          </div>
        );
      })}
      {provider.endpoint && allowed && (
        <p className="text-xs text-muted-foreground">{t(provider.endpoint.helpKey)}</p>
      )}
    </div>
  );
}

/** A provider's check parts, with the actions its problem box offers. */
function useProviderHealth(
  provider: ConnectionProviderDef,
  {
    allowed,
    values,
    setters,
    onRemove,
    replaceKey,
    editEndpoint,
  }: {
    allowed: boolean;
    values: readonly string[];
    setters: ReadonlyArray<(value: string) => void>;
    onRemove: (request: RemoveRequest) => void;
    replaceKey?: () => void;
    editEndpoint?: () => void;
  }
) {
  const single = provider.credentials.length === 1;
  return useHealthControls(provider.id, provider.name, {
    onReplaceKey: allowed ? replaceKey : undefined,
    keyUrl: allowed ? provider.keyUrl : undefined,
    onRemove:
      allowed && single && values[0]
        ? () =>
            onRemove({
              provider,
              credential: provider.credentials[0],
              clear: () => setters[0](""),
            })
        : undefined,
    onEditEndpoint: allowed && provider.endpoint ? editEndpoint : undefined,
  });
}

function ProviderKeyCard({
  provider: providerId,
  usages,
  policy,
  onRemove,
  "data-setting-id": settingId,
}: ProviderConnectionProps) {
  const { t } = useTranslation();
  const provider = findConnectionProvider(providerId) as ConnectionProviderDef;
  const { values, setters, endpoint } = useProviderCredentials(provider);
  const allowed = providerAllowed(policy, provider);
  const status = providerStatus(provider, allowed, values, endpoint);
  const [editRequest, setEditRequest] = useState(0);
  const [endpointFocus, setEndpointFocus] = useState(0);
  const health = useProviderHealth(provider, {
    allowed,
    values,
    setters,
    onRemove,
    replaceKey:
      provider.credentials.length === 1 ? () => setEditRequest((value) => value + 1) : undefined,
    editEndpoint: () => setEndpointFocus((value) => value + 1),
  });

  return (
    <ConnectionCard
      settingId={settingId}
      icon={<ProviderIcon provider={provider.id} className="h-4 w-4" />}
      name={provider.name}
      pill={
        <>
          {!health.showsState && (
            <StatusPill tone={STATUS_TONE[status]}>{t(STATUS_LABEL_KEY[status])}</StatusPill>
          )}
          {health.pill}
        </>
      }
      usages={usagesOfProvider(usages, provider.id)}
      health={health.health}
      problem={
        <>
          {health.note}
          {health.problem}
        </>
      }
      footer={allowed ? <GetApiKeyLink url={provider.keyUrl} /> : undefined}
    >
      <ProviderCredentials
        provider={provider}
        values={values}
        setters={setters}
        endpoint={endpoint}
        allowed={allowed}
        onRemove={onRemove}
        editRequest={editRequest}
        endpointFocus={endpointFocus}
      />
    </ConnectionCard>
  );
}

/**
 * A provider on one line: its key field (masked and "Replace" when saved,
 * "Paste your API key" when not) with Remove or "Get your API key", and its
 * check's pill and Check. Corti's three credentials and Azure Speech's
 * endpoint and key open under the line instead.
 */
function ProviderKeyRow({
  provider: providerId,
  usages,
  policy,
  onRemove,
  "data-setting-id": settingId,
}: ProviderConnectionProps) {
  const { t } = useTranslation();
  const provider = findConnectionProvider(providerId) as ConnectionProviderDef;
  const { values, setters, endpoint } = useProviderCredentials(provider);
  const [open, setOpen] = useState(false);
  const [editRequest, setEditRequest] = useState(0);
  const [endpointFocus, setEndpointFocus] = useState(0);
  const allowed = providerAllowed(policy, provider);
  const saved = values.some((value) => !!value.trim()) || !!endpoint.trim();
  const own = usagesOfProvider(usages, provider.id);
  const opensBody = provider.credentials.length > 1 || !!provider.endpoint;
  const health = useProviderHealth(provider, {
    allowed,
    values,
    setters,
    onRemove,
    replaceKey: opensBody ? () => setOpen(true) : () => setEditRequest((value) => value + 1),
    editEndpoint: () => {
      setOpen(true);
      setEndpointFocus((value) => value + 1);
    },
  });
  const getKey =
    allowed && !saved ? (
      <GetApiKeyLink
        url={provider.keyUrl}
        className="shrink-0 text-xs text-link underline decoration-link/30 hover:decoration-link/60"
      />
    ) : undefined;
  const line = {
    "data-setting-id": settingId,
    icon: <ProviderIcon provider={provider.id} className="h-4 w-4" />,
    name: provider.name,
    below: own.length > 0 ? <UsedBy usages={own} health={health.health} /> : undefined,
    health: health.health?.notChecked === "managed" ? undefined : health.pill,
    problem: health.problem,
  };

  if (opensBody) {
    const status = providerStatus(provider, allowed, values, endpoint);
    return (
      <ConnectionRow
        {...line}
        actions={getKey}
        toggleLabel={
          allowed || saved
            ? t(saved ? "connections.rows.manage" : "connections.rows.setUp")
            : undefined
        }
        open={open}
        onToggle={() => setOpen((value) => !value)}
        body={
          <ProviderCredentials
            provider={provider}
            values={values}
            setters={setters}
            endpoint={endpoint}
            allowed={allowed}
            onRemove={onRemove}
            endpointFocus={endpointFocus}
          />
        }
      >
        <RowStatus tone={STATUS_TONE[status]}>
          {status === "managed" && health.health?.notChecked === "managed"
            ? t("connections.health.notChecked.managed")
            : t(STATUS_LABEL_KEY[status])}
        </RowStatus>
      </ConnectionRow>
    );
  }

  const [credential] = provider.credentials;
  const [value] = values;
  if (!allowed) {
    return (
      <ConnectionRow {...line}>
        <RowStatus tone="managed">
          {health.health?.notChecked === "managed"
            ? t("connections.health.notChecked.managed")
            : t("common.managedByOrg")}
        </RowStatus>
        {value && (
          <span dir="ltr" className="truncate font-mono text-xs text-muted-foreground">
            {maskApiKey(value)}
          </span>
        )}
      </ConnectionRow>
    );
  }
  return (
    <ConnectionRow
      {...line}
      actions={
        <>
          {value && (
            <RemoveKeyButton
              onClick={() => onRemove({ provider, credential, clear: () => setters[0]("") })}
            />
          )}
          {getKey}
        </>
      }
    >
      <ApiKeyInput
        className="min-w-0 flex-1"
        apiKey={value}
        setApiKey={setters[0]}
        label=""
        helpText=""
        ariaLabel={`${provider.name}: ${t("common.apiKey")}`}
        replace
        editRequest={editRequest}
      />
    </ConnectionRow>
  );
}

function ProviderConnection({
  view,
  ...props
}: ProviderConnectionProps & { view: ConnectionView }) {
  return view === "card" ? <ProviderKeyCard {...props} /> : <ProviderKeyRow {...props} />;
}

interface ConnectionStatus {
  tone: PillTone;
  label: string;
}

/** GitHub Copilot's sign-in as a status, or null until main has answered. */
function useCopilotConnection(policy: PolicyDecisionSnapshot) {
  const { t } = useTranslation();
  const status = useCopilotStore((state) => state.status);
  const loaded = useCopilotStore((state) => state.loaded);
  const allowed =
    isModeAllowedByPolicy(policy, "llm", "providers") &&
    isProviderAllowedByPolicy(policy, "llm", COPILOT_PROVIDER_ID);
  const signedIn = loaded && status.state === "signedIn";

  let state: ConnectionStatus | null = null;
  if (!allowed) state = { tone: "managed", label: t("common.managedByOrg") };
  else if (signedIn) {
    state = {
      tone: "ok",
      label: status.login
        ? t("connections.status.signedInAs", { login: status.login })
        : t("connections.status.signedIn"),
    };
  } else if (loaded && (status.state === "waiting" || status.state === "checking")) {
    state = { tone: "busy", label: t("connections.status.signingIn") };
  } else if (loaded) {
    state = { tone: "muted", label: t("connections.status.notConnected") };
  }
  return { allowed, signedIn, state };
}

/** Copilot's card body, and its row's: the sign-in panel, or why it isn't offered. */
function CopilotBody({ allowed }: { allowed: boolean }) {
  const { t } = useTranslation();
  return allowed ? (
    <CopilotSignIn />
  ) : (
    <p className="text-xs text-muted-foreground">{t("connections.copilot.managed")}</p>
  );
}

interface SignInConnectionProps {
  view: ConnectionView;
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
  "data-setting-id": string;
}

function CopilotConnection({
  view,
  usages,
  policy,
  "data-setting-id": settingId,
}: SignInConnectionProps) {
  const { t } = useTranslation();
  const { allowed, signedIn, state } = useCopilotConnection(policy);
  const [open, setOpen] = useState(false);
  const own = usagesOfProvider(usages, COPILOT_PROVIDER_ID);
  const icon = <ProviderIcon provider={COPILOT_PROVIDER_ID} className="h-4 w-4" />;
  const name = t("connections.names.copilot");
  const health = useHealthControls("copilot", name, {
    onSignIn: view === "row" ? () => setOpen(true) : undefined,
  });

  if (view === "card") {
    return (
      <ConnectionCard
        settingId={settingId}
        icon={icon}
        name={name}
        pill={
          <>
            {!health.showsState && state && (
              <StatusPill tone={state.tone}>{state.label}</StatusPill>
            )}
            {health.pill}
          </>
        }
        usages={own}
        health={health.health}
        problem={
          <>
            {health.note}
            {health.problem}
          </>
        }
      >
        <CopilotBody allowed={allowed} />
      </ConnectionCard>
    );
  }
  return (
    <ConnectionRow
      data-setting-id={settingId}
      icon={icon}
      name={name}
      below={own.length > 0 ? <UsedBy usages={own} health={health.health} /> : undefined}
      health={health.health?.notChecked === "managed" ? undefined : health.pill}
      problem={health.problem}
      toggleLabel={
        allowed ? t(signedIn ? "connections.rows.manage" : "connections.rows.signIn") : undefined
      }
      open={open}
      onToggle={() => setOpen((value) => !value)}
      body={<CopilotBody allowed={allowed} />}
    >
      {state && <RowStatus tone={state.tone}>{state.label}</RowStatus>}
    </ConnectionRow>
  );
}

type CloudState = "off" | "managed" | "signedIn" | "signedOut";

/** OpenWhispr Cloud's state: off (Privacy & Data), managed, signed in or out. */
function useCloudConnection(
  policy: PolicyDecisionSnapshot,
  cloudDisabled: boolean
): { kind: CloudState; state: ConnectionStatus; body: ReactNode } {
  const { t } = useTranslation();
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const allowed =
    isModeAllowedByPolicy(policy, "llm", "openwhispr") ||
    isModeAllowedByPolicy(policy, "transcription", "openwhispr");

  if (cloudDisabled) {
    // Off: nothing here offers a sign-in; the switch lives in Privacy & Data.
    return {
      kind: "off",
      state: { tone: "muted", label: t("connections.status.off") },
      body: (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">{t("connections.cloud.off")}</p>
          <SettingsLink destination="privacyData#privacy.cloud">
            {t("connections.cloud.openPrivacy")}
          </SettingsLink>
        </div>
      ),
    };
  }
  if (!allowed) {
    return {
      kind: "managed",
      state: { tone: "managed", label: t("common.managedByOrg") },
      body: <p className="text-xs text-muted-foreground">{t("connections.cloud.managed")}</p>,
    };
  }
  if (isSignedIn) {
    return {
      kind: "signedIn",
      state: { tone: "ok", label: t("connections.status.signedIn") },
      body: <p className="text-xs text-muted-foreground">{t("connections.cloud.automatic")}</p>,
    };
  }
  return {
    kind: "signedOut",
    state: { tone: "muted", label: t("connections.status.notSignedIn") },
    body: (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">{t("connections.cloud.signedOut")}</p>
        <SettingsLink destination="account#account.signIn">
          {t("connections.cloud.signIn")}
        </SettingsLink>
      </div>
    ),
  };
}

function CloudConnection({
  view,
  usages,
  policy,
  cloudDisabled,
  "data-setting-id": settingId,
}: SignInConnectionProps & { cloudDisabled: boolean }) {
  const { t } = useTranslation();
  const { kind, state, body } = useCloudConnection(policy, cloudDisabled);
  const [open, setOpen] = useState(false);
  const own = usagesOfProvider(usages, "cloud");
  const icon = <Cloud className="h-4 w-4 text-foreground/80" />;
  const name = t("connections.names.cloud");
  const health = useHealthControls("cloud", name);

  if (view === "card") {
    return (
      <ConnectionCard
        settingId={settingId}
        icon={icon}
        name={name}
        pill={
          <>
            {!health.showsState && <StatusPill tone={state.tone}>{state.label}</StatusPill>}
            {health.pill}
          </>
        }
        usages={own}
        health={health.health}
        problem={health.problem}
      >
        {body}
      </ConnectionCard>
    );
  }
  const expandable = kind === "signedIn" || kind === "signedOut";
  return (
    <ConnectionRow
      data-setting-id={settingId}
      icon={icon}
      name={name}
      below={own.length > 0 ? <UsedBy usages={own} health={health.health} /> : undefined}
      health={health.health?.notChecked === "managed" ? undefined : health.pill}
      problem={health.problem}
      actions={
        kind === "off" ? (
          <SettingsLink destination="privacyData#privacy.cloud" className="shrink-0">
            {t("connections.cloud.openPrivacy")}
          </SettingsLink>
        ) : undefined
      }
      toggleLabel={
        expandable
          ? t(kind === "signedIn" ? "connections.rows.manage" : "connections.rows.signIn")
          : undefined
      }
      open={open}
      onToggle={() => setOpen((value) => !value)}
      body={body}
    >
      <RowStatus tone={state.tone}>
        {kind === "off" ? t("connections.rows.cloudOff") : state.label}
      </RowStatus>
    </ConnectionRow>
  );
}

// ── Connections ──────────────────────────────────────────────────────────────

const STARTER_PROVIDERS = CONNECTION_PROVIDERS.filter((provider) => provider.common).map(
  (provider) => provider.id
);

function GroupHeading({ title, count, hint }: { title: string; count?: number; hint: string }) {
  return (
    <div>
      <h4 className="flex items-baseline gap-2 text-xs font-medium text-foreground">
        {title}
        {count !== undefined && (
          <span className="font-normal tabular-nums text-muted-foreground/80">{count}</span>
        )}
      </h4>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">{hint}</p>
    </div>
  );
}

/**
 * Connections, grouped by state (connectionGroups.ts): In use as cards, Saved,
 * not in use as rows, the rest folded; a first run shows the starter cards
 * instead. Groups hold for a visit (`visiting`: the page showing while Settings
 * is open), so a key added or removed leaves its card or row where it is.
 */
function ConnectionsSection({
  usages,
  policy,
  cloudDisabled,
  connection,
  connectionUses,
  visiting,
}: {
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
  cloudDisabled: boolean;
  connection: CustomConnection | null;
  connectionUses: readonly ConnectionUse[];
  visiting: boolean;
}) {
  const { t } = useTranslation();
  const { isCompact } = useSettingsLayout();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const secrets = useSettingsStore(
    useShallow((s) => CONNECTION_PROVIDERS.map((provider) => hasSavedConnection(provider, s)))
  );
  const secretsHydrated = useSettingsStore((s) => s.secretsHydrated);
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const copilotLoaded = useCopilotStore((state) => state.loaded);
  const copilotSignedIn = useCopilotStore(
    (state) => state.loaded && state.status.state === "signedIn"
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [visit, setVisit] = useState<ConnectionsVisit>(NO_VISIT);

  // Copilot's row may stay closed, so its sign-in panel can't be what loads the status.
  useEffect(() => {
    void syncCopilotAuthStatus();
  }, []);

  const requestRemove = useCallback(
    ({ provider, credential, clear }: RemoveRequest) => {
      const name = credential.labelKey
        ? `${provider.name}: ${t(credential.labelKey)}`
        : provider.name;
      // Corti's key serves language models and its client credentials speech-to-text.
      const active = usagesOfProvider(usages, provider.id).filter(
        (usage) =>
          isActiveUsage(usage) &&
          (credential.serves === "both" ||
            (credential.serves === "transcription") === STT_FEATURES.has(usage.feature))
      );
      showConfirmDialog({
        title: t("connections.remove.title", { name }),
        description: active.length
          ? t("connections.remove.inUse", { features: featureList(t, active) })
          : t("connections.remove.description"),
        variant: "destructive",
        confirmText: t("connections.actions.remove"),
        onConfirm: clear,
      });
    },
    [showConfirmDialog, t, usages]
  );

  const activeUses = (provider: string) =>
    usagesOfProvider(usages, provider).filter(isActiveUsage).length;
  const input: ConnectionGroupsInput = {
    connections: {
      copilot: { activeUses: activeUses(COPILOT_PROVIDER_ID), saved: copilotSignedIn },
      ...Object.fromEntries(
        CONNECTION_PROVIDERS.map((provider, index) => [
          provider.id,
          { activeUses: activeUses(provider.id), saved: secrets[index] },
        ])
      ),
      cloud: { activeUses: activeUses("cloud"), saved: !cloudDisabled && isSignedIn },
      ...(connection && {
        custom: {
          activeUses: connectionUses.filter((use) => isActiveUsage(use.usage)).length,
          saved: true,
        },
      }),
    },
    cloudOff: cloudDisabled,
    common: STARTER_PROVIDERS,
  };
  // A visit starts in render, not an effect: a search reveal opening the fold
  // right after must not be undone by a late reset.
  const step = stepVisit(visit, {
    active: visiting,
    ready: secretsHydrated && copilotLoaded,
    input,
  });
  if (step.visit !== visit) {
    setVisit(step.visit);
    if (step.started) setMoreOpen(false);
  }
  const groups = step.groups;

  const shared = { usages, policy, onRemove: requestRemove };
  // Literal anchors: each card or row is a search target and a "Manage keys" destination.
  const views: Record<Exclude<ConnectionId, "custom">, (view: ConnectionView) => ReactNode> = {
    copilot: (view) => (
      <CopilotConnection
        view={view}
        usages={usages}
        policy={policy}
        data-setting-id="connections.copilot"
      />
    ),
    openai: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="openai"
        data-setting-id="connections.openai"
      />
    ),
    anthropic: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="anthropic"
        data-setting-id="connections.anthropic"
      />
    ),
    gemini: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="gemini"
        data-setting-id="connections.gemini"
      />
    ),
    groq: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="groq"
        data-setting-id="connections.groq"
      />
    ),
    openrouter: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="openrouter"
        data-setting-id="connections.openrouter"
      />
    ),
    mistral: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="mistral"
        data-setting-id="connections.mistral"
      />
    ),
    tinfoil: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="tinfoil"
        data-setting-id="connections.tinfoil"
      />
    ),
    corti: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="corti"
        data-setting-id="connections.corti"
      />
    ),
    xai: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="xai"
        data-setting-id="connections.xai"
      />
    ),
    deepgram: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="deepgram"
        data-setting-id="connections.deepgram"
      />
    ),
    assemblyai: (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="assemblyai"
        data-setting-id="connections.assemblyai"
      />
    ),
    "azure-speech": (view) => (
      <ProviderConnection
        {...shared}
        view={view}
        provider="azure-speech"
        data-setting-id="connections.azureSpeech"
      />
    ),
    cloud: (view) => (
      <CloudConnection
        view={view}
        usages={usages}
        policy={policy}
        cloudDisabled={cloudDisabled}
        data-setting-id="connections.cloud"
      />
    ),
  };
  const render = (id: ConnectionId, view: ConnectionView) => {
    let element: ReactNode = null;
    if (id !== "custom") element = views[id](view);
    else if (connection) {
      const props = { connection, uses: connectionUses, usages, policy };
      element =
        view === "card" ? <CustomConnectionCard {...props} /> : <CustomConnectionRow {...props} />;
    }
    return <Fragment key={id}>{element}</Fragment>;
  };
  const nameOf = (id: ConnectionId) =>
    id === "copilot" || id === "cloud"
      ? t(`connections.names.${id}`)
      : id === "custom"
        ? (connection?.name ?? "")
        : (findConnectionProvider(id)?.name ?? id);

  const grid = cn("grid gap-3", !isCompact && "grid-cols-2");
  const folded = groups.layout === "grouped" ? groups.add : groups.fold;
  const fold = folded.length > 0 && (
    <div data-setting-id="connections.more" className="space-y-3">
      <button
        type="button"
        data-setting-expand=""
        aria-expanded={moreOpen}
        onClick={() => setMoreOpen((open) => !open)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-start text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            !moreOpen && "-rotate-90 rtl:rotate-90"
          )}
        />
        <span className="shrink-0 font-medium text-foreground">
          {groups.layout === "grouped"
            ? t("connections.groups.add.title", { count: folded.length })
            : t("connections.more.title", { count: folded.length })}
        </span>
        {!moreOpen && <span className="min-w-0 truncate">{folded.map(nameOf).join(" · ")}</span>}
      </button>
      {moreOpen && <SettingsPanel>{folded.map((id) => render(id, "row"))}</SettingsPanel>}
    </div>
  );
  // While there's none: "Add custom connection" (or, under a policy, why not).
  const addCustom = !connection && <AddCustomConnection usages={usages} policy={policy} />;

  return (
    <div data-setting-id="connections.providers" className="space-y-4">
      <SectionHeader
        title={t("connections.sections.providers.title")}
        description={t("connections.sections.providers.description")}
      />
      <ConnectionsHealthSummary />
      {groups.layout === "grouped" ? (
        <>
          {groups.inUse.length > 0 && (
            <div data-connection-group="inUse" className="space-y-2.5">
              <GroupHeading
                title={t("connections.groups.inUse.title")}
                count={groups.inUse.length}
                hint={t("connections.groups.inUse.hint")}
              />
              <div className={grid}>{groups.inUse.map((id) => render(id, "card"))}</div>
            </div>
          )}
          {groups.saved.length > 0 && (
            <div data-connection-group="saved" className="space-y-2.5">
              <GroupHeading
                title={t("connections.groups.saved.title")}
                count={groups.saved.length}
                hint={t("connections.groups.saved.hint")}
              />
              <SettingsPanel>{groups.saved.map((id) => render(id, "row"))}</SettingsPanel>
            </div>
          )}
          {fold}
          {addCustom}
        </>
      ) : (
        <>
          <div data-connection-group="start" className="space-y-2.5">
            <GroupHeading
              title={t("connections.groups.start.title")}
              hint={t("connections.groups.start.hint")}
            />
            <div className={grid}>
              {groups.cards.filter((id) => id !== "custom").map((id) => render(id, "card"))}
            </div>
          </div>
          {fold}
          {groups.cards.includes("custom") ? render("custom", "card") : addCustom}
        </>
      )}
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />
    </div>
  );
}

// ── Self-hosted & custom endpoints ──────────────────────────────────────────

function EndpointsSection({
  usages,
  policy,
  customConnection,
  connectionUses,
}: {
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
  customConnection: CustomConnection | null;
  connectionUses: readonly ConnectionUse[];
}) {
  const { t } = useTranslation();
  const sttKeySaved = useSettingsStore((s) => !!s.customTranscriptionApiKey?.trim());
  // Custom endpoints the connection covers are on its card's "Used by" instead.
  const covered = new Set(connectionUses.map((use) => use.feature));
  const all = endpointUsages(usages);
  const endpoints = all.filter((usage) => !covered.has(usage.feature));
  const offerSaveAs = !customConnection && isCustomConnectionAllowed(policy);

  return (
    <div data-setting-id="connections.endpoints" className="space-y-3">
      <SectionHeader
        title={t("connections.sections.endpoints.title")}
        description={t("connections.sections.endpoints.description")}
      />
      {endpoints.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {all.length > 0 && customConnection
            ? t("connections.endpoints.allCovered", { name: customConnection.name })
            : t("connections.endpoints.none")}
        </p>
      ) : (
        <SettingsPanel>
          {endpoints.map((usage) => (
            <EndpointEntry
              key={usage.feature}
              usage={usage}
              usages={usages}
              sttKeySaved={sttKeySaved}
              offerSaveAs={offerSaveAs}
            />
          ))}
        </SettingsPanel>
      )}
    </div>
  );
}

/**
 * One feature's custom or self-hosted endpoint: what and where (host and
 * model, never the URL), Save as connection, Edit in <feature>, and its
 * check (`endpoint:<feature>`).
 */
function EndpointEntry({
  usage,
  usages,
  sttKeySaved,
  offerSaveAs,
}: {
  usage: FeatureUsage;
  usages: readonly FeatureUsage[];
  sttKeySaved: boolean;
  offerSaveAs: boolean;
}) {
  const { t } = useTranslation();
  const connection = usage.connection;
  const title = featureTitle(t, usage.feature);
  const health = useHealthControls(
    `endpoint:${usage.feature}`,
    connection.type === "custom" || connection.type === "selfHosted"
      ? connection.host || title
      : title,
    { editEndpointDestination: usage.edit },
    { showSkipped: true }
  );
  if (connection.type !== "custom" && connection.type !== "selfHosted") return null;
  const note = usageNote(t, usage);
  const custom = connection.type === "custom";
  return (
    <SettingsPanelRow>
      <div className="space-y-2">
        <div
          data-endpoint-feature={usage.feature}
          data-endpoint-type={connection.type}
          className={cn("flex flex-wrap items-start gap-3", usage.kind === "off" && "opacity-70")}
        >
          <div className="mt-0.5 shrink-0 text-muted-foreground">
            {custom ? <Wrench className="h-4 w-4" /> : <Network className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-xs font-medium text-foreground">
              {title}
              <span className="font-normal text-muted-foreground">
                {" · "}
                {t(custom ? "connections.endpoints.custom" : "connections.endpoints.selfHosted")}
              </span>
              {note && <span className="font-normal text-muted-foreground/80"> · {note}</span>}
            </p>
            <p className="text-xs text-muted-foreground">
              {connection.host ? (
                <span dir="ltr" className="font-mono">
                  {connection.host}
                </span>
              ) : (
                t("connections.endpoints.noUrl")
              )}
              {" · "}
              {connection.model ? (
                <span dir="ltr" className="font-mono">
                  {connection.model}
                </span>
              ) : (
                t("connections.endpoints.noModel")
              )}
            </p>
            {custom && (
              <p className="text-xs text-muted-foreground/80">
                {connection.secret === "speechToText"
                  ? t(
                      sttKeySaved
                        ? "connections.endpoints.sttKeySaved"
                        : "connections.endpoints.sttNoKey"
                    )
                  : t("connections.endpoints.featureKey")}
              </p>
            )}
            {custom && offerSaveAs && (
              <div className="pt-1">
                <SaveAsConnection usage={usage} usages={usages} />
              </div>
            )}
          </div>
          {health.pill && (
            <div className="flex shrink-0 items-center gap-2" data-endpoint-health="">
              {health.pill}
            </div>
          )}
          <SettingsLink destination={usage.edit} className="shrink-0">
            {t("connections.endpoints.editIn", { feature: title })}
          </SettingsLink>
        </div>
        {health.problem}
      </div>
    </SettingsPanelRow>
  );
}

// ── Local models ─────────────────────────────────────────────────────────────

interface LocalModelRow {
  engine: LocalModelEngine;
  id: string;
  name: string;
  kind: "speech" | "language";
  size: string;
  downloaded: boolean;
  group: string;
}

const ORGANIZATION_NAMES: Record<string, string> = Object.fromEntries(
  LOCAL_ASR_ORGANIZATIONS.map((organization) => [organization.id, organization.name])
);

function LocalModelsSection({ usages }: { usages: readonly FeatureUsage[] }) {
  const { t } = useTranslation();
  const { isCompact } = useSettingsLayout();
  const visible = useSettingsVisible();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const keepLoaded = useSettingsStore((s) => s.keepLocalModelLoaded);
  const setKeepLoaded = useSettingsStore((s) => s.setKeepLocalModelLoaded);
  const [whisper, setWhisper] = useState<WhisperModelResult[]>([]);
  const [sherpa, setSherpa] = useState<ParakeetModelResult[]>([]);
  const [sherpaSupported, setSherpaSupported] = useState(true);
  const [llm, setLlm] = useState<LocalLLMModelStatus[]>([]);
  const [browseOpen, setBrowseOpen] = useState(false);

  const loadWhisper = useCallback(async () => {
    try {
      const result = await window.electronAPI?.listWhisperModels?.();
      if (result?.success && Array.isArray(result.models)) setWhisper(result.models);
    } catch {
      // The last list stays.
    }
  }, []);
  const loadSherpa = useCallback(async () => {
    try {
      const result = await window.electronAPI?.listParakeetModels?.();
      if (result?.success && Array.isArray(result.models)) setSherpa(result.models);
    } catch {
      // The last list stays.
    }
  }, []);
  const loadLlm = useCallback(async () => {
    try {
      const result = await window.electronAPI?.modelGetAll?.();
      if (Array.isArray(result)) setLlm(result);
    } catch {
      // The last list stays.
    }
  }, []);
  const loadAll = useCallback(
    () => Promise.all([loadWhisper(), loadSherpa(), loadLlm()]),
    [loadWhisper, loadSherpa, loadLlm]
  );

  // Disk can change while Settings is closed (a download elsewhere): re-read on reopen.
  useEffect(() => {
    if (visible) void loadAll();
  }, [visible, loadAll]);
  useEffect(() => {
    const reload = () => void loadAll();
    window.addEventListener(LOCAL_MODELS_CHANGED_EVENT, reload);
    window.addEventListener("openwhispr-models-cleared", reload);
    return () => {
      window.removeEventListener(LOCAL_MODELS_CHANGED_EVENT, reload);
      window.removeEventListener("openwhispr-models-cleared", reload);
    };
  }, [loadAll]);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.checkParakeetInstallation?.()
      .then((capability) => {
        if (!cancelled && capability?.supported === false) setSherpaSupported(false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const whisperDownloads = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: loadWhisper,
  });
  const sherpaDownloads = useModelDownload({
    modelType: "parakeet",
    onDownloadComplete: loadSherpa,
  });
  const llmDownloads = useModelDownload({ modelType: "llm", onDownloadComplete: loadLlm });
  const downloadsFor = (engine: LocalModelEngine) =>
    engine === "whisper" ? whisperDownloads : engine === "sherpa" ? sherpaDownloads : llmDownloads;
  const reloadFor = (engine: LocalModelEngine) =>
    engine === "whisper" ? loadWhisper : engine === "sherpa" ? loadSherpa : loadLlm;

  const rows = useMemo<LocalModelRow[]>(
    () => [
      ...whisper.map((model): LocalModelRow => {
        const info = WHISPER_MODEL_INFO[model.model];
        return {
          engine: "whisper",
          id: model.model,
          name: info ? `Whisper ${info.name}` : model.model,
          kind: "speech",
          size: model.size_mb ? formatBytes(model.size_mb * 1024 * 1024, 0) : (info?.size ?? ""),
          downloaded: !!model.downloaded,
          group: "Whisper",
        };
      }),
      ...sherpa.map((model): LocalModelRow => {
        const info = PARAKEET_MODEL_INFO[model.model];
        const bytes = model.size_bytes ?? (model.size_mb ? model.size_mb * 1024 * 1024 : 0);
        return {
          engine: "sherpa",
          id: model.model,
          name: info?.name ?? model.model,
          kind: "speech",
          size: bytes ? formatBytes(bytes, 0) : (info?.size ?? ""),
          downloaded: !!model.downloaded,
          group: ORGANIZATION_NAMES[getASRModelOrganization(model.model)] ?? "",
        };
      }),
      ...llm.map((model): LocalModelRow => ({
        engine: "llm",
        id: model.id,
        name: model.name,
        kind: "language",
        size: model.sizeBytes ? formatBytes(model.sizeBytes, 1) : model.size,
        downloaded: !!model.isDownloaded,
        group: model.providerName ?? "",
      })),
    ],
    [whisper, sherpa, llm]
  );

  const downloading = (row: LocalModelRow) => downloadsFor(row.engine).isDownloadingModel(row.id);
  const onDisk = rows.filter((row) => row.downloaded || downloading(row));
  const available = rows.filter(
    (row) => !row.downloaded && !downloading(row) && (row.engine !== "sherpa" || sherpaSupported)
  );
  const groups = available.reduce<Array<{ key: string; label: string; rows: LocalModelRow[] }>>(
    (list, row) => {
      const key = `${row.kind}:${row.group}`;
      let group = list.find((entry) => entry.key === key);
      if (!group) {
        group = {
          key,
          label: `${t(`connections.local.kinds.${row.kind}`)} · ${row.group}`,
          rows: [],
        };
        list.push(group);
      }
      group.rows.push(row);
      return list;
    },
    []
  );

  const confirmDelete = (row: LocalModelRow) =>
    showConfirmDialog({
      title: t("transcription.deleteModel.title"),
      description: t("transcription.deleteModel.description"),
      variant: "destructive",
      confirmText: t("common.delete"),
      onConfirm: () => void downloadsFor(row.engine).deleteModel(row.id, reloadFor(row.engine)),
    });

  const columns = cn(
    "grid items-center gap-x-3 gap-y-1",
    isCompact
      ? "grid-cols-[minmax(0,1fr)_auto]"
      : "grid-cols-[minmax(0,1.5fr)_5.5rem_5.5rem_minmax(0,2fr)_auto]"
  );

  const renderRow = (row: LocalModelRow) => {
    const status = downloadsFor(row.engine).downloads[row.id];
    const own = usagesOfLocalModel(usages, row.engine, row.id);
    const active = own.filter(isActiveUsage);
    return (
      <SettingsPanelRow key={`${row.engine}:${row.id}`}>
        <div data-local-model={`${row.engine}:${row.id}`} className={columns}>
          <span className="min-w-0 truncate text-xs font-medium text-foreground" dir="auto">
            {row.name}
          </span>
          {!isCompact && (
            <>
              <span className="text-xs text-muted-foreground">
                {t(`connections.local.kinds.${row.kind}`)}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{row.size}</span>
            </>
          )}
          {status ? (
            <div className={cn("flex items-center gap-2", isCompact && "col-span-2 order-last")}>
              <Progress value={status.progress} className="h-1 flex-1" />
              <span className="text-xs tabular-nums text-muted-foreground">
                {status.phase === "installing"
                  ? t("connections.local.installing")
                  : `${Math.round(status.progress)}%`}
              </span>
            </div>
          ) : (
            <div className={cn("min-w-0", isCompact && "col-span-2 order-last")}>
              {own.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {own.map((usage) => (
                    <UsageChip key={usage.feature} usage={usage} />
                  ))}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground/60">—</span>
              )}
            </div>
          )}
          <div className="flex justify-end">
            {status ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={status.phase === "installing"}
                onClick={() => void downloadsFor(row.engine).cancelDownload(row.id)}
              >
                <X className="h-3 w-3" />
                {t("common.cancel")}
              </Button>
            ) : (
              // A disabled button shows no tooltip; its wrapper says why.
              <span
                title={
                  active.length > 0
                    ? t("connections.local.inUse", { features: featureList(t, active) })
                    : undefined
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                  disabled={active.length > 0}
                  onClick={() => confirmDelete(row)}
                >
                  <Trash2 className="h-3 w-3" />
                  {t("common.delete")}
                </Button>
              </span>
            )}
          </div>
        </div>
      </SettingsPanelRow>
    );
  };

  return (
    <div data-setting-id="connections.localModels" className="space-y-3">
      <SectionHeader
        title={t("connections.sections.local.title")}
        description={t("connections.sections.local.description")}
      />
      <SettingsPanel>
        {!isCompact && (
          <SettingsPanelRow>
            <div className={cn(columns, "text-[11px] font-medium text-muted-foreground/80")}>
              <span>{t("connections.local.columns.model")}</span>
              <span>{t("connections.local.columns.kind")}</span>
              <span>{t("connections.local.columns.size")}</span>
              <span>{t("connections.local.columns.usedBy")}</span>
              <span />
            </div>
          </SettingsPanelRow>
        )}
        {onDisk.map(renderRow)}
        {onDisk.length === 0 && (
          <SettingsPanelRow>
            <p className="text-xs text-muted-foreground">{t("connections.local.none")}</p>
          </SettingsPanelRow>
        )}
        <SettingsPanelRow>
          <div data-local-model="embedding:all-MiniLM-L6-v2" className={columns}>
            <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
              <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate" dir="ltr">
                all-MiniLM-L6-v2
              </span>
            </span>
            {!isCompact && (
              <>
                <span className="text-xs text-muted-foreground">
                  {t("connections.local.kinds.search")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("connections.local.bundled")}
                </span>
              </>
            )}
            <span
              className={cn("text-xs text-foreground/85", isCompact && "col-span-2 order-last")}
            >
              {t("connections.local.noteSearch")}
            </span>
            <span />
          </div>
        </SettingsPanelRow>
      </SettingsPanel>

      <div className="space-y-2">
        <button
          type="button"
          aria-expanded={browseOpen}
          onClick={() => setBrowseOpen((open) => !open)}
          className="flex items-center gap-2 rounded-md px-1 py-1 text-xs font-medium text-foreground hover:text-foreground/80"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              !browseOpen && "-rotate-90 rtl:rotate-90"
            )}
          />
          {t("connections.local.browse", { count: available.length })}
        </button>
        {browseOpen &&
          groups.map((group) => (
            <div key={group.key} className="space-y-1">
              <p className="ps-1 text-[11px] font-medium text-muted-foreground">{group.label}</p>
              <SettingsPanel>
                {group.rows.map((row) => (
                  <SettingsPanelRow key={`${row.engine}:${row.id}`}>
                    <div className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                        {row.name}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">{row.size}</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => void downloadsFor(row.engine).downloadModel(row.id)}
                      >
                        <Download className="h-3 w-3" />
                        {t("common.download")}
                      </Button>
                    </div>
                  </SettingsPanelRow>
                ))}
              </SettingsPanel>
            </div>
          ))}
      </div>

      <SettingsPanel>
        <SettingsPanelRow data-setting-id="connections.keepLoaded">
          <SettingsRow
            label={t("reasoning.keepModelLoaded.label")}
            description={t("reasoning.keepModelLoaded.help")}
          >
            <Toggle
              checked={keepLoaded}
              onChange={setKeepLoaded}
              ariaLabel={t("reasoning.keepModelLoaded.label")}
            />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>
      <GpuDeviceSelector purpose="transcription" data-setting-id="connections.gpu.transcription" />
      <GpuDeviceSelector purpose="intelligence" data-setting-id="connections.gpu.intelligence" />

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />
    </div>
  );
}

// ── Enterprise ───────────────────────────────────────────────────────────────

const MANAGED_SCOPES: ReadonlyArray<{ feature: UsageFeature; scope: ManagedEnterpriseScope }> = [
  { feature: "recognition", scope: "transcription" },
  { feature: "cleanup", scope: "dictationCleanup" },
  { feature: "assistant", scope: "dictationAgent" },
  { feature: "translation", scope: "dictationTranslation" },
  { feature: "noteFormatting", scope: "noteFormatting" },
  { feature: "chat", scope: "chatIntelligence" },
];

function EnterpriseSection({ usages }: { usages: readonly FeatureUsage[] }) {
  const { t } = useTranslation();
  // Re-render when an administrator changes the managed setup.
  useEnterpriseIdentityStore((state) => state.config);
  useEnterpriseIdentityStore((state) => state.status);
  const setupMode = useSettingsStore((s) => s.enterpriseSetupMode);
  const transcriptionSetupMode = useSettingsStore((s) => s.enterpriseTranscriptionSetupMode);
  const resolutions = MANAGED_SCOPES.map(({ feature, scope }) => ({
    feature,
    resolution: getManagedScopeResolution(
      scope,
      scope === "transcription" ? transcriptionSetupMode : setupMode
    ),
  }));
  const managed = resolutions.filter(({ resolution }) => resolution.kind === "managed");
  const failed = resolutions.filter(({ resolution }) => resolution.kind === "error");
  const personal = enterpriseUsages(usages).filter(
    (usage) => usage.connection.type === "enterprise" && !usage.connection.managed
  );
  const personalProviders = [
    ...new Set(
      personal.map((usage) =>
        usage.connection.type === "enterprise" ? usage.connection.provider : ""
      )
    ),
  ].filter(Boolean);

  return (
    <div data-setting-id="connections.enterprise" className="space-y-3">
      <SectionHeader
        title={t("connections.sections.enterprise.title")}
        description={t("connections.sections.enterprise.description")}
      />
      {(managed.length > 0 || failed.length > 0) && (
        <div
          data-enterprise-managed=""
          className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.03] p-3.5"
        >
          <div className="flex items-start gap-2.5">
            <div className="rounded-md bg-primary/10 p-1.5 text-primary">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                {t("settingsPage.aiModels.managedEnterprise.title")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("connections.enterprise.managedDescription")}
              </p>
            </div>
            <StatusPill tone="managed">{t("connections.health.notChecked.managed")}</StatusPill>
          </div>
          <ul className="space-y-1.5 border-t border-border/70 pt-3">
            {[...managed, ...failed].map(({ feature, resolution }) => (
              <li key={feature} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-medium text-foreground">{featureTitle(t, feature)}</span>
                {resolution.kind === "managed" ? (
                  <span className="text-muted-foreground">
                    {enterpriseProviderName(resolution.provider)} ·{" "}
                    <span dir="ltr" className="font-mono">
                      {resolution.model}
                    </span>
                  </span>
                ) : resolution.kind === "error" ? (
                  <span className="text-destructive">
                    {resolution.messageKey ? t(resolution.messageKey) : resolution.message}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {personalProviders.map((provider) => (
        <ConnectionCard
          key={provider}
          icon={<ProviderIcon provider={provider} className="h-4 w-4" />}
          name={enterpriseProviderName(provider as "bedrock")}
          pill={<StatusPill tone="ok">{t("connections.enterprise.personal")}</StatusPill>}
          usages={personal.filter(
            (usage) =>
              usage.connection.type === "enterprise" && usage.connection.provider === provider
          )}
        />
      ))}
      {managed.length === 0 && failed.length === 0 && personalProviders.length === 0 && (
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {t("connections.enterprise.notSetUp")}
              </p>
              <SettingsLink destination="cleanup#dictation.cleanup.model">
                {t("connections.enterprise.setUp")}
              </SettingsLink>
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AiConnectionsPage({
  showing = true,
}: {
  /** The page is the one Settings shows (it stays mounted, hidden, once visited). */
  showing?: boolean;
}) {
  const policy = usePolicySnapshot();
  const cloudDisabled = useOpenWhisprCloudDisabled();
  const settingsVisible = useSettingsVisible();
  const settings = useSettingsStore((s) => s);
  const stylesInUse = useStyleStore((state) => selectableStyles(state.library).length > 0);
  // Managed enterprise routes resolve from this store (selectResolvedLLMConfig reads it).
  useEnterpriseIdentityStore((state) => state.config);
  useEnterpriseIdentityStore((state) => state.status);

  const usages = computeConnectionUsage({ settings, policy, cloudDisabled, stylesInUse });
  const customConnection = settings.customConnection;
  const connectionUses = featuresUsingConnection(usages, customConnection, settings);
  const copilotLoaded = useCopilotStore((state) => state.loaded);
  const copilotSignedIn = useCopilotStore(
    (state) => state.loaded && state.status.state === "signedIn"
  );
  const visiting = showing && settingsVisible;

  // ── Connection checks (connectionHealth.ts, helpers/connectionChecks.js) ──
  const plan = buildCheckPlan({
    settings,
    usages,
    policy,
    cloudDisabled,
    copilotSignedIn,
    connection: customConnection,
    connectionUses,
  });
  const results = useConnectionHealthStore((state) => state.results);
  const pending = useConnectionHealthStore((state) => state.pending);
  const epoch = useConnectionHealthStore((state) => state.epoch);
  const now = useHealthNow();
  const planRef = useRef<CheckPlan>(plan);
  planRef.current = plan;
  // Until secrets and Copilot's status have loaded, descriptors are built from placeholders.
  const ready = settings.secretsHydrated && copilotLoaded;
  const targetsKey = plan.targets
    .map((item) => `${item.descriptor.id}@${item.descriptor.generation}`)
    .join("|");

  const check = useCallback((owner: string) => {
    void runConnectionChecks(
      planRef.current.targets.filter((item) => item.owner === owner),
      { fresh: true, maxAgeMs: 0 }
    );
  }, []);
  const checkAll = useCallback(() => {
    void runConnectionChecks(planRef.current.targets, { fresh: true, maxAgeMs: 0 });
  }, []);

  // Automatic: whenever the page shows while Settings is visible (and when
  // what it lists changes meanwhile), every saved connection, reusing results
  // younger than ten minutes. Never in the background or at app start.
  useEffect(() => {
    subscribeConnectionChecks();
    if (!visiting || !ready) return;
    void runConnectionChecks(planRef.current.targets, {
      fresh: false,
      maxAgeMs: CONNECTION_CHECK_MAX_AGE_MS,
    });
  }, [visiting, ready, targetsKey, epoch]);

  // Right after a key is saved here: that connection, fresh.
  useEffect(() => {
    if (!visiting) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const unsubscribe = useSettingsStore.subscribe((state, previous) => {
      const changed = new Set<string>();
      for (const item of planRef.current.targets) {
        for (const field of item.secretFields) {
          const key = field as keyof typeof state;
          if (state[key] !== previous[key] && state[key]) changed.add(item.owner);
        }
      }
      for (const owner of changed) {
        clearTimeout(timers.get(owner));
        // After the store's debounced save; the run flushes it anyway.
        timers.set(
          owner,
          setTimeout(() => {
            timers.delete(owner);
            check(owner);
          }, 400)
        );
      }
    });
    return () => {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [visiting, check]);

  // Cloud's result is about the session it saw: a sign-in change or the
  // Cloud switch makes it stale (its check runs again while the page shows).
  const cloudSignedIn = !cloudDisabled && !!settings.isSignedIn;
  useEffect(() => {
    forgetConnectionResults(["cloud"]);
  }, [cloudSignedIn]);

  // The Settings menu's dot (active usages' own failures only) and the
  // model pickers' advisory line, until a newer result.
  const flag = connectionsFlag(plan, results);
  const pickerHealthKey = JSON.stringify(pickerHealthMap(plan, results));
  useEffect(() => {
    publishConnectionHealth({ flag, pickerHealth: JSON.parse(pickerHealthKey) });
  }, [flag, pickerHealthKey]);

  const healthContext: ConnectionHealthContextValue = {
    plan,
    results,
    pending,
    now,
    check,
    checkAll,
  };

  return (
    <ConnectionHealthContext.Provider value={healthContext}>
      <div className="space-y-8">
        <ConnectionsSection
          usages={usages}
          policy={policy}
          cloudDisabled={cloudDisabled}
          connection={customConnection}
          connectionUses={connectionUses}
          visiting={visiting}
        />
        <EndpointsSection
          usages={usages}
          policy={policy}
          customConnection={customConnection}
          connectionUses={connectionUses}
        />
        <LocalModelsSection usages={usages} />
        <EnterpriseSection usages={usages} />
      </div>
    </ConnectionHealthContext.Provider>
  );
}
