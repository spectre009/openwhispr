import type { SettingsState } from "../../stores/settingsStore";
import {
  isModeAllowedByPolicy,
  isProviderAllowedByPolicy,
  type PolicyDecisionSnapshot,
} from "../../stores/policyRules";
import { API_ENDPOINTS } from "../../config/constants";
import { COPILOT_PROVIDER_ID } from "../../config/copilot";
import {
  CUSTOM_CONNECTION_SLOTS,
  canonicalEndpoint,
  validateEndpoint,
  type ConnectionUse,
  type CustomConnection,
} from "../../config/customConnection";
import { azureSpeechOrigin } from "../../helpers/azureSpeechTranscription.js";
import {
  endpointCheckRoute,
  endpointDescriptorId,
  shortHash,
} from "../../helpers/connectionOutcomeTargets.js";
import type {
  ConnectionCheckDescriptor,
  ConnectionCheckKind,
  ConnectionCheckResult,
  ConnectionModelEvidence,
  ConnectionOutcome,
  ConnectionOutcomeEntry,
} from "../../types/electron";
import {
  CONNECTION_PROVIDERS,
  hasSavedCredential,
  type ConnectionProviderDef,
  type ConnectionProviderId,
} from "./connectionProviders";
import {
  endpointUsages,
  isActiveUsage,
  isCustomConnectionAllowed,
  usagesOfProvider,
  type FeatureUsage,
  type UsageFeature,
} from "./connectionUsage";

/**
 * Connection checks on Settings › AI Connections & Local Models, the
 * renderer's half (main's: helpers/connectionChecks.js). React-free.
 *
 * - **Descriptors**: one per thing to verify, built here because endpoints,
 *   regions, tenants and models live in the renderer's settings: the
 *   resolved route, the credential slot's name (never its value), the models
 *   active features use on it and a generation that changes with any of
 *   them. A card aggregates its descriptors (Corti has two).
 * - **What's checked**: what the page lists: providers with a saved
 *   credential (in use or not), the custom connection, Copilot while signed
 *   in, Cloud while on and signed in, and the self-hosted & custom endpoint
 *   rows. Policy-forbidden ones aren't probed ("Managed by your organization
 *   · not checked here").
 * - **States**: evidence (`ConnectionCheckResult`) read as a pill state,
 *   combined per card, and the flags elsewhere: the summary, the Settings
 *   menu's dot (only from active usages' own failures) and the model
 *   pickers' advisory metadata (never an availability reason).
 * - **Last recorded use**: real requests' outcomes (main's
 *   helpers/connectionOutcomes.js) by the same ids, newest per card.
 */

/** Auto-checks on showing the page reuse results younger than this. */
export const CONNECTION_CHECK_MAX_AGE_MS = 10 * 60 * 1000;

/** The renderer's own kind: Cloud's session check never goes to main's queue. */
export type HealthKind = ConnectionCheckKind | "cloud";

export type NotCheckedReason =
  "managed" | "noKey" | "incomplete" | "invalidEndpoint" | "endpointNeeded";

/** A card or row: a connection id, or a self-hosted & custom endpoint row (`endpoint:<feature>`). */
export type HealthOwner = string;

export interface CheckUse {
  feature: UsageFeature;
  model: string;
  active: boolean;
  /** Where the feature picks its model. */
  edit: string;
}

export interface CheckTarget {
  owner: HealthOwner;
  /** Sent to main, except Cloud's (`kind: "cloud"`), which the renderer checks. */
  descriptor: Omit<ConnectionCheckDescriptor, "kind"> & { kind: HealthKind };
  /** The host the user knows it by (problem box), never a key or a full URL. */
  host: string;
  /** Corti's two: which half this is. */
  part?: "llm" | "stt";
  /** Features on it: what a model chip and the menu dot read. */
  uses: CheckUse[];
  /** Store fields holding its credentials: flushed before an explicit check. */
  secretFields: string[];
  /**
   * The ids its "Last recorded use" reads (the descriptor's own when absent).
   * The custom connection's: its features' own endpoints, where their
   * requests record.
   */
  outcomeIds?: string[];
}

