import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePolicyStore } from "../stores/policyStore";
import { isAgentAllowed } from "../stores/policyRules";
import { ShieldCheck } from "./icons";
import SettingsLayer, { type SettingsNavGroup } from "./settings/SettingsLayer";
import SettingsPage, { AccountAvatar } from "./SettingsPage";
import { useAuth } from "../hooks/useAuth";
import { useOpenWhisprCloudDisabled } from "../stores/openWhisprCloudStore";
import {
  SETTINGS_PAGES,
  resolveSettingsDestination,
  settingsBreadcrumbKeys,
  shownSettingsPage,
  takeSavedLegacyTabs,
  visibleSettingsNav,
  type SavedLegacyTabs,
  type SettingsPageContext,
  type SettingsPageId,
} from "./settings/settingsPages";
import { settingsIcon, settingsPageIcon } from "./settings/settingsPageIcons";
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
import { focusLandedSetting, revealSetting } from "./settings/search/revealSetting";
import type { ElsewhereLocation } from "./settings/search/types";
import { SettingsLinkContext } from "./settings/settingsLink";

const NO_RESULTS = { groups: [], results: [], bestIndex: -1 };

// The tabs Speech-to-Text and Language Models last showed, read (and their
// keys removed) once per window; a bare legacy destination uses each once.
let savedLegacyTabs: SavedLegacyTabs | undefined;
function savedLegacyTabsOnce(): SavedLegacyTabs {
  savedLegacyTabs ??= takeSavedLegacyTabs(
    typeof localStorage === "undefined" ? undefined : localStorage
  );
  return savedLegacyTabs;
}

interface SettingsModalProps {
  open: boolean;
  /** The latest named request (pages, legacy names and `<page>#<settingId>` included). */
  request: SettingsRequest | null;
  onRequestClose: () => boolean;
  railItems: ControlPanelNavItem[];
  activeView: ControlPanelView;
  onSelectView: (view: ControlPanelView) => void;
  onOpenSearch: () => void;
  /** A nav link or search result that lives outside Settings (Dictionary, Integrations). */
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
  const agentAllowed = usePolicyStore(isAgentAllowed);
  const policyManaged = usePolicyStore((s) => s.managed);
  // What decides which pages show: account pages need Cloud (Workspace also a
  // sign-in), the voice assistant and chat need the organization's policy.
  const pageCtx: SettingsPageContext = useMemo(
    () => ({ cloudDisabled, isSignedIn: !!isSignedIn, agentAllowed }),
    [cloudDisabled, isSignedIn, agentAllowed]
  );

  const navGroups: SettingsNavGroup<SettingsPageId>[] = useMemo(
    () =>
      visibleSettingsNav(pageCtx).map((group) => ({
        id: group.id,
        label: t(group.labelKey),
        items: group.items.map((item) => {
          if (item.kind === "page") {
            const page = SETTINGS_PAGES[item.page];
            return {
              id: item.page,
              label: t(page.titleKey),
              icon: settingsIcon(page.icon),
              page: item.page,
            };
          }
          if (item.kind === "parent") {
            return {
              id: item.id,
              label: t(item.titleKey),
              icon: settingsIcon(item.icon),
              page: item.pages[0],
              children: item.pages.map((id) => ({
                id,
                label: t(SETTINGS_PAGES[id].titleKey),
                icon: settingsIcon(SETTINGS_PAGES[id].icon),
              })),
            };
          }
          const location = item.location;
          return {
            id: item.id,
            label: t(item.titleKey),
            icon: settingsIcon(item.icon),
            onSelect: () => onOpenElsewhere?.(location),
          };
        }),
      })),
    [t, pageCtx, onOpenElsewhere]
  );

  // Settings stays mounted between opens: each named request navigates once,
  // and a bare open keeps whatever page it was on.
  const [navigation, setNavigation] = useState(() =>
    initialSettingsNavigation(request, {
      ctx: pageCtx,
      locateSetting,
      savedTabs: savedLegacyTabsOnce(),
    })
  );
  const [query, setQuery] = useState("");
  const current = applySettingsRequest(navigation, request, { ctx: pageCtx, locateSetting });
  if (current !== navigation) {
    setNavigation(current);
    // A request (Ctrl+K's Settings results included) shows its page, not the results.
    if (query) setQuery("");
  }

  const handleNavigate = useCallback((page: SettingsPageId, subTab?: string) => {
    setNavigation((previous) => navigateWithinSettings(previous, page, subTab));
  }, []);
  // A link inside a page ("Edit in Cleanup", "Manage keys in AI Connections"):
  // the same resolution as openSettings, landing on the named setting.
  const openSettingsLink = useCallback(
    (destination: string) => {
      const { page, subTab, settingId } = resolveSettingsDestination(destination, {
        ctx: pageCtx,
        locateSetting,
      });
      setQuery("");
      setNavigation((previous) => navigateWithinSettings(previous, page, subTab, settingId));
    },
    [pageCtx]
  );
  // A page that's hidden now (the account & Cloud switch turned off while an
  // account page is open, a sign-out, the agent policy) shows its fallback,
  // without forgetting what was asked for.
  const shownPage = shownSettingsPage(current.page, pageCtx);

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
      const { page, subTab } = action.location;
      setNavigation((previous) => navigateWithinSettings(previous, page, subTab, action.settingId));
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
  // the anchor is awaited, scrolled to and flashed, and takes focus when
  // nothing in Settings has it (a Ctrl+K result). A newer navigation cancels it.
  const revealRef = useRef<{ navigationId: number; controller: AbortController } | null>(null);
  useEffect(() => {
    const active = revealRef.current;
    if (active && active.navigationId !== current.navigationId) {
      active.controller.abort();
      revealRef.current = null;
    }
    if (!open || !current.settingId || revealRef.current) return;
    const descriptor = findSettingDescriptor(current.settingId);
    const layer = document.querySelector<HTMLElement>(`[${SETTINGS_LAYER_ATTRIBUTE}]`);
    if (!descriptor?.anchor || !layer) return;
    const controller = new AbortController();
    revealRef.current = { navigationId: current.navigationId, controller };
    void revealSetting({
      root: layer,
      anchor: descriptor.anchor,
      fallbackAnchor: descriptor.fallbackAnchor,
      expand: descriptor.reveal?.expand,
      page: descriptor.location?.page,
      signal: controller.signal,
    }).then((landed) => {
      if (landed && !controller.signal.aborted) focusLandedSetting(layer, landed);
    });
  }, [open, current.navigationId, current.settingId]);

  const breadcrumb = searching
    ? [t("settingsSearch.breadcrumb")]
    : settingsBreadcrumbKeys(shownPage).map((key) => t(key));

  return (
    <SettingsLayer<SettingsPageId>
      open={open}
      onRequestClose={onRequestClose}
      railItems={railItems}
      activeView={activeView}
      onSelectView={onSelectView}
      onOpenSearch={onOpenSearch}
      navGroups={navGroups}
      activePage={shownPage}
      breadcrumb={breadcrumb}
      onNavigate={(page) => {
        setQuery("");
        handleNavigate(page);
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
            iconFor={settingsPageIcon}
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
      <SettingsLinkContext.Provider value={openSettingsLink}>
        <SettingsPage
          page={shownPage}
          onNavigate={handleNavigate}
          initialSubTab={current.subTab}
          subTabRequestId={current.navigationId}
        />
      </SettingsLinkContext.Provider>
    </SettingsLayer>
  );
}
