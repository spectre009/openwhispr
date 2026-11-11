import { useCallback, useMemo, useRef, useState } from "react";
import { useRegistryVersion } from "../../hooks/useRegistryVersion";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { ShieldCheck, AlertTriangle } from "../icons";
import {
  LLM_ENTERPRISE_POLICY_PROVIDER_IDS,
  llmPolicyProviderIds,
  useSettingsStore,
  selectPolicyEffectiveSettings,
  selectResolvedLLMConfig,
  setResolvedLLMConfig,
  type ResolvedLLMConfig,
} from "../../stores/settingsStore";
import { usePolicyModeOptions, usePolicySnapshot } from "../../hooks/usePolicy";
import { GpuStatusBadge } from "../ReasoningModelSelector";
import EnterpriseSection from "../EnterpriseSection";
import OpenAICompatiblePanel from "../OpenAICompatiblePanel";
import { Toggle } from "../ui/toggle";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { useSettingsLayout } from "../ui/useSettingsLayout";
import { cn } from "../lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import type { InferenceMode } from "../../types/electron";
import {
  INFERENCE_SCOPES,
  type InferenceScope,
  type InferenceScopeDefinition,
} from "../../config/inferenceScopes";
import { getCloudModel, getLocalModel, enterpriseProviderName } from "../../models/ModelRegistry";
import { AUTO_REASONING_EFFORT, isReasoningEffortSupported } from "../../models/reasoningEffort";
import { selectableReasoningEffort } from "../../services/ai/chatRequestBody";
import { useManagedScopeResolution } from "../../stores/enterpriseIdentityStore";
import { requestSignIn } from "../../utils/requestSignIn";
import TestConnectionButton from "../TestConnectionButton";
import { getEnterpriseCallSettings } from "../../services/ai/enterpriseSettings";
import { Button } from "../ui/button";
import { API_ENDPOINTS } from "../../config/constants";
import { COPILOT_PROVIDER_ID } from "../../config/copilot";
import { useOpenSettingsLink } from "./settingsLink";
import ManageKeysLink, { SettingsLink } from "./ManageKeysLink";
import { connectionDestination } from "./connectionProviders";
import { SETTINGS_PAGES } from "./settingsPages";
import ModelPicker from "./modelPicker/ModelPicker";
import ConnectionModelField from "./modelPicker/ConnectionModelField";
import { CONNECTION_GROUP_ID } from "./modelPicker/connectionOptions";
import { useConnectionHealthStore } from "../../stores/connectionHealthStore";
import {
  buildModelPickerOptions,
  describePickerSelection,
  llmOptionAdvice,
  noteFormattingFields,
  selectedOptionId,
  type ModelPickerOption,
  type NoteFormattingFieldState,
  type PickerLink,
  type PickerText,
} from "./modelPicker/options";
import { useLlmPickerContext } from "./modelPicker/useLlmPickerContext";
import { useLlmConnectionSelection, useLlmSelection } from "./modelPicker/selectLlm";

const LLM_MODES: readonly InferenceMode[] = [
  "openwhispr",
  "providers",
  "local",
  "self-hosted",
  "enterprise",
];

/** Each scope's feature name, for "inherited from …" and the browse hints. */
const SCOPE_TITLE_KEYS: Record<InferenceScope, string> = {
  dictationCleanup: SETTINGS_PAGES.cleanup.titleKey,
  dictationAgent: SETTINGS_PAGES.assistant.titleKey,
  dictationAgentVision: "connections.features.assistantVision",
  dictationTranslation: SETTINGS_PAGES.translation.titleKey,
  noteFormatting: SETTINGS_PAGES.noteFormatting.titleKey,
  chatIntelligence: SETTINGS_PAGES.chat.titleKey,
};

// Radix Select can't hold an empty value, so Auto ("") gets a sentinel.
const AUTO_REASONING_EFFORT_VALUE = "__auto__";

interface InferenceConfigEditorProps {
  scope: InferenceScope;
  onModeChange?: (mode: InferenceMode) => void;
  /** Restrict the selectable modes (e.g. vision override offers cloud/BYOK only). */
  allowedModes?: InferenceMode[];
  /**
   * Settings search anchor of the editor; its thinking and keep-loaded rows
   * take `<id>.thinking` and `<id>.keepLoaded`.
   */
  "data-setting-id"?: string;
}