export interface CheckPlan {
  targets: CheckTarget[];
  /** Cards and rows listed but not probed, and why. */
  skipped: Record<HealthOwner, NotCheckedReason>;
}

export interface CheckPlanInput {
  settings: SettingsState;
  usages: readonly FeatureUsage[];
  policy: PolicyDecisionSnapshot;
  cloudDisabled: boolean;
  copilotSignedIn: boolean;
  connection: CustomConnection | null;
  connectionUses: readonly ConnectionUse[];
}

const STT_FEATURES: ReadonlySet<UsageFeature> = new Set([
  "recognition",
  "liveRecording",
  "fileTranscription",
]);

// ── Descriptors ──────────────────────────────────────────────────────────────

// Shared with "Last recorded use" (helpers/connectionOutcomeTargets.js), so a
// request maps to the same ids.
export { endpointCheckRoute, shortHash };

function generationOf(parts: {
  kind: HealthKind;
  route: string;
  slot: string | null;
  models: readonly string[];
}): string {
  return `g${shortHash(
    JSON.stringify([parts.kind, parts.route, parts.slot, [...parts.models].sort()])
  )}`;
}

function hostOf(route: string): string {
  try {
    return new URL(route).host;
  } catch {
    return "";
  }
}

function target(
  owner: HealthOwner,
  id: string,
  kind: HealthKind,
  capability: ConnectionCheckDescriptor["capability"],
  route: string,
  slot: string | null,
  uses: CheckUse[],
  secretFields: string[],
  part?: "llm" | "stt"
): CheckTarget {
  const models = [
    ...new Set(uses.filter((use) => use.active && use.model).map((use) => use.model)),
  ];
  return {
    owner,
    descriptor: {
      id,
      kind,
      capability,
      route,
      slot,
      models,
      generation: generationOf({ kind, route, slot, models }),
    },
    host: hostOf(route),
    uses,
    secretFields,
    ...(part ? { part } : {}),
  };
}

function usesOf(usages: readonly FeatureUsage[]): CheckUse[] {
  return usages.map((usage) => ({
    feature: usage.feature,
    model:
      usage.model ??
      (usage.connection.type === "custom" || usage.connection.type === "selfHosted"
        ? usage.connection.model
        : ""),
    active: isActiveUsage(usage),
    edit: usage.edit,
  }));
}

/** Whether policy lets the user bring their own key for this provider anywhere. */
export function providerCheckAllowed(
  policy: PolicyDecisionSnapshot,
  provider: ConnectionProviderDef
): boolean {
  return (
    (provider.llm &&
      isModeAllowedByPolicy(policy, "llm", "providers") &&
      isProviderAllowedByPolicy(policy, "llm", provider.id)) ||
    (provider.transcription &&
      isModeAllowedByPolicy(policy, "transcription", "providers") &&
      isProviderAllowedByPolicy(policy, "transcription", provider.id))
  );
}

const PROVIDER_KINDS: Record<
  Exclude<ConnectionProviderId, "corti" | "azure-speech">,
  { kind: ConnectionCheckKind; route: string }
> = {
  openai: { kind: "openai", route: API_ENDPOINTS.OPENAI_BASE },
  anthropic: { kind: "anthropic", route: "https://api.anthropic.com/v1" },
  gemini: { kind: "gemini", route: API_ENDPOINTS.GEMINI },
  groq: { kind: "groq", route: API_ENDPOINTS.GROQ_BASE },
  openrouter: { kind: "openrouter", route: API_ENDPOINTS.OPENROUTER_BASE },
  mistral: { kind: "mistral", route: "https://api.mistral.ai/v1" },
  xai: { kind: "xai", route: "https://api.x.ai/v1" },
  deepgram: { kind: "deepgram", route: "https://api.deepgram.com/v1" },
  assemblyai: { kind: "assemblyai", route: "https://api.assemblyai.com/v2" },
  tinfoil: { kind: "tinfoil", route: "https://inference.tinfoil.sh/v1" },
};

