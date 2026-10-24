import {
  mergeConnectionModels,
  rewrittenEndpointUrl,
  usesConnectionEndpoint,
  validateEndpoint,
  type ConnectionUse,
  type CustomConnection,
  type ValidatedEndpoint,
} from "../../../config/customConnection";
import type { InferenceScope } from "../../../config/inferenceScopes";
import { isOrukeetEndpoint, isOrukeetStreaming } from "../../../helpers/selfHostedTranscription.js";
import {
  selectPolicyEffectiveSettings,
  selectResolvedUploadTranscription,
  type SettingsState,
} from "../../../stores/settingsStore";
import type { PolicyDecisionSnapshot } from "../../../stores/policyRules";
import {
  USAGE_FEATURE_TITLE_KEYS,
  computeConnectionUsage,
  type UsageFeature,
} from "../connectionUsage";
import type { PickerText, PickerUnavailable } from "./options";
import type { SttSurface } from "./sttOptions";

/**
 * The custom connection (config/customConnection.js) in the model pickers: a
 * group named after it, listing its models for the picker's capability and
 * "Enter a deployment name…". A pick writes what a hand-entered custom
 * endpoint with the same URL, model and key writes (selectLlm.ts,
 * selectStt.ts). Pure (no React, no store reads).
 */

export type ConnectionCapability = "language" | "speech";

export interface PickerConnectionModel {
  id: string;
  /** The features running this model on the connection. */
  usedBy: readonly UsageFeature[];
}

/** The connection as a picker lists it; its key by presence only. */
export interface PickerConnection {
  name: string;
  /** As stored: an Azure resource origin, or an OpenAI-compatible base. */
  endpoint: string;
  kind: ValidatedEndpoint["kind"];
  hasKey: boolean;
  /** Remembered for this capability, then those its features use, without repeats. */
  models: readonly PickerConnectionModel[];
}

export const CONNECTION_GROUP_ID = "connection";
export const CONNECTION_ENTER_ID = "connection:enter";
export const connectionOptionId = (model: string) => `connection:model:${model}`;

/** The feature each picker picks for, as "Used by" names it. */
export const SCOPE_USAGE_FEATURES: Readonly<Record<InferenceScope, UsageFeature>> = {
  dictationCleanup: "cleanup",
  dictationAgent: "assistant",
  dictationAgentVision: "assistantVision",
  dictationTranslation: "translation",
  noteFormatting: "noteFormatting",
  chatIntelligence: "chat",
};

export const SURFACE_USAGE_FEATURES: Readonly<Record<SttSurface, UsageFeature>> = {
  dictation: "recognition",
  liveRecording: "liveRecording",
  fileTranscription: "fileTranscription",
};

/**
 * The connection for one capability's picker, or null when there is none (or
 * its stored endpoint isn't one it can take). `uses` are its features
 * (`featuresUsingConnection`); their models join the remembered ones.
 */
export function pickerConnection(
  connection: CustomConnection | null | undefined,
  {
    capability,
    hasKey,
    uses = [],
  }: { capability: ConnectionCapability; hasKey: boolean; uses?: readonly ConnectionUse[] }
): PickerConnection | null {
  if (!connection) return null;
  const validated = validateEndpoint(connection.endpoint);
  if (!validated.ok) return null;
  const usedBy = new Map<string, UsageFeature[]>();
  const inUse: Array<{ name: string; capability: ConnectionCapability }> = [];
  for (const use of uses) {
    const model = use.model?.trim();
    if (use.capability !== capability || !model) continue;
    const features = usedBy.get(model) ?? [];
    if (!features.includes(use.feature)) features.push(use.feature);
    usedBy.set(model, features);
    inUse.push({ name: model, capability });
  }
  const names = mergeConnectionModels(connection.models, inUse)[capability];
  return {
    name: connection.name,
    endpoint: connection.endpoint,
    kind: validated.kind,
    hasKey,
    models: names.map((id) => ({ id, usedBy: usedBy.get(id) ?? [] })),
  };
}

