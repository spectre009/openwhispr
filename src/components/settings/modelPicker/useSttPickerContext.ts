import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  selectPolicyEffectiveSettings,
  useSettingsStore,
  type SettingsState,
} from "../../../stores/settingsStore";
import { usePolicyStore } from "../../../stores/policyStore";
import {
  getManagedScopeResolution,
  useManagedScopeResolution,
} from "../../../stores/enterpriseIdentityStore";
import { usePolicySnapshot } from "../../../hooks/usePolicy";
import {
  isOpenWhisprCloudDisabled,
  useOpenWhisprCloudDisabled,
} from "../../../stores/openWhisprCloudStore";
import { LOCAL_MODELS_CHANGED_EVENT } from "../../../hooks/useModelDownload";
import { WHISPER_MODEL_INFO, PARAKEET_MODEL_INFO } from "../../../models/ModelRegistry";
import type { InferenceMode } from "../../../types/electron";
import { formatBytes } from "../../../utils/formatBytes";
import { useSettingsVisible } from "../useSettingsVisible";
import { pickerConnection, sttSharedKeyConflict } from "./connectionOptions";
import { compareSharedSttKey } from "./connectionPick";
import { usePickerConnection } from "./usePickerConnection";
import {
  STT_SURFACE_CONTEXT,
  sttCurrentFrom,
  sttEffectiveMode,
  sttKeyPresence,
  sttSurfaceOffersCustom,
  type SttLocalModel,
  type SttPickerConnection,
  type SttPickerContext,
  type SttSurface,
} from "./sttOptions";

/** Each surface's stored mode key. */
export const STT_MODE_KEY = {
  dictation: "transcriptionMode",
  liveRecording: "meetingTranscriptionMode",
  fileTranscription: "uploadTranscriptionMode",
} as const satisfies Record<SttSurface, keyof SettingsState>;

/** The operation a surface's managed transcription runs: Live Recording streams. */
const managedOperation = (surface: SttSurface) =>
  surface === "liveRecording" ? ("realtime" as const) : ("batch" as const);

/** Whether the organization's managed transcription would answer this surface if picked. */
export function useSttManagedAvailable(surface: SttSurface): boolean {
  return (
    useManagedScopeResolution("transcription", "managed", managedOperation(surface)).kind ===
    "managed"
  );
}

/**
 * The organization's managed transcription for a surface under the setup mode
 * dictation, live recording and uploads share (#2989): Live Recording resolves
 * the realtime deployment, the others the batch one.
 */
export function useSttManagedResolution(surface: SttSurface) {
  const setupMode = useSettingsStore((s) => s.enterpriseTranscriptionSetupMode);
  return useManagedScopeResolution("transcription", setupMode, managedOperation(surface));
}

/** The mode a surface's editor shows (policy-effective, as its mode cards reconciled it). */
export function useSttEffectiveMode(surface: SttSurface): InferenceMode | null {
  const policy = usePolicySnapshot();
  const cloudDisabled = useOpenWhisprCloudDisabled();
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const storedMode = useSettingsStore((s) => s[STT_MODE_KEY[surface]]);
  const managedAvailable = useSttManagedAvailable(surface);
  return useMemo(
    () =>
      sttEffectiveMode(surface, storedMode, {
        policy,
        cloudDisabled,
        isSignedIn,
        managedAvailable,
      }),
    [surface, storedMode, policy, cloudDisabled, isSignedIn, managedAvailable]
  );
}

interface LocalLists {
  whisper: SttLocalModel[] | null;
  sherpa: SttLocalModel[] | null;
}

function whisperModels(result: unknown): SttLocalModel[] | null {
  const models = (result as { success?: boolean; models?: unknown } | undefined)?.models;
  if (!(result as { success?: boolean })?.success || !Array.isArray(models)) return null;
  return models
    .filter((model) => model?.downloaded && typeof model.model === "string")
    .map((model) => ({
      id: model.model,
      engine: "whisper" as const,
      size: model.size_mb
        ? formatBytes(model.size_mb * 1024 * 1024, 0)
        : (WHISPER_MODEL_INFO as Record<string, { size?: string }>)[model.model]?.size,
    }));
}

