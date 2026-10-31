const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  SIGNED_OUT_OWNER,
  createStepHistory,
  createStepRunRegistry,
  hashPrompt,
  normalizeTrace,
  ownerKeyFor,
} = require("../../src/helpers/stepHistory.js");
const {
  recordPastedText,
  runPostTranscription,
  SERVER_PROMPT_REF,
} = require("../../src/helpers/postTranscription.ts");

// Step history's pure parts: the trace main accepts from the renderer, the
// runs that carry ownership and retry revisions, and the prompt reference the
// boundary records per model step. Synthetic text only.

const PROMPT = "Clean up this transcript for Jarvis.\n\nRespond in English.";

const baseTrace = (overrides = {}) => ({
  version: 1,
  rawText: "hello littlebuddy",
  workingText: "hello Little Buddy",
  finalText: "Hello, Little Buddy.",
  context: {
    targetApp: "Code.exe",
    intents: { voiceAgent: false, translation: false, wakeWord: false },
  },
  route: "cleanup",
  glossary: {
    revision: 4,
    rulesFired: [
      {
        ruleId: "rule-1",
        spelling: "littlebuddy",
        scope: "anywhere",
        from: "littlebuddy",
        to: "Little Buddy",
        index: 6,
      },
    ],
  },
  steps: [
    {
      kind: "stt",
      outcome: "ok",
      output: "hello littlebuddy",
      provider: "groq",
      model: "w",
      ms: 9,
    },
    {
      kind: "glossary",
      outcome: "ok",
      output: "hello Little Buddy",
      provider: null,
      model: null,
      ms: 1,
    },
    {
      kind: "cleanup",
      outcome: "ok",
      output: "Hello, Little Buddy.",
      provider: "copilot",
      model: "claude-haiku-5.5",
      ms: 1400.4,
      prompt: { source: "resolved", text: PROMPT, entryId: "migrated" },
    },
  ],
  ...overrides,
});

test("owners are an account or the signed-out namespace", () => {
  assert.equal(ownerKeyFor("acct-1"), "account:acct-1");
  assert.equal(ownerKeyFor("  acct-1 "), "account:acct-1");
  assert.equal(ownerKeyFor(null), SIGNED_OUT_OWNER);
  assert.equal(ownerKeyFor(""), SIGNED_OUT_OWNER);
});

test("a trace is normalized into what the database stores", () => {
  const normalized = normalizeTrace(baseTrace());
  assert.equal(normalized.version, 1);
  assert.equal(normalized.route, "cleanup");
  assert.deepEqual(normalized.context, {
    targetApp: "Code.exe",
    intents: { voiceAgent: false, translation: false, wakeWord: false },
  });
  assert.deepEqual(
    normalized.steps.map((step) => step.kind),
    ["stt", "glossary", "cleanup"]
  );
  const [stt, glossary, cleanup] = normalized.steps;
  assert.equal(stt.prompt, null);
  assert.deepEqual(glossary.detail, {
    revision: 4,
    rulesFired: [
      {
        ruleId: "rule-1",
        spelling: "littlebuddy",
        scope: "anywhere",
        from: "littlebuddy",
        to: "Little Buddy",
        index: 6,
      },
    ],
  });
  assert.equal(cleanup.ms, 1400);
  assert.deepEqual(cleanup.prompt, {
    source: "resolved",
    hash: crypto.createHash("sha256").update(PROMPT, "utf8").digest("hex"),
    text: PROMPT,
    entryId: "migrated",
  });
  assert.equal(hashPrompt(PROMPT), cleanup.prompt.hash);
});

test("a null raw transcript gets no invented stt step", () => {
  const normalized = normalizeTrace(baseTrace(), { rawTextIsNull: true });
  assert.deepEqual(
    normalized.steps.map((step) => step.kind),
    ["glossary", "cleanup"]
  );
});

test("unknown kinds, outcomes, versions and oversized prompts are refused", () => {
  assert.equal(normalizeTrace(null), null);
  assert.equal(normalizeTrace({ ...baseTrace(), version: 2 }), null);
  assert.equal(normalizeTrace({ ...baseTrace(), steps: "nope" }), null);
  assert.equal(
    normalizeTrace({ ...baseTrace(), steps: [{ kind: "rm -rf", outcome: "ok" }] }),
    null
  );

  const mixed = normalizeTrace(
    baseTrace({
      route: "something-else",
      steps: [
        { kind: "cleanup", outcome: "exploded", output: "x" },
        { kind: "bogus", outcome: "ok", output: "x" },
        {
          kind: "cleanup",
          outcome: "ok",
          output: "y",
          prompt: { source: "resolved", text: "p".repeat(200_001) },
        },
        { kind: "cleanup", outcome: "ok", output: "z", prompt: { source: "invented", text: "p" } },
        { kind: "cleanup", outcome: "ok", output: "s", prompt: { ...SERVER_PROMPT_REF } },
      ],
    })
  );
  assert.equal(mixed.route, null);
  assert.deepEqual(
    mixed.steps.map((step) => [step.output, step.prompt?.source ?? null]),
    [
      ["y", null],
      ["z", null],
      ["s", "server"],
    ]
  );
  assert.deepEqual(mixed.steps[2].prompt, {
    source: "server",
    hash: null,
    text: null,
    entryId: null,
  });

  const many = normalizeTrace(
    baseTrace({
      steps: Array.from({ length: 50 }, () => ({ kind: "finalize", outcome: "ok", output: "t" })),
    })
  );
  assert.equal(many.steps.length, 32, "a trace is capped");
});

