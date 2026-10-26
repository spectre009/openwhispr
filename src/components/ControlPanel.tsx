import React, { Suspense, useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./ui/button";
import { PAGE_CONTENT_WIDTH_CLASS } from "./ui/pageWidth";
import { cn } from "./lib/utils";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "./ui/BidiInterpolatedText";
import { Download, RefreshCw, Loader2, AlertTriangle, Zap } from "./icons";
import UpgradePrompt from "./UpgradePrompt";
import PostMigrationOnboarding from "./PostMigrationOnboarding";
import { RequiredModelsBanner } from "./RequiredModelsBanner";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useHotkey } from "../hooks/useHotkey";
import { useToast } from "./ui/useToast";
import { useUpdater } from "../hooks/useUpdater";
import { useSettings } from "../hooks/useSettings";
import { useAuth } from "../hooks/useAuth";
import { useJoinableWorkspaces } from "../hooks/useJoinableWorkspaces";
import { useWorkspace } from "../hooks/useWorkspace";
import { manageableWorkspaces, selectWorkspaceForSpaceCreation } from "../lib/workspaceSelection";
import { useUsage } from "../hooks/useUsage";
import { decideUpsell } from "../lib/upsell";
import { useCollapsibleSidebar } from "../hooks/useCollapsibleSidebar";
import {
  useTranscriptions,
  useShowDiscarded,
  initializeTranscriptions,
  removeTranscription as removeFromStore,
  updateTranscription as updateInStore,
  clearTranscriptions as clearStore,
} from "../stores/transcriptionStore";
import {
  getSettings,
  selectPolicyEffectiveSettings,
  useSettingsStore,
} from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { useOpenWhisprCloudDisabled } from "../stores/openWhisprCloudStore";
import { usePolicySnapshot } from "../hooks/usePolicy";
import {
  isAgentAllowed,
  isControlPanelViewAllowed,
  isPolicyActionAllowed,
  isTranscriptionContextAllowed,
  isUpdateRequiredByOrg,
} from "../stores/policyRules";
import { getManagedTranscriptionResolution } from "../services/managedTranscription";
import {
  useIsMeetingMode,
  useIsNarrowWindow,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";
import ControlPanelSidebar from "./ControlPanelSidebar";
import ControlPanelTopBar from "./ControlPanelTopBar";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";
import { useSettingsLayerController } from "./settings/useSettingsLayerController";
import { drainPendingSettingsSection } from "./settings/settingsNavigation";
import { COMMAND_PALETTE_ATTRIBUTE } from "./settings/settingsLayerPolicy";
import type { ElsewhereLocation } from "./settings/search/types";
import {
  DEFAULT_INTEGRATIONS_SECTION,
  type IntegrationsSection,
} from "./integrations/integrationsSections";
import { navigateMeetingNotification } from "./meetingNotificationNavigation";
import MeetingRecordingMount from "./MeetingRecordingMount";
import MeetingRecordingPill from "./notes/MeetingRecordingPill";
import NewNoteMenu from "./notes/NewNoteMenu";

import { getCachedPlatform } from "../utils/platform";
import { isAccessibilitySkipped } from "../utils/permissions";
import { useGpuBannerAvailability } from "../hooks/useGpuBannerAvailability";
import { startRecordingForNote, useCreateNote } from "../hooks/useCreateNote";
import { useSignInCloudNudge } from "../hooks/useSignInCloudNudge";
import {
  setActiveNoteId,
  setActiveFolderId,
  navigateToContainer,
  useActiveNoteId,
  initializeNotes,
  subscribeMeetingNotificationFolders,
} from "../stores/noteStore";
import { fetchProviders as fetchStreamingProviders } from "../stores/streamingProvidersStore";
import {
  rerunAfterSpeechToText,
  reusedSttStep,
  targetAppFromSteps,
  wasAssistantCommand,
  type HistoryRerunNotices,
} from "../services/historyRerun";
import { resolveStyleForRetry } from "../stores/styleStore";
import { styleIdFromRouteKind } from "../config/styles/library";
import { OPEN_HISTORY_ITEM_EVENT } from "../utils/openHistoryItem";
import { requestHistoryItem, requestHistoryReview } from "./history/historyViewStore";
import HistoryView from "./HistoryView";
import BackgroundActionToastListener from "./notes/BackgroundActionToastListener";
import AssistantNoteUndoListener from "./notes/AssistantNoteUndoListener";
import { providerErrorToastProps } from "../utils/describeProviderError";
import SpaceSyncToastListener from "./notes/SpaceSyncToastListener";
import { syncService } from "../services/SyncService.js";
import logger from "../utils/logger";
import AcceptInvitationModal from "./AcceptInvitationModal";
import JoinYourTeamModal from "./JoinYourTeamModal";
import {
  consumePendingInvitationToken,
  clearPendingInvitationToken,
} from "../utils/pendingInvitationToken";

const platform = getCachedPlatform();

const SIDEBAR_WIDTH_PX = 192;

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const ReferralModal = React.lazy(() => import("./ReferralModal"));
const InviteTeammateDialog = React.lazy(() => import("./InviteTeammateDialog"));
const PersonalNotesView = React.lazy(() => import("./notes/PersonalNotesView"));
const HistoryBrowser = React.lazy(() => import("./history/HistoryBrowser"));
const InsightsView = React.lazy(() => import("./InsightsView"));
const DictionaryView = React.lazy(() => import("./DictionaryView"));
const UploadAudioView = React.lazy(() => import("./notes/UploadAudioView"));
const IntegrationsView = React.lazy(() => import("./IntegrationsView"));
const ChatView = React.lazy(() => import("./chat/ChatView"));
const CommandSearch = React.lazy(() => import("./CommandSearch"));

interface ControlPanelProps {
  /** Open Settings at this section on mount (e.g. after onboarding). */
  initialSettingsSection?: string;
}

export default function ControlPanel({ initialSettingsSection }: ControlPanelProps = {}) {
  const { t } = useTranslation();
  useEffect(subscribeMeetingNotificationFolders, []);
  const history = useTranscriptions();
  const [isLoading, setIsLoading] = useState(true);
  // Settings is a layer over the app, kept mounted once opened (see SettingsLayer).
  const {
    open: showSettings,
    mounted: settingsMounted,
    request: settingsRequest,
    returnFocusRef: settingsReturnFocusRef,
    openSettings,
    closeSettings,
    toggleSettings,
  } = useSettingsLayerController(initialSettingsSection);
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [showPostMigration, setShowPostMigration] = useState(false);
  const [limitData, setLimitData] = useState<{ wordsUsed: number; limit: number } | null>(null);
  const hasShownUpgradePrompt = useRef(false);
  const [aiCTADismissed, setAiCTADismissed] = useState(
    () => localStorage.getItem("aiCTADismissed") === "true"
  );
  const [showReferrals, setShowReferrals] = useState(false);
  const [showInviteTeam, setShowInviteTeam] = useState(false);
  const [invitationToken, setInvitationToken] = useState<string | null>(null);
  const [invitationNotesEntry, setInvitationNotesEntry] = useState<{
    workspaceId: string;
    teamIds: string[];
    spaceIds: string[];
  } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const showDiscarded = useShowDiscarded();
  const [activeView, setActiveView] = useState<ControlPanelView>("home");
  const [integrationsSection, setIntegrationsSection] = useState<IntegrationsSection>(
    DEFAULT_INTEGRATIONS_SECTION
  );
  const navItems = useControlPanelNavItems();
  const {
    collapsed: sidebarCollapsed,
    peek: sidebarPeek,
    toggle: toggleSidebar,
    showPeek: showSidebarPeek,
    hidePeek: hideSidebarPeek,
    leaveToggle: leaveSidebarToggle,
  } = useCollapsibleSidebar();
  const isMeetingMode = useIsMeetingMode();
  const isNarrowWindow = useIsNarrowWindow();
  const activeNoteId = useActiveNoteId();
  const isSidePanelLayout =
    isMeetingMode || (isNarrowWindow && activeView === "personal-notes" && activeNoteId != null);
  // Leaving Settings for a palette result: the palette is closing in the same step.
  const closeSettingsForPalette = useCallback(
    () => closeSettings({ ignore: document.querySelector(`[${COMMAND_PALETTE_ATTRIBUTE}]`) }),
    [closeSettings]
  );
  // A settings search result that lives outside Settings (Dictionary, Integrations).
  const openElsewhere = useCallback(
    (location: ElsewhereLocation, fromPalette = false) => {
      if (!(fromPalette ? closeSettingsForPalette() : closeSettings())) return;
      if (location.integrationsSection) setIntegrationsSection(location.integrationsSection);
      setActiveView(location.view);
    },
    [closeSettings, closeSettingsForPalette]
  );
  // Focus returns here when Settings closes and what had focus before is gone.
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const sidebarShown = !sidebarCollapsed && !isSidePanelLayout;
  const getSettingsFocusFallback = useCallback(
    () =>
      sidebarShown
        ? (sidebarContainerRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? null)
        : null,
    [sidebarShown]
  );
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const recordingFolderId = useMeetingRecordingStore((s) => s.recordingFolderId);
  const [meetingRecordingRequest, setMeetingRecordingRequest] = useState<{
    noteId: number;
    folderId: number | null;
    event: any;
  } | null>(null);
  const [gpuBannerDismissed, setGpuBannerDismissed] = useState(
    () => localStorage.getItem("gpuBannerDismissedUnified") === "true"
  );
  const updateReadyToastShown = useRef(false);
  const { hotkey } = useHotkey();
  const { toast } = useToast();
  const { useCleanupModel } = useSettings();
  const { isSignedIn, isLoaded: authLoaded, user } = useAuth();
  // Suppressed while a deep-linked invitation is open so the two never stack.
  const {
    joinable,
    dismiss: dismissJoinable,
    markRequested,
  } = useJoinableWorkspaces(user?.id ?? null, isSignedIn && !invitationToken);
  const { workspaces, active: activeWorkspace } = useWorkspace();
  // Invitations are owner/admin-only (server-enforced), so the sidebar row
  // only exists when the user can manage a workspace.
  const inviteWorkspace = selectWorkspaceForSpaceCreation(
    manageableWorkspaces(workspaces),
    activeWorkspace,
    null
  );
  const usage = useUsage();
  const cloudDisabled = useOpenWhisprCloudDisabled();
  const upsell = cloudDisabled
    ? "hide"
    : decideUpsell({
        authLoaded,
        isSignedIn,
        hasPaidAccess: usage?.hasPaidAccess ?? null,
        isPastDue: usage?.isPastDue ?? false,
      });

  const {
    status: updateStatus,
    downloadProgress,
    isDownloading,
    isInstalling,
    downloadUpdate,
    installUpdate,
  } = useUpdater();

  const openTranscriptionSettings = useCallback(
    () => openSettings("transcription"),
    [openSettings]
  );
  useSignInCloudNudge(isSignedIn, openTranscriptionSettings);

  const agentAllowedByPolicy = usePolicyStore(isAgentAllowed);
  const { createNote } = useCreateNote();
  // The note is created before the view switches so Notes mounts with it already open.
  const handleNewNote = useCallback(async () => {
    await createNote();
    setActiveView("personal-notes");
  }, [createNote]);
  const policyActionsAllowed = usePolicyStore((state) => isPolicyActionAllowed(state));
  useEffect(() => {
    if (!isControlPanelViewAllowed(activeView, agentAllowedByPolicy, policyActionsAllowed)) {
      setActiveView("home");
    }
  }, [activeView, agentAllowedByPolicy, policyActionsAllowed]);
  const updateRequiredByOrg = usePolicyStore(isUpdateRequiredByOrg);
  const policyMinAppVersion = usePolicyStore((s) => s.policy?.minAppVersion ?? null);

  // Policy-effective, because the settings pane the GPU banner links to renders
  // the clamped mode — see eligibleGpuOffers.
  const policySnapshot = usePolicySnapshot();
  const gpuBannerSettings = useSettingsStore(
    useShallow((settings) => {
      const effective = selectPolicyEffectiveSettings(settings, policySnapshot);
      return {
        useLocalWhisper: effective.useLocalWhisper,
        localTranscriptionProvider: effective.localTranscriptionProvider,
        useCleanupModel: effective.useCleanupModel,
        cleanupMode: effective.cleanupMode,
        useDictationAgent: effective.useDictationAgent,
        dictationAgentMode: effective.dictationAgentMode,
      };
    })
  );
  const gpuAccelAvailable = useGpuBannerAvailability({
    settings: gpuBannerSettings,
    agentAllowedByPolicy,
    dismissed: gpuBannerDismissed,
    settingsOpen: showSettings,
    platform,
  });

  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const loadTranscriptions = useCallback(
    async (includeDiscarded?: boolean) => {
      try {
        setIsLoading(true);
        await initializeTranscriptions(undefined, includeDiscarded);
      } catch {
        showAlertDialog({
          title: t("controlPanel.history.couldNotLoadTitle"),
          description: t("controlPanel.history.couldNotLoadDescription"),
        });
      } finally {
        setIsLoading(false);
      }
    },
    [showAlertDialog, t]
  );

  useEffect(() => {
    loadTranscriptions();
  }, [loadTranscriptions]);

  useEffect(() => {
    const { noteFilesEnabled, noteFilesPath } = useSettingsStore.getState();
    if (!noteFilesEnabled) return;
    window.electronAPI?.noteFilesSetEnabled?.(true, noteFilesPath || undefined, {
      skipRebuild: true,
    });
  }, []);

  useEffect(() => {
    if (platform !== "darwin") return;
    window.electronAPI?.getPostMigrationState?.().then((state) => {
      if (state?.justMigrated) setShowPostMigration(true);
    });
  }, []);

  const dismissPostMigrationPermanently = useCallback(async () => {
    await window.electronAPI?.markBundleMigrated?.();
    setShowPostMigration(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        setShowSearch(true);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        toggleSettings();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSettings]);

  // "Open in History" (a Home row, Dictation › Overview's last dictation, a
  // test case pinned from History): leave Settings and show that dictation in
  // the History view, looked up by id whatever the list shows.
  useEffect(() => {
    const openHistoryItem = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (!Number.isInteger(id)) return;
      if (!closeSettings()) return;
      requestHistoryItem(id as number);
      setActiveView("history");
    };
    window.addEventListener(OPEN_HISTORY_ITEM_EVENT, openHistoryItem);
    return () => window.removeEventListener(OPEN_HISTORY_ITEM_EVENT, openHistoryItem);
  }, [closeSettings]);

  // "Review last dictation" (its hotkey or the tray): main holds the request
  // until this window asks for it, so one that arrives while the panel loads
  // isn't lost. Settings closes first (its own guard may refuse), then the
  // History view opens the dictation with its review.
  useEffect(() => {
    const drain = async () => {
      const request = await window.electronAPI?.getPendingReviewRequest?.();
      if (!request || !closeSettings()) return;
      requestHistoryReview(request);
      setActiveView("history");
    };
    void drain();
    return window.electronAPI?.onReviewDictationPending?.(() => void drain());
  }, [closeSettings]);

  // "Open in History" on a dictation error card: main holds the dictation's
  // row until this window asks, then History opens on it with no review
  // drafted, read by id whatever the list shows (as Home's Open in History).
  useEffect(() => {
    const drain = async () => {
      const request = await window.electronAPI?.getPendingHistoryItemRequest?.();
      if (!request || !Number.isInteger(request.id) || !closeSettings()) return;
      requestHistoryItem(request.id);
      setActiveView("history");
    };
    void drain();
    return window.electronAPI?.onHistoryItemPending?.(() => void drain());
  }, [closeSettings]);

  useEffect(() => {
    if (updateStatus.updateDownloaded && !isDownloading) {
      if (!updateReadyToastShown.current) {
        updateReadyToastShown.current = true;
        toast({
          title: t("controlPanel.update.readyTitle"),
          description: t("controlPanel.update.readyDescription"),
          variant: "success",
        });
      }
    } else {
      updateReadyToastShown.current = false;
    }
  }, [updateStatus.updateDownloaded, isDownloading, toast, t]);

  useEffect(() => {
    const dispose = window.electronAPI?.onLimitReached?.(
      (data: { wordsUsed: number; limit: number }) => {
        if (!hasShownUpgradePrompt.current) {
          hasShownUpgradePrompt.current = true;
          setLimitData(data);
          setShowUpgradePrompt(true);
        } else {
          toast({
            title: t("controlPanel.limit.weeklyTitle"),
            description: t("controlPanel.limit.weeklyDescription"),
            duration: 5000,
          });
        }
      }
    );

    return () => {
      dispose?.();
    };
  }, [toast, t]);

  useEffect(() => {
    if (!usage?.isPastDue) return;
    if (sessionStorage.getItem("pastDueNotified")) return;
    sessionStorage.setItem("pastDueNotified", "true");
    toast({
      title: t("controlPanel.billing.pastDueTitle"),
      description: t("controlPanel.billing.pastDueDescription"),
      variant: "destructive",
      duration: 8000,
    });
  }, [usage?.isPastDue, toast, t]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWorkspaceInvitationToken?.((token) => {
      setInvitationToken(token);
      // Consume the main-process stash so a handled push isn't re-pulled on a
      // later remount.
      void window.electronAPI?.getPendingInvitationToken?.();
    });
    window.electronAPI?.getPendingInvitationToken?.().then((token) => {
      if (token) setInvitationToken(token);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    // Also when signed out (the modal's "Sign in to accept" handles auth);
    // isSignedIn stays in the deps so a stored token resurfaces after sign-in.
    if (!authLoaded) return;
    const pending = consumePendingInvitationToken();
    if (pending) {
      setInvitationToken(pending);
      clearPendingInvitationToken();
    }
  }, [authLoaded, isSignedIn]);

  // A ref, not a per-run flag: StrictMode's remount must not cancel the first drain.
  const meetingNavigationMounted = useRef(false);
  useEffect(() => {
    meetingNavigationMounted.current = true;
    const isCurrent = () => meetingNavigationMounted.current;
    const drain = async () => {
      const data = await window.electronAPI?.getPendingMeetingNoteNavigation?.();
      if (!data) return;
      if (data.navigationId) {
        if (!isCurrent() || data.spaceId == null) {
          await window.electronAPI.confirmMeetingNoteNavigation(data.navigationId, "cancel");
          return;
        }
        setActiveView("personal-notes");
        await navigateMeetingNotification(
          { ...data, navigationId: data.navigationId, spaceId: data.spaceId },
          isCurrent,
          () => import("./notes/PersonalNotesView"),
          (note) => {
            void startRecordingForNote(note)
              .then((accepted) => {
                if (!accepted) void window.electronAPI?.restoreFromMeetingMode?.();
              })
              .catch((error) =>
                logger.warn(
                  "Failed to start notification recording",
                  { error: String(error) },
                  "meeting"
                )
              );
          }
        );
        return;
      }
      if (!isCurrent()) return;
      setActiveFolderId(data.folderId);
      setActiveNoteId(data.noteId);
      setActiveView("personal-notes");
      setMeetingRecordingRequest({
        noteId: data.noteId,
        folderId: data.folderId,
        event: data.event,
      });
      void initializeNotes(null, 50, data.folderId);
      if (
        data.trigger === "hotkey" &&
        useSettingsStore.getState().meetingHotkeyLayoutMode === "side-panel"
      ) {
        window.electronAPI?.snapToMeetingMode?.();
      }
    };
    const safeDrain = () => {
      void drain().catch((error) =>
        logger.warn("Failed to open meeting note", { error: String(error) }, "meeting")
      );
    };
    safeDrain();
    const cleanup = window.electronAPI?.onMeetingNoteNavigationPending?.(safeDrain);
    return () => {
      meetingNavigationMounted.current = false;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const drain = async () => {
      const data = await window.electronAPI?.getPendingNoteNavigation?.();
      if (!data) return;
      if (data.folderId) {
        setActiveFolderId(data.folderId);
        initializeNotes(null, 50, data.folderId);
      }
      setActiveNoteId(data.noteId);
      setActiveView("personal-notes");
    };
    drain();
    const cleanup = window.electronAPI?.onNoteNavigationPending?.(drain);
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    // A named section waits in main (it can outrace this listener on a cold
    // start); a bare request (app-menu Cmd+,) keeps Settings where it is.
    const drain = (showAnyway: boolean) =>
      void drainPendingSettingsSection(
        () => window.electronAPI?.getPendingSettingsSection?.(),
        openSettings,
        showAnyway
      );
    drain(false);
    const cleanup = window.electronAPI?.onShowSettings?.(() => drain(true));
    return () => cleanup?.();
  }, [openSettings]);

  // When accessibility is missing on macOS, open the permissions settings page
  useEffect(() => {
    const cleanup = window.electronAPI?.onAccessibilityMissing?.(async () => {
      if (isAccessibilitySkipped()) return;
      const migration = await window.electronAPI?.getPostMigrationState?.();
      if (migration?.justMigrated) return;
      openSettings("privacyData");
      toast({
        title: t("controlPanel.accessibilityMissing.title"),
        description: t("controlPanel.accessibilityMissing.description"),
        duration: 10000,
      });
    });
    return () => cleanup?.();
  }, [openSettings, toast, t]);

  useEffect(() => {
    fetchStreamingProviders();
  }, []);

  const handleMeetingRecordingRequestHandled = useCallback(
    () => setMeetingRecordingRequest(null),
    []
  );

  // The side-panel layout is shared by meeting mode and by a note opened in a
  // narrow window, so leaving it means different things in each case.
  const handleExitSidePanel = useCallback(() => {
    if (isMeetingMode) window.electronAPI?.restoreFromMeetingMode?.();
    else setActiveNoteId(null);
  }, [isMeetingMode]);

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("controlPanel.history.copiedTitle"),
          description: t("controlPanel.history.copiedDescription"),
          variant: "success",
          duration: 2000,
        });
      } catch (err) {
        toast({
          title: t("controlPanel.history.couldNotCopyTitle"),
          description: t("controlPanel.history.couldNotCopyDescription"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const deleteTranscription = useCallback(
    async (id: number) => {
      showConfirmDialog({
        title: t("controlPanel.history.deleteTitle"),
        description: t("controlPanel.history.deleteDescription"),
        onConfirm: async () => {
          try {
            const result = await window.electronAPI.deleteTranscription(id);
            if (result.success) {
              removeFromStore(id);
              syncService.requestSyncAll("manual");
            } else {
              showAlertDialog({
                title: t("controlPanel.history.couldNotDeleteTitle"),
                description: t("controlPanel.history.couldNotDeleteDescription"),
              });
            }
          } catch {
            showAlertDialog({
              title: t("controlPanel.history.couldNotDeleteTitle"),
              description: t("controlPanel.history.couldNotDeleteDescriptionGeneric"),
            });
          }
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, showAlertDialog, t]
  );

  const clearAllTranscriptions = useCallback(() => {
    showConfirmDialog({
      title: t("controlPanel.history.clearAllTitle"),
      description: t(
        isSignedIn
          ? "controlPanel.history.clearAllDescription"
          : "controlPanel.history.clearAllDescriptionDevice"
      ),
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.clearTranscriptions();
          if (result.success) {
            clearStore();
            syncService.requestSyncAll("manual");
            toast({
              title: t("controlPanel.history.clearAllSuccess"),
              variant: "success",
              duration: 2000,
            });
          } else {
            showAlertDialog({
              title: t("controlPanel.history.clearAllErrorTitle"),
              description: t("controlPanel.history.clearAllErrorDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("controlPanel.history.clearAllErrorTitle"),
            description: t("controlPanel.history.clearAllErrorDescription"),
          });
        }
      },
      variant: "destructive",
    });
  }, [isSignedIn, showConfirmDialog, showAlertDialog, toast, t]);

  // Main shows its own privacy warning and Save dialog, and writes the file.
  const exportDictations = useCallback(async () => {
    try {
      const result = await window.electronAPI.exportDictations?.();
      if (!result) return;
      if (result.success) {
        toast({
          title: t("controlPanel.history.export.success", { n: result.dictations }),
          variant: "success",
          duration: 3000,
        });
        return;
      }
      if (result.canceled) return;
      toast({
        title: t(
          result.code === "ACCOUNT_CHANGED"
            ? "controlPanel.history.export.accountChanged"
            : "controlPanel.history.export.error"
        ),
        variant: "destructive",
      });
    } catch {
      toast({ title: t("controlPanel.history.export.error"), variant: "destructive" });
    }
  }, [toast, t]);

  const showAudioInFolder = useCallback(
    async (id: number) => {
      try {
        const result = await window.electronAPI.showAudioInFolder(id);
        if (!result?.success) {
          toast({
            title: t("controlPanel.history.audioNotFound"),
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: t("controlPanel.history.audioNotFound"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  // What a re-run tells the user along the way, as a live dictation's toasts do.
  const rerunNotices = useMemo<HistoryRerunNotices>(
    () => ({
      cleanupFailed: (cleanupError) =>
        toast({
          title: t("app.toasts.cleanupFailed.title"),
          ...providerErrorToastProps(cleanupError, t),
          variant: "destructive",
        }),
      styleNotApplied: (name, reason) =>
        toast({
          title: t("hooks.audioRecording.styleFallback.title", { name }),
          description: t(
            reason === "unreachable"
              ? "hooks.audioRecording.styleFallback.unreachableDescription"
              : "hooks.audioRecording.styleFallback.failedDescription"
          ),
          variant: "destructive",
        }),
    }),
    [toast, t]
  );

  // Re-transcribe: main transcribes the stored recording again, then the rest
  // of the dictation runs as Re-run cleanup does (historyRerun.ts).
  const retryTranscription = useCallback(
    async (id: number, options?: { isRecover?: boolean; plainStyle?: boolean }) => {
      try {
        const s = getSettings();
        const managed = getManagedTranscriptionResolution();
        if (managed?.kind === "error") {
          toast({
            title: managed.messageKey ? t(managed.messageKey) : managed.message,
            variant: "destructive",
          });
          return;
        }
        if (!managed && !isTranscriptionContextAllowed(usePolicyStore.getState(), s, "dictation")) {
          toast({ title: t("common.managedByOrg"), variant: "default" });
          return;
        }
        // The dictation's captured target app, read before main rewrites the
        // transcript (which drops the row's old steps).
        let targetApp: string | null = null;
        try {
          targetApp = targetAppFromSteps(await window.electronAPI.getTranscriptionSteps?.(id));
        } catch {
          targetApp = null;
        }
        const result = await window.electronAPI.retryTranscription(id, {
          managed,
          useLocalWhisper: s.useLocalWhisper,
          localTranscriptionProvider: s.localTranscriptionProvider,
          cloudTranscriptionMode: s.cloudTranscriptionMode,
          cloudTranscriptionProvider: s.cloudTranscriptionProvider,
          cloudTranscriptionModel: s.cloudTranscriptionModel,
          cloudTranscriptionBaseUrl: s.cloudTranscriptionBaseUrl,
          cortiEnvironment: s.cortiEnvironment,
          cortiTenant: s.cortiTenant,
          parakeetModel: s.parakeetModel,
          cohereModel: s.cohereModel,
          whisperModel: s.whisperModel,
          preferredLanguage: s.preferredLanguage,
          transcriptionMode: s.transcriptionMode,
          remoteTranscriptionType: s.remoteTranscriptionType,
          remoteTranscriptionUrl: s.remoteTranscriptionUrl,
          remoteTranscriptionModel: s.remoteTranscriptionModel,
        });
        // A newer run on this row (Re-run cleanup, another Re-transcribe)
        // began meanwhile: main wrote nothing, and that run reports its own result.
        if (result.stale) return;
        if (result.success && result.transcription) {
          const row = result.transcription;
          const outcome = await rerunAfterSpeechToText(
            {
              id,
              rawText: row.text,
              routeKind: row.route_kind ?? null,
              currentText: row.text,
              plainStyle: options?.plainStyle,
              stt: { provider: row.provider ?? null, model: row.model ?? null, ms: null },
              targetApp,
              runId: result.stepRunId ?? null,
            },
            rerunNotices
          );
          if (outcome.status === "stale") return;
          updateInStore(
            outcome.status === "updated" && outcome.transcription ? outcome.transcription : row
          );
          toast({
            title: t(
              options?.isRecover
                ? "controlPanel.history.discarded.recovered"
                : "controlPanel.history.retrySuccess"
            ),
          });
        } else {
          toast({
            title: t("controlPanel.history.retryError"),
            ...providerErrorToastProps({ ...result, message: result.error }, t),
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: t("controlPanel.history.retryError"),
          variant: "destructive",
        });
      }
    },
    [toast, t, rerunNotices]
  );

  // Re-run cleanup: everything after speech-to-text, with today's settings, on
  // the row's stored raw transcript. Speech-to-text is never called (nor its
  // preflight), so it works without the recording; the stored speech-to-text
  // step is carried over, marked reused. The run begins on the row before the
  // row is read for it, so an older Re-transcribe still in flight writes
  // nothing after that read.
  const rerunCleanup = useCallback(
    async (id: number, options?: { plainStyle?: boolean }) => {
      const fail = () =>
        toast({ title: t("controlPanel.history.rerunCleanup.error"), variant: "destructive" });
      const read = () =>
        Promise.all([
          window.electronAPI.getTranscriptionById(id),
          window.electronAPI.getTranscriptionSteps?.(id),
        ]);
      // A completed dictation with a raw transcript that wasn't an assistant command.
      const eligible = ([row, steps]: Awaited<ReturnType<typeof read>>) =>
        !!row &&
        !row.deleted_at &&
        row.status === "completed" &&
        typeof row.raw_text === "string" &&
        !!row.raw_text.trim() &&
        !wasAssistantCommand(steps);
      const unavailable = () =>
        toast({
          title: t("controlPanel.history.rerunCleanup.unavailable"),
          variant: "destructive",
        });
      try {
        // Checked before the run begins, so a refused click never overtakes
        // a Re-transcribe in flight.
        if (!eligible(await read())) {
          unavailable();
          return;
        }
        const begun = await window.electronAPI.beginStepHistoryRun?.({ transcriptionId: id });
        const current = await read();
        if (!eligible(current)) {
          unavailable();
          return;
        }
        const [row, steps] = current;
        const outcome = await rerunAfterSpeechToText(
          {
            id,
            rawText: row.raw_text as string,
            routeKind: row.route_kind ?? null,
            currentText: row.text,
            plainStyle: options?.plainStyle,
            stt: reusedSttStep(steps),
            targetApp: targetAppFromSteps(steps),
            runId: begun?.runId ?? null,
          },
          rerunNotices
        );
        if (outcome.status === "stale") return;
        if (outcome.status === "failed") {
          fail();
          return;
        }
        updateInStore(
          outcome.status === "updated" && outcome.transcription ? outcome.transcription : row
        );
        toast({ title: t("controlPanel.history.rerunCleanup.success") });
      } catch {
        fail();
      }
    },
    [toast, t, rerunNotices]
  );

  // A styled dictation whose style was deleted since can still be retried, as
  // Plain, once the user says so. The History view names the row's route
  // itself, since its row may be far below the ones Home has loaded, and hears
  // when the retry is done (`onSettled`), confirmed or not. `cleanupOnly`:
  // Re-run cleanup instead of Re-transcribe.
  const retryFromHistory = useCallback(
    async (
      id: number,
      options?: {
        isRecover?: boolean;
        routeKind?: string | null;
        onSettled?: () => void;
        cleanupOnly?: boolean;
      }
    ) => {
      const { routeKind, onSettled, cleanupOnly, ...retryOptions } = options ?? {};
      const run = (plainStyle?: boolean) =>
        cleanupOnly
          ? rerunCleanup(id, plainStyle ? { plainStyle } : undefined)
          : retryTranscription(id, plainStyle ? { ...retryOptions, plainStyle } : retryOptions);
      const row = history.find((item) => item.id === id);
      const styleId = styleIdFromRouteKind(routeKind !== undefined ? routeKind : row?.route_kind);
      if (styleId && !resolveStyleForRetry(styleId)) {
        showConfirmDialog({
          title: t("controlPanel.history.styleDeleted.title"),
          description: t("controlPanel.history.styleDeleted.description"),
          confirmText: t("controlPanel.history.styleDeleted.retryPlain"),
          onConfirm: () => {
            void run(true).finally(onSettled);
          },
        });
        return;
      }
      await run();
      onSettled?.();
    },
    [history, retryTranscription, rerunCleanup, showConfirmDialog, t]
  );

  const toggleShowDiscarded = useCallback(() => {
    loadTranscriptions(!showDiscarded);
  }, [loadTranscriptions, showDiscarded]);

  const handleUpdateClick = async () => {
    if (updateStatus.updateDownloaded) {
      showConfirmDialog({
        title: t("controlPanel.update.installTitle"),
        description: t("controlPanel.update.installDescription"),
        onConfirm: async () => {
          try {
            await installUpdate();
          } catch (error) {
            toast({
              title: t("controlPanel.update.couldNotInstallTitle"),
              description: t("controlPanel.update.couldNotInstallDescription"),
              variant: "destructive",
            });
          }
        },
      });
    } else if (updateStatus.updateAvailable && !isDownloading) {
      try {
        await downloadUpdate();
      } catch (error) {
        toast({
          title: t("controlPanel.update.couldNotDownloadTitle"),
          description: t("controlPanel.update.couldNotDownloadDescription"),
          variant: "destructive",
        });
      }
    }
  };

  const getUpdateButtonContent = () => {
    if (isInstalling) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{t("controlPanel.update.installing")}</span>
        </>
      );
    }
    if (isDownloading) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{Math.round(downloadProgress)}%</span>
        </>
      );
    }
    if (updateStatus.updateDownloaded) {
      return (
        <>
          <RefreshCw size={14} />
          <span>{t("controlPanel.update.installButton")}</span>
        </>
      );
    }
    if (updateStatus.updateAvailable) {
      return (
        <>
          <Download size={14} />
          <span>{t("controlPanel.update.availableButton")}</span>
        </>
      );
    }
    return null;
  };

  return (
    <div className="h-screen bg-surface-window flex flex-col">
      <MeetingRecordingMount />
      <MeetingRecordingPill
        activeView={activeView}
        activeNoteId={activeNoteId}
        onReturnToNote={() => {
          setActiveView("personal-notes");
          setActiveFolderId(recordingFolderId);
          setActiveNoteId(recordingNoteId);
        }}
      />
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <UpgradePrompt
        open={showUpgradePrompt}
        onOpenChange={setShowUpgradePrompt}
        wordsUsed={limitData?.wordsUsed}
        limit={limitData?.limit}
      />

      <PostMigrationOnboarding
        open={showPostMigration}
        onOpenChange={setShowPostMigration}
        onDone={dismissPostMigrationPermanently}
      />

      {showReferrals && (
        <Suspense fallback={null}>
          <ReferralModal open={showReferrals} onOpenChange={setShowReferrals} />
        </Suspense>
      )}

      {showInviteTeam && inviteWorkspace && (
        <Suspense fallback={null}>
          <InviteTeammateDialog
            open={showInviteTeam}
            onOpenChange={setShowInviteTeam}
            workspaceId={inviteWorkspace.id}
            workspaceName={inviteWorkspace.name}
          />
        </Suspense>
      )}

      <AcceptInvitationModal
        token={invitationToken}
        onClose={() => setInvitationToken(null)}
        onAccepted={(entry) => {
          setInvitationNotesEntry(entry);
          setActiveView("personal-notes");
        }}
      />

      <JoinYourTeamModal
        joinable={joinable}
        domain={user?.email?.split("@")[1] ?? null}
        onDismiss={dismissJoinable}
        onRequested={markRequested}
        onJoined={() => setActiveView("personal-notes")}
      />

      {/* Always mounted so the palette chunk is warm and Radix can play its exit animation. */}
      <Suspense fallback={null}>
        <CommandSearch
          open={showSearch}
          onOpenChange={setShowSearch}
          transcriptions={history}
          // A result opened over Settings leaves it first; the palette itself is closing.
          onNoteSelect={(id, folderId, spaceId) => {
            closeSettingsForPalette();
            if (folderId != null) setActiveFolderId(folderId);
            else if (spaceId != null) navigateToContainer(spaceId, null);
            setActiveNoteId(id);
            setActiveView("personal-notes");
          }}
          onContainerSelect={(spaceId, folderId) => {
            closeSettingsForPalette();
            navigateToContainer(spaceId, folderId);
            setActiveView("personal-notes");
          }}
          onTranscriptSelect={() => {
            closeSettingsForPalette();
            setActiveView("home");
          }}
          // A Settings result opens Settings at it (`#settingId`), or the app page it names.
          onSettingSelect={(action) => {
            if (action.kind === "elsewhere") openElsewhere(action.location, true);
            else openSettings(action.destination);
          }}
          settingsFirst={showSettings}
        />
      </Suspense>

      <div className="flex flex-1 overflow-hidden relative">
        <div
          className="shrink-0 transition-[width] duration-300 ease-out"
          style={{ width: sidebarCollapsed || isSidePanelLayout ? 0 : SIDEBAR_WIDTH_PX }}
        />
        <div
          ref={sidebarContainerRef}
          // Under Settings the app keeps running but can't be reached.
          inert={showSettings}
          aria-hidden={showSettings || undefined}
          className={`absolute inset-y-0 start-0 z-30 transition-transform duration-300 ease-out ${
            !isSidePanelLayout && (!sidebarCollapsed || sidebarPeek)
              ? "translate-x-0"
              : "ltr:-translate-x-full rtl:translate-x-full"
          }${
            sidebarCollapsed && sidebarPeek && !isSidePanelLayout
              ? " shadow-[10px_0_40px_-18px_rgba(0,0,0,0.2)] rtl:shadow-[-10px_0_40px_-18px_rgba(0,0,0,0.2)]"
              : ""
          }`}
          onMouseEnter={sidebarCollapsed ? showSidebarPeek : undefined}
          onMouseLeave={sidebarCollapsed ? hideSidebarPeek : undefined}
        >
          <ControlPanelSidebar
            activeView={activeView}
            onViewChange={setActiveView}
            onOpenSettings={() => openSettings()}
            onOpenReferrals={() => setShowReferrals(true)}
            onInviteTeam={inviteWorkspace ? () => setShowInviteTeam(true) : undefined}
            onUpgrade={() => openSettings("plansBilling")}
            isOverLimit={usage?.isOverLimit ?? false}
            userName={user?.name}
            userEmail={user?.email}
            userImage={user?.image}
            isSignedIn={isSignedIn}
            authLoaded={authLoaded}
            upsell={upsell}
            updateAction={
              !updateStatus.isDevelopment &&
              (updateStatus.updateAvailable ||
                updateStatus.updateDownloaded ||
                isDownloading ||
                isInstalling) ? (
                <Button
                  variant={updateStatus.updateDownloaded ? "default" : "outline"}
                  size="sm"
                  onClick={handleUpdateClick}
                  disabled={isInstalling || isDownloading}
                  className="gap-1.5 text-xs w-full h-7"
                >
                  {getUpdateButtonContent()}
                </Button>
              ) : undefined
            }
          />
        </div>
        <main
          inert={showSettings}
          aria-hidden={showSettings || undefined}
          className="flex-1 flex flex-col overflow-hidden p-2"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-clip rounded-(--radius-shell) border border-border bg-background dark:border-white/10">
            <ControlPanelTopBar
              title={navItems.find((item) => item.id === activeView)?.label ?? ""}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              onToggleMouseEnter={sidebarCollapsed ? showSidebarPeek : undefined}
              onToggleMouseLeave={sidebarCollapsed ? leaveSidebarToggle : undefined}
              onOpenSearch={() => setShowSearch(true)}
              isSidePanelLayout={isSidePanelLayout}
              onExitSidePanel={handleExitSidePanel}
              actions={
                <NewNoteMenu
                  onNewNote={handleNewNote}
                  onNewChat={agentAllowedByPolicy ? () => setActiveView("chat") : undefined}
                />
              }
            />
            <div className="scrollbar-hidden flex-1 overflow-y-auto">
              {updateRequiredByOrg && (
                <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "px-6 mb-3")}>
                  <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 p-3">
                    <div className="flex items-start gap-3">
                      <div className="shrink-0 w-8 h-8 rounded-md bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
                        <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-amber-900 dark:text-amber-200 mb-0.5">
                          {t("controlPanel.updateRequiredByOrg.title")}
                        </p>
                        <p className="text-xs text-amber-700 dark:text-amber-300/80">
                          <BidiInterpolatedText
                            text={t("controlPanel.updateRequiredByOrg.description", {
                              version: BIDI_VALUE_TOKEN,
                            })}
                            value={policyMinAppVersion}
                          />
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <RequiredModelsBanner />
              {usage?.isPastDue && activeView === "home" && (
                <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "px-6 mb-3")}>
                  <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 p-3">
                    <div className="flex items-start gap-3">
                      <div className="shrink-0 w-8 h-8 rounded-md bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
                        <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-amber-900 dark:text-amber-200 mb-0.5">
                          {t("controlPanel.billing.pastDueTitle")}
                        </p>
                        <p className="text-xs text-amber-700 dark:text-amber-300/80 mb-2">
                          {t("controlPanel.billing.bannerDescription", {
                            limit: usage.limit.toLocaleString(),
                          })}
                        </p>
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => openSettings("account")}
                        >
                          {t("controlPanel.billing.updatePayment")}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {(gpuAccelAvailable.transcription || gpuAccelAvailable.intelligence) &&
                activeView === "home" &&
                !gpuBannerDismissed && (
                  <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "px-6 mb-3")}>
                    <div className="rounded-lg border border-primary/20 dark:border-primary/15 bg-primary/5 p-3">
                      <div className="flex items-start gap-3">
                        <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center">
                          <Zap size={16} className="text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground mb-0.5">
                            {t("controlPanel.gpu.bannerTitle")}
                          </p>
                          <p className="text-xs text-muted-foreground mb-2">
                            {t("controlPanel.gpu.bannerDescription")}
                          </p>
                          <div className="flex items-center gap-3">
                            <Button
                              variant="default"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() =>
                                openSettings(
                                  gpuAccelAvailable.transcription
                                    ? "transcription"
                                    : gpuAccelAvailable.intelligence === "dictationAgent"
                                      ? "dictationAgent"
                                      : "intelligence"
                                )
                              }
                            >
                              {t("controlPanel.gpu.enableButton")}
                            </Button>
                            <button
                              onClick={() => {
                                setGpuBannerDismissed(true);
                                localStorage.setItem("gpuBannerDismissedUnified", "true");
                              }}
                              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {t("controlPanel.gpu.dismissButton")}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              {activeView === "home" && (
                <HistoryView
                  history={history}
                  isLoading={isLoading}
                  hotkey={hotkey}
                  aiCTADismissed={aiCTADismissed}
                  setAiCTADismissed={setAiCTADismissed}
                  useCleanupModel={useCleanupModel}
                  copyToClipboard={copyToClipboard}
                  deleteTranscription={deleteTranscription}
                  clearAllTranscriptions={clearAllTranscriptions}
                  onExportDictations={exportDictations}
                  onShowAudioInFolder={showAudioInFolder}
                  onRetryTranscription={retryFromHistory}
                  showDiscarded={showDiscarded}
                  onToggleDiscarded={toggleShowDiscarded}
                  userName={user?.name}
                  onOpenSettings={openSettings}
                  onOpenIntegrations={() => {
                    setIntegrationsSection("calendars");
                    setActiveView("integrations");
                  }}
                />
              )}
              {activeView === "history" && (
                <Suspense fallback={null}>
                  <HistoryBrowser
                    hotkey={hotkey}
                    onCopy={copyToClipboard}
                    onDelete={deleteTranscription}
                    onRetry={retryFromHistory}
                    onShowAudioInFolder={showAudioInFolder}
                    onOpenSettings={openSettings}
                  />
                </Suspense>
              )}
              {activeView === "insights" && (
                <Suspense fallback={null}>
                  <InsightsView onSignIn={() => openSettings("account")} />
                </Suspense>
              )}
              {activeView === "chat" && agentAllowedByPolicy && (
                <Suspense fallback={null}>
                  <ChatView />
                </Suspense>
              )}
              {activeView === "personal-notes" && (
                <Suspense fallback={null}>
                  <PersonalNotesView
                    onOpenSettings={openSettings}
                    meetingRecordingRequest={meetingRecordingRequest}
                    onMeetingRecordingRequestHandled={handleMeetingRecordingRequestHandled}
                    invitationEntry={invitationNotesEntry}
                    onInvitationEntryHandled={() => setInvitationNotesEntry(null)}
                  />
                </Suspense>
              )}
              {activeView === "dictionary" && (
                <Suspense fallback={null}>
                  <DictionaryView />
                </Suspense>
              )}
              {activeView === "upload" && policyActionsAllowed && (
                <Suspense fallback={null}>
                  <UploadAudioView
                    onNoteCreated={(noteId, folderId) => {
                      setActiveNoteId(noteId);
                      if (folderId) setActiveFolderId(folderId);
                      setActiveView("personal-notes");
                    }}
                    onOpenSettings={openSettings}
                  />
                </Suspense>
              )}
              {activeView === "integrations" && (
                <Suspense fallback={null}>
                  <IntegrationsView
                    isPaid={usage?.hasPaidAccessOptimistic ?? false}
                    onUpgrade={() => openSettings("plansBilling")}
                    section={integrationsSection}
                    onSectionChange={setIntegrationsSection}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </main>
        {/* After <main> in the DOM: same z as the top bar's sidebar toggle (z-40), painted above it. */}
        {settingsMounted && (
          <Suspense fallback={null}>
            <SettingsModal
              open={showSettings}
              request={settingsRequest}
              onRequestClose={() => closeSettings()}
              railItems={navItems}
              activeView={activeView}
              onSelectView={(view) => {
                if (closeSettings()) setActiveView(view);
              }}
              onOpenSearch={() => setShowSearch(true)}
              onOpenElsewhere={openElsewhere}
              returnFocusRef={settingsReturnFocusRef}
              getFallbackFocus={getSettingsFocusFallback}
            />
          </Suspense>
        )}
      </div>
      <BackgroundActionToastListener />
      <AssistantNoteUndoListener />
      <SpaceSyncToastListener />
    </div>
  );
}
