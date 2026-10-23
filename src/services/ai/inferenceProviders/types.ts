import type { ReasoningConfig } from "../../BaseReasoningService";

export interface ProviderContext {
  getApiKey(provider: string): Promise<string>;
  /** The cleanup system prompt of this request (its cleanup prompt, substituted). */
  getSystemPrompt(agentName: string | null): string;
  /**
   * The request's unsubstituted cleanup prompt, or undefined for the built-in
   * default: what OpenWhispr Cloud takes as `customPrompt`.
   */
  getCleanupCustomPrompt(): string | undefined;
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
