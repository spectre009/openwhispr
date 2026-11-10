import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "./ui/BidiInterpolatedText";
import { Badge } from "./ui/badge";
import {
  RefreshCw,
  Download,
  Mic,
  Shield,
  LogOut,
  UserCircle,
  Sun,
  Moon,
  Monitor,
  Cloud,
  ShieldCheck,
  Sparkles,
  AlertTriangle,
  Loader2,
  Check,
  Mail,
  CircleCheck,
  CircleX,
  RotateCw,
  BookOpen,
  Copy,
  Trash2,
  Info,
} from "./icons";
import { useAuth } from "../hooks/useAuth";
import { AUTH_URL, signOut } from "../lib/auth";
import { deleteAccount } from "../lib/accountDeletionRequest";
import { executeAccountDeletion } from "../lib/accountDeletionFlow";
import { getValidatedAuthGeneration } from "../lib/authRequestContext";
import { useBillingPortal } from "../hooks/useBillingPortal";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import MicrophoneSettings from "./ui/MicrophoneSettings";
import PermissionCard from "./ui/PermissionCard";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import NixOsPasteInfo from "./ui/NixOsPasteInfo";
import TranscriptionConfigEditor from "./settings/TranscriptionConfigEditor";
import { useSttEffectiveMode } from "./settings/modelPicker/useSttPickerContext";
import {
  ConfirmDialog,
  AlertDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { useSettings } from "../hooks/useSettings";
import { useDialogs } from "../hooks/useDialogs";
import { useInsightsSyncOptIn } from "../hooks/useInsightsSyncOptIn";
import { useLeaderboardParticipation } from "../hooks/useLeaderboardParticipation";
import { useWhisper } from "../hooks/useWhisper";
import { usePermissions } from "../hooks/usePermissions";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { useClipboard } from "../hooks/useClipboard";
import { useUpdater } from "../hooks/useUpdater";

import PromptStudio from "./ui/PromptStudio";
import StyleStudio from "./ui/StyleStudio";
import StyleHotkeysList from "./ui/StyleHotkeysList";
import { STYLE_LIST_FOCUS, requestStyleFocus, useStyleStore } from "../stores/styleStore";
import { styleHotkeyConflicts } from "../utils/styleHotkeys";
import { HotkeyListInput } from "./ui/HotkeyListInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { useHotkeyModeInfo } from "../hooks/useHotkeyModeInfo";
import { validateHotkeyForSlot } from "../utils/hotkeyValidation";
import { getPlatform, getCachedPlatform } from "../utils/platform";
import { formatHotkeyLabel } from "../utils/hotkeys";
import {
  getLinuxPasteInstallCommands,
  needsLinuxPasteToolGuidance,
} from "../utils/linuxPasteTools";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import LinuxPttSetupInfo from "./ui/LinuxPttSetupInfo";
import { Toggle } from "./ui/toggle";
import DiagnosticsSection from "./settings/DiagnosticsSection";
import StoragePage from "./settings/StoragePage";
import ProcessesPage from "./settings/ProcessesPage";
import PrivacyStorageSummary from "./settings/PrivacyStorageSummary";
import { retentionPeriodLabel } from "./settings/storageFormat";
import { transcriptRetentionChoices } from "../utils/retentionPeriods.js";
import ChatAgentSettings from "./settings/ChatAgentSettings";
import DictationAgentSettings from "./settings/DictationAgentSettings";
import DictationTranslationSettings from "./settings/DictationTranslationSettings";
import InferenceConfigEditor from "./settings/InferenceConfigEditor";
import { MeetingTranscriptionPanel } from "./settings/MeetingSettings";
import { UploadTranscriptionPanel } from "./settings/UploadSettings";
import LanguageSelector from "./ui/LanguageSelector";
import { Skeleton } from "./ui/skeleton";
import { Progress } from "./ui/progress";
import { useToast } from "./ui/useToast";
import { useTheme } from "../hooks/useTheme";
import type { ChineseScriptPreference, InferenceMode } from "../types/electron";
import logger from "../utils/logger";
import { SettingsRow, SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { FloatingIconPlacementRows } from "./settings/FloatingIconPlacementRows";
import { RecordingIndicatorRows } from "./settings/RecordingIndicatorRows";
import { OpenWhisprCloudSwitch } from "./settings/OpenWhisprCloudSwitch";
import { useOpenWhisprCloudDisabled } from "../stores/openWhisprCloudStore";
import { useSettingsLayout } from "./ui/useSettingsLayout";
import { useSettingsVisible } from "./settings/useSettingsVisible";
import { useUsage } from "../hooks/useUsage";
import { cn } from "./lib/utils";
import { GRADIENT_CIRCLE } from "./ui/gradientCircle";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  startMigration,
  useMigration,
  loadFolders,
  initializeNotesTree,
} from "../stores/noteStore.js";
import { syncService } from "../services/SyncService.js";
import { useSettingsStore, type HotkeyRegistrationResult } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { highestPlan } from "../lib/usageStore";
import { decideProPlanCardCta, resolveAccountPlan, storeSubscriptionsUrl } from "../lib/upsell";
import {
  canChangeCloudBackupPreference,
  effectiveAudioRetentionDays,
  effectiveLocalHistoryEnabled,
  isAgentAllowed,
  isCloudBackupAllowed,
  lockedLocalHistoryValue,
} from "../stores/policyRules";
import { usePolicySnapshot } from "../hooks/usePolicy";
import { stopRecording } from "../stores/meetingRecordingStore";
import { requestSignIn } from "../utils/requestSignIn";
import { canManageSystemAudioInApp } from "../utils/systemAudioAccess";
import WorkspaceSection from "./settings/WorkspaceSection";
import { enterpriseTileCta, type EnterpriseTileCta } from "../lib/workspaceBilling";
import WorkspaceBillingOverview from "./settings/WorkspaceBillingOverview";
import EnterpriseCheckoutDialog from "./settings/EnterpriseCheckoutDialog";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import ProfileSection from "./settings/ProfileSection";
import { formatAmount } from "../utils/formatAmount";
import { enterpriseProviderName, getTranscriptionProvider } from "../models/ModelRegistry";
import { useManagedScopeResolution } from "../stores/enterpriseIdentityStore";
import { supportsLiveTranscriptionPreview } from "../utils/transcriptionPreview";
import SettingsPageHeader from "./settings/SettingsPageHeader";
import GpuDeviceSelector from "./settings/GpuDeviceSelector";
import AiConnectionsPage from "./settings/AiConnectionsPage";
import BuildInfoPanel from "./settings/BuildInfoPanel";
import DictationOverview from "./settings/DictationOverview";
import AutoLearnModeSetting from "./settings/AutoLearnModeSetting";
import CleanupDictionaryWordsSetting from "./settings/CleanupDictionaryWordsSetting";
import CleanupDictionaryGroupingSetting from "./settings/CleanupDictionaryGroupingSetting";
import DictionaryHintOrderSetting from "./settings/DictionaryHintOrderSetting";
import QuietEmptyDictationSetting from "./settings/QuietEmptyDictationSetting";
import { HotkeyFeatureLink, HotkeyKbd, HotkeyTable, HotkeyTableRow } from "./settings/HotkeyTable";
import type { ElsewhereLocation } from "./settings/search/types";
import {
  SETTINGS_PAGE_IDS,
  SETTINGS_PAGES,
  type PreferencesBlockId,
  type SettingsPageId,
} from "./settings/settingsPages";

export type SettingsSectionType =
  | "account"
  | "plansBilling"
  | "workspace"
  | "general"
  | "hotkeys"
  | "speechToText"
  | "llms"
  | "privacyData"
  | "system";

/** A Preferences block filter: the blocks of `general` a page shows (see settingsPages.ts). */
type BlockFilter = (block: PreferencesBlockId) => boolean;
const showAllBlocks: BlockFilter = () => true;

interface SettingsPageProps {
  /** The page shown; every page visited stays mounted, hidden (drafts and downloads survive). */
  page?: SettingsPageId;
  /** A link inside a page (Hotkeys → a style opens Styles). */
  onNavigate?: (page: SettingsPageId, subTab?: string) => void;
  /** Leaves Settings for an app page (the Dictation overview's Dictionary & glossary step). */
  onOpenElsewhere?: (location: ElsewhereLocation) => void;
  /** The Workspace tab a destination named. */
  initialSubTab?: string;
  /** Changes with each navigation, so `initialSubTab` re-applies even when it's unchanged. */
  subTabRequestId?: number;
}

const UI_LANGUAGE_OPTIONS: import("./ui/LanguageSelector").LanguageOption[] = [
  { value: "en", label: "English", flag: "🇺🇸" },
  { value: "ar", label: "العربية", flag: "🇦🇪" },
  { value: "es", label: "Español", flag: "🇪🇸" },
  { value: "fr", label: "Français", flag: "🇫🇷" },
  { value: "de", label: "Deutsch", flag: "🇩🇪" },
  { value: "pt", label: "Português", flag: "🇵🇹" },
  { value: "it", label: "Italiano", flag: "🇮🇹" },
  { value: "ru", label: "Русский", flag: "🇷🇺" },
  { value: "ja", label: "日本語", flag: "🇯🇵" },
  { value: "zh-CN", label: "简体中文", flag: "🇨🇳" },
  { value: "zh-TW", label: "繁體中文", flag: "🇹🇼" },
];

const RETENTION_SELECT_CLASS =
  "h-7 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-200";

function SectionHeader({
  title,
  description,
  note,
}: {
  title: string;
  description?: string;
  note?: string;
}) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      )}
      {note && <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{note}</p>}
    </div>
  );
}

interface GranolaImportPreview {
  total: number;
  newCount: number;
  duplicateCount: number;
  sampleTitles: string[];
  warningCount: number;
}

type GranolaImportState =
  | { phase: "idle" }
  | { phase: "picking" }
  | { phase: "preview"; preview: GranolaImportPreview }
  | { phase: "importing"; preview: GranolaImportPreview }
  | { phase: "done"; imported: number; skipped: number };

