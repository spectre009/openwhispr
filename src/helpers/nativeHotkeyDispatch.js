// Routes the Windows and Linux native key listeners' presses (one hook process
// per watched key, see windowsKeyManager.js) to the slot that owns the key.
// Dictation drives push-to-talk and needs the overlay window; meeting and
// review drive other windows (matching their globalShortcut callbacks and macOS).
//
// A style key (Stage 4) is an extra key on the dictation slot: its press goes
// down the dictation path in the user's activation mode and names its style,
// which the push freezes for the recording (windowManager.startWindowsPushToTalk)
// or the toggle carries (sendToggleDictation). The dictation hotkey names none.

function createNativeHotkeyDispatch({ hotkeyManager, windowManager, isLiveWindow }) {
  const styleIdFor = (key) => hotkeyManager.getStyleIdForHotkey?.(key) || undefined;

  const onKeyDown = (key, timing) => {
    if (hotkeyManager.slotHasHotkey("dictation", key)) {
      if (!isLiveWindow(windowManager.mainWindow)) return;
      const styleId = styleIdFor(key);
      if (windowManager.getActivationMode() === "push") {
        windowManager.startWindowsPushToTalk(key, timing, { styleId });
      } else {
        windowManager.sendToggleDictation({ styleId });
      }
      return;
    }
    if (hotkeyManager.slotHasHotkey("voiceAgent", key)) {
      windowManager.sendToggleVoiceAgent();
    } else if (hotkeyManager.slotHasHotkey("translation", key)) {
      windowManager.sendToggleTranslation();
    } else if (hotkeyManager.slotHasHotkey("meeting", key)) {
      windowManager.startManualMeeting({ activate: false });
    } else if (hotkeyManager.slotHasHotkey("review", key)) {
      void windowManager.reviewLastDictation();
    }
  };

  // Only dictation drives push-to-talk, so only its key-up matters; the push
  // ignores the release of any key but the one that started it.
  const onKeyUp = (key) => {
    if (!hotkeyManager.slotHasHotkey("dictation", key)) return;
    if (windowManager.winPushState?.active) {
      windowManager.handleWindowsPushKeyUp(key);
    } else if (
      isLiveWindow(windowManager.mainWindow) &&
      windowManager.getActivationMode() === "push"
    ) {
      windowManager.handleWindowsPushKeyUp(key);
    }
  };

  return { onKeyDown, onKeyUp };
}

module.exports = { createNativeHotkeyDispatch };
