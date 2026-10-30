const test = require("node:test");
const assert = require("node:assert/strict");

// Azure Speech (MAI-Transcribe-2): the endpoint rule the key depends on, the
// language map, the request's `definition`, the answer, the route and its
// size cap, and the dictionary's phrase-list channel. Synthetic values only.

const load = () => import("../../src/helpers/azureSpeechTranscription.js");
const loadRoute = () => import("../../src/helpers/transcriptionRoute.ts");
const languages = require("../../src/config/languageRegistry.json").languages;

const ORIGIN = "https://res.cognitiveservices.azure.com";
const TRANSCRIBE_URL = `${ORIGIN}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`;

test("the endpoint: https, a Speech resource's origin only", async () => {
  const { azureSpeechEndpointError, isAzureSpeechEndpoint, azureSpeechOrigin } = await load();
  for (const ok of [
    ORIGIN,
    `${ORIGIN}/`,
    "  https://Res.CognitiveServices.Azure.com  ",
    "https://westus2.api.cognitive.microsoft.com",
  ]) {
    assert.equal(azureSpeechEndpointError(ok), null, ok);
    assert.equal(isAzureSpeechEndpoint(ok), true, ok);
  }
  assert.equal(azureSpeechOrigin(`${ORIGIN}/`), ORIGIN);
  assert.equal(azureSpeechOrigin("https://Res.CognitiveServices.Azure.com"), ORIGIN);

  const reasons = {
    "": "required",
    "not a url": "invalidUrl",
    "res.cognitiveservices.azure.com": "invalidUrl",
    "ftp://res.cognitiveservices.azure.com": "invalidUrl",
    "http://res.cognitiveservices.azure.com": "httpsRequired",
    // Azure OpenAI and Foundry hosts take a different header: not this validator's.
    "https://res.openai.azure.com": "host",
    "https://res.services.ai.azure.com": "host",
    "https://cognitiveservices.azure.com": "host",
    "https://a.b.cognitiveservices.azure.com": "host",
    "https://res.cognitiveservices.azure.com.evil.example": "host",
    "https://example.com": "host",
    "https://res.cognitiveservices.azure.com/speechtotext": "resourceOnly",
    [TRANSCRIBE_URL]: "resourceOnly",
    "https://res.cognitiveservices.azure.com/?x=1": "resourceOnly",
    "https://res.cognitiveservices.azure.com/#frag": "resourceOnly",
    "https://res.cognitiveservices.azure.com:8443": "resourceOnly",
    "https://user:pw@res.cognitiveservices.azure.com": "resourceOnly",
  };
  for (const [input, reason] of Object.entries(reasons)) {
    assert.equal(azureSpeechEndpointError(input), reason, input);
    assert.equal(isAzureSpeechEndpoint(input), false, input);
  }
  assert.equal(azureSpeechEndpointError(undefined), "required");
});

test("the renderer's validator is the same one (urlUtils re-exports it)", async () => {
  const urlUtils = await import("../../src/utils/urlUtils.ts");
  const { isAzureSpeechEndpoint } = await load();
  assert.equal(urlUtils.isAzureSpeechEndpoint, isAzureSpeechEndpoint);
  // isAzureOpenAIEndpoint stays its own rule: it accepts this host and would pick `api-key`.
  assert.equal(urlUtils.isAzureOpenAIEndpoint(ORIGIN), true);
  assert.equal(urlUtils.isAzureSpeechEndpoint("https://res.openai.azure.com"), false);
});

test("the field tidies an endpoint once editing ends", async () => {
  const { normalizeAzureSpeechEndpoint } = await load();
  assert.equal(normalizeAzureSpeechEndpoint("res.cognitiveservices.azure.com"), ORIGIN);
  assert.equal(normalizeAzureSpeechEndpoint(` ${ORIGIN}/ `), ORIGIN);
  assert.equal(normalizeAzureSpeechEndpoint(""), "");
  // What can't be used stays as typed, so the field can say why.
  assert.equal(normalizeAzureSpeechEndpoint(`${ORIGIN}/x`), `${ORIGIN}/x`);
  assert.equal(
    normalizeAzureSpeechEndpoint("http://res.cognitiveservices.azure.com"),
    "http://res.cognitiveservices.azure.com"
  );
});

