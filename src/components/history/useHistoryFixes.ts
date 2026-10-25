import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/useToast";
import { glossaryRuleInput, useGlossaryStore } from "../../stores/glossaryStore";
import { pinHistoryTestCase } from "../../stores/promptTestSetStore";
import { STYLE_LIST_FOCUS, requestStyleFocus } from "../../stores/styleStore";
import { styleIdFromRouteKind } from "../../config/styles/library";
import {
  alignCorrection,
  blamedStepIndex,
  cleanPhrase,
  firedGlossaryRules,
  glossaryRuleWithSpelling,
  historyFixKind,
  trimSpan,
  type FiredGlossaryRule,
  type HistoryFixKind,
} from "../../utils/historyFixes";
import type { GlossaryRule } from "../../utils/glossary";
import type {
  GlossaryRuleInput,
  HistoryItemResult,
  PromptTestCase,
  PromptTestStorageReason,
} from "../../types/electron";
import type { HistoryReviewController } from "./useHistoryReview";

// The fixes a 👎 review suggests for the step it blames (a draft's, or the
// saved review's): a glossary correction or a dictionary word from words the
// user selects in a step's text, a test case with checks the user picks, the
// prompt or style to edit, or the text to copy again. Each opens the editor
// or dialog for that thing; nothing is saved until the user saves there.

type LoadedItem = Extract<HistoryItemResult, { success: true }>;

const PROMPT_STUDIO_DESTINATION = "cleanup#dictation.cleanup.prompt";
const STYLES_DESTINATION = "styles";

/** Words selected in a step's text. */
export interface PickedText {
  /** The step (its seq) whose text they're in. */
  index: number;
  text: string;
  /** Where they are in the step's output; -1 when that couldn't be read. */
  start: number;
  end: number;
  /** Where the selection's actions float, in the steps' box. */
  top: number;
  inlineStart: number;
}

export interface FiredRuleFix extends FiredGlossaryRule {
  /** The rule as it is now; null once deleted. */
  rule: GlossaryRule | null;
}

export interface TestCaseFix {
  testCase: PromptTestCase;
  /** The dictation already was a case: that one is shown. */
  duplicate: boolean;
  durable: boolean;
  reason: PromptTestStorageReason | null;
  /** The final output and the review's correction, the checks are suggested from. */
  output: string;
  correction: string;
}

export interface GlossaryFix {
  rule: GlossaryRuleInput;
  /** An existing rule already had the selected spelling, so it's opened instead. */
  existingSpelling: string | null;
}

export interface HistoryFixesController {
  kind: HistoryFixKind | null;
  /** The blamed recorded step (its seq) or the delivery, to highlight. */
  blamed: number | "delivery" | null;
  /** Steps up to this seq offer fixes for words selected in their text. */
  selectableThrough: number | null;
  selection: PickedText | null;
  setSelection: Dispatch<SetStateAction<PickedText | null>>;
  firedRules: FiredRuleFix[];
  canPin: boolean;
  pinning: boolean;
  canCopy: boolean;
  openGlossary: (picked?: PickedText | null) => void;
  openDictionary: (picked?: PickedText | null) => void;
  editRule: (ruleId: string) => void;
  addToTestSet: () => void;
  openPromptStudio: () => void;
  editStyle: () => void;
  copyAgain: () => void;
  glossary: GlossaryFix | null;
  closeGlossary: () => void;
  dictionaryWord: string | null;
  closeDictionary: () => void;
  testCase: TestCaseFix | null;
  closeTestCase: () => void;
}

function clearDocumentSelection() {
  try {
    window.getSelection?.()?.removeAllRanges();
  } catch {
    // Nothing selected to clear.
  }
}