/** The model a feature runs on the connection: its custom URL points there. "" otherwise. */
export function connectionModelOf(
  connection: Pick<PickerConnection, "endpoint"> | null | undefined,
  { provider, model, url }: { provider: string; model: string; url: string | undefined }
): string {
  if (!connection || provider !== "custom" || !model) return "";
  return usesConnectionEndpoint(url, connection) ? model : "";
}

/** The group's entries: its models, the feature's own, then a live list's, without repeats. */
export function connectionModelList(
  connection: PickerConnection,
  current: string,
  catalog: readonly string[] = []
): PickerConnectionModel[] {
  const list = [...connection.models];
  for (const id of [current, ...catalog]) {
    if (id && !list.some((entry) => entry.id === id)) list.push({ id, usedBy: [] });
  }
  return list;
}

const msg = (key: string, params?: Record<string, string>): PickerText =>
  params ? { key, params } : { key };

/** The kind badge beside the group's name: "Azure OpenAI" or "OpenAI-compatible". */
export function connectionBadge(connection: Pick<PickerConnection, "kind">): {
  text: PickerText;
  tone: "accent" | "muted";
} {
  const azure = connection.kind === "azure";
  return {
    text: msg(
      azure ? "connections.custom.kinds.azure" : "connections.custom.kinds.openaiCompatible"
    ),
    tone: azure ? "accent" : "muted",
  };
}

/** Words the filter field finds the connection's entries by. */
export function connectionTerms(connection: Pick<PickerConnection, "name" | "kind">): string[] {
  return [
    connection.name,
    "connection",
    ...(connection.kind === "azure" ? ["azure", "foundry"] : ["openai compatible"]),
  ];
}

/** The button's second line for a feature on the connection: "Little Buddy · Azure OpenAI". */
export function connectionTrigger(connection: PickerConnection): PickerText {
  return msg(
    connection.kind === "azure"
      ? "modelPicker.connection.trigger.azure"
      : "modelPicker.connection.trigger.compatible",
    { name: connection.name }
  );
}

export function connectionEnterLabel(kind: PickerConnection["kind"]): PickerText {
  return msg(
    kind === "azure"
      ? "modelPicker.connection.enterDeployment"
      : "modelPicker.connection.enterModel"
  );
}

/** "Used by Chat" under a model another feature runs on the connection. */
export function connectionUsedBy(
  usedBy: readonly UsageFeature[],
  self: UsageFeature
): PickerText | undefined {
  const others = usedBy.filter((feature) => feature !== self);
  if (others.length === 0) return undefined;
  return {
    key:
      others.length === 1 ? "modelPicker.connection.usedBy" : "modelPicker.connection.usedByMore",
    paramKeys: { feature: USAGE_FEATURE_TITLE_KEYS[others[0]] },
  };
}

/** The connection has no key to give the feature: add one on its card. */
export const CONNECTION_NO_KEY: PickerUnavailable = {
  reasonKey: "modelPicker.reasons.noKey",
  link: {
    kind: "settings",
    destination: "connections#connections.custom",
    labelKey: "modelPicker.links.addKey",
  },
};

/** Main couldn't copy the connection's key into the feature's slot; nothing was written. */
export function connectionKeyFailed(name: string): PickerUnavailable {
  return { reasonKey: "modelPicker.connection.reasons.keyFailed", reasonParams: { name } };
}

/** Speech-to-text's one key would change under another feature still using it elsewhere. */
export function connectionSharedKeyConflict(feature: UsageFeature): PickerUnavailable {
  return {
    reasonKey: "modelPicker.connection.reasons.sharedKey",
    reasonParamKeys: { feature: USAGE_FEATURE_TITLE_KEYS[feature] },
  };
}

// ── Speech-to-text ───────────────────────────────────────────────────────────

