import { create } from "zustand";

// What the History view is showing, kept outside the view so it survives
// switching to another view and back, and so "Open in History" can select a
// dictation before the view mounts.

export type HistoryKindFilter = "all" | "failed" | "cleanupChanged";

interface HistoryViewState {
  /** The search field's text; the list searches it after a short pause. */
  query: string;
  filter: HistoryKindFilter;
  /** The App filter (an exe name), combined with `filter`. */
  app: string | null;
  selectedId: number | null;
  /** Narrow layouts: the detail is open over the list. */
  detailOpen: boolean;
  /** Bumped by every "Open in History", so the view reveals the row even when already selected. */
  openRequest: number;
  /** Step cards show what changed, or the plain text. */
  textView: "changes" | "text";
}

export const useHistoryViewStore = create<HistoryViewState>()(() => ({
  query: "",
  filter: "all",
  app: null,
  selectedId: null,
  detailOpen: false,
  openRequest: 0,
  textView: "changes",
}));

export function setHistoryTextView(textView: "changes" | "text") {
  useHistoryViewStore.setState({ textView });
}

export function setHistoryQuery(query: string) {
  useHistoryViewStore.setState({ query });
}

/** "All" clears the App filter too. */
export function setHistoryFilter(filter: HistoryKindFilter) {
  useHistoryViewStore.setState(filter === "all" ? { filter, app: null } : { filter });
}

export function setHistoryApp(app: string | null) {
  useHistoryViewStore.setState({ app });
}

export function clearHistorySearch() {
  useHistoryViewStore.setState({ query: "", filter: "all", app: null });
}

export function selectHistoryItem(id: number | null, { open = false } = {}) {
  useHistoryViewStore.setState((state) => ({
    selectedId: id,
    detailOpen: id === null ? false : open || state.detailOpen,
  }));
}

export function setHistoryDetailOpen(detailOpen: boolean) {
  useHistoryViewStore.setState({ detailOpen });
}

/** "Open in History": select the dictation and show its detail, whatever the list shows. */
export function requestHistoryItem(id: number) {
  useHistoryViewStore.setState((state) => ({
    selectedId: id,
    detailOpen: true,
    openRequest: state.openRequest + 1,
  }));
}
