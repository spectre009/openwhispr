// Style hotkeys (Stage 4): each dictation style may bind a key. The keys are
// extra keys on the dictation hotkey slot, so they follow the activation mode
// (Hold or Tap) through the same push-to-talk path as the dictation hotkey,
// and a press carries its style id (hotkeyManager.getStyleIdForHotkey).
//
// Main is the authority for the bindings: it is the only side that knows
// whether a key registered, and it needs the map at boot, before any window
// exists. The committed map lives in hotkeyManager.styleKeys and in .env
// (`DICTATION_STYLE_KEYS`, a JSON hotkey -> style id map). The style record's
// `hotkey` field (renderer, config/styles/library.ts) is a mirror for the UI,
// rewritten from every `style-hotkeys-changed` broadcast. A window that deletes
// a style, switches it off or empties it reports the styles that may still
// hold a key (`syncStyles`), and main releases the others.
//
// Every change runs one at a time. A key is committed only after it
// registered, and .env is written after that; a failed write puts the previous
// map back, registrations included.

const debugLogger = require("./debugLogger");
const { i18nMain } = require("./i18nMain");
const { isValidStyleId, parseStyleKeyMap, serializeStyleKeyMap } = require("./hotkeyList");

const STYLE_HOTKEYS_CHANGED_CHANNEL = "style-hotkeys-changed";

const EMPTY_STATE = Object.freeze({ bindings: [], supported: false, unsupportedReason: null });

function createStyleHotkeys({
  hotkeyManager,
  environmentManager,
  reconcileNativeKeyListeners = () => {},
  broadcast = () => {},
  logger = debugLogger,
  i18n = i18nMain,
}) {
  let queue = Promise.resolve();
  const serialize = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const getState = () => hotkeyManager.getStyleKeyState();

  const publish = () => {
    const state = getState();
    broadcast(STYLE_HOTKEYS_CHANGED_CHANNEL, state);
    return state;
  };

  const reconcile = () => {
    try {
      reconcileNativeKeyListeners();
    } catch (error) {
      logger?.warn?.("Couldn't update the key listeners", { error: error?.message }, "hotkey");
    }
  };

  /** Boot, before the dictation hotkey registers: read the committed map. */
  function loadFromEnv() {
    const map = parseStyleKeyMap(environmentManager.getDictationStyleKeys?.() ?? "");
    hotkeyManager.setStyleKeys(map);
    if (map.size > 0) logger?.debug?.("Style hotkeys loaded", { count: map.size }, "hotkey");
    return map;
  }

  // Writes the committed map to .env. On failure the previous map is put back
  // (registrations too) and the reason is returned.
  async function persist(previous) {
    const value = serializeStyleKeyMap(hotkeyManager.getStyleKeys());
    try {
      await environmentManager.saveDictationStyleKeys(value);
      return null;
    } catch (error) {
      logger?.warn?.("Couldn't save the style hotkeys", { error: error?.message }, "hotkey");
      hotkeyManager.restoreStyleKeys(previous);
      reconcile();
      return i18n.t("hotkey.errors.styleKeySaveFailed");
    }
  }

  /** Binds `hotkey` to `styleId`; null or "" removes the style's key. */
  function set(styleId, hotkey) {
    return serialize(async () => {
      const previous = hotkeyManager.getStyleKeys();
      const result = hotkeyManager.setStyleKey(styleId, hotkey);
      reconcile();
      if (!result.success) {
        return {
          success: false,
          message: result.error,
          reason: result.reason ?? null,
          ...getState(),
        };
      }
      if (!result.changed) return { success: true, ...getState() };
      const failure = await persist(previous);
      const state = publish();
      if (failure) return { success: false, message: failure, reason: "save_failed", ...state };
      return { success: true, ...state };
    });
  }

  /** Releases the keys of every style not in `styleIds` (deleted, off or emptied). */
  function syncStyles(styleIds) {
    const ids = Array.isArray(styleIds) ? styleIds.filter(isValidStyleId) : [];
    return serialize(async () => {
      const previous = hotkeyManager.getStyleKeys();
      const result = hotkeyManager.syncStyleKeys(ids);
      if (!result.changed) return { success: true, ...getState() };
      reconcile();
      const failure = await persist(previous);
      const state = publish();
      if (failure) return { success: false, message: failure, reason: "save_failed", ...state };
      return { success: true, ...state };
    });
  }

  /**
   * Re-runs the slot builder for the current backend and activation mode
   * (after an activation-mode or dictation hotkey change); tells the windows
   * only when a binding's status changed.
   */
  function revalidate() {
    return serialize(async () => {
      const before = JSON.stringify(getState());
      hotkeyManager.refreshStyleKeyRegistration();
      reconcile();
      return JSON.stringify(getState()) === before ? getState() : publish();
    });
  }

  /**
   * Boot, once the dictation hotkey's backend has settled: registers what its
   * registration didn't, and says why each committed key that isn't live
   * isn't, so none is silently dropped.
   */
  function finishBoot() {
    return serialize(async () => {
      hotkeyManager.refreshStyleKeyRegistration();
      reconcile();
      const state = publish();
      for (const binding of state.bindings) {
        if (binding.active) continue;
        hotkeyManager.notifyHotkeyFailure?.(binding.hotkey, {
          error: i18n.t("hotkey.errors.styleKeyInactive", {
            hotkey: binding.hotkey,
            reason: binding.error ?? "",
          }),
          suggestions: [],
        });
      }
      return state;
    });
  }

  /** Tells the windows the current state (e.g. after the dictation hotkey changed). */
  function notifyChanged() {
    return serialize(async () => publish());
  }

  return { loadFromEnv, getState, set, syncStyles, revalidate, finishBoot, notifyChanged };
}

/** The IPC every window uses; `getService` may return null before main is ready. */
function registerStyleHotkeyIpc(ipcMain, getService) {
  ipcMain.handle("style-hotkeys-get", () => getService()?.getState() ?? EMPTY_STATE);
  ipcMain.handle("style-hotkeys-set", async (_event, payload) => {
    const service = getService();
    if (!service) return { success: false, ...EMPTY_STATE };
    const styleId = typeof payload?.styleId === "string" ? payload.styleId : "";
    const hotkey = typeof payload?.hotkey === "string" ? payload.hotkey : null;
    return service.set(styleId, hotkey);
  });
  ipcMain.handle("style-hotkeys-sync-styles", async (_event, styleIds) => {
    const service = getService();
    if (!service) return { success: false, ...EMPTY_STATE };
    return service.syncStyles(Array.isArray(styleIds) ? styleIds : []);
  });
}

module.exports = {
  STYLE_HOTKEYS_CHANGED_CHANNEL,
  createStyleHotkeys,
  registerStyleHotkeyIpc,
};
