import {
  TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS,
  TRANSCRIPTION_POLICY_PROVIDER_IDS,
  selectResolvedMeetingTranscription,
  selectResolvedUploadTranscription,
  type SettingsState,
} from "../../../stores/settingsStore";
import {
  filterModeOptionsByPolicy,
  isEnterpriseTranscriptionOfferable,
  isProviderAllowedByPolicy,
  reconcilePolicyModeSelection,
  type PolicyDecisionSnapshot,
  type TranscriptionPolicyContext,
} from "../../../stores/policyRules";
import {
  PARAKEET_MODEL_INFO,
  WHISPER_MODEL_INFO,
  getMeetingStreamingTranscriptionProviders,
  getTranscriptionProvider,
  getTranscriptionProviders,
  type TranscriptionModelDefinition,
  type TranscriptionProviderData,
} from "../../../models/ModelRegistry";
import { STREAMING_ONLY_PROVIDERS } from "../../../helpers/transcriptionRoute";
import {
  LOCAL_ASR_ORGANIZATIONS,
  getASRModelOrganization,
} from "../../../helpers/localASROrganization";
import { applyCloudSwitchToModeOptions } from "../../../utils/openWhisprCloudModes";
import { API_ENDPOINTS, normalizeBaseUrl } from "../../../config/constants";
import type { InferenceMode } from "../../../types/electron";
import { connectionDestination, findConnectionProvider } from "../connectionProviders";
import { endpointHost, type UsageFeature } from "../connectionUsage";
import {
  CONNECTION_ENTER_ID,
  CONNECTION_GROUP_ID,
  CONNECTION_NO_KEY,
  SURFACE_USAGE_FEATURES,
  connectionBadge,
  connectionEnterLabel,
  connectionModelList,
  connectionModelOf,
  connectionOptionId,
  connectionSharedKeyConflict,
  connectionTerms,
  connectionTrigger,
  connectionUsedBy,
  type PickerConnection,
} from "./connectionOptions";
import type {
  PickerAvailability,
  PickerGroup,
  PickerLink,
  PickerOptionBase,
  PickerSelectionSummary,
  PickerText,
  PickerUnavailable,
} from "./options";

/**
 * The speech-to-text picker's options, per surface: Recognition (dictation),
 * Live Recording (note/meeting recording) and File Transcription (uploads).
 * One group per connection — OpenWhispr Cloud, the custom connection (where
 * the surface has a custom lane), each speech-to-text provider
 * with its models, a custom OpenAI-compatible endpoint, downloaded local
 * models (Whisper, Parakeet/Oruk, Cohere), a self-hosted server, enterprise —
 * each entry carrying the mode, provider and model it selects.
 *
 * The filters are the old editors': the policy's modes and providers
 * (`filterModeOptionsByPolicy` with each surface's provider catalog,
 * `isProviderAllowedByPolicy`), the enterprise mode only for a managed policy
 * (`isEnterpriseTranscriptionOfferable`) and never for live recording, the
 * streaming rule per surface (live recording runs only the streaming models
 * of the providers it can stream, `getMeetingStreamingTranscriptionProviders`,
 * and no custom endpoint; file transcription hides the live-only providers,
 * `STREAMING_ONLY_PROVIDERS`). What those rule out is hidden, as before; what
 * the user can fix (Cloud off, signed out, no key saved, a sherpa model this
 * Mac can't run) is listed unavailable with the reason and a link, and live
 * recording lists the self-hosted server as "not available yet", as its card
 * did.
 *
 * Pure (no React, no store reads): `sttPickAvailability` is also what the
 * selection adapter revalidates a pick with at commit time.
 */

export type SttSurface = "dictation" | "liveRecording" | "fileTranscription";

/** The settings scope each surface's keys belong to. */
export const STT_SURFACE_CONTEXT: Record<SttSurface, TranscriptionPolicyContext> = {
  dictation: "dictation",
  liveRecording: "meeting",
  fileTranscription: "upload",
};

const lit = (text: string): PickerText => ({ text });
const msg = (key: string, params?: Record<string, string>): PickerText =>
  params ? { key, params } : { key };

/**
 * Entries that do more than select: the custom endpoint (opens its fields;
 * commits once a model is entered there, or picks the mode when this surface
 * already points at the endpoint, as the Cloud providers card did), the
 * self-hosted server (picks the mode, as its card did, and opens its fields),
 * a model on the custom connection (its key goes first, then the custom
 * endpoint's pick), the connection's "Enter a deployment name…" (opens a field
 * for it), and plain links.
 */
export type SttPickerAction =
  "configureCustom" | "configureSelfHosted" | "useConnection" | "enterConnectionModel" | "link";

export interface SttPickerOption extends PickerOptionBase {
  mode: InferenceMode;
  /** A cloud provider id, a local provider ("whisper" | "nvidia" | "cohere"), "custom", or "" for a mode. */
  provider: string;
  model: string;
  action?: SttPickerAction;
}

export type SttPickerGroup = PickerGroup<SttPickerOption>;

/** Speech-to-text providers with a shared key, in the old provider tabs' order. */
export const STT_PICKER_PROVIDERS = [
  "openai",
  "groq",
  "xai",
  "mistral",
  "gemini",
  "corti",
  "tinfoil",
  "deepgram",
  "assemblyai",
] as const;

export type SttKeyProvider = (typeof STT_PICKER_PROVIDERS)[number];

