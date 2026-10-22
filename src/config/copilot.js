// GitHub Copilot as a language-model provider: its id, the scopes it may serve
// and the OAuth App it signs in with. Pure and dependency-free so main (via
// require), the renderer and the tests share one source.

export const COPILOT_PROVIDER_ID = "copilot";
export const COPILOT_PROVIDER_NAME = "GitHub Copilot";

// The GitHub OAuth App OpenWhispr signs in with (device flow, no secret):
// "OpenWhispr (personal)", owned by dshafran_microsoft. Client ids are public
// by design. GITHUB_COPILOT_CLIENT_ID overrides it.
export const COPILOT_OAUTH_CLIENT_ID = "Ov23lit7TiXbhtZtWgoq";

export const COPILOT_DEFAULT_MODEL = "claude-haiku-5.5";

// Copilot runs through the Copilot SDK's agent runtime, which can't take part
// in the renderer's tool loop, so it serves only plain text requests.
export const COPILOT_SUPPORTED_SCOPES = Object.freeze([
  "dictationCleanup",
  "noteFormatting",
  "dictationTranslation",
]);

// Why a request can't go to Copilot, or null when it can. A request without a
// scope is dictation cleanup, the default processText resolves it to.
export function copilotRequestRefusal({ scope, requiresAgent, hasImage } = {}) {
  if (requiresAgent) return "agent";
  if (hasImage) return "image";
  if (!COPILOT_SUPPORTED_SCOPES.includes(scope || "dictationCleanup")) return "scope";
  return null;
}

export const isCopilotScopeSupported = (scope) => COPILOT_SUPPORTED_SCOPES.includes(scope);