export default function InferenceConfigEditor({
  scope,
  onModeChange,
  allowedModes,
  "data-setting-id": settingId,
}: InferenceConfigEditorProps) {
  useRegistryVersion();
  const { t } = useTranslation();
  const policyState = usePolicySnapshot();
  const definition: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  const config = useSettingsStore(
    useShallow((settings): ResolvedLLMConfig => {
      const effective = selectPolicyEffectiveSettings(settings, policyState);
      const resolved = selectResolvedLLMConfig(effective, scope);
      // Inherited runtime defaults are not an explicit selection in an optional picker.
      return definition.optional
        ? { ...resolved, model: effective[definition.storeKeys.model] as string }
        : resolved;
    })
  );
  const enterpriseSetupMode = useSettingsStore((s) => s.enterpriseSetupMode);
  const setEnterpriseSetupMode = useSettingsStore((s) => s.setEnterpriseSetupMode);
  const managed = useManagedScopeResolution(scope, enterpriseSetupMode);
  const managedAvailable = useManagedScopeResolution(scope, "managed");

  if (managed.kind === "error") {
    return (
      <div
        data-setting-id={settingId}
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
        role="alert"
      >
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

  if (managed.kind === "managed") {
    return (
      <div
        data-setting-id={settingId}
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
              <span className="font-mono">{managed.model}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settingsPage.aiModels.managedEnterprise.description")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
          <TestConnectionButton
            provider={managed.provider}
            getConfig={() => ({
              ...getEnterpriseCallSettings(managed.provider, scope),
              model: managed.model,
            })}
          />
          {managed.mode !== "managed_required" && managed.allowManualSetup && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEnterpriseSetupMode("manual")}
            >
              {t("settingsPage.aiModels.managedEnterprise.usePersonalSetup")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-setting-id={settingId} className="space-y-3">
      {enterpriseSetupMode === "manual" && managedAvailable.kind === "managed" && (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {t("settingsPage.aiModels.managedEnterprise.availableTitle")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.aiModels.managedEnterprise.availableDescription", {
                provider: enterpriseProviderName(managedAvailable.provider),
              })}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setEnterpriseSetupMode("managed")}
          >
            {t("settingsPage.aiModels.managedEnterprise.useManaged")}
          </Button>
        </div>
      )}
      <LlmModelSettings
        scope={scope}
        config={config}
        allowedModes={allowedModes}
        onModeChange={onModeChange}
        settingId={settingId}
      />
    </div>
  );
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function text(t: Translate, value: PickerText): string {
  return "text" in value ? value.text : t(value.key, value.params);
}

/** Fields under the picker that a pick opens without committing yet. */
type BrowsePanel = "custom" | "openrouter" | "connection";

/**
 * The model picker and what sits under it: the fields the selected
 * connection needs (custom endpoint, self-hosted server, enterprise, the
 * OpenRouter catalog, a name to pick on the custom connection), then "Disable
 * thinking" and "Keep model loaded" with
 * their usual visibility. Every pick goes through the selection adapter.
 */
function LlmModelSettings({
  scope,
  config,
  allowedModes,
  onModeChange,
  settingId,
}: {
  scope: InferenceScope;
  config: ResolvedLLMConfig;
  allowedModes?: InferenceMode[];
  onModeChange?: (mode: InferenceMode) => void;
  settingId?: string;
}) {
  const { t } = useTranslation();
  const { isCompact } = useSettingsLayout();
  const keepLocalModelLoaded = useSettingsStore((s) => s.keepLocalModelLoaded);
  const setKeepLocalModelLoaded = useSettingsStore((s) => s.setKeepLocalModelLoaded);
  const openrouterApiKey = useSettingsStore((s) => s.openrouterApiKey);
  const policyState = usePolicySnapshot();
  // Note formatting's own values, to tell which fields it borrows from Cleanup.
  const noteFormattingOwn = useSettingsStore(
    useShallow((settings) => {
      if (scope !== "noteFormatting") return null;
      const effective = selectPolicyEffectiveSettings(settings, policyState);
      return {
        noteFormattingMode: effective.noteFormattingMode,
        noteFormattingProvider: effective.noteFormattingProvider,
        noteFormattingModel: effective.noteFormattingModel,
        noteFormattingCloudBaseUrl: effective.noteFormattingCloudBaseUrl,
        noteFormattingRemoteUrl: effective.noteFormattingRemoteUrl,
      };
    })
  );
  const inheritedFields = useMemo<NoteFormattingFieldState[] | null>(
    () => (noteFormattingOwn ? noteFormattingFields(noteFormattingOwn, config) : null),
    [noteFormattingOwn, config]
  );

  // The mode the editor shows, reconciled as the mode cards were (Cloud needs a sign-in).
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const modeOptions = useMemo(
    () =>
      LLM_MODES.filter((mode) => !allowedModes || allowedModes.includes(mode)).map((id) => ({
        id,
        disabled: id === "openwhispr" && !isSignedIn,
      })),
    [allowedModes, isSignedIn]
  );
  const { effectiveMode } = usePolicyModeOptions(modeOptions, "llm", config.mode, {
    byokProviders: llmPolicyProviderIds(scope),
    enterpriseProviders: LLM_ENTERPRISE_POLICY_PROVIDER_IDS,
  });

  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState<BrowsePanel | null>(null);
  const pickerBoxRef = useRef<HTMLDivElement>(null);
  const current = useMemo(
    () => ({
      mode: effectiveMode,
      provider: config.provider,
      model: config.model,
      cloudBaseUrl: config.cloudBaseUrl,
      remoteUrl: config.remoteUrl,
    }),
    [effectiveMode, config.provider, config.model, config.cloudBaseUrl, config.remoteUrl]
  );
  const picker = useLlmPickerContext(scope, { allowedModes, current, open });
  const groups = useMemo(
    () => buildModelPickerOptions(scope, picker.context),
    [scope, picker.context]
  );
  const summary = useMemo(
    () => describePickerSelection(scope, picker.context),
    [scope, picker.context]
  );
  // AI Connections' last checks, beside the options they're about (advisory only).
  const pickerHealth = useConnectionHealthStore((state) => state.pickerHealth);
  const connectionName = picker.context.connection?.name ?? "";
  const optionAdvice = useCallback(
    (option: ModelPickerOption) => llmOptionAdvice(option, pickerHealth, connectionName),
    [pickerHealth, connectionName]
  );
  const commit = useLlmSelection(scope, {
    readContext: picker.readContext,
    managedAvailable: picker.managedAvailable,
    onModeChange,
  });
  const commitConnection = useLlmConnectionSelection(scope, {
    readContext: picker.readContext,
    managedAvailable: picker.managedAvailable,
    onModeChange,
  });
  const [connectionBusy, setConnectionBusy] = useState(false);
  const openSettings = useOpenSettingsLink();

  const focusPicker = () =>
    pickerBoxRef.current?.querySelector<HTMLElement>("[data-model-picker-trigger]")?.focus();

  // A model on the custom connection: main copies its key first, so this is awaited.
  const pickConnectionModel = async (model: string, fromField = false) => {
    if (connectionBusy) return;
    setConnectionBusy(true);
    try {
      const result = await commitConnection(model);
      if (result.status !== "committed") return;
      setBrowse(null);
      if (fromField) focusPicker();
    } finally {
      setConnectionBusy(false);
    }
  };

  const handleSelect = (option: ModelPickerOption) => {
    if (option.action === "configureCustom") {
      setBrowse("custom");
      return;
    }
    if (option.action === "searchOpenRouter") {
      setBrowse("openrouter");
      return;
    }
    if (option.action === "enterConnectionModel") {
      setBrowse("connection");
      return;
    }
    if (option.action === "useConnection") {
      void pickConnectionModel(option.model);
      return;
    }
    const result = commit(option);
    if (result.status !== "refused") setBrowse(null);
  };

  const commitModel = useCallback(
    (provider: "custom" | "openrouter") => (model: string) => {
      if (!model) return;
      const result = commit({ mode: "providers", provider, model });
      if (result.status === "committed") setBrowse(null);
    },
    [commit]
  );

  const followLink = (link: PickerLink) => {
    if (link.kind === "signIn") requestSignIn();
    else openSettings?.(link.destination);
  };

  const setField = useCallback(
    <K extends keyof Omit<ResolvedLLMConfig, "scope">>(field: K) =>
      (value: NonNullable<ResolvedLLMConfig[K]>) => {
        setResolvedLLMConfig(scope, { [field]: value });
      },
    [scope]
  );

  const showThinkingToggle =
    effectiveMode === "self-hosted" ||
    (effectiveMode === "providers" &&
      (config.provider === "custom" ||
        config.provider === "openrouter" ||
        !!getCloudModel(config.model, config.provider)?.supportsThinking)) ||
    (effectiveMode === "local" && !!getLocalModel(config.model)?.supportsThinking);

  // The reasoning effort this provider and model let the user pick for the scope (#2694).
  const effortCapability =
    effectiveMode === "providers"
      ? selectableReasoningEffort(config.provider, config.model, config, config.cloudBaseUrl)
      : null;

  const customCommitted = effectiveMode === "providers" && config.provider === "custom";
  // The connection's name field closes by itself if the connection goes away.
  const browsing = browse === "connection" && !picker.context.connection ? null : browse;
  const fields: BrowsePanel | "selfHosted" | "enterprise" | null =
    browsing ??
    (customCommitted
      ? "custom"
      : effectiveMode === "self-hosted"
        ? "selfHosted"
        : effectiveMode === "enterprise"
          ? "enterprise"
          : null);
  const scopeTitle = t(SCOPE_TITLE_KEYS[scope]);

  const groupNotes = {
    copilot: picker.copilotModels.loading ? (
      <p className="text-[11px] text-muted-foreground">{t("reasoning.copilot.refreshingModels")}</p>
    ) : picker.copilotModels.error ? (
      <p className="flex items-center gap-1 text-[11px] text-destructive">
        {t("reasoning.copilot.modelsFailed")}
        <button
          type="button"
          tabIndex={-1}
          onClick={() => void picker.copilotModels.retry()}
          className="text-link underline decoration-link/30"
        >
          {t("reasoning.copilot.retry")}
        </button>
      </p>
    ) : null,
    "provider:tinfoil": picker.tinfoilModels.loading ? (
      <p className="text-[11px] text-muted-foreground">{t("reasoning.tinfoil.refreshingModels")}</p>
    ) : picker.tinfoilModels.error ? (
      <p className="text-[11px] text-destructive">{t("reasoning.custom.unableToLoadModels")}</p>
    ) : null,
    [CONNECTION_GROUP_ID]:
      picker.context.connection?.catalog?.status === "loading" ? (
        <p className="text-[11px] text-muted-foreground">{t("reasoning.custom.fetchingModels")}</p>
      ) : picker.context.connection?.catalog?.status === "error" ? (
        <p className="text-[11px] text-destructive">{t("reasoning.custom.unableToLoadModels")}</p>
      ) : null,
  };

  const closeConnectionField = () => {
    setBrowse(null);
    focusPicker();
  };

  const pickerElement = (
    <ModelPicker
      groups={groups}
      selectedId={selectedOptionId(current, picker.context.connection)}
      summary={summary}
      onSelect={handleSelect}
      onLink={followLink}
      canFollow={(link) => link.kind === "signIn" || !!openSettings}
      releasesFocus={(option) => option.action === "enterConnectionModel"}
      groupNotes={groupNotes}
      advice={optionAdvice}
      label={t("modelPicker.label")}
      open={open}
      onOpenChange={setOpen}
      renderAnchor={
        inheritedFields
          ? (openMenu) => (
              <InheritedFields
                fields={inheritedFields}
                from={t(SCOPE_TITLE_KEYS.dictationCleanup)}
                onOverride={openMenu}
              />
            )
          : undefined
      }
    />
  );

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        {inheritedFields ? (
          <div ref={pickerBoxRef} className="space-y-2">
            <PickerHeading />
            {pickerElement}
          </div>
        ) : (
          <div
            className={cn(
              "flex",
              isCompact ? "flex-col items-stretch gap-2" : "items-center justify-between gap-4"
            )}
          >
            <PickerHeading />
            <div
              ref={pickerBoxRef}
              className={isCompact ? "w-full" : "w-[22rem] max-w-[55%] shrink-0"}
            >
              {pickerElement}
            </div>
          </div>
        )}
        <SelectionLinks provider={effectiveMode === "providers" ? config.provider : ""} />
        {effectiveMode === "local" && <GpuStatusBadge />}
      </SettingsPanelRow>

      {fields === "connection" && picker.context.connection && (
        <SettingsPanelRow>
          <ConnectionModelField
            connection={picker.context.connection}
            feature={scopeTitle}
            busy={connectionBusy}
            onSubmit={(model) => void pickConnectionModel(model, true)}
            onCancel={closeConnectionField}
          />
        </SettingsPanelRow>
      )}

      {fields === "custom" && (
        <SettingsPanelRow>
          {!customCommitted && (
            <BrowseHint
              text={t("modelPicker.custom.browseHint", { feature: scopeTitle })}
              onCancel={() => setBrowse(null)}
            />
          )}
          <OpenAICompatiblePanel
            key="custom"
            baseUrl={config.cloudBaseUrl ?? ""}
            setBaseUrl={setField("cloudBaseUrl")}
            apiKey={config.customApiKey ?? ""}
            setApiKey={setField("customApiKey")}
            model={customCommitted ? config.model : ""}
            setModel={commitModel("custom")}
            defaultBaseUrl={API_ENDPOINTS.OPENAI_BASE}
            replaceApiKey
          />
        </SettingsPanelRow>
      )}

      {fields === "openrouter" && (
        <SettingsPanelRow>
          <BrowseHint
            text={t("modelPicker.openrouter.browseHint", { feature: scopeTitle })}
            onCancel={() => setBrowse(null)}
            cancelLabel={t("modelPicker.openrouter.close")}
          />
          <OpenAICompatiblePanel
            key="openrouter"
            baseUrl={API_ENDPOINTS.OPENROUTER_BASE}
            setBaseUrl={() => {}}
            apiKey={openrouterApiKey}
            setApiKey={() => {}}
            model={
              effectiveMode === "providers" && config.provider === "openrouter" ? config.model : ""
            }
            setModel={commitModel("openrouter")}
            provider="openrouter"
            lockedBaseUrl
            hideApiKey
            modelNeeds={(INFERENCE_SCOPES[scope] as InferenceScopeDefinition).modelNeeds}
          />
        </SettingsPanelRow>
      )}

      {fields === "selfHosted" && (
        <SettingsPanelRow>
          <OpenAICompatiblePanel
            baseUrl={config.remoteUrl ?? ""}
            setBaseUrl={setField("remoteUrl")}
            apiKey={config.customApiKey ?? ""}
            setApiKey={setField("customApiKey")}
            model={config.model}
            setModel={setField("model")}
            baseUrlPlaceholder="http://192.168.1.126:11434/v1"
            helpExamples={
              <p className="text-xs text-muted-foreground">
                {t("reasoning.selfHosted.endpointHelp")}
              </p>
            }
            replaceApiKey
          />
        </SettingsPanelRow>
      )}

      {fields === "enterprise" && (
        <SettingsPanelRow>
          <EnterpriseSection
            currentProvider={config.provider}
            reasoningModel={config.model}
            setReasoningModel={setField("model")}
            setLocalReasoningProvider={setField("provider")}
          />
        </SettingsPanelRow>
      )}

      {showThinkingToggle && (
        <SettingsPanelRow data-setting-id={settingId && `${settingId}.thinking`}>
          <SettingsRow
            label={t("reasoning.disableThinking.label")}
            description={t("reasoning.disableThinking.help")}
          >
            <Toggle checked={config.disableThinking} onChange={setField("disableThinking")} />
          </SettingsRow>
        </SettingsPanelRow>
      )}

      {effortCapability && (
        <SettingsPanelRow data-setting-id={settingId && `${settingId}.reasoningEffort`}>
          <SettingsRow
            label={t("reasoning.effort.title")}
            description={
              effortCapability.defaultValue
                ? t("reasoning.effort.descriptionWithDefault", {
                    value: t(`reasoning.effort.options.${effortCapability.defaultValue}`),
                  })
                : t("reasoning.effort.description")
            }
          >
            <Select
              value={
                isReasoningEffortSupported(effortCapability, config.reasoningEffort)
                  ? config.reasoningEffort
                  : AUTO_REASONING_EFFORT_VALUE
              }
              onValueChange={(value) =>
                setField("reasoningEffort")(
                  value === AUTO_REASONING_EFFORT_VALUE ? AUTO_REASONING_EFFORT : value
                )
              }
            >
              <SelectTrigger
                aria-label={t("reasoning.effort.title")}
                className="h-7 w-44 shrink-0 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value={AUTO_REASONING_EFFORT_VALUE}
                  className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                >
                  {t("reasoning.effort.auto")}
                </SelectItem>
                {effortCapability.options.map((effort) => (
                  <SelectItem
                    key={effort}
                    value={effort}
                    className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                  >
                    {t(`reasoning.effort.options.${effort}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsPanelRow>
      )}

      {effectiveMode === "local" && (
        <SettingsPanelRow data-setting-id={settingId && `${settingId}.keepLoaded`}>
          <SettingsRow
            label={t("reasoning.keepModelLoaded.label")}
            description={t("reasoning.keepModelLoaded.help")}
          >
            <Toggle checked={keepLocalModelLoaded} onChange={setKeepLocalModelLoaded} />
          </SettingsRow>
        </SettingsPanelRow>
      )}
    </SettingsPanel>
  );
}

function PickerHeading() {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs font-medium text-foreground">{t("modelPicker.label")}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
        {t("modelPicker.description")}
      </p>
    </div>
  );
}

/** Where the selected connection's key or sign-in is managed. */
function SelectionLinks({ provider }: { provider: string }) {
  const { t } = useTranslation();
  if (provider === COPILOT_PROVIDER_ID) {
    return (
      <SettingsLink destination={connectionDestination("copilot")} className="mt-2">
        {t("modelPicker.links.manageCopilot")}
      </SettingsLink>
    );
  }
  return <ManageKeysLink provider={provider} className="mt-2" />;
}

function BrowseHint({
  text: hint,
  onCancel,
  cancelLabel,
}: {
  text: string;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex items-start justify-between gap-3 rounded-md bg-muted/40 px-3 py-2">
      <p className="text-xs text-muted-foreground">{hint}</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-xs"
        onClick={onCancel}
      >
        {cancelLabel ?? t("common.cancel")}
      </Button>
    </div>
  );
}

const FIELD_LABEL_KEYS: Record<NoteFormattingFieldState["field"], string> = {
  provider: "modelPicker.inherit.fields.provider",
  endpoint: "modelPicker.inherit.fields.endpoint",
  server: "modelPicker.inherit.fields.server",
  model: "modelPicker.inherit.fields.model",
};

/**
 * Note formatting's fields while any inherits from Cleanup, one row each:
 * the value, "inherited from Cleanup" when borrowed, and Override, which
 * opens the picker. Endpoints are edited in the fields below.
 */
function InheritedFields({
  fields,
  from,
  onOverride,
}: {
  fields: readonly NoteFormattingFieldState[];
  from: string;
  onOverride: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="divide-y divide-border/60 rounded-md border border-border/70 dark:divide-border-subtle/50 dark:border-border-subtle/60">
      {fields.map((field) => (
        <div
          key={field.field}
          data-inherited-field={field.field}
          className="flex items-center gap-3 px-3 py-2"
        >
          <span className="w-24 shrink-0 text-xs text-muted-foreground">
            {t(FIELD_LABEL_KEYS[field.field])}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
            {text(t, field.value)}
            {field.inherited && (
              <span className="ms-2 text-[11px] text-muted-foreground">
                {t("modelPicker.inherit.from", { feature: from })}
              </span>
            )}
          </span>
          {field.inherited && (field.field === "provider" || field.field === "model") && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={onOverride}
            >
              {t("modelPicker.inherit.override")}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
