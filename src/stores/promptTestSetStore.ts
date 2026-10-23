import { create } from "zustand";
import type {
  PromptTestCase,
  PromptTestCaseEditable,
  PromptTestCaseList,
  PromptTestCaseWriteResult,
  PromptTestCasesChange,
  PromptTestStorageReason,
} from "../types/electron";
import { STARTER_TEST_CASES, type StarterTestCase } from "../config/promptTestStarters";
import {
  DEFAULT_REPETITIONS,
  MAX_RUN_CASES,
  clampRepetitions,
  runPromptTests,
  type RunCase,
  type RunProgress,
} from "../services/promptTestRunner";
import {
  captureCleanupPrompt,
  captureCleanupPromptInputs,
  cleanupRouteKey,
  pinDictationCleanupRequest,
  runCleanupWithPrompt,
  type CleanupPromptOverride,
} from "../services/cleanupWithPrompt";
import { dictationGate } from "../services/dictationGate";
import { getGlossarySnapshot, syncGlossaryRules, useGlossaryStore } from "./glossaryStore";
import { getSettings } from "./settingsStore";
import logger from "../utils/logger";

// Prompt Studio's test set in this window: main's cases for the current owner
// (main owns them, see helpers/promptTestCases.js), which built-in starters
// are hidden, and the current or last run. Results live in memory for the
// session only, and an account change cancels a run and clears them: they
// hold that account's dictations.

const HIDDEN_STARTERS_KEY = "promptTestSet.hiddenStarters";

const STORAGE_NOTICE: Record<PromptTestStorageReason, string> = {
  "history-off": "promptStudio.testSet.storage.historyOff",
  "policy-off": "promptStudio.testSet.storage.policyOff",
  pending: "promptStudio.testSet.storage.pending",
  unavailable: "promptStudio.testSet.storage.unavailable",
};

/** i18n key explaining why a new case is kept for this session only. */
export function storageNoticeKey(reason: PromptTestStorageReason | null | undefined): string {
  return STORAGE_NOTICE[reason ?? "unavailable"] ?? STORAGE_NOTICE.unavailable;
}

export interface TestRunInfo {
  id: number;
  owner: string;
  promptA: { name: string };
  promptB: { name: string };
  provider: string;
  model: string;
  repetitions: number;
  startedAt: number;
  /** Cases past the cap that this run left out. */
  casesLeftOut: number;
  progress: RunProgress;
}

interface PromptTestSetState {
  loaded: boolean;
  /** The owner main listed the cases for ("account:<id>" or "signed-out"). */
  owner: string | null;
  cases: PromptTestCase[];
  /** Where a new case is kept: stored, or for this session only (and why). */
  durable: boolean;
  storageReason: PromptTestStorageReason | null;
  hiddenStarters: string[];
  repetitions: number;
  run: TestRunInfo | null;
}

function readHiddenStarters(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const parsed = JSON.parse(localStorage.getItem(HIDDEN_STARTERS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeHiddenStarters(ids: string[]): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(HIDDEN_STARTERS_KEY, JSON.stringify(ids));
    }
  } catch {
    // A preference that can't be saved stays for this session.
  }
}

export const usePromptTestSetStore = create<PromptTestSetState>()(() => ({
  loaded: false,
  owner: null,
  cases: [],
  durable: false,
  storageReason: null,
  hiddenStarters: readHiddenStarters(),
  repetitions: DEFAULT_REPETITIONS,
  run: null,
}));

const getState = () => usePromptTestSetStore.getState();
const setState = usePromptTestSetStore.setState;

let activeRun: { id: number; controller: AbortController } | null = null;
let runCounter = 0;

/** An owner other than the one listed: cancel the run and drop its results. */
function handleOwner(owner: string | null): void {
  const current = getState().owner;
  if (current === null || owner === current) return;
  activeRun?.controller.abort("account");
  activeRun = null;
  setState({ run: null });
}

function applyList(list: PromptTestCaseList): void {
  handleOwner(list.owner);
  setState({
    loaded: true,
    owner: list.owner,
    cases: Array.isArray(list.cases) ? list.cases : [],
    durable: list.durable === true,
    storageReason: list.reason ?? null,
  });
}

