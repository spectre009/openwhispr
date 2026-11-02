import { createContext, useContext, useEffect, useState } from "react";
import { useSettingsVisible } from "./useSettingsVisible";
import { formatAgo } from "./buildInfoFormat";
import {
  ownerHealth,
  ownerLastUse,
  type CheckPlan,
  type NotCheckedReason,
  type OwnerHealth,
  type OwnerLastUse,
} from "./connectionHealth";
import type { ConnectionCheckResult, ConnectionOutcomeEntry } from "../../types/electron";

/**
 * The connection checks' context on Settings › AI Connections: the page
 * (AiConnectionsPage) provides its plan, results and Check actions; each card
 * and row reads its own health here and renders it with
 * ConnectionCheckParts.tsx. React-free apart from the hooks.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

const TICK_MS = 30_000;

export interface ConnectionHealthContextValue {
  plan: CheckPlan;
  results: Readonly<Record<string, ConnectionCheckResult>>;
  pending: Readonly<Record<string, string>>;
  /** "Last recorded use" by descriptor id (main's connectionOutcomes.js). */
  outcomes?: Readonly<Record<string, ConnectionOutcomeEntry>>;
  now: number;
  /** An explicit, fresh check of one card or row. */
  check: (owner: string) => void;
  /** Check all: every card and row, fresh. */
  checkAll: () => void;
}

export const ConnectionHealthContext = createContext<ConnectionHealthContextValue | null>(null);

export interface OwnerHealthView {
  health: OwnerHealth;
  now: number;
  check: () => void;
  /** Something was sent to be checked (not only a reason it wasn't). */
  probed: boolean;
  /**
   * Whether the card or row shows the check's pill: when probed, when it's
   * managed ("not checked here"), or with `showSkipped`; other reasons (no
   * key, endpoint needed) are the card's own status.
   */
  showPill: boolean;
}

/** A card's or row's check, or null outside the page or when it has none. */
export function useOwnerHealth(
  owner: string,
  { showSkipped = false }: { showSkipped?: boolean } = {}
): OwnerHealthView | null {
  const context = useContext(ConnectionHealthContext);
  if (!context) return null;
  const health = ownerHealth(owner, context.plan, context.results, context.pending);
  if (!health) return null;
  const probed = health.parts.length > 0;
  return {
    health,
    now: context.now,
    check: () => context.check(owner),
    probed,
    showPill: probed || health.notChecked === "managed" || showSkipped,
  };
}

/**
 * Whether a check has something to say: an answer, a reason it isn't
 * checked, or one on its way. Before any of those, the card keeps its own
 * status beside the Check button.
 */
export function hasState(health: Pick<OwnerHealth, "state" | "checking">): boolean {
  return health.state !== "unchecked" || health.checking;
}

/** A card's or row's "Last recorded use", or null (outside the page, or nothing recorded). */
export function useOwnerLastUse(owner: string): OwnerLastUse | null {
  const context = useContext(ConnectionHealthContext);
  if (!context?.outcomes) return null;
  return ownerLastUse(owner, context.plan, context.outcomes);
}

/** Now, re-read every half minute while Settings shows, so ages stay true. */
export function useHealthNow(): number {
  const visible = useSettingsVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [visible]);
  return now;
}

/** "3 minutes ago", in the UI language. */
export function checkAge(checkedAt: number, now: number, language: string | undefined): string {
  return formatAgo(Math.max(0, now - checkedAt) / 1000, language);
}

const NOT_CHECKED_BY_CODE: Record<string, NotCheckedReason | "cloudOff"> = {
  API_KEY_MISSING: "noKey",
  CHECK_INVALID_ROUTE: "invalidEndpoint",
  CHECK_CLOUD_DISABLED: "cloudOff",
};

/** A state's words: a reason when not checked. */
export function stateLabel(
  t: Translate,
  health: Pick<OwnerHealth, "state" | "notChecked" | "code">
): string {
  if (health.state === "notChecked") {
    const reason =
      health.notChecked ?? (health.code ? NOT_CHECKED_BY_CODE[health.code] : undefined);
    return t(`connections.health.notChecked.${reason ?? "label"}`);
  }
  return t(`connections.health.states.${health.state}`);
}
