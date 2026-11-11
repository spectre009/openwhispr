const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AZURE,
  DESCRIPTORS: D,
  KEYS,
  SPEECH,
  createHarness,
  hang,
  headerOf,
  reply,
} = require("./harness/connectionCheckHarness");
const { compareModels, validateDescriptor } = require("../../src/helpers/connectionChecks");

// Settings › AI Connections' checks, main's side (helpers/connectionChecks.js):
// each kind's one free request (route, headers, what counts as accepted) and
// how its answer maps to evidence, for 200, 400, 401, 403, 404, 429, 5xx, a
// timeout and a malformed body; model comparison only where ids are
// trustworthy, with alias handling before any "missing"; descriptors refused
// outside each kind's allowlist before a key is read. No network: every
// request goes to a scripted fetch.

const list = (...ids) => ({ data: ids.map((id) => ({ id })) });

test("a model list (OpenAI): request shape and every answer", async (t) => {
  const cases = [
    [
      reply(200, list("gpt-5-mini", "whisper-1")),
      { reachable: true, credentials: "accepted", code: "OK", httpStatus: 200 },
    ],
    [
      reply(400, { error: { message: "bad" } }),
      { reachable: true, credentials: "unknown", code: "PROVIDER_ERROR" },
    ],
    [
      reply(401, { error: { message: "Incorrect API key provided" } }),
      { reachable: true, credentials: "rejected", code: "PROVIDER_AUTH_FAILED" },
    ],
    // A 403 isn't always a bad key: only an invalid-key body says so.
    [
      reply(403, { error: { message: "You lack the permission to list models" } }),
      { reachable: true, credentials: "unknown", code: "PROVIDER_ACCESS_DENIED" },
    ],
    [
      reply(403, { error: { code: "invalid_api_key" } }),
      { reachable: true, credentials: "rejected", code: "PROVIDER_AUTH_FAILED" },
    ],
    [
      reply(404, "not here"),
      { reachable: true, credentials: "unknown", code: "CHECK_ENDPOINT_NOT_FOUND" },
    ],
    [
      reply(429, { error: { message: "Rate limit reached" } }),
      { reachable: true, credentials: "unknown", code: "PROVIDER_RATE_LIMITED" },
    ],
    [
      reply(429, { error: { code: "insufficient_quota" } }),
      { reachable: true, credentials: "accepted", code: "PROVIDER_QUOTA_EXHAUSTED" },
    ],
    [
      reply(503, "upstream down"),
      { reachable: false, credentials: "unknown", code: "PROVIDER_UNAVAILABLE" },
    ],
    [hang, { reachable: false, credentials: "unknown", code: "PROVIDER_TIMEOUT" }],
    [
      new TypeError("fetch failed"),
      { reachable: false, credentials: "unknown", code: "PROVIDER_UNREACHABLE" },
    ],
    [
      new Error("net::ERR_NAME_NOT_RESOLVED"),
      { reachable: false, credentials: "unknown", code: "PROVIDER_UNREACHABLE" },
    ],
    // A 200 the check can't read still proves the key.
    [
      reply(200, "<html>oops</html>"),
      { reachable: true, credentials: "accepted", code: "CHECK_MALFORMED" },
    ],
  ];
  for (const [answer, expected] of cases) {
    await t.test(`${expected.code} (${answer.status ?? answer.name ?? "hang"})`, async () => {
      const { check, requests } = createHarness({ route: () => answer });
      const result = await check(D.openai(["gpt-5-mini"]));
      for (const [field, value] of Object.entries(expected)) {
        assert.equal(result[field], value, field);
      }
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://api.openai.com/v1/models");
      assert.equal(requests[0].init.method, "GET");
      assert.equal(requests[0].init.redirect, "manual");
      assert.equal(headerOf(requests[0], "authorization"), `Bearer ${KEYS.OPENAI_API_KEY}`);
      assert.equal(result.generation, "g1");
      assert.equal(typeof result.checkedAt, "number");
    });
  }
});