function GranolaImportSection({
  showAlertDialog,
}: {
  showAlertDialog: (options: { title: string; description?: string }) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<GranolaImportState>({ phase: "idle" });
  // Guards double-clicks: handlers read stale closure state, so state alone
  // can't prevent a second dialog/run being started in the same frame.
  const requestInFlightRef = useRef(false);

  const errorDescription = (code?: string) => {
    switch (code) {
      case "EMPTY_FILE":
        return t("settings.granolaImport.error.EMPTY_FILE");
      case "HEADERS_UNRECOGNIZED":
        return t("settings.granolaImport.error.HEADERS_UNRECOGNIZED");
      case "NO_DATA_ROWS":
        return t("settings.granolaImport.error.NO_DATA_ROWS");
      case "FILE_TOO_LARGE":
        return t("settings.granolaImport.error.FILE_TOO_LARGE");
      default:
        return t("settings.granolaImport.error.generic");
    }
  };

  const showImportError = (code?: string) => {
    showAlertDialog({
      title: t("settings.granolaImport.error.title"),
      description: errorDescription(code),
    });
  };

  const handleChooseFile = async () => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setState({ phase: "picking" });
    try {
      let result:
        | Awaited<ReturnType<NonNullable<typeof window.electronAPI.granolaImportPickAndPreview>>>
        | undefined;
      try {
        result = await window.electronAPI?.granolaImportPickAndPreview?.();
      } catch {
        setState({ phase: "idle" });
        showImportError();
        return;
      }
      if (!result || result.canceled) {
        setState({ phase: "idle" });
        return;
      }
      if (!result.success) {
        setState({ phase: "idle" });
        showImportError(result.error);
        return;
      }
      setState({
        phase: "preview",
        preview: {
          total: result.total ?? 0,
          newCount: result.newCount ?? 0,
          duplicateCount: result.duplicateCount ?? 0,
          sampleTitles: result.sampleTitles ?? [],
          warningCount: result.rowIssueCount ?? 0,
        },
      });
    } finally {
      requestInFlightRef.current = false;
    }
  };

  const handleConfirm = async () => {
    if (state.phase !== "preview" || requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setState({ phase: "importing", preview: state.preview });
    try {
      let result:
        Awaited<ReturnType<NonNullable<typeof window.electronAPI.granolaImportRun>>> | undefined;
      try {
        result = await window.electronAPI?.granolaImportRun?.();
      } catch {
        result = undefined;
      }
      if (!result?.success) {
        setState({ phase: "idle" });
        showImportError(result?.error);
        return;
      }
      const imported = result.imported ?? 0;
      setState({ phase: "done", imported, skipped: result.skipped ?? 0 });
      if (imported > 0) {
        // One refresh + one batched sync pass — never per-note pushes.
        void loadFolders();
        void initializeNotesTree();
        void syncService.requestSyncAll("manual");
      }
    } finally {
      requestInFlightRef.current = false;
    }
  };

  const dialogOpen =
    state.phase === "preview" || state.phase === "importing" || state.phase === "done";
  const preview = state.phase === "preview" || state.phase === "importing" ? state.preview : null;

  return (
    <div data-setting-id="notes.import.granola">
      <SectionHeader
        title={t("settings.granolaImport.title")}
        description={t("settings.granolaImport.howTo")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settings.granolaImport.title")}
            description={t("settings.granolaImport.description")}
          >
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={state.phase === "picking"}
              onClick={handleChooseFile}
            >
              {state.phase === "picking" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                t("settings.granolaImport.chooseFile")
              )}
            </Button>
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && state.phase !== "importing") setState({ phase: "idle" });
        }}
      >
        <DialogContent className="sm:max-w-90">
          <DialogHeader>
            <DialogTitle>
              {state.phase === "done"
                ? t("settings.granolaImport.done.title")
                : t("settings.granolaImport.preview.title")}
            </DialogTitle>
            {state.phase === "done" ? (
              <DialogDescription>
                {t("settings.granolaImport.done.summary", {
                  imported: state.imported,
                  skipped: state.skipped,
                })}
              </DialogDescription>
            ) : (
              preview && (
                <DialogDescription>
                  {preview.newCount === 0
                    ? t("settings.granolaImport.preview.nothingNew")
                    : t("settings.granolaImport.preview.summary", {
                        total: preview.total,
                        newCount: preview.newCount,
                        duplicateCount: preview.duplicateCount,
                      })}
                </DialogDescription>
              )
            )}
          </DialogHeader>
          {preview && (
            <div className="space-y-2">
              {preview.sampleTitles.length > 0 && (
                <ul className="text-xs text-muted-foreground space-y-1">
                  {preview.sampleTitles.map((title, index) => (
                    <li key={`${index}-${title}`} className="truncate">
                      {title}
                    </li>
                  ))}
                </ul>
              )}
              {preview.warningCount > 0 && (
                <p className="text-xs text-muted-foreground/80">
                  {t("settings.granolaImport.preview.warnings", {
                    warningCount: preview.warningCount,
                  })}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            {state.phase === "done" ? (
              <Button size="sm" onClick={() => setState({ phase: "idle" })}>
                {t("common.close")}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.phase === "importing"}
                  onClick={() => setState({ phase: "idle" })}
                >
                  {t("common.cancel")}
                </Button>
                <Button size="sm" disabled={state.phase === "importing"} onClick={handleConfirm}>
                  {state.phase === "importing" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    t("settings.granolaImport.preview.confirm", {
                      newCount: preview?.newCount ?? 0,
                    })
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface TranscriptionSectionProps {
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  showTranscriptionPreview: boolean;
  setShowTranscriptionPreview: (value: boolean) => void;
  toast: (opts: {
    title: string;
    description: string;
    variant?: "default" | "destructive" | "success";
    duration?: number;
  }) => void;
}

const TRANSCRIPTION_MODE_TOASTS: Record<InferenceMode, string> = {
  openwhispr: "switchedCloud",
  providers: "switchedProviders",
  local: "switchedLocal",
  "self-hosted": "switchedSelfHosted",
  enterprise: "switchedEnterprise",
};

function TranscriptionSection({
  cloudTranscriptionProvider,
  cloudTranscriptionModel,
  showTranscriptionPreview,
  setShowTranscriptionPreview,
  toast,
}: TranscriptionSectionProps) {
  const { t } = useTranslation();
  const enterpriseTranscriptionSetupMode = useSettingsStore(
    (s) => s.enterpriseTranscriptionSetupMode
  );
  const setEnterpriseTranscriptionSetupMode = useSettingsStore(
    (s) => s.setEnterpriseTranscriptionSetupMode
  );
  const managed = useManagedScopeResolution("transcription", enterpriseTranscriptionSetupMode);
  const managedAvailable = useManagedScopeResolution("transcription", "managed");
  const effectiveTranscriptionMode = useSttEffectiveMode("dictation");

  // The mode cards toasted each mode switch; the picker does on the same switches.
  const handleModeChange = useCallback(
    (mode: InferenceMode) => {
      const toastKey = TRANSCRIPTION_MODE_TOASTS[mode];
      toast({
        title: t(`settingsPage.transcription.toasts.${toastKey}.title`),
        description: t(`settingsPage.transcription.toasts.${toastKey}.description`),
        variant: "success",
        duration: 3000,
      });
    },
    [t, toast]
  );

  const selectedCloudModelStreams = Boolean(
    getTranscriptionProvider(cloudTranscriptionProvider)?.models.some(
      (model) => model.id === cloudTranscriptionModel && model.streaming
    )
  );
  const previewAvailable =
    !!effectiveTranscriptionMode &&
    supportsLiveTranscriptionPreview(effectiveTranscriptionMode, selectedCloudModelStreams);

  const renderPreviewToggle = () => (
    <SettingsPanel>
      <SettingsPanelRow data-setting-id="dictation.stt.preview">
        <SettingsRow
          label={t("settingsPage.transcription.transcriptionPreview")}
          description={t("settingsPage.transcription.transcriptionPreviewDescription")}
        >
          <Toggle checked={showTranscriptionPreview} onChange={setShowTranscriptionPreview} />
        </SettingsRow>
      </SettingsPanelRow>
    </SettingsPanel>
  );

  // Local decoding still serves meetings and uploads under a managed-config
  // error, so this stays a card alongside the rest of the section (including
  // the GPU selector below) instead of an early return that hides it.
  const errorCard =
    managed.kind === "error" ? (
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
    ) : null;

  const managedCard =
    managed.kind === "managed" ? (
      <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
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
        {managed.mode !== "managed_required" && managed.allowManualSetup && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEnterpriseTranscriptionSetupMode("manual")}
            >
              {t("settingsPage.aiModels.managedEnterprise.usePersonalSetup")}
            </Button>
          </div>
        )}
      </div>
    ) : null;

  return (
    <div data-setting-id="dictation.stt.engine" className="space-y-4">
      {errorCard}
      {managedCard}
      {!errorCard && !managedCard && (
        <>
          {enterpriseTranscriptionSetupMode === "manual" && managedAvailable.kind === "managed" && (
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
                onClick={() => setEnterpriseTranscriptionSetupMode("managed")}
              >
                {t("settingsPage.aiModels.managedEnterprise.useManaged")}
              </Button>
            </div>
          )}
          <TranscriptionConfigEditor surface="dictation" onModeChange={handleModeChange} />
          {previewAvailable && renderPreviewToggle()}
        </>
      )}

      {/* Local decoding still serves meetings and uploads, so the GPU choice stays reachable. */}
      <GpuDeviceSelector purpose="transcription" data-setting-id="dictation.stt.gpu" />
    </div>
  );
}
interface AiModelsSectionProps {
  useCleanupModel: boolean;
  setUseCleanupModel: (value: boolean) => void;
  /** The page header holds the on/off switch (Settings › Dictation › Cleanup). */
  enableToggleInHeader?: boolean;
  toast: (opts: {
    title: string;
    description: string;
    variant?: "default" | "destructive" | "success";
    duration?: number;
  }) => void;
}

const CLEANUP_MODE_TOAST_KEY: Record<InferenceMode, string> = {
  openwhispr: "switchedCloud",
  providers: "switchedProviders",
  local: "switchedLocal",
  "self-hosted": "switchedSelfHosted",
  enterprise: "switchedEnterprise",
};

function NoteFormattingSettings() {
  const { t } = useTranslation();
  const autoGenerateNoteTitle = useSettingsStore((s) => s.autoGenerateNoteTitle);
  const setAutoGenerateNoteTitle = useSettingsStore((s) => s.setAutoGenerateNoteTitle);

  return (
    <div className="space-y-4">
      <SettingsPanel>
        <SettingsPanelRow data-setting-id="notes.formatting.autoTitle">
          <SettingsRow
            label={t("settingsPage.noteFormatting.autoGenerateTitle")}
            description={t("settingsPage.noteFormatting.autoGenerateTitleDescription")}
          >
            <Toggle checked={autoGenerateNoteTitle} onChange={setAutoGenerateNoteTitle} />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>
      <InferenceConfigEditor scope="noteFormatting" data-setting-id="notes.formatting.model" />
    </div>
  );
}

function AiModelsSection({
  useCleanupModel,
  setUseCleanupModel,
  enableToggleInHeader = false,
  toast,
}: AiModelsSectionProps) {
  const { t } = useTranslation();

  const handleCleanupModeChange = (mode: InferenceMode) => {
    const toastKey = CLEANUP_MODE_TOAST_KEY[mode];
    toast({
      title: t(`settingsPage.aiModels.toasts.${toastKey}.title`),
      description: t(`settingsPage.aiModels.toasts.${toastKey}.description`),
      variant: "success",
      duration: 3000,
    });
  };

  return (
    <div className="space-y-4">
      {!enableToggleInHeader && (
        <SettingsPanel>
          <SettingsPanelRow data-setting-id="dictation.cleanup.enabled">
            <SettingsRow
              label={t("settingsPage.aiModels.enableTextCleanup")}
              description={t("settingsPage.aiModels.enableTextCleanupDescription")}
            >
              <Toggle checked={useCleanupModel} onChange={setUseCleanupModel} />
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      )}

      {useCleanupModel && (
        <>
          <InferenceConfigEditor
            scope="dictationCleanup"
            onModeChange={handleCleanupModeChange}
            data-setting-id="dictation.cleanup.model"
          />
          <GpuDeviceSelector purpose="intelligence" data-setting-id="dictation.cleanup.gpu" />
        </>
      )}
    </div>
  );
}

function VADLabelWithInfo({ label, description }: { label: string; description: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
      <span>{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground transition-colors"
            aria-label={label}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="max-w-sm p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// "Gabriel Stein" → "GS"; single names fall back to their first letter.
function nameInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function AccountAvatar({ image, name }: { image?: string | null; name: string }) {
  // Same stale-URL fallback as MemberAvatar: OAuth-hosted images expire, and a
  // bare <img> would render the broken-image glyph instead of the initials.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const initials = nameInitials(name);
  return (
    <div
      className={cn(
        "w-10 h-10 rounded-full flex items-center justify-center shrink-0 overflow-hidden",
        GRADIENT_CIRCLE
      )}
    >
      {image && image !== failedSrc ? (
        <img
          src={image}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(image)}
          className="w-10 h-10 rounded-full object-cover"
        />
      ) : initials ? (
        <span className="text-[13px] font-semibold leading-none select-none">{initials}</span>
      ) : (
        <UserCircle className="w-5 h-5" />
      )}
    </div>
  );
}

export default function SettingsPage({
  page = "appearance",
  onNavigate,
  onOpenElsewhere,
  initialSubTab,
  subTabRequestId,
}: SettingsPageProps) {
  const { isCompact } = useSettingsLayout();
  // Settings stays mounted while hidden: OS queries pause and refresh on reopen.
  const settingsVisible = useSettingsVisible();
  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const {
    localTranscriptionProvider,
    uiLanguage,
    preferredLanguage,
    chineseScriptPreference,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    useCleanupModel,
    dictationKey,
    activationMode,
    setActivationMode,
    microphoneSelectionMode,
    selectedMicDeviceId,
    selectedMicDeviceLabel,
    micWarmHoldSeconds,
    setMicrophoneSelectionMode,
    setSelectedMicDevice,
    setMicWarmHoldSeconds,
    setUiLanguage,
    setUseCleanupModel,
    setDictationKey,
    meetingKey,
    setMeetingKey,
    meetingHotkeyLayoutMode,
    setMeetingHotkeyLayoutMode,
    updateTranscriptionSettings,
    updateCleanupSettings,
    transcriptionMode,
    notificationsEnabled,
    setNotificationsEnabled,
    notifyMeetingDetection,
    setNotifyMeetingDetection,
    notifyCalendarReminders,
    setNotifyCalendarReminders,
    autoUpdatesEnabled,
    setAutoUpdatesEnabled,
    audioCuesEnabled,
    setAudioCuesEnabled,
    pauseMediaOnDictation,
    setPauseMediaOnDictation,
    showTranscriptionPreview,
    setShowTranscriptionPreview,
    autoPasteEnabled,
    setAutoPasteEnabled,
    keepTranscriptionInClipboard,
    setKeepTranscriptionInClipboard,
    floatingIconAutoHide,
    setFloatingIconAutoHide,
    startMinimized,
    setStartMinimized,
    panelStartPosition,
    setPanelStartPosition,
    floatingIconDisplay,
    floatingIconDisplayLabel,
    setFloatingIconDisplay,
    recordingIndicatorStyle,
    setRecordingIndicatorStyle,
    recordingIndicatorColor,
    setRecordingIndicatorColor,
    recordingEdgeStrip,
    setRecordingEdgeStrip,
    recordingEdgeStripDisplays,
    setRecordingEdgeStripDisplays,
    recordingTrayIndicator,
    setRecordingTrayIndicator,
    cloudBackupEnabled,
    setCloudBackupEnabled,
    insightsSyncEnabled,
    telemetryEnabled,
    setTelemetryEnabled,
    audioRetentionDays,
    transcriptRetentionDays,
    setTranscriptRetentionDays,
    dataRetentionEnabled,
    setDataRetentionEnabled,
    saveDiscardedTranscriptions,
    setSaveDiscardedTranscriptions,
    customDictionary,
    noteFilesEnabled,
    setNoteFilesEnabled,
    noteFilesPath,
    setNoteFilesPath,
    dictationSileroEnabled,
    setDictationSileroEnabled,
    noteRecordingSileroEnabled,
    setNoteRecordingSileroEnabled,
    meetingSileroEnabled,
    setMeetingSileroEnabled,
    whisperVadThreshold,
    setWhisperVadThreshold,
    whisperVadMinSpeechDurationMs,
    setWhisperVadMinSpeechDurationMs,
    whisperVadMinSilenceDurationMs,
    setWhisperVadMinSilenceDurationMs,
    whisperVadMaxSpeechDurationS,
    setWhisperVadMaxSpeechDurationS,
    whisperVadSpeechPadMs,
    setWhisperVadSpeechPadMs,
    whisperVadSamplesOverlap,
    setWhisperVadSamplesOverlap,
  } = useSettings();

  const cloudDisabled = useOpenWhisprCloudDisabled();
  const meetingProcessDetection = useSettingsStore((state) => state.meetingProcessDetection);
  const voiceAgentKey = useSettingsStore((s) => s.voiceAgentKey);
  const setVoiceAgentKey = useSettingsStore((s) => s.setVoiceAgentKey);
  const translationKey = useSettingsStore((s) => s.translationKey);
  const setTranslationKey = useSettingsStore((s) => s.setTranslationKey);
  const reviewKey = useSettingsStore((s) => s.reviewKey);
  const setReviewKey = useSettingsStore((s) => s.setReviewKey);
  // Style hotkeys (Stage 4) share the dictation slot: every hotkey field checks
  // against them by name.
  const styleLibrary = useStyleStore((s) => s.library);
  const styleHotkeyBindings = useStyleStore((s) => s.hotkeys.bindings);

  const settingsPolicyState = usePolicySnapshot();
  const agentAllowedByPolicy = isAgentAllowed(settingsPolicyState);
  const historyLockedByPolicy = lockedLocalHistoryValue(settingsPolicyState) !== null;
  const effectiveDataRetentionEnabled = effectiveLocalHistoryEnabled(
    settingsPolicyState,
    dataRetentionEnabled
  );
  const cloudBackupPolicyAllowed = isCloudBackupAllowed(settingsPolicyState);
  const enforcedAudioRetentionDays = effectiveAudioRetentionDays(
    settingsPolicyState,
    audioRetentionDays
  );

  const { t, i18n } = useTranslation();
  const { toast } = useToast();

  const [currentVersion, setCurrentVersion] = useState<string>("");

  const {
    status: updateStatus,
    info: updateInfo,
    downloadProgress: updateDownloadProgress,
    isChecking: checkingForUpdates,
    isDownloading: downloadingUpdate,
    isInstalling: installInitiated,
    checkForUpdates,
    downloadUpdate,
    installUpdate: installUpdateAction,
    getAppVersion,
  } = useUpdater();

  const isUpdateAvailable =
    !updateStatus.isDevelopment && (updateStatus.updateAvailable || updateStatus.updateDownloaded);

  const migration = useMigration();

  const { checkWhisperInstallation } = useWhisper();
  const permissionsHook = usePermissions(showAlertDialog, { active: settingsVisible });
  const systemAudio = useSystemAudioPermission();
  useClipboard(showAlertDialog);

  // Lazy keep-alive: a page mounts on its first visit, then stays mounted
  // (hidden) so editor drafts, model-download progress and IPC listeners
  // survive page switches. The setState-during-render pattern flips the flag
  // in the same commit as the page change, so there's no blank frame.
  const [visitedPages, setVisitedPages] = useState<ReadonlySet<SettingsPageId>>(
    () => new Set([page])
  );
  if (!visitedPages.has(page)) {
    setVisitedPages(new Set([...visitedPages, page]));
  }

  // Wayland paste tool status for diagnostics.
  const [ydotoolStatus, setYdotoolStatus] = useState<{
    isLinux: boolean;
    isWayland: boolean;
    hasYdotool: boolean;
    hasYdotoold: boolean;
    hasWtype: boolean;
    daemonRunning: boolean;
    hasService: boolean;
    hasUinput: boolean;
    hasUdevRule: boolean;
    hasGroup: boolean;
    isKde: boolean;
    isWlroots: boolean;
    isCosmic: boolean;
    hasXclip: boolean;
    hasXsel: boolean;
    isNixOS: boolean;
  } | null>(null);
  const [ydotoolGuideKey, setYdotoolGuideKey] = useState<string | null>(null);

  const refreshYdotoolStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI?.getYdotoolStatus?.();
      if (status) setYdotoolStatus(status);
    } catch {}
  }, []);

  useEffect(() => {
    if (settingsVisible) refreshYdotoolStatus();
  }, [refreshYdotoolStatus, settingsVisible]);

  const { theme, setTheme } = useTheme();
  const usage = useUsage();
  const billingWorkspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const billingWorkspacesLoaded = useWorkspaceStore((s) => s.loaded);
  const [enterpriseCheckoutOpen, setEnterpriseCheckoutOpen] = useState(false);
  const [enterpriseWorkspaceCreateOpen, setEnterpriseWorkspaceCreateOpen] = useState(false);
  // Until the store resolves, an empty list would make enterpriseTileCta answer
  // "createWorkspace" for everyone — including members who must never be routed
  // into creating a workspace. Fall back to contact sales for that window.
  const enterpriseCta: EnterpriseTileCta = billingWorkspacesLoaded
    ? enterpriseTileCta(billingWorkspaces, activeWorkspaceId)
    : { action: "contactSales", ownerName: null };
  const coveringWorkspaces = billingWorkspaces.filter((workspace) =>
    usage?.entitledWorkspaceIds?.includes(workspace.id)
  );
  const coveringWorkspaceNames = coveringWorkspaces.map((workspace) => workspace.name);
  // Reads the usage payload, not the workspace store, so the upgrade affordances
  // stay hidden across the window where the store is still loading.
  const isWorkspaceCovered =
    !usage?.isPersonallySubscribed && (usage?.entitledWorkspaceIds?.length ?? 0) > 0;
  // Null until the store resolves, so the label waits rather than guessing a tier.
  const coveringPlanLabel =
    isWorkspaceCovered && coveringWorkspaces.length
      ? t(
          `settingsPage.workspace.billing.planLabel.${highestPlan(
            coveringWorkspaces.map((workspace) => workspace.plan)
          )}`
        )
      : null;
  const hasShownApproachingToast = useRef(false);
  useEffect(() => {
    if (usage?.isApproachingLimit && !hasShownApproachingToast.current) {
      hasShownApproachingToast.current = true;
      toast({
        title: t("settingsPage.account.toasts.approachingLimit.title"),
        description: t("settingsPage.account.toasts.approachingLimit.description", {
          used: usage.wordsUsed.toLocaleString(i18n.language),
          limit: usage.limit.toLocaleString(i18n.language),
        }),
        duration: 6000,
      });
    }
  }, [usage?.isApproachingLimit, usage?.wordsUsed, usage?.limit, toast, t, i18n.language]);

  const installTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: true,
    showAlert: showAlertDialog,
  });

  const meetingRegisterFn = useCallback(async (hotkey: string) => {
    const result = await window.electronAPI?.registerMeetingHotkey?.(hotkey);
    // No `message`: useHotkeyRegistration falls back to the translated
    // hooks.hotkeyRegistration.errors.couldNotRegister, and that string is what
    // gets shown in a toast. An English literal here would surface untranslated.
    return result ?? { success: false };
  }, []);

  const { registerHotkey: registerMeetingHotkey, isRegistering: isMeetingHotkeyRegistering } =
    useHotkeyRegistration({
      onSuccess: (registeredHotkey) => {
        setMeetingKey(registeredHotkey);
      },
      showSuccessToast: false,
      showErrorToast: true,
      showAlert: showAlertDialog,
      registerFn: meetingRegisterFn,
    });

  // "Review last dictation": registered by main like the meeting hotkey.
  const reviewRegisterFn = useCallback(async (hotkey: string) => {
    const result = await window.electronAPI?.registerReviewHotkey?.(hotkey);
    return result ?? { success: false };
  }, []);

  const { registerHotkey: registerReviewHotkey, isRegistering: isReviewHotkeyRegistering } =
    useHotkeyRegistration({
      onSuccess: (registeredHotkey) => {
        setReviewKey(registeredHotkey);
      },
      showSuccessToast: false,
      showErrorToast: true,
      showAlert: showAlertDialog,
      registerFn: reviewRegisterFn,
    });

  // Agent hotkey setters resolve to false when main-process registration fails;
  // surface it and return the result so HotkeyListInput rolls the row back.
  const [isAgentHotkeyCommitting, setIsAgentHotkeyCommitting] = useState(false);
  const commitAgentHotkey = useCallback(
    async (setter: (key: string) => Promise<HotkeyRegistrationResult>, key: string) => {
      setIsAgentHotkeyCommitting(true);
      try {
        const result = await setter(key);
        if (!result.success) {
          showAlertDialog({
            title: t("hooks.hotkeyRegistration.titles.notRegistered"),
            description: result.message || t("hooks.hotkeyRegistration.errors.failedToRegister"),
          });
        }
        return result.success;
      } finally {
        setIsAgentHotkeyCommitting(false);
      }
    },
    [showAlertDialog, t]
  );

  const styleKeyConflicts = useMemo(
    () => styleHotkeyConflicts(styleHotkeyBindings, styleLibrary, t),
    [styleHotkeyBindings, styleLibrary, t]
  );

  const validateDictationHotkey = useCallback(
    (hotkey: string) =>
      validateHotkeyForSlot(
        hotkey,
        {
          "settingsPage.general.meetingHotkey.title": meetingKey,
          "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey,
          "settingsPage.general.translationHotkey.title": translationKey,
          "settingsPage.general.reviewHotkey.title": reviewKey,
        },
        t,
        styleKeyConflicts
      ),
    [meetingKey, voiceAgentKey, translationKey, reviewKey, styleKeyConflicts, t]
  );

  const validateMeetingHotkey = useCallback(
    (hotkey: string) =>
      validateHotkeyForSlot(
        hotkey,
        {
          "settingsPage.general.hotkey.title": dictationKey,
          "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey,
          "settingsPage.general.translationHotkey.title": translationKey,
          "settingsPage.general.reviewHotkey.title": reviewKey,
        },
        t,
        styleKeyConflicts
      ),
    [dictationKey, voiceAgentKey, translationKey, reviewKey, styleKeyConflicts, t]
  );

  const validateVoiceAgentHotkey = useCallback(
    (hotkey: string) =>
      validateHotkeyForSlot(
        hotkey,
        {
          "settingsPage.general.hotkey.title": dictationKey,
          "settingsPage.general.meetingHotkey.title": meetingKey,
          "settingsPage.general.translationHotkey.title": translationKey,
          "settingsPage.general.reviewHotkey.title": reviewKey,
        },
        t,
        styleKeyConflicts
      ),
    [dictationKey, meetingKey, translationKey, reviewKey, styleKeyConflicts, t]
  );

  const validateTranslationHotkey = useCallback(
    (hotkey: string) =>
      validateHotkeyForSlot(
        hotkey,
        {
          "settingsPage.general.hotkey.title": dictationKey,
          "settingsPage.general.meetingHotkey.title": meetingKey,
          "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey,
          "settingsPage.general.reviewHotkey.title": reviewKey,
        },
        t,
        styleKeyConflicts
      ),
    [dictationKey, meetingKey, voiceAgentKey, reviewKey, styleKeyConflicts, t]
  );

  const validateReviewHotkey = useCallback(
    (hotkey: string) =>
      validateHotkeyForSlot(
        hotkey,
        {
          "settingsPage.general.hotkey.title": dictationKey,
          "settingsPage.general.meetingHotkey.title": meetingKey,
          "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey,
          "settingsPage.general.translationHotkey.title": translationKey,
        },
        t,
        styleKeyConflicts
      ),
    [dictationKey, meetingKey, voiceAgentKey, translationKey, styleKeyConflicts, t]
  );

  // The Hotkeys page's style list opens Styles at that style.
  const openStyleInStudio = useCallback(
    (styleId: string | null) => {
      requestStyleFocus(styleId ?? STYLE_LIST_FOCUS);
      onNavigate?.("styles");
    },
    [onNavigate]
  );

  const {
    isUsingNativeShortcut,
    isUsingHyprland,
    hyprlandConfigStatus,
    pushToTalkUnavailableReason,
    linuxInputAccessDenied,
  } = useHotkeyModeInfo("settings", dictationKey);
  const [effectiveDefaultHotkey, setEffectiveDefaultHotkey] = useState<string | null>(null);
  const [linuxPttAvailable, setLinuxPttAvailable] = useState(true);

  const platform = getCachedPlatform();

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartNeedsApproval, setAutoStartNeedsApproval] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);

  const readAutoStartState = useCallback(async () => {
    if (!window.electronAPI?.getAutoStartEnabled) return;
    try {
      const state = await window.electronAPI.getAutoStartEnabled();
      setAutoStartEnabled(state.enabled);
      setAutoStartNeedsApproval(state.requiresApproval);
    } catch (error) {
      logger.error("Failed to get auto-start status", error, "settings");
    }
  }, []);

  useEffect(() => {
    if (!settingsVisible) return;
    readAutoStartState().finally(() => setAutoStartLoading(false));
  }, [readAutoStartState, settingsVisible]);

  useEffect(() => {
    window.electronAPI?.syncNotificationPreferences?.({
      notificationsEnabled,
      notifyMeetingDetection,
      notifyCalendarReminders,
      meetingProcessDetection,
    });
  }, [
    notificationsEnabled,
    notifyMeetingDetection,
    notifyCalendarReminders,
    meetingProcessDetection,
  ]);

  const handleAutoStartChange = async (enabled: boolean) => {
    if (!window.electronAPI?.setAutoStartEnabled) return;
    try {
      setAutoStartLoading(true);
      const result = await window.electronAPI.setAutoStartEnabled(enabled);
      // Read the state back rather than assuming: on Windows the OS can have the
      // item disabled out from under us, and on macOS it can need approval first.
      if (result.success) await readAutoStartState();
    } catch (error) {
      logger.error("Failed to set auto-start", error, "settings");
    } finally {
      setAutoStartLoading(false);
    }
  };

  const [noteFilesDefaultPath, setNoteFilesDefaultPath] = useState("");
  const [noteFilesRebuilding, setNoteFilesRebuilding] = useState(false);

  useEffect(() => {
    if (!noteFilesEnabled) return;
    window.electronAPI?.noteFilesGetDefaultPath?.().then((p) => {
      if (p) setNoteFilesDefaultPath(p);
    });
  }, [noteFilesEnabled]);

  const handleNoteFilesToggle = useCallback(
    async (enabled: boolean) => {
      setNoteFilesEnabled(enabled);
      await window.electronAPI?.noteFilesSetEnabled?.(enabled, noteFilesPath || undefined);
    },
    [setNoteFilesEnabled, noteFilesPath]
  );

  const handleNoteFilesChangePath = useCallback(async () => {
    const result = await window.electronAPI?.noteFilesPickFolder?.();
    if (result?.canceled || !result?.path) return;
    setNoteFilesPath(result.path);
    await window.electronAPI?.noteFilesSetPath?.(result.path);
  }, [setNoteFilesPath]);

  const handleNoteFilesRebuild = useCallback(async () => {
    setNoteFilesRebuilding(true);
    try {
      const result = await window.electronAPI?.noteFilesRebuild?.();
      if (result && !result.success) {
        toast({
          title: t("settings.noteFiles.rebuildError.title"),
          description: result.error || t("settings.noteFiles.rebuildError.description"),
          variant: "destructive",
        });
      }
    } finally {
      setNoteFilesRebuilding(false);
    }
  }, [toast, t]);

  useEffect(() => {
    let mounted = true;

    const timer = setTimeout(async () => {
      if (!mounted) return;

      const version = await getAppVersion();
      if (version && mounted) setCurrentVersion(version);

      if (mounted) {
        checkWhisperInstallation();
      }
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [checkWhisperInstallation, getAppVersion]);

  useEffect(() => {
    const loadEffectiveDefaultHotkey = async () => {
      try {
        const key = await window.electronAPI?.getEffectiveDefaultHotkey?.();
        if (key) setEffectiveDefaultHotkey(key);
      } catch (error) {
        logger.error("Failed to get effective default hotkey", error, "settings");
      }
    };
    loadEffectiveDefaultHotkey();
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI?.onLinuxPttPermissionDenied?.(() => {
      setLinuxPttAvailable(false);
      toast({
        title: t("settingsPage.general.hotkey.linuxPttPermissionTitle"),
        description: t("settingsPage.general.hotkey.linuxPttPermissionDescription"),
        variant: "destructive",
        duration: 15000,
      });
      setActivationMode("tap");
    });
    return () => cleanup?.();
  }, [toast, t, setActivationMode]);

  useEffect(() => {
    if (installInitiated) {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
      }
      installTimeoutRef.current = setTimeout(() => {
        showAlertDialog({
          title: t("settingsPage.general.updates.dialogs.almostThere.title"),
          description: t("settingsPage.general.updates.dialogs.almostThere.description"),
        });
      }, 10000);
    } else if (installTimeoutRef.current) {
      clearTimeout(installTimeoutRef.current);
      installTimeoutRef.current = null;
    }

    return () => {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
        installTimeoutRef.current = null;
      }
    };
  }, [installInitiated, showAlertDialog, t]);

  const resetAccessibilityPermissions = () => {
    const message = t("settingsPage.permissions.resetAccessibility.description");

    showConfirmDialog({
      title: t("settingsPage.permissions.resetAccessibility.title"),
      description: message,
      onConfirm: () => {
        permissionsHook.requestAccessibilityPermission();
      },
    });
  };

  const { isSignedIn, isLoaded, user, refetch } = useAuth();
  const {
    canToggleSync: canToggleInsightsSync,
    disableInsightsSync,
    enableInsightsSync,
    optInDialog: insightsOptInDialog,
    syncAllowedByPolicy: insightsSyncAllowedByPolicy,
  } = useInsightsSyncOptIn();
  const {
    enabled: leaderboardParticipationEnabled,
    error: leaderboardParticipationError,
    join: joinLeaderboard,
    leave: leaveLeaderboard,
    leavePending: leaderboardLeavePending,
    ready: leaderboardParticipationReady,
    updating: leaderboardParticipationUpdating,
  } = useLeaderboardParticipation();
  const [leaderboardPreferencePending, setLeaderboardPreferencePending] = useState(false);
  const updateLeaderboardParticipation = useCallback(
    async (enabled: boolean) => {
      if (!isSignedIn || !leaderboardParticipationReady || leaderboardPreferencePending) return;
      setLeaderboardPreferencePending(true);
      try {
        if (enabled) {
          if (
            !effectiveDataRetentionEnabled ||
            !insightsSyncAllowedByPolicy ||
            (!insightsSyncEnabled && !(await enableInsightsSync({ confirmWhenEmpty: true })))
          )
            return;
          if (!(await joinLeaderboard())) {
            toast({
              title: t("insights.leaderboard.activationError"),
              variant: "destructive",
            });
          }
          return;
        }

        if (!(await leaveLeaderboard())) {
          toast({ title: t("insights.leaderboard.leavePending") });
        }
      } finally {
        setLeaderboardPreferencePending(false);
      }
    },
    [
      effectiveDataRetentionEnabled,
      enableInsightsSync,
      insightsSyncAllowedByPolicy,
      insightsSyncEnabled,
      isSignedIn,
      joinLeaderboard,
      leaderboardParticipationReady,
      leaderboardPreferencePending,
      leaveLeaderboard,
      t,
      toast,
    ]
  );
  // Signed out there is nothing to load and the plan grid is purely
  // promotional; signed in, no card may claim a plan until usage confirms one.
  const planStateKnown = !isSignedIn || usage?.status === "success";
  const proCardCta = decideProPlanCardCta({
    isSignedIn,
    planStateKnown,
    isPersonallySubscribed: usage?.isPersonallySubscribed ?? false,
    isStoreBilled: Boolean(usage?.storeBilling),
    plan: usage?.plan ?? "free",
    isTrial: usage?.isTrial ?? false,
    isWorkspaceCovered,
  });
  const storeBilling = usage?.storeBilling ?? null;
  const accountPlan = resolveAccountPlan({
    isTrial: usage?.isTrial ?? false,
    isPastDue: usage?.isPastDue ?? false,
    isPersonallySubscribed: usage?.isPersonallySubscribed ?? false,
    storeBilling,
    isWorkspaceCovered,
    hasPeriodEnd: Boolean(usage?.currentPeriodEnd),
    hasCoveringWorkspaceNames: coveringWorkspaceNames.length > 0,
  });
  const storeUrl = storeBilling?.store ? storeSubscriptionsUrl(storeBilling.store) : null;
  const periodEndDate = usage?.currentPeriodEnd
    ? new Date(usage.currentPeriodEnd).toLocaleDateString(i18n.language, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [isDeleteAccountDialogOpen, setIsDeleteAccountDialogOpen] = useState(false);
  const [eraseDeviceData, setEraseDeviceData] = useState(false);
  const { openBillingPortal, isOpening: isOpeningBilling } = useBillingPortal(usage);
  const [billingState, setBillingState] = useState<Record<string, boolean>>({
    pro: true,
    business: true,
  });
  const [checkoutTier, setCheckoutTier] = useState<string | null>(null);
  const [switchPreview, setSwitchPreview] = useState<{
    plan: "monthly" | "annual";
    tier: "pro" | "business";
    immediateAmount: number;
    currency: string;
    newPriceAmount: number;
    newInterval: string;
    nextBillingDate: string | null;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const handleSwitchPlan = useCallback(
    async (plan: "monthly" | "annual", tier: "pro" | "business") => {
      setPreviewLoading(true);
      try {
        const preview = await usage.previewSwitchPlan({ plan, tier });
        if (!preview.success) {
          toast({
            title: t("settingsPage.account.checkout.couldNotOpenTitle"),
            description:
              preview.error || t("settingsPage.account.checkout.couldNotOpenDescription"),
          });
          return;
        }
        if (preview.alreadyOnPlan) {
          toast({ title: t("settingsPage.account.pricing.planSwitched") });
          return;
        }
        setSwitchPreview({
          plan,
          tier,
          immediateAmount: preview.immediateAmount ?? 0,
          currency: preview.currency ?? "usd",
          newPriceAmount: preview.newPriceAmount ?? 0,
          newInterval: preview.newInterval ?? "month",
          nextBillingDate: preview.nextBillingDate ?? null,
        });
      } finally {
        setPreviewLoading(false);
      }
    },
    [usage, toast, t]
  );

  const confirmSwitchPlan = useCallback(async () => {
    if (!switchPreview) return;
    const { plan, tier } = switchPreview;
    setSwitchPreview(null);
    const result = await usage.switchPlan({ plan, tier });
    if (result.success) {
      toast({ title: t("settingsPage.account.pricing.planSwitched") });
    } else {
      toast({
        title: t("settingsPage.account.checkout.couldNotOpenTitle"),
        description: result.error || t("settingsPage.account.checkout.couldNotOpenDescription"),
      });
    }
  }, [switchPreview, usage, toast, t]);

  const handleCheckout = useCallback(
    async (plan: "monthly" | "annual", tier: "pro" | "business") => {
      setCheckoutTier(tier);
      const result = await usage.openCheckout({ plan, tier });
      setCheckoutTier(null);
      if (!result.success) {
        toast({
          title: t("settingsPage.account.checkout.couldNotOpenTitle"),
          description: t("settingsPage.account.checkout.couldNotOpenDescription"),
        });
      }
    },
    [usage, toast, t]
  );

  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      // End a live meeting while its note is still in scope: signing out clears
      // the account scope, and anything said after that could not be saved.
      await stopRecording();
      // Clear account-scoped renderer/session state before ending the session.
      // Workspace-owned rows remain cached behind their membership boundary.
      await syncService.purgeTeamSpacesForSignOut();
      await signOut();
      window.location.reload();
    } catch (error) {
      logger.error("Sign out failed", error, "auth");
      showAlertDialog({
        title: t("settingsPage.account.signOut.failedTitle"),
        description: t("settingsPage.account.signOut.failedDescription"),
      });
    } finally {
      setIsSigningOut(false);
    }
  }, [showAlertDialog, t]);

  const handleDeleteAccount = useCallback(() => {
    setEraseDeviceData(false);
    setIsDeleteAccountDialogOpen(true);
  }, []);

  const confirmDeleteAccount = useCallback(async () => {
    const accountId = user?.id;
    const authGeneration = getValidatedAuthGeneration();
    if (!accountId || authGeneration == null) {
      showAlertDialog({
        title: t("settingsPage.account.deleteAccount.failedTitle"),
        description: t("settingsPage.account.deleteAccount.failedDescription"),
      });
      return;
    }

    setIsDeletingAccount(true);
    try {
      const result = await executeAccountDeletion({
        eraseDeviceData,
        dependencies: {
          deleteRemoteAccount: deleteAccount,
          deleteLocalAccountData: async () => {
            const cleanup = await window.electronAPI?.deleteAccountData?.(
              accountId,
              authGeneration,
              { erasingDevice: eraseDeviceData }
            );
            if (!cleanup?.success) {
              throw new Error(cleanup?.error ?? "Could not remove local account data");
            }
          },
          clearWorkspaceSessionState: () => syncService.purgeTeamSpacesForSignOut(),
          signOut,
          eraseDeviceData: async () => {
            const cleanup = await window.electronAPI?.cleanupApp();
            if (!cleanup?.success) {
              throw new Error(cleanup?.errors?.join(", ") || "Could not erase device data");
            }
          },
        },
      });

      showAlertDialog({
        title: t("settingsPage.account.deleteAccount.successTitle"),
        description:
          result.localCleanupFailures.length > 0
            ? t("settingsPage.account.deleteAccount.partialCleanupDescription")
            : t("settingsPage.account.deleteAccount.successDescription"),
      });
      // cleanup-app leaves the database closed; only a relaunch reopens it.
      setTimeout(() => {
        if (eraseDeviceData) {
          window.electronAPI?.relaunchApp();
        } else {
          window.location.reload();
        }
      }, 1000);
    } catch (error) {
      logger.error("Account deletion failed", error, "auth");
      showAlertDialog({
        title: t("settingsPage.account.deleteAccount.failedTitle"),
        description: t("settingsPage.account.deleteAccount.failedDescription"),
      });
    } finally {
      setIsDeletingAccount(false);
    }
  }, [eraseDeviceData, showAlertDialog, t, user?.id]);

  const renderWhisperVadSettings = () => (
    <div data-setting-id="dictation.stt.vad">
      <SectionHeader
        title={t("settingsPage.transcription.vad.title")}
        description={t("settingsPage.transcription.vad.description")}
      />
      <SettingsPanel>
        <SettingsPanelRow data-setting-id="dictation.stt.vad.dictation">
          <SettingsRow
            label={t("settingsPage.transcription.vad.toggles.dictation.title")}
            description={t("settingsPage.transcription.vad.toggles.dictation.description")}
          >
            <Toggle checked={dictationSileroEnabled} onChange={setDictationSileroEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow data-setting-id="dictation.stt.vad.noteRecording">
          <SettingsRow
            label={t("settingsPage.transcription.vad.toggles.noteRecording.title")}
            description={t("settingsPage.transcription.vad.toggles.noteRecording.description")}
          >
            <Toggle checked={noteRecordingSileroEnabled} onChange={setNoteRecordingSileroEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow data-setting-id="dictation.stt.vad.meeting">
          <SettingsRow
            label={t("settingsPage.transcription.vad.toggles.meeting.title")}
            description={t("settingsPage.transcription.vad.toggles.meeting.description")}
          >
            <Toggle checked={meetingSileroEnabled} onChange={setMeetingSileroEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow data-setting-id="dictation.stt.vad.fields">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.threshold.label")}
                description={t("settingsPage.transcription.vad.fields.threshold.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="0.01"
                min="0.1"
                max="0.95"
                value={whisperVadThreshold}
                onChange={(e) => setWhisperVadThreshold(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.minSpeechDurationMs.label")}
                description={t("settingsPage.transcription.vad.fields.minSpeechDurationMs.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="10"
                min="50"
                max="2000"
                value={whisperVadMinSpeechDurationMs}
                onChange={(e) => setWhisperVadMinSpeechDurationMs(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.minSilenceDurationMs.label")}
                description={t("settingsPage.transcription.vad.fields.minSilenceDurationMs.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="10"
                min="50"
                max="2000"
                value={whisperVadMinSilenceDurationMs}
                onChange={(e) => setWhisperVadMinSilenceDurationMs(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.maxSpeechDurationS.label")}
                description={t("settingsPage.transcription.vad.fields.maxSpeechDurationS.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="1"
                min="5"
                max="120"
                value={whisperVadMaxSpeechDurationS}
                onChange={(e) => setWhisperVadMaxSpeechDurationS(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.speechPadMs.label")}
                description={t("settingsPage.transcription.vad.fields.speechPadMs.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="10"
                min="0"
                max="1000"
                value={whisperVadSpeechPadMs}
                onChange={(e) => setWhisperVadSpeechPadMs(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <VADLabelWithInfo
                label={t("settingsPage.transcription.vad.fields.samplesOverlap.label")}
                description={t("settingsPage.transcription.vad.fields.samplesOverlap.info")}
              />
              <Input
                dir="ltr"
                type="number"
                step="0.01"
                min="0"
                max="0.95"
                value={whisperVadSamplesOverlap}
                onChange={(e) => setWhisperVadSamplesOverlap(Number(e.target.value))}
              />
            </div>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );

  // A section's body. `general` (the old Preferences) is split across pages:
  // `show` picks its blocks, and `soleBlock` is a page made of that one block,
  // whose page header already names it.
  const renderSectionContent = (
    section: SettingsSectionType,
    show: BlockFilter = showAllBlocks,
    soleBlock?: PreferencesBlockId
  ) => {
    switch (section) {
      case "account":
        return (
          <div data-setting-id="account" className="space-y-5">
            {!AUTH_URL ? (
              <>
                <SectionHeader
                  title={t("settingsPage.account.title")}
                  description={t("settingsPage.account.notConfigured")}
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.featuresDisabled")}
                      description={t("settingsPage.account.featuresDisabledDescription")}
                    >
                      <Badge variant="warning">{t("settingsPage.account.disabled")}</Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ) : isLoaded && isSignedIn && user ? (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <ProfileSection
                  name={user.name || ""}
                  onSessionRefresh={() => {
                    void refetch();
                  }}
                />

                <div data-setting-id="account.signOut" className="flex justify-end">
                  <Button
                    onClick={handleSignOut}
                    variant="outline"
                    disabled={isSigningOut}
                    size="sm"
                    className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/50"
                  >
                    <LogOut className="me-1.5 h-3.5 w-3.5" />
                    {isSigningOut
                      ? t("settingsPage.account.signOut.signingOut")
                      : t("settingsPage.account.signOut.signOut")}
                  </Button>
                </div>

                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="account.delete">
                    <SettingsRow
                      label={t("settingsPage.account.deleteAccount.label")}
                      description={t("settingsPage.account.deleteAccount.labelDescription")}
                    >
                      <Button
                        onClick={handleDeleteAccount}
                        variant="outline"
                        disabled={isDeletingAccount}
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                      >
                        <Trash2 className="me-1.5 h-3.5 w-3.5" />
                        {isDeletingAccount
                          ? t("settingsPage.account.deleteAccount.deleting")
                          : t("settingsPage.account.deleteAccount.button")}
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ) : isLoaded ? (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.notSignedIn")}
                      description={t("settingsPage.account.notSignedInDescription")}
                    >
                      <Badge variant="outline">{t("settingsPage.account.offline")}</Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <div
                  data-setting-id="account.signIn"
                  className="rounded-lg border border-primary/20 dark:border-primary/15 bg-primary/3 dark:bg-primary/6 p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center shrink-0 mt-0.5">
                      <Sparkles className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2.5">
                      <div>
                        <p className="text-xs font-medium text-foreground">
                          {t("settingsPage.account.trialCta.title")}
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                          {t("settingsPage.account.trialCta.description")}
                        </p>
                      </div>
                      <Button onClick={requestSignIn} size="sm" className="w-full">
                        <UserCircle className="me-1.5 h-3.5 w-3.5" />
                        {t("settingsPage.account.trialCta.button")}
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            )}
          </div>
        );

      case "plansBilling":
        return (
          <div data-setting-id="plansBilling" className="space-y-5">
            {!AUTH_URL ? (
              <>
                <SectionHeader
                  title={t("settingsPage.account.pricing.title")}
                  description={t("settingsPage.account.notConfigured")}
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.featuresDisabled")}
                      description={t("settingsPage.account.featuresDisabledDescription")}
                    >
                      <Badge variant="warning">{t("settingsPage.account.disabled")}</Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ) : isLoaded ? (
              <>
                {isSignedIn && <WorkspaceBillingOverview onRefreshEntitlement={usage?.refetch} />}
                {isSignedIn ? (
                  <div data-setting-id="plans.personal" className="space-y-5">
                    <SectionHeader title={t("settingsPage.unifiedBilling.personalPlanTitle")} />
                    {usage?.status === "error" ? (
                      <SettingsPanel>
                        <SettingsPanelRow>
                          <SettingsRow
                            label={t("settingsPage.account.planUnavailable.title")}
                            description={t("settingsPage.account.planUnavailable.description")}
                          >
                            <Button
                              onClick={() => void usage.retry()}
                              variant="outline"
                              size="sm"
                              disabled={usage.isRetrying}
                            >
                              {usage.isRetrying ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                t("common.retry")
                              )}
                            </Button>
                          </SettingsRow>
                        </SettingsPanelRow>
                      </SettingsPanel>
                    ) : usage?.status !== "success" ? (
                      <SettingsPanel>
                        <SettingsPanelRow>
                          <div className="flex items-center justify-between">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-5 w-16 rounded-full" />
                          </div>
                        </SettingsPanelRow>
                        <SettingsPanelRow>
                          <div className="space-y-2">
                            <Skeleton className="h-3 w-48" />
                            <Skeleton className="h-8 w-full rounded" />
                          </div>
                        </SettingsPanelRow>
                      </SettingsPanel>
                    ) : (
                      <SettingsPanel>
                        {usage.isPastDue && (
                          <SettingsPanelRow>
                            <Alert
                              variant="warning"
                              className="dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200 dark:[&>svg]:text-amber-400"
                            >
                              <AlertTriangle className="h-4 w-4" />
                              <AlertTitle>{t("settingsPage.account.pastDue.title")}</AlertTitle>
                              <AlertDescription>
                                {t("settingsPage.account.pastDue.description")}
                              </AlertDescription>
                            </Alert>
                          </SettingsPanelRow>
                        )}

                        <SettingsPanelRow>
                          <SettingsRow
                            label={
                              accountPlan.row === "trial"
                                ? t("settingsPage.account.planLabels.trial")
                                : accountPlan.row === "pastDue"
                                  ? t("settingsPage.account.planLabels.free")
                                  : accountPlan.row === "personal" || accountPlan.row === "store"
                                    ? usage.plan === "business"
                                      ? t("settingsPage.account.planLabels.business")
                                      : t("settingsPage.account.planLabels.pro")
                                    : (coveringPlanLabel ??
                                      t("settingsPage.account.planLabels.free"))
                            }
                            description={
                              accountPlan.description === "trial"
                                ? t("settingsPage.account.planDescriptions.trial", {
                                    days: usage.trialDaysLeft,
                                  })
                                : accountPlan.description === "pastDue"
                                  ? t("settingsPage.account.planDescriptions.pastDue", {
                                      used: usage.wordsUsed.toLocaleString(i18n.language),
                                      limit: usage.limit.toLocaleString(i18n.language),
                                    })
                                  : accountPlan.description === "storePaymentIssue"
                                    ? t("settingsPage.account.planDescriptions.storePaymentIssue")
                                    : accountPlan.description === "accessUntil"
                                      ? t("settingsPage.account.planDescriptions.accessUntil", {
                                          date: periodEndDate,
                                        })
                                      : accountPlan.description === "nextBilling"
                                        ? t("settingsPage.account.planDescriptions.nextBilling", {
                                            date: periodEndDate,
                                          })
                                        : accountPlan.description === "unlimited"
                                          ? t("settingsPage.account.planDescriptions.unlimited")
                                          : accountPlan.description === "providedBy"
                                            ? t("settingsPage.unifiedBilling.providedBy", {
                                                workspaces: coveringWorkspaceNames.join(", "),
                                              })
                                            : t("settingsPage.account.planDescriptions.freeUsage", {
                                                used: usage.wordsUsed.toLocaleString(i18n.language),
                                                limit: usage.limit.toLocaleString(i18n.language),
                                              })
                            }
                          >
                            {accountPlan.row === "trial" ? (
                              <Badge variant="info">{t("settingsPage.account.badges.trial")}</Badge>
                            ) : accountPlan.row === "pastDue" ? (
                              <Badge variant="destructive">
                                {t("settingsPage.account.badges.pastDue")}
                              </Badge>
                            ) : accountPlan.row === "personal" || accountPlan.row === "store" ? (
                              <Badge variant="success">
                                {usage.plan === "business"
                                  ? t("settingsPage.account.badges.business")
                                  : t("settingsPage.account.badges.pro")}
                              </Badge>
                            ) : coveringPlanLabel ? (
                              <Badge variant="success">{coveringPlanLabel}</Badge>
                            ) : usage.isOverLimit ? (
                              <Badge variant="warning">
                                {t("settingsPage.account.badges.limitReached")}
                              </Badge>
                            ) : (
                              <Badge variant="outline">
                                {t("settingsPage.account.badges.free")}
                              </Badge>
                            )}
                          </SettingsRow>
                        </SettingsPanelRow>

                        {!usage.isSubscribed && !usage.isTrial && (
                          <SettingsPanelRow>
                            <div className="space-y-1.5">
                              <Progress
                                value={
                                  usage.limit > 0
                                    ? Math.min(100, (usage.wordsUsed / usage.limit) * 100)
                                    : 0
                                }
                                className={cn(
                                  "h-1.5",
                                  usage.isOverLimit
                                    ? "[&>div]:bg-destructive"
                                    : usage.isApproachingLimit
                                      ? "[&>div]:bg-warning"
                                      : "[&>div]:bg-primary"
                                )}
                              />
                              <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span className="tabular-nums">
                                  {usage.wordsUsed.toLocaleString(i18n.language)} /{" "}
                                  {usage.limit.toLocaleString(i18n.language)}
                                </span>
                                {usage.isApproachingLimit && (
                                  <span className="text-warning">
                                    {t("settingsPage.account.wordsRemaining", {
                                      remaining: usage.wordsRemaining.toLocaleString(i18n.language),
                                    })}
                                  </span>
                                )}
                                {!usage.isApproachingLimit && !usage.isOverLimit && (
                                  <span>{t("settingsPage.account.rollingWeeklyLimit")}</span>
                                )}
                              </div>
                            </div>
                          </SettingsPanelRow>
                        )}

                        <SettingsPanelRow>
                          {accountPlan.action === "updatePayment" ? (
                            <Button
                              onClick={() => void openBillingPortal()}
                              disabled={isOpeningBilling}
                              size="sm"
                              className="w-full"
                            >
                              {isOpeningBilling ? (
                                <>
                                  <Loader2 size={14} className="animate-spin" />
                                  {t("settingsPage.account.billing.opening")}
                                </>
                              ) : (
                                t("settingsPage.account.billing.updatePaymentMethod")
                              )}
                            </Button>
                          ) : accountPlan.action === "manageInStore" && storeUrl ? (
                            <Button
                              onClick={() => void window.electronAPI?.openExternal?.(storeUrl)}
                              variant="outline"
                              size="sm"
                              className="w-full"
                            >
                              {storeBilling?.store === "play_store"
                                ? t("settingsPage.account.billing.manageInGooglePlay")
                                : t("settingsPage.account.billing.manageInAppStore")}
                            </Button>
                          ) : accountPlan.action === "storeNote" ? (
                            <p className="text-xs text-muted-foreground">
                              {t("settingsPage.account.billing.managedInMobileStore")}
                            </p>
                          ) : accountPlan.action === "manageBilling" ? (
                            <Button
                              onClick={() => void openBillingPortal()}
                              variant="outline"
                              size="sm"
                              className="w-full"
                              disabled={isOpeningBilling}
                            >
                              {isOpeningBilling
                                ? t("settingsPage.account.billing.opening")
                                : t("settingsPage.account.billing.manageBilling")}
                            </Button>
                          ) : accountPlan.action === "none" ? null : (
                            <Button
                              onClick={async () => {
                                setCheckoutTier("plan-upgrade");
                                const result = await usage.openCheckout({
                                  plan: billingState.pro ? "annual" : "monthly",
                                  tier: "pro",
                                });
                                setCheckoutTier(null);
                                if (!result.success) {
                                  toast({
                                    title: t("settingsPage.account.checkout.couldNotOpenTitle"),
                                    description: t(
                                      "settingsPage.account.checkout.couldNotOpenDescription"
                                    ),
                                    variant: "destructive",
                                  });
                                }
                              }}
                              size="sm"
                              className="w-full"
                              disabled={checkoutTier === "plan-upgrade"}
                            >
                              {checkoutTier === "plan-upgrade"
                                ? t("settingsPage.account.checkout.opening")
                                : t("settingsPage.account.checkout.upgradeToPro")}
                            </Button>
                          )}
                        </SettingsPanelRow>
                      </SettingsPanel>
                    )}
                  </div>
                ) : null}

                <div data-setting-id="plans.pricing" className="space-y-5">
                  <SectionHeader title={t("settingsPage.account.pricing.title")} />
                  <div className={`grid gap-1.5 ${isCompact ? "grid-cols-2" : "grid-cols-4"}`}>
                    <div
                      className={cn(
                        "rounded-md p-2.5 flex flex-col",
                        planStateKnown &&
                          !usage?.isPersonallySubscribed &&
                          !storeBilling &&
                          !usage?.isTrial &&
                          !isWorkspaceCovered
                          ? "border-2 border-primary/30 bg-primary/3 dark:border-primary/20 dark:bg-primary/5"
                          : "border border-border/70 dark:border-border-subtle/60 bg-card/30 dark:bg-surface-2/30"
                      )}
                    >
                      <p className="text-xs font-semibold text-foreground">
                        {t("settingsPage.account.pricing.free.name")}
                      </p>
                      <div className="flex items-baseline gap-0.5 mt-0.5">
                        <span className="text-lg font-bold text-foreground">
                          {t("settingsPage.account.pricing.free.price")}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          / {t("settingsPage.account.pricing.free.period")}
                        </span>
                      </div>
                      <ul className="space-y-0.5 mt-2 flex-1">
                        {(
                          t("settingsPage.account.pricing.free.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) =>
                          feature.startsWith("## ") ? (
                            <li
                              key={i}
                              className={`text-[8px] font-semibold uppercase tracking-wide text-muted-foreground/70 ${i > 0 ? "pt-1.5" : ""}`}
                            >
                              {feature.slice(3)}
                            </li>
                          ) : (
                            <li
                              key={i}
                              className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                            >
                              <Check size={9} className="mt-[2px] text-primary/70 shrink-0" />
                              {feature}
                            </li>
                          )
                        )}
                      </ul>
                      {!isSignedIn ? (
                        <Button
                          onClick={requestSignIn}
                          variant="outline"
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {t("settingsPage.account.signedOutPlans.button")}
                        </Button>
                      ) : usage?.isPersonallySubscribed && !usage?.isTrial ? (
                        <Button
                          onClick={() => void openBillingPortal()}
                          variant="outline"
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                          disabled={isOpeningBilling}
                        >
                          {isOpeningBilling
                            ? t("settingsPage.account.billing.opening")
                            : t("settingsPage.account.pricing.downgrade")}
                        </Button>
                      ) : planStateKnown && !isWorkspaceCovered && !storeBilling ? (
                        <div className="mt-2 text-center">
                          <span className="text-[9px] font-medium text-primary/70">
                            {t("settingsPage.account.pricing.currentPlan")}
                          </span>
                        </div>
                      ) : null}
                    </div>

                    <div
                      className={cn(
                        "rounded-md border-2 p-2.5 flex flex-col",
                        (usage?.isPersonallySubscribed || (storeBilling && !isWorkspaceCovered)) &&
                          usage?.plan === "pro"
                          ? "border-primary/40 bg-primary/5 dark:border-primary/30 dark:bg-primary/8"
                          : "border-primary/20 bg-primary/2 dark:border-primary/15 dark:bg-primary/3"
                      )}
                    >
                      <p className="text-xs font-semibold text-foreground">
                        {t("settingsPage.account.pricing.pro.name")}
                      </p>
                      <button
                        onClick={() => setBillingState((prev) => ({ ...prev, pro: !prev.pro }))}
                        role="switch"
                        aria-checked={billingState.pro}
                        className="flex items-center gap-1.5 mt-1"
                      >
                        <div
                          className={`relative w-7 h-4 rounded-full transition-colors ${billingState.pro ? "bg-primary" : "bg-muted"}`}
                        >
                          <div
                            className={`absolute top-0.5 start-0.5 w-3 h-3 rounded-full bg-white transition-transform ${billingState.pro ? "translate-x-3 rtl:-translate-x-3" : ""}`}
                          />
                        </div>
                        <span className="text-[9px] text-muted-foreground">
                          {t("settingsPage.account.pricing.billedYearly")}
                        </span>
                      </button>
                      <div className="flex items-baseline gap-0.5 mt-1">
                        <span className="text-lg font-bold text-foreground">
                          {billingState.pro
                            ? t("settingsPage.account.pricing.pro.annualEquivalent")
                            : t("settingsPage.account.pricing.pro.monthlyPrice")}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {t("settingsPage.account.pricing.pro.monthlyPeriod")}
                        </span>
                      </div>
                      <p className="text-[9px] text-muted-foreground/70 mt-1.5">
                        {t("settingsPage.account.pricing.pro.includesPrefix")}
                      </p>
                      <ul className="space-y-0.5 mt-1 flex-1">
                        {(
                          t("settingsPage.account.pricing.pro.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                          >
                            <Check size={9} className="mt-[2px] text-primary shrink-0" />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      {proCardCta === "currentPlan" ? (
                        <div className="mt-2 text-center">
                          <span className="text-[9px] font-medium text-primary">
                            {t("settingsPage.account.pricing.currentPlan")}
                          </span>
                        </div>
                      ) : proCardCta === "downgradeToPro" ? (
                        <Button
                          onClick={() =>
                            handleSwitchPlan(billingState.pro ? "annual" : "monthly", "pro")
                          }
                          disabled={previewLoading || usage.checkoutLoading}
                          variant="outline"
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {previewLoading ? (
                            <Loader2 size={10} className="animate-spin" />
                          ) : (
                            t("settingsPage.account.pricing.downgrade")
                          )}
                        </Button>
                      ) : proCardCta === "signUp" ? (
                        <Button
                          onClick={requestSignIn}
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {t("settingsPage.account.pricing.pro.cta")}
                        </Button>
                      ) : proCardCta === "coveredByWorkspace" ? (
                        <div className="mt-2 text-center">
                          <span className="text-[9px] font-medium text-primary">
                            {t("settingsPage.account.pricing.coveredByWorkspace")}
                          </span>
                        </div>
                      ) : proCardCta === "checkout" ? (
                        <Button
                          onClick={() =>
                            handleCheckout(billingState.pro ? "annual" : "monthly", "pro")
                          }
                          disabled={checkoutTier === "pro"}
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {checkoutTier === "pro" ? (
                            <Loader2 size={10} className="animate-spin" />
                          ) : (
                            t("settingsPage.account.pricing.pro.cta")
                          )}
                        </Button>
                      ) : null}
                    </div>

                    <div className="rounded-md border-2 border-primary/50 bg-primary/8 dark:border-primary/40 dark:bg-primary/10 p-2.5 flex flex-col relative">
                      <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-[8px] font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap shadow-sm">
                        {t("settingsPage.account.pricing.business.badge")}
                      </span>
                      <p className="text-xs font-semibold text-foreground">
                        {t("settingsPage.account.pricing.business.name")}
                      </p>
                      <button
                        onClick={() =>
                          setBillingState((prev) => ({ ...prev, business: !prev.business }))
                        }
                        role="switch"
                        aria-checked={billingState.business}
                        className="flex items-center gap-1.5 mt-1"
                      >
                        <div
                          className={`relative w-7 h-4 rounded-full transition-colors ${billingState.business ? "bg-primary" : "bg-muted"}`}
                        >
                          <div
                            className={`absolute top-0.5 start-0.5 w-3 h-3 rounded-full bg-white transition-transform ${billingState.business ? "translate-x-3 rtl:-translate-x-3" : ""}`}
                          />
                        </div>
                        <span className="text-[9px] text-muted-foreground">
                          {t("settingsPage.account.pricing.billedYearly")}
                        </span>
                      </button>
                      <div className="flex items-baseline gap-0.5 mt-1">
                        <span className="text-lg font-bold text-foreground">
                          {billingState.business
                            ? t("settingsPage.account.pricing.business.annualEquivalent")
                            : t("settingsPage.account.pricing.business.monthlyPrice")}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {t("settingsPage.account.pricing.business.monthlyPeriod")}
                        </span>
                      </div>
                      <p className="text-[9px] text-muted-foreground/70 mt-1.5">
                        {t("settingsPage.account.pricing.business.includesPrefix")}
                      </p>
                      <ul className="space-y-0.5 mt-1 flex-1">
                        {(
                          t("settingsPage.account.pricing.business.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                          >
                            <Check size={9} className="mt-[2px] text-primary shrink-0" />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      {!isSignedIn ? (
                        <Button
                          onClick={requestSignIn}
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {t("settingsPage.account.pricing.business.cta")}
                        </Button>
                      ) : (
                        <div className="mt-2 text-center">
                          <span className="text-[9px] font-medium text-primary">
                            {t("settingsPage.unifiedBilling.businessWorkspaceOnly")}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="rounded-md border border-border/70 dark:border-border-subtle/60 bg-card/30 dark:bg-surface-2/30 p-2.5 flex flex-col">
                      <p className="text-xs font-semibold text-foreground">
                        {t("settingsPage.account.pricing.enterprise.name")}
                      </p>
                      <p className="text-[9px] text-muted-foreground mt-1">
                        {t("settingsPage.account.pricing.enterprise.subtitle")}
                      </p>
                      <div className="flex items-baseline gap-0.5 mt-1">
                        <span className="text-lg font-bold text-foreground">
                          {t("settingsPage.account.pricing.enterprise.price")}
                        </span>
                      </div>
                      <p className="text-[9px] text-muted-foreground/70 mt-1.5">
                        {t("settingsPage.account.pricing.enterprise.includesPrefix")}
                      </p>
                      <ul className="space-y-0.5 mt-1 flex-1">
                        {(
                          t("settingsPage.account.pricing.enterprise.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                          >
                            <Check
                              size={9}
                              className="mt-[2px] text-purple-500 dark:text-purple-400 shrink-0"
                            />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      {isSignedIn && enterpriseCta.action !== "contactSales" ? (
                        <div className="mt-2 space-y-1">
                          <Button
                            size="sm"
                            className="w-full h-6 text-[10px]"
                            onClick={() => {
                              if (enterpriseCta.action === "openDialog") {
                                setEnterpriseCheckoutOpen(true);
                              } else {
                                setEnterpriseWorkspaceCreateOpen(true);
                              }
                            }}
                          >
                            {t("settingsPage.account.pricing.enterprise.upgradeCta")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full h-6 text-[10px] text-muted-foreground"
                            onClick={() =>
                              window.electronAPI?.openExternal?.(
                                "https://openwhispr.com/contact-sales"
                              )
                            }
                          >
                            <Mail size={10} />
                            {t("settingsPage.account.pricing.enterprise.cta")}
                          </Button>
                        </div>
                      ) : isSignedIn ? (
                        <div className="mt-2 space-y-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full h-6 text-[10px]"
                            onClick={() =>
                              window.electronAPI?.openExternal?.(
                                "https://openwhispr.com/contact-sales"
                              )
                            }
                          >
                            <Mail size={10} />
                            {t("settingsPage.account.pricing.enterprise.cta")}
                          </Button>
                          {enterpriseCta.action === "contactSales" && enterpriseCta.ownerName && (
                            <p className="text-[10px] text-muted-foreground text-center">
                              {t("settingsPage.account.pricing.enterprise.askOwner", {
                                name: enterpriseCta.ownerName,
                              })}
                            </p>
                          )}
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                          onClick={() =>
                            window.electronAPI?.openExternal?.(
                              "https://openwhispr.com/contact-sales"
                            )
                          }
                        >
                          <Mail size={10} />
                          {t("settingsPage.account.pricing.enterprise.cta")}
                        </Button>
                      )}
                    </div>
                  </div>

                  <Dialog
                    open={!!switchPreview}
                    onOpenChange={(open) => !open && setSwitchPreview(null)}
                  >
                    <DialogContent className="sm:max-w-90">
                      <DialogHeader>
                        <DialogTitle>
                          {t("settingsPage.account.pricing.confirmSwitch.title")}
                        </DialogTitle>
                        <DialogDescription>
                          {switchPreview &&
                            t("settingsPage.account.pricing.confirmSwitch.description", {
                              plan: switchPreview.tier === "pro" ? "Pro" : "Business",
                              interval:
                                switchPreview.plan === "annual"
                                  ? t("settingsPage.account.pricing.confirmSwitch.yearly")
                                  : t("settingsPage.account.pricing.confirmSwitch.monthly"),
                            })}
                        </DialogDescription>
                      </DialogHeader>
                      {switchPreview && (
                        <div className="rounded-lg border border-border/70 dark:border-border-subtle/60 overflow-hidden">
                          <div className="flex justify-between items-center px-3 py-2.5 bg-muted/40 dark:bg-surface-2/50">
                            <span className="text-xs text-muted-foreground">
                              {switchPreview.immediateAmount < 0
                                ? t("settingsPage.account.pricing.confirmSwitch.accountCredit")
                                : t("settingsPage.account.pricing.confirmSwitch.chargeToday")}
                            </span>
                            <span
                              className={cn(
                                "text-sm font-semibold",
                                switchPreview.immediateAmount < 0
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-foreground"
                              )}
                            >
                              {formatAmount(
                                Math.abs(switchPreview.immediateAmount),
                                switchPreview.currency
                              )}
                            </span>
                          </div>
                          <div className="divide-y divide-border/60">
                            <div className="flex justify-between items-center px-3 py-2">
                              <span className="text-xs text-muted-foreground">
                                {t("settingsPage.account.pricing.confirmSwitch.newPrice")}
                              </span>
                              <span className="text-xs font-medium text-foreground">
                                {formatAmount(switchPreview.newPriceAmount, switchPreview.currency)}
                                /
                                {switchPreview.newInterval === "year"
                                  ? t("settingsPage.account.pricing.confirmSwitch.yr")
                                  : t("settingsPage.account.pricing.confirmSwitch.mo")}
                              </span>
                            </div>
                            {switchPreview.nextBillingDate && (
                              <div className="flex justify-between items-center px-3 py-2">
                                <span className="text-xs text-muted-foreground">
                                  {t("settingsPage.account.pricing.confirmSwitch.nextBilling")}
                                </span>
                                <span className="text-xs font-medium text-foreground">
                                  {new Date(switchPreview.nextBillingDate).toLocaleDateString()}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setSwitchPreview(null)}>
                          {t("settingsPage.account.pricing.confirmSwitch.cancel")}
                        </Button>
                        <Button
                          size="sm"
                          onClick={confirmSwitchPlan}
                          disabled={usage?.checkoutLoading}
                        >
                          {usage?.checkoutLoading ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            t("settingsPage.account.pricing.confirmSwitch.confirm")
                          )}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  <EnterpriseCheckoutDialog
                    open={enterpriseCheckoutOpen}
                    onOpenChange={setEnterpriseCheckoutOpen}
                    workspaces={billingWorkspaces}
                    onRefreshEntitlement={usage?.refetch}
                  />
                  <CreateWorkspaceDialog
                    open={enterpriseWorkspaceCreateOpen}
                    onOpenChange={setEnterpriseWorkspaceCreateOpen}
                    onCreated={() => setEnterpriseCheckoutOpen(true)}
                  />
                </div>
              </>
            ) : (
              <>
                <SectionHeader title={t("settingsPage.account.pricing.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            )}
          </div>
        );

      case "workspace":
        return (
          <div data-setting-id="workspace">
            <WorkspaceSection
              initialSubTab={page === "workspace" ? initialSubTab : undefined}
              requestId={subTabRequestId}
            />
          </div>
        );

      case "general":
        return (
          <div className="space-y-6">
            {/* Appearance */}
            {show("appearance") && (
              <div>
                <SectionHeader
                  title={t("settingsPage.general.appearance.title")}
                  description={t("settingsPage.general.appearance.description")}
                />
                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="preferences.theme">
                    <SettingsRow
                      label={t("settingsPage.general.appearance.theme")}
                      description={t("settingsPage.general.appearance.themeDescription")}
                    >
                      <div className="inline-flex items-center gap-px p-0.5 bg-muted/60 dark:bg-surface-2 rounded-md">
                        {(
                          [
                            {
                              value: "light",
                              icon: Sun,
                              label: t("settingsPage.general.appearance.light"),
                            },
                            {
                              value: "dark",
                              icon: Moon,
                              label: t("settingsPage.general.appearance.dark"),
                            },
                            {
                              value: "auto",
                              icon: Monitor,
                              label: t("settingsPage.general.appearance.auto"),
                            },
                          ] as const
                        ).map((option) => {
                          const Icon = option.icon;
                          const isSelected = theme === option.value;
                          return (
                            <button
                              key={option.value}
                              onClick={() => setTheme(option.value)}
                              className={`
                              flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-xs font-medium
                              transition-colors duration-100
                              ${
                                isSelected
                                  ? "bg-background dark:bg-surface-raised text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground"
                              }
                            `}
                            >
                              <Icon className={`w-3 h-3 ${isSelected ? "text-primary" : ""}`} />
                              {option.label}
                            </button>
                          );
                        })}
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Sound Effects */}
            {show("sounds") && (
              <div>
                <SectionHeader title={t("settingsPage.general.soundEffects.title")} />
                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="preferences.sounds.dictation">
                    <SettingsRow
                      label={t("settingsPage.general.soundEffects.dictationSounds")}
                      description={t(
                        "settingsPage.general.soundEffects.dictationSoundsDescription"
                      )}
                    >
                      <Toggle checked={audioCuesEnabled} onChange={setAudioCuesEnabled} />
                    </SettingsRow>
                  </SettingsPanelRow>
                  <SettingsPanelRow data-setting-id="preferences.sounds.pauseMedia">
                    <SettingsRow
                      label={t("settingsPage.general.soundEffects.pauseMedia")}
                      description={t("settingsPage.general.soundEffects.pauseMediaDescription")}
                    >
                      <Toggle checked={pauseMediaOnDictation} onChange={setPauseMediaOnDictation} />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Notifications */}
            {show("notifications") && (
              <div data-setting-id="preferences.notifications">
                {soleBlock !== "notifications" && (
                  <SectionHeader
                    title={t("settingsPage.general.notifications.title")}
                    description={t("settingsPage.general.notifications.description")}
                  />
                )}
                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="preferences.notifications.disableAll">
                    <SettingsRow
                      label={t("settingsPage.general.notifications.disableAll")}
                      description={t("settingsPage.general.notifications.disableAllDescription")}
                    >
                      <Toggle
                        checked={!notificationsEnabled}
                        onChange={(v) => setNotificationsEnabled(!v)}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                  <SettingsPanelRow data-setting-id="preferences.notifications.meetingDetection">
                    <SettingsRow
                      label={t("settingsPage.general.notifications.meetingDetection")}
                      description={t(
                        "settingsPage.general.notifications.meetingDetectionDescription"
                      )}
                    >
                      <Toggle
                        checked={notifyMeetingDetection}
                        onChange={setNotifyMeetingDetection}
                        disabled={!notificationsEnabled}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                  <SettingsPanelRow data-setting-id="preferences.notifications.calendarReminders">
                    <SettingsRow
                      label={t("settingsPage.general.notifications.calendarReminders")}
                      description={t(
                        "settingsPage.general.notifications.calendarRemindersDescription"
                      )}
                    >
                      <Toggle
                        checked={notifyCalendarReminders}
                        onChange={setNotifyCalendarReminders}
                        disabled={!notificationsEnabled}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Clipboard */}
            {show("clipboard") && (
              <div>
                <SectionHeader title={t("settingsPage.general.clipboard.title")} />
                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="dictation.output.autoPaste">
                    <SettingsRow
                      label={t("settingsPage.general.clipboard.autoPaste")}
                      description={t("settingsPage.general.clipboard.autoPasteDescription")}
                    >
                      <Toggle checked={autoPasteEnabled} onChange={setAutoPasteEnabled} />
                    </SettingsRow>
                  </SettingsPanelRow>
                  <SettingsPanelRow data-setting-id="dictation.output.keepInClipboard">
                    <SettingsRow
                      label={t("settingsPage.general.clipboard.keepInClipboard")}
                      description={t("settingsPage.general.clipboard.keepInClipboardDescription")}
                    >
                      <Toggle
                        checked={keepTranscriptionInClipboard}
                        onChange={setKeepTranscriptionInClipboard}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Save Notes as Files */}
            {show("noteFiles") && (
              <div>
                <SectionHeader title={t("settings.noteFiles.title")} />
                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="notes.files.enabled">
                    <SettingsRow
                      label={t("settings.noteFiles.title")}
                      description={t("settings.noteFiles.description")}
                    >
                      <Toggle checked={noteFilesEnabled} onChange={handleNoteFilesToggle} />
                    </SettingsRow>
                  </SettingsPanelRow>
                  {noteFilesEnabled && (
                    <>
                      <SettingsPanelRow data-setting-id="notes.files.path">
                        <SettingsRow
                          label={t("settings.noteFiles.path")}
                          description={
                            <span dir="ltr" className="block break-all">
                              {noteFilesPath || noteFilesDefaultPath || "..."}
                            </span>
                          }
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={handleNoteFilesChangePath}
                          >
                            {t("settings.noteFiles.changePath")}
                          </Button>
                        </SettingsRow>
                      </SettingsPanelRow>
                      <SettingsPanelRow data-setting-id="notes.files.rebuild">
                        <SettingsRow
                          label={t("settings.noteFiles.rebuild")}
                          description={t("settings.noteFiles.rebuildDescription")}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={noteFilesRebuilding}
                            onClick={handleNoteFilesRebuild}
                          >
                            {noteFilesRebuilding ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              t("settings.noteFiles.rebuild")
                            )}
                          </Button>
                        </SettingsRow>
                      </SettingsPanelRow>
                    </>
                  )}
                </SettingsPanel>
              </div>
            )}

            {/* Import from Granola */}
            {show("granolaImport") && <GranolaImportSection showAlertDialog={showAlertDialog} />}

            {/* Floating Icon */}
            {show("floatingIcon") && (
              <div data-setting-id="preferences.floatingIcon">
                {soleBlock !== "floatingIcon" && (
                  <SectionHeader
                    title={t("settingsPage.general.floatingIcon.title")}
                    description={t("settingsPage.general.floatingIcon.description")}
                  />
                )}
                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="preferences.floatingIcon.autoHide">
                    <SettingsRow
                      label={t("settingsPage.general.floatingIcon.autoHide")}
                      description={t("settingsPage.general.floatingIcon.autoHideDescription")}
                    >
                      <Toggle checked={floatingIconAutoHide} onChange={setFloatingIconAutoHide} />
                    </SettingsRow>
                  </SettingsPanelRow>
                  <FloatingIconPlacementRows
                    panelStartPosition={panelStartPosition}
                    setPanelStartPosition={setPanelStartPosition}
                    floatingIconDisplay={floatingIconDisplay}
                    floatingIconDisplayLabel={floatingIconDisplayLabel}
                    setFloatingIconDisplay={setFloatingIconDisplay}
                  />
                  <RecordingIndicatorRows
                    recordingIndicatorStyle={recordingIndicatorStyle}
                    setRecordingIndicatorStyle={setRecordingIndicatorStyle}
                    recordingIndicatorColor={recordingIndicatorColor}
                    setRecordingIndicatorColor={setRecordingIndicatorColor}
                    recordingEdgeStrip={recordingEdgeStrip}
                    setRecordingEdgeStrip={setRecordingEdgeStrip}
                    recordingEdgeStripDisplays={recordingEdgeStripDisplays}
                    setRecordingEdgeStripDisplays={setRecordingEdgeStripDisplays}
                    recordingTrayIndicator={recordingTrayIndicator}
                    setRecordingTrayIndicator={setRecordingTrayIndicator}
                  />
                </SettingsPanel>
              </div>
            )}

            {/* Language: the interface language is on Appearance, the spoken one on Recognition */}
            {(show("language.ui") || show("language.transcription")) && (
              <div>
                <SectionHeader
                  title={t("settings.language.sectionTitle")}
                  description={
                    show("language.ui") && show("language.transcription")
                      ? t("settings.language.sectionDescription")
                      : undefined
                  }
                />
                <SettingsPanel>
                  {show("language.ui") && (
                    <SettingsPanelRow data-setting-id="preferences.uiLanguage">
                      <SettingsRow
                        label={t("settings.language.uiLabel")}
                        description={t("settings.language.uiDescription")}
                      >
                        <LanguageSelector
                          value={uiLanguage}
                          onChange={setUiLanguage}
                          options={UI_LANGUAGE_OPTIONS}
                          className="min-w-32"
                        />
                      </SettingsRow>
                    </SettingsPanelRow>
                  )}
                  {show("language.transcription") && (
                    <SettingsPanelRow data-setting-id="dictation.language">
                      <SettingsRow
                        label={t("settings.language.transcriptionLabel")}
                        description={t("settings.language.transcriptionDescription")}
                      >
                        <LanguageSelector
                          value={preferredLanguage}
                          onChange={(value) =>
                            updateTranscriptionSettings({ preferredLanguage: value })
                          }
                        />
                      </SettingsRow>
                    </SettingsPanelRow>
                  )}
                  {show("language.transcription") && preferredLanguage === "auto" && (
                    <SettingsPanelRow data-setting-id="dictation.language.chineseScript">
                      <SettingsRow
                        label={t("settings.language.chineseScriptLabel")}
                        description={t("settings.language.chineseScriptDescription")}
                      >
                        <Select
                          value={chineseScriptPreference}
                          onValueChange={(value: ChineseScriptPreference) =>
                            updateTranscriptionSettings({ chineseScriptPreference: value })
                          }
                        >
                          <SelectTrigger className="h-7 w-44 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem
                              value="as-transcribed"
                              className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                            >
                              {t("settings.language.chineseScriptAsTranscribed")}
                            </SelectItem>
                            <SelectItem
                              value="simplified"
                              className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                            >
                              {t("settings.language.chineseScriptSimplified")}
                            </SelectItem>
                            <SelectItem
                              value="traditional"
                              className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                            >
                              {t("settings.language.chineseScriptTraditional")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </SettingsRow>
                    </SettingsPanelRow>
                  )}
                </SettingsPanel>
              </div>
            )}

            {/* How a short dictation that comes back with no text ends */}
            {show("quietEmptyDictation") && (
              <SettingsPanel>
                <SettingsPanelRow data-setting-id="dictation.recognition.quietEmpty">
                  <QuietEmptyDictationSetting />
                </SettingsPanelRow>
              </SettingsPanel>
            )}

            {/* Startup */}
            {show("startup") && (
              <div>
                {soleBlock !== "startup" && (
                  <SectionHeader
                    title={t("settingsPage.general.startup.title")}
                    description={t("settingsPage.general.startup.description")}
                  />
                )}
                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="preferences.startup.launchAtLogin">
                    <SettingsRow
                      label={t("settingsPage.general.startup.launchAtLogin")}
                      description={t("settingsPage.general.startup.launchAtLoginDescription")}
                    >
                      <Toggle
                        checked={autoStartEnabled}
                        onChange={(checked: boolean) => handleAutoStartChange(checked)}
                        disabled={autoStartLoading}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                  {autoStartNeedsApproval && (
                    <SettingsPanelRow>
                      <Alert
                        variant="warning"
                        className="dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200 dark:[&>svg]:text-amber-400"
                      >
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle>
                          {t("settingsPage.general.startup.needsApproval.title")}
                        </AlertTitle>
                        <AlertDescription className="space-y-2">
                          <p>{t("settingsPage.general.startup.needsApproval.description")}</p>
                          <Button
                            onClick={() => void window.electronAPI?.openLoginItemsSettings?.()}
                            variant="outline"
                            size="sm"
                          >
                            {t("settingsPage.general.startup.needsApproval.action")}
                          </Button>
                        </AlertDescription>
                      </Alert>
                    </SettingsPanelRow>
                  )}
                  <SettingsPanelRow data-setting-id="preferences.startup.startMinimized">
                    <SettingsRow
                      label={t("settingsPage.general.startup.startMinimized")}
                      description={t("settingsPage.general.startup.startMinimizedDescription")}
                    >
                      <Toggle checked={startMinimized} onChange={setStartMinimized} />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Microphone */}
            {show("microphone") && (
              <div data-setting-id="preferences.microphone">
                <SectionHeader
                  title={t("settingsPage.general.microphone.title")}
                  description={t("settingsPage.general.microphone.description")}
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <MicrophoneSettings
                      microphoneSelectionMode={microphoneSelectionMode}
                      selectedMicDeviceId={selectedMicDeviceId}
                      selectedMicDeviceLabel={selectedMicDeviceLabel}
                      micWarmHoldSeconds={micWarmHoldSeconds}
                      onSelectionModeChange={setMicrophoneSelectionMode}
                      onDeviceSelect={setSelectedMicDevice}
                      onMicWarmHoldSecondsChange={setMicWarmHoldSeconds}
                    />
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Dictionary */}
            {show("autoLearn") && (
              <div>
                <SectionHeader title={t("settingsPage.dictionary.autoLearnTitle")} />
                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="dictation.output.autoLearn">
                    <AutoLearnModeSetting />
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Wayland Paste Diagnostics — only on Linux + Wayland (its guide dialog goes with it) */}
            {show("waylandPaste") && ydotoolStatus?.isLinux && ydotoolStatus?.isWayland && (
              <div data-setting-id="dictation.output.waylandPaste">
                <SectionHeader
                  title={t("settingsPage.general.waylandPaste.title", {
                    defaultValue: "Wayland Paste Setup",
                  })}
                  description={t("settingsPage.general.waylandPaste.description", {
                    defaultValue:
                      "Auto-paste on Wayland uses ydotool or wtype. wtype is preferred on wlroots compositors.",
                  })}
                />
                {(() => {
                  if (ydotoolStatus.isNixOS) {
                    return (
                      <NixOsPasteInfo status={ydotoolStatus} onRecheck={refreshYdotoolStatus} />
                    );
                  }
                  const checks = [
                    {
                      key: "hasWtype",
                      label: "wtype",
                      ok: ydotoolStatus.hasWtype,
                      required: ydotoolStatus.isWlroots || ydotoolStatus.isCosmic,
                      desc: t("settingsPage.general.waylandPaste.wtypeDesc"),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.wtype.step1Title"),
                          desc: t("settingsPage.general.waylandPaste.guide.wtype.step1Desc"),
                          cmds: getLinuxPasteInstallCommands(t, "wtype"),
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.wtype.step2Title"),
                          cmds: [{ cmd: "which wtype" }],
                        },
                      ],
                    },
                    {
                      key: "hasYdotool",
                      label: "ydotool",
                      ok: ydotoolStatus.hasYdotool,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.ydotoolDesc", {
                        defaultValue: "Input automation tool for Wayland",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.ydotool.step1Title", {
                            defaultValue: "Install ydotool",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.ydotool.step1Desc", {
                            defaultValue:
                              "Use your distribution's package manager to install ydotool.",
                          }),
                          cmds: getLinuxPasteInstallCommands(t, "ydotool"),
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.ydotool.step2Title", {
                            defaultValue: "Verify installation",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.ydotool.step2Desc", {
                            defaultValue: "Check that ydotool is available in your PATH.",
                          }),
                          cmds: [{ cmd: "which ydotool" }],
                        },
                      ],
                    },
                    {
                      key: "hasYdotoold",
                      label: "ydotoold",
                      ok: ydotoolStatus.hasYdotoold,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.ydotooldDesc", {
                        defaultValue: "Daemon for ydotool (separate package on Ubuntu/Pop!_OS)",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.ydotoold.step1Title", {
                            defaultValue: "Install ydotoold",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.ydotoold.step1Desc", {
                            defaultValue:
                              "On Ubuntu and Pop!_OS, ydotoold is a separate package. On Fedora, it's included with ydotool.",
                          }),
                          cmds: [
                            {
                              label: "Ubuntu / Pop!_OS / Debian",
                              cmd: "sudo apt install ydotoold",
                            },
                            { label: "Fedora", cmd: "# Already included in the ydotool package" },
                            { label: "Arch Linux", cmd: "# Included in the ydotool package" },
                          ],
                        },
                      ],
                    },
                    {
                      key: "hasUinput",
                      label: "/dev/uinput",
                      ok: ydotoolStatus.hasUinput,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.uinputDesc", {
                        defaultValue: "Kernel input device access",
                      }),
                      note: !ydotoolStatus.hasUinput
                        ? ydotoolStatus.hasUdevRule
                          ? t("settingsPage.general.waylandPaste.uinputRuleFound", {
                              defaultValue: "Rule present but not active. A reboot should fix it.",
                            })
                          : t("settingsPage.general.waylandPaste.uinputRuleMissing", {
                              defaultValue: "no udev rule found",
                            })
                        : undefined,
                      steps:
                        ydotoolStatus.hasUdevRule && !ydotoolStatus.hasUinput
                          ? [
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.ruleFoundTitle",
                                  {
                                    defaultValue: "udev rule already configured",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.ruleFoundDesc",
                                  {
                                    defaultValue:
                                      "The udev rule for /dev/uinput is already on your system but hasn't taken effect. Try reloading:",
                                  }
                                ),
                                cmds: [
                                  {
                                    cmd: "sudo udevadm control --reload-rules && sudo udevadm trigger /dev/uinput",
                                  },
                                ],
                              },
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.rebootTitle",
                                  {
                                    defaultValue: "If reloading didn't help, reboot",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.rebootDesc",
                                  {
                                    defaultValue:
                                      "On some distros, udev changes only apply after a full reboot. Restart your computer and come back to re-check.",
                                  }
                                ),
                              },
                            ]
                          : [
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step1Title",
                                  {
                                    defaultValue: "Create a udev rule",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step1Desc",
                                  {
                                    defaultValue:
                                      "This rule grants access to /dev/uinput for users in the input group.",
                                  }
                                ),
                                cmds: [
                                  {
                                    cmd: 'echo \'KERNEL=="uinput", GROUP="input", MODE="0660", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/70-uinput.rules',
                                  },
                                ],
                              },
                              {
                                title: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step2Title",
                                  {
                                    defaultValue: "Reload udev rules",
                                  }
                                ),
                                desc: t(
                                  "settingsPage.general.waylandPaste.guide.uinput.step2Desc",
                                  {
                                    defaultValue: "Apply the new rule without rebooting.",
                                  }
                                ),
                                cmds: [
                                  {
                                    cmd: "sudo udevadm control --reload-rules && sudo udevadm trigger /dev/uinput",
                                  },
                                ],
                              },
                            ],
                    },
                    {
                      key: "hasGroup",
                      label: t("settingsPage.general.waylandPaste.inputGroup", {
                        defaultValue: "input group",
                      }),
                      ok: ydotoolStatus.hasGroup,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.inputGroupDesc", {
                        defaultValue: "User must be in the input group (requires re-login)",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.group.step1Title", {
                            defaultValue: "Add your user to the input group",
                          }),
                          cmds: [{ cmd: "sudo usermod -aG input $USER" }],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.group.step2Title", {
                            defaultValue: "Log out and back in",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.group.step2Desc", {
                            defaultValue:
                              "Group changes only take effect after a new login session. Log out of your desktop and log back in, then reopen OpenWhispr.",
                          }),
                        },
                      ],
                    },
                    {
                      key: "hasService",
                      label: t("settingsPage.general.waylandPaste.service", {
                        defaultValue: "systemd service",
                      }),
                      ok: ydotoolStatus.hasService,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.serviceDesc", {
                        defaultValue: "User service file for auto-starting ydotoold",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.service.step1Title", {
                            defaultValue: "Create the service directory",
                          }),
                          cmds: [{ cmd: "mkdir -p ~/.config/systemd/user" }],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.service.step2Title", {
                            defaultValue: "Create the service file",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.service.step2Desc", {
                            defaultValue:
                              "This creates a user-level systemd service that starts ydotoold automatically when you log in.",
                          }),
                          cmds: [
                            {
                              cmd: `cat > ~/.config/systemd/user/ydotoold.service << 'EOF'
[Unit]
Description=ydotoold - ydotool daemon
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=/usr/bin/ydotoold
Restart=on-failure
RestartSec=1s

[Install]
WantedBy=graphical-session.target
EOF`,
                            },
                          ],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.service.step3Title", {
                            defaultValue: "Reload and enable",
                          }),
                          cmds: [
                            {
                              cmd: "systemctl --user daemon-reload && systemctl --user enable ydotoold",
                            },
                          ],
                        },
                      ],
                    },
                    {
                      key: "daemonRunning",
                      label: t("settingsPage.general.waylandPaste.daemon", {
                        defaultValue: "ydotoold daemon",
                      }),
                      ok: ydotoolStatus.daemonRunning,
                      required: !ydotoolStatus.isWlroots,
                      desc: t("settingsPage.general.waylandPaste.daemonDesc", {
                        defaultValue: "Background service must be running",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.daemon.step1Title", {
                            defaultValue: "Start the daemon",
                          }),
                          desc: t("settingsPage.general.waylandPaste.guide.daemon.step1Desc", {
                            defaultValue: "Start ydotoold and enable it so it runs on every login.",
                          }),
                          cmds: [
                            {
                              cmd: "systemctl --user enable ydotoold && systemctl --user start ydotoold",
                            },
                            {
                              label: "Arch Linux (service is named ydotool.service)",
                              cmd: "systemctl --user enable --now ydotool.service",
                            },
                          ],
                        },
                        {
                          title: t("settingsPage.general.waylandPaste.guide.daemon.step2Title", {
                            defaultValue: "Verify it's running",
                          }),
                          cmds: [
                            { cmd: "systemctl --user status ydotoold" },
                            {
                              label: "Arch Linux",
                              cmd: "systemctl --user status ydotool.service",
                            },
                          ],
                        },
                      ],
                    },
                  ];

                  if (ydotoolStatus.isKde) {
                    checks.push({
                      key: "hasXclip",
                      label: "xclip",
                      ok: ydotoolStatus.hasXclip || ydotoolStatus.hasXsel || false,
                      required: true,
                      desc: t("settingsPage.general.waylandPaste.xclipDesc", {
                        defaultValue: "Clipboard tool for KDE Wayland paste (xclip or xsel)",
                      }),
                      steps: [
                        {
                          title: t("settingsPage.general.waylandPaste.guide.xclip.step1Title", {
                            defaultValue: "Install xclip",
                          }),
                          cmds: [
                            { cmd: "sudo dnf install xclip  # Fedora" },
                            { cmd: "sudo apt install xclip  # Debian/Ubuntu" },
                          ],
                        },
                      ],
                    });
                  }

                  const allOk = checks.filter((c) => c.required).every((c) => c.ok);
                  const activeGuide = checks.find((c) => c.key === ydotoolGuideKey);

                  return (
                    <>
                      {allOk ? (
                        <SettingsPanel>
                          <SettingsPanelRow>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <CircleCheck className="h-4 w-4 text-emerald-500" />
                                <span className="text-sm">
                                  {t("settingsPage.general.waylandPaste.allGoodDesc", {
                                    defaultValue: "Auto-paste is ready to go.",
                                  })}
                                </span>
                              </div>
                              <button
                                onClick={refreshYdotoolStatus}
                                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                              >
                                <RotateCw className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </SettingsPanelRow>
                        </SettingsPanel>
                      ) : (
                        <>
                          <div className="rounded-xl border border-border overflow-hidden">
                            <div className="divide-y divide-border">
                              {checks.map((item) => (
                                <div key={item.key} className="px-4 py-3">
                                  <div className="flex items-center gap-2.5">
                                    {item.ok ? (
                                      <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" />
                                    ) : (
                                      <CircleX className="h-4 w-4 shrink-0 text-red-500" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <span className="text-sm font-medium">{item.label}</span>
                                      <span className="text-xs text-muted-foreground ms-2">
                                        {item.desc}
                                      </span>
                                      {item.note && (
                                        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                                          {item.note}
                                        </p>
                                      )}
                                    </div>
                                    {!item.ok && (
                                      <button
                                        onClick={() => setYdotoolGuideKey(item.key)}
                                        className="shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted transition-colors text-foreground"
                                      >
                                        <BookOpen className="w-3 h-3" />
                                        {t("settingsPage.general.waylandPaste.guide.open", {
                                          defaultValue: "Guide",
                                        })}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                          <button
                            onClick={refreshYdotoolStatus}
                            className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <RotateCw className="w-3 h-3" />
                            {t("settingsPage.general.waylandPaste.recheck", {
                              defaultValue: "Re-check",
                            })}
                          </button>
                        </>
                      )}

                      {/* Step-by-step guide dialog */}
                      <Dialog
                        open={!!activeGuide}
                        onOpenChange={(open) => !open && setYdotoolGuideKey(null)}
                      >
                        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
                          {activeGuide && (
                            <>
                              <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                  <BookOpen className="w-4 h-4" />
                                  {activeGuide.label}
                                </DialogTitle>
                                <DialogDescription>{activeGuide.desc}</DialogDescription>
                              </DialogHeader>
                              <div className="space-y-5 mt-2">
                                {activeGuide.steps.map((step, i) => (
                                  <div key={i}>
                                    <div className="flex items-start gap-3">
                                      <span className="shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">
                                        {i + 1}
                                      </span>
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium">{step.title}</p>
                                        {step.desc && (
                                          <p className="text-xs text-muted-foreground mt-0.5">
                                            {step.desc}
                                          </p>
                                        )}
                                        {step.cmds && step.cmds.length > 0 && (
                                          <div className="mt-2 space-y-2">
                                            {step.cmds.map((c, j) => (
                                              <div key={j}>
                                                {c.label && (
                                                  <p className="text-[11px] text-muted-foreground mb-1">
                                                    {c.label}
                                                  </p>
                                                )}
                                                <div className="flex items-start gap-1.5">
                                                  <pre
                                                    dir="ltr"
                                                    className="flex-1 text-[11px] bg-muted/60 rounded-md px-3 py-2 font-mono whitespace-pre-wrap break-all select-all overflow-x-auto"
                                                  >
                                                    {c.cmd}
                                                  </pre>
                                                  <button
                                                    onClick={() =>
                                                      navigator.clipboard.writeText(c.cmd)
                                                    }
                                                    className="shrink-0 p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                                                    title={t(
                                                      "settingsPage.general.waylandPaste.copy",
                                                      { defaultValue: "Copy" }
                                                    )}
                                                  >
                                                    <Copy className="w-3.5 h-3.5" />
                                                  </button>
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </DialogContent>
                      </Dialog>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        );

      case "hotkeys": {
        // Hidden under a native shortcut except on Linux, as before; style keys follow it too.
        const showActivationMode = !isUsingNativeShortcut || getCachedPlatform() === "linux";
        const dictationModeLabel = showActivationMode
          ? t(activationMode === "push" ? "common.hold" : "common.tap")
          : null;
        return (
          <div className="space-y-6">
            {isUsingHyprland && hyprlandConfigStatus && !hyprlandConfigStatus.canWrite && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertTitle>
                  {t("settingsPage.general.hotkey.hyprlandConfigWriteWarningTitle")}
                </AlertTitle>
                <AlertDescription>
                  <BidiInterpolatedText
                    text={t("settingsPage.general.hotkey.hyprlandConfigWriteWarningDescription", {
                      path: BIDI_VALUE_TOKEN,
                    })}
                    value={hyprlandConfigStatus.path}
                  />
                </AlertDescription>
              </Alert>
            )}

            {/* Activation mode: the dictation hotkey's Hold or Tap, which style hotkeys follow */}
            {showActivationMode && (
              <SettingsPanel>
                <SettingsPanelRow data-setting-id="hotkeys.activationMode">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground">
                        {t("settingsPage.general.hotkey.activationMode")}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
                        {t("settingsHotkeys.activation.description")}
                      </p>
                    </div>
                    <ActivationModeSelector
                      value={activationMode}
                      onChange={setActivationMode}
                      pushDisabledReason={pushToTalkUnavailableReason ?? undefined}
                    />
                  </div>
                  {/* Denied input access gets the setup box below instead. */}
                  {pushToTalkUnavailableReason && !linuxInputAccessDenied && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {pushToTalkUnavailableReason}
                    </p>
                  )}
                  {getCachedPlatform() === "linux" &&
                    (activationMode === "push" || linuxInputAccessDenied) && (
                      <LinuxPttSetupInfo
                        isAvailable={!linuxInputAccessDenied && linuxPttAvailable}
                      />
                    )}
                </SettingsPanelRow>
              </SettingsPanel>
            )}

            {/* Every hotkey in one table; each row keeps its existing control */}
            <div>
              <SectionHeader
                title={t("settingsHotkeys.table.title")}
                description={t("settingsHotkeys.table.description")}
                note={isUsingHyprland && t("settingsPage.general.hotkey.hyprlandUnbindDescription")}
              />
              <HotkeyTable label={t("settingsHotkeys.table.title")}>
                {/* Dictation Hotkey */}
                <HotkeyTableRow
                  data-setting-id="hotkeys.dictation"
                  rowId="dictation"
                  action={t("settingsPage.general.hotkey.title")}
                  description={t("settingsPage.general.hotkey.description")}
                  how={dictationModeLabel ?? "—"}
                  actions={
                    <HotkeyFeatureLink
                      label={t("settingsNav.parents.dictation")}
                      onClick={() => onNavigate?.("overview")}
                    />
                  }
                >
                  <HotkeyListInput
                    value={dictationKey}
                    onChange={(list) => registerHotkey(list)}
                    validate={validateDictationHotkey}
                    disabled={isHotkeyRegistering}
                    maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
                    required
                    footerEnd={
                      effectiveDefaultHotkey &&
                      dictationKey &&
                      dictationKey !== effectiveDefaultHotkey ? (
                        <button
                          onClick={() => registerHotkey(effectiveDefaultHotkey)}
                          disabled={isHotkeyRegistering}
                          className="text-xs text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
                        >
                          <BidiInterpolatedText
                            text={t("settingsPage.general.hotkey.resetToDefault", {
                              hotkey: BIDI_VALUE_TOKEN,
                            })}
                            value={formatHotkeyLabel(effectiveDefaultHotkey)}
                          />
                        </button>
                      ) : null
                    }
                  />
                </HotkeyTableRow>

                {/* Style Hotkeys (read-only; set in Styles) */}
                <StyleHotkeysList onOpenStyle={openStyleInStudio} modeLabel={dictationModeLabel} />

                {/* Voice Agent Hotkey */}
                {agentAllowedByPolicy && (
                  <HotkeyTableRow
                    data-setting-id="hotkeys.assistant"
                    rowId="assistant"
                    action={t("settingsPage.general.voiceAgentHotkey.title")}
                    description={t("settingsPage.general.voiceAgentHotkey.description")}
                    how={t("common.tap")}
                    actions={
                      <HotkeyFeatureLink
                        label={t(SETTINGS_PAGES.assistant.titleKey)}
                        onClick={() => onNavigate?.("assistant")}
                      />
                    }
                  >
                    <HotkeyListInput
                      value={voiceAgentKey}
                      onChange={(list) => commitAgentHotkey(setVoiceAgentKey, list)}
                      onClear={() => commitAgentHotkey(setVoiceAgentKey, "")}
                      validate={validateVoiceAgentHotkey}
                      disabled={isAgentHotkeyCommitting}
                      maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
                    />
                  </HotkeyTableRow>
                )}

                {/* Translation Hotkey */}
                <HotkeyTableRow
                  data-setting-id="hotkeys.translation"
                  rowId="translation"
                  action={t("settingsPage.general.translationHotkey.title")}
                  description={t("settingsPage.general.translationHotkey.description")}
                  how={t("common.tap")}
                  actions={
                    <HotkeyFeatureLink
                      label={t(SETTINGS_PAGES.translation.titleKey)}
                      onClick={() => onNavigate?.("translation")}
                    />
                  }
                >
                  <HotkeyListInput
                    value={translationKey}
                    onChange={(list) => commitAgentHotkey(setTranslationKey, list)}
                    onClear={() => commitAgentHotkey(setTranslationKey, "")}
                    validate={validateTranslationHotkey}
                    disabled={isAgentHotkeyCommitting}
                    maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
                  />
                </HotkeyTableRow>

                {/* Review Last Dictation Hotkey (no default) */}
                <HotkeyTableRow
                  data-setting-id="hotkeys.review"
                  rowId="review"
                  action={t("settingsPage.general.reviewHotkey.title")}
                  description={t("settingsPage.general.reviewHotkey.description")}
                  how={t("common.tap")}
                  actions={
                    <HotkeyFeatureLink
                      label={t("sidebar.history")}
                      onClick={() => onOpenElsewhere?.({ view: "history" })}
                    />
                  }
                >
                  <HotkeyListInput
                    value={reviewKey}
                    onChange={(list) => registerReviewHotkey(list)}
                    onClear={async (): Promise<boolean> => {
                      const result = await window.electronAPI?.registerReviewHotkey?.("");
                      if (!result?.success) {
                        showAlertDialog({
                          title: t("hooks.hotkeyRegistration.titles.notRegistered"),
                          description:
                            result?.message ||
                            t("hooks.hotkeyRegistration.errors.couldNotRegister"),
                        });
                        return false;
                      }
                      setReviewKey("");
                      return true;
                    }}
                    validate={validateReviewHotkey}
                    disabled={isReviewHotkeyRegistering}
                    maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
                  />
                </HotkeyTableRow>

                {/* Meeting Mode Hotkey */}
                <HotkeyTableRow
                  data-setting-id="hotkeys.meeting"
                  rowId="meeting"
                  action={t("settingsPage.general.meetingHotkey.title")}
                  description={t("settingsPage.general.meetingHotkey.description")}
                  how={t("common.tap")}
                  actions={
                    <HotkeyFeatureLink
                      label={t(SETTINGS_PAGES.liveRecording.titleKey)}
                      onClick={() => onNavigate?.("liveRecording")}
                    />
                  }
                >
                  <HotkeyListInput
                    value={meetingKey}
                    onChange={(list) => registerMeetingHotkey(list)}
                    onClear={async (): Promise<boolean> => {
                      const result = await window.electronAPI?.registerMeetingHotkey?.("");
                      if (!result?.success) {
                        showAlertDialog({
                          title: t("hooks.hotkeyRegistration.titles.notRegistered"),
                          description:
                            result?.message ||
                            t("hooks.hotkeyRegistration.errors.couldNotRegister"),
                        });
                        return false;
                      }
                      setMeetingKey("");
                      return true;
                    }}
                    validate={validateMeetingHotkey}
                    disabled={isMeetingHotkeyRegistering}
                    maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
                  />
                  <div
                    data-setting-id="hotkeys.meetingLayout"
                    className="mt-3 flex flex-wrap items-center justify-between gap-3"
                  >
                    <span className="text-xs text-muted-foreground/80">
                      {t("settingsPage.general.meetingHotkey.layoutLabel")}
                    </span>
                    <Select
                      value={meetingHotkeyLayoutMode}
                      onValueChange={(value) =>
                        setMeetingHotkeyLayoutMode(value as "side-panel" | "full-width")
                      }
                    >
                      <SelectTrigger className="h-7 w-36 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem
                          value="full-width"
                          className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                        >
                          {t("settingsPage.general.meetingHotkey.layoutFullWidth")}
                        </SelectItem>
                        <SelectItem
                          value="side-panel"
                          className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                        >
                          {t("settingsPage.general.meetingHotkey.layoutSidePanel")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </HotkeyTableRow>

                {/* Cancel: Esc while recording (fixed, shown for reference) */}
                <HotkeyTableRow
                  data-setting-id="hotkeys.cancel"
                  rowId="cancel"
                  action={t("settingsHotkeys.cancel.title")}
                  description={t("settingsHotkeys.cancel.description")}
                  how={t("settingsHotkeys.how.whileRecording")}
                >
                  <div className="@2xl:pt-0.5">
                    <HotkeyKbd>Esc</HotkeyKbd>
                  </div>
                </HotkeyTableRow>
              </HotkeyTable>
            </div>
          </div>
        );
      }

      case "speechToText":
      case "llms":
        return null;

      case "privacyData":
        return (
          <div className="space-y-6">
            {/* Privacy */}
            <div>
              <SectionHeader
                title={t("settingsPage.privacy.title")}
                description={t("settingsPage.privacy.description")}
              />

              <OpenWhisprCloudSwitch isSignedIn={isSignedIn} />

              {isSignedIn && (
                <div className="mb-4">
                  <SettingsPanel className="mb-2">
                    <SettingsPanelRow data-setting-id="privacy.cloudBackup">
                      <SettingsRow
                        label={t("settingsPage.privacy.cloudBackup")}
                        description={
                          cloudBackupPolicyAllowed
                            ? t("settingsPage.privacy.cloudBackupDescription")
                            : t("common.managedByOrg")
                        }
                      >
                        <Toggle
                          checked={cloudBackupEnabled}
                          disabled={
                            !canChangeCloudBackupPreference(
                              cloudBackupPolicyAllowed,
                              cloudBackupEnabled
                            )
                          }
                          onChange={(v) => {
                            setCloudBackupEnabled(v);
                            if (v) {
                              startMigration().catch(console.error);
                              syncService.requestSyncAll("manual");
                            }
                          }}
                        />
                      </SettingsRow>
                    </SettingsPanelRow>
                  </SettingsPanel>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("settingsPage.privacy.cloudBackupTeamCaveat")}
                  </p>
                  {migration && (
                    <div className="mt-2 space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t("settingsPage.privacy.cloudNotesMigration", {
                            done: migration.done,
                            total: migration.total,
                          })}
                        </span>
                        <span>{Math.round((migration.done / migration.total) * 100)}%</span>
                      </div>
                      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all duration-300 ease-out"
                          style={{ width: `${(migration.done / migration.total) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {!migration && cloudBackupEnabled && isSignedIn && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("settingsPage.privacy.cloudNotesMigrationDone")}
                    </p>
                  )}
                  {cloudBackupEnabled &&
                    isSignedIn &&
                    (() => {
                      const lastSyncedAt = localStorage.getItem("lastSyncedAt");
                      if (!lastSyncedAt) return null;
                      const date = new Date(lastSyncedAt);
                      const now = new Date();
                      const diffMs = now.getTime() - date.getTime();
                      const diffMin = Math.floor(diffMs / 60000);
                      const diffHr = Math.floor(diffMs / 3600000);
                      let relative: string;
                      if (diffMin < 1) relative = t("settingsPage.privacy.justNow");
                      else if (diffMin < 60)
                        relative = t("settingsPage.privacy.minutesAgo", { count: diffMin });
                      else if (diffHr < 24)
                        relative = t("settingsPage.privacy.hoursAgo", { count: diffHr });
                      else
                        relative = date.toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        });
                      return (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("settingsPage.privacy.lastSynced", { time: relative })}
                        </p>
                      );
                    })()}
                </div>
              )}

              {/* Insights sync, the leaderboard and usage analytics all go to
                  OpenWhispr: gone with the account & Cloud switch off. */}
              {!cloudDisabled && (
                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="privacy.insightsSync">
                    <SettingsRow
                      label={t("settingsPage.privacy.insightsSync")}
                      description={
                        !isSignedIn
                          ? t("settingsPage.privacy.insightsSyncRequiresAccount")
                          : !insightsSyncAllowedByPolicy
                            ? t("common.managedByOrg")
                            : effectiveDataRetentionEnabled
                              ? t("settingsPage.privacy.insightsSyncDescription")
                              : t("settingsPage.privacy.insightsSyncRequiresHistory")
                      }
                    >
                      {/* With history off nothing is counted anywhere: this
                        device records no counter, and the cloud writes none
                        either, because analyticsSyncEnabled withholds the
                        localDate its analytics write requires. Turning this on
                        could therefore only promise a sync that never happens —
                        but an already-on toggle must stay switchable off. */}
                      <Toggle
                        checked={insightsSyncEnabled}
                        disabled={
                          !isSignedIn ||
                          !canToggleInsightsSync ||
                          (!effectiveDataRetentionEnabled && !insightsSyncEnabled)
                        }
                        onChange={(enabled) => {
                          if (enabled) void enableInsightsSync();
                          else disableInsightsSync();
                        }}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                  <SettingsPanelRow data-setting-id="privacy.leaderboard">
                    <SettingsRow
                      label={t("insights.leaderboard.title")}
                      description={
                        !isSignedIn
                          ? t("settingsPage.privacy.leaderboardRequiresAccount")
                          : leaderboardParticipationError === "read"
                            ? t("insights.leaderboard.activationError")
                            : leaderboardLeavePending
                              ? t("insights.leaderboard.leavePending")
                              : !insightsSyncAllowedByPolicy
                                ? t("common.managedByOrg")
                                : !effectiveDataRetentionEnabled
                                  ? t("settingsPage.privacy.leaderboardRequiresHistory")
                                  : t("settingsPage.privacy.leaderboardDescription")
                      }
                    >
                      <Toggle
                        checked={isSignedIn && leaderboardParticipationEnabled}
                        disabled={
                          !isSignedIn ||
                          !leaderboardParticipationReady ||
                          leaderboardPreferencePending ||
                          leaderboardParticipationUpdating ||
                          leaderboardParticipationError === "read" ||
                          (!leaderboardParticipationEnabled &&
                            (!effectiveDataRetentionEnabled ||
                              !insightsSyncAllowedByPolicy ||
                              (!insightsSyncEnabled && !canToggleInsightsSync)))
                        }
                        onChange={(enabled) => void updateLeaderboardParticipation(enabled)}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                  <SettingsPanelRow data-setting-id="privacy.usageAnalytics">
                    <SettingsRow
                      label={t("settingsPage.privacy.usageAnalytics")}
                      description={t("settingsPage.privacy.usageAnalyticsDescription")}
                    >
                      <Toggle checked={telemetryEnabled} onChange={setTelemetryEnabled} />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              )}
            </div>

            {/* Data Retention (recordings and logs are managed on Storage; summarized here) */}
            <div className="border-t border-border/70 pt-6">
              <SettingsPanel>
                <SettingsPanelRow data-setting-id="privacy.history">
                  <SettingsRow
                    label={t("settingsPage.privacy.dataRetention")}
                    description={
                      historyLockedByPolicy
                        ? t("common.managedByOrg")
                        : t("settingsPage.privacy.dataRetentionDescription")
                    }
                  >
                    <Toggle
                      checked={effectiveDataRetentionEnabled}
                      disabled={historyLockedByPolicy}
                      onChange={setDataRetentionEnabled}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow data-setting-id="privacy.transcriptRetention">
                  <SettingsRow
                    label={t("settingsPage.privacy.transcriptRetention")}
                    description={t("settingsPage.privacy.transcriptRetentionDescription")}
                  >
                    <select
                      value={transcriptRetentionDays}
                      disabled={!effectiveDataRetentionEnabled}
                      onChange={(e) => setTranscriptRetentionDays(parseInt(e.target.value, 10))}
                      className={RETENTION_SELECT_CLASS}
                    >
                      {transcriptRetentionChoices(transcriptRetentionDays).map((days) => (
                        <option key={days} value={days}>
                          {days === 0
                            ? t("settingsPage.privacy.transcriptRetentionForever")
                            : retentionPeriodLabel(days, t)}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow data-setting-id="privacy.saveDiscarded">
                  <SettingsRow
                    label={t("settingsPage.privacy.saveDiscarded")}
                    description={t("settingsPage.privacy.saveDiscardedDescription")}
                  >
                    <Toggle
                      checked={saveDiscardedTranscriptions}
                      disabled={!effectiveDataRetentionEnabled || enforcedAudioRetentionDays === 0}
                      onChange={setSaveDiscardedTranscriptions}
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <PrivacyStorageSummary showing={page === "privacyData"} />
              </SettingsPanel>
            </div>

            {/* Permissions */}
            <div data-setting-id="privacy.permissions" className="border-t border-border/70 pt-6">
              <SectionHeader
                title={t("settingsPage.permissions.title")}
                description={t("settingsPage.permissions.description")}
              />

              <div className="space-y-3">
                <PermissionCard
                  data-setting-id="privacy.permissions.microphone"
                  icon={Mic}
                  title={t("settingsPage.permissions.microphoneTitle")}
                  description={t("settingsPage.permissions.microphoneDescription")}
                  granted={permissionsHook.micPermissionGranted}
                  onRequest={permissionsHook.requestMicPermission}
                  buttonText={t("settingsPage.permissions.grantAccess")}
                />

                {(platform === "darwin" || canManageSystemAudioInApp(systemAudio)) && (
                  <>
                    {platform === "darwin" && (
                      <PermissionCard
                        data-setting-id="privacy.permissions.accessibility"
                        icon={Shield}
                        title={t("settingsPage.permissions.accessibilityTitle")}
                        description={t("settingsPage.permissions.accessibilityDescription")}
                        granted={permissionsHook.accessibilityPermissionGranted}
                        onRequest={permissionsHook.requestAccessibilityPermission}
                        buttonText={t("settingsPage.permissions.grantAccess")}
                      />
                    )}
                    {canManageSystemAudioInApp(systemAudio) && (
                      <PermissionCard
                        data-setting-id="privacy.permissions.systemAudio"
                        icon={Monitor}
                        title={t("settingsPage.permissions.systemAudioTitle")}
                        description={t("settingsPage.permissions.systemAudioDescription")}
                        granted={systemAudio.granted}
                        onRequest={systemAudio.request}
                        buttonText={t("settingsPage.permissions.grantAccess")}
                        badge={t("settingsPage.permissions.optional")}
                      />
                    )}
                  </>
                )}
              </div>

              {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
                <MicPermissionWarning
                  error={permissionsHook.micPermissionError}
                  onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                  onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
                />
              )}

              {platform === "linux" &&
                permissionsHook.pasteToolsInfo &&
                needsLinuxPasteToolGuidance(permissionsHook.pasteToolsInfo) && (
                  <PasteToolsInfo
                    pasteToolsInfo={permissionsHook.pasteToolsInfo}
                    isChecking={permissionsHook.isCheckingPasteTools}
                    onCheck={permissionsHook.checkPasteToolsAvailability}
                  />
                )}

              {platform === "darwin" && (
                <div className="mt-5">
                  <p className="text-xs font-medium text-foreground mb-3">
                    {t("settingsPage.permissions.troubleshootingTitle")}
                  </p>
                  <SettingsPanel>
                    <SettingsPanelRow data-setting-id="privacy.permissions.resetAccessibility">
                      <SettingsRow
                        label={t("settingsPage.permissions.resetAccessibility.label")}
                        description={t(
                          "settingsPage.permissions.resetAccessibility.rowDescription"
                        )}
                      >
                        <Button
                          onClick={resetAccessibilityPermissions}
                          variant="ghost"
                          size="sm"
                          className="text-foreground/70 hover:text-foreground"
                        >
                          {t("settingsPage.permissions.troubleshoot")}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>
              )}
            </div>
          </div>
        );

      case "system":
        return (
          <div className="space-y-6">
            <BuildInfoPanel
              showing={page === "system"}
              fallbackVersion={currentVersion}
              updateAvailable={isUpdateAvailable}
              updatesSupported={updateStatus.isSupported}
            />

            {/* Software Updates */}
            <div className="border-t border-border/70 pt-6">
              <SectionHeader title={t("settingsPage.general.updates.title")} />
              <SettingsPanel>
                {updateStatus.isSupported ? (
                  <SettingsPanelRow data-setting-id="system.updates.auto">
                    <SettingsRow
                      label={t("settingsPage.general.updates.automaticUpdates")}
                      description={t("settingsPage.general.updates.automaticUpdatesDescription")}
                    >
                      <Toggle checked={autoUpdatesEnabled} onChange={setAutoUpdatesEnabled} />
                    </SettingsRow>
                  </SettingsPanelRow>
                ) : (
                  <SettingsPanelRow data-setting-id="system.updates.auto">
                    <SettingsRow
                      label={t("settingsPage.general.updates.automaticUpdates")}
                      description={
                        updateStatus.isDevelopment
                          ? t("settingsPage.general.updates.devMode")
                          : updateStatus.isSelfBuilt
                            ? t("settingsPage.general.updates.selfBuilt")
                            : t("settingsPage.general.updates.managedByPackageManager")
                      }
                    >
                      <Badge variant="outline">
                        {t("settingsPage.general.updates.notAvailable")}
                      </Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                )}

                {(isUpdateAvailable ||
                  updateStatus.updateDownloaded ||
                  updateInfo?.releaseNotes) && (
                  <SettingsPanelRow>
                    <div className="space-y-2.5">
                      {isUpdateAvailable && !updateStatus.updateDownloaded && (
                        <div className="space-y-2">
                          <Button
                            onClick={async () => {
                              try {
                                await downloadUpdate();
                              } catch {
                                showAlertDialog({
                                  title: t(
                                    "settingsPage.general.updates.dialogs.downloadFailed.title"
                                  ),
                                  description: t(
                                    "settingsPage.general.updates.dialogs.downloadFailed.description"
                                  ),
                                });
                              }
                            }}
                            disabled={downloadingUpdate}
                            variant="success"
                            className="w-full"
                            size="sm"
                          >
                            <Download
                              size={13}
                              className={`me-1.5 ${downloadingUpdate ? "animate-pulse" : ""}`}
                            />
                            {downloadingUpdate
                              ? t("settingsPage.general.updates.downloading", {
                                  progress: Math.round(updateDownloadProgress),
                                })
                              : t("settingsPage.general.updates.downloadUpdate", {
                                  version: updateInfo?.version || "",
                                })}
                          </Button>

                          {downloadingUpdate && (
                            <div className="h-1 w-full overflow-hidden rounded-full bg-muted/50">
                              <div
                                className="h-full bg-success transition-[width] duration-200 rounded-full"
                                style={{
                                  width: `${Math.min(100, Math.max(0, updateDownloadProgress))}%`,
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {updateStatus.updateDownloaded && (
                        <Button
                          onClick={() => {
                            showConfirmDialog({
                              title: t("settingsPage.general.updates.dialogs.installUpdate.title"),
                              description: t(
                                "settingsPage.general.updates.dialogs.installUpdate.description",
                                { version: updateInfo?.version || "" }
                              ),
                              confirmText: t(
                                "settingsPage.general.updates.dialogs.installUpdate.confirmText"
                              ),
                              onConfirm: async () => {
                                try {
                                  await installUpdateAction();
                                } catch {
                                  showAlertDialog({
                                    title: t(
                                      "settingsPage.general.updates.dialogs.installFailed.title"
                                    ),
                                    description: t(
                                      "settingsPage.general.updates.dialogs.installFailed.description"
                                    ),
                                  });
                                }
                              },
                            });
                          }}
                          disabled={installInitiated}
                          className="w-full"
                          size="sm"
                        >
                          <RefreshCw
                            size={14}
                            className={`me-2 ${installInitiated ? "animate-spin" : ""}`}
                          />
                          {installInitiated
                            ? t("settingsPage.general.updates.restarting")
                            : t("settingsPage.general.updates.installAndRestart")}
                        </Button>
                      )}
                    </div>

                    {updateInfo?.releaseNotes && (
                      <div className="mt-4 pt-4 border-t border-border/70">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                          <BidiInterpolatedText
                            text={t("settingsPage.general.updates.whatsNew", {
                              version: BIDI_VALUE_TOKEN,
                            })}
                            value={updateInfo.version}
                          />
                        </p>
                        <div
                          className="text-xs text-muted-foreground [&_ul]:list-disc [&_ul]:ps-4 [&_ul]:space-y-1 [&_ol]:list-decimal [&_ol]:ps-4 [&_ol]:space-y-1 [&_li]:ps-1 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_a]:text-link [&_a]:underline"
                          dangerouslySetInnerHTML={{ __html: updateInfo.releaseNotes }}
                        />
                      </div>
                    )}
                  </SettingsPanelRow>
                )}
              </SettingsPanel>
              <div data-setting-id="system.updates.check" className="mt-5 flex justify-end">
                <Button
                  onClick={async () => {
                    try {
                      const result = await checkForUpdates();
                      if (result && !result.updateAvailable) {
                        toast({
                          title: t("settingsPage.general.updates.dialogs.noUpdates.title"),
                          description: t(
                            "settingsPage.general.updates.dialogs.noUpdates.description"
                          ),
                        });
                      }
                    } catch {
                      showAlertDialog({
                        title: t("settingsPage.general.updates.dialogs.checkFailed.title"),
                        description: t(
                          "settingsPage.general.updates.dialogs.checkFailed.description"
                        ),
                      });
                    }
                  }}
                  disabled={
                    checkingForUpdates || updateStatus.isDevelopment || !updateStatus.isSupported
                  }
                  variant="outline"
                  size="sm"
                >
                  <RefreshCw
                    size={13}
                    className={`me-1.5 ${checkingForUpdates ? "animate-spin" : ""}`}
                  />
                  {checkingForUpdates
                    ? t("settingsPage.general.updates.checking")
                    : t("settingsPage.general.updates.checkForUpdates")}
                </Button>
              </div>
            </div>

            {/* Diagnostics: a summary of the log, managed in Storage */}
            <div className="border-t border-border/70 pt-6">
              <DiagnosticsSection showing={page === "system"} />
            </div>

            {/* Reset (the model cache, sizes and folders are on Storage) */}
            <div className="border-t border-border/70 pt-6">
              <SectionHeader title={t("settingsPage.developer.dataManagementTitle")} />

              <div className="space-y-4">
                <SettingsPanel>
                  <SettingsPanelRow data-setting-id="system.data.reset">
                    <SettingsRow
                      label={t("settingsPage.developer.resetAppData")}
                      description={t("settingsPage.developer.resetAppDataDescription")}
                    >
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.developer.resetAll.title"),
                            description: t("settingsPage.developer.resetAll.description"),
                            onConfirm: async () => {
                              try {
                                try {
                                  await signOut();
                                } catch {}
                                await window.electronAPI?.cleanupApp();
                                showAlertDialog({
                                  title: t("settingsPage.developer.resetAll.successTitle"),
                                  description: t(
                                    "settingsPage.developer.resetAll.successDescription"
                                  ),
                                });
                                setTimeout(() => window.electronAPI?.relaunchApp(), 1000);
                              } catch {
                                showAlertDialog({
                                  title: t("settingsPage.developer.resetAll.failedTitle"),
                                  description: t(
                                    "settingsPage.developer.resetAll.failedDescription"
                                  ),
                                });
                              }
                            },
                            variant: "destructive",
                            confirmText: t("settingsPage.developer.resetAll.confirmText"),
                          });
                        }}
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                      >
                        {t("common.reset")}
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  // A page's Preferences blocks, in the page's order (settingsPages.ts lists them).
  const renderPreferencesBlocks = (pageId: SettingsPageId) => {
    const blocks = SETTINGS_PAGES[pageId].blocks ?? [];
    return blocks.map((block) => (
      <React.Fragment key={block}>
        {renderSectionContent(
          "general",
          (candidate) => candidate === block,
          blocks.length === 1 ? block : undefined
        )}
      </React.Fragment>
    ));
  };

  const renderLocalWhisperVad = () =>
    transcriptionMode === "local" &&
    localTranscriptionProvider === "whisper" &&
    renderWhisperVadSettings();

  // A page's body, built from the old sections' bodies (moved, not rewritten).
  const renderPage = (pageId: SettingsPageId): React.ReactNode => {
    switch (pageId) {
      case "account":
      case "plansBilling":
      case "workspace":
      case "hotkeys":
      case "privacyData":
      case "system":
        return renderSectionContent(pageId);

      case "overview":
        return <DictationOverview onNavigate={onNavigate} onOpenElsewhere={onOpenElsewhere} />;

      case "recognition":
        return (
          <div className="space-y-6">
            <TranscriptionSection
              cloudTranscriptionProvider={cloudTranscriptionProvider}
              cloudTranscriptionModel={cloudTranscriptionModel}
              showTranscriptionPreview={showTranscriptionPreview}
              setShowTranscriptionPreview={setShowTranscriptionPreview}
              toast={toast}
            />
            {renderPreferencesBlocks("recognition")}
            <SettingsPanel>
              <SettingsPanelRow data-setting-id="dictation.recognition.dictionaryOrder">
                <DictionaryHintOrderSetting />
              </SettingsPanelRow>
            </SettingsPanel>
            {renderLocalWhisperVad()}
          </div>
        );

      case "liveRecording":
        return (
          <div className="space-y-6">
            <MeetingTranscriptionPanel />
            {renderLocalWhisperVad()}
          </div>
        );

      case "fileTranscription":
        return (
          <div className="space-y-6">
            <UploadTranscriptionPanel />
          </div>
        );

      case "cleanup":
        return (
          <div className="space-y-6">
            {useCleanupModel && (
              <AiModelsSection
                useCleanupModel={useCleanupModel}
                setUseCleanupModel={(value) => {
                  updateCleanupSettings({ useCleanupModel: value });
                }}
                enableToggleInHeader
                toast={toast}
              />
            )}
            {useCleanupModel && (
              <SettingsPanel>
                <SettingsPanelRow data-setting-id="dictation.cleanup.dictionaryWords">
                  <CleanupDictionaryWordsSetting />
                </SettingsPanelRow>
                <SettingsPanelRow data-setting-id="dictation.cleanup.dictionaryGrouping">
                  <CleanupDictionaryGroupingSetting />
                </SettingsPanelRow>
              </SettingsPanel>
            )}
            <div
              data-setting-id="dictation.cleanup.prompt"
              className={useCleanupModel ? "border-t border-border/70 pt-6" : undefined}
            >
              <SectionHeader
                title={t("settingsPage.prompts.title")}
                description={t("settingsPage.prompts.description")}
              />
              <PromptStudio />
            </div>
          </div>
        );

      case "styles":
        return (
          <div data-setting-id="dictation.styles">
            <StyleStudio />
          </div>
        );

      case "assistant":
        return <DictationAgentSettings hideEnableToggle />;

      case "translation":
        return <DictationTranslationSettings hideEnableToggle />;

      case "chat":
        return <ChatAgentSettings />;

      case "noteFormatting":
        return <NoteFormattingSettings />;

      case "connections":
        // Its connections regroup once per visit, so it needs to know when it shows.
        return <AiConnectionsPage showing={page === "connections"} />;

      case "storage":
        return <StoragePage showing={page === "storage"} />;

      case "processes":
        // Subscribes to live samples only while it shows.
        return <ProcessesPage showing={page === "processes"} />;

      default:
        return <div className="space-y-6">{renderPreferencesBlocks(pageId)}</div>;
    }
  };

  return (
    <>
      {insightsOptInDialog}

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

      <ConfirmDialog
        open={isDeleteAccountDialogOpen}
        onOpenChange={(open) => {
          setIsDeleteAccountDialogOpen(open);
          if (!open) setEraseDeviceData(false);
        }}
        title={t("settingsPage.account.deleteAccount.title")}
        description={t("settingsPage.account.deleteAccount.description")}
        onConfirm={() => void confirmDeleteAccount()}
        variant="destructive"
        confirmText={t("settingsPage.account.deleteAccount.confirmText")}
        confirmDisabled={isDeletingAccount}
      >
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-border accent-destructive"
            checked={eraseDeviceData}
            onChange={(event) => setEraseDeviceData(event.target.checked)}
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium">
              {t("settingsPage.account.deleteAccount.eraseDeviceLabel")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t("settingsPage.account.deleteAccount.eraseDeviceDescription")}
            </span>
            {eraseDeviceData && (
              <span className="block text-xs font-medium text-destructive">
                {t("settingsPage.account.deleteAccount.eraseDeviceWarning")}
              </span>
            )}
          </span>
        </label>
      </ConfirmDialog>

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Each page mounts on its first visit and then stays mounted, hidden, so editor
          drafts, model-download progress and IPC listeners survive page switches. */}
      {SETTINGS_PAGE_IDS.filter((id) => visitedPages.has(id)).map((id) => (
        <div key={id} data-settings-page-id={id} className={id === page ? undefined : "hidden"}>
          <SettingsPageHeader page={id} />
          {renderPage(id)}
        </div>
      ))}
    </>
  );
}
