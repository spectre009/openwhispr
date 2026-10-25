import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HistoryCursor, HistoryListRow } from "../../types/electron";

// The History list's rows, read from main a page at a time (history-list).
// A new search or filter starts over. A new dictation refreshes the first page
// and keeps what was already loaded below it; a changed one refreshes in
// place; a deleted one leaves. The same events Home's store follows.

export const HISTORY_PAGE_SIZE = 50;

export interface HistoryListParams {
  query: string;
  failed: boolean;
  cleanupChanged: boolean;
  app: string | null;
  flagged: boolean;
}

export interface HistoryListState {
  rows: HistoryListRow[];
  nextCursor: HistoryCursor | null;
  status: "loading" | "ready" | "error";
  loadingMore: boolean;
  /** The last page failed to load; it waits for a retry instead of looping. */
  moreFailed: boolean;
}

const INITIAL: HistoryListState = {
  rows: [],
  nextCursor: null,
  status: "loading",
  loadingMore: false,
  moreFailed: false,
};

// The cursor compares the row's sort key: its timestamp, "" when it has none.
function isBefore(row: HistoryListRow, cursor: HistoryCursor): boolean {
  const key = row.timestamp ?? "";
  return key < cursor.timestamp || (key === cursor.timestamp && row.id < cursor.id);
}

/** A fresh first page, followed by the rows already loaded below it. */
export function mergeFirstPage(
  previous: Pick<HistoryListState, "rows" | "nextCursor">,
  first: Pick<HistoryListState, "rows" | "nextCursor">
): Pick<HistoryListState, "rows" | "nextCursor"> {
  const end = first.nextCursor;
  if (!end) return { rows: first.rows, nextCursor: null };
  const ids = new Set(first.rows.map((row) => row.id));
  const below = previous.rows.filter((row) => !ids.has(row.id) && isBefore(row, end));
  return below.length > 0
    ? { rows: [...first.rows, ...below], nextCursor: previous.nextCursor }
    : { rows: first.rows, nextCursor: end };
}

function fetchPage(params: HistoryListParams, cursor: HistoryCursor | null, limit: number) {
  const list = window.electronAPI?.listHistory;
  if (!list) return Promise.resolve(null);
  return list({
    cursor,
    limit,
    query: params.query,
    filters: {
      failed: params.failed,
      cleanupChanged: params.cleanupChanged,
      app: params.app,
      flagged: params.flagged,
    },
  });
}

export function useHistoryList({ query, failed, cleanupChanged, app, flagged }: HistoryListParams) {
  const [state, setState] = useState<HistoryListState>(INITIAL);
  const latest = useRef(state);
  const params = useRef<HistoryListParams>({ query, failed, cleanupChanged, app, flagged });
  // Bumped by every new search or filter: answers to an older one are dropped.
  const generation = useRef(0);
  const loadingMore = useRef(false);

  useLayoutEffect(() => {
    latest.current = state;
  });

  const load = useCallback(() => {
    const current = ++generation.current;
    loadingMore.current = false;
    // The previous rows stay until the new ones arrive, so typing doesn't flash.
    setState((previous) => ({ ...previous, status: "loading", moreFailed: false }));
    fetchPage(params.current, null, HISTORY_PAGE_SIZE).then(
      (result) => {
        if (current !== generation.current) return;
        setState(
          result?.success
            ? { ...INITIAL, rows: result.rows, nextCursor: result.nextCursor, status: "ready" }
            : (previous) => ({ ...previous, status: "error" })
        );
      },
      () => {
        if (current === generation.current)
          setState((previous) => ({ ...previous, status: "error" }));
      }
    );
  }, []);

  useEffect(() => {
    params.current = { query, failed, cleanupChanged, app, flagged };
    load();
  }, [query, failed, cleanupChanged, app, flagged, load]);

  const loadMore = useCallback((retry = false) => {
    const { nextCursor, status, moreFailed } = latest.current;
    if (!nextCursor || status !== "ready" || loadingMore.current || (moreFailed && !retry)) return;
    loadingMore.current = true;
    const current = generation.current;
    setState((previous) => ({ ...previous, loadingMore: true, moreFailed: false }));
    const settle = (result: Awaited<ReturnType<typeof fetchPage>> | null) => {
      if (current !== generation.current) return;
      loadingMore.current = false;
      if (!result?.success) {
        setState((previous) => ({ ...previous, loadingMore: false, moreFailed: true }));
        return;
      }
      setState((previous) => {
        const ids = new Set(previous.rows.map((row) => row.id));
        return {
          ...previous,
          rows: [...previous.rows, ...result.rows.filter((row) => !ids.has(row.id))],
          nextCursor: result.nextCursor,
          loadingMore: false,
        };
      });
    };
    fetchPage(params.current, nextCursor, HISTORY_PAGE_SIZE).then(settle, () => settle(null));
  }, []);

  /** Re-reads the first page and keeps the loaded rows below it. */
  const refresh = useCallback(() => {
    const current = generation.current;
    fetchPage(params.current, null, HISTORY_PAGE_SIZE).then(
      (result) => {
        if (current !== generation.current || !result?.success) return;
        setState((previous) =>
          previous.status === "ready"
            ? { ...previous, ...mergeFirstPage(previous, result) }
            : previous
        );
      },
      () => {}
    );
  }, []);

  /** Re-reads one loaded row; it leaves the list when it no longer matches. */
  const refreshRow = useCallback((id: number) => {
    const row = latest.current.rows.find((candidate) => candidate.id === id);
    if (!row) return;
    const current = generation.current;
    // The page that starts just above this row: the row itself, if it still matches.
    fetchPage(params.current, { timestamp: row.timestamp ?? "", id: row.id + 1 }, 1).then(
      (result) => {
        if (current !== generation.current || !result?.success) return;
        const fresh = result.rows[0]?.id === id ? result.rows[0] : null;
        setState((previous) => ({
          ...previous,
          rows: fresh
            ? previous.rows.map((candidate) => (candidate.id === id ? fresh : candidate))
            : previous.rows.filter((candidate) => candidate.id !== id),
        }));
      },
      () => {}
    );
  }, []);

  const remove = useCallback((id: number) => {
    setState((previous) =>
      previous.rows.some((row) => row.id === id)
        ? { ...previous, rows: previous.rows.filter((row) => row.id !== id) }
        : previous
    );
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A dictation is saved, then its audio: one refresh for both.
    const refreshSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 150);
    };
    const disposers = [
      api?.onTranscriptionAdded?.(() => refreshSoon()),
      api?.onTranscriptionUpdated?.((item) => {
        if (!item || !Number.isInteger(item.id)) return;
        // A row recovered into the list (a discarded one re-transcribed) isn't loaded yet.
        if (latest.current.rows.some((row) => row.id === item.id)) refreshRow(item.id);
        else refreshSoon();
      }),
      api?.onTranscriptionDeleted?.(({ id }) => remove(id)),
      api?.onTranscriptionsCleared?.(() => load()),
      // A review saved or deleted: the row's rating (and the Flagged filter's answer).
      api?.onHistoryFeedbackChanged?.(({ id }) => refreshRow(id)),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      disposers.forEach((dispose) => dispose?.());
    };
  }, [load, refresh, refreshRow, remove]);

  return { ...state, reload: load, loadMore, refreshRow };
}