test("models compared where ids are trustworthy, alias handling before missing", async () => {
  const { check } = createHarness({
    route: () => reply(200, list("gpt-5-mini", "gpt-4o-2024-08-06", "whisper-1")),
  });
  const result = await check(
    D.openai(["gpt-5-mini", "gpt-4o", "gpt-retired-1", "whisper-1", "o3-preview"])
  );
  assert.deepEqual(result.models, {
    "gpt-5-mini": "offered",
    // A dated variant is listed: it may still answer under its alias.
    "gpt-4o": "unknown",
    "gpt-retired-1": "missing",
    "whisper-1": "offered",
    "o3-preview": "unknown",
  });

  assert.deepEqual(
    compareModels(["a", "b"], { ids: ["a"], truncated: true }),
    { a: "offered", b: "unknown" },
    "a truncated listing never says missing"
  );
  assert.deepEqual(compareModels(["models/Gemini-X"], { ids: ["gemini-x"] }), {
    "models/Gemini-X": "offered",
  });
  assert.deepEqual(
    compareModels(["vendor/model:free"], { ids: ["vendor/model"] }),
    { "vendor/model:free": "unknown" },
    "a routing variant of a listed model"
  );
});

test("Anthropic: x-api-key and its version; models not compared", async () => {
  const { check, requests } = createHarness({
    route: () => reply(200, list("claude-haiku-4-5-20251001")),
  });
  const result = await check(D.anthropic(["claude-haiku-4-5"]));
  assert.equal(requests[0].url, "https://api.anthropic.com/v1/models");
  assert.equal(headerOf(requests[0], "x-api-key"), KEYS.ANTHROPIC_API_KEY);
  assert.equal(headerOf(requests[0], "anthropic-version"), "2023-06-01");
  assert.equal(headerOf(requests[0], "authorization"), null);
  assert.equal(result.credentials, "accepted");
  assert.deepEqual(result.models, { "claude-haiku-4-5": "unknown" });
  assert.equal(requests[0].init.body, undefined);
});

test("Gemini: x-goog-api-key, paged, 400 API_KEY_INVALID rejected, preview ids unknown", async (t) => {
  await t.test("paged list", async () => {
    const { check, requests } = createHarness({
      route: (url) =>
        url.includes("pageToken=next-1")
          ? reply(200, { models: [{ name: "models/gemini-2.5-pro" }] })
          : reply(200, {
              models: [{ name: "models/gemini-2.5-flash", baseModelId: "gemini-2.5-flash" }],
              nextPageToken: "next-1",
            }),
    });
    const result = await check(
      D.gemini(["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-1.0-pro"])
    );
    assert.equal(requests.length, 2);
    assert.match(
      requests[0].url,
      /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?pageSize=1000$/
    );
    assert.equal(headerOf(requests[0], "x-goog-api-key"), KEYS.GEMINI_API_KEY);
    assert.equal(headerOf(requests[0], "authorization"), null);
    assert.deepEqual(result.models, {
      "gemini-2.5-flash": "offered",
      "gemini-2.5-pro": "offered",
      "gemini-3-flash-preview": "unknown",
      "gemini-1.0-pro": "missing",
    });
  });
  await t.test("a bad key is a 400", async () => {
    const { check } = createHarness({
      route: () =>
        reply(400, {
          error: {
            code: 400,
            message: "API key not valid.",
            status: "INVALID_ARGUMENT",
            details: [{ reason: "API_KEY_INVALID" }],
          },
        }),
    });
    const result = await check(D.gemini(["gemini-2.5-flash"]));
    assert.equal(result.credentials, "rejected");
    assert.equal(result.code, "PROVIDER_AUTH_FAILED");
    assert.equal(result.httpStatus, 400);
  });
});

