import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { useCopilotStore } from "../../stores/copilotStore";
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
import {
  CONNECTION_PROVIDERS,
  findConnectionProvider,
  hasSavedCredential,
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
import { CustomConnectionGroup, SaveAsConnection } from "./CustomConnectionCard";

/**
 * Settings › AI Connections & Local Models: every shared credential and
 * sign-in, the custom connection (CustomConnectionCard.tsx), the per-feature
 * custom and self-hosted endpoints, downloaded models, and the enterprise
 * setup, each with where it's used right now (connectionUsage.ts). The
 * language-model pickers on feature pages take no keys and link here instead;
 * speech-to-text pickers keep their key fields, which edit the same store
 * fields through the same setters as this page. Keys only ever show masked,
 * and replacing one never reveals the old one.
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
function UsageChip({ usage }: { usage: FeatureUsage }) {
  const { t } = useTranslation();
  const openSettings = useOpenSettingsLink();
  const title = featureTitle(t, usage.feature);
  const note = usageNote(t, usage);
  const className = cn(
    "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4",
    usage.kind === "off"
      ? "border-dashed border-border/60 text-muted-foreground/70"
      : "border-border/70 bg-muted/40 text-foreground/85 dark:border-white/10 dark:bg-surface-1"
  );
  const content = (
    <>
      <span className="truncate">{title}</span>
      {note && <span className="truncate text-muted-foreground/80">· {note}</span>}
    </>
  );
  const data = { "data-usage-feature": usage.feature, "data-usage-kind": usage.kind };
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

function UsedBy({ usages }: { usages: readonly FeatureUsage[] }) {
  const { t } = useTranslation();
  if (usages.length === 0) {
    return <p className="text-xs text-muted-foreground/70">{t("connections.usedBy.none")}</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" data-connection-used-by="">
      <span className="text-muted-foreground">{t("connections.usedBy.label")}</span>
      {usages.map((usage) => (
        <UsageChip key={usage.feature} usage={usage} />
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
  footer,
  children,
}: {
  /** Search anchor; a card that isn't a search target has none. */
  settingId?: string;
  icon: ReactNode;
  name: string;
  pill?: ReactNode;
  usages: readonly FeatureUsage[];
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-setting-id={settingId || undefined}
      data-connection-card=""
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border/70 bg-card/50 p-3.5 dark:border-border-subtle/70 dark:bg-surface-2/50"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background dark:border-white/10 dark:bg-surface-1">
          {icon}
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</p>
        {pill}
      </div>
      {children}
      <UsedBy usages={usages} />
      {footer && <div className="flex flex-wrap items-center gap-3">{footer}</div>}
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────

interface RemoveRequest {
  provider: ConnectionProviderDef;
  credential: ConnectionCredential;
  clear: () => void;
}

function ProviderKeyCard({
  provider: providerId,
  usages,
  policy,
  onRemove,
  "data-setting-id": settingId,
}: {
  provider: ConnectionProviderId;
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
  onRemove: (request: RemoveRequest) => void;
  "data-setting-id": string;
}) {
  const { t } = useTranslation();
  const provider = findConnectionProvider(providerId) as ConnectionProviderDef;
  const values = useSettingsStore(
    useShallow((s) => provider.credentials.map((credential) => s[credential.key] ?? ""))
  );
  const setters = useSettingsStore(
    useShallow((s) => provider.credentials.map((credential) => s[credential.setter]))
  );
  const allowed = providerAllowed(policy, provider);
  const saved = values.some((value) => !!value.trim());

  return (
    <ConnectionCard
      settingId={settingId}
      icon={<ProviderIcon provider={provider.id} className="h-4 w-4" />}
      name={provider.name}
      pill={
        !allowed ? (
          <StatusPill tone="managed">{t("common.managedByOrg")}</StatusPill>
        ) : saved ? (
          <StatusPill tone="ok">{t("connections.status.keySaved")}</StatusPill>
        ) : (
          <StatusPill tone="muted">{t("connections.status.notConnected")}</StatusPill>
        )
      }
      usages={usagesOfProvider(usages, provider.id)}
      footer={allowed ? <GetApiKeyLink url={provider.keyUrl} /> : undefined}
    >
      <div className="space-y-2">
        {provider.credentials.map((credential, index) => {
          const value = values[index];
          const label = credential.labelKey ? t(credential.labelKey) : undefined;
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
                  />
                  {value && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        onRemove({ provider, credential, clear: () => setters[index]("") })
                      }
                    >
                      {t("connections.actions.remove")}
                    </Button>
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
      </div>
    </ConnectionCard>
  );
}

function CopilotCard({
  usages,
  policy,
  "data-setting-id": settingId,
}: {
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
  "data-setting-id": string;
}) {
  const { t } = useTranslation();
  const status = useCopilotStore((state) => state.status);
  const loaded = useCopilotStore((state) => state.loaded);
  const allowed =
    isModeAllowedByPolicy(policy, "llm", "providers") &&
    isProviderAllowedByPolicy(policy, "llm", COPILOT_PROVIDER_ID);

  let pill: ReactNode = null;
  if (!allowed) pill = <StatusPill tone="managed">{t("common.managedByOrg")}</StatusPill>;
  else if (loaded && status.state === "signedIn") {
    pill = (
      <StatusPill tone="ok">
        {status.login
          ? t("connections.status.signedInAs", { login: status.login })
          : t("connections.status.signedIn")}
      </StatusPill>
    );
  } else if (loaded && (status.state === "waiting" || status.state === "checking")) {
    pill = <StatusPill tone="busy">{t("connections.status.signingIn")}</StatusPill>;
  } else if (loaded) {
    pill = <StatusPill tone="muted">{t("connections.status.notConnected")}</StatusPill>;
  }

  return (
    <ConnectionCard
      settingId={settingId}
      icon={<ProviderIcon provider={COPILOT_PROVIDER_ID} className="h-4 w-4" />}
      name={t("connections.names.copilot")}
      pill={pill}
      usages={usagesOfProvider(usages, COPILOT_PROVIDER_ID)}
    >
      {allowed ? (
        <CopilotSignIn />
      ) : (
        <p className="text-xs text-muted-foreground">{t("connections.copilot.managed")}</p>
      )}
    </ConnectionCard>
  );
}

function CloudCard({
  usages,
  policy,
  cloudDisabled,
  "data-setting-id": settingId,
}: {
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
  cloudDisabled: boolean;
  "data-setting-id": string;
}) {
  const { t } = useTranslation();
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const allowed =
    isModeAllowedByPolicy(policy, "llm", "openwhispr") ||
    isModeAllowedByPolicy(policy, "transcription", "openwhispr");

  let pill: ReactNode;
  let body: ReactNode;
  if (cloudDisabled) {
    // Off: nothing here offers a sign-in; the switch lives in Privacy & Data.
    pill = <StatusPill tone="muted">{t("connections.status.off")}</StatusPill>;
    body = (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">{t("connections.cloud.off")}</p>
        <SettingsLink destination="privacyData#privacy.cloud">
          {t("connections.cloud.openPrivacy")}
        </SettingsLink>
      </div>
    );
  } else if (!allowed) {
    pill = <StatusPill tone="managed">{t("common.managedByOrg")}</StatusPill>;
    body = <p className="text-xs text-muted-foreground">{t("connections.cloud.managed")}</p>;
  } else if (isSignedIn) {
    pill = <StatusPill tone="ok">{t("connections.status.signedIn")}</StatusPill>;
    body = <p className="text-xs text-muted-foreground">{t("connections.cloud.automatic")}</p>;
  } else {
    pill = <StatusPill tone="muted">{t("connections.status.notSignedIn")}</StatusPill>;
    body = (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">{t("connections.cloud.signedOut")}</p>
        <SettingsLink destination="account#account.signIn">
          {t("connections.cloud.signIn")}
        </SettingsLink>
      </div>
    );
  }

  return (
    <ConnectionCard
      settingId={settingId}
      icon={<Cloud className="h-4 w-4 text-foreground/80" />}
      name={t("connections.names.cloud")}
      pill={pill}
      usages={usagesOfProvider(usages, "cloud")}
    >
      {body}
    </ConnectionCard>
  );
}

// ── Connections ──────────────────────────────────────────────────────────────

function ConnectionsSection({
  usages,
  policy,
  cloudDisabled,
  connection,
  connectionUses,
}: {
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
  cloudDisabled: boolean;
  connection: CustomConnection | null;
  connectionUses: readonly ConnectionUse[];
}) {
  const { t } = useTranslation();
  const { isCompact } = useSettingsLayout();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const secrets = useSettingsStore(
    useShallow((s) => CONNECTION_PROVIDERS.map((provider) => hasSavedCredential(provider, s)))
  );
  const [moreOpen, setMoreOpen] = useState(false);

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

  // A less common provider moves up front once it has a key or a use, and
  // stays there for the visit, so removing its key doesn't hide the card.
  const inUseNow = CONNECTION_PROVIDERS.filter(
    (provider, index) =>
      !provider.common && (!!secrets[index] || usagesOfProvider(usages, provider.id).length > 0)
  ).map((provider) => provider.id);
  const inUseKey = inUseNow.join(",");
  const [sticky, setSticky] = useState<ReadonlySet<string>>(() => new Set(inUseNow));
  useEffect(() => {
    if (!inUseKey) return;
    setSticky((previous) => {
      const ids = inUseKey.split(",");
      return ids.every((id) => previous.has(id)) ? previous : new Set([...previous, ...ids]);
    });
  }, [inUseKey]);

  const shared = { usages, policy, onRemove: requestRemove };
  // Literal anchors: each card is a search target and a "Manage keys" destination.
  const cards: Record<ConnectionProviderId, ReactNode> = {
    openai: <ProviderKeyCard {...shared} provider="openai" data-setting-id="connections.openai" />,
    anthropic: (
      <ProviderKeyCard {...shared} provider="anthropic" data-setting-id="connections.anthropic" />
    ),
    gemini: <ProviderKeyCard {...shared} provider="gemini" data-setting-id="connections.gemini" />,
    groq: <ProviderKeyCard {...shared} provider="groq" data-setting-id="connections.groq" />,
    openrouter: (
      <ProviderKeyCard {...shared} provider="openrouter" data-setting-id="connections.openrouter" />
    ),
    mistral: (
      <ProviderKeyCard {...shared} provider="mistral" data-setting-id="connections.mistral" />
    ),
    tinfoil: (
      <ProviderKeyCard {...shared} provider="tinfoil" data-setting-id="connections.tinfoil" />
    ),
    corti: <ProviderKeyCard {...shared} provider="corti" data-setting-id="connections.corti" />,
    xai: <ProviderKeyCard {...shared} provider="xai" data-setting-id="connections.xai" />,
    deepgram: (
      <ProviderKeyCard {...shared} provider="deepgram" data-setting-id="connections.deepgram" />
    ),
    assemblyai: (
      <ProviderKeyCard {...shared} provider="assemblyai" data-setting-id="connections.assemblyai" />
    ),
  };
  const upFront = CONNECTION_PROVIDERS.filter(
    (provider) => provider.common || sticky.has(provider.id) || inUseNow.includes(provider.id)
  );
  const more = CONNECTION_PROVIDERS.filter((provider) => !upFront.includes(provider));
  const grid = cn("grid gap-3", !isCompact && "grid-cols-2");

  return (
    <div data-setting-id="connections.providers" className="space-y-3">
      <SectionHeader
        title={t("connections.sections.providers.title")}
        description={t("connections.sections.providers.description")}
      />
      <div className={grid}>
        <CopilotCard usages={usages} policy={policy} data-setting-id="connections.copilot" />
        {upFront.map((provider) => (
          <div key={provider.id} className="contents">
            {cards[provider.id]}
          </div>
        ))}
        <CloudCard
          usages={usages}
          policy={policy}
          cloudDisabled={cloudDisabled}
          data-setting-id="connections.cloud"
        />
      </div>
      {more.length > 0 && (
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
            <span className="font-medium text-foreground">
              {t("connections.more.title", { count: more.length })}
            </span>
            {!moreOpen && (
              <span className="min-w-0 truncate">
                {more.map((provider) => provider.name).join(" · ")}
              </span>
            )}
          </button>
          {moreOpen && (
            <div className={grid}>
              {more.map((provider) => (
                <div key={provider.id} className="contents">
                  {cards[provider.id]}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <CustomConnectionGroup
        connection={connection}
        uses={connectionUses}
        usages={usages}
        policy={policy}
      />
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
          {endpoints.map((usage) => {
            const connection = usage.connection;
            if (connection.type !== "custom" && connection.type !== "selfHosted") return null;
            const title = featureTitle(t, usage.feature);
            const note = usageNote(t, usage);
            const custom = connection.type === "custom";
            return (
              <SettingsPanelRow key={usage.feature}>
                <div
                  data-endpoint-feature={usage.feature}
                  data-endpoint-type={connection.type}
                  className={cn(
                    "flex flex-wrap items-start gap-3",
                    usage.kind === "off" && "opacity-70"
                  )}
                >
                  <div className="mt-0.5 shrink-0 text-muted-foreground">
                    {custom ? <Wrench className="h-4 w-4" /> : <Network className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-xs font-medium text-foreground">
                      {title}
                      <span className="font-normal text-muted-foreground">
                        {" · "}
                        {t(
                          custom
                            ? "connections.endpoints.custom"
                            : "connections.endpoints.selfHosted"
                        )}
                      </span>
                      {note && (
                        <span className="font-normal text-muted-foreground/80"> · {note}</span>
                      )}
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
                  <SettingsLink destination={usage.edit} className="shrink-0">
                    {t("connections.endpoints.editIn", { feature: title })}
                  </SettingsLink>
                </div>
              </SettingsPanelRow>
            );
          })}
        </SettingsPanel>
      )}
    </div>
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
            <StatusPill tone="managed">{t("common.managedByOrg")}</StatusPill>
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

export default function AiConnectionsPage() {
  const policy = usePolicySnapshot();
  const cloudDisabled = useOpenWhisprCloudDisabled();
  const settings = useSettingsStore((s) => s);
  const stylesInUse = useStyleStore((state) => selectableStyles(state.library).length > 0);
  // Managed enterprise routes resolve from this store (selectResolvedLLMConfig reads it).
  useEnterpriseIdentityStore((state) => state.config);
  useEnterpriseIdentityStore((state) => state.status);

  const usages = computeConnectionUsage({ settings, policy, cloudDisabled, stylesInUse });
  const customConnection = settings.customConnection;
  const connectionUses = featuresUsingConnection(usages, customConnection, settings);

  return (
    <div className="space-y-8">
      <ConnectionsSection
        usages={usages}
        policy={policy}
        cloudDisabled={cloudDisabled}
        connection={customConnection}
        connectionUses={connectionUses}
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
  );
}
