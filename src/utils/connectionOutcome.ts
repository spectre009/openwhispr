import {
  featureForScope,
  llmOutcomeTarget,
  requestOutcomeOfFailure,
} from "../helpers/connectionOutcomeTargets.js";
import type { InferenceScope } from "../config/inferenceScopes";
import type { ConnectionOutcomeFeature } from "../types/electron";

/**
 * Settings › AI Connections' "Last recorded use", the renderer's reporters:
 * a real request says how it ended, once, at the provider boundary and after
 * its retries, to main's one writer (helpers/connectionOutcomes.js). Fire and
 * forget: nothing here waits, and nothing throws into the request.
 */

export interface LlmOutcomeRequest {
  /** The resolved provider id (`openai`, `custom`, `lan`, `openwhispr`, …). */
  provider: string | undefined;
  /** A custom endpoint's URL, as its feature's setting holds it. */
  baseUrl?: string;
  /** A self-hosted server's URL. */
  lanUrl?: string;
  /** Whose custom key slot the request reads (the screen context model's own). */
  scope?: InferenceScope | string;
  /** The feature that sent it; null records nothing. */
  feature: ConnectionOutcomeFeature | null;
  startedAt: number;
}

export type RequestResult = { ok: true } | { error: unknown };

/** The feature a language-model request records, from its scope unless it names one (Styles). */
export function llmOutcomeFeature(
  scope: string | undefined,
  explicit?: ConnectionOutcomeFeature
): ConnectionOutcomeFeature | null {
  return explicit ?? (featureForScope(scope) as ConnectionOutcomeFeature | null);
}

async function customSlot(scope: string | undefined): Promise<string | null> {
  if (!scope) return null;
  // Loaded only for a custom endpoint: the resolvers stage A reads its slots with.
  const [{ llmCustomEndpoint }, { getSettings }] = await Promise.all([
    import("../components/settings/connectionUsage"),
    import("../stores/settingsStore"),
  ]);
  return llmCustomEndpoint(scope as InferenceScope, getSettings())?.slot ?? null;
}

function report(
  target: { id: string; slot: string | null } | null,
  request: Pick<LlmOutcomeRequest, "feature" | "startedAt">,
  result: RequestResult
): void {
  if (!target || !request.feature) return;
  const outcome = "ok" in result ? { ok: true, code: "OK" } : requestOutcomeOfFailure(result.error);
  if (!outcome) return;
  window.electronAPI?.recordConnectionOutcome?.({
    descriptorId: target.id,
    slot: target.slot,
    feature: request.feature,
    ok: outcome.ok,
    code: outcome.code,
    startedAt: request.startedAt,
  });
}

/**
 * A language-model request ended: `{ ok: true }` when the provider answered
 * (whatever a check of its reply finds later), or `{ error }`. A cancel, a
 * yield, a missing key or a local check's failure records nothing.
 */
export function recordLlmOutcome(request: LlmOutcomeRequest, result: RequestResult): void {
  try {
    if (!request.feature || typeof window === "undefined") return;
    if (!("ok" in result) && !requestOutcomeOfFailure(result.error)) return;
    const resolve = async () => {
      const slot = request.provider === "custom" ? await customSlot(request.scope) : null;
      report(
        llmOutcomeTarget({
          provider: request.provider,
          baseUrl: request.baseUrl,
          lanUrl: request.lanUrl,
          slot,
        }),
        request,
        result
      );
    };
    resolve().catch(() => {});
  } catch {
    // The reply matters more than its record.
  }
}