function sherpaModels(result: unknown): SttLocalModel[] | null {
  const models = (result as { success?: boolean; models?: unknown } | undefined)?.models;
  if (!(result as { success?: boolean })?.success || !Array.isArray(models)) return null;
  return models
    .filter((model) => model?.downloaded && typeof model.model === "string")
    .map((model) => {
      const bytes = model.size_bytes ?? (model.size_mb ? model.size_mb * 1024 * 1024 : 0);
      return {
        id: model.model,
        engine: "sherpa" as const,
        size: bytes
          ? formatBytes(bytes, 0)
          : (PARAKEET_MODEL_INFO as Record<string, { size?: string }>)[model.model]?.size,
      };
    });
}

export interface SttPickerContextResult {
  context: SttPickerContext;
  effectiveMode: InferenceMode | null;
  /** The context and mode as the stores hold them right now, for revalidating a pick at commit. */
  readContext: () => { context: SttPickerContext; effectiveMode: InferenceMode | null };
}

/**
 * Everything a surface's speech-to-text picker needs, from the sources the old
 * editors used: the policy snapshot, the Cloud switch and sign-in, saved
 * credential presence (never a key), downloaded Whisper and sherpa-onnx models
 * (the same list IPCs as AI Connections, re-read when Settings is shown, when
 * the menu opens and after a download or delete), whether sherpa-onnx runs
 * here, what the surface runs now (policy-effective, inherited values
 * filled in) and the custom connection (key presence only; while the menu is
 * open, who runs which of its models, and whether speech-to-text's one custom
 * key already is its key, which main answers with a boolean). Reads only;
 * nothing here writes a setting.
 */
