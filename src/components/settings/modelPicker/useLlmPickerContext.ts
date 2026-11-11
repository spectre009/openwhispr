import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../../../stores/settingsStore";
import { usePolicyStore } from "../../../stores/policyStore";
import { usePolicySnapshot } from "../../../hooks/usePolicy";
import {
  isOpenWhisprCloudDisabled,
  useOpenWhisprCloudDisabled,
} from "../../../stores/openWhisprCloudStore";
import { syncCopilotAuthStatus, useCopilotStore } from "../../../stores/copilotStore";
import { useManagedScopeResolution } from "../../../stores/enterpriseIdentityStore";
import { useCopilotModels } from "../../../hooks/useCopilotModels";
import { useTinfoilModels } from "../../../hooks/useTinfoilModels";
import { LOCAL_MODELS_CHANGED_EVENT } from "../../../hooks/useModelDownload";
import { useRegistryVersion } from "../../../hooks/useRegistryVersion";
import { isCopilotScopeSupported } from "../../../config/copilot";
import type { InferenceScope } from "../../../config/inferenceScopes";
import type { InferenceMode, LocalLLMModelStatus } from "../../../types/electron";
import { useSettingsVisible } from "../useSettingsVisible";
import { pickerConnection } from "./connectionOptions";
import { useConnectionCatalog, usePickerConnection } from "./usePickerConnection";
import {
  offeredModes,
  savedKeyPresence,
  type ModelPickerContext,
  type PickerLocalModel,
} from "./options";

interface UseLlmPickerContextOptions {
  allowedModes?: readonly InferenceMode[];
  current: ModelPickerContext["current"];
  /** The picker's menu is open: live model lists load only while someone is looking. */
  open: boolean;
}

export interface LlmPickerContextResult {
  context: ModelPickerContext;
  /** The context as the stores hold it right now, for revalidating a pick at commit. */
  readContext: () => ModelPickerContext;
  /** A managed deployment exists for this scope (as if the setup mode were managed). */
  managedAvailable: boolean;
  copilotModels: { loading: boolean; error: string | null; retry: () => Promise<void> };
  tinfoilModels: { loading: boolean; error: string | null };
}

function downloadedModels(result: unknown): PickerLocalModel[] | null {
  if (!Array.isArray(result)) return null;
  return (result as LocalLLMModelStatus[])
    .filter((model) => model?.isDownloaded && typeof model.id === "string")
    .map((model) => ({ id: model.id, name: model.name, size: model.size }));
}

/**
 * Everything the language-model picker needs to build its options, from the
 * same sources the editor used: the policy snapshot, the Cloud switch and
 * sign-in, saved key presence (never a key), the Copilot sign-in and its live
 * model list, Tinfoil's live list, downloaded local models, the managed
 * enterprise deployment and the custom connection (key presence only; who
 * runs which of its models, and an OpenAI-compatible one's `/models` list,
 * while the menu is open). Copilot's and Tinfoil's lists load only while the
 * menu is open (listing Copilot's starts its runtime), as their tabs did.
 */