type SttKeyFields = Pick<
  SettingsState,
  | "openaiApiKey"
  | "groqApiKey"
  | "xaiApiKey"
  | "mistralApiKey"
  | "geminiApiKey"
  | "cortiClientId"
  | "cortiClientSecret"
  | "tinfoilApiKey"
  | "deepgramApiKey"
  | "assemblyaiApiKey"
>;

/** Which speech-to-text credentials are saved (presence only, never a key). Corti needs both client credentials. */
export function sttKeyPresence(settings: SttKeyFields): Record<SttKeyProvider, boolean> {
  const has = (value: string | undefined) => !!value?.trim();
  return {
    openai: has(settings.openaiApiKey),
    groq: has(settings.groqApiKey),
    xai: has(settings.xaiApiKey),
    mistral: has(settings.mistralApiKey),
    gemini: has(settings.geminiApiKey),
    corti: has(settings.cortiClientId) && has(settings.cortiClientSecret),
    tinfoil: has(settings.tinfoilApiKey),
    deepgram: has(settings.deepgramApiKey),
    assemblyai: has(settings.assemblyaiApiKey),
  };
}

/** A downloaded local speech model: a whisper.cpp model or a sherpa-onnx one (Parakeet, Oruk, Cohere). */
export interface SttLocalModel {
  id: string;
  engine: "whisper" | "sherpa";
  /** Size on disk, when the list reports one. */
  size?: string;
}

/** What the surface runs, resolved and policy-effective (inherited values filled in). */
export interface SttCurrent {
  /** The mode the editor shows (policy-effective, as the mode cards reconciled it). */
  mode: InferenceMode | null;
  cloudProvider: string;
  cloudModel: string;
  cloudBaseUrl: string;
  localProvider: string;
  localModel: string;
  remoteUrl: string;
  remoteModel: string;
}

export interface SttPickerContext {
  policy: PolicyDecisionSnapshot;
  /** The "OpenWhispr account & Cloud" switch is off. */
  cloudDisabled: boolean;
  isSignedIn: boolean;
  keys: Readonly<Partial<Record<SttKeyProvider, boolean>>>;
  /** Downloaded local speech models; null until the lists have been read. */
  localModels: readonly SttLocalModel[] | null;
  /** sherpa-onnx can't run here (an older macOS): its models can't be picked. */
  sherpa?: { supported: boolean; minimumMacOSVersion?: string };
  /**
   * The model this surface last used on its custom endpoint (the store's
   * per-provider memory, `transcriptionModelByProvider["<context>:custom"]`),
   * offered back while another provider is selected and the endpoint's URL is
   * still set.
   */
  rememberedCustomModel?: string;
  /** The custom connection, with its speech models; null when there is none. */
  connection?: SttPickerConnection | null;
  current: SttCurrent;
}

export interface SttPickerConnection extends PickerConnection {
  /**
   * Speech-to-text's one custom key: whether it already is the connection's
   * (main compares; null until asked), and the feature that would keep sending
   * it elsewhere after a pick (`sttSharedKeyConflict`).
   */
  sharedKey: { matches: boolean | null; conflict: UsageFeature | null };
}

/** The providers (and their models) a surface can run, before policy and keys. */
export function sttSurfaceProviders(surface: SttSurface): TranscriptionProviderData[] {
  // Live recording streams, and only through the providers main can stream notes with.
  if (surface === "liveRecording") return getMeetingStreamingTranscriptionProviders();
  const providers = getTranscriptionProviders();
  // Uploads are batch: the live-only providers have no batch route (transcriptionRoute fails them closed).
  return surface === "fileTranscription"
    ? providers.filter((provider) => !STREAMING_ONLY_PROVIDERS.has(provider.id))
    : providers;
}

/** Live recording has no custom-endpoint lane (it streams). */
export const sttSurfaceOffersCustom = (surface: SttSurface) => surface !== "liveRecording";

function policyCatalog(surface: SttSurface) {
  return surface === "liveRecording"
    ? { byokProviders: getMeetingStreamingTranscriptionProviders().map((provider) => provider.id) }
    : {
        byokProviders: TRANSCRIPTION_POLICY_PROVIDER_IDS,
        enterpriseProviders: TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS,
      };
}

/** The mode cards each surface showed, before policy. */
export function sttModeCandidates(
  surface: SttSurface,
  policy: PolicyDecisionSnapshot
): InferenceMode[] {
  const modes: InferenceMode[] = ["openwhispr", "providers", "local", "self-hosted"];
  if (surface !== "liveRecording" && isEnterpriseTranscriptionOfferable(policy)) {
    modes.push("enterprise");
  }
  return modes;
}

/** The modes policy lets a surface offer (as `usePolicyModeOptions` filtered the cards). */
export function sttOfferedModes(
  surface: SttSurface,
  ctx: Pick<SttPickerContext, "policy">
): ReadonlySet<InferenceMode> {
  return new Set(
    filterModeOptionsByPolicy(
      sttModeCandidates(surface, ctx.policy).map((id) => ({ id })),
      "transcription",
      ctx.policy,
      policyCatalog(surface)
    ).map((option) => option.id)
  );
}

