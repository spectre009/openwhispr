/**
 * Settings is a layer over the Control Panel, and Radix portals its popups and
 * dialogs into document.body, outside it. Hiding Settings under an open popup
 * would leave the popup floating over the app (and a modal one keeps
 * `pointer-events: none` on the body), so every way out of Settings goes
 * through these rules first. Kept free of React so they're unit-tested.
 */

/** Marks the Settings layer's root. */
export const SETTINGS_LAYER_ATTRIBUTE = "data-settings-layer";
/** Marks the Ctrl+K palette's content: leaving Settings for a palette result ignores it. */
export const COMMAND_PALETTE_ATTRIBUTE = "data-command-palette";

const POPPER_WRAPPER = "[data-radix-popper-content-wrapper]";
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
// Item-aligned selects and menus that render outside a popper wrapper.
const OPEN_RADIX_POPUP = '[role="menu"][data-state="open"], [role="listbox"][data-state="open"]';
// A hand-rolled dropdown (LanguageSelector) shows only through its trigger.
const EXPANDED_POPUP_TRIGGER = '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]';
const CAPTURING_HOTKEY = "[data-capturing]";

export interface OpenOverlays {
  /** A modal dialog: a confirmation, the Ctrl+K palette. */
  dialog: boolean;
  /** A popup that Esc closes: popover, menu, select, dropdown. Tooltips don't count. */
  popup: boolean;
}

/**
 * What is open over Settings. A popper's content carries `data-state="open"`
 * until it starts closing (tooltips use `delayed-open`/`instant-open`), and a
 * popover's `role="dialog"` sits inside its popper wrapper, unlike a modal's.
 */
export function readOpenOverlays(
  doc: ParentNode,
  layer: Element | null,
  ignore?: Element | null
): OpenOverlays {
  const counts = (element: Element) => !ignore?.contains(element);
  const popup =
    Array.from(doc.querySelectorAll(POPPER_WRAPPER)).some(
      (wrapper) =>
        wrapper.firstElementChild?.getAttribute("data-state") === "open" && counts(wrapper)
    ) ||
    Array.from(doc.querySelectorAll(OPEN_RADIX_POPUP)).some(counts) ||
    (layer?.querySelector(EXPANDED_POPUP_TRIGGER) ?? null) !== null;
  const dialog = Array.from(doc.querySelectorAll(OPEN_DIALOG)).some(
    (element) => !element.closest(POPPER_WRAPPER) && counts(element)
  );
  return { dialog, popup };
}

export type SettingsCloseVerdict = "close" | "dismissPopup" | "blocked";

/** A modal dialog or a hotkey capture keeps Settings open; a popup closes first. */
export function decideSettingsClose({
  capturing,
  overlays,
}: {
  capturing: boolean;
  overlays: OpenOverlays;
}): SettingsCloseVerdict {
  if (capturing || overlays.dialog) return "blocked";
  if (overlays.popup) return "dismissPopup";
  return "close";
}

const popupDismissals = new WeakSet<Event>();

/** True for the Escape that `dismissTopPopup` sends, so Settings' own Esc rules skip it. */
export function isPopupDismissal(event: Event): boolean {
  return popupDismissals.has(event);
}

/**
 * Closes the top popup the way a user would, with Escape: at the focused
 * element for a Radix popup (it dismisses its highest layer from a document
 * listener), and at the trigger of a hand-rolled dropdown, which handles the
 * key itself and may be open while focus sits elsewhere (no search field).
 */
export function dismissTopPopup(doc: Document, layer?: Element | null): void {
  const view = doc.defaultView;
  if (!view) return;
  const event = new view.KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
  });
  popupDismissals.add(event);
  const radixPopupOpen = readOpenOverlays(doc, null).popup;
  const handRolledTrigger = radixPopupOpen ? null : layer?.querySelector(EXPANDED_POPUP_TRIGGER);
  (handRolledTrigger ?? doc.activeElement ?? doc.body).dispatchEvent(event);
}

/**
 * Every way out of Settings asks here first: true when Settings may hide now.
 * An open popup is closed instead (one step per request, like Esc), and a modal
 * dialog or a hotkey capture refuses. `ignore` leaves out the palette a result
 * was picked from, which is closing in the same step.
 */
