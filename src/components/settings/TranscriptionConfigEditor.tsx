import { useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import {
  selectPolicyEffectiveSettings,
  useSettingsStore,
  type SettingsState,
} from "../../stores/settingsStore";
import { filterByokProviderOptionsByPolicy } from "../../stores/policyRules";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { API_ENDPOINTS, normalizeBaseUrl } from "../../config/constants";
import { createExternalLinkHandler } from "../../utils/externalLinks";
import { requestSignIn } from "../../utils/requestSignIn";
import type { InferenceMode } from "../../types/electron";
import { AlertTriangle, ChevronRight } from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import ApiKeyInput from "../ui/ApiKeyInput";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { useSettingsLayout } from "../ui/useSettingsLayout";
import { cn } from "../lib/utils";
import SelfHostedPanel from "../SelfHostedPanel";
import ManageKeysLink from "./ManageKeysLink";
import { useOpenSettingsLink } from "./settingsLink";
import { SETTINGS_PAGES } from "./settingsPages";
import WhisperGpuCard from "./WhisperGpuCard";
import ModelPicker from "./modelPicker/ModelPicker";
import type { PickerLink, PickerText, PickerUnavailable } from "./modelPicker/options";
import {
  STT_SURFACE_CONTEXT,
  buildSttPickerOptions,
  describeSttSelection,
  selectedSttOptionId,
  sttSelectionIssue,
  sttInheritedFields,
  sttSurfaceProviders,
  type SttFieldState,
  type SttPickerOption,
  type SttSurface,
} from "./modelPicker/sttOptions";
import { useSttPickerContext } from "./modelPicker/useSttPickerContext";
import { rawSttCloudProvider, useSttSelection } from "./modelPicker/selectStt";

const TINFOIL_AUDIO_DOCS_URL = "https://docs.tinfoil.sh/models/audio";

/** Each surface's page name, for "inherited from …" and the browse hint. */
const SURFACE_TITLE_KEYS: Record<SttSurface, string> = {
  dictation: SETTINGS_PAGES.recognition.titleKey,
  liveRecording: SETTINGS_PAGES.liveRecording.titleKey,
  fileTranscription: SETTINGS_PAGES.fileTranscription.titleKey,
};

/** The store keys inherited fields are read from (live recording and uploads borrow Recognition's). */
const INHERITANCE_KEYS = [
  "isSignedIn",
  "transcriptionMode",
  "useLocalWhisper",
  "cloudTranscriptionMode",
  "cloudTranscriptionProvider",
  "cloudTranscriptionModel",
  "cloudTranscriptionBaseUrl",
  "localTranscriptionProvider",
  "whisperModel",
  "parakeetModel",
  "cohereModel",
  "remoteTranscriptionUrl",
  "remoteTranscriptionModel",
  "meetingTranscriptionMode",
  "meetingUseLocalWhisper",
  "meetingCloudTranscriptionMode",
  "meetingCloudTranscriptionProvider",
  "meetingCloudTranscriptionModel",
  "meetingCloudTranscriptionBaseUrl",
  "meetingLocalTranscriptionProvider",
  "meetingWhisperModel",
  "meetingParakeetModel",
  "meetingCohereModel",
  "meetingRemoteTranscriptionType",
  "meetingRemoteTranscriptionUrl",
  "uploadTranscriptionMode",
  "uploadUseLocalWhisper",
  "uploadCloudTranscriptionMode",
  "uploadCloudTranscriptionProvider",
  "uploadCloudTranscriptionModel",
  "uploadCloudTranscriptionBaseUrl",
  "uploadLocalTranscriptionProvider",
  "uploadWhisperModel",
  "uploadParakeetModel",
  "uploadCohereModel",
  "uploadRemoteTranscriptionUrl",
  "uploadRemoteTranscriptionModel",
] as const;

type Translate = (key: string, options?: Record<string, unknown>) => string;

function text(t: Translate, value: PickerText | undefined): string {
  if (!value) return "";
  return "text" in value ? value.text : t(value.key, value.params);
}

interface TranscriptionConfigEditorProps {
  surface: SttSurface;
  /** Recognition's mode-change toast (its mode cards toasted; the other surfaces' didn't). */
  onModeChange?: (mode: InferenceMode) => void;
}

/**
 * A speech-to-text surface's model setting (Recognition, Live Recording, File
 * Transcription): one picker grouped by connection, then what the selection
 * needs under it — the custom endpoint's URL, shared key (replace-only) and
 * model, the self-hosted server's URL and model, Corti's data region and
 * tenant, Tinfoil's transport note, Cohere's one-language rule, and Whisper's
 * GPU acceleration pack. Keys live on AI Connections. Live recording and
 * uploads show the values they borrow from Recognition one by one, with
 * Override. Every pick goes through the selection adapter (selectStt.ts).
 */
export default function TranscriptionConfigEditor({
  surface,
  onModeChange,
}: TranscriptionConfigEditorProps) {
  const { t } = useTranslation();
  const { isCompact } = useSettingsLayout();
  const policy = usePolicySnapshot();
  const [open, setOpen] = useState(false);
  const [browseCustom, setBrowseCustom] = useState(false);
  const picker = useSttPickerContext(surface, { open });
  const { context, effectiveMode } = picker;
  const { current } = context;
  const groups = useMemo(() => buildSttPickerOptions(surface, context), [surface, context]);
  const summary = useMemo(() => describeSttSelection(surface, context), [surface, context]);
  const issue = useMemo(() => sttSelectionIssue(surface, context), [surface, context]);
  const commit = useSttSelection(surface, { readContext: picker.readContext, onModeChange });
  const openSettings = useOpenSettingsLink();

  // Live recording's and uploads' own values, to tell which fields borrow Recognition's.
  const inheritance = useSettingsStore(
    useShallow((settings) => {
      if (surface === "dictation") return null;
      const effective = selectPolicyEffectiveSettings(settings, policy);
      return Object.fromEntries(INHERITANCE_KEYS.map((key) => [key, effective[key]]));
    })
  );
  const inheritedFields = useMemo(
    () =>
      inheritance
        ? sttInheritedFields(surface, inheritance as unknown as SettingsState, effectiveMode)
        : null,
    [surface, inheritance, effectiveMode]
  );

  const handleSelect = (option: SttPickerOption) => {
    const result = commit(option);
    if (option.action === "configureCustom") {
      setBrowseCustom(result.status === "browse");
      return;
    }
    if (result.status !== "refused") setBrowseCustom(false);
  };

  const commitCustomModel = (model: string) => {
    const result = commit({ mode: "providers", provider: "custom", model });
    if (result.status === "committed") setBrowseCustom(false);
  };

  const followLink = (link: PickerLink) => {
    if (link.kind === "signIn") requestSignIn();
    else openSettings?.(link.destination);
  };

  const providers = effectiveMode === "providers";
  const customCommitted = providers && current.cloudProvider === "custom";
  const showCustom = browseCustom || customCommitted;
  const showSelfHosted =
    !showCustom && effectiveMode === "self-hosted" && surface !== "liveRecording";
  const local = effectiveMode === "local";
  const from = t(SURFACE_TITLE_KEYS.dictation);

  const pickerElement = (
    <ModelPicker
      groups={groups}
      selectedId={selectedSttOptionId(current)}
      summary={summary}
      onSelect={handleSelect}
      onLink={followLink}
      canFollow={(link) => link.kind === "signIn" || !!openSettings}
      label={t("modelPicker.label")}
      open={open}
      onOpenChange={setOpen}
      renderAnchor={
        inheritedFields
          ? (openMenu) => (
              <InheritedFields
                fields={inheritedFields}
                from={from}
                issue={issue}
                canFollow={(link) => link.kind === "signIn" || !!openSettings}
                onFollow={followLink}
                onOverride={openMenu}
              />
            )
          : undefined
      }
    />
  );

  const panel = (
    <SettingsPanel>
      <SettingsPanelRow>
        {inheritedFields ? (
          <div className="space-y-2">
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
            <div className={isCompact ? "w-full" : "w-[22rem] max-w-[55%] shrink-0"}>
              {pickerElement}
            </div>
          </div>
        )}
        {providers && current.cloudProvider !== "custom" && (
          <ManageKeysLink provider={current.cloudProvider} className="mt-2" />
        )}
      </SettingsPanelRow>

      {showCustom && (
        <SettingsPanelRow>
          {!customCommitted && (
            <BrowseHint
              text={t("modelPicker.stt.custom.browseHint", {
                feature: t(SURFACE_TITLE_KEYS[surface]),
              })}
              onCancel={() => setBrowseCustom(false)}
            />
          )}
          <CustomEndpointFields
            surface={surface}
            inheritedUrl={current.cloudProvider === "custom" ? current.cloudBaseUrl : ""}
            inheritedModel={current.cloudProvider === "custom" ? current.cloudModel : ""}
            onModel={commitCustomModel}
          />
        </SettingsPanelRow>
      )}

      {showSelfHosted && (
        <SettingsPanelRow>
          <SelfHostedFields surface={surface} />
        </SettingsPanelRow>
      )}

      {providers && !browseCustom && current.cloudProvider === "corti" && (
        <SettingsPanelRow>
          <CortiFields />
        </SettingsPanelRow>
      )}

      {providers && !browseCustom && current.cloudProvider === "tinfoil" && (
        <SettingsPanelRow>
          <p className="text-xs text-muted-foreground/80">
            {t("transcription.tinfoil.transportNote")}{" "}
            <a
              href={TINFOIL_AUDIO_DOCS_URL}
              onClick={createExternalLinkHandler(TINFOIL_AUDIO_DOCS_URL)}
              className="text-primary/70 hover:text-primary transition-colors"
            >
              {t("transcription.tinfoil.docsLink")}
            </a>
          </p>
        </SettingsPanelRow>
      )}

      {local && current.localProvider === "cohere" && (
        <SettingsPanelRow>
          <p className="text-xs text-muted-foreground">{t("modelPicker.stt.local.cohereNote")}</p>
        </SettingsPanelRow>
      )}
    </SettingsPanel>
  );

  return (
    <div className="space-y-3">
      {panel}
      {/* Its own card (as on the old Whisper tab); renders nothing on macOS or without a GPU pack to offer. */}
      {local && current.localProvider === "whisper" && <WhisperGpuCard />}
    </div>
  );
}

function PickerHeading() {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs font-medium text-foreground">{t("modelPicker.label")}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
        {t("modelPicker.stt.description")}
      </p>
    </div>
  );
}

