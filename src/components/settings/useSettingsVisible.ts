import React from "react";

// Settings stays mounted once opened and is hidden when closed. Its polling and
// OS queries read this to pause while hidden and refresh when shown again.
// Outside Settings (onboarding, Notes) nothing provides it, so it reads true.
const SettingsVisibleContext = React.createContext(true);

export const SettingsVisibleProvider = SettingsVisibleContext.Provider;

export const useSettingsVisible = () => React.useContext(SettingsVisibleContext);
