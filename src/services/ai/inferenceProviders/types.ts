import type { ReasoningConfig } from "../../BaseReasoningService";
import type { DictationToneStyle } from "../../../config/toneStyle";

export interface ProviderContext {
  getApiKey(provider: string): Promise<string>;
  /**
   * The cleanup system prompt of this request (its cleanup prompt, substituted),
   * with the tone-style instruction for the target app when one is given.
   */
  getSystemPrompt(agentName: string | null, toneStyle?: DictationToneStyle | null): string;
  /**
   * The request's unsubstituted cleanup prompt, or undefined for the built-in
   * default: what OpenWhispr Cloud takes as `customPrompt`.
   */
  getCleanupCustomPrompt(): string | undefined;
  /**
   * The cleanup request's user message for `text`; absent, the shared
   * wrapCleanupTranscript. A styled cleanup (one step) names its style here.
   */
  wrapCleanupTranscript?(text: string): string;
  getCustomDictionary(): string[];
  getPreferredLanguage(): string;
  getUiLanguage(): string;
  callChatCompletionsApi(
    endpoint: string,
    apiKey: string,
    model: string,
    text: string,
    agentName: string | null,
    config: ReasoningConfig,
    providerName: string
  ): Promise<string>;
  calculateMaxTokens(
    textLength: number,
    minTokens?: number,
    maxTokens?: number,
    multiplier?: number
  ): number;
}

export interface ProviderCallParams {
  text: string;
  model: string;
  agentName: string | null;
  config: ReasoningConfig;
  ctx: ProviderContext;
}

export interface InferenceProvider {
  readonly id: string;
  /** True when this client can send `config.screenContext` as image content. */
  readonly supportsImages?: boolean;
  call(params: ProviderCallParams): Promise<string>;
}
