import { create } from "zustand";
import type { TechnicalErrorDetailsData } from "../components/ui/useToast";

export interface CleanupFailure {
  message: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  surface?: "transcription" | "llm";
  settingsTarget?: string;
  action?: string;
  actionKey?: string;
  copyCommand?: string;
  technicalDetails?: TechnicalErrorDetailsData;
  /**
   * The dictation it belongs to (the dictation window sets it): whether that
   * dictation is still the newest, so a late card never replaces a newer
   * dictation's, and its saved History row, for Open in History.
   */
  dictation?: {
    isCurrent: () => boolean;
    rowId: Promise<number | null> | null;
    /** Whether the uncleaned text was pasted; false: it's only in History (and the clipboard). */
    pasted?: boolean;
  };
}

interface CleanupFailureState {
  /** Dictations handed back raw because cleanup failed, not yet surfaced to the user. */
  pending: number;
  /** Cause of the most recent failure, shown with the toast so it's actionable. */
  lastMessage: string;
  /** Structured cause and AWS diagnostics for the most recent fallback. */
  lastFailure: CleanupFailure | null;
}

export const useCleanupFailureStore = create<CleanupFailureState>(() => ({
  pending: 0,
  lastMessage: "",
  lastFailure: null,
}));

export function recordCleanupFailure(failure: string | CleanupFailure = ""): void {
  const normalized = typeof failure === "string" ? { message: failure } : failure;
  useCleanupFailureStore.setState((state) => ({
    pending: state.pending + 1,
    lastMessage: normalized.message,
    lastFailure: normalized,
  }));
}

export function consumeCleanupFailures(): number {
  const { pending } = useCleanupFailureStore.getState();
  if (pending > 0) {
    useCleanupFailureStore.setState({ pending: 0 });
  }
  return pending;
}