test("Groq and Mistral: bearer model lists; Mistral's aliases count", async () => {
  const groq = createHarness({ route: () => reply(200, list("whisper-large-v3-turbo")) });
  const groqResult = await groq.check(D.groq(["whisper-large-v3-turbo", "gone-model"]));
  assert.equal(groq.requests[0].url, "https://api.groq.com/openai/v1/models");
  assert.equal(headerOf(groq.requests[0], "authorization"), `Bearer ${KEYS.GROQ_API_KEY}`);
  assert.deepEqual(groqResult.models, {
    "whisper-large-v3-turbo": "offered",
    "gone-model": "missing",
  });

  const mistral = createHarness({
    route: () =>
      reply(200, { data: [{ id: "voxtral-mini-2507", aliases: ["voxtral-mini-latest"] }] }),
  });
  const mistralResult = await mistral.check(D.mistral(["voxtral-mini-latest"]));
  assert.equal(mistral.requests[0].url, "https://api.mistral.ai/v1/models");
  assert.deepEqual(mistralResult.models, { "voxtral-mini-latest": "offered" });
});

test("OpenRouter: /key only (never /credits), management keys, a key's own limit, the public lists", async (t) => {
  const SPEECH_LIST = "/models?output_modalities=transcription";
  const keyInfo =
    (data, { speech = reply(200, list("mistralai/voxtral-mini-transcribe-3-0")) } = {}) =>
    (url) =>
      url.endsWith("/key")
        ? reply(200, { data })
        : url.endsWith("/models")
          ? reply(200, list("anthropic/claude-sonnet-4.5", "openai/gpt-5-mini"))
          : url.endsWith(SPEECH_LIST)
            ? speech
            : reply(500, "unexpected");

  await t.test("unlimited key: no limit shown, models from the public lists", async () => {
    const { check, requests } = createHarness({
      route: keyInfo({ label: "sk-or-v1-abc", limit: null, limit_remaining: null, usage: 12 }),
    });
    const result = await check(D.openrouter(["openai/gpt-5-mini", "gone/model"]));
    assert.deepEqual(
      requests.map((request) => request.url),
      [
        "https://openrouter.ai/api/v1/key",
        "https://openrouter.ai/api/v1/models",
        `https://openrouter.ai/api/v1${SPEECH_LIST}`,
      ]
    );
    assert.ok(!requests.some((request) => request.url.includes("/credits")), "never /credits");
    assert.equal(headerOf(requests[0], "authorization"), `Bearer ${KEYS.OPENROUTER_API_KEY}`);
    for (const request of requests.slice(1)) {
      assert.equal(headerOf(request, "authorization"), null, "the public lists go without the key");
    }
    assert.equal(result.credentials, "accepted");
    assert.equal(result.code, "OK");
    assert.equal(result.limit, undefined);
    assert.deepEqual(result.models, { "openai/gpt-5-mini": "offered", "gone/model": "missing" });
  });
  // Speech-to-text models are listed only by output modality (#2105).
  await t.test("speech-to-text models come from the transcription list", async () => {
    const used = await createHarness({ route: keyInfo({ limit: null }) }).check(
      D.openrouter(["openai/gpt-5-mini", "mistralai/voxtral-mini-transcribe-3-0"])
    );
    assert.deepEqual(used.models, {
      "openai/gpt-5-mini": "offered",
      "mistralai/voxtral-mini-transcribe-3-0": "offered",
    });
    // Every used model on the text list: the speech list isn't asked for.
    const textOnly = createHarness({ route: keyInfo({ limit: null }) });
    await textOnly.check(D.openrouter(["openai/gpt-5-mini"]));
    assert.equal(textOnly.requests.length, 2);
    // A speech list that can't be read leaves what it might name unknown, never missing.
    const unread = await createHarness({
      route: keyInfo({ limit: null }, { speech: reply(503, "down") }),
    }).check(D.openrouter(["openai/gpt-5-mini", "mistralai/voxtral-mini-transcribe-3-0"]));
    assert.deepEqual(unread.models, {
      "openai/gpt-5-mini": "offered",
      "mistralai/voxtral-mini-transcribe-3-0": "unknown",
    });
    assert.equal(unread.credentials, "accepted");
  });
  await t.test("a limited key: what's left; spent is a warning", async () => {
    const left = await createHarness({ route: keyInfo({ limit: 20, limit_remaining: 4.5 }) }).check(
      D.openrouter()
    );
    assert.deepEqual(left.limit, { amount: 20, remaining: 4.5, reached: false });
    assert.equal(left.code, "OK");
    const spent = await createHarness({ route: keyInfo({ limit: 20, limit_remaining: 0 }) }).check(
      D.openrouter()
    );
    assert.deepEqual(spent.limit, { amount: 20, remaining: 0, reached: true });
    assert.equal(spent.code, "CHECK_LIMIT_REACHED");
    assert.equal(spent.credentials, "accepted");
  });
  await t.test("a management key can't make requests", async () => {
    const result = await createHarness({
      route: keyInfo({ is_management_key: true, limit: null }),
    }).check(D.openrouter());
    assert.equal(result.credentials, "rejected");
    assert.equal(result.code, "CHECK_MANAGEMENT_KEY");
  });
});

