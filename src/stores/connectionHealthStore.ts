import { create } from "zustand";
import type {
  ConnectionCheckDescriptor,
  ConnectionCheckEvent,
  ConnectionCheckResult,
} from "../types/electron";
import { flushPendingSecretSave } from "./settingsStore";
import type {
  CheckTarget,
  ConnectionsFlag,
  PickerConnectionHealth,
} from "../components/settings/connectionHealth";

/**
 * The renderer's connection-check results (Settings › AI Connections; main's
 * queue is helpers/connectionChecks.js). Results are kept by descriptor id
 * with the generation they answer, so a view shows only one about what it
 * shows now; a check in flight keeps the previous result on screen. Main
 * streams answers (`onConnectionCheckResult`), drops late ones and says when
 * a key change invalidated a result. Nothing here is persisted: checks run
 * when the page is looked at, never in the background or at app start.
 */

interface ConnectionHealthState {
  results: Record<string, ConnectionCheckResult>;
  /** Descriptor id → the generation a queued check answers. */
  pending: Record<string, string>;
  /** Bumped when main invalidated results (a key changed): the page checks again. */
  epoch: number;
  /** The Settings menu's dot on AI Connections, from the page's last render. */
  flag: ConnectionsFlag;
  /** Each connection's failing check, for the model pickers' advisory line. */
  pickerHealth: Readonly<Record<string, PickerConnectionHealth>>;
}

export const useConnectionHealthStore = create<ConnectionHealthState>()(() => ({
  results: {},
  pending: {},
  epoch: 0,
  flag: null,
  pickerHealth: {},
}));

let subscribed = false;

function applyEvent(event: ConnectionCheckEvent): void {
  if (!event || typeof event.id !== "string") return;
  useConnectionHealthStore.setState((state) => {
    const { id } = event;
    if ("invalidated" in event) {
      if (!state.results[id]) return state;
      const results = { ...state.results };
      delete results[id];
      return { results, epoch: state.epoch + 1 };
    }
    const awaited = state.pending[id];
    // An answer for a generation no longer awaited is about something not shown.
    if (awaited !== undefined && awaited !== event.generation) return state;
    const pending = { ...state.pending };
    delete pending[id];
    if ("dropped" in event) return { pending };
    return { pending, results: { ...state.results, [id]: event.result } };
  });
}

/** Follows main's streamed answers; once per window. */
export function subscribeConnectionChecks(): void {
  if (subscribed || typeof window === "undefined") return;
  const api = window.electronAPI;
  if (!api?.onConnectionCheckResult) return;
  subscribed = true;
  api.onConnectionCheckResult(applyEvent);
}

/** Cloud's check is the app's own session check: the renderer holds the session. */
let cloudSessionCheck: () => void | Promise<void> = async () => {
  const { requestSessionCheck } = await import("../lib/auth");
  requestSessionCheck();
};

/** Tests replace the session check; nothing else should. */
export function setCloudSessionCheck(check: () => void | Promise<void>): void {
  cloudSessionCheck = check;
}

const now = () => Date.now();

function cloudResult(item: CheckTarget): ConnectionCheckResult {
  return {
    reachable: true,
    credentials: "accepted",
    models: Object.fromEntries(item.descriptor.models.map((model) => [model, "unknown"])),
    proof: "session",
    code: "OK",
    checkedAt: now(),
    generation: item.descriptor.generation,
  };
}

export interface RunOptions {
  /** An explicit Check: skip cached results (main's too). */
  fresh: boolean;
  maxAgeMs: number;
}

/**
 * Checks these targets. Automatic runs (`fresh: false`) skip a target whose
 * current result is younger than `maxAgeMs` or that is already queued, and
 * main answers from its own cache within that age too, so showing the page
 * again within ten minutes sends nothing.
 */
export async function runConnectionChecks(
  targets: readonly CheckTarget[],
  { fresh, maxAgeMs }: RunOptions
): Promise<void> {
  subscribeConnectionChecks();
  const { results, pending } = useConnectionHealthStore.getState();
  const due = targets.filter((item) => {
    const { id, generation } = item.descriptor;
    if (fresh) return true;
    if (pending[id] === generation) return false;
    const current = results[id];
    return !(current && current.generation === generation && now() - current.checkedAt <= maxAgeMs);
  });
  if (due.length === 0) return;

  const cloud = due.filter((item) => item.descriptor.kind === "cloud");
  if (cloud.length > 0) {
    if (fresh) {
      try {
        await cloudSessionCheck();
      } catch {
        // The session check reports through the app's own sign-in state.
      }
    }
    useConnectionHealthStore.setState((state) => ({
      results: {
        ...state.results,
        ...Object.fromEntries(cloud.map((item) => [item.descriptor.id, cloudResult(item)])),
      },
    }));
  }

  const remote = due.filter((item) => item.descriptor.kind !== "cloud");
  if (remote.length === 0) return;
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.connectionChecksRun) return;
  // Main reads the key it holds: one just typed here, still in its debounced
  // save, goes first.
  const fields = [...new Set(remote.flatMap((item) => item.secretFields))];
  await Promise.all(fields.map((field) => flushPendingSecretSave(field).catch(() => {})));
  // Identical descriptors (two rows on one server) go once.
  const descriptors = [
    ...new Map(
      remote.map((item) => [item.descriptor.id, item.descriptor as ConnectionCheckDescriptor])
    ).values(),
  ];
  useConnectionHealthStore.setState((state) => ({
    pending: {
      ...state.pending,
      ...Object.fromEntries(descriptors.map((item) => [item.id, item.generation])),
    },
  }));
  let answer: Awaited<ReturnType<NonNullable<typeof api.connectionChecksRun>>> | undefined;
  try {
    answer = await api.connectionChecksRun({ descriptors, maxAgeMs, fresh });
  } catch {
    answer = undefined;
  }
  useConnectionHealthStore.setState((state) => {
    const pendingNext = { ...state.pending };
    const queued = new Set(Array.isArray(answer?.pending) ? answer.pending : []);
    const answered = answer?.results && typeof answer.results === "object" ? answer.results : {};
    for (const item of descriptors) {
      // Answered now, or not queued (main refused or failed): nothing to wait for.
      if (!queued.has(item.id) && pendingNext[item.id] === item.generation) {
        delete pendingNext[item.id];
      }
    }
    return { pending: pendingNext, results: { ...state.results, ...answered } };
  });
}

/** Results that no longer hold (Cloud's after a sign-in change or the Cloud switch). */
export function forgetConnectionResults(ids: readonly string[]): void {
  useConnectionHealthStore.setState((state) => {
    if (!ids.some((id) => state.results[id])) return state;
    const results = { ...state.results };
    for (const id of ids) delete results[id];
    return { results };
  });
}

/**
 * The page publishes what other places show from its checks: the Settings
 * menu's dot and the model pickers' advisory line. They hold until a newer
 * result.
 */
export function publishConnectionHealth({
  flag,
  pickerHealth,
}: {
  flag: ConnectionsFlag;
  pickerHealth: Record<string, PickerConnectionHealth>;
}): void {
  const state = useConnectionHealthStore.getState();
  const same = JSON.stringify(state.pickerHealth) === JSON.stringify(pickerHealth);
  if (state.flag === flag && same) return;
  useConnectionHealthStore.setState({
    flag,
    ...(same ? {} : { pickerHealth }),
  });
}

/** Tests: a clean slate. */
export function resetConnectionHealthForTests(): void {
  subscribed = false;
  useConnectionHealthStore.setState({
    results: {},
    pending: {},
    epoch: 0,
    flag: null,
    pickerHealth: {},
  });
}