export function useLlmPickerContext(
  scope: InferenceScope,
  { allowedModes, current, open }: UseLlmPickerContextOptions
): LlmPickerContextResult {
  const policy = usePolicySnapshot();
  const cloudDisabled = useOpenWhisprCloudDisabled();
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const keys = useSettingsStore(useShallow(savedKeyPresence));
  const enterpriseSetupMode = useSettingsStore((s) => s.enterpriseSetupMode);
  const managedResolution = useManagedScopeResolution(scope, "managed");
  const visible = useSettingsVisible();
  const registryVersion = useRegistryVersion();

  const copilotSupported = isCopilotScopeSupported(scope);
  const copilotStatus = useCopilotStore((state) => state.status);
  const copilotLoaded = useCopilotStore((state) => state.loaded);
  const copilotSignedIn = copilotStatus.state === "signedIn";
  // Still being read from main (or mid sign-in): neither offered nor flagged as signed out.
  const copilotChecking =
    !copilotSignedIn &&
    (!copilotLoaded || copilotStatus.state === "checking" || copilotStatus.state === "waiting");
  useEffect(() => {
    if (copilotSupported) void syncCopilotAuthStatus();
  }, [copilotSupported]);
  const copilot = useCopilotModels(open && copilotSupported && copilotSignedIn);
  const tinfoil = useTinfoilModels(open && keys.tinfoil);

  const offersLocal = useMemo(
    () => offeredModes(scope, { policy, allowedModes }).has("local"),
    [scope, policy, allowedModes]
  );
  const [localModels, setLocalModels] = useState<PickerLocalModel[]>([]);
  const loadLocalModels = useCallback(async () => {
    try {
      const models = downloadedModels(await window.electronAPI?.modelGetAll?.());
      if (models) setLocalModels(models);
    } catch {
      // The last list stays.
    }
  }, []);
  // Disk can change while Settings is closed or the menu is shut: re-read on both.
  useEffect(() => {
    if (offersLocal && visible) void loadLocalModels();
  }, [offersLocal, visible, loadLocalModels]);
  useEffect(() => {
    if (offersLocal && open) void loadLocalModels();
  }, [offersLocal, open, loadLocalModels]);
  useEffect(() => {
    if (!offersLocal) return;
    const reload = () => void loadLocalModels();
    window.addEventListener(LOCAL_MODELS_CHANGED_EVENT, reload);
    window.addEventListener("openwhispr-models-cleared", reload);
    return () => {
      window.removeEventListener(LOCAL_MODELS_CHANGED_EVENT, reload);
      window.removeEventListener("openwhispr-models-cleared", reload);
    };
  }, [offersLocal, loadLocalModels]);

  const managedAvailable = managedResolution.kind === "managed";
  const managedProvider = managedAvailable ? managedResolution.provider : "";
  const managedModel = managedAvailable ? managedResolution.model : "";

  const custom = usePickerConnection(open, policy, cloudDisabled);
  const catalog = useConnectionCatalog(open, custom.connection);
  const connection = useMemo(() => {
    const base = pickerConnection(custom.connection, {
      capability: "language",
      hasKey: custom.hasKey,
      uses: custom.uses,
    });
    return base ? { ...base, catalog } : null;
  }, [custom.connection, custom.hasKey, custom.uses, catalog]);

  const context = useMemo<ModelPickerContext>(
    () => ({
      policy,
      cloudDisabled,
      isSignedIn,
      allowedModes,
      keys,
      copilot: {
        signedIn: copilotSignedIn,
        checking: copilotChecking,
        login: copilotStatus.login,
        models: copilot.models.map((model) => ({ id: model.id, name: model.name })),
      },
      tinfoilModels: tinfoil.models.map((model) => ({ id: model.id, name: model.name })),
      localModels,
      current,
      managedDeployment:
        enterpriseSetupMode === "manual" && managedProvider
          ? { provider: managedProvider, model: managedModel }
          : null,
      connection,
      registryVersion,
    }),
    [
      policy,
      cloudDisabled,
      isSignedIn,
      allowedModes,
      keys,
      copilotSignedIn,
      copilotChecking,
      copilotStatus.login,
      copilot.models,
      tinfoil.models,
      localModels,
      current,
      enterpriseSetupMode,
      managedProvider,
      managedModel,
      connection,
      registryVersion,
    ]
  );

  const latest = useRef(context);
  useEffect(() => {
    latest.current = context;
  }, [context]);

  const readContext = useCallback((): ModelPickerContext => {
    const base = latest.current;
    const settings = useSettingsStore.getState();
    const { status, policy: orgPolicy, appVersion } = usePolicyStore.getState();
    const { status: copilotNow, loaded: copilotLoadedNow } = useCopilotStore.getState();
    const signedInNow = copilotNow.state === "signedIn";
    return {
      ...base,
      policy: { status, policy: orgPolicy, appVersion },
      cloudDisabled: isOpenWhisprCloudDisabled(),
      isSignedIn: settings.isSignedIn,
      keys: savedKeyPresence(settings),
      copilot: {
        ...base.copilot,
        signedIn: signedInNow,
        checking:
          !signedInNow &&
          (!copilotLoadedNow || copilotNow.state === "checking" || copilotNow.state === "waiting"),
        login: copilotNow.login,
      },
      // The stored connection and its key as they are now; a pick's model needn't be listed.
      connection: pickerConnection(settings.customConnection, {
        capability: "language",
        hasKey: !!settings.customConnectionApiKey?.trim(),
      }),
    };
  }, []);

  return {
    context,
    readContext,
    managedAvailable,
    copilotModels: { loading: copilot.loading, error: copilot.error, retry: copilot.retry },
    tinfoilModels: { loading: tinfoil.loading, error: tinfoil.error },
  };
}
