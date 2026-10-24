import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
import { SETTINGS_LAYER_ATTRIBUTE } from "./settings/settingsLayerPolicy";
import type { ControlPanelNavItem, ControlPanelView } from "./controlPanelNav";
import SettingsSearchField from "./settings/search/SettingsSearchField";
import SettingsSearchResults from "./settings/search/SettingsSearchResults";
import { useSettingsSearchIndex } from "./settings/search/useSettingsSearchIndex";
import {
  searchSettings,
  settingsSearchOptionId,
  type SettingsSearchEntry,
} from "./settings/search/match";
import { findSettingDescriptor, locateSetting } from "./settings/search/registry";
import { settingsSearchAction } from "./settings/search/openSettingsResult";
import { revealSetting } from "./settings/search/revealSetting";
import type { ElsewhereLocation } from "./settings/search/types";

export type { SettingsSectionType };

const NO_RESULTS = { groups: [], results: [], bestIndex: -1 };

interface SettingsModalProps {
  open: boolean;
  /** The latest named request (deep links, legacy names and `section#settingId` included). */
  request: SettingsRequest | null;
  onRequestClose: () => boolean;
  railItems: ControlPanelNavItem[];
  activeView: ControlPanelView;
  onSelectView: (view: ControlPanelView) => void;
  onOpenSearch: () => void;
  /** A search result that lives outside Settings (Dictionary, Integrations). */
  onOpenElsewhere?: (location: ElsewhereLocation) => void;
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
  onOpenElsewhere,
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
    initialSettingsNavigation(request, cloudDisabled, locateSetting)
  );
  const [query, setQuery] = useState("");
  const current = applySettingsRequest(navigation, request, cloudDisabled, locateSetting);
  if (current !== navigation) {
    setNavigation(current);
    // A request (Ctrl+K's Settings results included) shows its page, not the results.
    if (query) setQuery("");
  }

  const handleSectionChange = useCallback((section: SettingsSectionType, subTab?: string) => {
    setNavigation((previous) => navigateWithinSettings(previous, section, subTab));
  }, []);
  // Turning the account & Cloud switch off while an account section is open
  // moves the view off it without forgetting what was asked for.
  const shownSection = shownSettingsSection(current.section, cloudDisabled);

  // ── Settings search ────────────────────────────────────────────────────────
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const searching = query.trim().length > 0;
  const searchIndex = useSettingsSearchIndex(searching);
  const outcome = useMemo(
    () => (searching && searchIndex ? searchSettings(searchIndex, query) : NO_RESULTS),
    [searching, searchIndex, query]
  );
  // The best match is highlighted until the arrows move it, for this query.
  const [cursor, setCursor] = useState<{ query: string; index: number } | null>(null);
  const highlighted =
    cursor && cursor.query === query && cursor.index < outcome.results.length
      ? cursor.index
      : outcome.bestIndex;

  const clearSearch = useCallback(() => setQuery(""), []);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const openResult = useCallback(
    (entry: SettingsSearchEntry) => {
      const action = settingsSearchAction(entry);
      if (action.kind === "none") return;
      setQuery("");
      if (action.kind === "elsewhere") {
        onOpenElsewhere?.(action.location);
        return;
      }
      const { section, subTab } = action.location;
      setNavigation((previous) =>
        navigateWithinSettings(previous, section, subTab, action.settingId)
      );
    },
    [onOpenElsewhere]
  );

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const count = outcome.results.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!count) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const from = highlighted < 0 ? (step > 0 ? -1 : 0) : highlighted;
      setCursor({ query, index: (from + step + count) % count });
    } else if (event.key === "Enter") {
      const result = outcome.results[highlighted];
      if (!result) return;
      event.preventDefault();
      openResult(result.entry);
    } else if (event.key === "Escape" && query) {
      // One Esc clears the query, even though focus is in a text field.
      event.preventDefault();
      setQuery("");
    }
  };

  const focusSearch = useCallback(() => {
    const input = searchInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  // A navigation that names a setting lands on it once its page has rendered:
  // the anchor is awaited, scrolled to and flashed. A newer navigation cancels it.
  const revealRef = useRef<{ navigationId: number; controller: AbortController } | null>(null);
  useEffect(() => {
    const active = revealRef.current;
    if (active && active.navigationId !== current.navigationId) {
      active.controller.abort();
      revealRef.current = null;
    }
    if (!open || !current.settingId || revealRef.current) return;
    const descriptor = findSettingDescriptor(current.settingId);
    const layer = document.querySelector(`[${SETTINGS_LAYER_ATTRIBUTE}]`);
    if (!descriptor?.anchor || !layer) return;
    const controller = new AbortController();
    revealRef.current = { navigationId: current.navigationId, controller };
    void revealSetting({
      root: layer,
      anchor: descriptor.anchor,
      fallbackAnchor: descriptor.fallbackAnchor,
      expand: descriptor.reveal?.expand,
      subTab: descriptor.location?.subTab,
      signal: controller.signal,
    });
  }, [open, current.navigationId, current.settingId]);

  const iconFor = useCallback(
    (groupId: string) => navItems.find((item) => item.id === groupId)?.icon,
    [navItems]
  );

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
      sectionLabel={
        searching
          ? t("settingsSearch.breadcrumb")
          : t(`settingsModal.sections.${shownSection}.label`, { defaultValue: "" })
      }
      onSectionChange={(section) => {
        setQuery("");
        handleSectionChange(section);
      }}
      navigationKey={current.navigationId}
      returnFocusRef={returnFocusRef}
      getFallbackFocus={getFallbackFocus}
      navTop={
        <SettingsSearchField
          value={query}
          onChange={setQuery}
          onKeyDown={handleSearchKeyDown}
          onClear={() => {
            setQuery("");
            searchInputRef.current?.focus();
          }}
          inputRef={searchInputRef}
          listId={searching && outcome.results.length ? listId : undefined}
          activeDescendant={
            searching && highlighted >= 0 ? settingsSearchOptionId(listId, highlighted) : undefined
          }
        />
      }
      searchActive={searching}
      onClearSearch={clearSearch}
      onFocusSearch={focusSearch}
      searchResults={
        searching ? (
          <SettingsSearchResults
            query={query}
            outcome={outcome}
            highlighted={highlighted}
            onHighlight={(index) => setCursor({ query, index })}
            onOpen={openResult}
            iconFor={iconFor}
            listId={listId}
          />
        ) : undefined
      }
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
