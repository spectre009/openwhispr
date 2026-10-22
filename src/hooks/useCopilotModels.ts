import { useCallback, useEffect, useRef, useState } from "react";
import { getCopilotModels, type CloudModelDefinition } from "../models/ModelRegistry";
import { isCopilotListFresh, refreshCopilotModels } from "../models/copilotModels";
import { useCopilotStore } from "../stores/copilotStore";
import logger from "../utils/logger";

interface UseCopilotModelsResult {
  models: CloudModelDefinition[];
  loading: boolean;
  /** Set when the signed-in list couldn't be read; the last known list stays. */
  error: string | null;
  /** Asks main for a fresh list, past the hourly cache. */
  retry: () => Promise<void>;
}

/**
 * The GitHub Copilot models to offer: the signed-in plan's live list, or the
 * shipped list while signed out or offline. Pass `enabled` only while the user
 * is looking at Copilot — listing models starts the Copilot runtime.
 */
export function useCopilotModels(enabled: boolean): UseCopilotModelsResult {
  const signedIn = useCopilotStore((state) => state.status.state === "signedIn");
  // Initialised from the registry, which the Copilot store resets on sign-out.
  const [models, setModels] = useState<CloudModelDefinition[]>(() => getCopilotModels());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (force: boolean) => {
    const willFetch = force || !isCopilotListFresh();
    if (willFetch && isMountedRef.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const fresh = await refreshCopilotModels({ force });
      if (isMountedRef.current) {
        setModels(fresh);
        setError(null);
      }
    } catch (err) {
      logger.warn(
        "Failed to load GitHub Copilot models",
        { error: (err as Error)?.message, code: (err as { code?: string })?.code },
        "models"
      );
      if (isMountedRef.current) {
        setModels(getCopilotModels());
        setError((err as Error)?.message || "Unable to load models");
      }
    } finally {
      if (willFetch && isMountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!signedIn) {
      setModels(getCopilotModels());
      setError(null);
      return;
    }
    if (enabled) void load(false);
  }, [enabled, signedIn, load]);

  const retry = useCallback(() => load(true), [load]);

  return { models, loading, error, retry };
}