/** A provider's env slot (secretKeys.js), by its store field. */
const SLOT_BY_FIELD: Record<string, string> = {
  openaiApiKey: "OPENAI_API_KEY",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  geminiApiKey: "GEMINI_API_KEY",
  groqApiKey: "GROQ_API_KEY",
  openrouterApiKey: "OPENROUTER_API_KEY",
  mistralApiKey: "MISTRAL_API_KEY",
  tinfoilApiKey: "TINFOIL_API_KEY",
  cortiApiKey: "CORTI_API_KEY",
  xaiApiKey: "XAI_API_KEY",
  deepgramApiKey: "DEEPGRAM_API_KEY",
  assemblyaiApiKey: "ASSEMBLYAI_API_KEY",
  azureSpeechApiKey: "AZURE_SPEECH_API_KEY",
};

const filled = (value: unknown) => typeof value === "string" && !!value.trim();

/**
 * Every check the page runs, by card or row. Pure: reads presence only, and
 * names slots; no key enters a descriptor.
 */
export function buildCheckPlan(input: CheckPlanInput): CheckPlan {
  const { settings, usages, policy } = input;
  const targets: CheckTarget[] = [];
  const skipped: Record<HealthOwner, NotCheckedReason> = {};

  for (const provider of CONNECTION_PROVIDERS) {
    if (!hasSavedCredential(provider, settings)) continue;
    if (!providerCheckAllowed(policy, provider)) {
      skipped[provider.id] = "managed";
      continue;
    }
    const own = usesOf(usagesOfProvider(usages, provider.id));
    if (provider.id === "corti") {
      const llmUses = own.filter((use) => !STT_FEATURES.has(use.feature));
      const sttUses = own.filter((use) => STT_FEATURES.has(use.feature));
      if (filled(settings.cortiApiKey)) {
        targets.push(
          target(
            "corti",
            "corti:llm",
            "corti-llm",
            "llm",
            API_ENDPOINTS.CORTI_MODELS_BASE,
            "CORTI_API_KEY",
            llmUses,
            ["cortiApiKey"],
            "llm"
          )
        );
      }
      const id = filled(settings.cortiClientId);
      const secret = filled(settings.cortiClientSecret);
      if (id && secret) {
        const environment = settings.cortiEnvironment === "eu" ? "eu" : "us";
        const tenant = String(settings.cortiTenant || "base").trim() || "base";
        targets.push(
          target(
            "corti",
            "corti:stt",
            "corti-stt",
            "stt",
            `https://auth.${environment}.corti.app/realms/${tenant}`,
            "CORTI_CLIENT_CREDENTIALS",
            sttUses.map((use) => ({ ...use, model: "" })),
            ["cortiClientId", "cortiClientSecret"],
            "stt"
          )
        );
      } else if ((id || secret) && !filled(settings.cortiApiKey)) {
        skipped.corti = "incomplete";
      }
      continue;
    }
    if (provider.id === "azure-speech") {
      const origin = azureSpeechOrigin(settings.azureSpeechEndpoint ?? "");
      if (!filled(settings.azureSpeechApiKey)) continue;
      if (!origin) {
        skipped[provider.id] = "endpointNeeded";
        continue;
      }
      targets.push(
        target(
          provider.id,
          "provider:azure-speech",
          "azure-speech",
          "stt",
          origin,
          "AZURE_SPEECH_API_KEY",
          own,
          ["azureSpeechApiKey"]
        )
      );
      continue;
    }
    const spec = PROVIDER_KINDS[provider.id];
    const field = provider.credentials[0].key;
    targets.push(
      target(
        provider.id,
        `provider:${provider.id}`,
        spec.kind,
        provider.llm ? "llm" : "stt",
        spec.route,
        SLOT_BY_FIELD[field],
        own,
        [field]
      )
    );
  }

  // GitHub Copilot, while signed in: its token's identity, or (Check) its plan.
  const copilotAllowed =
    isModeAllowedByPolicy(policy, "llm", "providers") &&
    isProviderAllowedByPolicy(policy, "llm", COPILOT_PROVIDER_ID);
  if (input.copilotSignedIn) {
    if (!copilotAllowed) skipped.copilot = "managed";
    else {
      targets.push(
        target(
          "copilot",
          "copilot",
          "copilot",
          "identity",
          "https://api.github.com",
          "GITHUB_COPILOT_TOKEN",
          usesOf(usagesOfProvider(usages, COPILOT_PROVIDER_ID)),
          []
        )
      );
    }
  }

  // OpenWhispr Cloud, while on and signed in: the app's own session check.
  const cloudAllowed =
    isModeAllowedByPolicy(policy, "llm", "openwhispr") ||
    isModeAllowedByPolicy(policy, "transcription", "openwhispr");
  if (!input.cloudDisabled && settings.isSignedIn) {
    if (!cloudAllowed) skipped.cloud = "managed";
    else {
      targets.push(
        target(
          "cloud",
          "cloud",
          "cloud",
          "identity",
          "",
          null,
          usesOf(usagesOfProvider(usages, "cloud")),
          []
        )
      );
    }
  }

  // The custom connection: its canonical endpoint and its own key. A feature
  // on its endpoint whose slot holds another key ("different key · Update")
  // isn't vouched for by the connection's check.
  if (input.connection) {
    const validated = validateEndpoint(input.connection.endpoint);
    const connectionKey = String(settings.customConnectionApiKey ?? "").trim();
    const sameKey = (use: ConnectionUse) =>
      String(settings[CUSTOM_CONNECTION_SLOTS[use.slot] as keyof SettingsState] ?? "").trim() ===
      connectionKey;
    if (!isCustomConnectionAllowed(policy)) skipped.custom = "managed";
    else if (!validated.ok) skipped.custom = "invalidEndpoint";
    else if (!connectionKey) skipped.custom = "noKey";
    else {
      const vouched = input.connectionUses.filter(sameKey);
      targets.push(
        target(
          "custom",
          "custom",
          "custom",
          "llm",
          canonicalEndpoint(validated),
          "CUSTOM_CONNECTION_API_KEY",
          vouched.map((use) => ({
            feature: use.feature,
            model: use.model,
            active: isActiveUsage(use.usage),
            edit: use.usage.edit,
          })),
          ["customConnectionApiKey"]
        )
      );
      const added = targets[targets.length - 1];
      added.host = hostOf(validated.origin);
      // Its features record on their own endpoint's id, with their own key slot.
      added.outcomeIds = [
        "custom",
        ...new Set(
          vouched.flatMap((use) => {
            const route = endpointCheckRoute(settings[use.urlField as keyof SettingsState], false);
            return route ? [endpointDescriptorId("endpoint", route, use.slot)] : [];
          })
        ),
      ];
    }
  }

  // The self-hosted & custom endpoint rows the connection doesn't cover.
  const covered = new Set(input.connectionUses.map((use) => use.feature));
  for (const usage of endpointUsages(usages)) {
    if (covered.has(usage.feature)) continue;
    const owner = `endpoint:${usage.feature}`;
    if (usage.offReason === "policy") {
      skipped[owner] = "managed";
      continue;
    }
    const custom = usage.connection.type === "custom";
    const urlField = custom ? usage.customEndpoint?.urlField : usage.selfHostedEndpoint?.urlField;
    const route = urlField ? endpointCheckRoute(settings[urlField], !custom) : null;
    if (!route) {
      skipped[owner] = "invalidEndpoint";
      continue;
    }
    const slot = custom ? (usage.customEndpoint?.slot ?? null) : null;
    const kind: ConnectionCheckKind = custom ? "endpoint" : "selfHosted";
    const capability = STT_FEATURES.has(usage.feature) ? "stt" : "llm";
    // Rows on the same server with the same key share one check.
    const id = endpointDescriptorId(kind, route, slot);
    const uses = usesOf([usage]).map((use) => ({ ...use, model: "" }));
    targets.push(
      target(
        owner,
        id,
        kind,
        capability,
        route,
        slot,
        uses,
        slot ? [CUSTOM_CONNECTION_SLOTS[slot as keyof typeof CUSTOM_CONNECTION_SLOTS]] : []
      )
    );
  }

  return { targets, skipped };
}