export function requestSettingsClose(
  doc: Document,
  { ignore }: { ignore?: Element | null } = {}
): boolean {
  const layer = doc.querySelector(`[${SETTINGS_LAYER_ATTRIBUTE}]`);
  const verdict = decideSettingsClose({
    capturing: doc.querySelector(CAPTURING_HOTKEY) !== null,
    overlays: readOpenOverlays(doc, layer, ignore),
  });
  if (verdict === "dismissPopup") dismissTopPopup(doc, layer);
  return verdict === "close";
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** A field Esc should leave rather than Settings: text inputs, textareas, rich editors. */
export function isEditableElement(element: Element): boolean {
  if ((element as HTMLElement).isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !(element as HTMLTextAreaElement).readOnly;
  if (element.tagName !== "INPUT") return false;
  const input = element as HTMLInputElement;
  return !NON_TEXT_INPUT_TYPES.has(input.type) && !input.readOnly;
}

export type SettingsEscapeAction = "none" | "dismissPopup" | "blur" | "clearSearch" | "close";

export interface SettingsEscapeContext {
  /** An IME composition: Esc cancels it. */
  composing: boolean;
  /** A hotkey field is listening, and Esc may be the key being set. */
  capturing: boolean;
  /** A popup or dialog was open before anything handled this Esc. */
  overlayOpen: boolean;
  /** Of those, a popup with no modal dialog over it. */
  popupOpen?: boolean;
  /** Something else already acted on this Esc (preventDefault). */
  handled: boolean;
  /** Focus is in a text field inside Settings. */
  editableFocused: boolean;
  /** The settings search has a query. */
  searchActive: boolean;
}

/**
 * One Esc does one thing, in this order: nothing during a capture or once a
 * popup or dialog took it; a popup that didn't get it (a hand-rolled dropdown
 * open while focus is elsewhere) is closed; then leave the field, then clear
 * the search, then leave Settings. The overlay check is read before Radix
 * handles the key, so the Esc that closes a popup never closes Settings too.
 */
export function decideSettingsEscape(context: SettingsEscapeContext): SettingsEscapeAction {
  if (context.composing || context.capturing || context.handled) return "none";
  if (context.overlayOpen) return context.popupOpen ? "dismissPopup" : "none";
  if (context.editableFocused) return "blur";
  if (context.searchActive) return "clearSearch";
  return "close";
}

/**
 * Ctrl+F (⌘F on macOS) focuses the settings search; `/` does too unless focus
 * is in a text field, where it types. Neither while a hotkey field listens or a
 * popup or dialog is open over Settings.
 */
export function isSettingsSearchShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing">,
  {
    mac,
    editableFocused,
    overlayOpen,
    capturing,
  }: { mac: boolean; editableFocused: boolean; overlayOpen: boolean; capturing: boolean }
): boolean {
  if (event.isComposing || overlayOpen || capturing) return false;
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") return true;
  return event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !editableFocused;
}

/** Whether a key goes to the settings search, read from the live document. */
export function readSettingsSearchShortcut(
  doc: Document,
  layer: Element | null,
  event: KeyboardEvent,
  mac: boolean
): boolean {
  const overlays = readOpenOverlays(doc, layer);
  const active = doc.activeElement;
  return isSettingsSearchShortcut(event, {
    mac,
    editableFocused: !!active && isEditableElement(active),
    overlayOpen: overlays.dialog || overlays.popup,
    capturing: doc.querySelector(CAPTURING_HOTKEY) !== null,
  });
}

/** The Esc context, read in the capture phase before any handler runs. */
export function readEscapeContext(
  doc: Document,
  layer: Element | null,
  event: KeyboardEvent,
  searchActive: boolean
): Omit<SettingsEscapeContext, "handled"> {
  const overlays = readOpenOverlays(doc, layer);
  const active = doc.activeElement;
  return {
    composing: event.isComposing || event.keyCode === 229,
    capturing: doc.querySelector(CAPTURING_HOTKEY) !== null,
    overlayOpen: overlays.dialog || overlays.popup,
    popupOpen: overlays.popup && !overlays.dialog,
    editableFocused: !!active && !!layer?.contains(active) && isEditableElement(active),
    searchActive,
  };
}

/**
 * After Settings hides (and the app is no longer inert): back to what had focus
 * before it opened, else the fallback, else out of the hidden layer. Focus that
 * already moved elsewhere (a dialog, the palette) is left alone.
 */
export function restoreFocusAfterSettings(
  doc: Document,
  layer: Element,
  previous: HTMLElement | null,
  getFallback?: () => HTMLElement | null
): void {
  const active = doc.activeElement;
  if (active && active !== doc.body && !layer.contains(active)) return;
  for (const candidate of [previous, getFallback?.() ?? null]) {
    if (!candidate?.isConnected || layer.contains(candidate)) continue;
    candidate.focus({ preventScroll: true });
    if (doc.activeElement === candidate) return;
  }
  if (active && active !== doc.body && layer.contains(active)) (active as HTMLElement).blur();
}