/** What a custom pick writes on each surface that has a custom lane (selectStt.ts). */
const STT_PICK_FIELDS = {
  dictation: {
    mode: "transcriptionMode",
    cloudMode: "cloudTranscriptionMode",
    provider: "cloudTranscriptionProvider",
    model: "cloudTranscriptionModel",
    url: "cloudTranscriptionBaseUrl",
  },
  fileTranscription: {
    mode: "uploadTranscriptionMode",
    cloudMode: "uploadCloudTranscriptionMode",
    provider: "uploadCloudTranscriptionProvider",
    model: "uploadCloudTranscriptionModel",
    url: "uploadCloudTranscriptionBaseUrl",
  },
} as const satisfies Partial<Record<SttSurface, Record<string, keyof SettingsState>>>;

/**
 * Speech-to-text has one custom key (CUSTOM_TRANSCRIPTION_API_KEY), sent by
 * every surface's custom endpoint and by a self-hosted Orukeet server that
 * authenticates. The feature that would still send it somewhere other than the
 * connection once `surface` is on it, or null: Recognition's or File
 * Transcription's custom endpoint (its own URL, or Recognition's it borrows),
 * or their self-hosted server when it sends the key (`isOrukeetEndpoint`, and
 * Recognition's Orukeet streaming). Live Recording has no custom lane and
 * never sends it.
 */
export function sttSharedKeyConflict(
  surface: SttSurface,
  settings: SettingsState,
  policy: PolicyDecisionSnapshot,
  connection: CustomConnection | null | undefined
): UsageFeature | null {
  if (surface === "liveRecording" || !connection) return null;
  const target = validateEndpoint(connection.endpoint);
  if (!target.ok) return null;
  const fields = STT_PICK_FIELDS[surface];
  // The store as the pick leaves it (the model aside: Orukeet is opted into by the server's).
  const after = {
    ...settings,
    [fields.mode]: "providers",
    [fields.cloudMode]: "byok",
    [fields.provider]: "custom",
    [fields.model]: "",
    [fields.url]: target.speechBase,
  } as SettingsState;
  const elsewhere = (url: unknown) => !usesConnectionEndpoint(url, connection);

  const usages = computeConnectionUsage({
    settings: after,
    policy,
    cloudDisabled: false,
    stylesInUse: false,
  });
  for (const usage of usages) {
    if (usage.feature !== "recognition" && usage.feature !== "fileTranscription") continue;
    const source = usage.customEndpoint;
    if (usage.connection.type !== "custom" || source?.slot !== "CUSTOM_TRANSCRIPTION_API_KEY") {
      continue;
    }
    if (elsewhere(after[source.urlField])) return usage.feature;
  }

  const effective = selectPolicyEffectiveSettings(after, policy);
  const servers = [
    ["recognition", effective, true],
    ["fileTranscription", selectResolvedUploadTranscription(effective), false],
  ] as const;
  for (const [feature, resolved, streams] of servers) {
    const remote = String(resolved.remoteTranscriptionUrl ?? "").trim();
    if (!remote || !isOrukeetEndpoint(resolved)) continue;
    const sends =
      resolved.transcriptionMode === "self-hosted" || (streams && isOrukeetStreaming(resolved));
    if (sends && elsewhere(remote)) return feature;
  }
  return null;
}

// An Azure operation URL that names its deployment, which then wins over the model.
const PINNED_DEPLOYMENT =
  /\/openai\/deployments\/([^/]+)\/audio\/(?:transcriptions|translations)$/i;

/**
 * The URL a speech-to-text pick on the connection writes: the connection's
 * speech base, or the surface's pasted Azure operation URL when it's already on
 * the connection (`rewrittenEndpointUrl`), unless that URL names another
 * deployment than the model picked.
 */
export function connectionSpeechUrl(
  current: string,
  model: string,
  connection: Pick<CustomConnection, "endpoint">
): string {
  const target = validateEndpoint(connection.endpoint);
  if (!target.ok) return "";
  if (!usesConnectionEndpoint(current, connection)) return target.speechBase;
  const url = rewrittenEndpointUrl(current, "speech", target);
  if (url === target.speechBase) return url;
  try {
    const pinned = PINNED_DEPLOYMENT.exec(new URL(url).pathname.replace(/\/+$/, ""));
    if (pinned && decodeURIComponent(pinned[1]) !== model) return target.speechBase;
  } catch {
    return target.speechBase;
  }
  return url;
}