function BrowseHint({ text: hint, onCancel }: { text: string; onCancel: () => void }) {
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
        {t("common.cancel")}
      </Button>
    </div>
  );
}

const FIELD_LABEL_KEYS: Record<SttFieldState["field"], string> = {
  engine: "modelPicker.stt.inherit.engine",
  provider: "modelPicker.inherit.fields.provider",
  endpoint: "modelPicker.inherit.fields.endpoint",
  model: "modelPicker.inherit.fields.model",
};

/**
 * The fields a surface borrows from Recognition (or takes as the provider's
 * default), one row each, with Override, which opens the picker, then why the
 * result can't run here (the picker button's warning, which this view replaces),
 * with "Choose a model" (the picker) and where it's fixed. Showing them writes
 * nothing.
 */
function InheritedFields({
  fields,
  from,
  issue,
  canFollow,
  onFollow,
  onOverride,
}: {
  fields: readonly SttFieldState[];
  from: string;
  issue: PickerUnavailable | undefined;
  canFollow: (link: PickerLink) => boolean;
  onFollow: (link: PickerLink) => void;
  onOverride: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
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
              {field.source === "inherited" && (
                <span className="ms-2 text-[11px] text-muted-foreground">
                  {t("modelPicker.inherit.from", { feature: from })}
                </span>
              )}
            </span>
            {field.source !== "own" && field.field !== "endpoint" && (
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
      {issue && (
        <p
          data-inherited-warning=""
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-warning"
        >
          <span className="inline-flex items-center gap-1">
            <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0" />
            {t(issue.reasonKey, issue.reasonParams)}
          </span>
          <button
            type="button"
            onClick={onOverride}
            className="text-link underline decoration-link/30 hover:decoration-link/60"
          >
            {t("modelPicker.trigger.choose")}
          </button>
          {issue.link && canFollow(issue.link) && (
            <button
              type="button"
              onClick={() => issue.link && onFollow(issue.link)}
              className="inline-flex items-center gap-0.5 text-link underline decoration-link/30 hover:decoration-link/60"
            >
              {t(issue.link.labelKey)}
              <ChevronRight aria-hidden="true" className="h-3 w-3 rtl:rotate-180" />
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * The custom endpoint's fields, as the old Custom tab had them: the URL (written
 * as typed; normalized on blur once the endpoint is picked, and switched to the
 * matching provider when it is one of theirs), the one key every speech-to-text
 * custom endpoint shares (replace-only, never shown), and the model, which
 * commits through the adapter.
 */
function CustomEndpointFields({
  surface,
  inheritedUrl,
  inheritedModel,
  onModel,
}: {
  surface: SttSurface;
  inheritedUrl: string;
  inheritedModel: string;
  onModel: (model: string) => void;
}) {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const upload = surface === "fileTranscription";
  const rawUrl = useSettingsStore((s) =>
    upload ? s.uploadCloudTranscriptionBaseUrl : s.cloudTranscriptionBaseUrl
  );
  const rawProvider = useSettingsStore((s) => rawSttCloudProvider(surface, s));
  const rawModel = useSettingsStore((s) =>
    upload ? s.uploadCloudTranscriptionModel : s.cloudTranscriptionModel
  );
  const setUrl = useSettingsStore((s) =>
    upload ? s.setUploadCloudTranscriptionBaseUrl : s.setCloudTranscriptionBaseUrl
  );
  const switchProvider = useSettingsStore((s) => s.switchCloudTranscriptionProvider);
  const apiKey = useSettingsStore((s) => s.customTranscriptionApiKey);
  const setApiKey = useSettingsStore((s) => s.setCustomTranscriptionApiKey);
  const url = rawUrl ?? "";
  const model = rawProvider === "custom" ? rawModel : "";
  const urlId = useId();
  const modelId = useId();

  const handleBlur = () => {
    if (rawProvider !== "custom") return;
    const trimmed = url.trim();
    if (!trimmed) return;
    const normalized = normalizeBaseUrl(trimmed);
    if (normalized && normalized !== url) setUrl(normalized);
    if (normalized) {
      const allowed = filterByokProviderOptionsByPolicy(
        sttSurfaceProviders(surface),
        "transcription",
        policy
      );
      for (const provider of allowed) {
        if (normalized === normalizeBaseUrl(provider.baseUrl)) {
          switchProvider(STT_SURFACE_CONTEXT[surface], provider.id);
          break;
        }
      }
    }
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <label htmlFor={urlId} className="block text-xs font-medium text-foreground">
          {t("transcription.endpointUrl")}
        </label>
        <Input
          id={urlId}
          dir="ltr"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onBlur={handleBlur}
          placeholder={
            // Uploads with no URL of their own use Recognition's.
            !url && inheritedUrl && inheritedUrl !== API_ENDPOINTS.TRANSCRIPTION_BASE
              ? inheritedUrl
              : "https://your-api.example.com/v1"
          }
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">{t("transcription.apiKeyOptional")}</p>
        {/* Replace mode never shows the saved key, so clearing it is its own action. */}
        <div className="flex items-start gap-1.5">
          <ApiKeyInput
            className="min-w-0 flex-1"
            apiKey={apiKey}
            setApiKey={setApiKey}
            label=""
            ariaLabel={t("transcription.apiKeyOptional")}
            helpText={t("modelPicker.stt.custom.keyShared")}
            replace
          />
          {apiKey && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => setApiKey("")}
            >
              {t("connections.actions.remove")}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={modelId} className="block text-xs font-medium text-foreground">
          {t("common.model")}
        </label>
        <Input
          id={modelId}
          dir="ltr"
          value={model}
          onChange={(event) => onModel(event.target.value)}
          placeholder={!model && inheritedModel ? inheritedModel : "whisper-1"}
          className="h-8 text-sm"
        />
      </div>

      {/azure\.com/i.test(url || inheritedUrl) && (
        <p className="text-xs text-muted-foreground">{t("transcription.azureHint")}</p>
      )}
    </div>
  );
}

/** The self-hosted server's URL and model (Recognition's and File Transcription's own keys). */
function SelfHostedFields({ surface }: { surface: SttSurface }) {
  const upload = surface === "fileTranscription";
  const url = useSettingsStore((s) =>
    upload ? s.uploadRemoteTranscriptionUrl : s.remoteTranscriptionUrl
  );
  const setUrl = useSettingsStore((s) =>
    upload ? s.setUploadRemoteTranscriptionUrl : s.setRemoteTranscriptionUrl
  );
  const model = useSettingsStore((s) =>
    upload ? s.uploadRemoteTranscriptionModel : s.remoteTranscriptionModel
  );
  const setModel = useSettingsStore((s) =>
    upload ? s.setUploadRemoteTranscriptionModel : s.setRemoteTranscriptionModel
  );
  return (
    <SelfHostedPanel
      service="transcription"
      url={url}
      onUrlChange={setUrl}
      model={model}
      onModelChange={setModel}
    />
  );
}

/** Corti's data region and tenant (shared by every surface; the client credentials are on AI Connections). */
function CortiFields() {
  const { t } = useTranslation();
  const environment = useSettingsStore((s) => s.cortiEnvironment);
  const setEnvironment = useSettingsStore((s) => s.setCortiEnvironment);
  const tenant = useSettingsStore((s) => s.cortiTenant);
  const setTenant = useSettingsStore((s) => s.setCortiTenant);
  const regionId = useId();
  const tenantId = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <label htmlFor={regionId} className="block text-xs font-medium text-foreground">
          {t("transcription.corti.environment")}
        </label>
        <Select value={environment} onValueChange={setEnvironment}>
          <SelectTrigger id={regionId} className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="us">US</SelectItem>
            <SelectItem value="eu">EU</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={tenantId} className="block text-xs font-medium text-foreground">
          {t("transcription.corti.tenant")}
        </label>
        <Input
          id={tenantId}
          dir="ltr"
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
          placeholder="base"
          className="h-8 text-sm"
        />
      </div>
    </div>
  );
}
