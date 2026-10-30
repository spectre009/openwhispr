// Local Whisper's dictionary-echo recovery for History's Re-transcribe, the
// same rules live dictation applies in audioManager.processWithLocalWhisper:
// whisper.cpp can continue its initial prompt instead of transcribing, so a
// reply that is the dictionary (a strict echo) or a fragment of it in the
// prompt's own shape is decoded again without the prompt and without VAD, and
// that retry is adopted when it recovers real speech. A strict echo that
// isn't recovered fails as a dictionary echo, as it does live. Pure ESM;
// `transcribe` is the caller's (main's whisper manager). Never logs text.

import {
  analyzeDictionaryPromptFragment,
  dictionaryEchoError,
  matchesDictionaryPrompt,
} from "./dictionaryEchoFilter.js";

// As audioManager: a non-repeated fragment is only replaced on a recording at
// least this long, and only by a retry with this many more distinct words.
export const MIN_SPARSE_RECORDING_DURATION_SECONDS = 3;
export const MIN_UNIQUE_WORD_GAIN = 2;

/**
 * Transcribes with `prompt` as the initial prompt, then recovers an echo.
 * `options`: the request's own options (model, language, VAD). Resolves the
 * transcriber's result (the retry's when it was adopted); throws the
 * dictionary-echo error for an unrecovered strict echo. `onRecovery` hears
 * `{ reason, recovered }` (no text).
 */
export async function transcribeWithEchoRecovery({
  transcribe,
  options = {},
  prompt = null,
  dictionaryPrompt = null,
  durationSeconds = null,
  onRecovery = null,
}) {
  const first = await transcribe(prompt ? { ...options, initialPrompt: prompt } : { ...options });
  if (!first?.success || !first.text || !prompt) return first;

  const strictEcho =
    matchesDictionaryPrompt(first.text, prompt) ||
    matchesDictionaryPrompt(first.text, dictionaryPrompt);
  const initialFragment = analyzeDictionaryPromptFragment(first.text, prompt);
  const promptFragment = !strictEcho && initialFragment.isPromptFragment;
  const retryCanBeAdopted =
    strictEcho ||
    initialFragment.hasRepeatedWords ||
    (Number.isFinite(durationSeconds) && durationSeconds >= MIN_SPARSE_RECORDING_DURATION_SECONDS);
  if (!(strictEcho || promptFragment) || !retryCanBeAdopted) return first;

  let retry = null;
  try {
    retry = await transcribe({
      model: options.model,
      ...(options.language ? { language: options.language } : {}),
      skipVad: true,
    });
  } catch (error) {
    if (strictEcho) throw error;
    // A heuristic recovery is best-effort; the first transcript stands.
  }

  const retryText = retry?.success && typeof retry.text === "string" ? retry.text : "";
  const hasRetryText = Boolean(retryText.trim());
  const retryFragment = analyzeDictionaryPromptFragment(retryText, prompt);
  const retryStrictEcho = Boolean(
    hasRetryText &&
    (matchesDictionaryPrompt(retryText, prompt) ||
      matchesDictionaryPrompt(retryText, dictionaryPrompt))
  );
  const retryStillPromptLike = strictEcho
    ? retryStrictEcho
    : retryStrictEcho || retryFragment.isPromptFragment;
  const retryAddsUniqueWords = retryFragment.uniqueWordCount > initialFragment.uniqueWordCount;
  const repeatedFragmentRecovered = initialFragment.hasRepeatedWords && retryAddsUniqueWords;
  const sparseRecordingRecovered =
    Number.isFinite(durationSeconds) &&
    durationSeconds >= MIN_SPARSE_RECORDING_DURATION_SECONDS &&
    retryFragment.uniqueWordCount >= initialFragment.uniqueWordCount + MIN_UNIQUE_WORD_GAIN;
  const recovered =
    hasRetryText &&
    !retryStillPromptLike &&
    (strictEcho || repeatedFragmentRecovered || sparseRecordingRecovered);

  onRecovery?.({ reason: strictEcho ? "strict-echo" : "prompt-fragment", recovered });
  if (recovered) return retry;
  if (strictEcho) throw dictionaryEchoError();
  return first;
}
