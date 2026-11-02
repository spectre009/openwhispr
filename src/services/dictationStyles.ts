// Dictation styles at run time: the restyle request (step two), the one-step
// request (cleanup plus the style), and the chain that runs a styled
// dictation with its fallbacks. Shared by the dictation route (audioManager),
// retry from history and the style editor's Test, so each sends what a
// dictation would.
//
// Both requests run on the dictationCleanup scope with the cleanup thinking
// setting, the cleanup sampling and `requireCompleteOutput`, on the cleanup
// provider and model, with an output budget sized for a reformatted message.
// OpenWhispr Cloud returns no finish reason, so styled requests there end
// with a completion marker and a reply without it counts as cut off. An empty
// or cut-off reply keeps the text the style was given (styleChain.js).

import type { ReasoningConfig } from "./BaseReasoningService";
import type { DictationCleanupRequest } from "./cleanupWithPrompt";
import { TRUNCATED_OUTPUT_MESSAGE_KEY } from "./ai/chatRequestBody";
import { finishCleanupOutput } from "../utils/cleanupOutput";
import { buildDictationCleanupConfig, cleanupStepMeta } from "../helpers/dictationCleanupConfig";
import { executeStyleChain } from "../helpers/styleChain";
import { passthroughStep, type RecordStep } from "../helpers/postTranscription";
import {
  buildOneStepStyleBlock,
  buildRestylePrompt,
  restoreDelimiters,
  styleOutputTokens,
  takeMarkedReply,
  wrapRestyleText,
} from "../config/styles/restylePrompt";
import type { RecordingStyle, StyleRunMode } from "../config/styles/library";
import {
  getEffectiveCleanupModel,
  getSettings,
  isCloudCleanupMode,
  selectResolvedLLMConfig,
  type SettingsState,
} from "../stores/settingsStore";

export type ProcessText = (
  text: string,
  model: string,
  agentName: string | null,
  config: ReasoningConfig
) => Promise<string>;

// Loaded on first use: the dictation route sends through its own call
// (audioManager.processWithReasoningModel) and never needs it here.
const defaultProcess: ProcessText = async (text, model, agentName, config) => {
  const { default: ReasoningService } = await import("./ReasoningService");
  return ReasoningService.processText(text, model, agentName, config);
};

/** The dictation's cleanup request with these settings (cleanupWithPrompt's, without its imports). */
function dictationCleanupRequest(settings: SettingsState): DictationCleanupRequest {
  return {
    model: getEffectiveCleanupModel(settings) || "",
    config: buildDictationCleanupConfig(settings),
  };
}

/**
 * Whether a style can run: a model is reachable for the cleanup scope. The
 * cleanup switch doesn't matter; with cleanup off a style restyles the
 * transcript as it came from the glossary.
 */
export function isStyleReachable(settings: SettingsState = getSettings()): boolean {
  const cleanup = selectResolvedLLMConfig(settings, "dictationCleanup");
  return !!cleanup?.model?.trim() || isCloudCleanupMode();
}

/** Where a cleanup-scope request goes when it names no provider (processText's rule). */
function goesToOpenWhisprCloud(
  request: DictationCleanupRequest,
  settings: Pick<SettingsState, "cleanupMode">
): boolean {
  const provider =
    request.config.provider ?? (settings.cleanupMode === "openwhispr" ? "openwhispr" : undefined);
  return provider === "openwhispr";
}

export interface StyleRequestOptions {
  agentName: string | null;
  settings?: SettingsState;
  /**
   * The cleanup request the style rides on (a test run pins its provider);
   * the dictation's own cleanup request by default.
   */
  request?: DictationCleanupRequest;
  /** Added to the request: a test run's request id, captured prompt and inputs. */
  extra?: Partial<ReasoningConfig>;
  onDispatch?: ReasoningConfig["onDispatch"];
  redactLogs?: boolean;
  /** The call that sends it; ReasoningService.processText by default. */
  process?: ProcessText;
  /** The voice block (reserved); empty until a voice profile exists. */
  voice?: string;
}

function styleTruncatedError(): Error {
  return Object.assign(new Error("The styled reply was cut off"), {
    code: "STYLE_OUTPUT_TRUNCATED",
    messageKey: TRUNCATED_OUTPUT_MESSAGE_KEY,
  });
}

/**
 * Turns a styled reply into the text to paste: Cloud's completion marker is
 * required and removed, the delimiters a dictation said are restored, and a
 * reply that repeats its input twice is rejected like a cleanup reply.
 */
export function finishStyledReply(reply: string, input: string, { cloud = false } = {}): string {
  let text = typeof reply === "string" ? reply : "";
  if (cloud && text.trim()) {
    const body = takeMarkedReply(text);
    if (body === null) throw styleTruncatedError();
    text = body;
  }
  text = restoreDelimiters(text).trim();
  if (text) text = finishCleanupOutput(input, text);
  return text;
}

/** The request of step two for `text`: the restyle prompt on the cleanup scope. */
export function buildRestyleRequest(
  text: string,
  style: Pick<RecordingStyle, "name" | "instruction">,
  {
    settings = getSettings(),
    request = dictationCleanupRequest(settings),
    voice = "",
  }: { settings?: SettingsState; request?: DictationCleanupRequest; voice?: string } = {}
): DictationCleanupRequest & { cloud: boolean } {
  const cloud = goesToOpenWhisprCloud(request, settings);
  return {
    model: request.model,
    cloud,
    config: {
      ...request.config,
      systemPrompt: buildRestylePrompt(style, { voice, completionMarker: cloud }),
      maxTokens: styleOutputTokens(text),
      requireCompleteOutput: true,
    },
  };
}

