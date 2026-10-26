import LogsSection from "./LogsSection";
import RecordingsSection from "./RecordingsSection";
import {
  EverythingElseSection,
  HistoryDatabaseSection,
  StorageOverview,
} from "./StorageInventorySections";
import { useSettingsVisible } from "./useSettingsVisible";
import { useStorageInventory } from "./useStorageInventory";

/**
 * Settings › Data › Storage: what OpenWhispr keeps on this computer. Its header
 * comes from SettingsPage; then the size bar of everything, Recordings, Logs,
 * the History database and everything else. Main measures the sizes when the
 * page shows while Settings is visible (and on Refresh or after an action);
 * a hidden page reads nothing.
 */
export default function StoragePage({ showing }: { showing: boolean }) {
  const settingsVisible = useSettingsVisible();
  const active = showing && settingsVisible;
  const inventory = useStorageInventory(active);
  const remeasure = () => void inventory.refresh();

  return (
    <div className="space-y-6">
      <StorageOverview inventory={inventory} />
      <div className="border-t border-border/70 pt-6">
        <RecordingsSection
          active={active}
          pace={inventory.result?.recordingPace ?? null}
          folderPath={inventory.item("recordings")?.path ?? null}
          onChanged={remeasure}
        />
      </div>
      <div className="border-t border-border/70 pt-6">
        <LogsSection showing={showing} onCleared={remeasure} />
      </div>
      <div className="border-t border-border/70 pt-6">
        <HistoryDatabaseSection inventory={inventory} />
      </div>
      <div className="border-t border-border/70 pt-6">
        <EverythingElseSection inventory={inventory} />
      </div>
    </div>
  );
}
