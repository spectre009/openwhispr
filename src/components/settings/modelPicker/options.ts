import {
  LLM_ENTERPRISE_POLICY_PROVIDER_IDS,
  llmPolicyProviderIds,
  type ResolvedLLMConfig,
  type SettingsState,
} from "../../../stores/settingsStore";
import {
  filterModeOptionsByPolicy,
  isProviderAllowedByPolicy,
  type PolicyDecisionSnapshot,
} from "../../../stores/policyRules";
import {
  REASONING_PROVIDERS,
  enterpriseProviderName,
  getCloudModel,
  getLocalModel,
  getProviderDisplayName,
  isEnterpriseProvider,
  modelRegistry,
} from "../../../models/ModelRegistry";
import { COPILOT_PROVIDER_ID, isCopilotScopeSupported } from "../../../config/copilot";
import { isListedModel } from "../../../models/legacyModels";
import {
  INFERENCE_SCOPES,
  type InferenceScope,
  type InferenceScopeDefinition,
} from "../../../config/inferenceScopes";
import type { InferenceMode } from "../../../types/electron";
import { connectionDestination, findConnectionProvider } from "../connectionProviders";
import { endpointHost } from "../connectionUsage";
import { noteFormattingInheritsCleanup } from "../featurePageStatus";
import {
  CONNECTION_ENTER_ID,
  CONNECTION_GROUP_ID,
  CONNECTION_NO_KEY,
  SCOPE_USAGE_FEATURES,
  connectionBadge,
  connectionEnterLabel,
  connectionModelList,
  connectionModelOf,
  connectionOptionId,
  connectionTerms,
  connectionTrigger,
  connectionUsedBy,
  type PickerConnection,
} from "./connectionOptions";

/**
 * The language-model picker's options: one group per connection (OpenWhispr
 * Cloud, GitHub Copilot, the custom connection, each API-key provider, a
 * custom endpoint, local models, a self-hosted server, enterprise), each entry
 * carrying the mode, cloud mode, provider and model it selects. The filters
 * are the editor's:
 * `allowedModes`, the policy's modes and providers (`filterModeOptionsByPolicy`
 * with the scope's `llmPolicyProviderIds`, `isProviderAllowedByPolicy`), the
 * Cloud switch and sign-in, Copilot's scopes and sign-in, saved keys and
 * downloaded models. What policy or `allowedModes` rule out is hidden, as
 * before; what the user can fix is listed unavailable, with the reason and a
 * link to where it's fixed. The custom connection is offered wherever the
 * custom endpoint is, its models picked as a custom endpoint's are.
 *
 * Pure (no React, no store reads): `pickAvailability` is also what the
 * selection adapter revalidates a pick with at commit time.
 */

/**
 * Literal text (brand and model names) or an i18n key. `paramKeys` are
 * interpolation values that are themselves i18n keys (a feature's name),
 * translated first.
 */
export type PickerText =
  | { text: string }
  | { key: string; params?: Record<string, string>; paramKeys?: Record<string, string> };

const lit = (text: string): PickerText => ({ text });
const msg = (key: string, params?: Record<string, string>): PickerText =>
  params ? { key, params } : { key };

export type PickerLink =
  /** A Settings destination (`<page>#<settingId>`). */
  | { kind: "settings"; destination: string; labelKey: string }
  /** The OpenWhispr account sign-in (`requestSignIn`). */
  | { kind: "signIn"; labelKey: string };

export interface PickerUnavailable {
  reasonKey: string;
  /** Interpolation values for the reason (the speech-to-text picker's macOS version). */
  reasonParams?: Record<string, string>;
  /** Interpolation values that are i18n keys (a feature's name), translated first. */
  reasonParamKeys?: Record<string, string>;
  link?: PickerLink;
}

export type PickerAvailability = true | PickerUnavailable;

type Translate = (key: string, options?: Record<string, unknown>) => string;

function pickerParams(
  t: Translate,
  params?: Record<string, string>,
  paramKeys?: Record<string, string>
): Record<string, string> | undefined {
  if (!paramKeys) return params;
  const translated = Object.fromEntries(
    Object.entries(paramKeys).map(([name, key]) => [name, t(key)])
  );
  return { ...params, ...translated };
}

/** A picker text as shown. */
export function resolvePickerText(t: Translate, text: PickerText | undefined): string {
  if (!text) return "";
  return "text" in text ? text.text : t(text.key, pickerParams(t, text.params, text.paramKeys));
}

/** Why an entry can't be picked, as shown. */
export function unavailableReason(t: Translate, reason: PickerUnavailable): string {
  return t(reason.reasonKey, pickerParams(t, reason.reasonParams, reason.reasonParamKeys));
}

/**
 * A connection's last failing check, as AI Connections publishes it
 * (connectionHealth.ts's `pickerHealthMap`): by connection id, and by
 * `<id>:llm` / `<id>:stt` for Corti's halves.
 */
export interface PickerHealthEntry {
  state: string;
  checkedAt: number;
  /** Models the check found missing. */
  missing: readonly string[];
}

export type PickerHealth = Readonly<Record<string, PickerHealthEntry>>;