test("only the snippets marker survives as finalize detail", () => {
  const normalized = normalizeTrace(
    baseTrace({
      steps: [
        { kind: "finalize", outcome: "ok", output: "a", detail: { snippets: true, extra: "x" } },
        { kind: "finalize", outcome: "ok", output: "b", detail: { anything: 1 } },
      ],
    })
  );
  assert.deepEqual(
    normalized.steps.map((step) => step.detail),
    [{ snippets: true }, null]
  );
});

test("a cleanup or style step keeps its dictionary word set, enums and a count only", () => {
  const scope = { setting: "typedPinnedMissed", applied: "all", words: 12 };
  const normalized = normalizeTrace(
    baseTrace({
      steps: [
        { kind: "cleanup", outcome: "ok", output: "a", detail: { dictionaryScope: scope } },
        {
          kind: "style",
          outcome: "fallback",
          output: "b",
          detail: {
            styleId: "teams",
            runMode: "one-step",
            dictionaryScope: { ...scope, words: 0, extra: "OpenWhispr" },
            failure: { code: "PROVIDER_AUTH_FAILED" },
          },
        },
        // Invented values and other kinds lose it.
        {
          kind: "cleanup",
          outcome: "ok",
          output: "c",
          detail: { dictionaryScope: { setting: "most", applied: "all", words: 1 } },
        },
        {
          kind: "cleanup",
          outcome: "ok",
          output: "d",
          detail: { dictionaryScope: { setting: "all", applied: "all", words: 10_001 } },
        },
        {
          kind: "cleanup",
          outcome: "ok",
          output: "e",
          detail: { dictionaryScope: { setting: "all", applied: "all", words: 1.5 } },
        },
        { kind: "translation", outcome: "ok", output: "f", detail: { dictionaryScope: scope } },
        { kind: "finalize", outcome: "ok", output: "g", detail: { dictionaryScope: scope } },
      ],
    })
  );
  assert.deepEqual(
    normalized.steps.map((step) => step.detail),
    [
      { dictionaryScope: scope },
      {
        styleId: "teams",
        runMode: "one-step",
        dictionaryScope: { setting: "typedPinnedMissed", applied: "all", words: 0 },
        failure: { code: "PROVIDER_AUTH_FAILED" },
      },
      null,
      null,
      null,
      null,
      null,
    ]
  );
});

test("a cleanup step keeps 'all but everyday words' and its fallback to All", () => {
  const applied = { setting: "noEveryday", applied: "noEveryday", words: 140 };
  const fellBack = { setting: "noEveryday", applied: "all", words: 215 };
  const normalized = normalizeTrace(
    baseTrace({
      steps: [
        { kind: "cleanup", outcome: "ok", output: "a", detail: { dictionaryScope: applied } },
        { kind: "cleanup", outcome: "ok", output: "b", detail: { dictionaryScope: fellBack } },
      ],
    })
  );
  assert.deepEqual(
    normalized.steps.map((step) => step.detail),
    [{ dictionaryScope: applied }, { dictionaryScope: fellBack }]
  );
});

test("a run completes once, and a newer retry overtakes an older one", () => {
  let ids = 0;
  let clock = 1_000;
  const runs = createStepRunRegistry({
    now: () => clock,
    randomId: () => `run-${++ids}`,
    ttlMs: 100,
    maxRuns: 3,
  });

  const plain = runs.begin("account:a");
  const taken = runs.take(plain);
  assert.deepEqual(
    { owner: taken.owner, transcriptionId: taken.transcriptionId },
    { owner: "account:a", transcriptionId: null }
  );
  assert.equal(runs.isCurrent(taken), true);
  assert.equal(runs.take(plain), null, "a run completes at most once");
  assert.equal(runs.take(undefined), null);

  const older = runs.begin("account:a", { transcriptionId: 7 });
  const newer = runs.begin("account:a", { transcriptionId: 7 });
  const olderRun = runs.take(older);
  const newerRun = runs.take(newer);
  assert.equal(runs.isCurrent(newerRun), true);
  assert.equal(runs.isCurrent(olderRun), false, "the older retry's completion is stale");

  // Abandoned runs expire and the registry stays bounded.
  const expired = runs.begin("signed-out");
  clock += 101;
  assert.equal(runs.take(expired), null);
  const kept = [1, 2, 3, 4].map(() => runs.begin("signed-out"));
  assert.equal(runs.take(kept[0]), null, "the oldest open run is dropped past the cap");
  assert.ok(runs.take(kept[3]));
});

