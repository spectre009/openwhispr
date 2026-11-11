import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useStyleStore } from "../../../stores/styleStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { useOpenWhisprCloudDisabled } from "../../../stores/openWhisprCloudStore";
import { usePolicySnapshot } from "../../../hooks/usePolicy";
import { workspaceCan } from "../../../lib/capabilities";
import { settingsWorkspace } from "../../../lib/workspaceSwitcher";
import { getAgentName } from "../../../utils/agentName";
import { getCachedPlatform } from "../../../utils/platform";
import { SETTINGS_SEARCH_DESCRIPTORS } from "./registry";
import { buildSettingsSearchIndex, type Translate } from "./searchIndex";
import { buildSettingsSearchContext, type SettingsSearchEnvironment } from "./searchContext";
import type { SettingsSearchEntry } from "./match";

// Asked once per window: whether the Wayland paste rows and the GPU pickers render.
let environmentRequest: Promise<SettingsSearchEnvironment> | null = null;

function loadEnvironment(): Promise<SettingsSearchEnvironment> {
  environmentRequest ??= (async () => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    const [gpus, ydotool] = await Promise.all([
      api?.listGpus?.().catch(() => null) ?? null,
      getCachedPlatform() === "linux"
        ? (api?.getYdotoolStatus?.().catch(() => null) ?? null)
        : null,
    ]);
    return {
      gpuCount: Array.isArray(gpus) ? gpus.length : null,
      isWayland: ydotool ? Boolean(ydotool.isWayland) : null,
    };
  })();
  return environmentRequest;
}

function useSettingsSearchEnvironment(active: boolean): SettingsSearchEnvironment {
  const [env, setEnv] = useState<SettingsSearchEnvironment>({ gpuCount: null, isWayland: null });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void loadEnvironment().then((next) => {
      if (!cancelled) setEnv(next);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return env;
}

/**
 * The settings search index for the current language and settings, or null
 * while inactive (no store subscriptions are kept busy then). Rebuilt when the
 * UI language, the settings, policy or style hotkeys change.
 */
export function useSettingsSearchIndex(active: boolean): SettingsSearchEntry[] | null {
  const { t, i18n } = useTranslation();
  const settings = useSettingsStore((state) => (active ? state : null));
  const policy = usePolicySnapshot();
  const styles = useStyleStore(
    useShallow((state) =>
      active ? { library: state.library, bindings: state.hotkeys.bindings } : null
    )
  );
  const cloudDisabled = useOpenWhisprCloudDisabled();
  // As Settings shows the workspace pages: the workspace Settings manages (none in Personal), and
  // the server's capabilities on it (#2921), the role as fallback.
  const workspaceAccess = useWorkspaceStore(
    useShallow((state) => {
      const workspace = settingsWorkspace(
        state.workspaces,
        state.activeWorkspaceId,
        state.personalSelected
      );
      return {
        hasWorkspace: workspace !== null,
        canManageWorkspace: workspace ? workspaceCan(workspace, "manage_settings") : false,
        canManageMembers: workspace ? workspaceCan(workspace, "manage_members") : false,
      };
    })
  );
  const env = useSettingsSearchEnvironment(active);
  const language = i18n.language;
  const tEn = useMemo(() => i18n.getFixedT("en") as unknown as Translate, [i18n]);

  const ctx = useMemo(() => {
    if (!settings || !styles) return null;
    return buildSettingsSearchContext({
      settings,
      policy,
      styleLibrary: styles.library,
      styleBindings: styles.bindings,
      platform: getCachedPlatform(),
      cloudDisabled,
      ...workspaceAccess,
      env,
      agentName: getAgentName(),
      t: t as unknown as Translate,
    });
    // `language` rebuilds the translated values when the UI language changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, policy, styles, cloudDisabled, workspaceAccess, env, t, language]);

  return useMemo(
    () =>
      ctx
        ? buildSettingsSearchIndex({
            descriptors: SETTINGS_SEARCH_DESCRIPTORS,
            ctx,
            t: t as unknown as Translate,
            tEn,
          })
        : null,
    [ctx, t, tEn]
  );
}