function modeCards(
  surface: SttSurface,
  ctx: Pick<SttPickerContext, "policy" | "isSignedIn">
): Array<{ id: InferenceMode; disabled: boolean }> {
  return sttModeCandidates(surface, ctx.policy).map((id) => ({
    id,
    disabled:
      (id === "openwhispr" && !ctx.isSignedIn) ||
      // Live recording's self-hosted card was "Coming soon".
      (surface === "liveRecording" && id === "self-hosted"),
  }));
}

/**
 * The mode cards a surface showed, as `usePolicyModeOptions`' `modes`: policy-
 * filtered, Cloud dropped while the Cloud switch is off unless it's the stored mode.
 */
export function sttVisibleModes(
  surface: SttSurface,
  storedMode: InferenceMode,
  ctx: Pick<SttPickerContext, "policy" | "cloudDisabled"> & { isSignedIn?: boolean }
): Array<{ id: InferenceMode; disabled: boolean }> {
  const switched = applyCloudSwitchToModeOptions(
    modeCards(surface, { policy: ctx.policy, isSignedIn: ctx.isSignedIn ?? true }),
    ctx.cloudDisabled,
    storedMode,
    { badge: "", description: "" }
  );
  return filterModeOptionsByPolicy(switched, "transcription", ctx.policy, policyCatalog(surface));
}

/**
 * The mode the editor shows for a stored mode, exactly as `usePolicyModeOptions`
 * derived it from the mode cards: the stored mode, unless a managed policy hides
 * it (or Cloud needs a sign-in), then the first card it allows.
 */
export function sttEffectiveMode(
  surface: SttSurface,
  storedMode: InferenceMode,
  ctx: Pick<SttPickerContext, "policy" | "cloudDisabled" | "isSignedIn">
): InferenceMode | null {
  const status = ctx.policy.status;
  if (
    status === "idle" ||
    status === "unmanaged" ||
    sttVisibleModes(surface, storedMode, ctx).some(
      (option) => option.id === storedMode && !option.disabled
    )
  ) {
    return storedMode;
  }
  return reconcilePolicyModeSelection(
    modeCards(surface, ctx),
    "transcription",
    ctx.policy,
    storedMode,
    policyCatalog(surface)
  );
}

/** The local provider a downloaded model runs under ("whisper", "nvidia" for Parakeet and Oruk, "cohere"). */
export function localSttProvider(model: Pick<SttLocalModel, "id" | "engine">): string {
  if (model.engine === "whisper") return "whisper";
  return getASRModelOrganization(model.id) === "cohere" ? "cohere" : "nvidia";
}

/** A local speech model's display name. */
export function localSttModelName(modelId: string): string {
  const whisper = (WHISPER_MODEL_INFO as Record<string, { name: string } | undefined>)[modelId];
  if (whisper) return `Whisper ${whisper.name}`;
  const sherpa = (PARAKEET_MODEL_INFO as Record<string, { name: string } | undefined>)[modelId];
  return sherpa?.name || modelId;
}

/** The organization a local model is listed under (Oruk, OpenAI's Whisper, NVIDIA, Cohere). */
function localOrganization(model: Pick<SttLocalModel, "id" | "engine">): string {
  return model.engine === "whisper" ? "whisper" : getASRModelOrganization(model.id);
}

const ORGANIZATION_ORDER: readonly string[] = LOCAL_ASR_ORGANIZATIONS.map((org) => org.id);
const ORGANIZATION_NAMES: Record<string, string> = {
  ...Object.fromEntries(LOCAL_ASR_ORGANIZATIONS.map((org) => [org.id, org.name])),
  whisper: "Whisper",
};

export interface SttPick {
  mode: InferenceMode;
  provider: string;
  model: string;
  action?: SttPickerAction;
}

function noKey(provider: string): PickerUnavailable {
  const card = findConnectionProvider(provider);
  return {
    reasonKey: "modelPicker.reasons.noKey",
    link: card
      ? {
          kind: "settings",
          destination: connectionDestination(card.id),
          labelKey: "modelPicker.links.addKey",
        }
      : undefined,
  };
}

function sherpaUnavailable(ctx: SttPickerContext): PickerUnavailable {
  const version = ctx.sherpa?.minimumMacOSVersion;
  return version
    ? { reasonKey: "modelPicker.stt.reasons.requiresMacOS", reasonParams: { version } }
    : { reasonKey: "modelPicker.stt.reasons.localUnavailable" };
}

/** Whether a provider's credentials are saved (the custom endpoint's key is optional). */
const hasKey = (ctx: SttPickerContext, provider: string) => !!ctx.keys[provider as SttKeyProvider];

/**
 * Whether a pick can be made on this surface right now: true, unavailable with
 * a reason the user can act on, or null when the surface doesn't offer it
 * (policy, the surface's streaming rule, an unknown or undownloaded model).
 */
export function sttPickAvailability(
  surface: SttSurface,
  pick: SttPick,
  ctx: SttPickerContext
): PickerAvailability | null {
  if (pick.action === "link") return true;
  if (pick.action === "useConnection" || pick.action === "enterConnectionModel") {
    return sttConnectionAvailability(surface, pick, ctx);
  }
  if (!sttOfferedModes(surface, ctx).has(pick.mode)) return null;

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
      return surface === "liveRecording"
        ? { reasonKey: "modelPicker.stt.reasons.selfHostedLiveRecording" }
        : true;
    case "enterprise":
      return true;
    case "local": {
      const entry = ctx.localModels?.find((model) => model.id === pick.model);
      if (!entry || localSttProvider(entry) !== pick.provider) return null;
      if (entry.engine === "sherpa" && ctx.sherpa?.supported === false) {
        return sherpaUnavailable(ctx);
      }
      return true;
    }
    case "providers": {
      const { provider, model } = pick;
      if (!provider || !isProviderAllowedByPolicy(ctx.policy, "transcription", provider)) {
        return null;
      }
      // A custom endpoint's model is free-form (even empty: the route sends whisper-1), and its key optional.
      if (provider === "custom") return sttSurfaceOffersCustom(surface) ? true : null;
      const data = sttSurfaceProviders(surface).find((entry) => entry.id === provider);
      if (!data) return null;
      if (!hasKey(ctx, provider)) return noKey(provider);
      return data.models.some((entry) => entry.id === model) ? true : null;
    }
    default:
      return null;
  }
}

