import { useCallback, useMemo, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { cn } from "../lib/utils";
import { VoicePill } from "../dictation/VoicePill";
import { SELECT_CLASS } from "./FloatingIconPlacementRows";
import {
  RECORDING_INDICATOR_COLORS,
  RECORDING_INDICATOR_STYLES,
  recordingIndicatorCssVars,
  resolveRecordingAccent,
} from "../../helpers/recordingIndicator";
import type { RecordingIndicatorStyle } from "../../types/electron";

const STYLE_KEYS: Record<RecordingIndicatorStyle, { label: string; description: string }> = {
  classic: {
    label: "settingsPage.general.floatingIcon.recordingStyleClassic",
    description: "settingsPage.general.floatingIcon.recordingStyleClassicDescription",
  },
  tinted: {
    label: "settingsPage.general.floatingIcon.recordingStyleTinted",
    description: "settingsPage.general.floatingIcon.recordingStyleTintedDescription",
  },
  solid: {
    label: "settingsPage.general.floatingIcon.recordingStyleSolid",
    description: "settingsPage.general.floatingIcon.recordingStyleSolidDescription",
  },
  beacon: {
    label: "settingsPage.general.floatingIcon.recordingStyleBeacon",
    description: "settingsPage.general.floatingIcon.recordingStyleBeaconDescription",
  },
};

const COLOR_IDS = Object.keys(RECORDING_INDICATOR_COLORS) as Array<
  keyof typeof RECORDING_INDICATOR_COLORS
>;

const COLOR_LABEL_KEYS: Record<(typeof COLOR_IDS)[number], string> = {
  red: "settingsPage.general.floatingIcon.colorRed",
  coral: "settingsPage.general.floatingIcon.colorCoral",
  amber: "settingsPage.general.floatingIcon.colorAmber",
  green: "settingsPage.general.floatingIcon.colorGreen",
  cyan: "settingsPage.general.floatingIcon.colorCyan",
  blue: "settingsPage.general.floatingIcon.colorBlue",
  purple: "settingsPage.general.floatingIcon.colorPurple",
  pink: "settingsPage.general.floatingIcon.colorPink",
};

const SWATCH_CLASS =
  "size-5 rounded-full border-2 transition-[border-color,transform] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed";

interface RecordingIndicatorRowsProps {
  recordingIndicatorStyle: RecordingIndicatorStyle;
  setRecordingIndicatorStyle: (style: RecordingIndicatorStyle) => void;
  recordingIndicatorColor: string;
  setRecordingIndicatorColor: (color: string) => void;
}

// A speech-like RMS level for the preview pill (conversational speech sits
// around 0.02–0.15, see waveformMath.ts): bursts of syllables and short
// pauses, so the waveform reads like a real recording.
function useSyntheticLevel() {
  const talkRef = useRef(0);
  return useCallback(() => {
    if (talkRef.current <= 0) {
      talkRef.current =
        Math.random() < 0.82
          ? 3 + Math.floor(Math.random() * 9)
          : -(1 + Math.floor(Math.random() * 3));
    }
    if (talkRef.current > 0) {
      talkRef.current -= 1;
      return 0.02 + Math.random() * 0.12;
    }
    talkRef.current += 1;
    return Math.random() * 0.004;
  }, []);
}

export function RecordingIndicatorRows({
  recordingIndicatorStyle,
  setRecordingIndicatorStyle,
  recordingIndicatorColor,
  setRecordingIndicatorColor,
}: RecordingIndicatorRowsProps) {
  const { t } = useTranslation();
  const getLevel = useSyntheticLevel();
  const previewVars = useMemo(
    () => recordingIndicatorCssVars(recordingIndicatorColor) as CSSProperties,
    [recordingIndicatorColor]
  );
  const colorDisabled = recordingIndicatorStyle === "classic";
  const customSelected = recordingIndicatorColor.startsWith("#");

  return (
    <>
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.general.floatingIcon.recordingStyle")}
          description={t(STYLE_KEYS[recordingIndicatorStyle].description)}
        >
          <div className="flex items-center gap-2">
            <div className="p-3" style={previewVars} aria-hidden="true">
              <VoicePill
                variant="floating"
                state="recording"
                expanded
                getAudioLevel={getLevel}
                recordingStyle={recordingIndicatorStyle}
                className="pointer-events-none"
              />
            </div>
            <select
              value={recordingIndicatorStyle}
              onChange={(e) =>
                setRecordingIndicatorStyle(e.target.value as RecordingIndicatorStyle)
              }
              className={SELECT_CLASS}
              aria-label={t("settingsPage.general.floatingIcon.recordingStyle")}
            >
              {RECORDING_INDICATOR_STYLES.map((style: RecordingIndicatorStyle) => (
                <option key={style} value={style}>
                  {t(STYLE_KEYS[style].label)}
                </option>
              ))}
            </select>
          </div>
        </SettingsRow>
      </SettingsPanelRow>
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.general.floatingIcon.recordingColor")}
          description={t("settingsPage.general.floatingIcon.recordingColorDescription")}
        >
          <div
            role="radiogroup"
            aria-label={t("settingsPage.general.floatingIcon.recordingColor")}
            aria-disabled={colorDisabled || undefined}
            className={cn("flex items-center gap-1.5", colorDisabled && "opacity-45")}
          >
            {COLOR_IDS.map((id) => {
              const selected = recordingIndicatorColor === id;
              const label = t(COLOR_LABEL_KEYS[id]);
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={label}
                  title={label}
                  disabled={colorDisabled}
                  onClick={() => setRecordingIndicatorColor(id)}
                  className={cn(
                    SWATCH_CLASS,
                    selected ? "border-foreground" : "border-transparent hover:scale-110"
                  )}
                  style={{ backgroundColor: RECORDING_INDICATOR_COLORS[id] }}
                />
              );
            })}
            <label
              title={t("settingsPage.general.floatingIcon.colorCustom")}
              className={cn(
                SWATCH_CLASS,
                "relative overflow-hidden",
                colorDisabled ? "cursor-not-allowed" : "cursor-pointer",
                customSelected ? "border-foreground" : "border-transparent hover:scale-110"
              )}
              style={{
                background: customSelected
                  ? resolveRecordingAccent(recordingIndicatorColor)
                  : "conic-gradient(#ef3b3b, #f5a524, #22c55e, #06b6d4, #3466e2, #8b5cf6, #ec4899, #ef3b3b)",
              }}
            >
              <input
                type="color"
                role="radio"
                aria-checked={customSelected}
                aria-label={t("settingsPage.general.floatingIcon.colorCustom")}
                disabled={colorDisabled}
                value={resolveRecordingAccent(recordingIndicatorColor)}
                onChange={(e) => setRecordingIndicatorColor(e.target.value)}
                className="absolute inset-0 cursor-[inherit] opacity-0"
              />
            </label>
          </div>
        </SettingsRow>
      </SettingsPanelRow>
    </>
  );
}
