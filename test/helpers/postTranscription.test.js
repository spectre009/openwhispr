const test = require("node:test");
const assert = require("node:assert/strict");

const {
  POST_TRANSCRIPTION_TRACE_VERSION,
  runPostTranscription,
  summarizeGlossaryTrace,
} = require("../../src/helpers/postTranscription.ts");

const GLOSSARY = Object.freeze({
  revision: 7,
  rules: [
    {
      id: "rule-little-buddy",
      canonical: "Little Buddy",
      enabled: true,
      revision: 3,
      apps: ["Code.exe"],
      spellings: [
        { text: "littlebuddy", scope: "anywhere" },
        { text: "everybody", scope: "start" },
      ],
    },
  ],
});

const RAW = "Hello, everybody. I need you to take a look at the build.";
const CORRECTED = "Hello, Little Buddy. I need you to take a look at the build.";

let clock = 0;
const now = () => (clock += 5);

test("the trace has the documented shape, in step order", async () => {
  const { text, trace } = await runPostTranscription(RAW, {
    context: { targetApp: "Code.exe", voiceAgentRequested: false, translationRequested: false },
    glossary: GLOSSARY,
    stt: { provider: "groq", model: "whisper-large-v3", ms: 812 },
    detectWakeWord: () => false,
    run: async ({ workingText, recordStep, setRoute }) => {
      setRoute("cleanup");
      return recordStep("cleanup", {}, async (dispatched) => {
        dispatched({ provider: "copilot", model: "claude-haiku-5.5" });
        return `${workingText} (cleaned)`;
      });
    },
    finalize: async (value) => value,
    now,
  });

  assert.equal(text, `${CORRECTED} (cleaned)`);
  assert.equal(trace.version, POST_TRANSCRIPTION_TRACE_VERSION);
  assert.equal(trace.rawText, RAW);
  assert.equal(trace.workingText, CORRECTED);
  assert.equal(trace.finalText, text);
  assert.deepEqual(trace.context, {
    targetApp: "Code.exe",
    intents: { voiceAgent: false, translation: false, wakeWord: false },
  });
  assert.equal(trace.route, "cleanup");
  assert.deepEqual(trace.glossary, {
    revision: 7,
    rulesFired: [
      {
        ruleId: "rule-little-buddy",
        spelling: "everybody",
        scope: "start",
        from: "everybody",
        to: "Little Buddy",
        index: 7,
      },
    ],
  });
  assert.deepEqual(
    trace.steps.map(({ kind, outcome, provider, model }) => ({ kind, outcome, provider, model })),
    [
      { kind: "stt", outcome: "ok", provider: "groq", model: "whisper-large-v3" },
      { kind: "glossary", outcome: "ok", provider: null, model: null },
      { kind: "cleanup", outcome: "ok", provider: "copilot", model: "claude-haiku-5.5" },
      { kind: "finalize", outcome: "ok", provider: null, model: null },
    ]
  );
  assert.equal(trace.steps[0].ms, 812);
  assert.equal(trace.steps[0].output, RAW);
  assert.equal(trace.steps[1].output, CORRECTED);
  for (const step of trace.steps) assert.equal(typeof step.ms, "number");
});

test("routing reads the raw transcript and the model reads the corrected one", async () => {
  const seen = {};
  await runPostTranscription(RAW, {
    context: { targetApp: "Code.exe" },
    glossary: GLOSSARY,
    detectWakeWord: (text) => {
      seen.wakeWord = text;
      return text.includes("Little Buddy");
    },
    run: async ({ rawText, workingText }) => {
      seen.route = rawText;
      seen.model = workingText;
      return workingText;
    },
  }).then(({ trace }) => {
    assert.equal(trace.context.intents.wakeWord, false, "the raw text never named the agent");
  });
  assert.equal(seen.wakeWord, RAW);
  assert.equal(seen.route, RAW);
  assert.equal(seen.model, CORRECTED);
});

test("a translation recording ignores the wake word, as routing does", async () => {
  let asked = false;
  const { trace } = await runPostTranscription(RAW, {
    context: { translationRequested: true },
    detectWakeWord: () => {
      asked = true;
      return true;
    },
  });
  assert.equal(asked, false);
  assert.deepEqual(trace.context.intents, {
    voiceAgent: false,
    translation: true,
    wakeWord: false,
  });
});

