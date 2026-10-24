import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { SectionHeader } from "../ui/SettingsSection";
import { Button } from "../ui/button";
import { Copy } from "../icons";
import PromptLibraryBar, { PromptDraftActions } from "../ui/PromptLibraryBar";
import { AutoGrowTextarea } from "../ui/AutoGrowTextarea";
import ClampedText from "../ui/ClampedText";
import { usePromptLibraryEditor } from "../../hooks/usePromptLibraryEditor";
import InferenceConfigEditor from "./InferenceConfigEditor";

const TEXTAREA_CLASS =
  "w-full text-xs bg-transparent border border-border/70 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/30 placeholder:text-muted-foreground/70";

export default function ChatAgentSettings() {
  const { t } = useTranslation();
  const uiLanguage = useSettingsStore((s) => s.uiLanguage);
  // The textarea edits a draft; only Save / Save as new write the library.
  const editor = usePromptLibraryEditor("chatAgent", { uiLanguage });

  return (
    <div className="space-y-6">
      <InferenceConfigEditor scope="chatIntelligence" />

      <div>
        <SectionHeader
          title={t("agentMode.settings.systemPrompt")}
          description={t("agentMode.settings.systemPromptDescription")}
        />
        <PromptLibraryBar editor={editor} className="mb-3" />
        {editor.isDefaultSelected ? (
          <div className="space-y-2">
            <ClampedText collapsedRem={12} className="rounded-md border border-border/70 px-3 py-2">
              <pre
                dir="auto"
                className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground"
              >
                {editor.savedText}
              </pre>
            </ClampedText>
            <div className="flex flex-wrap items-center gap-3">
              <p className="flex-1 min-w-48 text-xs text-muted-foreground">
                {t("promptStudio.library.builtinReadOnly")}
              </p>
              <Button onClick={editor.startDuplicate} size="sm" className="h-8">
                <Copy className="w-3.5 h-3.5" />
                {t("promptStudio.library.actions.duplicateToCustomize")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <AutoGrowTextarea
              unstyled
              dir="auto"
              value={editor.editorText}
              onChange={(e) => editor.setDraft(e.target.value)}
              placeholder={t("agentMode.settings.systemPromptPlaceholder")}
              minRows={4}
              className={TEXTAREA_CLASS}
            />
            <PromptDraftActions editor={editor} />
          </div>
        )}
      </div>
    </div>
  );
}