/**
 * Advisory metadata beside an available option: "Groq's key was rejected
 * (checked 3 minutes ago)" with a link to AI Connections. Never an
 * availability reason: `pickAvailability` refuses unavailable picks, and a
 * check is evidence from a moment ago, not a rule, so the option stays
 * pickable.
 */
export interface PickerAdvice {
  tone: "danger" | "warning";
  reasonKey: string;
  params: Record<string, string>;
  checkedAt: number;
  link: PickerLink;
}

const ADVICE_BY_STATE: Readonly<Record<string, { tone: PickerAdvice["tone"]; key: string }>> = {
  rejected: { tone: "danger", key: "modelPicker.health.rejected" },
  managementKey: { tone: "danger", key: "modelPicker.health.rejected" },
  unreachable: { tone: "danger", key: "modelPicker.health.unreachable" },
  endpointNotFound: { tone: "danger", key: "modelPicker.health.unreachable" },
  rateLimited: { tone: "warning", key: "modelPicker.health.rateLimited" },
  limitReached: { tone: "warning", key: "modelPicker.health.limitReached" },
  outOfCredit: { tone: "warning", key: "modelPicker.health.outOfCredit" },
  accessDenied: { tone: "warning", key: "modelPicker.health.accessDenied" },
};

/**
 * What a connection's last check says about one of its options: the
 * connection's own failure, or this option's model missing from its list.
 */
export function connectionAdvice(
  health: PickerHealth | undefined,
  keys: readonly string[],
  name: string,
  model: string,
  destination: string
): PickerAdvice | null {
  const entry = keys.map((key) => health?.[key]).find(Boolean);
  if (!entry) return null;
  const link: PickerLink = {
    kind: "settings",
    destination,
    labelKey: "modelPicker.health.fix",
  };
  if (entry.state === "modelMissing") {
    if (!model || !entry.missing.includes(model)) return null;
    return {
      tone: "danger",
      reasonKey: "modelPicker.health.modelMissing",
      params: { provider: name },
      checkedAt: entry.checkedAt,
      link,
    };
  }
  const advice = ADVICE_BY_STATE[entry.state];
  if (!advice) return null;
  return {
    tone: advice.tone,
    reasonKey: advice.key,
    params: { provider: name },
    checkedAt: entry.checkedAt,
    link,
  };
}

/** A language-model option's advisory line, if its connection's check found a problem. */
export function llmOptionAdvice(
  option: ModelPickerOption,
  health: PickerHealth | undefined,
  connectionName = ""
): PickerAdvice | null {
  if (!health || option.available !== true) return null;
  if (option.action === "useConnection") {
    return connectionAdvice(
      health,
      ["custom"],
      connectionName,
      option.model,
      "connections#connections.custom"
    );
  }
  if (option.mode !== "providers" || option.action || !option.provider) return null;
  if (option.provider === "custom") return null;
  if (option.provider === COPILOT_PROVIDER_ID) {
    return connectionAdvice(
      health,
      ["copilot"],
      "GitHub Copilot",
      option.model,
      connectionDestination("copilot")
    );
  }
  const provider = findConnectionProvider(option.provider);
  if (!provider) return null;
  return connectionAdvice(
    health,
    [`${provider.id}:llm`, provider.id],
    provider.name,
    option.model,
    connectionDestination(provider.id)
  );
}

/**
 * Entries that do more than select a model: the custom endpoint (opens its
 * fields; commits once a model is picked there, as the Custom tab did),
 * OpenRouter's catalog search, the self-hosted server and enterprise (pick
 * the mode, as their mode cards did, and open their fields), the
 * organization's managed deployment, a model on the custom connection (its
 * key is copied first, then the custom endpoint's pick), the connection's
 * "Enter a deployment name…" (opens a field for it), and plain links.
 */
export type PickerAction =
  | "configureCustom"
  | "searchOpenRouter"
  | "configureSelfHosted"
  | "configureEnterprise"
  | "useManaged"
  | "useConnection"
  | "enterConnectionModel"
  | "link";

/**
 * What `ModelPicker` reads from an option. The language-model picker's options
 * (`ModelPickerOption`) and the speech-to-text picker's (`SttPickerOption`,
 * sttOptions.ts) both extend it with what their selection adapter writes.
 */
export interface PickerOptionBase {
  id: string;
  label: PickerText;
  sub?: PickerText;
  /** Icon id: a provider id, or "cloud" | "local" | "selfHosted" | "enterprise" | "custom". */
  icon: string;
  /** "link" entries only follow `link`; other actions are the adapter's. */
  action?: string;
  /** Where a `link` entry goes. */
  link?: PickerLink;
  available: PickerAvailability;
  /** Extra words the filter field matches. */
  terms?: readonly string[];
}

export interface ModelPickerOption extends PickerOptionBase {
  mode: InferenceMode;
  cloudMode: "openwhispr" | "byok";
  /** Empty for entries that pick only a mode (Cloud, self-hosted, enterprise). */
  provider: string;
  model: string;
  action?: PickerAction;
}

export interface PickerGroup<O extends PickerOptionBase> {
  id: string;
  icon: string;
  title: PickerText;
  /** A pill beside the title (the custom connection's kind). */
  badge?: { text: PickerText; tone: "accent" | "muted" };
  meta?: PickerText;
  options: O[];
}

