import { getCleanupSystemPrompt, type CleanupPromptOverride } from "../config/prompts";
import { getSettings } from "../stores/settingsStore";
import { resolveCleanupLanguage } from "../utils/chineseScript";
import { getDictionaryHintWords } from "../utils/snippets";
import type { InferenceScope } from "../config/inferenceScopes";
import type { ScreenContextImage } from "../types/electron";

export interface ReasoningConfig {
  maxTokens?: number;
  temperature?: number;
  contextSize?: number;
  systemPrompt?: string;
  lanUrl?: string;
  baseUrl?: string;
  customApiKey?: string;
  provider?: string;
  disableThinking?: boolean;
  /** Screenshot attached to voice-agent requests when screen context is on. */
  screenContext?: ScreenContextImage;
  /** Suffix-free prompt used when a screenshot-carrying request is retried text-only. */
  textOnlySystemPrompt?: string;
  language?: string;
  requireCompleteOutput?: boolean;
  /** Bundled local server only; callers must validate the decoded response. */
  responseFormat?: { type: "json_object"; schema: Record<string, unknown> };
  /**
   * Local models only: when the prompt leaves less than `maxTokens` of room and
   * the reply fills what is left, fail as CONTEXT_TOO_LARGE instead of
   * returning a reply the context window clipped. With `requireCompleteOutput`,
   * it still lets the allowance shrink to fit, where that flag alone refuses.
   */
  refuseClippedByWindow?: boolean;
  /** Local models only: tags the request so `cancelLocalReasoning` can abort it. */
  requestId?: string;
  requiresAgent?: boolean;
  inferenceScope?: InferenceScope;
  /**
   * Cleanup requests only (no systemPrompt): which cleanup prompt to run in
   * place of the saved one, as a real dictation would if it were saved. Read
   * by processText and never forwarded to a provider.
   */
  cleanupPrompt?: CleanupPromptOverride;
  /**
   * Cleanup requests only (no systemPrompt): a dictation style run in the same
   * request as cleanup (a style's one-step mode). `block` is appended to the
   * cleanup system prompt (and to the prompt OpenWhispr Cloud is given), and
   * the transcript's closing line names the style. Read by processText and
   * never forwarded to a provider.
   */
  cleanupStyle?: CleanupStyle;
  /**
   * Told the provider and model a request is actually dispatched to, once
   * routing (managed scopes, implicit cleanup providers) has resolved them,
   * and the system prompt it sends (see DispatchedPrompt). Called once per
   * dispatch. Read by processText and never forwarded to a provider.
   */
  onDispatch?: (dispatched: { provider: string; model: string; prompt?: DispatchedPrompt }) => void;
  /**
   * Cleanup requests only: the dictionary, cleanup language and UI language
   * the cleanup prompt is built with, captured when a test run started, so a
   * dictionary or language change mid-run can't change what later requests
   * send. Read by processText and never forwarded to a provider.
   */
  promptInputs?: CleanupPromptInputs;
  /**
   * Leaves the request's and response's text out of every log line (prompt
   * tests): no request body, response excerpt or result preview, metadata only.
   */
  redactLogs?: boolean;
  /**
   * Local models only: a background request that gives way to a dictation
   * (test-set runs). Main refuses it while a dictation is underway and aborts
   * it, freeing the model, when one starts; it fails as YIELDED_TO_DICTATION.
   */
  yieldToDictation?: boolean;
}

/** A style folded into a cleanup request (ReasoningConfig.cleanupStyle). */
export interface CleanupStyle {
  /** The style's name, quoted in the transcript's closing line. */
  name: string;
  /** Appended to the cleanup system prompt, after a blank line. */
  block: string;
}

/** What a cleanup system prompt is built from besides its template. */
export interface CleanupPromptInputs {
  customDictionary: string[];
  /** The cleanup language (resolveCleanupLanguage), "auto" kept as is. */
  preferredLanguage: string;
  uiLanguage: string;
}

/**
 * The system prompt one request is sent with, for step history:
 * - resolved: `text` is exactly what the app sent (after substitutions, the
 *   language instruction and the dictionary suffix);
 * - server: OpenWhispr Cloud builds the prompt on its server, so it isn't
 *   available here and is never reconstructed.
 * `entryId` is the prompt library entry in use ("default" = built-in) when
 * known. The text is private: persist it, never log it.
 */
export type DispatchedPrompt =
  | { source: "resolved"; text: string; entryId?: string | null }
  | { source: "server"; entryId?: string | null };

export abstract class BaseReasoningService {
  protected isProcessing = false;

  protected getCustomDictionary(): string[] {
    return getDictionaryHintWords(getSettings());
  }

  // Auto must remain auto here: zh-CN/zh-TW instructions make cleanup write its
  // entire response in Chinese before the transcription language is known. The
  // final deterministic script pass handles likely-Chinese output instead. See #975.
  protected getPreferredLanguage(): string {
    return resolveCleanupLanguage(getSettings().preferredLanguage);
  }

  protected getUiLanguage(): string {
    return getSettings().uiLanguage || "en";
  }

  /**
   * `cleanupTemplate` is the request's cleanup prompt ("" = built-in); omitted, the saved one.
   * `inputs`, when given, replaces the dictionary and languages read from settings.
   */
  protected getSystemPrompt(
    agentName: string | null,
    cleanupTemplate?: string,
    inputs?: CleanupPromptInputs
  ): string {
    return getCleanupSystemPrompt(
      agentName,
      inputs ? inputs.customDictionary : this.getCustomDictionary(),
      inputs ? inputs.preferredLanguage : this.getPreferredLanguage(),
      inputs ? inputs.uiLanguage : this.getUiLanguage(),
      cleanupTemplate
    );
  }

  protected calculateMaxTokens(
    textLength: number,
    minTokens = 100,
    maxTokens = 2048,
    multiplier = 2
  ): number {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }

  abstract isAvailable(): Promise<boolean>;

  abstract processText(
    text: string,
    modelId: string,
    agentName?: string | null,
    config?: ReasoningConfig
  ): Promise<string>;
}
