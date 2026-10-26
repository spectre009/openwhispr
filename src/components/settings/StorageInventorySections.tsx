import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AlertDialog, ConfirmDialog } from "../ui/dialog";
import { Check, ChevronRight, Copy, FolderOpen, RefreshCw, Trash2 } from "../icons";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { formatBytes } from "../../utils/formatBytes";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { clearMissingLocalModelSelections } from "../../stores/settingsStore";
import type {
  HistoryDatabaseCounts,
  StorageInventoryItem,
  StorageResourceId,
} from "../../types/electron";
import { useOpenSettingsLink } from "./settingsLink";
import type { StorageInventoryState } from "./useStorageInventory";
import {
  formatCount,
  itemPathText,
  storageBarSegments,
  type StorageBarSegment,
} from "./storageFormat";

// Settings › Storage's inventory: the size bar at the top, then (below the
// Recordings and Logs sections) the History database and everything else.
// Paths come from main, masked; actions name a resource id, never a path.

type Notice = { tone: "ok" | "error"; text: string } | null;

const LEGEND_KEYS: Record<StorageBarSegment["key"], string> = {
  recordings: "settingsPage.storage.recordings.title",
  models: "settingsPage.storage.items.models.label",
  searchIndex: "settingsPage.storage.items.searchIndex.label",
  appCache: "settingsPage.storage.items.appCache.label",
  logs: "settingsPage.storage.logs.title",
  database: "settingsPage.storage.database.title",
  other: "settingsPage.storage.overview.other",
};

const COUNT_KEYS: ReadonlyArray<keyof HistoryDatabaseCounts> = [
  "dictations",
  "stepRecords",
  "reviews",
  "testCases",
  "dictionaryWords",
  "glossaryRules",
  "notes",
];

const MODEL_KINDS = ["whisper", "parakeet", "diarization", "llm", "embedding"] as const;

/** Where "Manage in AI Connections" lands. */
export const LOCAL_MODELS_DESTINATION = "connections#connections.localModels";
/** Where "Clear history in Privacy & Data" lands. */
export const CLEAR_HISTORY_DESTINATION = "privacyData#privacy.history";

function SectionTitle({
  title,
  size,
  description,
}: {
  title: string;
  size?: string;
  description?: string;
}) {
  return (
    <div className="mb-3">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-xs font-semibold tracking-tight text-foreground">
        {title}
        {size && <span className="font-normal text-muted-foreground">{size}</span>}
      </h3>
      {description && (
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">{description}</p>
      )}
    </div>
  );
}

function useSizeText(inventory: StorageInventoryState) {
  const { t } = useTranslation();
  return (item: StorageInventoryItem | null): string => {
    if (!item) {
      return inventory.failed && !inventory.loading
        ? t("common.unknown")
        : t("settingsPage.storage.measuring");
    }
    if (item.bytes === null) return "—";
    if (!item.exists) return t("settingsPage.storage.actions.notCreated");
    return formatBytes(item.bytes, 1);
  };
}

async function openItem(id: StorageResourceId): Promise<boolean> {
  try {
    const result = await window.electronAPI?.openStorageItem?.(id);
    return !result || result.success;
  } catch {
    return false;
  }
}

function CopyPathButton({ path }: { path: string | null }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopyFeedback(path ?? "");
  const label = copied ? t("common.copied") : t("settingsPage.storage.actions.copyPath");
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={label}
      title={label}
      disabled={!path}
      onClick={() => void copy()}
      data-storage-action="copy"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function OpenButton({
  item,
  id,
  onFailed,
}: {
  item: StorageInventoryItem | null;
  id: StorageResourceId;
  onFailed: () => void;
}) {
  const { t } = useTranslation();
  const label =
    item?.target === "file"
      ? t("settingsPage.storage.actions.showInFolder")
      : t("settingsPage.storage.actions.openFolder");
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={label}
      title={label}
      disabled={!item || (!item.exists && id !== "models")}
      onClick={async () => {
        if (!(await openItem(id))) onFailed();
      }}
      data-storage-action="open"
    >
      <FolderOpen className="h-3.5 w-3.5" />
    </Button>
  );
}

