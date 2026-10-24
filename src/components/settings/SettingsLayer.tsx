import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Search, Settings } from "../icons";
import WindowControls from "../WindowControls";
import { cn } from "../lib/utils";
import { SettingsLayoutProvider } from "../ui/useSettingsLayout";
import { getCachedPlatform } from "../../utils/platform";
import type { ControlPanelNavItem, ControlPanelView } from "../controlPanelNav";
import { SettingsVisibleProvider } from "./useSettingsVisible";
import {
  decideSettingsEscape,
  dismissTopPopup,
  isPopupDismissal,
  readEscapeContext,
  readSettingsSearchShortcut,
  restoreFocusAfterSettings,
  type SettingsEscapeContext,
} from "./settingsLayerPolicy";

const platform = getCachedPlatform();

// Controls inside a drag region must opt out or the click starts a window drag.
const dragStyle = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDragStyle = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

// Below this layer width the Settings nav folds to icons, leaving the content room.
const NAV_ICONS_BELOW_PX = 900;
// Section bodies take their compact layout only when the content column is narrow.
const COMPACT_CONTENT_BELOW_PX = 640;

const railButtonClass =
  "group flex h-9 w-9 items-center justify-center rounded-lg outline-none transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-primary/30 dark:hover:bg-white/5";
const railIconClass =
  "text-foreground/70 group-hover:text-foreground/90 dark:text-foreground/65 dark:group-hover:text-foreground/85 transition-colors duration-150";

export interface SettingsNavItem<T extends string> {
  id: T;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group?: string;
  description?: string;
}

export interface SettingsLayerProps<T extends string> {
  open: boolean;
  /** Leave Settings; false when a popup or dialog kept it open. */
  onRequestClose: () => boolean;
  /** The app's views, as the sidebar lists them; picking one leaves Settings. */
  railItems: ControlPanelNavItem[];
  /** The view underneath, which "Back" returns to. */
  activeView: ControlPanelView;
  onSelectView: (view: ControlPanelView) => void;
  onOpenSearch: () => void;
  navItems: SettingsNavItem<T>[];
  activeSection: T;
  sectionLabel: string;
  onSectionChange: (section: T) => void;
  /** Changes on every navigation; the content scrolls back to the top. */
  navigationKey: number;
  /** Above the nav (hidden while the nav shows icons only), e.g. account identity. */
  header?: React.ReactNode;
  /** Account-level notice, e.g. an organization-managed policy. */
  notice?: { icon: React.ReactNode; label: string; description: string };
  /** The top of the Settings nav, for the settings search field. */
  navTop?: React.ReactNode;
  /** A settings search with a query: Esc clears it before leaving Settings. */
  searchActive?: boolean;
  onClearSearch?: () => void;
  /** Search results, shown in place of the page (which stays mounted, hidden). */
  searchResults?: React.ReactNode;
  /** Ctrl+F, or `/` outside a text field: focus the search field. */
  onFocusSearch?: () => void;
  /** What had focus before Settings opened. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /** Where focus goes on close when that element is gone. */
  getFallbackFocus?: () => HTMLElement | null;
  children: React.ReactNode;
}

/** Width of an element, kept at its last real value while hidden (display: none reads 0). */
function useObservedWidth() {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const observe = useCallback((element: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    observerRef.current = observer;
  }, []);
  return [observe, width] as const;
}

/**
 * Settings as a full-window layer over the Control Panel: an icon rail of the
 * app's views, the Settings nav and one content scroller. It stays mounted once
 * opened and is hidden (display: none, inert) when closed, so drafts, downloads
 * and scroll position survive; `useSettingsVisible` tells its effects which.
 */