export type ModelPickerGroup = PickerGroup<ModelPickerOption>;

export interface PickerModel {
  id: string;
  name: string;
  /** Superseded (#2958): listed only while it is the selection (isListedModel). */
  legacy?: boolean;
}

export interface PickerLocalModel {
  id: string;
  name: string;
  size?: string;
}

/** API-key providers a language-model scope can pick, in the editor's order. */
export const PICKER_KEY_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "openrouter",
  "tinfoil",
  "corti",
] as const;

export type PickerKeyProvider = (typeof PICKER_KEY_PROVIDERS)[number];

type KeyFields = Pick<
  SettingsState,
  | "openaiApiKey"
  | "anthropicApiKey"
  | "geminiApiKey"
  | "groqApiKey"
  | "openrouterApiKey"
  | "tinfoilApiKey"
  | "cortiApiKey"
>;

/** Which provider keys are saved (presence only, never the key). */
export function savedKeyPresence(settings: KeyFields): Record<PickerKeyProvider, boolean> {
  const has = (value: string | undefined) => !!value?.trim();
  return {
    openai: has(settings.openaiApiKey),
    anthropic: has(settings.anthropicApiKey),
    gemini: has(settings.geminiApiKey),
    groq: has(settings.groqApiKey),
    openrouter: has(settings.openrouterApiKey),
    tinfoil: has(settings.tinfoilApiKey),
    corti: has(settings.cortiApiKey),
  };
}

export interface ModelPickerContext {
  policy: PolicyDecisionSnapshot;
  /** The "OpenWhispr account & Cloud" switch is off. */
  cloudDisabled: boolean;
  isSignedIn: boolean;
  /** The editor's restriction (the screen-context model offers API-key providers only). */
  allowedModes?: readonly InferenceMode[];
  keys: Readonly<Partial<Record<PickerKeyProvider, boolean>>>;
  copilot: {
    signedIn: boolean;
    /** The sign-in is still being read from main: neither offered nor flagged yet. */
    checking?: boolean;
    login?: string;
    models: readonly PickerModel[];
  };
  /** Tinfoil's live list (the registry's until it loads). */
  tinfoilModels?: readonly PickerModel[];
  /** Downloaded local language models. */
  localModels: readonly PickerLocalModel[];
  /**
   * What the editor shows as selected: the policy-effective mode and the
   * resolved fields (an optional scope's own model, not the inherited one).
   */
  current: Pick<ResolvedLLMConfig, "provider" | "model" | "cloudBaseUrl" | "remoteUrl"> & {
    mode: InferenceMode | null;
  };
  /** The organization's deployment for this scope, offered while the setup mode is manual. */
  managedDeployment?: { provider: string; model: string } | null;
  /** The custom connection, with its language models; null when there is none. */
  connection?: LlmPickerConnection | null;
}

/** An OpenAI-compatible connection's own `/models` list, read while the menu is open. */
export interface PickerConnectionCatalog {
  status: "loading" | "ready" | "error";
  models: readonly string[];
}

export interface LlmPickerConnection extends PickerConnection {
  /** Never for Azure, whose list is the region's catalog, not the resource's deployments. */
  catalog?: PickerConnectionCatalog | null;
}

const MODES: readonly InferenceMode[] = [
  "openwhispr",
  "providers",
  "local",
  "self-hosted",
  "enterprise",
];

/** The modes the editor offers a scope: `allowedModes`, then policy (as `usePolicyModeOptions`). */
export function offeredModes(
  scope: InferenceScope,
  ctx: Pick<ModelPickerContext, "policy" | "allowedModes">
): ReadonlySet<InferenceMode> {
  const candidates = MODES.filter((mode) => !ctx.allowedModes || ctx.allowedModes.includes(mode));
  return new Set(
    filterModeOptionsByPolicy(
      candidates.map((id) => ({ id })),
      "llm",
      ctx.policy,
      {
        byokProviders: llmPolicyProviderIds(scope),
        enterpriseProviders: LLM_ENTERPRISE_POLICY_PROVIDER_IDS,
      }
    ).map((option) => option.id)
  );
}

const isKeyProvider = (provider: string): provider is PickerKeyProvider =>
  (PICKER_KEY_PROVIDERS as readonly string[]).includes(provider);

/** The models a provider lists: Copilot's and Tinfoil's live lists, else the registry's. */
function providerModels(provider: string, ctx: ModelPickerContext): PickerModel[] {
  if (provider === COPILOT_PROVIDER_ID) return [...ctx.copilot.models];
  if (provider === "tinfoil" && ctx.tinfoilModels) return [...ctx.tinfoilModels];
  return (REASONING_PROVIDERS[provider]?.models ?? []).map((model) => ({
    id: model.value,
    name: model.label,
    ...(model.legacy ? { legacy: true } : {}),
  }));
}

/**
 * A provider's models as its group lists them: a legacy model (#2958) only
 * while it is the selection, where it can't be picked again.
 */
function listedProviderModels(provider: string, ctx: ModelPickerContext): PickerModel[] {
  return providerModels(provider, ctx).filter((model) =>
    isListedModel(model, isCurrent(ctx, provider, model.id))
  );
}

