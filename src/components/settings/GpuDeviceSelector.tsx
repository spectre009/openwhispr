import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GpuDevice } from "../../types/electron";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";

type GpuPurpose = "transcription" | "intelligence";

// Each purpose's picker shows on its feature page and on AI Connections & Local
// Models; a pick in one tells the other, since main holds the value.
const listeners = new Map<GpuPurpose, Set<(uuid: string) => void>>();

function subscribe(purpose: GpuPurpose, listener: (uuid: string) => void): () => void {
  if (!listeners.has(purpose)) listeners.set(purpose, new Set());
  listeners.get(purpose)!.add(listener);
  return () => listeners.get(purpose)?.delete(listener);
}

/** Which NVIDIA GPU local models of a kind run on; shown only with two or more GPUs. */
export default function GpuDeviceSelector({
  purpose,
  "data-setting-id": settingId,
}: {
  purpose: GpuPurpose;
  /** Settings search anchor; each placement has its own. */
  "data-setting-id": string;
}) {
  const { t } = useTranslation();
  const [gpus, setGpus] = useState<GpuDevice[]>([]);
  const [selectedUuid, setSelectedUuid] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      window.electronAPI?.listGpus?.() ?? Promise.resolve([]),
      window.electronAPI?.getGpuDeviceIndex?.(purpose) ?? Promise.resolve(""),
    ])
      .then(([gpuList, savedUuid]) => {
        const list = Array.isArray(gpuList) ? gpuList : [];
        setGpus(list);
        setSelectedUuid(savedUuid || list[0]?.uuid || "");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [purpose]);

  useEffect(() => subscribe(purpose, setSelectedUuid), [purpose]);

  if (!loaded || gpus.length < 2) return null;

  return (
    <div data-setting-id={settingId} className="border-t border-border/70 pt-4 mt-4">
      <SectionHeader
        title={t(`settingsPage.${purpose}.gpuDevice.title`)}
        description={t(`settingsPage.${purpose}.gpuDevice.description`)}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <div className="relative w-full">
            <select
              value={selectedUuid}
              onChange={async (e) => {
                const uuid = e.target.value;
                for (const listener of listeners.get(purpose) ?? []) listener(uuid);
                await window.electronAPI?.setGpuDeviceIndex?.(purpose, uuid);
              }}
              className="w-full appearance-none rounded-md border border-border bg-background px-3 pe-10 py-2 text-sm"
            >
              {gpus.map((gpu) => (
                <option key={gpu.uuid} value={gpu.uuid}>
                  GPU {gpu.index}: {gpu.name} ({Math.round(gpu.vramMb / 1024)}GB)
                </option>
              ))}
            </select>
            <svg
              className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}
