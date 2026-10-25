import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { cn } from "../lib/utils";
import ThemedEmptyIllustration from "../ui/ThemedEmptyIllustration";
import DictationHotkeyHint from "../ui/DictationHotkeyHint";
import historyEmptyLight from "../../assets/empty-states/home-history-light.svg";
import historyEmptyDark from "../../assets/empty-states/home-history-dark.svg";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePolicyStore } from "../../stores/policyStore";
import { effectiveLocalHistoryEnabled } from "../../stores/policyRules";
import HistoryList from "./HistoryList";
import HistoryDetail from "./HistoryDetail";
import { useHistoryList } from "./useHistoryList";
import {
  clearHistorySearch,
  selectHistoryItem,
  setHistoryDetailOpen,
  useHistoryViewStore,
} from "./historyViewStore";

// The History view: every dictation, searchable and filterable, beside the
// selected one in full. Below NARROW_PX the list fills the view and the
// detail opens over it with a Back button. The row actions are Home's own
// (ControlPanel's copy, delete, retry and show-in-folder).

const NARROW_PX = 900;
const SEARCH_DELAY_MS = 250;
const PRIVACY_HISTORY_SETTING = "privacyData#privacy.history";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function useNarrowLayout(ref: RefObject<HTMLDivElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const width = node.getBoundingClientRect().width;
      if (width > 0) setNarrow(width < NARROW_PX);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

interface HistoryBrowserProps {
  hotkey: string;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onRetry: (
    id: number,
    options: { routeKind: string | null; onSettled: () => void }
  ) => Promise<void>;
  onShowAudioInFolder: (id: number) => void;
  onOpenSettings: (destination?: string) => void;
}

export default function HistoryBrowser({
  hotkey,
  onCopy,
  onDelete,
  onRetry,
  onShowAudioInFolder,
  onOpenSettings,
}: HistoryBrowserProps) {
  const { t } = useTranslation();
  const { query, filter, app, selectedId, detailOpen, openRequest } = useHistoryViewStore(
    useShallow((state) => ({
      query: state.query,
      filter: state.filter,
      app: state.app,
      selectedId: state.selectedId,
      detailOpen: state.detailOpen,
      openRequest: state.openRequest,
    }))
  );
  const trimmed = query.trim();
  // Clearing the search applies at once; typing waits for a pause.
  const searched = useDebouncedValue(trimmed, trimmed ? SEARCH_DELAY_MS : 0);
  const list = useHistoryList({
    query: searched,
    failed: filter === "failed",
    cleanupChanged: filter === "cleanupChanged",
    app,
  });
  const { rows, refreshRow } = list;
  const criteriaActive = !!searched || filter !== "all" || !!app;
  const personalHistory = useSettingsStore((state) => state.dataRetentionEnabled);
  const historyOn = usePolicyStore((state) => effectiveLocalHistoryEnabled(state, personalHistory));
  const containerRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowLayout(containerRef);
  // Bumped when main reports the shown row changed, or a retry finished.
  const [revision, setRevision] = useState(0);

  // Side by side, a row is always shown once there are rows.
  useEffect(() => {
    if (!narrow && selectedId === null && rows.length > 0) selectHistoryItem(rows[0].id);
  }, [narrow, selectedId, rows]);

  const rowsRef = useRef(rows);
  useLayoutEffect(() => {
    rowsRef.current = rows;
  });

  useEffect(() => {
    const api = window.electronAPI;
    const disposers = [
      api?.onTranscriptionUpdated?.((item) => {
        if (item?.id === useHistoryViewStore.getState().selectedId) setRevision((n) => n + 1);
      }),
      // The shown row was deleted: show its neighbor, or the list on a narrow layout.
      api?.onTranscriptionDeleted?.(({ id }) => {
        if (id !== useHistoryViewStore.getState().selectedId) return;
        const index = rowsRef.current.findIndex((row) => row.id === id);
        const next =
          index >= 0 ? (rowsRef.current[index + 1] ?? rowsRef.current[index - 1] ?? null) : null;
        selectHistoryItem(next ? next.id : null);
        setHistoryDetailOpen(false);
      }),
      api?.onTranscriptionsCleared?.(() => selectHistoryItem(null)),
    ];
    return () => disposers.forEach((dispose) => dispose?.());
  }, []);

  // The retry rewrites the row's text and steps (or, for a deleted style, runs
  // once the user confirms): re-read both when it's done.
  const retry = useCallback(
    (id: number, routeKind: string | null) =>
      onRetry(id, {
        routeKind,
        onSettled: () => {
          refreshRow(id);
          setRevision((n) => n + 1);
        },
      }),
    [onRetry, refreshRow]
  );

  const back = useCallback(() => {
    setHistoryDetailOpen(false);
    requestAnimationFrame(() =>
      containerRef.current
        ?.querySelector<HTMLElement>('[role="listbox"]')
        ?.focus({ preventScroll: true })
    );
  }, []);

  const openPrivacy = useCallback(() => onOpenSettings(PRIVACY_HISTORY_SETTING), [onOpenSettings]);

  // No dictations at all: Home's empty state, across the whole view.
  if (list.status === "ready" && rows.length === 0 && !criteriaActive) {
    return (
      <div ref={containerRef} className="flex h-full min-h-0">
        <div className="flex flex-1 flex-col items-center px-6 pt-16 text-center">
          <ThemedEmptyIllustration
            light={historyEmptyLight}
            dark={historyEmptyDark}
            width={560}
            height={102}
            className="[mask-image:linear-gradient(to_right,transparent,black_20%,black_80%,transparent)]"
          />
          {historyOn ? (
            <>
              <h2 className="mt-6 text-lg font-semibold text-foreground">
                {t("controlPanel.history.empty")}
              </h2>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                {t("controlPanel.history.emptyDescription")}
              </p>
              <DictationHotkeyHint hotkey={hotkey} className="mt-2" />
            </>
          ) : (
            <>
              <h2 className="mt-6 text-lg font-semibold text-foreground">
                {t("historyView.historyOff.title")}
              </h2>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                {t("historyView.historyOff.message")}
              </p>
              <button
                type="button"
                onClick={openPrivacy}
                className="mt-2 text-sm font-medium text-link underline decoration-link/30 hover:decoration-link/60"
              >
                {t("historyView.historyOff.link")}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const showDetail = selectedId !== null && (!narrow || detailOpen);
  const detail =
    selectedId !== null ? (
      <HistoryDetail
        key={selectedId}
        id={selectedId}
        revision={revision}
        onBack={narrow ? back : undefined}
        onCopy={onCopy}
        onDelete={onDelete}
        onRetry={retry}
        onShowAudioInFolder={onShowAudioInFolder}
      />
    ) : null;
  const listCovered = narrow && showDetail;

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0">
      <div
        inert={listCovered}
        aria-hidden={listCovered || undefined}
        className={cn(
          "flex min-h-0 flex-col",
          narrow ? "w-full" : "w-[380px] shrink-0 border-e border-border/70 dark:border-white/10"
        )}
      >
        <HistoryList
          list={list}
          selectedId={selectedId}
          onSelect={(id, open) => selectHistoryItem(id, { open })}
          narrow={narrow}
          revealRequest={openRequest}
          criteriaKey={`${searched}\u0000${filter}\u0000${app ?? ""}`}
          criteriaActive={criteriaActive}
          onClearCriteria={clearHistorySearch}
          historyOn={historyOn}
          onOpenPrivacy={openPrivacy}
        />
      </div>
      {narrow ? (
        showDetail && (
          <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background">{detail}</div>
        )
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {detail ??
            (list.status !== "loading" && (
              <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
                {t("historyView.detail.empty")}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