/** A legacy model, listed only as the selection: shown, never picked again. */
const LEGACY_MODEL: PickerUnavailable = { reasonKey: "models.legacyHint" };

const isCurrent = (ctx: ModelPickerContext, provider: string, model: string) =>
  ctx.current.mode === "providers" &&
  ctx.current.provider === provider &&
  ctx.current.model === model;

const COPILOT_SIGN_IN: PickerUnavailable = {
  reasonKey: "modelPicker.reasons.copilotSignedOut",
  link: {
    kind: "settings",
    destination: connectionDestination("copilot"),
    labelKey: "modelPicker.links.signInCopilot",
  },
};

function noKey(provider: PickerKeyProvider): PickerUnavailable {
  return {
    reasonKey: "modelPicker.reasons.noKey",
    link: {
      kind: "settings",
      destination: connectionDestination(provider),
      labelKey: "modelPicker.links.addKey",
    },
  };
}

export interface LlmPick {
  mode: InferenceMode;
  provider: string;
  model: string;
  action?: PickerAction;
}

/**
 * Whether a pick can be made in this scope right now: true, unavailable with a
 * reason the user can act on, or null when the editor doesn't offer it at all
 * (policy, `allowedModes`, an unknown or undownloaded model).
 */
export function pickAvailability(
  scope: InferenceScope,
  pick: LlmPick,
  ctx: ModelPickerContext
): PickerAvailability | null {
  if (pick.action === "link") return true;
  if (pick.action === "useConnection" || pick.action === "enterConnectionModel") {
    return connectionAvailability(scope, pick, ctx);
  }
  if (!offeredModes(scope, ctx).has(pick.mode)) return null;
  if (pick.action === "useManaged") return ctx.managedDeployment ? true : null;

  switch (pick.mode) {
    case "openwhispr":
      if (ctx.cloudDisabled) {
        return {
          reasonKey: "modelPicker.reasons.cloudOff",
          link: {
            kind: "settings",
            destination: "privacyData#privacy.cloud",
            labelKey: "modelPicker.links.openPrivacy",
          },
        };
      }
      if (!ctx.isSignedIn) {
        return {
          reasonKey: "modelPicker.reasons.signedOut",
          link: { kind: "signIn", labelKey: "modelPicker.links.signIn" },
        };
      }
      return true;
    case "self-hosted":
    case "enterprise":
      return true;
    case "local": {
      const downloaded = ctx.localModels.some((model) => model.id === pick.model);
      const known = downloaded ? modelRegistry.getModel(pick.model) : null;
      if (!known) return null;
      // A legacy model (#2958) is listed only as the selection; AI Connections deletes it.
      if (known.model.legacy) {
        return ctx.current.mode === "local" && ctx.current.model === pick.model
          ? LEGACY_MODEL
          : null;
      }
      return true;
    }
    case "providers": {
      const { provider, model } = pick;
      if (!provider || !isProviderAllowedByPolicy(ctx.policy, "llm", provider)) return null;
      if (provider === "custom") {
        // A custom endpoint's model ids are free-form, and its key is optional.
        return model || pick.action === "configureCustom" ? true : null;
      }
      if (provider === COPILOT_PROVIDER_ID) {
        if (!isCopilotScopeSupported(scope)) {
          return { reasonKey: "modelPicker.reasons.copilotScope" };
        }
        if (ctx.copilot.checking) return { reasonKey: "reasoning.copilot.loading" };
        if (!ctx.copilot.signedIn) return COPILOT_SIGN_IN;
      } else if (isKeyProvider(provider)) {
        if (!ctx.keys[provider]) return noKey(provider);
        if (provider === "openrouter") {
          // OpenRouter's catalog is live and free-form.
          return model || pick.action === "searchOpenRouter" ? true : null;
        }
      } else {
        return null;
      }
      const entry = providerModels(provider, ctx).find((candidate) => candidate.id === model);
      if (entry?.legacy) return isCurrent(ctx, provider, model) ? LEGACY_MODEL : null;
      return entry || (!!model && isCurrent(ctx, provider, model)) ? true : null;
    }
    default:
      return null;
  }
}

/**
 * A model on the custom connection: offered exactly where a custom endpoint's
 * model is (mode, policy, `allowedModes`), and only with a key to copy.
 */
function connectionAvailability(
  scope: InferenceScope,
  pick: LlmPick,
  ctx: ModelPickerContext
): PickerAvailability | null {
  if (!ctx.connection) return null;
  const custom = pickAvailability(
    scope,
    pick.action === "enterConnectionModel"
      ? { mode: "providers", provider: "custom", model: "", action: "configureCustom" }
      : { mode: "providers", provider: "custom", model: pick.model },
    ctx
  );
  if (custom !== true) return custom;
  return ctx.connection.hasKey ? true : CONNECTION_NO_KEY;
}

/** Builds an option, or null when the editor doesn't offer it. */
function option(
  scope: InferenceScope,
  ctx: ModelPickerContext,
  entry: Omit<ModelPickerOption, "available" | "cloudMode">
): ModelPickerOption | null {
  const available = pickAvailability(scope, entry, ctx);
  if (available === null) return null;
  return {
    ...entry,
    cloudMode: entry.mode === "openwhispr" ? "openwhispr" : "byok",
    available,
  };
}

