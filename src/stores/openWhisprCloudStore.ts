import { create } from "zustand";

/**
 * The "OpenWhispr account & Cloud" switch, owned by main (see
 * openWhisprCloudGate.js). Never persisted here: preload hands over main's
 * value synchronously and main broadcasts every change to all windows.
 */
interface OpenWhisprCloudState {
  disabled: boolean;
}

type CloudSwitchBridge = {
  openWhisprCloudDisabledAtLoad?: boolean;
  onOpenWhisprCloudDisabledChanged?: (callback: (disabled: boolean) => void) => () => void;
  setOpenWhisprCloudDisabled?: (
    disabled: boolean
  ) => Promise<{ success: boolean; code?: string; disabled: boolean }>;
};

function bridge(): CloudSwitchBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { electronAPI?: CloudSwitchBridge }).electronAPI;
}

export const useOpenWhisprCloudStore = create<OpenWhisprCloudState>(() => ({
  disabled: bridge()?.openWhisprCloudDisabledAtLoad === true,
}));

bridge()?.onOpenWhisprCloudDisabledChanged?.((disabled) => {
  useOpenWhisprCloudStore.setState({ disabled });
});

export function isOpenWhisprCloudDisabled(): boolean {
  return useOpenWhisprCloudStore.getState().disabled;
}

export function useOpenWhisprCloudDisabled(): boolean {
  return useOpenWhisprCloudStore((state) => state.disabled);
}

export interface SetOpenWhisprCloudResult {
  success: boolean;
  code?: "SIGNED_IN" | "PERSIST_FAILED" | "UNAVAILABLE";
  disabled: boolean;
}

export async function setOpenWhisprCloudDisabled(
  disabled: boolean
): Promise<SetOpenWhisprCloudResult> {
  const setter = bridge()?.setOpenWhisprCloudDisabled;
  if (!setter)
    return { success: false, code: "UNAVAILABLE", disabled: isOpenWhisprCloudDisabled() };
  const result = await setter(disabled);
  // The broadcast normally arrives first; this keeps the window that asked
  // consistent even if it doesn't.
  if (result.code !== "SIGNED_IN") useOpenWhisprCloudStore.setState({ disabled: result.disabled });
  if (result.success) return { success: true, disabled: result.disabled };
  const code =
    result.code === "SIGNED_IN" || result.code === "PERSIST_FAILED" ? result.code : "UNAVAILABLE";
  return { success: false, code, disabled: result.disabled };
}
