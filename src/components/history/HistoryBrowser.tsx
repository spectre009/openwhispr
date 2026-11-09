import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { cn } from "../lib/utils";
import { ConfirmDialog } from "../ui/dialog";
import ThemedEmptyIllustration from "../ui/ThemedEmptyIllustration";
import DictationHotkeyHint from "../ui/DictationHotkeyHint";
import historyEmptyLight from "../../assets/empty-states/home-history-light.svg";
import historyEmptyDark from "../../assets/empty-states/home-history-dark.svg";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePolicyStore } from "../../stores/policyStore";
import { effectiveLocalHistoryEnabled } from "../../stores/policyRules";
import { useDialogs } from "../../hooks/useDialogs";
import { PanelLeftOpen, X } from "../icons";
import HistoryList from "./HistoryList";
import HistoryDetail, { type DetailLayoutInfo } from "./HistoryDetail";
import { useHistoryList } from "./useHistoryList";
import type { ReviewConfirm } from "./useHistoryReview";
import {
  applyHistoryReview,
  clearHistorySearch,
  dropHistoryReviewRequest,
  isReviewDraftChanged,
  reviewDraftKey,
  selectHistoryItem,
  setHistoryDetailOpen,
  setHistoryListChoice,
  setHistoryNotice,
  useHistoryViewStore,
} from "./historyViewStore";

// The History view: every dictation, searchable and filterable, beside the
// selected one in full. Below NARROW_PX the list fills the view and the
// detail opens over it with a Back button. The row actions are Home's own
// (ControlPanel's copy, delete, retry and show-in-folder). "Review last
// dictation" arrives here as a pending request: it opens that dictation with
// its review, asking first when the shown one has unsaved review changes.
//
// The layout is decided here, from the view's width: first the list's state
// (the user's own choice, else folded to a rail while a 👎 review is open on a
// dictation the wide layout suits, when that leaves the detail room), then
// the detail's layout: wide when the detail has WIDE_DETAIL_PX beside the
// list as it is. The detail's width never feeds back into the list's state.

const NARROW_PX = 900;
const LIST_PX = 380;
const RAIL_PX = 44;
/** The detail's width from which a dictation shows side by side with what speech heard. */
const WIDE_DETAIL_PX = 880;
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

