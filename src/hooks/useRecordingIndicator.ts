import { useEffect, useMemo, type CSSProperties } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import {
  normalizeRecordingIndicatorColor,
  normalizeRecordingIndicatorStyle,
  recordingIndicatorCssVars,
} from "../helpers/recordingIndicator";
import type { RecordingIndicatorStyle } from "../types/electron";

/**
 * The floating icon's recording style and the CSS variables its pill and
 * cancel skin read. Follows Settings live in every window that hosts a pill:
 * the companion pill window never runs initializeSettings, so it would
 * otherwise miss the store's storage listener. Duplicate updates in the
 * dictation window are harmless — the values are normalized and equal.
 */
export function useRecordingIndicator(): {
  recordingStyle: RecordingIndicatorStyle;
  recordingVars: CSSProperties;
} {
  const recordingStyle = useSettingsStore((s) => s.recordingIndicatorStyle);
  const recordingColor = useSettingsStore((s) => s.recordingIndicatorColor);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.newValue === null) return;
      if (event.key === "recordingIndicatorStyle") {
        useSettingsStore.setState({
          recordingIndicatorStyle: normalizeRecordingIndicatorStyle(
            event.newValue
          ) as RecordingIndicatorStyle,
        });
      } else if (event.key === "recordingIndicatorColor") {
        useSettingsStore.setState({
          recordingIndicatorColor: normalizeRecordingIndicatorColor(event.newValue),
        });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const recordingVars = useMemo(
    () => recordingIndicatorCssVars(recordingColor) as CSSProperties,
    [recordingColor]
  );

  return { recordingStyle, recordingVars };
}