export function useHistoryFixes({
  result,
  review,
  onCopy,
  onOpenSettings,
}: {
  result: LoadedItem;
  review: HistoryReviewController;
  onCopy: (text: string) => void;
  onOpenSettings: (destination?: string) => void;
}): HistoryFixesController {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { item } = result;
  const steps = useMemo(() => (result.status === "captured" ? result.steps : []), [result]);
  const completed = item.status === "completed";
  const finalText = completed ? item.text : "";

  // The open draft's review, else the saved one when it's 👎.
  const { draft, feedback } = review;
  const active = draft
    ? { stage: draft.stage, correction: draft.expectedText }
    : feedback?.verdict === "bad"
      ? { stage: feedback.stage, correction: feedback.expectedText ?? finalText }
      : null;
  const stage = active?.stage ?? null;
  const correction = active?.correction ?? "";
  const kind = historyFixKind(stage, steps);
  const blamedIndex = blamedStepIndex(stage, steps);
  const blamed = stage?.kind === "delivery" ? "delivery" : blamedIndex;
  const selectableThrough = kind === "recognition" || kind === "glossary" ? blamedIndex : null;

  const [selection, setSelection] = useState<PickedText | null>(null);
  const [pinning, setPinning] = useState(false);
  const [glossary, setGlossary] = useState<GlossaryFix | null>(null);
  const [dictionaryWord, setDictionaryWord] = useState<string | null>(null);
  const [testCase, setTestCase] = useState<TestCaseFix | null>(null);

  useEffect(() => {
    if (selectableThrough === null) setSelection(null);
  }, [selectableThrough]);

  const rules = useGlossaryStore((state) => state.rules);
  const firedRules = useMemo(
    () =>
      firedGlossaryRules(steps).map((fired) => ({
        ...fired,
        rule: rules.find((rule) => rule.id === fired.ruleId) ?? null,
      })),
    [steps, rules]
  );

  // The selected words as they are in the step's output, and the correction's words for them.
  const readPicked = useCallback(
    (picked: PickedText) => {
      const output = steps[picked.index]?.output ?? "";
      const span = picked.start >= 0 ? trimSpan(output, picked.start, picked.end) : null;
      const spelling = cleanPhrase(span ? output.slice(span.start, span.end) : picked.text);
      const aligned = span ? alignCorrection(output, span.start, span.end, correction) : null;
      return { spelling, aligned };
    },
    [steps, correction]
  );

  const openGlossary = (picked: PickedText | null = selection) => {
    if (!picked) return;
    const { spelling, aligned } = readPicked(picked);
    if (!spelling) return;
    clearDocumentSelection();
    setSelection(null);
    const existing = glossaryRuleWithSpelling(useGlossaryStore.getState().rules, spelling);
    if (existing) {
      setGlossary({ rule: glossaryRuleInput(existing), existingSpelling: spelling });
      return;
    }
    setGlossary({
      rule: {
        canonical: aligned ?? "",
        spellings: [{ text: spelling, scope: "anywhere" }],
        apps: [],
        enabled: true,
      },
      existingSpelling: null,
    });
  };

  // A dictionary word is the word speech-to-text should have written: the
  // correction's words for the selection when they line up, else the selection.
  const openDictionary = (picked: PickedText | null = selection) => {
    if (!picked) return;
    const { spelling, aligned } = readPicked(picked);
    const word = aligned ?? spelling;
    if (!word) return;
    clearDocumentSelection();
    setSelection(null);
    setDictionaryWord(word);
  };

  const editRule = (ruleId: string) => {
    const rule = useGlossaryStore.getState().rules.find((candidate) => candidate.id === ruleId);
    if (rule) setGlossary({ rule: glossaryRuleInput(rule), existingSpelling: null });
  };

  const canPin = completed && !!item.rawText?.trim();
  const addToTestSet = async () => {
    if (!canPin || pinning) return;
    const output = finalText;
    const expected = correction;
    setPinning(true);
    try {
      const reply = await pinHistoryTestCase(item.id);
      if (!reply.success || !reply.case) {
        toast({
          title: t("controlPanel.history.testSet.failed"),
          description:
            reply.code === "NO_RAW_TEXT" ? t("controlPanel.history.testSet.noRawText") : undefined,
          variant: "destructive",
        });
        return;
      }
      setTestCase({
        testCase: reply.case,
        duplicate: reply.duplicate === true,
        durable: reply.durable ?? reply.case.durable,
        reason: reply.reason ?? null,
        output,
        correction: expected,
      });
    } finally {
      setPinning(false);
    }
  };

  const editStyle = () => {
    const step = blamedIndex !== null ? steps[blamedIndex] : null;
    const styleId = step?.detail?.styleId ?? styleIdFromRouteKind(item.routeKind);
    requestStyleFocus(styleId ?? STYLE_LIST_FOCUS);
    onOpenSettings(STYLES_DESTINATION);
  };

  const canCopy = completed && !!item.text;

  return {
    kind,
    blamed,
    selectableThrough,
    selection,
    setSelection,
    firedRules,
    canPin,
    pinning,
    canCopy,
    openGlossary,
    openDictionary,
    editRule,
    addToTestSet: () => void addToTestSet(),
    openPromptStudio: () => onOpenSettings(PROMPT_STUDIO_DESTINATION),
    editStyle,
    copyAgain: () => {
      if (canCopy) onCopy(item.text);
    },
    glossary,
    closeGlossary: () => setGlossary(null),
    dictionaryWord,
    closeDictionary: () => setDictionaryWord(null),
    testCase,
    closeTestCase: () => setTestCase(null),
  };
}

