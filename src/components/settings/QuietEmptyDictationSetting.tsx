import { useTranslation } from "react-i18next";
import { SettingsRow } from "../ui/SettingsSection";
import { SELECT_CLASS } from "./FloatingIconPlacementRows";
import { useSettingsStore } from "../../stores/settingsStore";
import { QUIET_EMPTY_DICTATION_SECONDS } from "../../utils/emptyDictation.js";

// Settings › Dictation › Recognition › "End empty dictations quietly"
// (`quietEmptyDictationSeconds`): a dictation shorter than this that comes
// back with no text just ends, with the pill's spin-down; a longer one still
// says "We didn't catch that" (emptyDictation.js).

export default function QuietEmptyDictationSetting() {
  const { t } = useTranslation();
  const seconds = useSettingsStore((s) => s.quietEmptyDictationSeconds);
  const setSeconds = useSettingsStore((s) => s.setQuietEmptyDictationSeconds);
  const label = t("settingsPage.quietEmptyDictation.title");

  return (
    <SettingsRow label={label} description={t("settingsPage.quietEmptyDictation.description")}>
      <select
        value={seconds}
        onChange={(e) => setSeconds(Number(e.target.value))}
        className={SELECT_CLASS}
        aria-label={label}
      >
        {QUIET_EMPTY_DICTATION_SECONDS.map((option: number) => (
          <option key={option} value={option}>
            {option === 0
              ? t("settingsPage.quietEmptyDictation.off")
              : t("settingsPage.quietEmptyDictation.shorterThan", { seconds: option })}
          </option>
        ))}
      </select>
    </SettingsRow>
  );
}
