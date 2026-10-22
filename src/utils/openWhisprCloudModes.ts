import type { InferenceMode } from "../types/electron";

interface CloudModeOption {
  id: InferenceMode;
  disabled?: boolean;
  signInRequired?: boolean;
  badge?: string;
  description?: string;
}

/**
 * With the OpenWhispr account & Cloud switch off, the OpenWhispr Cloud mode
 * disappears from a picker. If it is the stored selection it stays, plainly
 * unavailable (no sign-in offer), so the user can see it and pick another.
 */
export function applyCloudSwitchToModeOptions<T extends CloudModeOption>(
  options: T[],
  cloudDisabled: boolean,
  selectedMode: InferenceMode | null,
  unavailable: { badge: string; description: string }
): T[] {
  if (!cloudDisabled) return options;
  return options.flatMap((option) => {
    if (option.id !== "openwhispr") return [option];
    if (selectedMode !== "openwhispr") return [];
    return [
      {
        ...option,
        disabled: true,
        signInRequired: false,
        badge: unavailable.badge,
        description: unavailable.description,
      },
    ];
  });
}

export function isModeAllowedWithCloudSwitch(mode: InferenceMode, cloudDisabled: boolean): boolean {
  return !(cloudDisabled && mode === "openwhispr");
}
