import { useEffect, useMemo, useState } from "react";
import {
  featuresUsingConnection,
  validateEndpoint,
  type ConnectionUse,
  type CustomConnection,
} from "../../../config/customConnection";
import type { PolicyDecisionSnapshot } from "../../../stores/policyRules";
import { useSettingsStore, type SettingsState } from "../../../stores/settingsStore";
import { fetchOpenAiCompatibleModels } from "../../../utils/openAiCompatibleModels";
import { computeConnectionUsage } from "../connectionUsage";
import type { PickerConnectionCatalog } from "./options";

const NO_USES: readonly ConnectionUse[] = [];

export interface PickerConnectionState {
  connection: CustomConnection | null;
  /** The connection has a key (presence only). */
  hasKey: boolean;
  /** The features running on it, read while the menu is open ("Used by"'s derivation). */
  uses: readonly ConnectionUse[];
  /** The whole store while the menu is open and there is a connection, else null. */
  openState: SettingsState | null;
}

/**
 * The custom connection for a model picker: the stored setting, whether it
 * has a key, and, while the menu is open, which features run on it, derived
 * from the whole store the way AI Connections derives "Used by".
 */
export function usePickerConnection(
  open: boolean,
  policy: PolicyDecisionSnapshot,
  cloudDisabled: boolean
): PickerConnectionState {
  const connection = useSettingsStore((s) => s.customConnection);
  const hasKey = useSettingsStore((s) => !!s.customConnectionApiKey?.trim());
  const openState = useSettingsStore((s) => (open && s.customConnection ? s : null));
  const uses = useMemo(
    () =>
      openState
        ? featuresUsingConnection(
            computeConnectionUsage({
              settings: openState,
              policy,
              cloudDisabled,
              stylesInUse: false,
            }),
            openState.customConnection,
            openState
          )
        : NO_USES,
    [openState, policy, cloudDisabled]
  );
  return { connection, hasKey, uses, openState };
}

/**
 * An OpenAI-compatible connection's own `{languageBase}/models` list, read
 * while the menu is open with the code the custom endpoint's fields use.
 * Never Azure's: its v1 list is the region's whole catalog, not the
 * resource's deployments.
 */
export function useConnectionCatalog(
  open: boolean,
  connection: CustomConnection | null
): PickerConnectionCatalog | null {
  const key = useSettingsStore((s) => s.customConnectionApiKey);
  const validated = connection ? validateEndpoint(connection.endpoint) : null;
  const base = validated?.ok && validated.kind !== "azure" ? validated.languageBase : "";
  const [loaded, setLoaded] = useState<{ base: string; catalog: PickerConnectionCatalog } | null>(
    null
  );
  useEffect(() => {
    if (!open || !base) return;
    let cancelled = false;
    setLoaded((previous) => ({
      base,
      catalog: {
        status: "loading",
        models: previous?.base === base ? previous.catalog.models : [],
      },
    }));
    fetchOpenAiCompatibleModels(base, {
      apiKey: key?.trim() || undefined,
      describeOwner: (owner) => owner,
    })
      .then((models) => {
        if (cancelled) return;
        setLoaded({
          base,
          catalog: { status: "ready", models: models.map((model) => model.value) },
        });
      })
      .catch(() => {
        // The reason stays out of the menu: a server's error body is not ours to show.
        if (!cancelled) setLoaded({ base, catalog: { status: "error", models: [] } });
      });
    return () => {
      cancelled = true;
    };
  }, [open, base, key]);
  return base && loaded?.base === base ? loaded.catalog : null;
}