// ─── Words selected in a step's text ─────────────────────────────────────

/**
 * Where the selected words are in the step's own text. A step shown as
 * changes also holds what it deleted and the ↵ marks (HistoryDiffText marks
 * them), which aren't part of its output and are left out.
 */
function selectedSpan(root: HTMLElement, range: Range, output: string) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let shown = "";
  let start = -1;
  let end = -1;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    const hidden = !!node.parentElement?.closest("del, [data-diff-mark]");
    if (range.intersectsNode(node)) {
      const from = node === range.startContainer ? Math.min(range.startOffset, value.length) : 0;
      const to =
        node === range.endContainer ? Math.min(range.endOffset, value.length) : value.length;
      if (start < 0) start = shown.length + (hidden ? 0 : from);
      end = shown.length + (hidden ? 0 : to);
    }
    if (!hidden) shown += value;
  }
  if (shown !== output || start < 0 || end <= start) return null;
  return { start, end };
}

function pickSelection(
  container: HTMLElement,
  through: number,
  outputs: readonly (string | null)[]
): PickedText | null {
  const selection = container.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const holder = (node: Node) =>
    (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>(
      "[data-step-output]"
    ) ?? null;
  const root = holder(range.startContainer);
  if (!root || root !== holder(range.endContainer) || !container.contains(root)) return null;
  const index = Number(root.dataset.stepOutput);
  const output = outputs[index];
  if (!Number.isInteger(index) || index > through || typeof output !== "string") return null;

  let span = selectedSpan(root, range, output);
  let text = span ? output.slice(span.start, span.end) : selection.toString();
  if (!span) {
    const at = text.trim() ? output.indexOf(text.trim()) : -1;
    span = at >= 0 ? { start: at, end: at + text.trim().length } : { start: -1, end: -1 };
    text = text.trim();
  }
  if (!text.trim()) return null;

  let top = 0;
  let inlineStart = 0;
  try {
    const rect = range.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    const rtl = getComputedStyle(container).direction === "rtl";
    top = Math.max(0, rect.bottom - box.top + 6);
    inlineStart = Math.max(
      0,
      Math.min(box.width - 240, rtl ? box.right - rect.right : rect.left - box.left)
    );
  } catch {
    // No layout: the actions sit at the box's start.
  }
  return { index, text, start: span.start, end: span.end, top, inlineStart };
}

const samePicked = (a: PickedText | null, b: PickedText | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.index === b.index &&
    a.start === b.start &&
    a.end === b.end &&
    a.text === b.text &&
    a.top === b.top &&
    a.inlineStart === b.inlineStart);

/** Follows the document's selection while fixes from selected words apply. */
export function useStepTextSelection(
  containerRef: RefObject<HTMLElement | null>,
  fixes: HistoryFixesController,
  outputs: readonly (string | null)[]
) {
  const { selectableThrough, setSelection } = fixes;
  const outputsRef = useRef(outputs);
  useLayoutEffect(() => {
    outputsRef.current = outputs;
  });
  useEffect(() => {
    if (selectableThrough === null) return;
    const container = containerRef.current;
    if (!container) return;
    const doc = container.ownerDocument;
    const onChange = () => {
      const current = containerRef.current;
      const next = current ? pickSelection(current, selectableThrough, outputsRef.current) : null;
      setSelection((previous) => (samePicked(previous, next) ? previous : next));
    };
    onChange();
    doc.addEventListener("selectionchange", onChange);
    return () => doc.removeEventListener("selectionchange", onChange);
  }, [containerRef, selectableThrough, setSelection]);
}
