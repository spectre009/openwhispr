import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  selectPolicyEffectiveSettings,
  selectResolvedLLMConfig,
  useSettingsStore,
} from "../../stores/settingsStore";
import { useStyleStore } from "../../stores/styleStore";
import { selectableStyles } from "../../config/styles/library";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { usePolicyStore } from "../../stores/policyStore";
import { isAgentAllowed } from "../../stores/policyRules";
import { useAgentName } from "../../utils/agentName";
import { Toggle } from "../ui/toggle";
import { cn } from "../lib/utils";
import { describeLlm } from "./search/searchContext";
import type { Translate } from "./search/searchIndex";
import { SETTINGS_PAGES, type SettingsFeature, type SettingsPageId } from "./settingsPages";
import {
  activePromptName,
  cleanupSharedWith,
  noteFormattingInheritsCleanup,
} from "./featurePageStatus";

interface Pill {
  label: string;
  /** "model" stands out; "muted" is context (what else uses it). */
  tone?: "model" | "muted";
}

function PageHeading({
  title,
  description,
  aside,
  pills = [],
  dimPills = false,
}: {
  title: string;
  description?: string;
  aside?: ReactNode;
  pills?: Pill[];
  /** The feature is off: its model and prompt are what it would use. */
  dimPills?: boolean;
}) {
  return (
    <header data-settings-page-header="" className="mb-6">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          {/* Global heading styles are display-sized; pin this one to the page scale. */}
          <h2 className="text-lg! font-semibold! leading-snug! tracking-tight! text-foreground">
            {title}
          </h2>
          {description && (
            <p className="mt-1 max-w-[640px] text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {aside}
      </div>
      {pills.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {pills.map((pill) => (
            <span
              key={pill.label}
              dir="auto"
              className={cn(
                "inline-flex max-w-full items-center truncate rounded-full border px-2.5 py-0.5 text-[11px] leading-5",
                pill.tone === "model"
                  ? "border-primary/25 bg-primary/8 text-primary dark:bg-primary/12"
                  : pill.tone === "muted"
                    ? "border-border/60 bg-transparent text-muted-foreground/80 dark:border-white/10"
                    : "border-border/70 bg-muted/50 text-foreground/80 dark:border-white/10 dark:bg-surface-2",
                dimPills && pill.tone !== "muted" && "opacity-60"
              )}
            >
              {pill.label}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}

/** A feature's on/off switch, in its page header (the body no longer has its own). */
function HeaderSwitch({
  label,
  checked,
  onChange,
  disabled,
  "data-setting-id": settingId,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  "data-setting-id": string;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-setting-id={settingId}
      className="-my-1 flex shrink-0 items-center gap-2 rounded-md px-2 py-1"
    >
      <span aria-hidden="true" className="text-xs text-muted-foreground">
        {checked ? t("settingsNav.switch.on") : t("settingsNav.switch.off")}
      </span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} ariaLabel={label} />
    </div>
  );
}

/**
 * An AI feature's header: name, one line, its on/off switch where it has one,
 * and what it runs on (provider · model as the editors resolve it, the prompt
 * in use, and what else shares Cleanup's model).
 */
function FeaturePageHeader({ page, feature }: { page: SettingsPageId; feature: SettingsFeature }) {
  const { t } = useTranslation();
  const translate = t as unknown as Translate;
  const { agentName } = useAgentName();
  const policy = usePolicySnapshot();
  const agentAllowed = usePolicyStore(isAgentAllowed);

  const modelLabel = useSettingsStore(
    (settings) =>
      describeLlm(
        selectResolvedLLMConfig(selectPolicyEffectiveSettings(settings, policy), feature.scope),
        translate
      ).display
  );
  const promptLibrary = useSettingsStore((settings) =>
    feature.prompt ? settings.promptLibraries[feature.prompt] : undefined
  );
  const noteFormattingInherits = useSettingsStore(
    (settings) =>
      (page === "cleanup" || page === "noteFormatting") &&
      noteFormattingInheritsCleanup(selectPolicyEffectiveSettings(settings, policy))
  );
  const stylesInUse = useStyleStore(
    (state) => page === "cleanup" && selectableStyles(state.library).length > 0
  );

  const cleanupOn = useSettingsStore((s) => s.useCleanupModel);
  const updateCleanupSettings = useSettingsStore((s) => s.updateCleanupSettings);
  const assistantOn = useSettingsStore((s) => s.useDictationAgent);
  const setAssistantOn = useSettingsStore((s) => s.setUseDictationAgent);
  const translationOn = useSettingsStore((s) => s.useDictationTranslation);
  const setTranslationOn = useSettingsStore((s) => s.setUseDictationTranslation);

  const def = SETTINGS_PAGES[page];
  const pills: Pill[] = [];
  if (modelLabel) pills.push({ label: modelLabel, tone: "model" });
  if (feature.prompt) {
    pills.push({
      label: t("settingsNav.pills.prompt", { name: activePromptName(promptLibrary, translate) }),
    });
  }
  if (page === "cleanup") {
    const shared = cleanupSharedWith({ stylesInUse, noteFormattingInherits }).map((id) =>
      id === "styles" ? t("styles.section.title") : t("settingsNav.pills.noteFormattingInherits")
    );
    if (shared.length) {
      pills.push({
        label: t("settingsNav.pills.alsoUsedBy", { features: shared.join(" · ") }),
        tone: "muted",
      });
    }
  }
  if (page === "noteFormatting" && noteFormattingInherits) {
    pills.push({ label: t("settingsNav.pills.inheritsFromCleanup"), tone: "muted" });
  }

  const featureOff =
    (page === "cleanup" && !cleanupOn) ||
    (page === "assistant" && !assistantOn) ||
    (page === "translation" && !translationOn);

  return (
    <PageHeading
      title={t(def.titleKey)}
      description={t(def.descriptionKey, { agentName })}
      pills={pills}
      dimPills={featureOff}
      aside={
        page === "cleanup" ? (
          <HeaderSwitch
            data-setting-id="dictation.cleanup.enabled"
            label={t("settingsPage.aiModels.enableTextCleanup")}
            checked={cleanupOn}
            onChange={(value) => updateCleanupSettings({ useCleanupModel: value })}
          />
        ) : page === "assistant" ? (
          <HeaderSwitch
            data-setting-id="assistant.enabled"
            label={t("dictationAgent.enabled")}
            checked={assistantOn}
            onChange={setAssistantOn}
            disabled={!agentAllowed}
          />
        ) : page === "translation" ? (
          <HeaderSwitch
            data-setting-id="translation.enabled"
            label={t("dictationTranslation.enabled")}
            checked={translationOn}
            onChange={setTranslationOn}
          />
        ) : undefined
      }
    />
  );
}

/** A page's header: its title and one line, plus the switch and status for AI features. */
export default function SettingsPageHeader({ page }: { page: SettingsPageId }) {
  const { t } = useTranslation();
  const def = SETTINGS_PAGES[page];
  if (def.feature) return <FeaturePageHeader page={page} feature={def.feature} />;
  return <PageHeading title={t(def.titleKey)} description={t(def.descriptionKey)} />;
}