export default function SettingsLayer<T extends string>({
  open,
  onRequestClose,
  railItems,
  activeView,
  onSelectView,
  onOpenSearch,
  navItems,
  activeSection,
  sectionLabel,
  onSectionChange,
  navigationKey,
  header,
  notice,
  navTop,
  searchActive = false,
  onClearSearch,
  searchResults,
  onFocusSearch,
  returnFocusRef,
  getFallbackFocus,
  children,
}: SettingsLayerProps<T>) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [observeRoot, layerWidth] = useObservedWidth();
  const [observeContent, contentWidth] = useObservedWidth();
  const navIconsOnly = layerWidth > 0 && layerWidth < NAV_ICONS_BELOW_PX;
  const isCompact = contentWidth > 0 && contentWidth < COMPACT_CONTENT_BELOW_PX;
  const layout = useMemo(() => ({ isCompact }), [isCompact]);

  const setRoot = useCallback(
    (element: HTMLElement | null) => {
      rootRef.current = element;
      observeRoot(element);
    },
    [observeRoot]
  );
  const setContent = useCallback(
    (element: HTMLDivElement | null) => {
      contentRef.current = element;
      observeContent(element);
    },
    [observeContent]
  );

  // Latest callbacks for the window listeners, which only re-subscribe on open.
  const latest = useRef({ onRequestClose, onClearSearch, searchActive, onFocusSearch });
  latest.current = { onRequestClose, onClearSearch, searchActive, onFocusSearch };

  // Ctrl+F / `/` focus the settings search while Settings is open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const focusSearch = latest.current.onFocusSearch;
      if (!focusSearch || event.defaultPrevented) return;
      if (!readSettingsSearchShortcut(document, rootRef.current, event, platform === "darwin")) {
        return;
      }
      event.preventDefault();
      focusSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Esc: the context is read in the capture phase, before Radix closes the top
  // popup from its own document listener, and acted on after every handler had
  // its turn, so one Esc never closes a popup and Settings both.
  useEffect(() => {
    if (!open) return;
    const contexts = new WeakMap<Event, Omit<SettingsEscapeContext, "handled">>();
    const read = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isPopupDismissal(event)) return;
      contexts.set(
        event,
        readEscapeContext(document, rootRef.current, event, latest.current.searchActive)
      );
    };
    const act = (event: KeyboardEvent) => {
      const context = contexts.get(event);
      if (!context) return;
      const action = decideSettingsEscape({ ...context, handled: event.defaultPrevented });
      if (action === "none") return;
      event.preventDefault();
      if (action === "dismissPopup") dismissTopPopup(document, rootRef.current);
      else if (action === "blur") (document.activeElement as HTMLElement | null)?.blur();
      else if (action === "clearSearch") latest.current.onClearSearch?.();
      else latest.current.onRequestClose();
    };
    window.addEventListener("keydown", read, true);
    window.addEventListener("keydown", act);
    return () => {
      window.removeEventListener("keydown", read, true);
      window.removeEventListener("keydown", act);
    };
  }, [open]);

  // Focus moves into the layer itself on open (not its first button, which
  // would wear a focus ring), and goes back once the app is no longer inert.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (open) {
      wasOpenRef.current = true;
      if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    restoreFocusAfterSettings(document, root, returnFocusRef?.current ?? null, getFallbackFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // display: none drops the scroll offset, so it's kept across close and reopen;
  // a navigation starts at the top. Declared in this order so a request that
  // opens Settings at another section lands at the top.
  const scrollTopRef = useRef(0);
  useLayoutEffect(() => {
    if (open && contentRef.current) contentRef.current.scrollTop = scrollTopRef.current;
  }, [open]);
  // Search results replace the page; the page's offset comes back when they go,
  // unless opening a result navigated (the effect below runs after this one).
  const searching = searchResults != null && searchResults !== false;
  const wasSearchingRef = useRef(false);
  const pageScrollTopRef = useRef(0);
  useLayoutEffect(() => {
    if (wasSearchingRef.current === searching) return;
    wasSearchingRef.current = searching;
    const content = contentRef.current;
    if (searching) pageScrollTopRef.current = scrollTopRef.current;
    scrollTopRef.current = searching ? 0 : pageScrollTopRef.current;
    if (content) content.scrollTop = scrollTopRef.current;
  }, [searching]);
  const lastNavigationKey = useRef(navigationKey);
  useLayoutEffect(() => {
    if (lastNavigationKey.current === navigationKey) return;
    lastNavigationKey.current = navigationKey;
    scrollTopRef.current = 0;
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [navigationKey]);

  const groupedItems = useMemo(() => {
    const groups: { label: string | null; items: SettingsNavItem<T>[] }[] = [];
    for (const item of navItems) {
      const group = item.group ?? null;
      const last = groups[groups.length - 1];
      if (last && last.label === group) last.items.push(item);
      else groups.push({ label: group, items: [item] });
    }
    return groups;
  }, [navItems]);

  const backLabel = t("settingsLayer.backTo", {
    view: railItems.find((item) => item.id === activeView)?.label ?? t("sidebar.home"),
  });

  const navRowClass = (active: boolean) =>
    cn(
      "group relative flex h-8 w-full items-center rounded-md text-start text-[13px] outline-none transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-primary/30",
      navIconsOnly ? "justify-center px-0" : "gap-2.5 px-2.5",
      active
        ? "bg-muted text-foreground dark:bg-surface-raised"
        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground dark:text-foreground/75 dark:hover:bg-surface-2"
    );
  const navIconClass = (active: boolean) =>
    cn(
      "h-4 w-4 shrink-0 transition-colors duration-100",
      active
        ? "text-primary"
        : "text-muted-foreground/70 group-hover:text-foreground/80 dark:text-foreground/55"
    );

  return (
    <SettingsVisibleProvider value={open}>
      <section
        ref={setRoot}
        // requestSettingsClose finds the layer by this attribute.
        data-settings-layer=""
        tabIndex={-1}
        aria-label={t("settingsModal.title")}
        inert={!open}
        className={cn(
          "absolute inset-0 z-40 flex bg-surface-window outline-none",
          !open && "hidden"
        )}
      >
        {/* The rail stands in for the app sidebar; on macOS it clears the traffic lights. */}
        <nav
          aria-label={t("settingsLayer.appViews")}
          className={cn(
            "flex h-full shrink-0 flex-col items-center pb-2",
            platform === "darwin" ? "w-20" : "w-14"
          )}
        >
          <div className="h-10 w-full shrink-0" style={dragStyle} />
          <div className="flex flex-col items-center gap-1 pt-2">
            {railItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectView(item.id)}
                  title={item.label}
                  aria-label={item.label}
                  className={railButtonClass}
                >
                  <Icon size={16} className={railIconClass} />
                </button>
              );
            })}
          </div>
          <div className="flex-1" />
          <span
            aria-hidden="true"
            title={t("sidebar.settings")}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/8 text-primary dark:bg-primary/10"
          >
            <Settings size={16} />
          </span>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col py-2 pe-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-clip rounded-(--radius-shell) border border-border bg-background dark:border-white/10">
            <header
              className="grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,340px)_minmax(max-content,1fr)] items-center gap-4 border-b border-border px-4 dark:border-white/10"
              style={dragStyle}
            >
              {/* Global h1 styles are display-sized; this is chrome, so pin it down. */}
              <h1 className="flex min-w-0 items-center gap-1.5 text-sm! font-medium! leading-none! tracking-normal!">
                <span className="shrink-0 text-muted-foreground">{t("settingsModal.title")}</span>
                <ChevronRight
                  size={12}
                  className="shrink-0 text-muted-foreground/60 rtl:rotate-180"
                />
                <span className="truncate text-foreground">{sectionLabel}</span>
              </h1>
              <button
                type="button"
                onClick={onOpenSearch}
                data-no-window-drag=""
                style={noDragStyle}
                className="flex h-8 w-full items-center gap-2.5 rounded-full border border-border bg-foreground/4 px-4 text-start outline-none transition-colors duration-150 hover:bg-foreground/6 focus-visible:ring-1 focus-visible:ring-primary/30 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/8"
              >
                <Search size={14} className="shrink-0 text-muted-foreground/70" />
                <span className="flex-1 truncate text-[13px] text-muted-foreground/70">
                  {t("commandSearch.placeholder")}
                </span>
                <kbd
                  dir="ltr"
                  className="shrink-0 rounded-full bg-foreground/6 px-1.5 py-px font-sans text-[10px] font-medium text-muted-foreground/70 dark:bg-white/8"
                >
                  {platform === "darwin" ? "⌘ + K" : "Ctrl + K"}
                </kbd>
              </button>
              <div className="col-start-3 flex items-center">
                {platform !== "darwin" && open && (
                  <div data-no-window-drag="" style={noDragStyle} className="ms-auto">
                    <WindowControls />
                  </div>
                )}
              </div>
            </header>

            <div className="flex min-h-0 flex-1">
              <aside
                className={cn(
                  "flex shrink-0 flex-col border-e border-border/70 bg-surface-1 transition-[width] duration-200 ease-out dark:border-border-subtle dark:bg-surface-0",
                  navIconsOnly ? "w-12" : "w-[236px]"
                )}
              >
                {!navIconsOnly && navTop}
                <nav
                  aria-label={t("settingsLayer.sections")}
                  className={cn(
                    "flex-1 overflow-y-auto pb-3",
                    navIconsOnly ? "px-1.5 pt-2" : "px-2 pt-2"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onRequestClose()}
                    title={navIconsOnly ? backLabel : undefined}
                    aria-label={navIconsOnly ? backLabel : undefined}
                    className={navRowClass(false)}
                  >
                    <ChevronLeft className={cn(navIconClass(false), "rtl:rotate-180")} />
                    {!navIconsOnly && (
                      <>
                        <span className="min-w-0 flex-1 truncate">{backLabel}</span>
                        <kbd
                          dir="ltr"
                          className="shrink-0 font-sans text-[10px] text-muted-foreground/70"
                        >
                          Esc
                        </kbd>
                      </>
                    )}
                  </button>

                  {header && !navIconsOnly && <div className="px-2 pt-4 pb-1">{header}</div>}
                  {notice && (
                    <div className={cn("flex justify-center", navIconsOnly ? "pt-3" : "px-2 pt-1")}>
                      <span
                        aria-hidden="true"
                        title={notice.description}
                        className="inline-flex items-center gap-1.5 text-center text-[11px] text-primary"
                      >
                        {notice.icon}
                        {!navIconsOnly && notice.label}
                      </span>
                      <span className="sr-only">{notice.description}</span>
                    </div>
                  )}

                  {groupedItems.map((group, groupIndex) => (
                    <div key={group.label ?? groupIndex} className="mt-4">
                      {!navIconsOnly && group.label && (
                        <div className="px-2.5 pb-1">
                          <span className="text-[11px] font-medium text-muted-foreground/70 dark:text-muted-foreground/65">
                            {group.label}
                          </span>
                        </div>
                      )}
                      <div className="space-y-px">
                        {group.items.map((item) => {
                          const Icon = item.icon;
                          const isActive = activeSection === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              data-section-id={item.id}
                              aria-current={isActive ? "page" : undefined}
                              onClick={() => onSectionChange(item.id)}
                              title={navIconsOnly ? item.label : undefined}
                              aria-label={navIconsOnly ? item.label : undefined}
                              className={navRowClass(isActive)}
                            >
                              <Icon className={navIconClass(isActive)} />
                              {!navIconsOnly && (
                                <span
                                  className={cn(
                                    "min-w-0 flex-1 truncate leading-tight",
                                    isActive ? "font-medium" : "font-normal"
                                  )}
                                >
                                  {item.label}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </nav>
              </aside>

              <div
                ref={setContent}
                // revealSetting aligns tall anchors to the top of this scroller.
                data-settings-scroller=""
                onScroll={(event) => {
                  if (open) scrollTopRef.current = event.currentTarget.scrollTop;
                }}
                className="min-w-0 flex-1 overflow-y-auto bg-background dark:bg-surface-1"
              >
                <SettingsLayoutProvider value={layout}>
                  <div
                    className={cn("w-full max-w-[920px]", isCompact ? "p-4" : "px-8 pt-6 pb-16")}
                  >
                    {/* With the nav folded to icons, the search field heads the content. */}
                    {navIconsOnly && navTop && <div className="-mx-2 mb-4">{navTop}</div>}
                    {searching && searchResults}
                    <div data-settings-page="" className={searching ? "hidden" : undefined}>
                      {children}
                    </div>
                  </div>
                </SettingsLayoutProvider>
              </div>
            </div>
          </div>
        </div>
      </section>
    </SettingsVisibleProvider>
  );
}