// ── States ───────────────────────────────────────────────────────────────────

export type HealthState =
  | "ok"
  | "signedIn"
  | "service"
  | "reachable"
  | "notVerifiable"
  | "rejected"
  | "managementKey"
  | "unreachable"
  | "endpointNotFound"
  | "modelMissing"
  | "rateLimited"
  | "limitReached"
  | "outOfCredit"
  | "accessDenied"
  | "unexpected"
  | "notChecked"
  | "unchecked";

export type HealthTone = "ok" | "danger" | "warning" | "muted";

export const STATE_TONE: Readonly<Record<HealthState, HealthTone>> = {
  ok: "ok",
  signedIn: "ok",
  service: "ok",
  reachable: "ok",
  notVerifiable: "ok",
  rejected: "danger",
  managementKey: "danger",
  unreachable: "danger",
  endpointNotFound: "danger",
  modelMissing: "warning",
  rateLimited: "warning",
  limitReached: "warning",
  outOfCredit: "warning",
  accessDenied: "warning",
  unexpected: "warning",
  notChecked: "muted",
  unchecked: "muted",
};

// Worst first: a card shows its worst descriptor.
const PRIORITY: readonly HealthState[] = [
  "rejected",
  "managementKey",
  "unreachable",
  "endpointNotFound",
  "modelMissing",
  "limitReached",
  "outOfCredit",
  "rateLimited",
  "accessDenied",
  "unexpected",
  "notChecked",
  "notVerifiable",
  "reachable",
  "signedIn",
  "service",
  "ok",
  "unchecked",
];

