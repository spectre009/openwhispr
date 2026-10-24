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
import { isProviderValidForMode } from "../../../models/ModelRegistry";
import { requestSignIn } from "../../../utils/requestSignIn";
import { ToastContext } from "../../ui/useToast";
import {
  pickAvailability,
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
 * - `onModeChange` (Cleanup's toast) fires only when the mode changed.
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
const BROWSE_ONLY = new Set<LlmPick["action"]>(["configureCustom", "searchOpenRouter", "link"]);

export function commitLlmSelection(
  scope: InferenceScope,
  pick: LlmPick,
  deps: LlmCommitDeps
): LlmCommitResult {
  if (BROWSE_ONLY.has(pick.action)) return { status: "browse" };

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
  const { t } = useTranslation();
  const toasts = useContext(ToastContext);
  return useCallback(
    (pick: LlmPick) => {
      const context = readContext();
      const settings = useSettingsStore.getState();
      const result = commitLlmSelection(scope, pick, {
        context,
        effectiveMode: context.current.mode,
        currentProvider: context.current.provider,
        enterpriseSetupMode: settings.enterpriseSetupMode,
        managedTakesOver: managedAvailable,
        write: setResolvedLLMConfig,
        setEnterpriseSetupMode: settings.setEnterpriseSetupMode,
        requestSignIn,
        onModeChange,
      });
      if (result.status === "refused") {
        toasts?.toast({
          title: t("modelPicker.refused.title"),
          description: t(result.reason?.reasonKey ?? "modelPicker.refused.unavailable"),
          variant: "destructive",
          duration: 4000,
        });
      }
      return result;
    },
    [scope, readContext, managedAvailable, onModeChange, t, toasts]
  );
}