/** Re-reads the current owner's cases from main. */
export async function loadTestCases(): Promise<void> {
  const list = window.electronAPI?.listTestCases;
  if (!list) return;
  try {
    const result = await list();
    if (result?.success) applyList(result);
    else if (result) handleOwner(result.owner ?? null);
  } catch (error) {
    logger.warn("Couldn't load test cases", { error: (error as Error)?.message }, "prompt-tests");
  }
}

let subscribed = false;

/** Loads the cases and follows main's changes for the window's lifetime. Safe to call often. */
export function followTestCases(): void {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!subscribed && api?.onTestCasesChanged) {
    subscribed = true;
    api.onTestCasesChanged((change: PromptTestCasesChange) => {
      handleOwner(change?.owner ?? null);
      void loadTestCases();
    });
  }
  void loadTestCases();
}

async function write(
  call: (() => Promise<PromptTestCaseWriteResult>) | undefined
): Promise<PromptTestCaseWriteResult> {
  if (!call) return { success: false, code: "FAILED" };
  try {
    const result = await call();
    void loadTestCases();
    return result ?? { success: false, code: "FAILED" };
  } catch (error) {
    logger.warn("Test case not saved", { error: (error as Error)?.message }, "prompt-tests");
    return { success: false, code: "FAILED" };
  }
}

/** History → "Add to test set": main copies the row's raw transcript. */
export function pinHistoryTestCase(transcriptionId: number) {
  const api = window.electronAPI;
  return write(api?.pinHistoryTestCase && (() => api.pinHistoryTestCase!(transcriptionId)));
}

/** Prompt Studio's Test → "Save as test case": the input as typed. */
export function saveTestCaseFromInput(rawText: string) {
  const api = window.electronAPI;
  return write(api?.saveTestCase && (() => api.saveTestCase!({ rawText })));
}

export function updateTestCase(id: string, patch: PromptTestCaseEditable) {
  const api = window.electronAPI;
  return write(api?.updateTestCase && (() => api.updateTestCase!(id, patch)));
}

export function deleteTestCase(id: string) {
  const api = window.electronAPI;
  return write(api?.deleteTestCase && (() => api.deleteTestCase!(id)));
}

export function clearTestCases() {
  const api = window.electronAPI;
  return write(api?.clearTestCases && (() => api.clearTestCases!()));
}

export function hideStarter(id: string): void {
  const hidden = [...new Set([...getState().hiddenStarters, id])];
  writeHiddenStarters(hidden);
  setState({ hiddenStarters: hidden });
}

export function showAllStarters(): void {
  writeHiddenStarters([]);
  setState({ hiddenStarters: [] });
}

export function setRepetitions(value: number): void {
  setState({ repetitions: clampRepetitions(value) });
}

/** The starters still shown. */
export function visibleStarters(hidden: string[]): StarterTestCase[] {
  const hiddenSet = new Set(hidden);
  return STARTER_TEST_CASES.filter((starter) => !hiddenSet.has(starter.id));
}

/**
 * The cases a run sends, in order: the owner's own cases first, then the
 * shown starters, so the 50-case cap keeps the user's own.
 */
export function buildRunCases(
  stored: PromptTestCase[],
  hiddenStarters: string[],
  labels: {
    starter: (starter: StarterTestCase) => string;
    stored: (testCase: PromptTestCase) => string;
  }
): RunCase[] {
  const own: RunCase[] = stored
    .filter((testCase) => testCase.target === "cleanup")
    .map((testCase) => ({
      id: testCase.id,
      label: labels.stored(testCase),
      rawText: testCase.rawText,
      targetApp: testCase.targetApp,
      referenceText: testCase.referenceText,
      mustContain: testCase.mustContain,
      mustNotContain: testCase.mustNotContain,
      matchCase: testCase.matchCase,
      source: testCase.source,
      sourceTranscriptionId: testCase.sourceTranscriptionId,
    }));
  const starters: RunCase[] = visibleStarters(hiddenStarters).map((starter) => ({
    id: starter.id,
    label: labels.starter(starter),
    rawText: starter.rawText,
    targetApp: starter.targetApp,
    referenceText: null,
    mustContain: [...starter.mustContain],
    mustNotContain: [...starter.mustNotContain],
    matchCase: starter.matchCase,
    source: "starter",
    sourceTranscriptionId: null,
  }));
  return [...own, ...starters];
}