/** States a feature fails in: a red flag when an active usage depends on it. */
const FAILING: ReadonlySet<HealthState> = new Set([
  "rejected",
  "managementKey",
  "unreachable",
  "endpointNotFound",
]);
/** Limits: amber. */
const LIMITED: ReadonlySet<HealthState> = new Set(["rateLimited", "limitReached", "outOfCredit"]);

/** One result as a pill state. */
export function stateOf(result: ConnectionCheckResult | undefined): HealthState {
  if (!result) return "unchecked";
  const { code } = result;
  if (code === "API_KEY_MISSING" || code === "CHECK_INVALID_ROUTE") return "notChecked";
  if (code === "CHECK_CLOUD_DISABLED") return "notChecked";
  if (code === "CHECK_MANAGEMENT_KEY") return "managementKey";
  if (result.credentials === "rejected") return "rejected";
  if (!result.reachable) return "unreachable";
  if (code === "CHECK_ENDPOINT_NOT_FOUND") return "endpointNotFound";
  if (code === "PROVIDER_RATE_LIMITED") return "rateLimited";
  if (code === "CHECK_LIMIT_REACHED") return "limitReached";
  if (code === "PROVIDER_QUOTA_EXHAUSTED") return "outOfCredit";
  if (code === "PROVIDER_ACCESS_DENIED") return "accessDenied";
  if (Object.values(result.models).includes("missing")) return "modelMissing";
  if (code === "CHECK_REDIRECTED" || code === "PROVIDER_ERROR") return "unexpected";
  if (result.credentials === "accepted") {
    if (result.proof === "identity" || result.proof === "session") return "signedIn";
    if (result.proof === "service") return "service";
    return "ok";
  }
  if (code === "CHECK_NOT_VERIFIABLE") return "notVerifiable";
  if (result.reachable) return "reachable";
  return "unexpected";
}

/** The worst of several states. */
export function worstState(states: readonly HealthState[]): HealthState {
  let worst: HealthState = "unchecked";
  for (const state of states) {
    if (PRIORITY.indexOf(state) < PRIORITY.indexOf(worst)) worst = state;
  }
  return worst;
}

/** The result shown for a target: only one about the generation it has now. */
export function resultFor(
  item: CheckTarget,
  results: Readonly<Record<string, ConnectionCheckResult>>
): ConnectionCheckResult | undefined {
  const result = results[item.descriptor.id];
  return result && result.generation === item.descriptor.generation ? result : undefined;
}

export interface OwnerHealth {
  owner: HealthOwner;
  state: HealthState;
  tone: HealthTone;
  /** The oldest result's time, for the pill's age. */
  checkedAt: number | null;
  checking: boolean;
  notChecked?: NotCheckedReason;
  /** The worst target's code (for a not-checked pill without a skipped reason). */
  code?: string;
  parts: Array<{ target: CheckTarget; result?: ConnectionCheckResult; state: HealthState }>;
}