function compact<T>(items: ReadonlyArray<T | null | undefined>): T[] {
  return items.filter((item): item is T => item !== null && item !== undefined);
}

/** A provider's display name, as AI Connections shows it. */
export function providerName(provider: string): string {
  if (provider === COPILOT_PROVIDER_ID) return "GitHub Copilot";
  if (isEnterpriseProvider(provider)) return enterpriseProviderName(provider);
  return findConnectionProvider(provider)?.name ?? getProviderDisplayName(provider);
}

function modelName(provider: string, model: string, ctx?: ModelPickerContext): string {
  if (!model) return "";
  if (ctx && (provider === COPILOT_PROVIDER_ID || provider === "tinfoil")) {
    const live = providerModels(provider, ctx).find((entry) => entry.id === model);
    if (live) return live.name;
  }
  return getCloudModel(model, provider)?.name || model;
}

/** The provider's models plus the current pick when the list doesn't carry it (yet). */
function withCurrent(
  provider: string,
  models: PickerModel[],
  ctx: ModelPickerContext
): PickerModel[] {
  const { model } = ctx.current;
  if (!model || !isCurrent(ctx, provider, model) || models.some((entry) => entry.id === model)) {
    return models;
  }
  return [{ id: model, name: modelName(provider, model, ctx) }, ...models];
}

function cloudGroup(scope: InferenceScope, ctx: ModelPickerContext): ModelPickerGroup | null {
  const automatic = option(scope, ctx, {
    id: "cloud",
    icon: "cloud",
    label: msg("modelPicker.cloud.automatic"),
    sub: msg("modelPicker.cloud.automaticSub"),
    mode: "openwhispr",
    provider: "",
    model: "",
    terms: ["openwhispr", "cloud"],
  });
  if (!automatic) return null;
  return {
    id: "cloud",
    icon: "cloud",
    title: msg("connections.names.cloud"),
    meta: ctx.cloudDisabled
      ? msg("connections.status.off")
      : ctx.isSignedIn
        ? msg("connections.status.signedIn")
        : msg("connections.status.notSignedIn"),
    options: [automatic],
  };
}

function copilotGroup(scope: InferenceScope, ctx: ModelPickerContext): ModelPickerGroup | null {
  const base = {
    icon: COPILOT_PROVIDER_ID,
    mode: "providers" as const,
    provider: COPILOT_PROVIDER_ID,
  };
  const terms = ["copilot", "github"];
  const supported = isCopilotScopeSupported(scope);
  const checking = supported && !!ctx.copilot.checking;
  const placeholder = !supported
    ? { id: "copilot:unsupported", key: "modelPicker.copilot.unsupported" }
    : checking
      ? { id: "copilot:checking", key: "reasoning.copilot.loading" }
      : { id: "copilot:signIn", key: "modelPicker.copilot.notSignedIn" };
  const options =
    supported && !checking && ctx.copilot.signedIn
      ? compact(
          withCurrent(COPILOT_PROVIDER_ID, providerModels(COPILOT_PROVIDER_ID, ctx), ctx).map(
            (model) =>
              option(scope, ctx, {
                ...base,
                id: `copilot:${model.id}`,
                label: lit(model.name),
                model: model.id,
                terms: [...terms, model.id],
              })
          )
        )
      : compact([
          option(scope, ctx, {
            ...base,
            id: placeholder.id,
            label: msg(placeholder.key),
            model: "",
            terms,
          }),
        ]);
  if (options.length === 0) return null;
  return {
    id: "copilot",
    icon: COPILOT_PROVIDER_ID,
    title: msg("connections.names.copilot"),
    meta:
      !supported || checking
        ? undefined
        : !ctx.copilot.signedIn
          ? msg("connections.status.notSignedIn")
          : ctx.copilot.login
            ? lit(`@${ctx.copilot.login}`)
            : msg("connections.status.signedIn"),
    options,
  };
}

function keyProviderGroup(
  scope: InferenceScope,
  ctx: ModelPickerContext,
  provider: PickerKeyProvider
): ModelPickerGroup | null {
  const name = providerName(provider);
  const base = { icon: provider, mode: "providers" as const, provider };
  const terms = [provider, name];
  let options: ModelPickerOption[];
  if (!ctx.keys[provider]) {
    options = compact([
      option(scope, ctx, {
        ...base,
        id: `provider:${provider}:addKey`,
        label: msg("modelPicker.provider.notConnected"),
        model: "",
        terms,
      }),
    ]);
  } else if (provider === "openrouter") {
    const { model } = ctx.current;
    options = compact([
      model && isCurrent(ctx, provider, model)
        ? option(scope, ctx, {
            ...base,
            id: `openrouter:${model}`,
            label: lit(modelName(provider, model)),
            sub: lit(model),
            model,
            terms: [...terms, model],
          })
        : null,
      option(scope, ctx, {
        ...base,
        id: "openrouter:search",
        label: msg("modelPicker.openrouter.search"),
        model: "",
        action: "searchOpenRouter",
        terms,
      }),
    ]);
  } else {
    options = compact(
      withCurrent(provider, listedProviderModels(provider, ctx), ctx).map((model) =>
        option(scope, ctx, {
          ...base,
          id: `provider:${provider}:${model.id}`,
          label: lit(model.name),
          ...(model.legacy ? { sub: msg("models.legacy") } : {}),
          model: model.id,
          terms: [...terms, model.id],
        })
      )
    );
  }
  if (options.length === 0) return null;
  return {
    id: `provider:${provider}`,
    icon: provider,
    title: lit(name),
    meta: ctx.keys[provider]
      ? msg("modelPicker.meta.apiKey")
      : msg("connections.status.notConnected"),
    options,
  };
}

