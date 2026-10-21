import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import type { FloatingIconDisplayInfo, PanelPosition } from "../../types/electron";
import { relativeDisplayDirection } from "../../helpers/floatingIconPlacement";

const SELECT_CLASS =
  "h-7 max-w-64 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 transition-colors duration-200";

const ROWS = ["top", "middle", "bottom"] as const;
const COLUMNS = ["left", "center", "right"] as const;
// Dot centers inside the display-shaped frame, in percent.
const ROW_Y: Record<(typeof ROWS)[number], number> = { top: 20, middle: 50, bottom: 80 };
const COLUMN_X: Record<(typeof COLUMNS)[number], number> = { left: 10, center: 50, right: 90 };

const POSITION_LABEL_KEYS: Record<PanelPosition, string> = {
  "top-left": "settingsPage.general.floatingIcon.topLeft",
  "top-center": "settingsPage.general.floatingIcon.topCenter",
  "top-right": "settingsPage.general.floatingIcon.topRight",
  "middle-left": "settingsPage.general.floatingIcon.middleLeft",
  "middle-center": "settingsPage.general.floatingIcon.middleCenter",
  "middle-right": "settingsPage.general.floatingIcon.middleRight",
  "bottom-left": "settingsPage.general.floatingIcon.bottomLeft",
  center: "settingsPage.general.floatingIcon.center",
  "bottom-right": "settingsPage.general.floatingIcon.bottomRight",
};

function toPosition(row: (typeof ROWS)[number], column: (typeof COLUMNS)[number]): PanelPosition {
  // Bottom-center keeps its legacy stored spelling.
  if (row === "bottom" && column === "center") return "center";
  return `${row}-${column}` as PanelPosition;
}

const DIRECTION_KEYS: Record<string, string> = {
  above: "settingsPage.general.floatingIcon.displayAbove",
  below: "settingsPage.general.floatingIcon.displayBelow",
  left: "settingsPage.general.floatingIcon.displayLeft",
  right: "settingsPage.general.floatingIcon.displayRight",
  "above-left": "settingsPage.general.floatingIcon.displayAboveLeft",
  "above-right": "settingsPage.general.floatingIcon.displayAboveRight",
  "below-left": "settingsPage.general.floatingIcon.displayBelowLeft",
  "below-right": "settingsPage.general.floatingIcon.displayBelowRight",
};

interface FloatingIconPlacementRowsProps {
  panelStartPosition: PanelPosition;
  setPanelStartPosition: (position: PanelPosition) => void;
  floatingIconDisplay: string;
  floatingIconDisplayLabel: string;
  setFloatingIconDisplay: (display: string, label: string) => void;
}

export function FloatingIconPlacementRows({
  panelStartPosition,
  setPanelStartPosition,
  floatingIconDisplay,
  floatingIconDisplayLabel,
  setFloatingIconDisplay,
}: FloatingIconPlacementRowsProps) {
  const { t } = useTranslation();
  const [displays, setDisplays] = useState<FloatingIconDisplayInfo[]>([]);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let disposed = false;
    window.electronAPI
      ?.getDisplays?.()
      .then((list) => {
        if (!disposed && Array.isArray(list)) setDisplays(list);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI?.onDisplaysChanged?.((list) => {
      if (Array.isArray(list)) setDisplays(list);
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const lockedId =
    floatingIconDisplay !== "cursor" && floatingIconDisplay !== "primary"
      ? floatingIconDisplay
      : null;
  const lockedDisplay = lockedId ? displays.find((display) => display.id === lockedId) : null;

  const primary = displays.find((display) => display.primary) ?? null;

  const displayName = (display: FloatingIconDisplayInfo, index: number) => {
    const name =
      display.label.trim() ||
      t("settingsPage.general.floatingIcon.displayUnnamed", { number: index + 1 });
    if (display.primary) {
      return t("settingsPage.general.floatingIcon.displayOptionPrimary", { name });
    }
    const where = primary ? relativeDisplayDirection(display.bounds, primary.bounds) : null;
    return where
      ? t("settingsPage.general.floatingIcon.displayOption", {
          name,
          where: t(DIRECTION_KEYS[where]),
        })
      : name;
  };

  const handleDisplayChange = (value: string) => {
    if (value === "cursor" || value === "primary") {
      setFloatingIconDisplay(value, "");
      return;
    }
    const display = displays.find((candidate) => candidate.id === value);
    setFloatingIconDisplay(value, display?.label ?? floatingIconDisplayLabel);
  };

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      await window.electronAPI?.previewFloatingIconPlacement?.();
    } finally {
      setPreviewing(false);
    }
  };

  // The picker takes the shape of the display the icon will use.
  const frameDisplay = lockedDisplay ?? primary;
  const aspect = frameDisplay ? frameDisplay.bounds.width / frameDisplay.bounds.height : 16 / 9;
  const frameHeight = 64;
  const frameWidth = Math.min(200, Math.max(84, Math.round(frameHeight * aspect)));

  return (
    <>
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.general.floatingIcon.display")}
          description={t("settingsPage.general.floatingIcon.displayDescription")}
        >
          <select
            value={floatingIconDisplay}
            onChange={(e) => handleDisplayChange(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="cursor">{t("settingsPage.general.floatingIcon.displayCursor")}</option>
            <option value="primary">{t("settingsPage.general.floatingIcon.displayPrimary")}</option>
            {displays.map((display, index) => (
              <option key={display.id} value={display.id}>
                {displayName(display, index)}
              </option>
            ))}
            {lockedId && !lockedDisplay && (
              <option value={lockedId}>
                {t("settingsPage.general.floatingIcon.displayDisconnected", {
                  name:
                    floatingIconDisplayLabel ||
                    t("settingsPage.general.floatingIcon.displayUnnamed", { number: "?" }),
                })}
              </option>
            )}
          </select>
        </SettingsRow>
      </SettingsPanelRow>
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.general.floatingIcon.startPosition")}
          description={t(POSITION_LABEL_KEYS[panelStartPosition])}
        >
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePreview}
              disabled={previewing}
              title={t("settingsPage.general.floatingIcon.showMeHint")}
            >
              {t("settingsPage.general.floatingIcon.showMe")}
            </Button>
            <div
              role="radiogroup"
              aria-label={t("settingsPage.general.floatingIcon.startPositionDescription")}
              className="relative rounded border border-border/70 bg-surface-1/80 shadow-sm"
              style={{ width: frameWidth, height: frameHeight }}
            >
              {ROWS.flatMap((row) =>
                COLUMNS.map((column) => {
                  const position = toPosition(row, column);
                  const selected = panelStartPosition === position;
                  return (
                    <button
                      key={position}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={t(POSITION_LABEL_KEYS[position])}
                      title={t(POSITION_LABEL_KEYS[position])}
                      onClick={() => setPanelStartPosition(position)}
                      className={cn(
                        "absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border transition-colors duration-150",
                        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                        selected
                          ? "border-primary bg-primary"
                          : "border-border-hover bg-surface-2 hover:border-primary/70"
                      )}
                      style={{ left: `${COLUMN_X[column]}%`, top: `${ROW_Y[row]}%` }}
                    />
                  );
                })
              )}
            </div>
          </div>
        </SettingsRow>
      </SettingsPanelRow>
    </>
  );
}