/** Each card's or row's combined state, from its targets' current results. */
export function ownerHealth(
  owner: HealthOwner,
  plan: CheckPlan,
  results: Readonly<Record<string, ConnectionCheckResult>>,
  pending: Readonly<Record<string, string>>
): OwnerHealth | null {
  const own = plan.targets.filter((item) => item.owner === owner);
  if (own.length === 0) {
    const reason = plan.skipped[owner];
    return reason
      ? {
          owner,
          state: "notChecked",
          tone: "muted",
          checkedAt: null,
          checking: false,
          notChecked: reason,
          parts: [],
        }
      : null;
  }
  const parts = own.map((item) => {
    const result = resultFor(item, results);
    return { target: item, result, state: stateOf(result) };
  });
  const state = worstState(parts.map((part) => part.state));
  const times = parts.map((part) => part.result?.checkedAt).filter((at): at is number => !!at);
  const worst = parts.find((part) => part.state === state);
  return {
    owner,
    state,
    tone: STATE_TONE[state],
    checkedAt: times.length ? Math.min(...times) : null,
    checking: own.some((item) => pending[item.descriptor.id] === item.descriptor.generation),
    ...(plan.skipped[owner] ? { notChecked: plan.skipped[owner] } : {}),
    ...(worst?.result ? { code: worst.result.code } : {}),
    parts,
  };
}

/** A feature's model on a card, as compared: ✓ offered, ✕ missing, nothing when not compared. */
export function modelMark(
  health: OwnerHealth | null,
  feature: UsageFeature,
  model: string | undefined
): "offered" | "missing" | null {
  if (!health || !model) return null;
  for (const part of health.parts) {
    if (!part.target.uses.some((use) => use.feature === feature)) continue;
    const evidence: ConnectionModelEvidence | undefined = part.result?.models[model];
    if (evidence === "offered" || evidence === "missing") return evidence;
  }
  return null;
}

/** Active features whose own model is missing on this card. */
export function missingModelUses(health: OwnerHealth | null): CheckUse[] {
  if (!health) return [];
  return health.parts.flatMap(({ target: item, result }) =>
    item.uses.filter((use) => use.active && use.model && result?.models[use.model] === "missing")
  );
}

/** Active features a card's failure affects. */
export function affectedUses(health: OwnerHealth | null): CheckUse[] {
  if (!health) return [];
  const failing = health.parts.filter((part) => STATE_TONE[part.state] !== "ok");
  const uses = failing.flatMap((part) =>
    part.state === "modelMissing"
      ? part.target.uses.filter(
          (use) => use.active && use.model && part.result?.models[use.model] === "missing"
        )
      : part.target.uses.filter((use) => use.active)
  );
  const seen = new Set<UsageFeature>();
  return uses.filter((use) => (seen.has(use.feature) ? false : (seen.add(use.feature), true)));
}

// ── Last recorded use ────────────────────────────────────────────────────────

/** A card's or row's "Last recorded use": its newest outcome, and its newest failure. */
export interface OwnerLastUse {
  last: ConnectionOutcome;
  lastFailure: ConnectionOutcome | null;
}

/**
 * The newest outcome across a card's or row's descriptors (Corti's two, the
 * custom connection's features' endpoints), or null when nothing recorded
 * one: then it shows no line.
 */
export function ownerLastUse(
  owner: HealthOwner,
  plan: CheckPlan,
  outcomes: Readonly<Record<string, ConnectionOutcomeEntry>>
): OwnerLastUse | null {
  const ids = new Set(
    plan.targets
      .filter((item) => item.owner === owner)
      .flatMap((item) => item.outcomeIds ?? [item.descriptor.id])
  );
  let last: ConnectionOutcome | null = null;
  let lastFailure: ConnectionOutcome | null = null;
  for (const id of ids) {
    const entry = outcomes[id];
    if (!entry?.last) continue;
    if (!last || entry.last.at > last.at) last = entry.last;
    if (entry.lastFailure && (!lastFailure || entry.lastFailure.at > lastFailure.at)) {
      lastFailure = entry.lastFailure;
    }
  }
  return last ? { last, lastFailure } : null;
}