/** The view's width (0 until it's laid out). */
function useViewWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [viewWidth, setViewWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const width = node.getBoundingClientRect().width;
      if (width > 0) setViewWidth(Math.round(width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return viewWidth;
}

interface HistoryBrowserProps {
  hotkey: string;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onRetry: (
    id: number,
    options: { routeKind: string | null; onSettled: () => void; cleanupOnly?: boolean }
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
  const {
    query,
    filter,
    app,
    dictionaryWord,
    selectedId,
    detailOpen,
    openRequest,
    pendingReview,
    notice,
    holdSelection,
    listChoice,
  } = useHistoryViewStore(
    useShallow((state) => ({
      query: state.query,
      filter: state.filter,
      app: state.app,
      dictionaryWord: state.dictionaryWord,
      selectedId: state.selectedId,
      detailOpen: state.detailOpen,
      openRequest: state.openRequest,
      pendingReview: state.pendingReview,
      notice: state.notice,
      holdSelection: state.holdSelection,
      listChoice: state.listChoice,
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
    flagged: filter === "flagged",
    dictionaryFixed: filter === "dictionaryFixed",
    dictionaryWord,
  });
  const { rows, refreshRow } = list;
  const criteriaActive = !!searched || filter !== "all" || !!app || !!dictionaryWord;
  const personalHistory = useSettingsStore((state) => state.dataRetentionEnabled);
  const historyOn = usePolicyStore((state) => effectiveLocalHistoryEnabled(state, personalHistory));
  const containerRef = useRef<HTMLDivElement>(null);
  const viewWidth = useViewWidth(containerRef);
  const narrow = viewWidth > 0 && viewWidth < NARROW_PX;
  // The shown dictation, as its detail reported it once loaded.
  const [detailInfo, setDetailInfo] = useState<DetailLayoutInfo | null>(null);
  const onLayoutInfo = useCallback((info: DetailLayoutInfo) => {
    setDetailInfo((previous) =>
      previous &&
      previous.id === info.id &&
      previous.eligible === info.eligible &&
      previous.owner === info.owner
        ? previous
        : info
    );
  }, []);
  const shownInfo = detailInfo && detailInfo.id === selectedId ? detailInfo : null;
  const reviewing = useHistoryViewStore((state) =>
    shownInfo?.owner ? !!state.drafts[reviewDraftKey(shownInfo.owner, shownInfo.id)] : false
  );
  const eligible = !!shownInfo?.eligible;
  const autoFold = !narrow && eligible && reviewing && viewWidth - RAIL_PX >= WIDE_DETAIL_PX;
  const listCollapsed = !narrow && (listChoice ? listChoice === "collapsed" : autoFold);
  const detailWidth = viewWidth - (listCollapsed ? RAIL_PX : LIST_PX);
  // Room for the wide layout; the detail uses it for a dictation it suits.
  const wideRoom = !narrow && viewWidth > 0 && detailWidth >= WIDE_DETAIL_PX;
  // Expanding while a review folds it keeps it shown for reviews; otherwise it's back to folding by itself.
  const expandList = useCallback(() => {
    setHistoryListChoice(autoFold ? "expanded" : null);
    requestAnimationFrame(() =>
      containerRef.current
        ?.querySelector<HTMLElement>('[role="listbox"]')
        ?.focus({ preventScroll: true })
    );
  }, [autoFold]);
  const collapseList = useCallback(() => {
    setHistoryListChoice("collapsed");
    requestAnimationFrame(() =>
      containerRef.current?.querySelector<HTMLElement>("[data-history-list-expand]")?.focus()
    );
  }, []);
  // Bumped when main reports the shown row changed, or a retry finished.
  const [revision, setRevision] = useState(0);

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const confirm = useCallback(
    (options: ReviewConfirm) =>
      showConfirmDialog({
        title: options.title,
        description: options.description,
        confirmText: options.confirmText,
        cancelText: options.cancelText ?? t("common.cancel"),
        variant: options.destructive ? "destructive" : "default",
        onConfirm: options.onConfirm,
      }),
    [showConfirmDialog, t]
  );

  // Side by side, a row is always shown once there are rows (unless the review
  // hotkey found none: then nothing is, until one is picked).
  useEffect(() => {
    if (!narrow && selectedId === null && !holdSelection && rows.length > 0) {
      selectHistoryItem(rows[0].id);
    }
  }, [narrow, selectedId, holdSelection, rows]);

  // "Review last dictation": open it, unless the shown dictation's review has
  // unsaved changes. Then ask; the draft is kept either way.
  useEffect(() => {
    if (!pendingReview) return;
    const { drafts, selectedId: shown } = useHistoryViewStore.getState();
    const unsaved =
      shown !== null &&
      shown !== pendingReview.id &&
      Object.values(drafts).some((draft) => draft.id === shown && isReviewDraftChanged(draft));
    if (!unsaved) {
      applyHistoryReview(pendingReview);
      return;
    }
    const request = pendingReview;
    dropHistoryReviewRequest();
    confirm({
      title: t("historyView.review.confirmSwitch.title"),
      description: t("historyView.review.confirmSwitch.description"),
      confirmText: t("historyView.review.confirmSwitch.confirm"),
      cancelText: t("historyView.review.confirmSwitch.stay"),
      onConfirm: () => applyHistoryReview(request),
    });
  }, [pendingReview, confirm, t]);

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
  // once the user confirms): re-read both when it's done. `cleanupOnly`: Re-run
  // cleanup, from the stored raw transcript.
  const retry = useCallback(
    (id: number, routeKind: string | null, cleanupOnly = false) =>
      onRetry(id, {
        routeKind,
        ...(cleanupOnly ? { cleanupOnly } : {}),
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

  const confirmation = (
    <ConfirmDialog
      open={confirmDialog.open}
      onOpenChange={(open) => {
        if (!open) hideConfirmDialog();
      }}
      title={confirmDialog.title}
      description={confirmDialog.description}
      confirmText={confirmDialog.confirmText}
      cancelText={confirmDialog.cancelText}
      onConfirm={confirmDialog.onConfirm}
      variant={confirmDialog.variant}
    />
  );
  const noticeBar =
    notice === "lastNotFound" ? (
      <div
        role="status"
        className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/8 px-3.5 py-2 text-[12.5px] text-foreground"
      >
        <span className="min-w-0 flex-1">{t("historyView.review.lastNotFound")}</span>
        <button
          type="button"
          onClick={() => setHistoryNotice(null)}
          aria-label={t("common.dismiss")}
          className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={12} />
        </button>
      </div>
    ) : null;

  // No dictations at all: Home's empty state, across the whole view.
  if (list.status === "ready" && rows.length === 0 && !criteriaActive) {
    return (
      <div ref={containerRef} data-history-view className="flex h-full min-h-0 flex-col">
        {noticeBar}
        {confirmation}
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
        historyOn={historyOn}
        onOpenPrivacy={openPrivacy}
        onOpenSettings={onOpenSettings}
        confirm={confirm}
        wide={wideRoom}
        onLayoutInfo={onLayoutInfo}
      />
    ) : null;
  const listCovered = narrow && showDetail;
  const listHidden = listCovered || listCollapsed;

  return (
    <div ref={containerRef} data-history-view className="flex h-full min-h-0 flex-col">
      {noticeBar}
      {confirmation}
      <div className="relative flex min-h-0 flex-1">
        <div
          data-history-list-column={listCollapsed ? "rail" : "list"}
          className={cn(
            "relative flex min-h-0 flex-col",
            narrow
              ? "w-full"
              : "shrink-0 overflow-hidden border-e border-border/70 transition-[width] duration-200 ease-out motion-reduce:transition-none dark:border-white/10"
          )}
          style={narrow ? undefined : { width: listCollapsed ? RAIL_PX : LIST_PX }}
        >
          <div
            id="history-list-panel"
            inert={listHidden}
            aria-hidden={listHidden || undefined}
            className={cn(
              "flex h-full min-h-0 flex-col",
              !narrow && "w-[380px]",
              listCollapsed && "invisible"
            )}
          >
            <HistoryList
              list={list}
              selectedId={selectedId}
              onSelect={(id, open) => selectHistoryItem(id, { open })}
              narrow={narrow}
              revealRequest={openRequest}
              criteriaKey={`${searched}\u0000${filter}\u0000${app ?? ""}\u0000${dictionaryWord ?? ""}`}
              criteriaActive={criteriaActive}
              onClearCriteria={clearHistorySearch}
              historyOn={historyOn}
              onOpenPrivacy={openPrivacy}
              onCollapse={narrow ? undefined : collapseList}
            />
          </div>
          {listCollapsed && (
            <div className="absolute inset-0 flex flex-col items-center pt-3">
              <button
                type="button"
                data-history-list-expand
                onClick={expandList}
                aria-label={t("historyView.wide.listExpand")}
                title={t("historyView.wide.listExpand")}
                aria-expanded={false}
                aria-controls="history-list-panel"
                className="grid size-8 place-items-center rounded-lg border border-border/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:border-white/10"
              >
                <PanelLeftOpen size={15} className="rtl:-scale-x-100" />
              </button>
            </div>
          )}
        </div>
        {narrow ? (
          showDetail && (
            <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background">
              {detail}
            </div>
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
    </div>
  );
}
