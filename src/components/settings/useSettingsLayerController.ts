import { useCallback, useRef, useState, type RefObject } from "react";
import { nextSettingsRequest, type SettingsRequest } from "./settingsNavigation";
import { requestSettingsClose } from "./settingsLayerPolicy";

export interface SettingsLayerController {
  open: boolean;
  /** True from the first open on: the layer then stays mounted, hidden while closed. */
  mounted: boolean;
  /** The latest named request; Settings navigates once per id. */
  request: SettingsRequest | null;
  /** What had focus before Settings opened, for when it closes. */
  returnFocusRef: RefObject<HTMLElement | null>;
  /** A named section always navigates; a bare open keeps the page Settings was on. */
  openSettings: (section?: string) => void;
  /** False when a popup or dialog kept Settings open (see requestSettingsClose). */
  closeSettings: (options?: { ignore?: Element | null }) => boolean;
  toggleSettings: () => void;
}

export function useSettingsLayerController(initialSection?: string): SettingsLayerController {
  const [open, setOpen] = useState(!!initialSection);
  const [mounted, setMounted] = useState(!!initialSection);
  const [request, setRequest] = useState<SettingsRequest | null>(() =>
    initialSection ? nextSettingsRequest(null, initialSection) : null
  );
  // Read by handlers that run before React re-renders (two requests in one event).
  const openRef = useRef(open);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const openSettings = useCallback((section?: string) => {
    if (!openRef.current) {
      openRef.current = true;
      // Captured now: once the app turns inert the browser may move focus away.
      const active = document.activeElement;
      returnFocusRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (section) setRequest((previous) => nextSettingsRequest(previous, section));
    setMounted(true);
    setOpen(true);
  }, []);

  const closeSettings = useCallback((options?: { ignore?: Element | null }) => {
    if (!openRef.current) return true;
    if (!requestSettingsClose(document, options)) return false;
    openRef.current = false;
    setOpen(false);
    return true;
  }, []);

  const toggleSettings = useCallback(() => {
    if (openRef.current) closeSettings();
    else openSettings();
  }, [closeSettings, openSettings]);

  return { open, mounted, request, returnFocusRef, openSettings, closeSettings, toggleSettings };
}