export interface StartTestRunParams {
  cases: RunCase[];
  /** B: the selected prompt or its unsaved draft. A is the prompt in use when the run starts. */
  promptB: CleanupPromptOverride;
  names: { a: string; b: string };
  agentName: string | null;
  /** For display: where the requests go. */
  destination: { provider: string; model: string };
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

const newRequestId = () =>
  `prompt-test-${
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }`;

/**
 * Starts a run. Everything it sends is fixed now: prompt A (the one in use)
 * and B, the request with its provider pinned, the prompt's dictionary and
 * languages, the glossary snapshot and the snippets. Nothing saved changes.
 */
export async function startTestRun(
  params: StartTestRunParams
): Promise<{ started: boolean; code?: "RUNNING" | "OWNER_UNKNOWN" | "NO_CASES" }> {
  if (activeRun) return { started: false, code: "RUNNING" };
  if (params.cases.length === 0) return { started: false, code: "NO_CASES" };
  const listed = await window.electronAPI?.listTestCases?.();
  if (!listed?.success || !listed.owner) return { started: false, code: "OWNER_UNKNOWN" };
  applyList(listed);
  if (activeRun) return { started: false, code: "RUNNING" };
  if (!useGlossaryStore.getState().loaded) await syncGlossaryRules();

  const settings = getSettings();
  const promptA = captureCleanupPrompt({ mode: "inherit" }, settings.customPrompts.cleanup);
  const promptB = captureCleanupPrompt(params.promptB, settings.customPrompts.cleanup);
  const request = pinDictationCleanupRequest(settings);
  const promptInputs = captureCleanupPromptInputs(settings);
  const routeKey = cleanupRouteKey(settings);
  const glossary = getGlossarySnapshot();
  const snippets = Array.isArray(settings.snippets) ? settings.snippets : null;
  const repetitions = getState().repetitions;
  const cases = params.cases.slice(0, MAX_RUN_CASES);

  const id = ++runCounter;
  const controller = new AbortController();
  activeRun = { id, controller };
  const owner = listed.owner;
  const initial: RunProgress = {
    phase: "running",
    total: 0,
    done: 0,
    stopReason: null,
    results: [],
  };
  setState({
    run: {
      id,
      owner,
      promptA: { name: params.names.a },
      promptB: { name: params.names.b },
      provider: params.destination.provider,
      model: params.destination.model,
      repetitions,
      startedAt: Date.now(),
      casesLeftOut: Math.max(0, params.cases.length - cases.length),
      progress: initial,
    },
  });
  const update = (progress: RunProgress) => {
    const run = getState().run;
    if (run?.id === id) setState({ run: { ...run, progress } });
  };

  const release = dictationGate.retain();
  try {
    const final = await runPromptTests(
      { cases, repetitions, glossary, snippets },
      {
        send: (side, text, requestId) =>
          runCleanupWithPrompt(text, side === "A" ? promptA : promptB, {
            agentName: params.agentName,
            request: {
              model: request.model,
              config: { ...request.config, promptInputs, requestId, yieldToDictation: true },
            },
            redactLogs: true,
          }),
        waitForDictation: (signal, onPause) => dictationGate.waitForIdle(signal, onPause),
        sleep: abortableSleep,
        now: () => Date.now(),
        newRequestId,
        routeUnchanged: () => cleanupRouteKey(getSettings()) === routeKey,
        cancelRequest: (requestId) => {
          void window.electronAPI?.cancelLocalReasoning?.(requestId)?.catch?.(() => {});
        },
        onUpdate: update,
      },
      controller.signal
    );
    update(final);
    // Counts only: the results hold dictated text.
    logger.info(
      "Prompt test run finished",
      { requests: final.total, done: final.done, stopReason: final.stopReason },
      "prompt-tests"
    );
  } catch (error) {
    logger.error("Prompt test run failed", { error: (error as Error)?.message }, "prompt-tests");
    const run = getState().run;
    if (run?.id === id) {
      setState({
        run: {
          ...run,
          progress: { ...run.progress, phase: "finished", stopReason: "errors" },
        },
      });
    }
  } finally {
    release();
    if (activeRun?.id === id) activeRun = null;
  }
  return { started: true };
}

/** Stop: the run ends before its next request. */
export function stopTestRun(): void {
  activeRun?.controller.abort("user");
}

/** Forgets the last run's results (not while one runs). */
export function clearTestResults(): void {
  if (activeRun) return;
  setState({ run: null });
}

export function isTestRunActive(): boolean {
  return activeRun !== null;
}
