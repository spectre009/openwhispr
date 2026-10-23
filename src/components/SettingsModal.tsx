import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePolicyStore } from "../stores/policyStore";
import {
  Sliders,
  Mic,
  Brain,
  UserCircle,
  Wrench,
  Keyboard,
  CreditCard,
  Shield,
  ShieldCheck,
  Users,
} from "./icons";
import SettingsLayer, { type SettingsNavItem } from "./settings/SettingsLayer";
import SettingsPage, { AccountAvatar, SettingsSectionType } from "./SettingsPage";
import { useAuth } from "../hooks/useAuth";
import { useOpenWhisprCloudDisabled } from "../stores/openWhisprCloudStore";
import { shownSettingsSection, visibleSettingsSections } from "./settingsSections";
import {
  applySettingsRequest,
  initialSettingsNavigation,
  navigateWithinSettings,
  type SettingsRequest,
} from "./settings/settingsNavigation";
import type { ControlPanelNavItem, ControlPanelView } from "./controlPanelNav";

export type { SettingsSectionType };

interface SettingsModalProps {
  open: boolean;
  /** The latest named request (deep links and legacy names included). */
  request: SettingsRequest | null;
  onRequestClose: () => boolean;
  railItems: ControlPanelNavItem[];
  activeView: ControlPanelView;
  onSelectView: (view: ControlPanelView) => void;
  onOpenSearch: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  getFallbackFocus?: () => HTMLElement | null;
}

export default function SettingsModal({
  open,
  request,
  onRequestClose,
  railItems,
  activeView,
  onSelectView,
  onOpenSearch,
  returnFocusRef,
  getFallbackFocus,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const { isSignedIn, user } = useAuth();
  const cloudDisabled = useOpenWhisprCloudDisabled();
  const policyManaged = usePolicyStore((s) => s.managed);
  const navItems: SettingsNavItem<SettingsSectionType>[] = useMemo(() => {
    const items: SettingsNavItem<SettingsSectionType>[] = [
      {
        id: "account",
        label: t("settingsModal.sections.account.label"),
        icon: UserCircle,
        description: t("settingsModal.sections.account.description"),
        group: t("settingsModal.groups.account"),
      },
      {
        id: "plansBilling",
        label: t("settingsModal.sections.plansBilling.label"),
        icon: CreditCard,
        description: t("settingsModal.sections.plansBilling.description"),
        group: t("settingsModal.groups.account"),
      },
      {
        id: "workspace" as const,
        label: t("settingsModal.sections.workspace.label"),
        icon: Users,
        description: t("settingsModal.sections.workspace.description"),
        group: t("settingsModal.groups.account"),
      },
      {
        id: "general",
        label: t("settingsModal.sections.general.label"),
        icon: Sliders,
        description: t("settingsModal.sections.general.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "hotkeys",
        label: t("settingsModal.sections.hotkeys.label"),
        icon: Keyboard,
        description: t("settingsModal.sections.hotkeys.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "speechToText",
        label: t("settingsModal.sections.speechToText.label"),
        icon: Mic,
        description: t("settingsModal.sections.speechToText.description"),
        group: t("settingsModal.groups.aiModels"),
      },
      {
        id: "llms",
        label: t("settingsModal.sections.llms.label"),
        icon: Brain,
        description: t("settingsModal.sections.llms.description"),
        group: t("settingsModal.groups.aiModels"),
      },
      {
        id: "privacyData",
        label: t("settingsModal.sections.privacyData.label"),
        icon: Shield,
        description: t("settingsModal.sections.privacyData.description"),
        group: t("settingsModal.groups.system"),
      },
      {
        id: "system",
        label: t("settingsModal.sections.system.label"),
        icon: Wrench,
        description: t("settingsModal.sections.system.description"),
        group: t("settingsModal.groups.system"),
      },
    ];
    return visibleSettingsSections(items, { isSignedIn, cloudDisabled });
  }, [t, isSignedIn, cloudDisabled]);

  // Settings stays mounted between opens: each named request navigates once,
  // and a bare open keeps whatever page it was on.
  const [navigation, setNavigation] = useState(() =>
    initialSettingsNavigation(request, cloudDisabled)
  );
  const current = applySettingsRequest(navigation, request, cloudDisabled);
  if (current !== navigation) setNavigation(current);

  const handleSectionChange = useCallback((section: SettingsSectionType, subTab?: string) => {
    setNavigation((previous) => navigateWithinSettings(previous, section, subTab));
  }, []);
  // Turning the account & Cloud switch off while an account section is open
  // moves the view off it without forgetting what was asked for.
  const shownSection = shownSettingsSection(current.section, cloudDisabled);

  return (
    <SettingsLayer<SettingsSectionType>
      open={open}
      onRequestClose={onRequestClose}
      railItems={railItems}
      activeView={activeView}
      onSelectView={onSelectView}
      onOpenSearch={onOpenSearch}
      navItems={navItems}
      activeSection={shownSection}
      sectionLabel={t(`settingsModal.sections.${shownSection}.label`, { defaultValue: "" })}
      onSectionChange={handleSectionChange}
      navigationKey={current.navigationId}
      returnFocusRef={returnFocusRef}
      getFallbackFocus={getFallbackFocus}
      header={
        isSignedIn && user ? (
          <div className="flex flex-col items-center gap-2 pb-2 text-center">
            <AccountAvatar image={user.image} name={user.name || t("settingsPage.account.user")} />
            <div className="min-w-0 w-full">
              <p dir="auto" className="text-[13px] font-semibold text-foreground truncate">
                {user.name || t("settingsPage.account.user")}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                <bdi dir="ltr">{user.email}</bdi>
              </p>
            </div>
          </div>
        ) : undefined
      }
      notice={
        policyManaged
          ? {
              icon: <ShieldCheck className="h-3.5 w-3.5 shrink-0" />,
              label: t("settingsModal.managedAccount"),
              description: t("settingsModal.managedByOrg"),
            }
          : undefined
      }
    >
      <SettingsPage
        activeSection={shownSection}
        onNavigateToSection={handleSectionChange}
        initialSubTab={current.subTab}
        subTabRequestId={current.navigationId}
      />
    </SettingsLayer>
  );
}
