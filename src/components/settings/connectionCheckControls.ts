import { createElement, type ReactNode } from "react";
import { hasState, useOwnerHealth } from "./connectionCheckContext";
import {
  HealthNote,
  OwnerHealthDetails,
  OwnerHealthPill,
  type ProblemActions,
} from "./ConnectionCheckParts";
import type { OwnerHealth } from "./connectionHealth";

/**
 * A card's or row's connection-check parts, ready to place (the cards and
 * rows on Settings › AI Connections): the pill and Check for its header or
 * line, the problem box, and the note on what a working check proved.
 */
export interface HealthControls {
  health: OwnerHealth | null;
  /**
   * The pill and Check for its header or line; null when the card or row
   * shows no check (no key, endpoint needed: its own status says so).
   */
  pill: ReactNode;
  /**
   * Whether `pill` carries a state. Until a first answer (and while none is
   * on its way) it's the Check button alone, beside the card's own status.
   */
  showsState: boolean;
  problem: ReactNode;
  note: ReactNode;
  check: () => void;
}

const nothing = () => {};

export function useHealthControls(
  owner: string,
  name: string,
  actions: Omit<ProblemActions, "onCheck"> = {},
  { showSkipped = false, checkButton = true }: { showSkipped?: boolean; checkButton?: boolean } = {}
): HealthControls {
  const view = useOwnerHealth(owner, { showSkipped });
  if (!view) {
    return {
      health: null,
      pill: null,
      showsState: false,
      problem: null,
      note: null,
      check: nothing,
    };
  }
  return {
    health: view.health,
    check: view.check,
    pill: view.showPill ? createElement(OwnerHealthPill, { view, name, checkButton }) : null,
    showsState: view.showPill && hasState(view.health),
    problem: view.probed
      ? createElement(OwnerHealthDetails, { view, name, actions, note: false })
      : null,
    note: view.probed ? createElement(HealthNote, { health: view.health }) : null,
  };
}
