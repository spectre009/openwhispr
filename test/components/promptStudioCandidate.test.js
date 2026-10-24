const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Prompt Studio's Test runs the selected prompt, or its unsaved draft, in the
// request itself: a cleanup override for cleanup, an explicit system prompt
// for translation and the voice assistant. It never saves, switches or swaps
// the prompt in use (the editor's write actions throw if called).

const writeAction = (name) => () => {
  throw new Error(`Test must not call ${name}`);
};

function editorFor({ selected, draft }) {
  const isDefault = selected === "default";
  const saved = isDefault ? "built-in text" : "saved text";
  return {
    library: {
      version: 1,
      activeId: "in-use",
      entries: [
        { id: "in-use", name: "In use", text: "in-use text", updatedAt: 0, origin: "user" },
        { id: "picked", name: "Picked", text: saved, updatedAt: 0, origin: "user" },
      ],
    },
    selectedId: selected,
    selectedEntry: isDefault ? null : { id: selected, name: "Picked", text: saved },
    isDefaultSelected: isDefault,
    isSelectedActive: false,
    savedText: saved,
    editorText: draft ?? saved,
    isDirty: draft !== undefined,
    displayName: (id) => id,
    save: writeAction("save"),
    activateSelected: writeAction("activateSelected"),
    activateDefault: writeAction("activateDefault"),
    setDraft: writeAction("setDraft"),
  };
}

async function loadStudio(t) {
  const calls = { cleanup: [], reasoning: [], resolved: [] };
  globalThis.__studio = { calls, editor: null, hookCalls: 0 };
  t.after(() => {
    delete globalThis.__studio;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-prompt-studio-candidate-",
    noExternal: true,
    mockModules: {
      react: `
        export function useState(initial) {
          globalThis.__studio.hookCalls += 1;
          // The first state is the active tab: render the Test tab.
          const value = globalThis.__studio.hookCalls === 1
            ? "test"
            : typeof initial === "function" ? initial() : initial;
          return [value, () => {}];
        }
      `,
      "react/jsx-dev-runtime": `
        export const Fragment = Symbol.for("fragment");
        export function jsxDEV(type, props, key) { return { type, props, key }; }
      `,
      "react/jsx-runtime": `
        export const Fragment = Symbol.for("fragment");
        export function jsx(type, props, key) { return { type, props, key }; }
        export const jsxs = jsx;
      `,
      "react-i18next": "export function useTranslation() { return { t: (key) => key }; }",
      "zustand/react/shallow": "export function useShallow(selector) { return selector; }",
      "./button": "export function Button() {}",
      "./AutoGrowTextarea": "export function AutoGrowTextarea() {}",
      "./ClampedText": "export default function ClampedText() {}",
      "/icons": `
        export const Eye = () => null, Edit3 = () => null, Play = () => null, Copy = () => null,
          TestTube = () => null, AlertTriangle = () => null, Check = () => null, Info = () => null;
      `,
      "./PromptLibraryBar": `
        export default function PromptLibraryBar() { return null; }
        export function PromptDraftActions() { return null; }
      `,
      "./PromptTestSet": "export default function PromptTestSet() { return null; }",
      "/stores/promptTestSetStore": `
        export async function saveTestCaseFromInput() { return { success: true }; }
        export function storageNoticeKey() { return "notice"; }
      `,
      "/hooks/usePromptLibraryEditor": `
        export function usePromptLibraryEditor() { return globalThis.__studio.editor; }
      `,
      "/utils/agentName": `export function useAgentName() { return { agentName: "Jarvis" }; }`,
      "/services/ReasoningService": `
        export default {
          async processText(...args) {
            globalThis.__studio.calls.reasoning.push(args);
            return "translated";
          },
        };
      `,
      "/services/cleanupWithPrompt": `
        export async function runCleanupWithPrompt(...args) {
          globalThis.__studio.calls.cleanup.push(args);
          return "cleaned";
        }
      `,
      "/models/ModelRegistry": `export function getModelProvider() { return "openai"; }`,
      "/utils/logger": "export default { debug() {}, error() {} };",
      "/config/prompts": `
        export function resolvePromptText(kind, template, opts) {
          globalThis.__studio.calls.resolved.push({ kind, template, opts });
          return "resolved " + kind + ": " + template;
        }
      `,
      "/stores/settingsStore": `
        const state = Object.freeze({
          uiLanguage: "en",
          useCleanupModel: true,
          cleanupModel: "gpt-4.1-mini",
          cleanupCloudBaseUrl: "",
          useDictationAgent: true,
          dictationAgentMode: "providers",
          dictationAgentProvider: "openai",
          dictationAgentModel: "gpt-4.1-mini",
          useDictationTranslation: true,
          translationMode: "providers",
          translationProvider: "openai",
          translationModel: "gpt-4.1-mini",
          translationRemoteUrl: "",
          translationTargetLanguage: "fr",
          preferredLanguage: "en",
          cleanupDisableThinking: true,
        });
        export function useSettingsStore(selector) { return selector(state); }
        export function selectPolicyEffectiveSettings(settings) { return settings; }
        export const selectIsCloudCleanupMode = () => false;
        export const selectIsCloudDictationAgentMode = () => false;
        export const selectIsCloudTranslationMode = () => false;
      `,
      "/hooks/usePolicy": `
        export function usePolicySnapshot() { return { status: "unmanaged", policy: null }; }
      `,
      "/utils/languageSupport": "export function getLanguageLabel(value) { return value; }",
      "/utils/snippets": `export function getDictionaryHintWords() { return ["Kubernetes"]; }`,
      "/helpers/dictationAgentInference": `
        export function resolveDictationAgentInference() {
          return { reachable: true, model: "gpt-4.1-mini", displayProvider: "openai",
            config: { provider: "openai" } };
        }
      `,
      "/helpers/dictationTranslationInference": `
        export function resolveDictationTranslationInference() {
          return { reachable: true, model: "gpt-4.1-mini", displayProvider: "openai",
            config: { provider: "openai", inferenceScope: "dictationTranslation" } };
        }
      `,
    },
  });
  const { default: PromptStudio } = await vite.ssrLoadModule("/components/ui/PromptStudio.tsx");

  return async (kind, editor) => {
    globalThis.__studio.editor = editor;
    globalThis.__studio.hookCalls = 0;
    const findRun = (node) => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const match = findRun(child);
          if (match) return match;
        }
        return null;
      }
      if (node.props?.className === "w-full" && typeof node.props.onClick === "function") {
        return node;
      }
      return findRun(node.props?.children);
    };
    const run = findRun(PromptStudio({ kind }));
    assert.ok(run, "the Run button renders");
    assert.equal(run.props.disabled, false);
    await run.props.onClick();
    return calls;
  };
}

