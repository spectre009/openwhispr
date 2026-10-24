import { useCallback, useContext } from "react";
import { useTranslation } from "react-i18next";
import {
  setResolvedLLMConfig,
  useSettingsStore,
  type ResolvedLLMConfig,
} from "../../../stores/settingsStore";
import type { InferenceMode } from "../../../types/electron";
import type { EnterpriseSetupMode } from "../../../types/enterpriseIdentity";
import type { InferenceScope } from "../../../config/inferenceScopes";
import {
  validateEndpoint,
  type CustomConnection,
  type CustomConnectionSlot,
} from "../../../config/customConnection";
import { isProviderValidForMode } from "../../../models/ModelRegistry";
import { requestSignIn } from "../../../utils/requestSignIn";
import { ToastContext } from "../../ui/useToast";
import { LLM_KEY_SLOTS } from "../connectionUsage";
import { connectionKeyFailed } from "./connectionOptions";
import { applyConnectionKey, rememberConnectionModel } from "./connectionPick";
import {
  pickAvailability,
  unavailableReason,
  type LlmPick,
  type ModelPickerContext,
  type PickerUnavailable,
} from "./options";

/**
 * The language-model selection adapter: every pick in a feature's model
 * picker goes through `commitLlmSelection`, never a bare setter call. It
 * revalidates the pick against the live context (policy, Cloud switch and
 * sign-in, Copilot's scopes and sign-in, saved keys, downloaded models), then
 * writes mode, cloud mode, provider and model in one `setResolvedLLMConfig`
 * call, with the editor's side effects:
 * - mode and cloud mode are written only when the pick changes the mode the
 *   editor shows (as the mode cards did), and a mode-only pick (Cloud,
 *   self-hosted, enterprise) clears a provider that mode can't use;
 * - OpenWhispr Cloud while signed out asks to sign in and writes nothing;
 * - the organization's managed deployment sets the setup mode to managed
 *   (the "Use managed" banner's action); any other pick, if a managed
 *   deployment would otherwise answer this scope, sets it to manual;
 * - `onModeChange` (Cleanup's toast) fires only when the mode changed;
 * - a model on the custom connection (`commitLlmConnectionSelection`) has
 *   main copy the connection's key into the scope's own key slot first, then
 *   makes the custom endpoint's pick with the connection's URL.
 * Optional scopes write their own override; nothing is written by opening the
 * picker or by browsing, so inherited fields are never materialized.
 */

type LlmPatch = Partial<Omit<ResolvedLLMConfig, "scope">>;

export interface LlmCommitDeps {
  /** The picker context, read live at commit time. */
  context: ModelPickerContext;
  /** The mode the editor shows (policy-effective). */
  effectiveMode: InferenceMode | null;
  /** The provider the editor shows (resolved, inheritance included). */
  currentProvider: string;
  enterpriseSetupMode: EnterpriseSetupMode;
  /** A managed deployment would answer this scope unless the setup mode is manual. */
  managedTakesOver: boolean;
  write: (scope: InferenceScope, patch: LlmPatch) => void;
  setEnterpriseSetupMode: (mode: EnterpriseSetupMode) => void;
  requestSignIn: () => void;
  onModeChange?: (mode: InferenceMode) => void;
}

export type LlmCommitResult =
  | { status: "committed"; patch: LlmPatch; modeChanged: boolean }
  | { status: "managed" }
  | { status: "signIn" }
  /** An entry that only opens fields under the picker. */
  | { status: "browse" }
  | { status: "refused"; reason: PickerUnavailable | null };

/** Entries that only open fields under the picker; they never write. */
const BROWSE_ONLY = new Set<LlmPick["action"]>([
  "configureCustom",
  "searchOpenRouter",
  "enterConnectionModel",
  "link",
]);

export function commitLlmSelection(
  scope: InferenceScope,
  pick: LlmPick,
  deps: LlmCommitDeps
): LlmCommitResult {
  if (BROWSE_ONLY.has(pick.action)) return { status: "browse" };
  // A model on the custom connection is picked by commitLlmConnectionSelection.
  if (pick.action === "useConnection") return { status: "refused", reason: null };

  const availability = pickAvailability(scope, pick, deps.context);
  if (pick.action === "useManaged") {
    if (availability !== true) return { status: "refused", reason: null };
    deps.setEnterpriseSetupMode("managed");
    return { status: "managed" };
  }
  if (availability !== true) {
    if (availability?.link?.kind === "signIn") {
      deps.requestSignIn();
      return { status: "signIn" };
    }
    return { status: "refused", reason: availability };
  }

  const modeChanged = pick.mode !== deps.effectiveMode;
  const patch: LlmPatch = {};
  if (modeChanged) {
    patch.mode = pick.mode;
    patch.cloudMode = pick.mode === "openwhispr" ? "openwhispr" : "byok";
    if (!pick.provider && !isProviderValidForMode(deps.currentProvider, pick.mode)) {
      patch.provider = "";
      patch.model = "";
    }
  }
  if (pick.provider) {
    patch.provider = pick.provider;
    patch.model = pick.model;
  }

  if (deps.managedTakesOver && deps.enterpriseSetupMode !== "manual") {
    deps.setEnterpriseSetupMode("manual");
  }
  if (Object.keys(patch).length > 0) deps.write(scope, patch);
  if (modeChanged) deps.onModeChange?.(pick.mode);
  return { status: "committed", patch, modeChanged };
}

