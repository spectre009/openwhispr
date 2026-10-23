// "Open in History" from elsewhere in the control panel (a test case pinned
// from History): the control panel leaves Settings, shows History and brings
// the row into view while it's still listed. A window event, so the opener
// needn't know the control panel's layout.

export const OPEN_HISTORY_ITEM_EVENT = "openwhispr:open-history-item";

export function requestOpenHistoryItem(transcriptionId: number): void {
  if (typeof window === "undefined" || !Number.isInteger(transcriptionId)) return;
  window.dispatchEvent(
    new CustomEvent(OPEN_HISTORY_ITEM_EVENT, { detail: { id: transcriptionId } })
  );
}