function customGroup(scope: InferenceScope, ctx: ModelPickerContext): ModelPickerGroup | null {
  const { current } = ctx;
  const committed = current.mode === "providers" && current.provider === "custom";
  const host = committed ? endpointHost(current.cloudBaseUrl) : "";
  const entry = option(scope, ctx, {
    id: "custom",
    icon: "custom",
    label: committed && current.model ? lit(current.model) : msg("modelPicker.custom.label"),
    sub: host ? lit(host) : msg("modelPicker.custom.sub"),
    mode: "providers",
    provider: "custom",
    model: committed ? current.model : "",
    action: "configureCustom",
    terms: ["custom", "openai compatible", "endpoint", ...(host ? [host] : [])],
  });
  if (!entry) return null;
  return {
    id: "custom",
    icon: "custom",
    title: msg("modelPicker.custom.title"),
    meta: msg("modelPicker.meta.thisFeature"),
    options: [entry],
  };
}

/**
 * The custom connection, named after it with its kind: its language models
 * (remembered, then those its features run, the feature's own included), an
 * OpenAI-compatible connection's `/models` list, then "Enter a deployment
 * name…". Offered wherever the custom endpoint is.
 */
function connectionGroup(scope: InferenceScope, ctx: ModelPickerContext): ModelPickerGroup | null {
  const { connection } = ctx;
  if (!connection) return null;
  const custom = { mode: "providers" as const, provider: "custom", model: "" };
  if (pickAvailability(scope, { ...custom, action: "configureCustom" }, ctx) === null) return null;
  const terms = connectionTerms(connection);
  const current = connectionModelOf(connection, {
    provider: ctx.current.mode === "providers" ? ctx.current.provider : "",
    model: ctx.current.model,
    url: ctx.current.cloudBaseUrl,
  });
  const catalog = connection.kind === "azure" ? [] : (connection.catalog?.models ?? []);
  const self = SCOPE_USAGE_FEATURES[scope];
  const models = compact(
    connectionModelList(connection, current, catalog).map((model) =>
      option(scope, ctx, {
        ...custom,
        id: connectionOptionId(model.id),
        icon: "connection",
        label: lit(model.id),
        sub: connectionUsedBy(model.usedBy, self),
        model: model.id,
        action: "useConnection",
        terms: [...terms, model.id],
      })
    )
  );
  const enter = option(scope, ctx, {
    ...custom,
    id: CONNECTION_ENTER_ID,
    icon: "connection",
    label: connectionEnterLabel(connection.kind),
    action: "enterConnectionModel",
    terms: [...terms, "deployment", "model"],
  });
  return {
    id: CONNECTION_GROUP_ID,
    icon: "connection",
    title: lit(connection.name),
    badge: connectionBadge(connection),
    options: compact([...models, enter]),
  };
}

function localGroup(scope: InferenceScope, ctx: ModelPickerContext): ModelPickerGroup | null {
  if (!offeredModes(scope, ctx).has("local")) return null;
  const models = compact(
    ctx.localModels.map((model) => {
      const known = modelRegistry.getModel(model.id);
      if (!known) return null;
      return option(scope, ctx, {
        id: `local:${model.id}`,
        icon: known.provider.id,
        label: lit(known.model.name || model.name),
        sub: known.model.legacy
          ? msg("models.legacy")
          : lit([known.provider.name, model.size || known.model.size].filter(Boolean).join(" · ")),
        mode: "local",
        provider: known.provider.id,
        model: model.id,
        terms: ["local", model.id, known.provider.id, known.provider.name],
      });
    })
  );
  const download: ModelPickerOption = {
    id: "local:download",
    icon: "local",
    label: msg(models.length ? "modelPicker.local.downloadMore" : "modelPicker.local.download"),
    sub: msg("modelPicker.local.downloadSub"),
    mode: "local",
    cloudMode: "byok",
    provider: "",
    model: "",
    action: "link",
    link: {
      kind: "settings",
      destination: "connections#connections.localModels",
      labelKey: "modelPicker.links.openLocalModels",
    },
    available: true,
    terms: ["download", "local"],
  };
  return {
    id: "local",
    icon: "local",
    title: msg("modelPicker.local.title"),
    meta: msg("modelPicker.meta.onThisComputer"),
    options: [...models, download],
  };
}

