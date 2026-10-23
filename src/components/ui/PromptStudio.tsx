import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./button";
import { Textarea } from "./textarea";
import { Eye, Edit3, Play, Copy, TestTube, AlertTriangle, Check, Info } from "../icons";
import PromptLibraryBar, { PromptDraftActions } from "./PromptLibraryBar";
import PromptTestSet from "./PromptTestSet";
import { useAgentName } from "../../utils/agentName";
import ReasoningService from "../../services/ReasoningService";
import { runCleanupWithPrompt, type CleanupPromptOverride } from "../../services/cleanupWithPrompt";
import { saveTestCaseFromInput, storageNoticeKey } from "../../stores/promptTestSetStore";
import { getModelProvider } from "../../models/ModelRegistry";
import logger from "../../utils/logger";
import { resolvePromptText, type PromptKind } from "../../config/prompts";
import { usePromptLibraryEditor } from "../../hooks/usePromptLibraryEditor";
import {
  useSettingsStore,
  selectPolicyEffectiveSettings,
  selectIsCloudCleanupMode,
  selectIsCloudDictationAgentMode,
  selectIsCloudTranslationMode,
} from "../../stores/settingsStore";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { getLanguageLabel } from "../../utils/languageSupport";
import { getDictionaryHintWords } from "../../utils/snippets";
import { resolveDictationAgentInference } from "../../helpers/dictationAgentInference";
import { resolveDictationTranslationInference } from "../../helpers/dictationTranslationInference";

interface PromptStudioProps {
  className?: string;
  kind?: PromptKind;
}

type ProviderConfig = {
  label: string;
  apiKeyStorageKey?: string;
  baseStorageKey?: string;
};

const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  openai: { label: "OpenAI", apiKeyStorageKey: "openaiApiKey" },
  anthropic: { label: "Anthropic", apiKeyStorageKey: "anthropicApiKey" },
  gemini: { label: "Gemini", apiKeyStorageKey: "geminiApiKey" },
  groq: { label: "Groq", apiKeyStorageKey: "groqApiKey" },
  openrouter: { label: "OpenRouter", apiKeyStorageKey: "openrouterApiKey" },
  tinfoil: { label: "Tinfoil", apiKeyStorageKey: "tinfoilApiKey" },
  copilot: { label: "GitHub Copilot" },
  openwhispr: { label: "OpenWhispr Cloud" },
  custom: {
    label: "Custom endpoint",
    apiKeyStorageKey: "openaiApiKey",
    baseStorageKey: "cleanupCloudBaseUrl",
  },
  local: { label: "Local" },
};

