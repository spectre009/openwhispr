const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/chatRouting.js");

test("custom BYOK Chat stays on its provider route", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "custom",
    customApiKey: "litellm-key",
  });

  assert.deepEqual(route, { kind: "provider", baseUrl: "", apiKey: "" });
});

test("built-in provider Chat stays on its provider route", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({ provider: "gemini" });

  assert.equal(route.kind, "provider");
});

test("local Chat stays on its local route", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({ provider: "ollama" });

  assert.equal(route.kind, "local");
});

test("explicit self-hosted Chat URL wins over a stale enterprise provider", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "bedrock",
    lanUrl: "  http://127.0.0.1:4000/v1  ",
    customApiKey: "  secret-key  ",
    isEnterpriseProvider: true,
  });

  assert.deepEqual(route, {
    kind: "self-hosted",
    baseUrl: "http://127.0.0.1:4000/v1",
    apiKey: "secret-key",
  });
});

test("self-hosted Chat preserves an empty optional API key", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "custom",
    lanUrl: "http://127.0.0.1:11434/v1",
  });

  assert.equal(route.kind, "self-hosted");
  assert.equal(route.apiKey, "");
});

test("enterprise Chat stays enterprise without a Chat LAN URL", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "vertex",
    isEnterpriseProvider: true,
  });

  assert.equal(route.kind, "enterprise");
});

test("blank Chat LAN URL does not activate self-hosted routing", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "custom",
    lanUrl: "   ",
    customApiKey: "secret-key",
  });

  assert.equal(route.kind, "provider");
});

// GitHub Copilot answers plain-text requests only. A chat scope left on it
// must fail with words the user can act on — never fall through to the local
// llama route the way an unknown id does.
test("a Copilot Chat selection fails closed instead of routing to the local model", async () => {
  const { resolveChatRoute } = await load();
  assert.throws(
    () => resolveChatRoute({ provider: "copilot" }),
    (error) => {
      assert.equal(error.code, "PROVIDER_BAD_REQUEST");
      assert.equal(error.messageKey, "providerErrors.copilot.unsupportedRequest");
      assert.equal(error.settingsTarget, "llms");
      return true;
    }
  );
});

test("an explicit self-hosted Chat URL still wins over a stale Copilot provider", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({ provider: "copilot", lanUrl: "http://127.0.0.1:4000/v1" });

  assert.equal(route.kind, "self-hosted");
});

test("Copilot is never classified as a local Chat provider", async () => {
  const { isChatUnsupportedProvider, isLocalChatProvider } = await load();

  assert.equal(isChatUnsupportedProvider("copilot"), true);
  assert.equal(isLocalChatProvider("copilot"), false);
  assert.equal(isChatUnsupportedProvider("openai"), false);
  assert.equal(isLocalChatProvider("openai"), false);
  assert.equal(isLocalChatProvider("qwen"), true);
  assert.equal(isLocalChatProvider("bedrock", { isEnterpriseProvider: true }), false);
});
