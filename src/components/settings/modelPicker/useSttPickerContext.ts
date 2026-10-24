import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  selectPolicyEffectiveSettings,
  useSettingsStore,
  type SettingsState,
} from "../../../stores/settingsStore";
import { usePolicyStore } from "../../../stores/policyStore";
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
import {
  STT_SURFACE_CONTEXT,
  sttCurrentFrom,
  sttEffectiveMode,
  sttKeyPresence,
  type SttLocalModel,
  type SttPickerContext,
  type SttSurface,
} from "./sttOptions";

/** Each surface's stored mode key. */
export const STT_MODE_KEY = {
  dictation: "transcriptionMode",
  liveRecording: "meetingTranscriptionMode",
  fileTranscription: "uploadTranscriptionMode",
} as const satisfies Record<SttSurface, keyof SettingsState>;

/** The mode a surface's editor shows (policy-effective, as its mode cards reconciled it). */
export function useSttEffectiveMode(surface: SttSurface): InferenceMode | null {
  const policy = usePolicySnapshot();
  const cloudDisabled = useOpenWhisprCloudDisabled();
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const storedMode = useSettingsStore((s) => s[STT_MODE_KEY[surface]]);
  return useMemo(
    () => sttEffectiveMode(surface, storedMode, { policy, cloudDisabled, isSignedIn }),
    [surface, storedMode, policy, cloudDisabled, isSignedIn]
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
 * here, and what the surface runs now (policy-effective, inherited values
 * filled in). Reads only; nothing here writes a setting.
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

  const context = useMemo<SttPickerContext>(
    () => ({
      policy,
      cloudDisabled,
      isSignedIn,
      keys,
      localModels,
      sherpa,
      rememberedCustomModel,
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
    };
    const mode = sttEffectiveMode(surface, settings[STT_MODE_KEY[surface]], live);
    return {
      context: {
        ...latest.current,
        ...live,
        keys: sttKeyPresence(settings),
        rememberedCustomModel:
          settings.transcriptionModelByProvider?.[`${STT_SURFACE_CONTEXT[surface]}:custom`] ?? "",
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