/**
 * A model on the custom connection: offered where the surface has a custom
 * lane (never Live Recording) and policy allows it, with a key to copy, and
 * named (a deployment). Speech-to-text has one custom key: unless it already
 * is the connection's, the pick replaces it, so it's unavailable while
 * another feature still sends it elsewhere.
 */
function sttConnectionAvailability(
  surface: SttSurface,
  pick: SttPick,
  ctx: SttPickerContext
): PickerAvailability | null {
  const { connection } = ctx;
  if (!connection) return null;
  const custom = sttPickAvailability(
    surface,
    { mode: "providers", provider: "custom", model: pick.model },
    ctx
  );
  if (custom !== true) return custom;
  if (pick.action === "useConnection" && !pick.model) return null;
  if (!connection.hasKey) return CONNECTION_NO_KEY;
  const { matches, conflict } = connection.sharedKey;
  if (matches !== true && conflict) return connectionSharedKeyConflict(conflict);
  return true;
}

function option(
  surface: SttSurface,
  ctx: SttPickerContext,
  entry: Omit<SttPickerOption, "available">
): SttPickerOption | null {
  const available = sttPickAvailability(surface, entry, ctx);
  if (available === null) return null;
  return { ...entry, available };
}

function compact<T>(items: ReadonlyArray<T | null | undefined>): T[] {
  return items.filter((item): item is T => item !== null && item !== undefined);
}

/** A speech-to-text provider's display name, as AI Connections shows it. */
export function sttProviderName(provider: string): string {
  return (
    findConnectionProvider(provider)?.name ?? getTranscriptionProvider(provider)?.name ?? provider
  );
}

/** A cloud model's display name (the registry's, else the id). */
export function sttCloudModelName(provider: string, model: string): string {
  return (
    getTranscriptionProvider(provider)?.models.find((entry) => entry.id === model)?.name || model
  );
}

function modelDescription(model: TranscriptionModelDefinition): PickerText | undefined {
  if (model.descriptionKey) return msg(model.descriptionKey);
  return model.description ? lit(model.description) : undefined;
}