test("the transcribe URL, and the check main makes before sending the key", async () => {
  const { buildAzureSpeechTranscribeUrl, isAzureSpeechTranscribeUrl } = await load();
  assert.equal(buildAzureSpeechTranscribeUrl(`${ORIGIN}/`), TRANSCRIBE_URL);
  assert.equal(buildAzureSpeechTranscribeUrl("https://res.openai.azure.com"), null);
  assert.equal(isAzureSpeechTranscribeUrl(TRANSCRIBE_URL), true);
  for (const url of [
    ORIGIN,
    `${ORIGIN}/speechtotext/transcriptions:transcribe`,
    `${ORIGIN}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`,
    "https://res.openai.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    "https://evil.example/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    null,
  ]) {
    assert.equal(isAzureSpeechTranscribeUrl(url), false, String(url));
  }
});

// Microsoft's MAI-Transcribe-2 list (Learn, "Language support") against
// languageRegistry.json: what each of the app's languages sends.
test("every app language maps to MAI's code, an alias, or no locale", async () => {
  const { resolveMaiLocale, maiLocale } = await load();
  const UNSUPPORTED = ["be", "hr", "mt", "mi", "sr", "cy"];
  const ALIASES = { no: "nb", tl: "fil" };
  const seen = { mapped: [], aliased: [], unsupported: [] };
  for (const { code } of languages) {
    const { locale, unsupported } = resolveMaiLocale(code);
    const base = code.split("-")[0];
    if (code === "auto") {
      assert.deepEqual(resolveMaiLocale(code), { locale: null, unsupported: null });
    } else if (UNSUPPORTED.includes(base)) {
      assert.deepEqual({ locale, unsupported }, { locale: null, unsupported: base }, code);
      seen.unsupported.push(code);
    } else if (ALIASES[base]) {
      assert.equal(locale, ALIASES[base], code);
      seen.aliased.push(code);
    } else {
      assert.equal(locale, base, code);
      seen.mapped.push(code);
    }
  }
  assert.deepEqual(seen.unsupported, UNSUPPORTED);
  assert.deepEqual(seen.aliased, ["no", "tl"]);
  // Base codes, as Microsoft's examples use (["en"], not "en-US").
  assert.equal(maiLocale("en-US"), "en");
  assert.equal(maiLocale("en-GB"), "en");
  assert.equal(maiLocale("zh-CN"), "zh");
  assert.equal(maiLocale("zh-TW"), "zh");
  assert.equal(maiLocale(""), null);
  assert.equal(maiLocale(undefined), null);
});

test("the definition: the model, a locale only when set, at most 199 phrases, no modelOptions", async () => {
  const { buildAzureSpeechDefinition, AZURE_SPEECH_MAX_PHRASES } = await load();
  assert.equal(AZURE_SPEECH_MAX_PHRASES, 199);
  assert.equal(
    buildAzureSpeechDefinition({
      model: "MAI-Transcribe-2",
      locale: "en",
      phrases: ["OpenWhispr", "XerahS"],
    }),
    '{"locales":["en"],"enhancedMode":{"enabled":true,"model":"MAI-Transcribe-2"},"phraseList":{"phrases":["OpenWhispr","XerahS"]}}'
  );
  assert.equal(
    buildAzureSpeechDefinition({ model: "MAI-Transcribe-2", locale: null, phrases: [] }),
    '{"enhancedMode":{"enabled":true,"model":"MAI-Transcribe-2"}}'
  );
  const many = Array.from({ length: 205 }, (_, index) => `term-${index}`);
  const definition = JSON.parse(buildAzureSpeechDefinition({ phrases: [...many, "  ", null] }));
  assert.equal(definition.phraseList.phrases.length, 199);
  assert.deepEqual(definition.phraseList.phrases, many.slice(0, 199), "the head is kept");
  assert.equal(definition.enhancedMode.model, "MAI-Transcribe-2", "the default model");
  assert.equal("modelOptions" in definition, false);
  assert.equal("modelOptions" in definition.enhancedMode, false);
});

test("the request main sends: the key header, `audio` and `definition`, or nothing", async () => {
  const { buildAzureSpeechRequest } = await load();
  assert.deepEqual(
    buildAzureSpeechRequest({ endpoint: ORIGIN, apiKey: "k", model: "MAI-Transcribe-2" }),
    {
      endpoint: TRANSCRIBE_URL,
      headers: { "Ocp-Apim-Subscription-Key": "k" },
      fields: [["definition", '{"enhancedMode":{"enabled":true,"model":"MAI-Transcribe-2"}}']],
      audioPart: "audio",
    }
  );
  assert.equal(
    buildAzureSpeechRequest({ endpoint: TRANSCRIBE_URL, apiKey: "k" }).endpoint,
    TRANSCRIBE_URL
  );
  assert.equal(buildAzureSpeechRequest({ endpoint: "https://evil.example", apiKey: "k" }), null);
});