function selfHostedGroup(scope: InferenceScope, ctx: ModelPickerContext): ModelPickerGroup | null {
  const { current } = ctx;
  const committed = current.mode === "self-hosted";
  const host = committed ? endpointHost(current.remoteUrl) : "";
  const entry = option(scope, ctx, {
    id: "selfHosted",
    icon: "selfHosted",
    label: committed && current.model ? lit(current.model) : msg("modelPicker.selfHosted.label"),
    sub: host ? lit(host) : msg("modelPicker.selfHosted.sub"),
    mode: "self-hosted",
    provider: "",
    model: "",
    action: "configureSelfHosted",
    terms: ["self-hosted", "lan", "ollama", "lm studio", "server", ...(host ? [host] : [])],
  });
  if (!entry) return null;
  return {
    id: "selfHosted",
    icon: "selfHosted",
    title: msg("modelPicker.selfHosted.title"),
    meta: msg("modelPicker.meta.thisFeature"),
    options: [entry],
  };
}

function enterpriseGroup(scope: InferenceScope, ctx: ModelPickerContext): ModelPickerGroup | null {
  const { current } = ctx;
  const own =
    current.mode === "enterprise" && isEnterpriseProvider(current.provider) ? current.provider : "";
  const deployment = ctx.managedDeployment;
  const options = compact([
    deployment && isEnterpriseProvider(deployment.provider)
      ? option(scope, ctx, {
          id: "enterprise:managed",
          icon: deployment.provider,
          label: lit(modelName(deployment.provider, deployment.model)),
          sub: msg("modelPicker.enterprise.managedSub", {
            provider: providerName(deployment.provider),
          }),
          mode: "enterprise",
          provider: "",
          model: "",
          action: "useManaged",
          terms: ["managed", "organization", deployment.provider],
        })
      : null,
    option(scope, ctx, {
      id: "enterprise",
      icon: own || "enterprise",
      label:
        own && current.model
          ? lit(modelName(own, current.model))
          : msg("modelPicker.enterprise.label"),
      sub: own ? lit(providerName(own)) : msg("modelPicker.enterprise.sub"),
      mode: "enterprise",
      provider: "",
      model: "",
      action: "configureEnterprise",
      terms: ["enterprise", "bedrock", "aws", "azure", "vertex"],
    }),
  ]);
  if (options.length === 0) return null;
  return {
    id: "enterprise",
    icon: "enterprise",
    title: msg("modelPicker.enterprise.title"),
    options,
  };
}

/**
 * The picker's groups for a scope. The custom connection comes after Copilot;
 * API-key providers with a saved key come right after it, in the editor's
 * order; those without one follow the custom endpoint.
 */
export function buildModelPickerOptions(
  scope: InferenceScope,
  ctx: ModelPickerContext
): ModelPickerGroup[] {
  const connected = PICKER_KEY_PROVIDERS.filter((provider) => ctx.keys[provider]);
  const unconnected = PICKER_KEY_PROVIDERS.filter((provider) => !ctx.keys[provider]);
  return compact([
    cloudGroup(scope, ctx),
    copilotGroup(scope, ctx),
    connectionGroup(scope, ctx),
    ...connected.map((provider) => keyProviderGroup(scope, ctx, provider)),
    customGroup(scope, ctx),
    ...unconnected.map((provider) => keyProviderGroup(scope, ctx, provider)),
    localGroup(scope, ctx),
    selfHostedGroup(scope, ctx),
    enterpriseGroup(scope, ctx),
  ]);
}

/**
 * The option the current selection shows as, so the list can mark it: a
 * custom endpoint that is the connection shows as the connection's model.
 */
export function selectedOptionId(
  current: ModelPickerContext["current"],
  connection?: Pick<PickerConnection, "endpoint"> | null
): string | null {
  const { mode, provider, model } = current;
  switch (mode) {
    case "openwhispr":
      return "cloud";
    case "self-hosted":
      return "selfHosted";
    case "enterprise":
      return "enterprise";
    case "local":
      return model ? `local:${model}` : null;
    case "providers": {
      if (provider === "custom") {
        const onConnection = connectionModelOf(connection, {
          provider,
          model,
          url: current.cloudBaseUrl,
        });
        return onConnection ? connectionOptionId(onConnection) : "custom";
      }
      if (!provider || !model) return null;
      if (provider === COPILOT_PROVIDER_ID) return `copilot:${model}`;
      if (provider === "openrouter") return `openrouter:${model}`;
      return `provider:${provider}:${model}`;
    }
    default:
      return null;
  }
}

export interface PickerSelectionSummary {
  /** Icon id, as on options. */
  icon: string;
  title: PickerText;
  sub: PickerText;
  /** Why the selection can't run as shown (Cloud off, no key, …). */
  warning?: PickerText;
}

/**
 * What the picker's button shows: the model, then connection · account. An
 * optional scope with no model of its own says what answers meanwhile.
 */