/** Step two: restyles already-cleaned `text`. Resolves the restyled text ("" when empty). */
export async function runRestyle(
  text: string,
  style: Pick<RecordingStyle, "name" | "instruction">,
  options: StyleRequestOptions
): Promise<string> {
  const settings = options.settings ?? getSettings();
  const { model, config, cloud } = buildRestyleRequest(text, style, {
    settings,
    request: options.request ?? dictationCleanupRequest(settings),
    voice: options.voice,
  });
  const process = options.process ?? defaultProcess;
  const reply = await process(wrapRestyleText(text, style.name), model, options.agentName, {
    ...config,
    ...options.extra,
    // Recorded as Styles' use of the connection, not Cleanup's.
    connectionFeature: "styles",
    ...(options.redactLogs ? { redactLogs: true } : {}),
    ...(options.onDispatch ? { onDispatch: options.onDispatch } : {}),
  });
  return finishStyledReply(reply, text, { cloud });
}

/**
 * One step: the cleanup request with the style folded in. The cleanup prompt
 * stays the cleanup override (the saved one unless `extra.cleanupPrompt`
 * says otherwise); the style block follows it and the closing line names the
 * style (ReasoningConfig.cleanupStyle).
 */
export async function runOneStepStyle(
  text: string,
  style: Pick<RecordingStyle, "name" | "instruction">,
  options: StyleRequestOptions
): Promise<string> {
  const settings = options.settings ?? getSettings();
  const request = options.request ?? dictationCleanupRequest(settings);
  const cloud = goesToOpenWhisprCloud(request, settings);
  const process = options.process ?? defaultProcess;
  const reply = await process(text, request.model, options.agentName, {
    ...request.config,
    ...options.extra,
    cleanupStyle: {
      name: style.name,
      block: buildOneStepStyleBlock(style, { voice: options.voice, completionMarker: cloud }),
    },
    connectionFeature: "styles",
    maxTokens: styleOutputTokens(text),
    requireCompleteOutput: true,
    ...(options.redactLogs ? { redactLogs: true } : {}),
    ...(options.onDispatch ? { onDispatch: options.onDispatch } : {}),
  });
  return finishStyledReply(reply, text, { cloud });
}

export interface StyledDictationParams extends Omit<StyleRequestOptions, "onDispatch"> {
  /** The glossary-corrected transcript. */
  text: string;
  style: RecordingStyle;
  /** The cleanup switch: off, the style restyles `text` in one request. */
  cleanupOn: boolean;
  /** The path's own cleanup call, which records its own step. */
  runCleanup: (text: string) => Promise<string | null | undefined>;
  recordStep?: RecordStep;
  /** Overrides the style's run mode (the editor's Test compares both). */
  runMode?: StyleRunMode;
  onCleanupError?: (error: unknown) => void;
  /** The style failed (threw, or nothing usable); the last good text is kept. */
  onStyleError?: (error: unknown) => void;
  wasCancelled?: () => boolean;
  /** Test runs: a failure rejects instead of falling back. */
  strict?: boolean;
}

export interface StyledDictationResult {
  text: string;
  applied: boolean;
  cleaned: boolean;
  mode: StyleRunMode;
  changed: boolean;
}

/**
 * A styled dictation: two steps (cleanup, then the restyle) or one step, with
 * every model call recorded as a step. The style step carries the style id
 * and the run mode, and its prompt is the one actually sent.
 */
export async function runStyledDictation(
  params: StyledDictationParams
): Promise<StyledDictationResult> {
  const {
    text,
    style,
    cleanupOn,
    runCleanup,
    recordStep = passthroughStep,
    runMode = style.runMode,
    onCleanupError,
    onStyleError,
    wasCancelled,
    strict,
    ...requestOptions
  } = params;
  const styleStep = (
    mode: StyleRunMode,
    call: (options: StyleRequestOptions) => Promise<string>
  ) => {
    // One step is the cleanup request itself: its dictionary (cleanup's word
    // set) is decided once, here, and the style step records it. Two steps
    // restyle with their own system prompt, which carries no dictionary.
    const request =
      mode === "one-step"
        ? (requestOptions.request ??
          dictationCleanupRequest(requestOptions.settings ?? getSettings()))
        : requestOptions.request;
    const scope = mode === "one-step" ? cleanupStepMeta(request?.config).detail : undefined;
    return recordStep(
      "style",
      { detail: { styleId: style.id, runMode: mode, ...(scope ?? {}) } },
      (dispatched) =>
        call({ ...requestOptions, ...(request ? { request } : {}), onDispatch: dispatched })
    );
  };
  return (await executeStyleChain({
    text,
    runMode,
    cleanupReachable: cleanupOn,
    runCleanup,
    runRestyle: (current: string) =>
      styleStep("two-step", (options) => runRestyle(current, style, options)),
    runOneStep: (current: string) =>
      styleStep("one-step", (options) => runOneStepStyle(current, style, options)),
    onCleanupError,
    onStyleError,
    wasCancelled,
    strict,
  })) as StyledDictationResult;
}
