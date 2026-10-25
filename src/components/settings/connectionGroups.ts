import { CONNECTION_PROVIDERS, type ConnectionProviderId } from "./connectionProviders";

/**
 * How Connections on Settings › AI Connections & Local Models arranges its
 * connections (the shared API-key providers, GitHub Copilot, OpenWhispr Cloud
 * and the custom connection). Once any connection is in use:
 *
 * - In use: at least one active usage; full cards, most active usages first;
 * - Saved, not in use: a saved credential or sign-in and no active usage; rows;
 * - Add a provider: the rest, folded; rows. The custom connection is never
 *   here: without one, the section offers "Add custom connection" instead.
 *
 * While nothing is in use (a first run) it shows the starter cards, with the
 * rest folded under "More providers". Groups are taken once per visit and
 * frozen (`stepVisit`), so adding or removing a key doesn't move anything
 * until the next visit. React-free, so tests read it directly.
 */

export type ConnectionId = ConnectionProviderId | "copilot" | "cloud" | "custom";

export type ConnectionsLayout = "grouped" | "firstRun";

export interface ConnectionFacts {
  /** Active usages (`isActiveUsage`); for the custom connection, its active features. */
  activeUses: number;
  /**
   * A saved credential (providers), a sign-in (Copilot), Cloud on and signed
   * in. The custom connection counts as saved while it exists.
   */
  saved: boolean;
}

export interface ConnectionGroupsInput {
  /**
   * Per connection. The custom connection is listed only while it exists; a
   * provider, Copilot or Cloud left out has no use and nothing saved.
   */
  connections: Partial<Record<ConnectionId, ConnectionFacts>>;
  /** OpenWhispr Cloud is switched off in Privacy & Data. */
  cloudOff: boolean;
  /** The first-run starter providers (`ConnectionProviderDef.common`). */
  common: readonly ConnectionProviderId[];
}

export interface GroupedConnections {
  layout: "grouped";
  inUse: ConnectionId[];
  saved: ConnectionId[];
  add: ConnectionId[];
}

export interface FirstRunConnections {
  layout: "firstRun";
  cards: ConnectionId[];
  fold: ConnectionId[];
}

export type ConnectionGroups = GroupedConnections | FirstRunConnections;

/** Today's order: every group lists in it, and In use breaks ties with it. */
export const CONNECTION_ORDER: readonly ConnectionId[] = [
  "copilot",
  ...CONNECTION_PROVIDERS.map((provider) => provider.id),
  "cloud",
  "custom",
];

const NONE: ConnectionFacts = { activeUses: 0, saved: false };

const factsOf = (input: ConnectionGroupsInput, id: ConnectionId): ConnectionFacts =>
  input.connections[id] ?? NONE;

const exists = (input: ConnectionGroupsInput, id: ConnectionId): boolean =>
  id !== "custom" || !!input.connections.custom;

const isSaved = (input: ConnectionGroupsInput, id: ConnectionId): boolean =>
  id === "custom" || factsOf(input, id).saved;

/** The connections there are, in today's order. */
function present(input: ConnectionGroupsInput): ConnectionId[] {
  return CONNECTION_ORDER.filter((id) => exists(input, id));
}

/** Grouped once any connection has an active use; a first run until then. */
export function connectionsLayout(input: ConnectionGroupsInput): ConnectionsLayout {
  return present(input).some((id) => factsOf(input, id).activeUses > 0) ? "grouped" : "firstRun";
}

/** The live groups, in `layout` (by default the one the state calls for). */
export function groupConnections(
  input: ConnectionGroupsInput,
  layout: ConnectionsLayout = connectionsLayout(input)
): ConnectionGroups {
  const ids = present(input);
  const uses = (id: ConnectionId) => factsOf(input, id).activeUses;
  if (layout === "grouped") {
    return {
      layout,
      // Stable: ties keep today's order.
      inUse: ids.filter((id) => uses(id) > 0).sort((a, b) => uses(b) - uses(a)),
      saved: ids.filter((id) => uses(id) === 0 && isSaved(input, id)),
      add: ids.filter((id) => uses(id) === 0 && !isSaved(input, id)),
    };
  }
  const common = new Set<ConnectionId>(input.common);
  const starter = (id: ConnectionId) => {
    if (id === "copilot" || id === "custom") return true;
    if (id === "cloud") return !input.cloudOff;
    return common.has(id) || factsOf(input, id).saved;
  };
  return { layout, cards: ids.filter(starter), fold: ids.filter((id) => !starter(id)) };
}

function allIds(groups: ConnectionGroups): ConnectionId[] {
  return groups.layout === "grouped"
    ? [...groups.inUse, ...groups.saved, ...groups.add]
    : [...groups.cards, ...groups.fold];
}

/**
 * The snapshot's groups against the live state: a connection it knows keeps
 * its group and place, one it doesn't know (a custom connection saved since)
 * joins its live group at the end, and one that no longer exists is dropped.
 */
export function freezeGroups(
  snapshot: ConnectionGroups,
  input: ConnectionGroupsInput
): ConnectionGroups {
  const known = new Set(allIds(snapshot));
  const keep = (frozen: readonly ConnectionId[], live: readonly ConnectionId[]) => [
    ...frozen.filter((id) => exists(input, id)),
    ...live.filter((id) => !known.has(id)),
  ];
  if (snapshot.layout === "grouped") {
    const live = groupConnections(input, "grouped") as GroupedConnections;
    return {
      layout: "grouped",
      inUse: keep(snapshot.inUse, live.inUse),
      saved: keep(snapshot.saved, live.saved),
      add: keep(snapshot.add, live.add),
    };
  }
  const live = groupConnections(input, "firstRun") as FirstRunConnections;
  return {
    layout: "firstRun",
    cards: keep(snapshot.cards, live.cards),
    fold: keep(snapshot.fold, live.fold),
  };
}

// ── Visits ───────────────────────────────────────────────────────────────────

export interface ConnectionsVisit {
  /** The page is showing while Settings is open. */
  active: boolean;
  /** This visit's groups, taken once its inputs had loaded; null until then. */
  snapshot: ConnectionGroups | null;
}

export const NO_VISIT: ConnectionsVisit = { active: false, snapshot: null };

export interface VisitStep {
  /** The visit to keep: the same object when nothing changed. */
  visit: ConnectionsVisit;
  /** This render starts a visit (the fold closes). */
  started: boolean;
  groups: ConnectionGroups;
}

/**
 * One render of the section. A visit starts when the page shows while
 * Settings is open and ends when either hides. Its snapshot is taken on the
 * visit's first render where `ready` (secrets hydrated from main, Copilot's
 * status loaded), so a page opened during startup doesn't keep groups worked
 * out from placeholders; until then the groups follow the live state.
 */
export function stepVisit(
  visit: ConnectionsVisit,
  { active, ready, input }: { active: boolean; ready: boolean; input: ConnectionGroupsInput }
): VisitStep {
  if (!active) {
    return {
      visit: visit.active ? NO_VISIT : visit,
      started: false,
      groups: groupConnections(input),
    };
  }
  const started = !visit.active;
  if (!started && visit.snapshot) {
    return { visit, started, groups: freezeGroups(visit.snapshot, input) };
  }
  const groups = groupConnections(input);
  const next: ConnectionsVisit = ready
    ? { active: true, snapshot: groups }
    : started
      ? { active: true, snapshot: null }
      : visit;
  return { visit: next, started, groups };
}
