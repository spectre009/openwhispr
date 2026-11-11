import { buildApiUrl } from "../config/constants";

export interface OpenAiCompatibleModel {
  value: string;
  label: string;
  description?: string;
  ownedBy?: string;
  /** Set only when `isEligible` was given: whether the caller's feature can use it. */
  eligibleForScope?: boolean;
}

/**
 * An OpenAI-compatible endpoint's `{base}/models` list (its `data`, or
 * `models`). A key, when given, goes as a bearer token. An answer that isn't OK
 * throws with its status and the start of its body. `isEligible` reads each
 * raw catalog entry (OpenRouter's `supported_parameters`, for one).
 */
export async function fetchOpenAiCompatibleModels(
  base: string,
  {
    apiKey,
    describeOwner,
    isEligible,
  }: {
    apiKey?: string;
    describeOwner: (owner: string) => string;
    isEligible?: (item: Record<string, unknown>) => boolean;
  }
): Promise<OpenAiCompatibleModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(buildApiUrl(base, "/models"), { method: "GET", headers });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const summary = errorText
      ? `${response.status} ${errorText.slice(0, 200)}`
      : `${response.status} ${response.statusText}`;
    throw new Error(summary.trim());
  }

  const payload = await response.json().catch(() => ({}));
  const rawModels = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];

  // Coerce fields defensively: non-conformant endpoints may return
  // numeric ids or object descriptions, which would crash the render.
  return (rawModels as Array<Record<string, unknown>>)
    .map((item) => {
      const rawValue = item?.id ?? item?.name;
      if (rawValue === undefined || rawValue === null || rawValue === "") return null;
      const value = String(rawValue);
      const ownedBy = typeof item?.owned_by === "string" ? item.owned_by : undefined;
      const description =
        typeof item?.description === "string" && item.description
          ? item.description
          : ownedBy
            ? describeOwner(ownedBy)
            : undefined;
      return {
        value,
        label: value,
        description,
        ownedBy,
        ...(isEligible ? { eligibleForScope: isEligible(item) } : {}),
      } as OpenAiCompatibleModel;
    })
    .filter(Boolean) as OpenAiCompatibleModel[];
}