test("the answer is combinedPhrases[].text, trimmed and joined; silence is empty", async () => {
  const { parseAzureSpeechAnswer } = await load();
  assert.equal(
    parseAzureSpeechAnswer({
      combinedPhrases: [{ text: " Hello there. " }, { text: "" }, { text: "Second channel." }],
      phrases: [{ text: "ignored" }],
    }),
    "Hello there. Second channel."
  );
  assert.equal(parseAzureSpeechAnswer('{"combinedPhrases":[{"text":"Weather"}]}'), "Weather");
  assert.equal(parseAzureSpeechAnswer({ durationMilliseconds: 2000, combinedPhrases: [] }), "");
  assert.equal(parseAzureSpeechAnswer({}), "");
  assert.equal(parseAzureSpeechAnswer("not json"), "");
  assert.equal(parseAzureSpeechAnswer(null), "");
});

test("uploads: WAV, MP3 and FLAC go as they are", async () => {
  const { isAzureSpeechAcceptedExtension } = await load();
  for (const extension of ["wav", "WAV", "mp3", "flac"]) {
    assert.equal(isAzureSpeechAcceptedExtension(extension), true, extension);
  }
  for (const extension of ["webm", "m4a", "ogg", "opus", "aac", "", undefined]) {
    assert.equal(isAzureSpeechAcceptedExtension(extension), false, String(extension));
  }
});

// ── The route ────────────────────────────────────────────────────────────────

const azureSettings = (overrides = {}) => ({
  transcriptionMode: "providers",
  cloudTranscriptionProvider: "azure-speech",
  cloudTranscriptionModel: "MAI-Transcribe-2",
  azureSpeechEndpoint: ORIGIN,
  preferredLanguage: "en-US",
  ...overrides,
});

test("the route: its own transport, the transcribe URL, the model, the language and 250 MB", async () => {
  const { resolveTranscriptionRoute } = await loadRoute();
  assert.deepEqual(resolveTranscriptionRoute({ settings: azureSettings() }), {
    transport: "azure-speech",
    provider: "azure-speech",
    endpoint: TRANSCRIBE_URL,
    model: "MAI-Transcribe-2",
    language: "en",
    locale: "en",
    sizeCapBytes: 250 * 1024 * 1024,
    auth: { scheme: "azure-speech-key", keyRef: "azure-speech" },
  });
  const auto = resolveTranscriptionRoute({
    settings: azureSettings({ preferredLanguage: "auto" }),
  });
  assert.equal(auto.language, undefined);
  assert.equal(auto.locale, null);
  assert.equal(
    resolveTranscriptionRoute({ settings: azureSettings({ preferredLanguage: "no" }) }).locale,
    "nb"
  );
  assert.equal(
    resolveTranscriptionRoute({ settings: azureSettings({ preferredLanguage: "cy" }) }).locale,
    null,
    "a language MAI doesn't list auto-detects"
  );
});

test("the route: a translation from Auto never sends the ordinary preferred language", async () => {
  const { resolveTranscriptionRoute } = await loadRoute();
  // Dictation passes the translation-aware language; "auto" means none.
  const fromAuto = resolveTranscriptionRoute({
    settings: azureSettings({ preferredLanguage: "en" }),
    request: { effectiveLanguage: "auto" },
  });
  assert.equal(fromAuto.language, undefined);
  assert.equal(fromAuto.locale, null);
  const fromGerman = resolveTranscriptionRoute({
    settings: azureSettings({ preferredLanguage: "en" }),
    request: { effectiveLanguage: "de" },
  });
  assert.equal(fromGerman.locale, "de");
  // Callers that pass none keep the preferred language, as before.
  assert.equal(
    resolveTranscriptionRoute({
      settings: azureSettings({ preferredLanguage: "fr" }),
      request: { effectiveLanguage: undefined },
    }).locale,
    "fr"
  );
});

test("the route fails closed without a valid endpoint, never falling through", async () => {
  const { resolveTranscriptionRoute } = await loadRoute();
  for (const azureSpeechEndpoint of [
    undefined,
    "",
    "https://res.openai.azure.com",
    "https://api.openai.com/v1",
    `${ORIGIN}/speechtotext`,
  ]) {
    const route = resolveTranscriptionRoute({ settings: azureSettings({ azureSpeechEndpoint }) });
    assert.deepEqual(
      route,
      {
        transport: "error",
        message: "Add your Azure Speech endpoint in Settings → AI Connections & Local Models.",
        code: "AZURE_SPEECH_ENDPOINT_INVALID",
        messageKey: "hooks.audioRecording.errorDescriptions.azureSpeechEndpointMissing",
        settingsTarget: "speechToText",
      },
      String(azureSpeechEndpoint)
    );
  }
  const en = require("../../src/locales/en/translation.json");
  assert.equal(
    en.hooks.audioRecording.errorDescriptions.azureSpeechEndpointMissing,
    "Add your Azure Speech endpoint in Settings → AI Connections & Local Models."
  );
});