test("cleanup Test runs the unsaved draft as a cleanup override", async (t) => {
  const runTest = await loadStudio(t);
  const calls = await runTest("cleanup", editorFor({ selected: "picked", draft: "draft text" }));

  assert.equal(calls.reasoning.length, 0, "no explicit system prompt for cleanup");
  assert.equal(calls.cleanup.length, 1);
  const [, candidate, options] = calls.cleanup[0];
  assert.deepEqual(candidate, { mode: "text", text: "draft text" });
  // A test request: its text stays out of the request logs.
  assert.deepEqual(options, { agentName: "Jarvis", redactLogs: true });
});

test("cleanup Test of a saved prompt sends its saved text; Default sends builtin", async (t) => {
  const runTest = await loadStudio(t);
  await runTest("cleanup", editorFor({ selected: "picked" }));
  const calls = await runTest("cleanup", editorFor({ selected: "default" }));

  assert.deepEqual(calls.cleanup[0][1], { mode: "text", text: "saved text" });
  assert.deepEqual(calls.cleanup[1][1], { mode: "builtin" });
});

test("translation and assistant Tests pass the candidate as their system prompt", async (t) => {
  const runTest = await loadStudio(t);
  await runTest("translate", editorFor({ selected: "picked", draft: "translate draft" }));
  const calls = await runTest("dictationAgent", editorFor({ selected: "default" }));

  assert.equal(calls.cleanup.length, 0);
  const [translate, agent] = calls.reasoning;
  assert.equal(translate[3].systemPrompt, "resolved translate: translate draft");
  assert.equal(agent[3].systemPrompt, "resolved dictationAgent: ");
  assert.equal(agent[3].requiresAgent, true);
  // The same substitutions resolvePrompt applies to the saved prompt.
  assert.deepEqual(calls.resolved[0].opts, {
    agentName: "Jarvis",
    targetLanguageLabel: "fr",
    customDictionary: ["Kubernetes"],
    uiLanguage: "en",
  });
  assert.deepEqual(calls.resolved[1].opts, {
    agentName: "Jarvis",
    language: "en",
    customDictionary: ["Kubernetes"],
    uiLanguage: "en",
  });
});
