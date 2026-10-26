import LogsSection from "./LogsSection";

/**
 * Settings › Data › Storage: what OpenWhispr keeps on this computer. Its header
 * comes from SettingsPage; the sections follow (the Logs section for now;
 * recordings and the inventory of everything else are to come above it).
 */
export default function StoragePage({ showing }: { showing: boolean }) {
  return (
    <div className="space-y-6">
      <LogsSection showing={showing} />
    </div>
  );
}