test("the route: an organization allowlist that doesn't name it is a policy refusal", async () => {
  const { resolveTranscriptionRoute } = await loadRoute();
  const policy = (allowedByokProviders) => ({
    status: "managed",
    appVersion: "1.10.3",
    policy: {
      version: 1,
      transcription: {
        allowedModes: ["providers"],
        allowedByokProviders,
        allowedEnterpriseProviders: [],
      },
      llm: { allowedModes: ["providers"], allowedByokProviders: ["openai"] },
      features: { agentEnabled: true, webSearchEnabled: true, screenContextEnabled: true },
      sharing: { externalLinkSharing: "allowed" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: true,
      },
      minAppVersion: null,
    },
  });
  assert.equal(
    resolveTranscriptionRoute({ settings: azureSettings(), policy: policy(["openai"]) }).code,
    "POLICY_RESTRICTED"
  );
  assert.equal(
    resolveTranscriptionRoute({ settings: azureSettings(), policy: policy(["azure-speech"]) })
      .transport,
    "azure-speech"
  );
});

test("one size cap per provider: 25 MB, Gemini 14 MB, Azure Speech 250 MB", async () => {
  const { byokFileSizeLimit } = await loadRoute();
  assert.equal(byokFileSizeLimit("openai"), 25 * 1024 * 1024);
  assert.equal(byokFileSizeLimit("custom"), 25 * 1024 * 1024);
  assert.equal(byokFileSizeLimit("gemini"), 14 * 1024 * 1024);
  assert.equal(byokFileSizeLimit("azure-speech"), 250 * 1024 * 1024);
});

test("the model: MAI-Transcribe ids are kept, anything else is MAI-Transcribe-2", async () => {
  const { resolveByokModel } = await loadRoute();
  assert.equal(resolveByokModel("azure-speech", "MAI-Transcribe-2"), "MAI-Transcribe-2");
  assert.equal(resolveByokModel("azure-speech", "MAI-Transcribe-1.5"), "MAI-Transcribe-1.5");
  assert.equal(resolveByokModel("azure-speech", "gpt-4o-transcribe"), "MAI-Transcribe-2");
  assert.equal(resolveByokModel("azure-speech", ""), "MAI-Transcribe-2");
});

// ── The phrase-list channel ──────────────────────────────────────────────────

test("the dictionary's phrase list: 199 entries at most, the most important first", async () => {
  const { buildDictionaryHints, resolveHintTarget } =
    await import("../../src/utils/dictionaryHints.ts");
  const target = resolveHintTarget({ engine: "byok", provider: "azure-speech" });
  assert.deepEqual(target, {
    channel: "phrases",
    order: "head",
    maxChars: Infinity,
    readChars: Infinity,
    maxTerms: 199,
  });
  // 205 entries: 200 typed, 2 glossary forms, 1 snippet trigger, 2 learned.
  const typed = Array.from({ length: 200 }, (_, index) => `Typed${index}`);
  const plan = buildDictionaryHints({
    dictionary: [...typed, "learned-one", "learned-two"],
    learnedWords: ["learned-one", "learned-two"],
    glossaryTerms: ["GlossaryA", "GlossaryB"],
    snippets: [{ trigger: "sig", text: "x" }],
    maxChars: target.maxChars,
    maxTerms: target.maxTerms,
    order: target.order,
    readChars: target.readChars,
  });
  assert.equal(plan.entries.length, 205);
  assert.equal(plan.terms.length, 199);
  assert.deepEqual(plan.terms, typed.slice(0, 199), "typed words first");
  assert.equal(plan.truncated, true);
  const notSent = plan.entries.filter((entry) => entry.coverage === "notSent");
  assert.deepEqual(
    notSent.map((entry) => entry.term),
    ["Typed199", "GlossaryA", "GlossaryB", "sig", "learned-one", "learned-two"],
    "the Dictionary page shows which 6 aren't sent"
  );
  assert.ok(
    plan.entries
      .filter((entry) => entry.coverage !== "notSent")
      .every((entry) => entry.coverage === "read")
  );

  // A small dictionary goes whole, in priority order.
  const small = buildDictionaryHints({
    dictionary: ["Typed", "learned"],
    learnedWords: ["learned"],
    glossaryTerms: ["Gloss"],
    snippets: [{ trigger: "sig", text: "x" }],
    maxTerms: 199,
    order: "head",
  });
  assert.deepEqual(small.terms, ["Typed", "Gloss", "sig", "learned"]);
});
