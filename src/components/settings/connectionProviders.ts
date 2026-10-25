import type { SettingsState } from "../../stores/settingsStore";

/**
 * The shared API-key providers Settings › AI Connections & Local Models shows
 * as cards or rows (connectionGroups.ts): one key per provider, read by every
 * feature that picks it (the per-feature custom and self-hosted endpoints are
 * listed separately, never here). React-free, so search, the usage module and
 * tests read it too.
 */

export type ConnectionProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "openrouter"
  | "mistral"
  | "tinfoil"
  | "corti"
  | "xai"
  | "deepgram"
  | "assemblyai";

/** Store fields holding a shared provider secret (hydrated by the get-*-key IPCs). */
export type ConnectionSecretKey = Extract<
  keyof SettingsState,
  | "openaiApiKey"
  | "anthropicApiKey"
  | "geminiApiKey"
  | "groqApiKey"
  | "openrouterApiKey"
  | "mistralApiKey"
  | "tinfoilApiKey"
  | "cortiApiKey"
  | "cortiClientId"
  | "cortiClientSecret"
  | "xaiApiKey"
  | "deepgramApiKey"
  | "assemblyaiApiKey"
>;

/** The store's debounced secret setter for each of those fields. */
export type ConnectionSecretSetter = Extract<
  keyof SettingsState,
  | "setOpenaiApiKey"
  | "setAnthropicApiKey"
  | "setGeminiApiKey"
  | "setGroqApiKey"
  | "setOpenrouterApiKey"
  | "setMistralApiKey"
  | "setTinfoilApiKey"
  | "setCortiApiKey"
  | "setCortiClientId"
  | "setCortiClientSecret"
  | "setXaiApiKey"
  | "setDeepgramApiKey"
  | "setAssemblyaiApiKey"
>;

export interface ConnectionCredential {
  key: ConnectionSecretKey;
  setter: ConnectionSecretSetter;
  /** A label when the card holds more than one credential (Corti). */
  labelKey?: string;
  /** What reads it: language models, speech-to-text, or both. */
  serves: "llm" | "transcription" | "both";
}

export interface ConnectionProviderDef {
  id: ConnectionProviderId;
  /** Brand name, never translated. */
  name: string;
  /** A first-run starter card; the rest sit behind "More providers" until one is saved. */
  common: boolean;
  /** Whether policy's language-model and speech-to-text BYOK lists can name it. */
  llm: boolean;
  transcription: boolean;
  credentials: readonly ConnectionCredential[];
  /** The provider's console, for "Get your API key". */
  keyUrl: string;
}

const single = (
  key: ConnectionSecretKey,
  setter: ConnectionSecretSetter,
  serves: ConnectionCredential["serves"]
): readonly ConnectionCredential[] => [{ key, setter, serves }];

export const CONNECTION_PROVIDERS: readonly ConnectionProviderDef[] = [
  {
    id: "openai",
    name: "OpenAI",
    common: true,
    llm: true,
    transcription: true,
    credentials: single("openaiApiKey", "setOpenaiApiKey", "both"),
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    common: true,
    llm: true,
    transcription: false,
    credentials: single("anthropicApiKey", "setAnthropicApiKey", "llm"),
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    common: true,
    llm: true,
    transcription: true,
    credentials: single("geminiApiKey", "setGeminiApiKey", "both"),
    keyUrl: "https://aistudio.google.com/app/api-keys",
  },
  {
    id: "groq",
    name: "Groq",
    common: true,
    llm: true,
    transcription: true,
    credentials: single("groqApiKey", "setGroqApiKey", "both"),
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    common: false,
    llm: true,
    transcription: false,
    credentials: single("openrouterApiKey", "setOpenrouterApiKey", "llm"),
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "mistral",
    name: "Mistral",
    common: false,
    llm: false,
    transcription: true,
    credentials: single("mistralApiKey", "setMistralApiKey", "transcription"),
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "tinfoil",
    name: "Tinfoil",
    common: false,
    llm: true,
    transcription: true,
    credentials: single("tinfoilApiKey", "setTinfoilApiKey", "both"),
    keyUrl: "https://tinfoil.sh/inference?utm_source=referral&utm_campaign=openwhispr",
  },
  {
    id: "corti",
    name: "Corti",
    common: false,
    llm: true,
    transcription: true,
    // Language models take an API key; speech-to-text signs in with client credentials.
    credentials: [
      {
        key: "cortiApiKey",
        setter: "setCortiApiKey",
        labelKey: "connections.credentials.languageModelKey",
        serves: "llm",
      },
      {
        key: "cortiClientId",
        setter: "setCortiClientId",
        labelKey: "transcription.corti.clientId",
        serves: "transcription",
      },
      {
        key: "cortiClientSecret",
        setter: "setCortiClientSecret",
        labelKey: "transcription.corti.clientSecret",
        serves: "transcription",
      },
    ],
    keyUrl: "https://www.corti.ai/?utm_source=referral&utm_campaign=openwhispr",
  },
  {
    id: "xai",
    name: "xAI",
    common: false,
    llm: false,
    transcription: true,
    credentials: single("xaiApiKey", "setXaiApiKey", "transcription"),
    keyUrl: "https://console.x.ai",
  },
  {
    id: "deepgram",
    name: "Deepgram",
    common: false,
    llm: false,
    transcription: true,
    credentials: single("deepgramApiKey", "setDeepgramApiKey", "transcription"),
    keyUrl: "https://console.deepgram.com/",
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    common: false,
    llm: false,
    transcription: true,
    credentials: single("assemblyaiApiKey", "setAssemblyaiApiKey", "transcription"),
    keyUrl: "https://www.assemblyai.com/dashboard/api-keys",
  },
];

const BY_ID = new Map<string, ConnectionProviderDef>(
  CONNECTION_PROVIDERS.map((provider) => [provider.id, provider])
);

export function findConnectionProvider(id: string | undefined): ConnectionProviderDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** A connection's search anchor and destination id, on its card or row ("connections.openai"). */
export function connectionAnchor(id: ConnectionProviderId | "copilot" | "cloud"): string {
  return `connections.${id}`;
}

/** The page destination that opens a connection's card or row ("connections#connections.openai"). */
export function connectionDestination(id: ConnectionProviderId | "copilot" | "cloud"): string {
  return `connections#${connectionAnchor(id)}`;
}

/** True when any of the provider's credentials is saved. Reads presence only. */
export function hasSavedCredential(
  provider: ConnectionProviderDef,
  settings: Pick<SettingsState, ConnectionSecretKey>
): boolean {
  return provider.credentials.some((credential) => !!settings[credential.key]?.trim());
}