test("xAI: its key-info route; blocked or disabled keys are rejected", async () => {
  const ok = createHarness({
    route: () => reply(200, { api_key_blocked: false, api_key_disabled: false }),
  });
  assert.equal((await ok.check(D.xai())).credentials, "accepted");
  assert.equal(ok.requests[0].url, "https://api.x.ai/v1/api-key");
  assert.equal(headerOf(ok.requests[0], "authorization"), `Bearer ${KEYS.XAI_API_KEY}`);
  const blocked = await createHarness({
    route: () => reply(200, { api_key_disabled: true }),
  }).check(D.xai());
  assert.equal(blocked.credentials, "rejected");
  assert.equal(blocked.code, "CHECK_KEY_BLOCKED");
});

test("Deepgram: its projects with a Token header; AssemblyAI: status only, body cancelled unread", async () => {
  const deepgram = createHarness({
    route: () => reply(200, { projects: [{ name: "BODY-CANARY" }] }),
  });
  assert.equal((await deepgram.check(D.deepgram())).credentials, "accepted");
  assert.equal(deepgram.requests[0].url, "https://api.deepgram.com/v1/projects");
  assert.equal(headerOf(deepgram.requests[0], "authorization"), `Token ${KEYS.DEEPGRAM_API_KEY}`);

  for (const status of [200, 401]) {
    const answer = reply(status, { transcripts: [{ text: "BODY-CANARY dictated words" }] });
    const assembly = createHarness({ route: () => answer });
    const result = await assembly.check(D.assemblyai());
    assert.equal(assembly.requests[0].url, "https://api.assemblyai.com/v2/transcript?limit=1");
    assert.equal(headerOf(assembly.requests[0], "authorization"), KEYS.ASSEMBLYAI_API_KEY);
    assert.equal(answer.state.read, false, `${status}: never read`);
    assert.equal(answer.state.cancelled, true, `${status}: cancelled`);
    assert.equal(result.credentials, status === 200 ? "accepted" : "rejected");
  }
});

test("Azure Speech: the resource's base models with its key; MAI checked when you dictate", async () => {
  const { check, requests } = createHarness({ route: () => reply(200, { values: [] }) });
  const result = await check(D.azureSpeech());
  assert.equal(requests[0].url, `${SPEECH}/speechtotext/models/base?api-version=2024-11-15&top=1`);
  assert.equal(headerOf(requests[0], "ocp-apim-subscription-key"), KEYS.AZURE_SPEECH_API_KEY);
  assert.equal(result.credentials, "accepted");
  assert.deepEqual(result.models, { "MAI-Transcribe-2": "unknown" });
  const missing = await createHarness({
    route: () => reply(404, { error: { code: "404" } }),
  }).check(D.azureSpeech());
  assert.equal(missing.code, "CHECK_ENDPOINT_NOT_FOUND");
});

