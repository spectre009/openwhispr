import { create } from "zustand";
import logger from "../utils/logger";
import { subscribeListsOwner, useSettingsStore } from "./settingsStore";
import { effectiveCategory } from "./dictionaryCategoriesStore";
import {
  dictionaryCategoryRevision,
  parseDictionaryCategoryReviewReply,
  type CategoryProposal,
  type CategoryReviewRequest,
} from "../utils/dictionaryCategoryReview";
import {
  cancelDictionaryCategoryReview,
  runDictionaryCategoryReview,
  type ProcessText,
  type ReviewModelOption,
} from "../services/dictionaryCategoryReview";

// "Sort into categories" › Ask a model, in this window: the request in
// flight, its validated proposals, and what the user dismissed (✕) or
// accepted this session. A reply is dropped when the dictionary or its
// categories changed while it ran (a revision taken at send), when it's
// malformed or oversized, or when it was cancelled. Nothing is stored
// without a click (dictionaryCategoriesStore.setDictionaryCategories, as
// "model"). Nothing here is logged but counts and codes.

export type CategoryReviewState =
  | { status: "idle" }
  | { status: "running"; optionId: string; modelName: string; requestId: string }
  | {
      status: "done";
      optionId: string;
      modelName: string;
      proposals: CategoryProposal[];
      kept: number;
      dropped: number;
    }
  | {
      status: "dropped";
      reason: "stale" | "malformed" | "oversized";
      modelName: string;
      dropped: number;
    }
  | { status: "error"; modelName: string; error: unknown };

interface DictionaryCategoryReviewState {
  review: CategoryReviewState;
  /** Proposals the user dismissed (✕) this session. */
  dismissed: ReadonlySet<string>;
  /** Proposals the user accepted this session. */
  accepted: ReadonlySet<string>;
}

export const useDictionaryCategoryReviewStore = create<DictionaryCategoryReviewState>()(() => ({
  review: { status: "idle" },
  dismissed: new Set<string>(),
  accepted: new Set<string>(),
}));

const getState = () => useDictionaryCategoryReviewStore.getState();
const setState = (partial: Partial<DictionaryCategoryReviewState>) =>
  useDictionaryCategoryReviewStore.setState(partial);

/** The dictionary and its categories now (every word, its effective category and who set it). */
export function currentCategoryRevision(): string {
  const words = useSettingsStore.getState().customDictionary;
  return dictionaryCategoryRevision(words.map((word) => ({ word, ...effectiveCategory(word) })));
}

let reviewGeneration = 0;

export interface AskCategoryReviewParams {
  option: ReviewModelOption;
  request: CategoryReviewRequest;
  /** The call that sends it (tests); ReasoningService.processText by default. */
  process?: ProcessText;
}

/** Sends the review; its validated proposals replace any earlier ones. */
export async function askCategoryReview({
  option,
  request,
  process,
}: AskCategoryReviewParams): Promise<void> {
  cancelCategoryReview();
  const generation = ++reviewGeneration;
  const requestId = `dictionary-category-review-${Date.now()}-${generation}`;
  const revision = currentCategoryRevision();
  const modelName = option.modelName;
  setState({ review: { status: "running", optionId: option.id, modelName, requestId } });
  try {
    const reply = await runDictionaryCategoryReview(option, request, {
      requestId,
      ...(process ? { process } : {}),
    });
    if (generation !== reviewGeneration) return;
    if (currentCategoryRevision() !== revision) {
      setState({ review: { status: "dropped", reason: "stale", modelName, dropped: 0 } });
      logger.debug("Dictionary category review dropped", { reason: "stale" }, "settings");
      return;
    }
    const parsed = parseDictionaryCategoryReviewReply(reply, { words: request.words });
    if (parsed.status !== "ok") {
      setState({
        review: { status: "dropped", reason: parsed.status, modelName, dropped: parsed.dropped },
      });
    } else {
      setState({
        review: {
          status: "done",
          optionId: option.id,
          modelName,
          proposals: parsed.proposals,
          kept: parsed.kept,
          dropped: parsed.dropped,
        },
        dismissed: new Set<string>(),
        accepted: new Set<string>(),
      });
    }
    logger.debug(
      "Dictionary category review finished",
      { status: parsed.status, kept: parsed.kept, dropped: parsed.dropped },
      "settings"
    );
  } catch (error) {
    if (generation !== reviewGeneration) return;
    setState({ review: { status: "error", modelName, error } });
    const failure = error as { code?: string; messageKey?: string };
    logger.warn(
      "Dictionary category review failed",
      { code: failure?.code ?? null, messageKey: failure?.messageKey ?? null },
      "settings"
    );
  }
}

/** Stops waiting: a local model's request is aborted, any other reply is discarded. */
export function cancelCategoryReview(): void {
  const { review } = getState();
  reviewGeneration += 1;
  if (review.status === "running") {
    cancelDictionaryCategoryReview(review.requestId);
    setState({ review: { status: "idle" } });
  }
}

/** ✕: the proposal leaves for this session; nothing changes. */
export function dismissCategoryProposal(id: string): void {
  const { dismissed } = getState();
  if (dismissed.has(id)) return;
  setState({ dismissed: new Set([...dismissed, id]) });
}

/** Marks proposals accepted (stored as "model" by the caller). */
export function markCategoryProposalsAccepted(ids: readonly string[]): void {
  if (ids.length === 0) return;
  setState({ accepted: new Set([...getState().accepted, ...ids]) });
}

/** Forgets the review: proposals for another account's list don't carry over. */
export function resetCategoryReview(): void {
  cancelCategoryReview();
  setState({ review: { status: "idle" }, dismissed: new Set(), accepted: new Set() });
}

// A settings store without account scoping (a test's stand-in) has no owner to follow.
if (typeof subscribeListsOwner === "function") subscribeListsOwner(resetCategoryReview);