export default function PromptStudio({ className = "", kind = "cleanup" }: PromptStudioProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"current" | "edit" | "test">("current");
  const [testText, setTestText] = useState(() =>
    t(
      kind === "translate"
        ? "promptStudio.defaultTestInputTranslate"
        : "promptStudio.defaultTestInput"
    )
  );
  const [testResult, setTestResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  // Cleanup's Test tab: one input, or the test set (A against B on many cases).
  const [testMode, setTestMode] = useState<"single" | "set">("single");
  const [caseNotice, setCaseNotice] = useState<string | null>(null);

  const { agentName } = useAgentName();
  const policyState = usePolicySnapshot();
  const effectiveSettings = useSettingsStore(
    useShallow((settings) => selectPolicyEffectiveSettings(settings, policyState))
  );
  const uiLanguage = effectiveSettings.uiLanguage;

  const isCloudMode = selectIsCloudCleanupMode(effectiveSettings);
  const useCleanupModel = effectiveSettings.useCleanupModel;
  const cleanupModel = effectiveSettings.cleanupModel;

  const isCloudDictationAgent = selectIsCloudDictationAgentMode(effectiveSettings);
  const useDictationAgent = effectiveSettings.useDictationAgent;
  const dictationAgentMode = effectiveSettings.dictationAgentMode;
  const dictationAgentProvider = effectiveSettings.dictationAgentProvider;
  const dictationAgentModel = effectiveSettings.dictationAgentModel;

  const isCloudTranslation = selectIsCloudTranslationMode(effectiveSettings);
  const useDictationTranslation = effectiveSettings.useDictationTranslation;
  const translationMode = effectiveSettings.translationMode;
  const translationProvider = effectiveSettings.translationProvider;
  const translationModel = effectiveSettings.translationModel;
  const translationRemoteUrl = effectiveSettings.translationRemoteUrl;
  const translationTargetLanguage = effectiveSettings.translationTargetLanguage;

  const isTranslate = kind === "translate";
  const isAgent = kind === "dictationAgent";

  const editor = usePromptLibraryEditor(kind, {
    uiLanguage,
    onEdit: () => setActiveTab("edit"),
  });

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const testPrompt = async () => {
    if (!testText.trim()) return;

    // The selected prompt, or its unsaved draft, runs in this request only:
    // nothing saved changes, so other windows keep dictating with the prompt in
    // use. Captured now, so edits made while the test runs don't leak into it.
    const candidateTemplate = editor.isDefaultSelected ? "" : editor.editorText;
    const candidate: CleanupPromptOverride = editor.isDefaultSelected
      ? { mode: "builtin" }
      : { mode: "text", text: candidateTemplate };

    setIsLoading(true);
    setTestResult("");

    try {
      if (isTranslate) {
        if (!useDictationTranslation) {
          setTestResult(t("promptStudio.test.translationDisabled"));
          return;
        }
        if (!translationTargetLanguage.trim()) {
          setTestResult(t("promptStudio.test.noTargetLanguage"));
          return;
        }

        const translation = resolveDictationTranslationInference(effectiveSettings, {
          isCloudTranslation,
        });
        if (!translation.reachable) {
          if (translationMode === "self-hosted" && !translationRemoteUrl.trim()) {
            setTestResult(t("notes.actions.errors.noEndpoint"));
            return;
          }
          setTestResult(t("promptStudio.test.noModelSelected"));
          return;
        }

        const result = await ReasoningService.processText(testText, translation.model, agentName, {
          ...translation.config,
          systemPrompt: resolvePromptText("translate", candidateTemplate, {
            agentName,
            targetLanguageLabel: getLanguageLabel(translationTargetLanguage),
            customDictionary: getDictionaryHintWords(effectiveSettings),
            uiLanguage,
          }),
        });
        setTestResult(result);
        return;
      }

      // The agent runs on its own inference scope; falling through to the cleanup
      // branch would test the cleanup provider with the cleanup prompt.
      if (isAgent) {
        if (!useDictationAgent) {
          setTestResult(t("promptStudio.test.agentDisabled"));
          return;
        }

        const settings = effectiveSettings;
        const agent = resolveDictationAgentInference(settings, {
          isCloudAgent: isCloudDictationAgent,
        });

        if (!agent.reachable) {
          setTestResult(t("promptStudio.test.noModelSelected"));
          return;
        }

        const result = await ReasoningService.processText(testText, agent.model, agentName, {
          ...agent.config,
          inferenceScope: "dictationAgent",
          requiresAgent: true,
          systemPrompt: resolvePromptText("dictationAgent", candidateTemplate, {
            agentName,
            language: settings.preferredLanguage,
            customDictionary: getDictionaryHintWords(settings),
            uiLanguage,
          }),
        });
        setTestResult(result);
        return;
      }

      const cleanupProvider = isCloudMode
        ? "openwhispr"
        : (cleanupModel && getModelProvider(cleanupModel)) || "openai";

      logger.debug(
        "PromptStudio test starting",
        {
          useCleanupModel,
          isCloudMode,
          cleanupModel,
          cleanupProvider,
          testTextLength: testText.length,
          agentName,
        },
        "prompt-studio"
      );

      if (!useCleanupModel) {
        setTestResult(t("promptStudio.test.disabledReasoning"));
        return;
      }

      if (!isCloudMode && !cleanupModel) {
        setTestResult(t("promptStudio.test.noModelSelected"));
        return;
      }

      if (!isCloudMode) {
        const providerConfig = PROVIDER_CONFIG[cleanupProvider] || {
          label: cleanupProvider.charAt(0).toUpperCase() + cleanupProvider.slice(1),
        };

        if (providerConfig.baseStorageKey) {
          const baseUrl = (effectiveSettings.cleanupCloudBaseUrl || "").trim();
          if (!baseUrl) {
            setTestResult(
              t("promptStudio.test.baseUrlMissing", {
                provider:
                  cleanupProvider === "custom"
                    ? t("promptStudio.test.customEndpoint")
                    : providerConfig.label,
              })
            );
            return;
          }
        }
      }

      // The real cleanup request with the candidate as its prompt (see
      // runCleanupWithPrompt): same model, options, wrapper and validation as a
      // dictation would use if this prompt were the one in use. A test: its
      // text stays out of the request logs.
      const result = await runCleanupWithPrompt(testText, candidate, {
        agentName,
        redactLogs: true,
      });
      setTestResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("PromptStudio test failed", { error: errorMessage }, "prompt-studio");
      const typed = error as { code?: string; provider?: string };
      setTestResult(
        typed?.code === "API_KEY_MISSING"
          ? t("promptStudio.test.apiKeyMissing", { provider: typed.provider })
          : t("promptStudio.test.failed", { error: errorMessage })
      );
    } finally {
      setIsLoading(false);
    }
  };

  // "Save as test case": main stores the input as typed (or keeps it for this
  // session only when local history is off) and says which.
  const saveAsTestCase = async () => {
    if (!testText.trim()) return;
    const result = await saveTestCaseFromInput(testText);
    if (!result.success) {
      setCaseNotice(t("promptStudio.test.saveCaseFailed"));
    } else if (result.duplicate) {
      setCaseNotice(t("promptStudio.test.caseExists"));
    } else if (result.durable) {
      setCaseNotice(t("promptStudio.test.caseSaved"));
    } else {
      setCaseNotice(
        `${t("promptStudio.test.caseSavedSession")} ${t(storageNoticeKey(result.reason))}`
      );
    }
  };

  const isAgentAddressed = testText.toLowerCase().includes(agentName.toLowerCase());
  const candidateIsEmpty = !editor.isDefaultSelected && !editor.editorText.trim();
  const selectedName = editor.displayName(editor.selectedId);
  const activeName = editor.displayName(editor.library.activeId);

  const tabs = [
    { id: "current" as const, label: t("promptStudio.tabs.view"), icon: Eye },
    { id: "edit" as const, label: t("promptStudio.tabs.customize"), icon: Edit3 },
    { id: "test" as const, label: t("promptStudio.tabs.test"), icon: TestTube },
  ];

  const duplicateToCustomize = (
    <div className="rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 min-w-48 text-xs text-muted-foreground leading-relaxed">
          {t("promptStudio.library.builtinReadOnly")}
        </p>
        <Button onClick={editor.startDuplicate} size="sm" className="h-8">
          <Copy className="w-3.5 h-3.5" />
          {t("promptStudio.library.actions.duplicateToCustomize")}
        </Button>
      </div>
    </div>
  );

  return (
    <div className={className}>
      <PromptLibraryBar editor={editor} className="mb-3" />

      {/* Tab Navigation + Content in a single panel */}
      <div className="rounded-xl border border-border/70 dark:border-border-subtle bg-card dark:bg-surface-2 overflow-hidden">
        <div className="flex border-b border-border/70 dark:border-border-subtle">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-xs font-medium transition-colors duration-150 border-b-2 ${
                  isActive
                    ? "border-primary text-foreground bg-primary/5 dark:bg-primary/3"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-black/2 dark:hover:bg-white/2"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* ── View Tab ── */}
        {activeTab === "current" && (
          <div className="divide-y divide-border/60 dark:divide-border-subtle">
            <div className="px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
                    {editor.isDefaultSelected
                      ? t("promptStudio.library.builtinLabel")
                      : t("promptStudio.library.savedLabel")}
                  </p>
                  <span
                    className={`text-xs font-semibold uppercase tracking-wider px-1.5 py-px rounded-full ${
                      editor.isDefaultSelected
                        ? "bg-muted text-muted-foreground"
                        : "bg-primary/10 text-primary"
                    }`}
                  >
                    {editor.isDefaultSelected
                      ? t("promptStudio.library.readOnly")
                      : t("promptStudio.library.yours")}
                  </span>
                </div>
                <Button
                  onClick={() => copyText(editor.savedText)}
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                >
                  {copiedPrompt ? (
                    <>
                      <Check className="w-3 h-3 me-1 text-success" />{" "}
                      {t("promptStudio.common.copied")}
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 me-1" /> {t("promptStudio.common.copy")}
                    </>
                  )}
                </Button>
              </div>
              <div className="bg-muted/30 dark:bg-surface-raised/30 border border-border/70 rounded-lg p-4 max-h-80 overflow-y-auto">
                <pre
                  dir="auto"
                  className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed"
                >
                  {editor.savedText.replace(/\{\{agentName\}\}/g, agentName)}
                </pre>
              </div>
              {editor.isDirty && (
                <p className="text-xs text-warning mt-2">
                  {t("promptStudio.library.viewShowsSaved")}
                </p>
              )}
            </div>
            {editor.isDefaultSelected && <div className="px-5 py-4">{duplicateToCustomize}</div>}
          </div>
        )}

        {/* ── Edit Tab ── */}
        {activeTab === "edit" &&
          (editor.isDefaultSelected ? (
            <div className="px-5 py-4">{duplicateToCustomize}</div>
          ) : (
            <div className="divide-y divide-border/60 dark:divide-border-subtle">
              <div className="px-5 py-4">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  <span className="font-medium text-warning">
                    {t("promptStudio.edit.cautionLabel")}
                  </span>{" "}
                  {t("promptStudio.edit.cautionTextPrefix")}{" "}
                  <code dir="ltr" className="text-xs bg-muted/50 px-1 py-0.5 rounded font-mono">
                    {"{{agentName}}"}
                  </code>{" "}
                  {t("promptStudio.edit.cautionTextSuffix")}
                </p>
              </div>

              <div className="px-5 py-4">
                <Textarea
                  dir="auto"
                  value={editor.editorText}
                  onChange={(e) => editor.setDraft(e.target.value)}
                  rows={16}
                  className="font-mono text-xs leading-relaxed"
                  placeholder={t("promptStudio.edit.placeholder")}
                />
                <p className="text-xs text-muted-foreground/70 mt-2">
                  {t("promptStudio.edit.agentNameLabel")}{" "}
                  <span dir="auto" className="font-medium text-foreground">
                    {agentName}
                  </span>
                </p>
              </div>

              <div className="px-5 py-4">
                <PromptDraftActions editor={editor} />
              </div>
            </div>
          ))}

        {/* ── Test Tab ── */}
        {activeTab === "test" &&
          (() => {
            // Each kind reports the scope that actually runs it.
            const testIsCloud = isTranslate
              ? isCloudTranslation
              : isAgent
                ? isCloudDictationAgent
                : isCloudMode;
            const testModel = isTranslate
              ? translationModel
              : isAgent
                ? dictationAgentModel
                : cleanupModel;
            const agentDisplayProvider = isAgent
              ? resolveDictationAgentInference(
                  {
                    useDictationAgent,
                    dictationAgentMode,
                    dictationAgentProvider,
                    dictationAgentModel,
                  },
                  { isCloudAgent: isCloudDictationAgent }
                ).displayProvider
              : "";
            const translationDisplayProvider = isTranslate
              ? resolveDictationTranslationInference(
                  {
                    translationMode,
                    translationProvider,
                  },
                  { isCloudTranslation }
                ).displayProvider
              : "";
            const scopeProvider = isTranslate
              ? translationDisplayProvider
              : isAgent
                ? agentDisplayProvider
                : "";
            const testProvider =
              isAgent || isTranslate
                ? scopeProvider
                : testIsCloud
                  ? "openwhispr"
                  : scopeProvider || (testModel && getModelProvider(testModel)) || "openai";
            const providerConfig = PROVIDER_CONFIG[testProvider] || {
              label: testProvider.charAt(0).toUpperCase() + testProvider.slice(1),
            };

            const displayModel = testIsCloud
              ? t("promptStudio.test.openwhisprCloud")
              : testModel || t("promptStudio.test.none");
            const displayProvider =
              testProvider === "custom"
                ? t("promptStudio.test.customEndpoint")
                : providerConfig.label;

            // The test set runs cleanup prompts only (styles join in a later stage).
            const isCleanupKind = !isTranslate && !isAgent;
            const modeSwitch = isCleanupKind && (
              <div className="px-5 py-3">
                <div
                  role="tablist"
                  className="inline-flex rounded-lg border border-border/70 dark:border-border-subtle p-0.5"
                >
                  {(["single", "set"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={testMode === mode}
                      onClick={() => setTestMode(mode)}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors duration-150 ${
                        testMode === mode
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t(
                        mode === "single"
                          ? "promptStudio.testSet.modeSingle"
                          : "promptStudio.testSet.modeSet"
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );

            if (isCleanupKind && testMode === "set") {
              return (
                <div className="divide-y divide-border/60 dark:divide-border-subtle">
                  {modeSwitch}
                  <PromptTestSet editor={editor} agentName={agentName} />
                </div>
              );
            }

            return (
              <div className="divide-y divide-border/60 dark:divide-border-subtle">
                {modeSwitch}
                <div className="px-5 py-4">
                  <div className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 px-4 py-3">
                    <Info className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                    <p dir="auto" className="text-xs text-muted-foreground leading-relaxed">
                      {editor.isDirty
                        ? t("promptStudio.library.testRunsDraft", { active: activeName })
                        : editor.isSelectedActive
                          ? t("promptStudio.library.testRunsActive", { name: selectedName })
                          : t("promptStudio.library.testRunsSelected", {
                              name: selectedName,
                              active: activeName,
                            })}
                    </p>
                  </div>
                </div>

                {!isTranslate && !isAgent && !useCleanupModel && (
                  <div className="px-5 py-4">
                    <div className="rounded-lg border border-warning/20 bg-warning/5 dark:bg-warning/10 px-4 py-3">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t("promptStudio.test.disabledInSettingsPrefix")}{" "}
                          <span className="font-medium text-foreground">
                            {t("promptStudio.test.aiModels")}
                          </span>{" "}
                          {t("promptStudio.test.disabledInSettingsSuffix")}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="px-5 py-4">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground/70 uppercase tracking-wider">
                        {t("promptStudio.test.modelLabel")}
                      </p>
                      <p dir="ltr" className="text-xs font-medium text-foreground font-mono">
                        {displayModel}
                      </p>
                    </div>
                    <div className="h-3 w-px bg-border/40" />
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground/70 uppercase tracking-wider">
                        {t("promptStudio.test.providerLabel")}
                      </p>
                      <p dir="ltr" className="text-xs font-medium text-foreground">
                        {displayProvider}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-foreground">
                      {t("promptStudio.test.inputLabel")}
                    </p>
                    {testText && (
                      <span
                        className={`text-xs font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                          isTranslate || isAgent || isAgentAddressed
                            ? "bg-primary/10 text-primary dark:bg-primary/15"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {isTranslate
                          ? t("promptStudio.test.translation")
                          : isAgent || isAgentAddressed
                            ? t("promptStudio.test.instruction")
                            : t("promptStudio.test.cleanup")}
                      </span>
                    )}
                  </div>
                  <Textarea
                    dir="auto"
                    value={testText}
                    onChange={(e) => setTestText(e.target.value)}
                    rows={3}
                    className="text-xs"
                    placeholder={t("promptStudio.test.inputPlaceholder")}
                  />
                  {/* The agent tab always runs the agent prompt, addressed or not. */}
                  {!isAgent && (
                    <p className="text-xs text-muted-foreground/70 mt-1.5">
                      {isTranslate
                        ? t("promptStudio.test.translateHint", {
                            language: getLanguageLabel(translationTargetLanguage),
                          })
                        : t("promptStudio.test.addressHint", { agentName })}
                    </p>
                  )}
                </div>

                <div className="px-5 py-4">
                  <Button
                    onClick={testPrompt}
                    disabled={
                      !testText.trim() ||
                      isLoading ||
                      candidateIsEmpty ||
                      (!isTranslate && !isAgent && !useCleanupModel)
                    }
                    size="sm"
                    className="w-full"
                  >
                    <Play className="w-3.5 h-3.5 me-2" />
                    {isLoading ? t("promptStudio.test.processing") : t("promptStudio.test.run")}
                  </Button>
                  {candidateIsEmpty && (
                    <p className="text-xs text-muted-foreground/70 mt-1.5">
                      {t("promptStudio.library.emptyPrompt")}
                    </p>
                  )}
                  {isCleanupKind && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        onClick={() => void saveAsTestCase()}
                        disabled={!testText.trim()}
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                      >
                        {t("promptStudio.test.saveAsCase")}
                      </Button>
                      {caseNotice && (
                        <p className="text-xs text-muted-foreground/80">{caseNotice}</p>
                      )}
                    </div>
                  )}
                </div>

                {testResult && (
                  <div className="px-5 py-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-medium text-foreground">
                        {t("promptStudio.test.outputLabel")}
                      </p>
                      <Button
                        onClick={() => copyText(testResult)}
                        variant="ghost"
                        size="icon"
                        className="h-6 w-7"
                      >
                        <Copy className="w-3 h-3 text-muted-foreground" />
                      </Button>
                    </div>
                    <div className="bg-muted/30 dark:bg-surface-raised/30 border border-border/70 rounded-lg p-4 max-h-48 overflow-y-auto">
                      <pre
                        dir="auto"
                        className="text-xs text-foreground whitespace-pre-wrap leading-relaxed"
                      >
                        {testResult}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
      </div>
    </div>
  );
}