test("Tinfoil: reachability through the attested client; the key is never sent", async () => {
  const calls = [];
  const tinfoil = async (path, init) => {
    calls.push({ path, init });
    return reply(200, list("llama3-3-70b", "whisper-large-v3-turbo"));
  };
  const { check, requests } = createHarness({ tinfoil });
  const result = await check(D.tinfoil(["llama3-3-70b", "gone"]));
  assert.equal(requests.length, 0, "nothing through the plain transport");
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/v1/models"]
  );
  assert.equal(calls[0].init.headers, undefined, "no Authorization, no key");
  assert.ok(!JSON.stringify(calls).includes(KEYS.TINFOIL_API_KEY));
  assert.equal(result.reachable, true);
  assert.equal(result.credentials, "unknown");
  assert.equal(result.code, "CHECK_NOT_VERIFIABLE");
  assert.equal(result.proof, "reachability");
  assert.deepEqual(result.models, { "llama3-3-70b": "offered", gone: "missing" });
});

test("Corti: the language-model gateway, and a client-credentials token fresh on an explicit Check", async () => {
  const llm = createHarness({ route: () => reply(200, list("corti-model")) });
  const llmResult = await llm.check(D.cortiLlm());
  assert.equal(llm.requests[0].url, "https://ai.eu.corti.app/v1/models");
  assert.equal(headerOf(llm.requests[0], "authorization"), `Bearer ${KEYS.CORTI_API_KEY}`);
  assert.equal(llmResult.credentials, "accepted");

  const { getCortiToken } = require("../../src/helpers/cortiAuth");
  const tenant = `t${Date.now()}`;
  const stt = createHarness({
    route: () => reply(200, { access_token: "corti-TOKEN-CANARY", expires_in: 300 }),
    cortiToken: getCortiToken,
  });
  const first = await stt.check(D.cortiStt(tenant), { fresh: false });
  assert.equal(first.credentials, "accepted");
  assert.equal(stt.requests.length, 1);
  assert.equal(
    stt.requests[0].url,
    `https://auth.eu.corti.app/realms/${tenant}/protocol/openid-connect/token`
  );
  assert.equal(stt.requests[0].init.method, "POST");
  // Automatic: a cached token answers. Check: Corti is asked again.
  await stt.check({ ...D.cortiStt(tenant), generation: "g2" }, { fresh: false });
  assert.equal(stt.requests.length, 1, "the cached token");
  await stt.check(D.cortiStt(tenant), { fresh: true });
  assert.equal(stt.requests.length, 2, "fresh on an explicit Check");

  const rejected = await createHarness({
    route: () => reply(401, { error: "invalid_client", error_description: "BODY-CANARY" }),
    cortiToken: getCortiToken,
  }).check(D.cortiStt(`r${Date.now()}`), { fresh: true });
  assert.equal(rejected.credentials, "rejected");
  assert.equal(rejected.httpStatus, 401);
  assert.ok(!JSON.stringify(rejected).includes("BODY-CANARY"));
});

