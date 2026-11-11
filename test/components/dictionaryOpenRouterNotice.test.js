const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The fork's Dictionary says these in "Where it goes", beside the coverage
// they explain (and under the lists with teammates' words), so they're read
// off the hook both use. The prompt-length warning upstream also showed is the
// coverage's cut line here ("N aren't sent", "Whisper reads the last ≈ N
// characters"), so no case expects it.
const IGNORED_NOTICE = "dictionary.openRouterIgnoredNotice";
const LOCAL_NOTICE = "dictionary.localModelIgnoredNotice";
const HOTWORDS_NOTICE = "dictionary.localModelHotwordsLimitNotice";
const ORUKEET = {
  useLocalWhisper: true,
  localTranscriptionProvider: "nvidia",
  parakeetModel: "orukeet-v0.1.0",
};
const LONG_DICTIONARY = Array.from({ length: 60 }, (_, i) => `SpecializedTerm${i}`);

// Mounts the notice hook under React's client lifecycle, so the settings and
// enterprise stores update it live. The dictation route comes from the real
// settings store, exactly as the page reads it.
async function mountDictionary(t) {
  let unmount = async () => {};
  t.after(() => unmount());
  installBrowserGlobals(t, { window: { location: { search: "" }, electronAPI: {} } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictionary-openrouter-notice-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key, options) =>
          key === "${HOTWORDS_NOTICE}" ? [key, options?.model, options?.limit].join("|") : key;
        export function useTranslation() {
          return { t, i18n: { language: "en", dir: () => "ltr" } };
        }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { useSpeechDictionaryNotice, speechDictionaryNoticeText } = await vite.ssrLoadModule(
    "/components/dictionary/speechDictionaryNotice.ts"
  );
  const translate = (key, options) =>
    key === HOTWORDS_NOTICE ? [key, options?.model, options?.limit].join("|") : key;

  let shown = [];
  let rerender;
  function Harness() {
    const [, setTick] = React.useState(0);
    rerender = () => setTick((tick) => tick + 1);
    const notice = useSpeechDictionaryNotice();
    shown = notice ? [speechDictionaryNoticeText(notice, translate)] : [];
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  unmount = async () => {
    unmount = async () => {};
    await React.act(async () => root.unmount());
  };

  // The words don't change the notice: a list past a cap is the coverage's to say.
  const notices = async (dictation, words = ["Kubernetes"]) => {
    await React.act(async () => {
      useSettingsStore.setState({
        customDictionary: words,
        useLocalWhisper: false,
        cloudTranscriptionMode: "byok",
        transcriptionMode: "providers",
        remoteTranscriptionUrl: "",
        cloudTranscriptionBaseUrl: "",
        localTranscriptionProvider: "whisper",
        ...dictation,
      });
      rerender();
    });
    return shown;
  };
  const setEnterprise = (state) =>
    React.act(async () => useEnterpriseIdentityStore.setState(state));
  return { notices, setEnterprise };
}

const OPENROUTER_TAB = {
  cloudTranscriptionProvider: "openrouter",
  cloudTranscriptionModel: "openai/gpt-transcribe",
};
const OPENAI = { cloudTranscriptionProvider: "openai", cloudTranscriptionModel: "whisper-1" };

test("the Dictionary says when OpenRouter won't pass its words on", async (t) => {
  const { notices, setEnterprise } = await mountDictionary(t);

  assert.deepEqual(await notices(OPENROUTER_TAB), [IGNORED_NOTICE], "OpenRouter tab");
  assert.deepEqual(
    await notices({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://openrouter.ai/api/v1",
      cloudTranscriptionModel: "openai/gpt-transcribe",
    }),
    [IGNORED_NOTICE],
    "Custom endpoint on OpenRouter"
  );

  assert.deepEqual(await notices(OPENAI), [], "OpenAI reads the dictionary");
  assert.deepEqual(
    await notices({ ...OPENROUTER_TAB, cloudTranscriptionMode: "openwhispr" }),
    [],
    "OpenWhispr Cloud"
  );
  assert.deepEqual(await notices({ ...OPENROUTER_TAB, useLocalWhisper: true }), [], "local model");

  // A long list on a Whisper-style model is the coverage's cut line, not a notice.
  assert.deepEqual(await notices(OPENAI, LONG_DICTIONARY), []);
  assert.deepEqual(await notices(OPENROUTER_TAB, LONG_DICTIONARY), [IGNORED_NOTICE]);

  // A managed workspace transcribes with its own deployment, whatever the
  // personal settings still say (fixture shape: dictationTranslationInference.test.js).
  await setEnterprise({
    status: "ready",
    config: {
      workspaceId: "workspace-a",
      version: 1,
      providers: [
        {
          provider: "azure",
          mode: "managed_required",
          allowManualSetup: false,
          config: { transcription: { defaultDeployment: "stt" } },
          version: 1,
          updatedAt: "2026-09-25T00:00:00.000Z",
        },
      ],
    },
  });
  t.after(() => setEnterprise({ status: "idle", config: null }));
  assert.deepEqual(await notices(OPENROUTER_TAB), [], "managed workspace");
  assert.deepEqual(await notices(ORUKEET), [], "managed workspace with Orukeet selected locally");
});

test("the Dictionary says when the local model can't use its words", async (t) => {
  const { notices } = await mountDictionary(t);
  const parakeet = (parakeetModel) => ({
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel,
  });

  assert.deepEqual(
    await notices({
      useLocalWhisper: true,
      localTranscriptionProvider: "cohere",
      cohereModel: "cohere-transcribe-03-2026",
    }),
    [LOCAL_NOTICE],
    "Cohere Transcribe"
  );
  assert.deepEqual(await notices(parakeet("parakeet-tdt-0.6b-v3")), [LOCAL_NOTICE], "Parakeet");
  assert.deepEqual(
    await notices(parakeet("nemotron-speech-streaming-en-0.6b")),
    [LOCAL_NOTICE],
    "Nemotron"
  );
  assert.deepEqual(await notices({ useLocalWhisper: true }), [], "local Whisper takes a prompt");
  assert.deepEqual(
    await notices({ ...parakeet("parakeet-tdt-0.6b-v3"), useLocalWhisper: false, ...OPENAI }),
    [],
    "cloud dictation"
  );
});

test("the Dictionary shows Orukeet's hotword limit for local dictation", async (t) => {
  const { notices } = await mountDictionary(t);
  const expectedNotice = [`${HOTWORDS_NOTICE}|Orukeet|100`];
  const overLimitDictionary = Array.from({ length: 101 }, (_, i) => `Term${i}`);

  assert.deepEqual(await notices(ORUKEET), expectedNotice, "short dictionary");
  assert.deepEqual(await notices(ORUKEET, overLimitDictionary), expectedNotice, "over the limit");
  assert.deepEqual(
    await notices({ ...ORUKEET, useLocalWhisper: false, ...OPENAI }, overLimitDictionary),
    [],
    "cloud dictation with Orukeet selected locally"
  );
});