/** What a pick on the custom connection needs besides the adapter's own deps. */
export interface ConnectionCommitDeps {
  /** The connection as stored; its endpoint gives the URL the pick writes. */
  connection: CustomConnection | null;
  /** Copies the connection's key into a key slot (main), awaited; throws when it can't. */
  applyKey: (slot: CustomConnectionSlot) => Promise<void>;
  /** Remembers the model on the connection, once the pick is committed. */
  rememberModel: (model: string) => void;
}

/**
 * A model on the custom connection, written through as a hand-entered custom
 * endpoint with the same URL, model and key: revalidated first (as any pick);
 * then the connection's key copied into the scope's own key slot, awaited
 * (refused, with nothing written, if that fails); then the URL the request
 * reads (the connection's language base, `{origin}/openai/v1` on Azure), then
 * mode, provider `custom` and the model through `commitLlmSelection`; and
 * only then the model is remembered on the connection.
 */
export async function commitLlmConnectionSelection(
  scope: InferenceScope,
  model: string,
  deps: LlmCommitDeps & ConnectionCommitDeps
): Promise<LlmCommitResult> {
  const name = model.trim();
  const availability = pickAvailability(
    scope,
    { mode: "providers", provider: "custom", model: name, action: "useConnection" },
    deps.context
  );
  const target = deps.connection ? validateEndpoint(deps.connection.endpoint) : null;
  if (availability !== true || !deps.connection || !target?.ok) {
    return { status: "refused", reason: availability === true ? null : availability };
  }
  try {
    await deps.applyKey(LLM_KEY_SLOTS[scope]);
  } catch {
    return { status: "refused", reason: connectionKeyFailed(deps.connection.name) };
  }
  deps.write(scope, { cloudBaseUrl: target.languageBase });
  const result = commitLlmSelection(
    scope,
    { mode: "providers", provider: "custom", model: name },
    deps
  );
  if (result.status === "committed") deps.rememberModel(name);
  return result;
}

export interface UseLlmSelectionOptions {
  /** Reads the picker context as it is now (stores, live lists). */
  readContext: () => ModelPickerContext;
  /** A managed deployment exists for this scope (resolved as if the setup mode were managed). */
  managedAvailable: boolean;
  onModeChange?: (mode: InferenceMode) => void;
}

/**
 * The adapter wired to the live stores: the mode shown is re-read from
 * policy-effective settings at commit time, and a refused pick explains why
 * in a toast (when a toast host is mounted).
 */
export function useLlmSelection(
  scope: InferenceScope,
  { readContext, managedAvailable, onModeChange }: UseLlmSelectionOptions
): (pick: LlmPick) => LlmCommitResult {
  const deps = useLiveLlmDeps({ readContext, managedAvailable, onModeChange });
  const explain = useRefusalToast();
  return useCallback(
    (pick: LlmPick) => {
      const result = commitLlmSelection(scope, pick, deps());
      explain(result);
      return result;
    },
    [scope, deps, explain]
  );
}

/**
 * A model on the custom connection, with the live stores: the key goes through
 * main (`applyConnectionKey`), the model is remembered for language models,
 * and a refused pick explains why in a toast.
 */
export function useLlmConnectionSelection(
  scope: InferenceScope,
  { readContext, managedAvailable, onModeChange }: UseLlmSelectionOptions
): (model: string) => Promise<LlmCommitResult> {
  const deps = useLiveLlmDeps({ readContext, managedAvailable, onModeChange });
  const explain = useRefusalToast();
  return useCallback(
    async (model: string) => {
      const result = await commitLlmConnectionSelection(scope, model, {
        ...deps(),
        connection: useSettingsStore.getState().customConnection,
        applyKey: applyConnectionKey,
        rememberModel: (name) => rememberConnectionModel(name, "language"),
      });
      explain(result);
      return result;
    },
    [scope, deps, explain]
  );
}

function useLiveLlmDeps({
  readContext,
  managedAvailable,
  onModeChange,
}: UseLlmSelectionOptions): () => LlmCommitDeps {
  return useCallback(() => {
    const context = readContext();
    const settings = useSettingsStore.getState();
    return {
      context,
      effectiveMode: context.current.mode,
      currentProvider: context.current.provider,
      enterpriseSetupMode: settings.enterpriseSetupMode,
      managedTakesOver: managedAvailable,
      write: setResolvedLLMConfig,
      setEnterpriseSetupMode: settings.setEnterpriseSetupMode,
      requestSignIn,
      onModeChange,
    };
  }, [readContext, managedAvailable, onModeChange]);
}

function useRefusalToast(): (result: LlmCommitResult) => void {
  const { t } = useTranslation();
  const toasts = useContext(ToastContext);
  return useCallback(
    (result: LlmCommitResult) => {
      if (result.status !== "refused") return;
      toasts?.toast({
        title: t("modelPicker.refused.title"),
        description: result.reason
          ? unavailableReason(t, result.reason)
          : t("modelPicker.refused.unavailable"),
        variant: "destructive",
        duration: 4000,
      });
    },
    [t, toasts]
  );
}