function cloudGroup(surface: SttSurface, ctx: SttPickerContext): SttPickerGroup | null {
  const automatic = option(surface, ctx, {
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

function providerGroup(
  surface: SttSurface,
  ctx: SttPickerContext,
  data: TranscriptionProviderData
): SttPickerGroup | null {
  const provider = data.id;
  const name = sttProviderName(provider);
  const base = { icon: provider, mode: "providers" as const, provider };
  const terms = [provider, name];
  const options = hasKey(ctx, provider)
    ? compact(
        data.models.map((model) =>
          option(surface, ctx, {
            ...base,
            id: `provider:${provider}:${model.id}`,
            label: lit(model.name),
            sub: modelDescription(model),
            model: model.id,
            terms: [...terms, model.id, ...(model.streaming ? ["streaming", "realtime"] : [])],
          })
        )
      )
    : compact([
        option(surface, ctx, {
          ...base,
          id: `provider:${provider}:addKey`,
          label: msg("modelPicker.provider.notConnected"),
          model: "",
          terms,
        }),
      ]);
  if (options.length === 0) return null;
  return {
    id: `provider:${provider}`,
    icon: provider,
    title: lit(name),
    meta: hasKey(ctx, provider)
      ? msg("modelPicker.meta.apiKey")
      : msg("connections.status.notConnected"),
    options,
  };
}

/**
 * A URL that points at a custom endpoint: set, and neither the default OpenAI
 * URL nor a known provider's (the old Custom tab's `hasCustomUrl`).
 */
export function isCustomTranscriptionUrl(url: string | undefined): boolean {
  const normalized = normalizeBaseUrl(url || "");
  if (!normalized || normalized === normalizeBaseUrl(API_ENDPOINTS.TRANSCRIPTION_BASE)) {
    return false;
  }
  return !getTranscriptionProviders().some(
    (provider) => normalizeBaseUrl(provider.baseUrl) === normalized
  );
}

function customGroup(surface: SttSurface, ctx: SttPickerContext): SttPickerGroup | null {
  const { current } = ctx;
  // The surface already points at the endpoint (another mode may be shown).
  const stored = current.cloudProvider === "custom";
  const host = stored ? endpointHost(current.cloudBaseUrl) : "";
  const entry = option(surface, ctx, {
    id: "custom",
    icon: "custom",
    label: stored && current.cloudModel ? lit(current.cloudModel) : msg("modelPicker.custom.label"),
    sub: host ? lit(host) : msg("modelPicker.stt.custom.sub"),
    mode: "providers",
    provider: "custom",
    model: stored ? current.cloudModel : "",
    action: "configureCustom",
    terms: ["custom", "openai compatible", "endpoint", "azure", ...(host ? [host] : [])],
  });
  if (!entry) return null;
  // Back to the endpoint this surface last used, in one pick: what entering
  // that model in the Custom tab did (the provider switch restores it).
  const remembered = ctx.rememberedCustomModel?.trim() ?? "";
  const rememberedHost =
    !stored && remembered && isCustomTranscriptionUrl(current.cloudBaseUrl)
      ? endpointHost(current.cloudBaseUrl)
      : "";
  const back = rememberedHost
    ? option(surface, ctx, {
        id: "custom:remembered",
        icon: "custom",
        label: lit(remembered),
        sub: lit(rememberedHost),
        mode: "providers",
        provider: "custom",
        model: remembered,
        terms: ["custom", "endpoint", "azure", remembered, rememberedHost],
      })
    : null;
  return {
    id: "custom",
    icon: "custom",
    title: msg("modelPicker.custom.title"),
    meta: msg("modelPicker.meta.thisFeature"),
    options: compact([back, entry]),
  };
}

/**
 * The custom connection, named after it with its kind: its speech models
 * (remembered, then those its features run, the surface's own included), then
 * "Enter a deployment name…". Recognition and File Transcription only.
 */
function connectionGroup(surface: SttSurface, ctx: SttPickerContext): SttPickerGroup | null {
  const { connection, current } = ctx;
  if (!connection) return null;
  const custom = { mode: "providers" as const, provider: "custom", model: "" };
  if (sttPickAvailability(surface, { ...custom, action: "configureCustom" }, ctx) === null) {
    return null;
  }
  const terms = connectionTerms(connection);
  const own = connectionModelOf(connection, {
    provider: current.mode === "providers" ? current.cloudProvider : "",
    model: current.cloudModel,
    url: current.cloudBaseUrl,
  });
  const self = SURFACE_USAGE_FEATURES[surface];
  const models = compact(
    connectionModelList(connection, own).map((model) =>
      option(surface, ctx, {
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
  const enter = option(surface, ctx, {
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

function localSub(model: SttLocalModel): PickerText {
  const organization = localOrganization(model);
  const size = model.size || "";
  if (organization === "cohere") {
    return msg(
      size ? "modelPicker.stt.local.cohereSubSized" : "modelPicker.stt.local.cohereSub",
      size ? { size } : undefined
    );
  }
  return lit([ORGANIZATION_NAMES[organization] ?? "", size].filter(Boolean).join(" · "));
}

function localGroup(surface: SttSurface, ctx: SttPickerContext): SttPickerGroup | null {
  if (!sttOfferedModes(surface, ctx).has("local")) return null;
  const rank = (model: SttLocalModel) => {
    const index = ORGANIZATION_ORDER.indexOf(localOrganization(model));
    return index === -1 ? ORGANIZATION_ORDER.length : index;
  };
  const models = compact(
    [...(ctx.localModels ?? [])]
      .sort((a, b) => rank(a) - rank(b))
      .map((model) => {
        const organization = localOrganization(model);
        return option(surface, ctx, {
          id: `local:${model.id}`,
          icon: organization,
          label: lit(localSttModelName(model.id)),
          sub: localSub(model),
          mode: "local",
          provider: localSttProvider(model),
          model: model.id,
          terms: [
            "local",
            "offline",
            model.id,
            organization,
            ORGANIZATION_NAMES[organization] ?? "",
            model.engine === "whisper" ? "whisper" : "parakeet",
          ],
        });
      })
  );
  const download: SttPickerOption = {
    id: "local:download",
    icon: "local",
    label: msg(models.length ? "modelPicker.local.downloadMore" : "modelPicker.local.download"),
    sub: msg("modelPicker.local.downloadSub"),
    mode: "local",
    provider: "",
    model: "",
    action: "link",
    link: {
      kind: "settings",
      destination: "connections#connections.localModels",
      labelKey: "modelPicker.links.openLocalModels",
    },
    available: true,
    terms: ["download", "local", "whisper", "parakeet", "cohere"],
  };
  return {
    id: "local",
    icon: "local",
    title: msg("modelPicker.local.title"),
    meta: msg("modelPicker.meta.onThisComputer"),
    options: [...models, download],
  };
}

function selfHostedGroup(surface: SttSurface, ctx: SttPickerContext): SttPickerGroup | null {
  const { current } = ctx;
  const committed = current.mode === "self-hosted";
  const host = committed ? endpointHost(current.remoteUrl) : "";
  const entry = option(surface, ctx, {
    id: "selfHosted",
    icon: "selfHosted",
    label:
      committed && current.remoteModel
        ? lit(current.remoteModel)
        : msg("modelPicker.selfHosted.label"),
    sub: host ? lit(host) : msg("modelPicker.stt.selfHosted.sub"),
    mode: "self-hosted",
    provider: "",
    model: "",
    action: "configureSelfHosted",
    terms: ["self-hosted", "lan", "server", "whisper.cpp", ...(host ? [host] : [])],
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

function enterpriseGroup(surface: SttSurface, ctx: SttPickerContext): SttPickerGroup | null {
  const entry = option(surface, ctx, {
    id: "enterprise",
    icon: "enterprise",
    label: msg("modelPicker.stt.enterprise.label"),
    sub: msg("modelPicker.stt.enterprise.sub"),
    mode: "enterprise",
    provider: "",
    model: "",
    terms: ["enterprise", "azure", "managed", "organization"],
  });
  if (!entry) return null;
  return {
    id: "enterprise",
    icon: "enterprise",
    title: msg("modelPicker.enterprise.title"),
    options: [entry],
  };
}

/**
 * The picker's groups for a surface. The custom connection comes right after
 * OpenWhispr Cloud; providers with saved credentials follow, in the old tabs'
 * order; those without follow the custom endpoint.
 */
export function buildSttPickerOptions(
  surface: SttSurface,
  ctx: SttPickerContext
): SttPickerGroup[] {
  const providers = sttSurfaceProviders(surface);
  const ordered = STT_PICKER_PROVIDERS.map((id) =>
    providers.find((entry) => entry.id === id)
  ).filter((entry): entry is TranscriptionProviderData => !!entry);
  const connected = ordered.filter((entry) => hasKey(ctx, entry.id));
  const unconnected = ordered.filter((entry) => !hasKey(ctx, entry.id));
  return compact([
    cloudGroup(surface, ctx),
    connectionGroup(surface, ctx),
    ...connected.map((entry) => providerGroup(surface, ctx, entry)),
    customGroup(surface, ctx),
    ...unconnected.map((entry) => providerGroup(surface, ctx, entry)),
    localGroup(surface, ctx),
    selfHostedGroup(surface, ctx),
    enterpriseGroup(surface, ctx),
  ]);
}

/**
 * The option the current selection shows as, so the list can mark it: a
 * custom endpoint that is the connection (the surface's own URL, or the one
 * it borrows) shows as the connection's model.
 */
export function selectedSttOptionId(
  current: SttCurrent,
  connection?: Pick<PickerConnection, "endpoint"> | null
): string | null {
  switch (current.mode) {
    case "openwhispr":
      return "cloud";
    case "self-hosted":
      return "selfHosted";
    case "enterprise":
      return "enterprise";
    case "local":
      return current.localModel ? `local:${current.localModel}` : null;
    case "providers": {
      if (current.cloudProvider === "custom") {
        const onConnection = connectionModelOf(connection, {
          provider: current.cloudProvider,
          model: current.cloudModel,
          url: current.cloudBaseUrl,
        });
        return onConnection ? connectionOptionId(onConnection) : "custom";
      }
      if (!current.cloudProvider || !current.cloudModel) return null;
      return `provider:${current.cloudProvider}:${current.cloudModel}`;
    }
    default:
      return null;
  }
}

/**
 * The model a local engine runs when its scope has none (the meeting route's
 * and the local managers' defaults: whisper.js, parakeet.js,
 * resolveMeetingTranscriptionOptions).
 */
export const LOCAL_STT_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  whisper: "base",
  nvidia: "parakeet-tdt-0.6b-v3",
  cohere: "cohere-transcribe-03-2026",
};

/** A local engine's name as the picker lists it (Whisper, NVIDIA, Oruk, Cohere). */
export function localSttEngineName(provider: string, model: string): string {
  if (model) {
    const organization = localOrganization({
      id: model,
      engine: provider === "whisper" ? "whisper" : "sherpa",
    });
    return ORGANIZATION_NAMES[organization] ?? organization;
  }
  return provider === "whisper" ? "Whisper" : provider === "cohere" ? "Cohere" : "NVIDIA";
}

const LOCAL_MODELS_LINK: PickerLink = {
  kind: "settings",
  destination: "connections#connections.localModels",
  labelKey: "modelPicker.links.openLocalModels",
};

/**
 * Why the current selection can't run on this surface as shown, if it can't,
 * with where it's fixed: live recording on a provider or model that doesn't
 * stream (an inherited dictation choice, typically), uploads on a live-only
 * provider, a provider without a saved key, a local engine with no model on
 * disk (its own, or the engine's default when it has none) — "No Whisper
 * model downloaded", or "This model isn't downloaded" when the engine has
 * others — and sherpa models this macOS can't run.
 */
export function sttSelectionIssue(
  surface: SttSurface,
  ctx: SttPickerContext
): PickerUnavailable | undefined {
  const { current } = ctx;
  switch (current.mode) {
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
      return ctx.isSignedIn
        ? undefined
        : {
            reasonKey: "modelPicker.reasons.signedOut",
            link: { kind: "signIn", labelKey: "modelPicker.links.signIn" },
          };
    case "local": {
      if (!ctx.localModels) return undefined;
      const provider = current.localProvider;
      const model = current.localModel || LOCAL_STT_DEFAULT_MODELS[provider] || "";
      const entry = ctx.localModels.find(
        (candidate) => candidate.id === model && localSttProvider(candidate) === provider
      );
      if (!entry) {
        const engineHasModels = ctx.localModels.some(
          (candidate) => localSttProvider(candidate) === provider
        );
        return engineHasModels && current.localModel
          ? { reasonKey: "modelPicker.stt.reasons.notDownloaded", link: LOCAL_MODELS_LINK }
          : {
              reasonKey: "modelPicker.stt.reasons.noLocalModel",
              reasonParams: { engine: localSttEngineName(provider, current.localModel) },
              link: LOCAL_MODELS_LINK,
            };
      }
      if (entry.engine === "sherpa" && ctx.sherpa?.supported === false) {
        return sherpaUnavailable(ctx);
      }
      return undefined;
    }
    case "self-hosted":
      return surface === "liveRecording"
        ? { reasonKey: "modelPicker.stt.reasons.selfHostedLiveRecording" }
        : undefined;
    case "providers": {
      const provider = current.cloudProvider;
      if (surface === "liveRecording") {
        const data = sttSurfaceProviders(surface).find((entry) => entry.id === provider);
        const streams =
          !!data &&
          (!current.cloudModel || data.models.some((model) => model.id === current.cloudModel));
        if (provider && !streams) return { reasonKey: "modelPicker.stt.reasons.needsStreaming" };
      } else if (surface === "fileTranscription" && STREAMING_ONLY_PROVIDERS.has(provider)) {
        return { reasonKey: "modelPicker.stt.reasons.liveOnly" };
      }
      if (
        (STT_PICKER_PROVIDERS as readonly string[]).includes(provider) &&
        !hasKey(ctx, provider)
      ) {
        return noKey(provider);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The issue's text, as the picker's button shows it. */
export function sttSelectionWarning(
  surface: SttSurface,
  ctx: SttPickerContext
): PickerText | undefined {
  const issue = sttSelectionIssue(surface, ctx);
  return issue ? msg(issue.reasonKey, issue.reasonParams) : undefined;
}
/**
 * What the picker's button shows: the model, then the connection, with a
 * warning when the selection can't run as shown.
 */
export function describeSttSelection(
  surface: SttSurface,
  ctx: SttPickerContext
): PickerSelectionSummary {
  const { current } = ctx;
  const choose = msg("modelPicker.trigger.choose");
  const warning = sttSelectionWarning(surface, ctx);
  switch (current.mode) {
    case null:
      return { icon: "enterprise", title: msg("common.managedByOrg"), sub: lit("") };
    case "openwhispr":
      return {
        icon: "cloud",
        title: msg("modelPicker.cloud.automatic"),
        sub: msg("connections.names.cloud"),
        warning,
      };
    case "local": {
      const engine = current.localProvider === "whisper" ? "whisper" : "sherpa";
      return {
        icon: current.localModel ? localOrganization({ id: current.localModel, engine }) : "local",
        title: current.localModel ? lit(localSttModelName(current.localModel)) : choose,
        sub: msg("modelPicker.trigger.local"),
        warning,
      };
    }
    case "self-hosted": {
      const host = endpointHost(current.remoteUrl);
      return {
        icon: "selfHosted",
        title: current.remoteModel
          ? lit(current.remoteModel)
          : host
            ? msg("modelPicker.stt.trigger.serverDefault")
            : choose,
        sub: host
          ? msg("modelPicker.trigger.selfHosted", { host })
          : msg("modelPicker.selfHosted.title"),
        warning,
      };
    }
    case "enterprise":
      return {
        icon: "enterprise",
        title: msg("modelPicker.stt.enterprise.label"),
        sub: msg("modelPicker.enterprise.title"),
      };
    default: {
      if (current.cloudProvider === "custom") {
        const { connection } = ctx;
        const onConnection = connectionModelOf(connection, {
          provider: current.cloudProvider,
          model: current.cloudModel,
          url: current.cloudBaseUrl,
        });
        if (connection && onConnection) {
          return {
            icon: "connection",
            title: lit(onConnection),
            sub: connectionTrigger(connection),
            warning,
          };
        }
        const host = endpointHost(current.cloudBaseUrl);
        return {
          icon: "custom",
          title: current.cloudModel ? lit(current.cloudModel) : choose,
          sub: host ? msg("modelPicker.trigger.custom", { host }) : msg("modelPicker.custom.title"),
          warning,
        };
      }
      if (!current.cloudProvider) return { icon: "custom", title: choose, sub: lit("") };
      return {
        icon: current.cloudProvider,
        title: current.cloudModel
          ? lit(sttCloudModelName(current.cloudProvider, current.cloudModel))
          : choose,
        sub: msg("modelPicker.trigger.apiKey", {
          provider: sttProviderName(current.cloudProvider),
        }),
        warning,
      };
    }
  }
}

type LocalModelKeys = "whisperModel" | "parakeetModel" | "cohereModel";

function localModelFor(
  provider: string,
  models: Pick<SettingsState, LocalModelKeys> | Record<LocalModelKeys, string>
): string {
  if (provider === "nvidia") return models.parakeetModel;
  if (provider === "cohere") return models.cohereModel;
  return models.whisperModel;
}

/**
 * What a surface runs (everything but the mode), from policy-effective
 * settings, with live recording's and uploads' inherited values filled in
 * (selectResolvedMeetingTranscription / selectResolvedUploadTranscription).
 */
export function sttCurrentFrom(
  surface: SttSurface,
  effective: SettingsState
): Omit<SttCurrent, "mode"> {
  if (surface === "liveRecording") {
    const meeting = selectResolvedMeetingTranscription(effective);
    return {
      cloudProvider: meeting.cloudTranscriptionProvider,
      cloudModel: meeting.cloudTranscriptionModel,
      cloudBaseUrl: meeting.cloudTranscriptionBaseUrl,
      localProvider: meeting.localTranscriptionProvider,
      localModel: localModelFor(meeting.localTranscriptionProvider, meeting),
      remoteUrl: meeting.remoteTranscriptionUrl,
      remoteModel: "",
    };
  }
  if (surface === "fileTranscription") {
    const upload = selectResolvedUploadTranscription(effective);
    return {
      cloudProvider: upload.cloudTranscriptionProvider,
      cloudModel: upload.cloudTranscriptionModel,
      cloudBaseUrl: upload.cloudTranscriptionBaseUrl,
      localProvider: upload.localTranscriptionProvider,
      localModel: localModelFor(upload.localTranscriptionProvider, upload),
      remoteUrl: upload.remoteTranscriptionUrl,
      remoteModel: upload.remoteTranscriptionModel,
    };
  }
  return {
    cloudProvider: effective.cloudTranscriptionProvider,
    cloudModel: effective.cloudTranscriptionModel,
    cloudBaseUrl: effective.cloudTranscriptionBaseUrl || "",
    localProvider: effective.localTranscriptionProvider,
    localModel: localModelFor(effective.localTranscriptionProvider, effective),
    remoteUrl: effective.remoteTranscriptionUrl,
    remoteModel: effective.remoteTranscriptionModel,
  };
}

export type SttInheritField = "engine" | "provider" | "endpoint" | "model";

export interface SttFieldState {
  field: SttInheritField;
  value: PickerText;
  /** Borrowed from Recognition ("inherited"), the provider's default ("default"), or this surface's own. */
  source: "own" | "inherited" | "default";
}

/**
 * Live recording's and file transcription's fields while any of them borrows
 * Recognition's value (an empty own key, selectResolvedMeetingTranscription /
 * selectResolvedUploadTranscription), else null: in local mode the engine (the
 * surface's own) then the model (Recognition's, or the engine's default); in
 * providers mode the provider, the custom endpoint's host and the model. Uploads
 * never inherit a live-only dictation provider: they fall back to the default
 * provider and its default model instead, shown as "default". Takes
 * policy-effective settings and the mode shown; endpoints show their host only.
 * Nothing is written.
 */
export function sttInheritedFields(
  surface: SttSurface,
  settings: SettingsState,
  mode: InferenceMode | null
): SttFieldState[] | null {
  if (surface === "dictation") return null;
  const upload = surface === "fileTranscription";
  const own = upload
    ? {
        provider: settings.uploadCloudTranscriptionProvider,
        model: settings.uploadCloudTranscriptionModel,
        baseUrl: settings.uploadCloudTranscriptionBaseUrl,
        localProvider: settings.uploadLocalTranscriptionProvider,
        whisperModel: settings.uploadWhisperModel,
        parakeetModel: settings.uploadParakeetModel,
        cohereModel: settings.uploadCohereModel,
      }
    : {
        provider: settings.meetingCloudTranscriptionProvider,
        model: settings.meetingCloudTranscriptionModel,
        baseUrl: settings.meetingCloudTranscriptionBaseUrl,
        localProvider: settings.meetingLocalTranscriptionProvider,
        whisperModel: settings.meetingWhisperModel,
        parakeetModel: settings.meetingParakeetModel,
        cohereModel: settings.meetingCohereModel,
      };
  const resolved = sttCurrentFrom(surface, settings);
  // Uploads replace a live-only dictation provider with the default one, and drop its model.
  const defaulted = upload && STREAMING_ONLY_PROVIDERS.has(settings.cloudTranscriptionProvider);
  const sourceOf = (value: string, canDefault: boolean): SttFieldState["source"] =>
    value ? "own" : canDefault && defaulted ? "default" : "inherited";

  if (mode === "local") {
    const ownModel = localModelFor(own.localProvider, own);
    if (ownModel) return null;
    // The engine is always the surface's own (its local provider key); the
    // model is Recognition's, or the engine's default when neither has one.
    const engine = resolved.localProvider;
    const fallback = LOCAL_STT_DEFAULT_MODELS[engine];
    return [
      {
        field: "engine",
        value: msg("modelPicker.stt.inherit.localEngine", {
          engine: localSttEngineName(engine, resolved.localModel),
        }),
        source: "own",
      },
      {
        field: "model",
        value: resolved.localModel
          ? lit(localSttModelName(resolved.localModel))
          : fallback
            ? msg("modelPicker.stt.inherit.defaultModel", { model: localSttModelName(fallback) })
            : msg("modelPicker.stt.inherit.default"),
        source: resolved.localModel ? "inherited" : "default",
      },
    ];
  }
  if (mode !== "providers") return null;

  const custom = resolved.cloudProvider === "custom";
  if (own.provider && own.model && (!custom || own.baseUrl)) return null;

  const fields: SttFieldState[] = [
    {
      field: "provider",
      value: custom
        ? msg("modelPicker.custom.title")
        : resolved.cloudProvider
          ? lit(sttProviderName(resolved.cloudProvider))
          : msg("modelPicker.inherit.none"),
      source: sourceOf(own.provider, true),
    },
  ];
  if (custom) {
    const host = endpointHost(resolved.cloudBaseUrl);
    fields.push({
      field: "endpoint",
      value: host ? lit(host) : msg("modelPicker.inherit.none"),
      source: own.baseUrl ? "own" : "inherited",
    });
  }
  const modelSource = sourceOf(own.model, true);
  fields.push({
    field: "model",
    value: resolved.cloudModel
      ? lit(sttCloudModelName(resolved.cloudProvider, resolved.cloudModel))
      : msg("modelPicker.stt.inherit.default"),
    source: resolved.cloudModel ? modelSource : "default",
  });
  return fields;
}