// ── Flags elsewhere ──────────────────────────────────────────────────────────

export type ConnectionsFlag = "danger" | "warning" | null;

/**
 * The Settings menu's dot on AI Connections: red only for an active usage's
 * own failure (its connection's key rejected or unreachable, or its own model
 * missing), amber for rate and spending limits on a connection a feature
 * uses. A connection nothing uses, or a missing model only an off feature
 * uses, flags nothing.
 */
export function connectionsFlag(
  plan: CheckPlan,
  results: Readonly<Record<string, ConnectionCheckResult>>
): ConnectionsFlag {
  let flag: ConnectionsFlag = null;
  for (const item of plan.targets) {
    const result = resultFor(item, results);
    if (!result) continue;
    const state = stateOf(result);
    const active = item.uses.filter((use) => use.active);
    if (active.length === 0) continue;
    if (FAILING.has(state)) return "danger";
    if (active.some((use) => use.model && result.models[use.model] === "missing")) return "danger";
    if (LIMITED.has(state)) flag = "warning";
  }
  return flag;
}

export interface HealthSummary {
  /** Connections listed with something to check. */
  total: number;
  checking: number;
  working: number;
  problems: number;
  warnings: number;
  notChecked: number;
  /** The oldest current result. */
  checkedAt: number | null;
  /** Red when a connection a feature uses fails, amber for any other problem. */
  tone: "danger" | "warning" | "ok" | "muted";
}

export function summarizeHealth(
  plan: CheckPlan,
  results: Readonly<Record<string, ConnectionCheckResult>>,
  pending: Readonly<Record<string, string>>
): HealthSummary {
  const owners = [...new Set(plan.targets.map((item) => item.owner))];
  const healths = owners
    .map((owner) => ownerHealth(owner, plan, results, pending))
    .filter((health): health is OwnerHealth => !!health);
  const count = (tone: HealthTone) => healths.filter((health) => health.tone === tone).length;
  const times = healths.map((health) => health.checkedAt).filter((at): at is number => !!at);
  const problems = count("danger");
  const warnings = count("warning");
  const flag = connectionsFlag(plan, results);
  return {
    total: healths.length,
    checking: healths.filter((health) => health.checking).length,
    working: count("ok"),
    problems,
    warnings,
    notChecked: healths.filter((health) => health.state === "notChecked").length,
    checkedAt: times.length ? Math.min(...times) : null,
    tone:
      flag === "danger"
        ? "danger"
        : problems + warnings > 0
          ? "warning"
          : times.length
            ? "ok"
            : "muted",
  };
}

// ── Model pickers ────────────────────────────────────────────────────────────

/** A connection's last check, as a model picker shows it beside an option. */
export interface PickerConnectionHealth {
  state: HealthState;
  checkedAt: number;
  /** Models the check found missing. */
  missing: readonly string[];
}

/**
 * Picker health by connection: `<owner>` and, for Corti's halves,
 * `<owner>:llm` / `<owner>:stt`. Only states worth a line: failures, limits
 * and missing models.
 */
export function pickerHealthMap(
  plan: CheckPlan,
  results: Readonly<Record<string, ConnectionCheckResult>>
): Record<string, PickerConnectionHealth> {
  const map: Record<string, PickerConnectionHealth> = {};
  for (const item of plan.targets) {
    const result = resultFor(item, results);
    if (!result) continue;
    const state = stateOf(result);
    const tone = STATE_TONE[state];
    if (tone !== "danger" && tone !== "warning") continue;
    const entry: PickerConnectionHealth = {
      state,
      checkedAt: result.checkedAt,
      missing: Object.entries(result.models)
        .filter(([, evidence]) => evidence === "missing")
        .map(([model]) => model),
    };
    const key = item.part ? `${item.owner}:${item.part}` : item.owner;
    map[key] = entry;
    if (item.part && !map[item.owner]) map[item.owner] = entry;
  }
  return map;
}