test("a failed model call keeps the corrected text, never the raw one", async () => {
  const { text, trace } = await runPostTranscription(RAW, {
    context: { targetApp: "Code.exe" },
    glossary: GLOSSARY,
    run: async ({ workingText, recordStep }) => {
      try {
        await recordStep("cleanup", { provider: "groq" }, async () => {
          throw Object.assign(new Error("boom: secret dictated text"), { code: "PROVIDER_DOWN" });
        });
      } catch {
        return workingText;
      }
      return "unreachable";
    },
  });
  assert.equal(text, CORRECTED);
  const cleanup = trace.steps.find((step) => step.kind === "cleanup");
  assert.equal(cleanup.outcome, "failed");
  assert.equal(cleanup.errorCode, "PROVIDER_DOWN");
  assert.equal(cleanup.output, null);
});

test("a blank model reply is recorded as a fallback", async () => {
  const { text, trace } = await runPostTranscription("So littlebuddy, check this.", {
    glossary: GLOSSARY,
    run: async ({ workingText, recordStep }) => {
      const reply = await recordStep("cleanup", {}, async () => "   ");
      return reply.trim() ? reply : workingText;
    },
  });
  assert.equal(text, "So Little Buddy, check this.");
  assert.equal(trace.steps.find((step) => step.kind === "cleanup").outcome, "fallback");
});

test("no glossary rules: the glossary step is skipped and the text is untouched", async () => {
  const { text, trace } = await runPostTranscription(RAW, {
    context: { targetApp: "Code.exe" },
    glossary: { revision: 0, rules: [] },
  });
  assert.equal(text, RAW);
  assert.equal(trace.workingText, RAW);
  assert.deepEqual(
    trace.steps.map((step) => [step.kind, step.outcome]),
    [
      ["stt", "ok"],
      ["glossary", "skipped"],
    ]
  );
});

test("a cancelled dictation skips finalization", async () => {
  let finalized = false;
  const { text, trace } = await runPostTranscription(RAW, {
    context: { targetApp: "Code.exe" },
    glossary: GLOSSARY,
    wasCancelled: () => true,
    finalize: async (value) => {
      finalized = true;
      return value;
    },
  });
  assert.equal(finalized, false);
  assert.equal(text, CORRECTED);
  assert.equal(trace.finalText, CORRECTED);
});

test("finalization runs last, and a failed one keeps the text", async () => {
  const order = [];
  const { text } = await runPostTranscription("So littlebuddy, check this.", {
    glossary: GLOSSARY,
    run: async ({ workingText }) => {
      order.push(["run", workingText]);
      return `${workingText}!`;
    },
    finalize: async (value) => {
      order.push(["finalize", value]);
      return value.toUpperCase();
    },
  });
  assert.deepEqual(order, [
    ["run", "So Little Buddy, check this."],
    ["finalize", "So Little Buddy, check this.!"],
  ]);
  assert.equal(text, "SO LITTLE BUDDY, CHECK THIS.!");

  const failed = await runPostTranscription("So littlebuddy, check this.", {
    glossary: GLOSSARY,
    finalize: async () => {
      throw new Error("opencc missing");
    },
  });
  assert.equal(failed.text, "So Little Buddy, check this.");
  assert.equal(failed.trace.steps.at(-1).outcome, "failed");
});

test("a run error (a fatal selection edit) propagates to the caller", async () => {
  const fatal = Object.assign(new Error("fatal"), { selectionEditFatal: true });
  await assert.rejects(
    runPostTranscription(RAW, {
      run: async () => {
        throw fatal;
      },
    }),
    (error) => error === fatal
  );
});

test("the log summary carries ids and counts, never dictated text", async () => {
  const { trace } = await runPostTranscription(RAW, {
    context: { targetApp: "Code.exe" },
    glossary: GLOSSARY,
  });
  const summary = summarizeGlossaryTrace(trace);
  assert.deepEqual(summary, {
    revision: 7,
    fired: 1,
    ruleIds: ["rule-little-buddy"],
    scopes: ["start"],
    targetAppKnown: true,
  });
  const serialized = JSON.stringify(summary);
  for (const fragment of ["everybody", "Little Buddy", "build", "Code.exe"]) {
    assert.ok(!serialized.includes(fragment), `summary leaked "${fragment}"`);
  }
});