/** The size bar: one segment per kind of data, a legend with sizes and the total. */
export function StorageOverview({ inventory }: { inventory: StorageInventoryState }) {
  const { t } = useTranslation();
  const { result, loading, failed, refresh } = inventory;
  const segments = storageBarSegments(result);
  const total = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const shown = segments.filter((segment) => segment.bytes > 0);

  return (
    <div data-setting-id="storage.inventory" data-storage-section="overview">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex flex-wrap items-baseline gap-x-2 text-xs font-semibold tracking-tight text-foreground">
          {t("settingsPage.storage.overview.title")}
          {result && (
            <span className="font-normal text-muted-foreground">
              {t("settingsPage.storage.overview.total", { size: formatBytes(total, 1) })}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {loading && (
            <span data-storage-measuring className="text-xs text-muted-foreground">
              {t("settingsPage.storage.measuring")}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw className={`me-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("common.refresh")}
          </Button>
        </div>
      </div>
      {result ? (
        <>
          <div
            role="img"
            aria-label={t("settingsPage.storage.overview.total", { size: formatBytes(total, 1) })}
            data-storage-bar
            className="flex h-3 w-full overflow-hidden rounded-md bg-muted/50"
          >
            {shown.map((segment) => (
              <span
                key={segment.key}
                data-storage-segment={segment.key}
                className={`h-full ${segment.className}`}
                style={{ width: `${Math.max(segment.share, 0.5)}%` }}
              />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {shown.map((segment) => (
              <li key={segment.key} data-storage-legend={segment.key} className="flex items-center">
                <span
                  aria-hidden="true"
                  className={`me-1.5 inline-block h-2.5 w-2.5 rounded-sm ${segment.className}`}
                />
                {t(LEGEND_KEYS[segment.key])}
                <span className="ms-1 font-medium text-foreground">
                  {formatBytes(segment.bytes, 1)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
            {t("settingsPage.storage.overview.description")}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {failed && !loading
            ? t("settingsPage.storage.measureFailed")
            : t("settingsPage.storage.measuring")}
        </p>
      )}
    </div>
  );
}

/** History database: its size, what it holds (counts), Show in folder. */
export function HistoryDatabaseSection({ inventory }: { inventory: StorageInventoryState }) {
  const { t, i18n } = useTranslation();
  const openSettings = useOpenSettingsLink();
  const sizeText = useSizeText(inventory);
  const item = inventory.item("database");
  const counts = inventory.result?.database.counts ?? null;
  const [notice, setNotice] = useState<Notice>(null);

  return (
    <div data-storage-section="database">
      <SectionTitle
        title={t("settingsPage.storage.database.title")}
        size={item ? sizeText(item) : undefined}
        description={t("settingsPage.storage.database.description")}
      />
      <SettingsPanel data-setting-id="storage.database">
        <SettingsPanelRow>
          {counts ? (
            <dl className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {COUNT_KEYS.map((key) => (
                <div
                  key={key}
                  data-database-count={key}
                  className="flex items-baseline justify-between gap-2 rounded-md bg-muted/40 px-2 py-1 text-xs dark:bg-surface-raised/40"
                >
                  <dt className="text-muted-foreground">
                    {t(`settingsPage.storage.database.counts.${key}`)}
                  </dt>
                  <dd className="font-medium tabular-nums text-foreground">
                    {formatCount(counts[key], i18n.language)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              {inventory.result
                ? t("settingsPage.storage.database.countsUnavailable")
                : sizeText(null)}
            </p>
          )}
        </SettingsPanelRow>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.storage.database.file")}
            description={
              item?.path ? (
                <span dir="ltr" className="block break-all font-mono text-[11px]">
                  {item.path}
                </span>
              ) : undefined
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={!item?.exists}
                onClick={async () => {
                  setNotice(null);
                  if (!(await openItem("database"))) {
                    setNotice({
                      tone: "error",
                      text: t("settingsPage.storage.actions.openFailed"),
                    });
                  }
                }}
              >
                <FolderOpen className="me-1.5 h-3.5 w-3.5" />
                {t("settingsPage.storage.actions.showInFolder")}
              </Button>
              {openSettings && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-link"
                  onClick={() => openSettings(CLEAR_HISTORY_DESTINATION)}
                >
                  {t("settingsPage.storage.database.clearHistory")}
                  <ChevronRight aria-hidden="true" className="ms-1 h-3 w-3 rtl:rotate-180" />
                </Button>
              )}
            </div>
          </SettingsRow>
          {notice && (
            <p role="status" className="mt-2 text-xs text-destructive">
              {notice.text}
            </p>
          )}
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}

function InventoryRow({
  id,
  inventory,
  children,
  details,
  tag,
  "data-setting-id": settingId,
}: {
  id: StorageResourceId;
  inventory: StorageInventoryState;
  /** Extra actions after Copy path and Open. */
  children?: ReactNode;
  /** Extra lines under the description. */
  details?: ReactNode;
  tag?: string;
  "data-setting-id"?: string;
}) {
  const { t } = useTranslation();
  const sizeText = useSizeText(inventory);
  const item = inventory.item(id);
  const [openFailed, setOpenFailed] = useState(false);
  const pathText = itemPathText(item);

  return (
    <SettingsPanelRow data-setting-id={settingId}>
      <div data-storage-item={id} className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-foreground">
            {t(`settingsPage.storage.items.${id}.label`)}
            {tag && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {tag}
              </Badge>
            )}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
            {t(`settingsPage.storage.items.${id}.description`)}
          </p>
          {details}
          {pathText && (
            <p
              dir="ltr"
              data-storage-path
              className="mt-1 break-all font-mono text-[11px] text-muted-foreground"
            >
              {pathText}
            </p>
          )}
          {openFailed && (
            <p role="status" className="mt-1 text-xs text-destructive">
              {t("settingsPage.storage.actions.openFailed")}
            </p>
          )}
        </div>
        <span data-storage-size className="pt-0.5 text-xs tabular-nums text-muted-foreground">
          {sizeText(item)}
        </span>
        <div className="flex items-center gap-1">
          <CopyPathButton path={item?.path ?? null} />
          <OpenButton item={item} id={id} onFailed={() => setOpenFailed(true)} />
          {children}
        </div>
      </div>
    </SettingsPanelRow>
  );
}

function ModelsDetails({ item }: { item: StorageInventoryItem | null }) {
  const { t } = useTranslation();
  const openSettings = useOpenSettingsLink();
  const kinds = MODEL_KINDS.map((kind) => ({
    kind,
    bytes: item?.parts.find((part) => part.key === kind)?.bytes ?? 0,
  })).filter((entry) => entry.bytes > 0);
  return (
    <>
      {kinds.length > 0 && (
        <p data-model-kinds className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {kinds
            .map(
              ({ kind, bytes }) =>
                `${t(`settingsPage.storage.modelKinds.${kind}`)} ${formatBytes(bytes, 1)}`
            )
            .join(" · ")}
        </p>
      )}
      {openSettings && (
        <button
          type="button"
          onClick={() => openSettings(LOCAL_MODELS_DESTINATION)}
          className="mt-1 inline-flex items-center text-xs text-link underline decoration-link/30 hover:decoration-link/60"
        >
          {t("settingsPage.storage.actions.manageModels")}
          <ChevronRight aria-hidden="true" className="ms-0.5 h-3 w-3 rtl:rotate-180" />
        </button>
      )}
    </>
  );
}

/** Remove all downloaded models: today's model cache action, confirm first. */
function RemoveModelsButton({
  item,
  onDone,
}: {
  item: StorageInventoryItem | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [alert, setAlert] = useState<{ title: string; description: string } | null>(null);

  const remove = async () => {
    setRemoving(true);
    try {
      const results = await Promise.allSettled([
        window.electronAPI?.deleteAllWhisperModels?.(),
        window.electronAPI?.deleteAllParakeetModels?.(),
        window.electronAPI?.modelDeleteAll?.(),
      ]);
      const anyFailed = results.some(
        (r) => r.status === "rejected" || (r.status === "fulfilled" && r.value && !r.value.success)
      );
      if (anyFailed) {
        setAlert({
          title: t("settingsPage.developer.removeModels.failedTitle"),
          description: t("settingsPage.developer.removeModels.failedDescription"),
        });
      } else {
        // Every local model is gone, so no local selection can still resolve.
        clearMissingLocalModelSelections(() => false);
        window.dispatchEvent(new Event("openwhispr-models-cleared"));
        setAlert({
          title: t("settingsPage.developer.removeModels.successTitle"),
          description: t("settingsPage.developer.removeModels.successDescription"),
        });
      }
    } catch {
      setAlert({
        title: t("settingsPage.developer.removeModels.failedTitle"),
        description: t("settingsPage.developer.removeModels.failedDescriptionShort"),
      });
    } finally {
      setRemoving(false);
      onDone();
    }
  };

  return (
    <span data-setting-id="system.data.modelCache">
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs text-destructive hover:text-destructive"
        disabled={removing}
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="me-1.5 h-3.5 w-3.5" />
        {removing
          ? t("settingsPage.developer.removing")
          : t("settingsPage.storage.actions.removeModels")}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("settingsPage.developer.removeModels.title")}
        description={t("settingsPage.developer.removeModels.description", {
          path: item?.path ?? "",
        })}
        confirmText={t("settingsPage.developer.removeModels.confirmText")}
        cancelText={t("common.cancel")}
        variant="destructive"
        onConfirm={() => void remove()}
      />
      <AlertDialog
        open={alert !== null}
        onOpenChange={(open) => !open && setAlert(null)}
        title={alert?.title ?? ""}
        description={alert?.description}
        onOk={() => setAlert(null)}
      />
    </span>
  );
}

/** App cache: Chromium's HTTP and code caches, cleared through the session (never its storage). */
function ClearAppCacheButton({ onDone }: { onDone: (notice: Notice) => void }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const clear = async () => {
    try {
      const result = await window.electronAPI?.clearStorageItem?.("appCache");
      onDone(
        result?.success
          ? { tone: "ok", text: t("settingsPage.storage.appCache.cleared") }
          : { tone: "error", text: t("settingsPage.storage.appCache.clearFailed") }
      );
    } catch {
      onDone({ tone: "error", text: t("settingsPage.storage.appCache.clearFailed") });
    }
  };
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        data-storage-action="clear"
        onClick={() => setConfirming(true)}
      >
        {t("settingsPage.storage.actions.clear")}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("settingsPage.storage.appCache.clearTitle")}
        description={t("settingsPage.storage.appCache.clearDescription")}
        confirmText={t("settingsPage.storage.actions.clear")}
        cancelText={t("common.cancel")}
        onConfirm={() => void clear()}
      />
    </>
  );
}

/** Everything else: one row per remaining place, with what it is, its size and actions. */
export function EverythingElseSection({ inventory }: { inventory: StorageInventoryState }) {
  const { t } = useTranslation();
  const [cacheNotice, setCacheNotice] = useState<Notice>(null);
  const models = inventory.item("models");
  const selfhost = inventory.item("selfhost");

  return (
    <div data-storage-section="everythingElse">
      <SectionTitle
        title={t("settingsPage.storage.everythingElse.title")}
        description={t("settingsPage.storage.everythingElse.description")}
      />
      <SettingsPanel>
        <InventoryRow id="settings" inventory={inventory} data-setting-id="storage.settings" />
        <InventoryRow id="secrets" inventory={inventory} data-setting-id="storage.secrets" />
        <InventoryRow
          id="models"
          inventory={inventory}
          data-setting-id="storage.models"
          details={<ModelsDetails item={models} />}
        >
          <RemoveModelsButton item={models} onDone={() => void inventory.refresh()} />
        </InventoryRow>
        <InventoryRow
          id="searchIndex"
          inventory={inventory}
          data-setting-id="storage.searchIndex"
        />
        <InventoryRow
          id="appCache"
          inventory={inventory}
          data-setting-id="storage.appCache"
          details={
            cacheNotice && (
              <p
                role="status"
                data-app-cache-notice={cacheNotice.tone}
                className={`mt-1 text-xs ${
                  cacheNotice.tone === "error" ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {cacheNotice.text}
              </p>
            )
          }
        >
          <ClearAppCacheButton
            onDone={(notice) => {
              setCacheNotice(notice);
              void inventory.refresh();
            }}
          />
        </InventoryRow>
        <InventoryRow id="cliBridge" inventory={inventory} data-setting-id="storage.cliBridge" />
        {selfhost && (
          <InventoryRow
            id="selfhost"
            inventory={inventory}
            tag={t("settingsPage.storage.items.selfhost.tag")}
          />
        )}
      </SettingsPanel>
    </div>
  );
}
