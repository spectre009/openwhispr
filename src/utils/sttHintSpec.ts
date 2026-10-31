// Which speech-to-text hint route (sttHintFields.js) the current settings
// send their dictionary on, mapped exactly as History's Re-transcribe maps the
// resolved route in main (ipcHandlers.js, retry-transcription): managed Azure,
// then a self-hosted server, then local (Whisper, or nothing for sherpa), then
// OpenWhispr Cloud, then the provider's own channel. The Dictionary page reads
// coverage and the cut line off buildSttHintFields for this spec, so what it
// calls sent is what a request carries. Streaming dictation (Deepgram,
// AssemblyAI, Corti's live socket) builds its own keyterm list and isn't
// described here; a streaming-only provider has no batch route and maps to
// "none", as Re-transcribe does. Pure: no stores.

import {
  resolveTranscriptionRoute,
  type ManagedTranscriptionResolution,
  type TranscriptionRoute,
  type TranscriptionRouteSettings,
} from "../helpers/transcriptionRoute";
import type { TranscriptionProviderBaseUrl } from "../services/transcriptionBaseUrl";

export type SttHintRoute =
  | "openai-compatible"
  | "azure-speech"
  | "mistral"
  | "gemini"
  | "xai"
  | "tinfoil"
  | "managed"
  | "cloud"
  | "local-whisper"
  | "none";

export interface SttHintSpec {
  route: SttHintRoute;
  provider?: string;
  endpoint?: string;
  model?: string;
}

export interface SttHintSettings extends TranscriptionRouteSettings {
  cloudTranscriptionMode?: string;
  localTranscriptionProvider?: string;
}

const isSherpaLocalProvider = (provider: string | undefined) =>
  provider === "nvidia" || provider === "cohere";

/** The hint route a resolved transcription route sends on, in Re-transcribe's branch order. */
export function sttHintSpecForRoute(
  route: TranscriptionRoute,
  settings: SttHintSettings
): SttHintSpec {
  const provider = settings.cloudTranscriptionProvider || "openai";
  if (route.transport === "managed") return { route: "managed" };
  if (route.transport === "http-batch" && route.provider === "self-hosted") {
    return {
      route: "openai-compatible",
      provider,
      endpoint: route.endpoint,
      model: route.model ?? "",
    };
  }
  if (route.transport === "error") {
    // Fatal unless OpenWhispr Cloud is selected (and not self-hosted).
    return settings.transcriptionMode !== "self-hosted" &&
      settings.cloudTranscriptionMode === "openwhispr"
      ? { route: "cloud" }
      : { route: "none" };
  }
  if (route.transport === "local") {
    return {
      route: isSherpaLocalProvider(settings.localTranscriptionProvider) ? "none" : "local-whisper",
    };
  }
  if (settings.cloudTranscriptionMode === "openwhispr") return { route: "cloud" };
  if (route.transport === "proxied") {
    if (route.provider === "corti") return { route: "none" };
    return { route: route.provider };
  }
  if (route.transport === "azure-speech") return { route: "azure-speech" };
  return {
    route: "openai-compatible",
    provider,
    endpoint: route.endpoint,
    model: route.model ?? "",
  };
}

/**
 * The hint route for policy-effective settings: the transcription route as
 * Re-transcribe resolves it (no policy floor; a managed resolution outranks
 * every personal setting, a managed error sends nothing).
 */
export function resolveSttHintSpec({
  settings,
  managed,
  providers = [],
}: {
  settings: SttHintSettings;
  managed?: ManagedTranscriptionResolution | null;
  providers?: readonly TranscriptionProviderBaseUrl[];
}): SttHintSpec {
  if (managed?.kind === "error") return { route: "none" };
  const route = resolveTranscriptionRoute({
    settings: settings || {},
    providers,
    managed: managed ?? undefined,
    request: { effectiveLanguage: "auto" },
  });
  return sttHintSpecForRoute(route, settings || {});
}
