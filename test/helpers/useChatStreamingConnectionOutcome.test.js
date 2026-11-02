const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  SIGNED_OUT_AUTH_MOCK,
  createRendererServer,
  installBrowserGlobals,
} = require("../lib/rendererTestHarness");

// Chat streaming records "Last recorded use" at the provider's finish or
// error, as Chat's or (from the assistant panel) the assistant's use: never a
// cancel, and never a delivery's failure after the provider finished. Drives
// the real hook once (renderToStaticMarkup), then its sendToAI.

const LAN = "http://127.0.0.1:11434/v1";

async function renderChatStreaming(t, { inferenceScope, stream }) {
  const recorded = [];
  installBrowserGlobals(t, {
    window: { electronAPI: { recordConnectionOutcome: (outcome) => recorded.push(outcome) } },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-outcome-test-",
    mockModules: SIGNED_OUT_AUTH_MOCK,
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!viteI18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await viteI18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  useSettingsStore.setState({
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-1b-q4_k_m",
    chatAgentRemoteUrl: LAN,
    isSignedIn: false,
    useDictationAgent: false,
  });
  const targets = await vite.ssrLoadModule("/helpers/connectionOutcomeTargets.js");
  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  t.mock.method(reasoningService, "processTextStreamingAI", () => stream());

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };
  let captured = null;
  function Harness() {
    captured = useChatStreaming({ messages, setMessages, inferenceScope });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const lanId = targets.endpointDescriptorId(
    "selfHosted",
    targets.endpointCheckRoute(LAN, true),
    null
  );
  return { captured, recorded, settle, lanId, getMessages: () => messages };
}

test("a finished reply is Chat's OK; a delivery that fails afterwards changes nothing", async (t) => {
  const { captured, recorded, settle, lanId } = await renderChatStreaming(t, {
    stream: async function* () {
      yield { type: "content", text: "Here you go." };
    },
  });
  await captured.sendToAI("hello", [], {
    onComplete: () => {
      // Even one carrying a provider's code: it's the delivery's, after the finish.
      throw Object.assign(new Error("Paste failed"), { code: "PROVIDER_UNREACHABLE" });
    },
  });
  await settle();
  assert.equal(recorded.length, 1, "one record: the provider's finish");
  assert.equal(recorded[0].descriptorId, lanId);
  assert.equal(recorded[0].feature, "chat");
  assert.equal(recorded[0].ok, true);
  assert.equal(typeof recorded[0].startedAt, "number");
});

test("the assistant panel's failure is the assistant's, with its code", async (t) => {
  const { captured, recorded, settle, lanId, getMessages } = await renderChatStreaming(t, {
    inferenceScope: "dictationAgent",
    stream: async function* () {
      yield { type: "content", text: "Partial" };
      throw Object.assign(new Error("Your server rate-limited the request."), {
        code: "PROVIDER_RATE_LIMITED",
        messageKey: "providerErrors.selfHosted.rateLimited",
      });
    },
  });
  await captured.sendToAI("what's the weather", []);
  await settle();
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    {
      descriptorId: recorded[0].descriptorId,
      feature: recorded[0].feature,
      ok: recorded[0].ok,
      code: recorded[0].code,
    },
    { descriptorId: lanId, feature: "assistant", ok: false, code: "PROVIDER_RATE_LIMITED" }
  );
  assert.ok(getMessages().at(-1).content.includes("rate-limited"));
});

test("a cancel mid-stream records nothing", async (t) => {
  let release;
  const { captured, recorded, settle } = await renderChatStreaming(t, {
    stream: async function* () {
      yield { type: "content", text: "Thinking" };
      await new Promise((resolve) => {
        release = resolve;
      });
      yield { type: "content", text: " more" };
    },
  });
  const sending = captured.sendToAI("hello", []);
  for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setImmediate(r));
  captured.cancelStream();
  release();
  await sending;
  await settle();
  assert.deepEqual(recorded, []);
});
