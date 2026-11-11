// Providers this fork ships that no model registry publication lists: GitHub Copilot (a
// language-model provider, whose live list replaces these models once signed in) and
// Azure Speech's MAI-Transcribe-2. modelRegistryData.json is generated from the signed
// registry and model-registry:verify refuses a hand edit, so they join the bundled catalog
// here, as upstream's appTranscriptionProviders.js does for OpenRouter. Main's registry
// loader keeps every provider the bundle has, so both survive every live catalog.
export const FORK_TRANSCRIPTION_PROVIDERS = Object.freeze([
  {
    id: "azure-speech",
    name: "Azure Speech",
    baseUrl: "",
    models: [
      {
        id: "MAI-Transcribe-2",
        name: "MAI-Transcribe-2",
        description: "Microsoft's speech-to-text, through your Azure Speech resource",
        descriptionKey: "models.descriptions.transcription.azure_speech_mai_transcribe_2",
      },
    ],
  },
]);

export const FORK_CLOUD_PROVIDERS = Object.freeze([
  {
    id: "copilot",
    name: "GitHub Copilot",
    defaultModel: "claude-haiku-5.5",
    models: [
      {
        id: "claude-haiku-5.5",
        name: "Claude Haiku 5.5",
        description: "Fast and low-cost, recommended for dictation cleanup",
        descriptionKey: "models.descriptions.cloud.copilot_claude_haiku_5_5",
        supportsThinking: true,
      },
      {
        id: "mai-code-2-flash",
        name: "MAI-Code-2-Flash",
        description: "Fast Microsoft model",
        descriptionKey: "models.descriptions.cloud.copilot_mai_code_2_flash",
        supportsThinking: true,
      },
      {
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
        description: "Fast, low-cost OpenAI model",
        descriptionKey: "models.descriptions.cloud.copilot_gpt_6_luna",
        supportsThinking: true,
      },
      {
        id: "claude-sonnet-5.5",
        name: "Claude Sonnet 5.5",
        description: "More capable Claude model for long notes",
        descriptionKey: "models.descriptions.cloud.copilot_claude_sonnet_5_5",
        supportsThinking: true,
      },
    ],
  },
]);

function appendMissing(list, additions) {
  const listed = new Set((Array.isArray(list) ? list : []).map((provider) => provider?.id));
  return [
    ...(Array.isArray(list) ? list : []),
    ...structuredClone(additions.filter((provider) => !listed.has(provider.id))),
  ];
}

// A catalog that lists one of these keeps its own entry.
export function withForkProviders(catalog) {
  return {
    ...catalog,
    transcriptionProviders: appendMissing(
      catalog.transcriptionProviders,
      FORK_TRANSCRIPTION_PROVIDERS
    ),
    cloudProviders: appendMissing(catalog.cloudProviders, FORK_CLOUD_PROVIDERS),
  };
}
