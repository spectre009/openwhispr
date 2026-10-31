// "Sort into categories" › Ask a model at run time. The same models and the
// same request rules as Tidy up's review (services/dictionaryReview.ts): the
// Cleanup, Chat and Voice Assistant models that are reachable, one per
// provider · model, GitHub Copilot only for the scopes it serves; the
// request is ReasoningService.processText with the review's own fixed system
// prompt as `systemPrompt`, that scope's provider and settings, logs
// redacted, a complete reply required, giving way to a dictation on a local
// model, tagged with a requestId so Cancel can abort it.

import {
  cancelDictionaryReview,
  reviewModelOptions,
  runDictionaryReview,
  type ProcessText,
  type ReviewModelOption,
} from "./dictionaryReview";
import type { CategoryReviewRequest } from "../utils/dictionaryCategoryReview";

export { reviewModelOptions as categoryReviewModelOptions };
export type { ProcessText, ReviewModelOption };

/** Sends the category review. Resolves the model's reply as text. */
export function runDictionaryCategoryReview(
  option: ReviewModelOption,
  request: Pick<CategoryReviewRequest, "systemPrompt" | "text">,
  options: { requestId?: string; process?: ProcessText } = {}
): Promise<string> {
  return runDictionaryReview(option, request, options);
}

/** Frees a local model's slot from a cancelled review; other routes finish and are discarded. */
export function cancelDictionaryCategoryReview(requestId: string | null | undefined): void {
  cancelDictionaryReview(requestId);
}