export function useSttPickerContext(
  surface: SttSurface,
  { open }: { open: boolean }
): SttPickerContextResult {
  const policy = usePolicySnapshot();
  const cloudDisabled = useOpenWhisprCloudDisabled();
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const keys = useSettingsStore(useShallow(sttKeyPresence));
  const effectiveMode = useSttEffectiveMode(surface);
  const managedAvailable = useSttManagedAvailable(surface);
  const rememberedCustomModel = useSettingsStore(
    (s) => s.transcriptionModelByProvider?.[`${STT_SURFACE_CONTEXT[surface]}:custom`] ?? ""
  );
  const resolved = useSettingsStore(
    useShallow((s) => sttCurrentFrom(surface, selectPolicyEffectiveSettings(s, policy)))
  );
  const visible = useSettingsVisible();

  const [lists, setLists] = useState<LocalLists>({ whisper: null, sherpa: null });
  const [sherpa, setSherpa] = useState<SttPickerContext["sherpa"]>(undefined);
  const loadLocalModels = useCallback(async () => {
    const api = window.electronAPI;
    const [whisper, parakeet] = await Promise.all([
      api?.listWhisperModels?.().catch(() => undefined),
      api?.listParakeetModels?.().catch(() => undefined),
    ]);
    // A failed read keeps the last list.
    setLists((previous) => ({
      whisper: whisperModels(whisper) ?? previous.whisper,
      sherpa: sherpaModels(parakeet) ?? previous.sherpa,
    }));
  }, []);
  // Disk can change while Settings is closed or the menu is shut: re-read on both.
  useEffect(() => {
    if (visible) void loadLocalModels();
  }, [visible, loadLocalModels]);
  useEffect(() => {
    if (open) void loadLocalModels();
  }, [open, loadLocalModels]);
  useEffect(() => {
    const reload = () => void loadLocalModels();
    window.addEventListener?.(LOCAL_MODELS_CHANGED_EVENT, reload);
    window.addEventListener?.("openwhispr-models-cleared", reload);
    return () => {
      window.removeEventListener?.(LOCAL_MODELS_CHANGED_EVENT, reload);
      window.removeEventListener?.("openwhispr-models-cleared", reload);
    };
  }, [loadLocalModels]);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.checkParakeetInstallation?.()
      .then((capability) => {
        if (!cancelled && capability?.supported === false) {
          setSherpa({ supported: false, minimumMacOSVersion: capability.minimumMacOSVersion });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const localModels = useMemo<SttLocalModel[] | null>(
    () =>
      lists.whisper === null && lists.sherpa === null
        ? null
        : [...(lists.whisper ?? []), ...(lists.sherpa ?? [])],
    [lists]
  );

  // The custom connection, and whether speech-to-text's one key already is its
  // key: main compares (a boolean) while the menu is open, again when either key changes.
  const offersConnection = sttSurfaceOffersCustom(surface);
  const custom = usePickerConnection(open && offersConnection, policy, cloudDisabled);
  const sharedKey = useSettingsStore((s) => s.customTranscriptionApiKey);
  const connectionKey = useSettingsStore((s) => s.customConnectionApiKey);
  const [keyMatches, setKeyMatches] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open || !offersConnection || !custom.connection) return;
    let cancelled = false;
    compareSharedSttKey()
      .then((matches) => {
        if (!cancelled) setKeyMatches(matches);
      })
      .catch(() => {
        if (!cancelled) setKeyMatches(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, offersConnection, custom.connection, sharedKey, connectionKey]);
  const connection = useMemo<SttPickerConnection | null>(() => {
    if (!offersConnection) return null;
    const base = pickerConnection(custom.connection, {
      capability: "speech",
      hasKey: custom.hasKey,
      uses: custom.uses,
    });
    if (!base) return null;
    const conflict = custom.openState
      ? sttSharedKeyConflict(surface, custom.openState, policy, custom.connection)
      : null;
    return { ...base, sharedKey: { matches: keyMatches, conflict } };
  }, [
    offersConnection,
    surface,
    policy,
    custom.connection,
    custom.hasKey,
    custom.uses,
    custom.openState,
    keyMatches,
  ]);

  const context = useMemo<SttPickerContext>(
    () => ({
      policy,
      cloudDisabled,
      isSignedIn,
      keys,
      localModels,
      sherpa,
      rememberedCustomModel,
      connection,
      managedAvailable,
      current: { mode: effectiveMode, ...resolved },
    }),
    [
      policy,
      cloudDisabled,
      isSignedIn,
      keys,
      localModels,
      sherpa,
      rememberedCustomModel,
      connection,
      managedAvailable,
      effectiveMode,
      resolved,
    ]
  );

  const latest = useRef(context);
  useEffect(() => {
    latest.current = context;
  }, [context]);

  const readContext = useCallback(() => {
    const settings = useSettingsStore.getState();
    const { status, policy: orgPolicy, appVersion } = usePolicyStore.getState();
    const livePolicy = { status, policy: orgPolicy, appVersion };
    const live = {
      policy: livePolicy,
      cloudDisabled: isOpenWhisprCloudDisabled(),
      isSignedIn: settings.isSignedIn,
      managedAvailable:
        getManagedScopeResolution("transcription", "managed", managedOperation(surface)).kind ===
        "managed",
    };
    const mode = sttEffectiveMode(surface, settings[STT_MODE_KEY[surface]], live);
    // The stored connection and its key as they are now, with who else sends the shared key.
    const base = sttSurfaceOffersCustom(surface)
      ? pickerConnection(settings.customConnection, {
          capability: "speech",
          hasKey: !!settings.customConnectionApiKey?.trim(),
        })
      : null;
    const connection: SttPickerConnection | null = base
      ? {
          ...base,
          sharedKey: {
            matches: latest.current.connection?.sharedKey.matches ?? null,
            conflict: sttSharedKeyConflict(
              surface,
              settings,
              livePolicy,
              settings.customConnection
            ),
          },
        }
      : null;
    return {
      context: {
        ...latest.current,
        ...live,
        keys: sttKeyPresence(settings),
        rememberedCustomModel:
          settings.transcriptionModelByProvider?.[`${STT_SURFACE_CONTEXT[surface]}:custom`] ?? "",
        connection,
        current: {
          mode,
          ...sttCurrentFrom(surface, selectPolicyEffectiveSettings(settings, livePolicy)),
        },
      },
      effectiveMode: mode,
    };
  }, [surface]);

  return { context, effectiveMode, readContext };
}