test("the custom connection: main's check, deployment ids compared, the catalog never returned", async (t) => {
  const route = (deployments) => (url) =>
    url === `${AZURE}/openai/v1/models`
      ? reply(200, list("gpt-catalog-CANARY"))
      : url.startsWith(`${AZURE}/openai/deployments`)
        ? deployments
        : reply(500, "unexpected");

  await t.test("listed: offered and missing", async () => {
    const { check, requests } = createHarness({
      route: route(
        reply(200, {
          data: [
            { id: "gpt-5-mini", model: "gpt-5-mini" },
            { id: "stt-CANARY", model: "gpt-4o-transcribe" },
          ],
        })
      ),
    });
    const result = await check(D.custom(["gpt-5-mini", "gpt-4.1-mini"]));
    assert.equal(requests[0].url, `${AZURE}/openai/v1/models`);
    assert.equal(
      headerOf(requests[0], "authorization"),
      `Bearer ${KEYS.CUSTOM_CONNECTION_API_KEY}`
    );
    assert.equal(requests[1].url, `${AZURE}/openai/deployments?api-version=2022-12-01`);
    assert.equal(headerOf(requests[1], "api-key"), KEYS.CUSTOM_CONNECTION_API_KEY);
    assert.equal(result.credentials, "accepted");
    assert.deepEqual(result.models, { "gpt-5-mini": "offered", "gpt-4.1-mini": "missing" });
    const text = JSON.stringify(result);
    assert.ok(!text.includes("stt-CANARY") && !text.includes("gpt-catalog-CANARY"), "no catalog");
  });
  await t.test("discovery unavailable or truncated: unknown", async () => {
    const unavailable = await createHarness({ route: route(reply(404, {})) }).check(
      D.custom(["gpt-5-mini"])
    );
    assert.equal(unavailable.credentials, "accepted");
    assert.deepEqual(unavailable.models, { "gpt-5-mini": "unknown" });
    const truncated = await createHarness({
      route: route(reply(200, { data: [{ id: "other" }], has_more: true })),
    }).check(D.custom(["gpt-5-mini"]));
    assert.deepEqual(truncated.models, { "gpt-5-mini": "unknown" });
  });
  await t.test("401 rejected, 403 not a verdict, 429 rate limited, 5xx unreachable", async () => {
    const at = async (status) =>
      createHarness({ route: () => reply(status, {}) }).check(D.custom(["gpt-5-mini"]));
    assert.equal((await at(401)).credentials, "rejected");
    assert.equal((await at(403)).code, "PROVIDER_ACCESS_DENIED");
    assert.equal((await at(429)).code, "PROVIDER_RATE_LIMITED");
    const down = await at(502);
    assert.equal(down.reachable, false);
    const timedOut = await createHarness({ route: () => hang }).check(D.custom());
    assert.equal(timedOut.code, "PROVIDER_TIMEOUT");
  });
});

test("a feature's own endpoint and a self-hosted server", async () => {
  const endpoint = createHarness({ route: () => reply(200, list("m")) });
  const endpointResult = await endpoint.check(D.endpoint());
  assert.equal(endpoint.requests[0].url, "https://gateway.example.test/v1/models");
  assert.equal(
    headerOf(endpoint.requests[0], "authorization"),
    `Bearer ${KEYS.CUSTOM_CLEANUP_API_KEY}`
  );
  assert.equal(endpointResult.credentials, "accepted");

  const server = createHarness({ route: () => reply(404, "no list") });
  const serverResult = await server.check(D.selfHosted());
  assert.equal(server.requests[0].url, "http://192.168.1.20:8178/models");
  assert.equal(headerOf(server.requests[0], "authorization"), null, "no key");
  assert.equal(serverResult.reachable, true, "a server without a model list still answered");
  assert.equal(serverResult.credentials, "unknown");
  assert.equal(serverResult.proof, "reachability");
  const down = await createHarness({ route: () => new TypeError("fetch failed") }).check(
    D.selfHosted()
  );
  assert.equal(down.reachable, false);
});

