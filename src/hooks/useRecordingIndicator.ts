import { useEffect, useMemo, type CSSProperties } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import {
  normalizeRecordingIndicatorColor,
  normalizeRecordingIndicatorStyle,
  normalizeRecordingModeColor,
  recordingIndicatorCssVars,
  resolveRecordingModeColor,
} from "../helpers/recordingIndicator";
import type { RecordingIndicatorStyle, RecordingInputKind } from "../types/electron";

// The keys a pill window must follow live, with how each is read back.
const LIVE_KEYS: Record<string, (value: string) => unknown> = {
  recordingIndicatorStyle: (value) => normalizeRecordingIndicatorStyle(value),
  recordingIndicatorColor: (value) => normalizeRecordingIndicatorColor(value),
  recordingShowElapsed: (value) => value === "true",
  recordingColorByMode: (value) => value === "true",
  recordingAssistantColor: (value) => normalizeRecordingModeColor(value, "assistant"),
  recordingTranslationColor: (value) => normalizeRecordingModeColor(value, "translation"),
};

/**
 * The floating icon's recording style, whether it shows the elapsed time, and
 * the CSS variables its pill and cancel skin read, in the color of the
 * recording's mode when "Color by mode" is on. Follows Settings live in every
 * window that hosts a pill: the companion pill window never runs
 * initializeSettings, so it would otherwise miss the store's storage
 * listener. Duplicate updates in the dictation window are harmless — the
 * values are normalized and equal.
 */
export function useRecordingIndicator(inputKind: RecordingInputKind | null = null): {
  recordingStyle: RecordingIndicatorStyle;
  recordingShowElapsed: boolean;
  recordingVars: CSSProperties;
} {
  const recordingStyle = useSettingsStore((s) => s.recordingIndicatorStyle);
  const recordingShowElapsed = useSettingsStore((s) => s.recordingShowElapsed);
  const color = useSettingsStore((s) => s.recordingIndicatorColor);
  const colorByMode = useSettingsStore((s) => s.recordingColorByMode);
  const assistantColor = useSettingsStore((s) => s.recordingAssistantColor);
  const translationColor = useSettingsStore((s) => s.recordingTranslationColor);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.newValue === null || !event.key) return;
      const read = LIVE_KEYS[event.key];
      if (read) useSettingsStore.setState({ [event.key]: read(event.newValue) });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const recordingColor = resolveRecordingModeColor(
    { color, colorByMode, assistantColor, translationColor },
    inputKind
  );
  const recordingVars = useMemo(
    () => recordingIndicatorCssVars(recordingColor) as CSSProperties,
    [recordingColor]
  );

  return { recordingStyle, recordingShowElapsed, recordingVars };
}