export function describePickerSelection(
  scope: InferenceScope,
  ctx: ModelPickerContext
): PickerSelectionSummary {
  const { mode, provider, model } = ctx.current;
  const choose = msg("modelPicker.trigger.choose");
  const definition: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  if (definition.optional && !model && mode !== "openwhispr") {
    return {
      icon: provider || "custom",
      title: choose,
      sub: msg(`modelPicker.trigger.optionalUnset.${scope}`),
    };
  }
  switch (mode) {
    case null:
      return { icon: "enterprise", title: msg("common.managedByOrg"), sub: lit("") };
    case "openwhispr":
      return {
        icon: "cloud",
        title: msg("modelPicker.cloud.automatic"),
        sub: msg("connections.names.cloud"),
        warning: ctx.cloudDisabled
          ? msg("modelPicker.reasons.cloudOff")
          : ctx.isSignedIn
            ? undefined
            : msg("modelPicker.reasons.signedOut"),
      };
    case "local":
      return {
        icon: modelRegistry.getModel(model)?.provider.id ?? "local",
        title: model ? lit(getLocalModel(model)?.name || model) : choose,
        sub: msg("modelPicker.trigger.local"),
      };
    case "self-hosted": {
      const host = endpointHost(ctx.current.remoteUrl);
      return {
        icon: "selfHosted",
        title: model ? lit(model) : choose,
        sub: host
          ? msg("modelPicker.trigger.selfHosted", { host })
          : msg("modelPicker.selfHosted.title"),
      };
    }
    case "enterprise":
      return {
        icon: isEnterpriseProvider(provider) ? provider : "enterprise",
        title: model ? lit(modelName(provider, model)) : choose,
        sub: isEnterpriseProvider(provider)
          ? msg("modelPicker.trigger.enterprise", { provider: providerName(provider) })
          : msg("modelPicker.enterprise.title"),
      };
    default: {
      if (provider === "custom") {
        const { connection } = ctx;
        if (
          connection &&
          connectionModelOf(connection, { provider, model, url: ctx.current.cloudBaseUrl })
        ) {
          return { icon: "connection", title: lit(model), sub: connectionTrigger(connection) };
        }
        const host = endpointHost(ctx.current.cloudBaseUrl);
        return {
          icon: "custom",
          title: model ? lit(model) : choose,
          sub: host ? msg("modelPicker.trigger.custom", { host }) : msg("modelPicker.custom.title"),
        };
      }
      if (!provider) return { icon: "custom", title: choose, sub: lit("") };
      const name = providerName(provider);
      if (provider === COPILOT_PROVIDER_ID) {
        return {
          icon: provider,
          title: model ? lit(modelName(provider, model, ctx)) : choose,
          sub: lit(ctx.copilot.login ? `${name} · @${ctx.copilot.login}` : name),
          warning: !isCopilotScopeSupported(scope)
            ? msg("modelPicker.reasons.copilotScope")
            : ctx.copilot.signedIn || ctx.copilot.checking
              ? undefined
              : msg("modelPicker.reasons.copilotSignedOut"),
        };
      }
      return {
        icon: provider,
        title: model ? lit(modelName(provider, model, ctx)) : choose,
        sub: msg("modelPicker.trigger.apiKey", { provider: name }),
        warning:
          isKeyProvider(provider) && !ctx.keys[provider]
            ? msg("modelPicker.reasons.noKey")
            : undefined,
      };
    }
  }
}

export type NoteFormattingField = "provider" | "endpoint" | "server" | "model";

export interface NoteFormattingFieldState {
  field: NoteFormattingField;
  value: PickerText;
  /** Borrowed from Cleanup because note formatting's own value is empty. */
  inherited: boolean;
}

type NoteFormattingSettings = Pick<
  SettingsState,
  | "noteFormattingMode"
  | "noteFormattingProvider"
  | "noteFormattingModel"
  | "noteFormattingCloudBaseUrl"
  | "noteFormattingRemoteUrl"
>;

/**
 * Note formatting's fields while any of them inherits from Cleanup (each
 * empty field borrows Cleanup's value on its own, selectResolvedLLMConfig),
 * else null. Takes policy-effective settings and note formatting's resolved
 * config, as the editor shows them; endpoints show their host only.
 */
export function noteFormattingFields(
  settings: NoteFormattingSettings,
  resolved: Pick<ResolvedLLMConfig, "provider" | "model" | "cloudBaseUrl" | "remoteUrl">
): NoteFormattingFieldState[] | null {
  if (!noteFormattingInheritsCleanup(settings)) return null;
  const none = msg("modelPicker.inherit.none");
  const host = (url: string | undefined) => {
    const value = endpointHost(url);
    return value ? lit(value) : none;
  };
  const model: NoteFormattingFieldState = {
    field: "model",
    value: resolved.model
      ? lit(
          getCloudModel(resolved.model, resolved.provider)?.name ||
            getLocalModel(resolved.model)?.name ||
            resolved.model
        )
      : none,
    inherited: !settings.noteFormattingModel,
  };
  switch (settings.noteFormattingMode) {
    case "local":
      return [model];
    case "self-hosted":
      return [
        {
          field: "server",
          value: host(resolved.remoteUrl),
          inherited: !settings.noteFormattingRemoteUrl,
        },
        model,
      ];
    default: {
      const custom = resolved.provider === "custom";
      const provider: NoteFormattingFieldState = {
        field: "provider",
        value: custom
          ? msg("modelPicker.custom.title")
          : resolved.provider
            ? lit(providerName(resolved.provider))
            : none,
        inherited: !settings.noteFormattingProvider,
      };
      return custom
        ? [
            provider,
            {
              field: "endpoint",
              value: host(resolved.cloudBaseUrl),
              inherited: !settings.noteFormattingCloudBaseUrl,
            },
            model,
          ]
        : [provider, model];
    }
  }
}
