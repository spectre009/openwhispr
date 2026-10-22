import { create } from "zustand";
import type { CopilotAuthStatus } from "../types/electron";
import { expireCopilotModels, forgetCopilotModels } from "../models/copilotModels";
import logger from "../utils/logger";

// The renderer's view of the GitHub Copilot sign-in. Main owns it (and the
// token, which never crosses); this mirrors main's snapshots and forwards the
// panel's actions.

interface CopilotStoreState {
  status: CopilotAuthStatus;
  /** False until main has answered once: the default below is a placeholder. */
  loaded: boolean;
  /** A sign-in action is waiting on main. */
  pending: boolean;
}

const PLACEHOLDER: CopilotAuthStatus = { configured: true, state: "signedOut", login: "" };

export const useCopilotStore = create<CopilotStoreState>()(() => ({
  status: PLACEHOLDER,
  loaded: false,
  pending: false,
}));

function isStatus(value: unknown): value is CopilotAuthStatus {
  return !!value && typeof (value as CopilotAuthStatus).state === "string";
}

// A new sign-in serves its own account's models; a sign-out serves the shipped
// list again. The first answer after launch only drops a cache an account that
// is no longer signed in left behind.
function applyStatus(next: unknown): void {
  if (!isStatus(next)) return;
  const { status: previous, loaded } = useCopilotStore.getState();
  if (next.state === "signedOut" && (!loaded || previous.state !== "signedOut")) {
    forgetCopilotModels();
  } else if (loaded && next.state === "signedIn" && previous.state !== "signedIn") {
    expireCopilotModels();
  }
  useCopilotStore.setState({ status: next, loaded: true });
}

let subscribed = false;
let broadcastsSeen = 0;

/**
 * Loads main's sign-in status and follows its broadcasts from then on. Safe to
 * call on every mount: it subscribes once and re-reads the status each time.
 */
export async function syncCopilotAuthStatus(): Promise<void> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!subscribed && api?.onCopilotAuthChanged) {
    subscribed = true;
    api.onCopilotAuthChanged((status) => {
      broadcastsSeen += 1;
      applyStatus(status);
    });
  }
  if (!api?.getCopilotAuthStatus) return;
  const seenBefore = broadcastsSeen;
  try {
    const status = await api.getCopilotAuthStatus();
    // A broadcast that landed meanwhile is at least as new as this answer.
    if (broadcastsSeen === seenBefore) applyStatus(status);
  } catch (error) {
    logger.warn(
      "Couldn't read the GitHub Copilot sign-in",
      { error: (error as Error)?.message },
      "copilot"
    );
  }
}

async function runAction(
  name: string,
  action: (() => Promise<CopilotAuthStatus>) | undefined
): Promise<void> {
  if (!action) return;
  useCopilotStore.setState({ pending: true });
  try {
    applyStatus(await action());
  } catch (error) {
    logger.warn(`GitHub Copilot ${name} failed`, { error: (error as Error)?.message }, "copilot");
  } finally {
    useCopilotStore.setState({ pending: false });
  }
}

const api = () => (typeof window !== "undefined" ? window.electronAPI : undefined);

/** Asks GitHub for a device code. Never opens the browser; the panel offers that. */
export function startCopilotSignIn(): Promise<void> {
  const start = api()?.startCopilotSignIn;
  return runAction("sign-in", start && (() => start()));
}

export function cancelCopilotSignIn(): Promise<void> {
  const flowId = useCopilotStore.getState().status.flowId;
  const cancel = api()?.cancelCopilotSignIn;
  return runAction("cancel", flowId && cancel ? () => cancel(flowId) : undefined);
}

/** Checks Copilot access again for an authorization GitHub already granted. */
export function retryCopilotSignIn(): Promise<void> {
  const flowId = useCopilotStore.getState().status.flowId;
  const retry = api()?.retryCopilotSignIn;
  return runAction("retry", flowId && retry ? () => retry(flowId) : undefined);
}

export function signOutOfCopilot(): Promise<void> {
  const signOut = api()?.signOutOfCopilot;
  return runAction("sign-out", signOut && (() => signOut()));
}