test("an overtaken retry's own speech-to-text writes are dropped too", () => {
  const writes = [];
  const db = {
    getTranscriptionById: (id) => ({ id, audio_duration_ms: 2100 }),
    updateTranscriptionText: (id, text, rawText) => writes.push(["text", id, text, rawText]),
    updateTranscriptionStatus: (id, status) => writes.push(["status", id, status]),
    updateTranscriptionAudio: (id, audio) => writes.push(["audio", id, audio]),
  };
  const history = createStepHistory({
    db,
    getOwner: () => "account:a",
    isEnabled: () => true,
  });
  // Re-transcribe begins; Re-run cleanup of the same row begins after it.
  const retranscribe = history.beginRun({ transcriptionId: 7 });
  const stillCurrent = history.currentRunCheck(retranscribe);
  assert.equal(stillCurrent(), true);
  history.beginRun({ transcriptionId: 7 });
  assert.equal(stillCurrent(), false);
  assert.deepEqual(
    history.saveRetranscription(7, { text: "heard again", isCurrent: stillCurrent }),
    { stale: true, transcription: null }
  );
  assert.deepEqual(writes, [], "nothing at all is written");

  // Another row's runs never overtake this one; an unknown run can't be overtaken.
  const other = history.beginRun({ transcriptionId: 8 });
  const otherCurrent = history.currentRunCheck(other);
  history.beginRun({ transcriptionId: 9 });
  assert.equal(otherCurrent(), true);
  assert.equal(history.currentRunCheck(null)(), true);
  const saved = history.saveRetranscription(8, {
    text: "heard",
    provider: "groq",
    model: "whisper-large-v3",
    isCurrent: otherCurrent,
  });
  assert.equal(saved.stale, false);
  assert.deepEqual(writes, [
    ["text", 8, "heard", "heard"],
    ["status", 8, "completed"],
    [
      "audio",
      8,
      { hasAudio: 1, audioDurationMs: 2100, provider: "groq", model: "whisper-large-v3" },
    ],
  ]);
});

test("the boundary records each model step's prompt as dispatched", async () => {
  const { trace } = await runPostTranscription("so littlebuddy", {
    run: async ({ workingText, recordStep }) => {
      const cleaned = await recordStep("cleanup", {}, async (dispatched) => {
        dispatched({
          provider: "openai",
          model: "gpt-4.1-mini",
          prompt: { source: "resolved", text: PROMPT, entryId: "default" },
        });
        // A text-only rerun reports the prompt it actually sent.
        dispatched({ prompt: { source: "resolved", text: `${PROMPT} (text only)` } });
        return `${workingText}!`;
      });
      await recordStep("translation", {}, async (dispatched) => {
        dispatched({ provider: "groq", model: "m", prompt: { source: "resolved" } });
        return cleaned;
      });
      return recordStep(
        "cleanup",
        { provider: "openwhispr", prompt: SERVER_PROMPT_REF },
        async () => cleaned
      );
    },
  });
  const [cleanup, translation, cloud] = trace.steps.filter((step) => step.provider);
  assert.deepEqual(cleanup.prompt, { source: "resolved", text: `${PROMPT} (text only)` });
  assert.equal("prompt" in translation, false, "a malformed reference is not recorded");
  assert.deepEqual(cloud.prompt, { source: "server" });
  assert.equal("prompt" in trace.steps[0], false, "the stt step has no prompt");
  assert.equal("runId" in trace, false, "no run id until main has issued one");
});

test("snippets expanded after the boundary end the trace with what was pasted", () => {
  const trace = {
    ...baseTrace(),
    finalText: "Thanks, ;sig",
  };
  assert.equal(recordPastedText(trace, "Thanks, ;sig"), trace, "unchanged text, same trace");
  const pasted = recordPastedText(trace, "Thanks, Dmitri");
  assert.notEqual(pasted, trace);
  assert.equal(pasted.finalText, "Thanks, Dmitri");
  assert.deepEqual(pasted.steps.at(-1), {
    kind: "finalize",
    outcome: "ok",
    output: "Thanks, Dmitri",
    provider: null,
    model: null,
    ms: 0,
    detail: { snippets: true },
  });
  assert.equal(trace.steps.length, 3, "the original trace is not mutated");
  assert.equal(recordPastedText(null, "x"), null);
});
