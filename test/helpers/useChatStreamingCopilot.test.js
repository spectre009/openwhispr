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

// A chat or assistant scope left on GitHub Copilot (an import, an older build)
// must answer with why it can't run there. useChatStreaming used to class any
// provider id it didn't list as local, which would have sent the conversation
// to the bundled llama server.

const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
);

async function renderChatStreaming(t, settings) {
  const calls = { llama: 0, fetch: 0, streams: 0 };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        llamaServerStart: async () => {
          calls.llama += 1;
          return { success: false, error: "local must never be reached" };
        },
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.fetch += 1;
    throw new Error("no request may leave the app");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-copilot-test-",
    mockModules: SIGNED_OUT_AUTH_MOCK,
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!viteI18next.isInitialized) {
    await viteI18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  }

  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.3", policy: null });
  useSettingsStore.setState({ isSignedIn: false, ...settings });

  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  for (const method of [
    "processTextStreaming",
    "processTextStreamingAI",
    "processTextStreamingCloud",
  ]) {
    const original = reasoningService[method].bind(reasoningService);
    reasoningService[method] = (...args) => {
      calls.streams += 1;
      return original(...args);
    };
  }
  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };
  let captured = null;
  function Harness({ inferenceScope }) {
    captured = useChatStreaming({ messages, setMessages, inferenceScope });
    return null;
  }
  return {
    render: (inferenceScope) => {
      renderToStaticMarkup(React.createElement(Harness, { inferenceScope }));
      return captured;
    },
    getMessages: () => messages,
    calls,
  };
}

test("Chat on a stale Copilot selection says why, and never reaches a model", async (t) => {
  const { render, getMessages, calls } = await renderChatStreaming(t, {
    chatAgentMode: "providers",
    chatAgentProvider: "copilot",
    chatAgentModel: "claude-haiku-5.5",
  });

  await render("chatIntelligence").sendToAI("hello", []);

  const [reply] = getMessages();
  assert.equal(reply.role, "assistant");
  assert.equal(reply.content, en.providerErrors.copilot.unsupportedRequest);
  assert.equal(reply.isStreaming, false);
  assert.deepEqual(calls, { llama: 0, fetch: 0, streams: 0 });
});

test("the voice assistant on a stale Copilot selection fails the same way", async (t) => {
  const { render, getMessages, calls } = await renderChatStreaming(t, {
    useDictationAgent: true,
    dictationAgentMode: "providers",
    dictationAgentProvider: "copilot",
    dictationAgentModel: "claude-haiku-5.5",
  });

  await render("dictationAgent").sendToAI("hello", []);

  assert.equal(getMessages().at(-1).content, en.providerErrors.copilot.unsupportedRequest);
  assert.deepEqual(calls, { llama: 0, fetch: 0, streams: 0 });
});