test("GitHub Copilot: the sign-in automatically, Copilot's own list on Check", async (t) => {
  const listCalls = [];
  const rejected = [];
  const copilot = {
    runtime: {
      listModels: async (options) => {
        listCalls.push(options);
        return [{ id: "claude-haiku-5.5" }, { id: "gpt-5-mini" }];
      },
    },
    auth: { reportTokenRejected: () => rejected.push(true) },
  };
  await t.test("automatic: an identity", async () => {
    const { check, requests } = createHarness({
      route: () => reply(200, { login: "someone" }),
      copilot,
    });
    const result = await check(D.copilot(["claude-haiku-5.5"]));
    assert.equal(requests[0].url, "https://api.github.com/user");
    assert.equal(headerOf(requests[0], "authorization"), `Bearer ${KEYS.GITHUB_COPILOT_TOKEN}`);
    assert.equal(headerOf(requests[0], "x-github-api-version"), "2022-11-28");
    assert.equal(result.proof, "identity");
    assert.equal(result.credentials, "accepted");
    assert.equal(listCalls.length, 0, "the runtime isn't started");
    assert.deepEqual(result.models, { "claude-haiku-5.5": "unknown" });
  });
  await t.test("Check: Copilot's plan, fresh", async () => {
    const { check } = createHarness({ route: () => reply(200, {}), copilot });
    const result = await check(D.copilot(["claude-haiku-5.5", "retired-model"]), { fresh: true });
    assert.deepEqual(listCalls.at(-1), { refresh: true });
    assert.equal(result.proof, "service");
    assert.deepEqual(result.models, { "claude-haiku-5.5": "offered", "retired-model": "missing" });
  });
  await t.test("a token GitHub refuses, and one Copilot refuses", async () => {
    const refused = await createHarness({ route: () => reply(401, {}), copilot }).check(
      D.copilot()
    );
    assert.equal(refused.credentials, "rejected");
    const noAccess = await createHarness({
      route: () => reply(200, {}),
      copilot: {
        runtime: {
          listModels: async () => {
            throw Object.assign(new Error("no"), {
              code: "COPILOT_SDK_ERROR",
              errorType: "authentication",
            });
          },
        },
        auth: copilot.auth,
      },
    }).check(D.copilot(), { fresh: true });
    assert.equal(noAccess.credentials, "rejected");
    assert.equal(rejected.length, 1, "the sign-in is marked rejected, as copilot-list-models does");
    const limited = await createHarness({
      route: () =>
        reply(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }),
      copilot,
    }).check(D.copilot());
    assert.equal(limited.code, "PROVIDER_RATE_LIMITED");
  });
});

test("redirects: followed within the origin, never with a key to another", async () => {
  const sameOrigin = createHarness({
    route: (url) =>
      url.endsWith("/v1/models")
        ? reply(307, "", { location: "/v1/models/" })
        : reply(200, list("gpt-5-mini")),
  });
  assert.equal((await sameOrigin.check(D.openai())).credentials, "accepted");
  assert.equal(sameOrigin.requests.length, 2);

  const elsewhere = createHarness({
    route: () => reply(302, "", { location: "https://collector.example/steal" }),
  });
  const result = await elsewhere.check(D.openai());
  assert.equal(elsewhere.requests.length, 1, "not followed");
  assert.equal(result.code, "CHECK_REDIRECTED");
});

test("descriptors outside a kind's allowlist are refused before a key is read", async () => {
  const cases = [
    { ...D.openai(), route: "https://collector.example/v1" },
    { ...D.groq(), slot: "OPENAI_API_KEY" },
    { ...D.endpoint(), slot: "GROQ_API_KEY" },
    { ...D.endpoint("http://public.example.com/v1") },
    { ...D.custom(), route: `${AZURE}/openai/deployments/x` },
    { ...D.azureSpeech(), route: "https://evil.example.com" },
    { ...D.cortiStt(), route: "https://auth.evil.corti.app.example/realms/base" },
    { ...D.selfHosted(), slot: "OPENAI_API_KEY" },
    { ...D.openai(), kind: "shell" },
    { ...D.openai(), models: [42] },
  ];
  for (const descriptor of cases) {
    const { checks, requests, reads } = createHarness();
    const answer = checks.run({ descriptors: [descriptor], maxAgeMs: 0, fresh: true });
    await checks.idle();
    assert.equal(
      answer.results[descriptor.id]?.code,
      "CHECK_INVALID_ROUTE",
      JSON.stringify(descriptor)
    );
    assert.deepEqual(answer.pending, []);
    assert.equal(requests.length, 0);
    assert.deepEqual(reads, [], "no key read");
  }
  assert.equal(validateDescriptor({ id: "bad id with spaces" }).id, null);
});

test("no key saved: not checked, nothing sent", async () => {
  const { check, requests } = createHarness({ keys: {} });
  const result = await check(D.groq());
  assert.equal(result.code, "API_KEY_MISSING");
  assert.equal(requests.length, 0);
});
