import { COPILOT_PROVIDER_ID } from "../config/copilot.js";
import { copilotUnsupportedRequestError } from "./providerHttpErrors.js";

const CLOUD_CHAT_PROVIDERS = new Set([
  "openai",
  "groq",
  "gemini",
  "anthropic",
  "tinfoil",
  "custom",
  "openrouter",
  "corti",
]);

// Providers that answer plain-text requests only (GitHub Copilot: cleanup,
// note formatting, translation). A chat scope holding one fails closed rather
// than falling through to the local route below.
const NON_CHAT_PROVIDERS = new Set([COPILOT_PROVIDER_ID]);

export function isChatUnsupportedProvider(provider) {
  return NON_CHAT_PROVIDERS.has(provider);
}

/** Whether a Chat provider id runs on the local model server. */
export function isLocalChatProvider(provider, { isEnterpriseProvider = false } = {}) {
  return (
    !isEnterpriseProvider &&
    !CLOUD_CHAT_PROVIDERS.has(provider) &&
    !NON_CHAT_PROVIDERS.has(provider)
  );
}

// Resolve Chat from Chat-owned settings only. In particular, this must never
// consult Dictation Cleanup's mode or endpoint.
export function resolveChatRoute({ provider, lanUrl, customApiKey, isEnterpriseProvider = false }) {
  // An explicit self-hosted URL is the caller's declared route — it wins even
  // over a stale enterprise provider id left in settings.
  const baseUrl = lanUrl?.trim() || "";
  if (baseUrl) {
    return {
      kind: "self-hosted",
      baseUrl,
      apiKey: customApiKey?.trim() || "",
    };
  }

  if (isEnterpriseProvider) {
    return { kind: "enterprise", baseUrl: "", apiKey: "" };
  }

  if (NON_CHAT_PROVIDERS.has(provider)) {
    throw copilotUnsupportedRequestError("chat");
  }

  if (!CLOUD_CHAT_PROVIDERS.has(provider)) {
    return { kind: "local", baseUrl: "", apiKey: "" };
  }

  return { kind: "provider", baseUrl: "", apiKey: "" };
}
