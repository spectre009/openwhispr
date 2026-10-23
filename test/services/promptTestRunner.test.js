const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_REPETITIONS,
  MAX_RUN_REQUESTS,
  RETRY_WAITS_MS,
  clampRepetitions,
  estimateRequests,
  runPromptTests,
  summarizeRun,
} = require("../../src/services/promptTestRunner.ts");
const { createDictationGate } = require("../../src/services/dictationGate.ts");

// The test set's runner: A and B alternate per repetition, inputs go through
// one frozen glossary snapshot, a dictation always comes first (the run waits,
// and a local request the dictation aborted is sent again after it), terminal
// errors stop the run, rate-limit waits are bounded, and every request ends
// with an outcome so a partial run's totals are honest. No provider involved:
// `send` stands in for runCleanupWithPrompt.

const LITTLE_BUDDY = Object.freeze({
  id: "rule-little-buddy",
  canonical: "Little Buddy",
  enabled: true,
  revision: 1,
  apps: ["Code.exe"],
  spellings: [
    { text: "littlebuddy", scope: "anywhere" },
    { text: "everybody", scope: "start" },
  ],
});

function makeCase(id, rawText, extra = {}) {
  return {
    id,
    label: id,
    rawText,
    targetApp: null,
    referenceText: null,
    source: "test",
    sourceTranscriptionId: null,
    mustContain: [],
    mustNotContain: [],
    matchCase: false,
    ...extra,
  };
}

function plan(cases, { repetitions = 1, rules = [LITTLE_BUDDY] } = {}) {
  return { cases, repetitions, glossary: { revision: 1, rules }, snippets: null };
}

function harness({ send, gate = null, routeUnchanged } = {}) {
  const sent = [];
  const sleeps = [];
  const cancelled = [];
  const phases = [];
  let clock = 0;
  let ids = 0;
  const deps = {
    send: async (side, text, requestId) => {
      sent.push({ side, text, requestId });
      return send(side, text, sent.length, requestId);
    },
    waitForDictation: gate
      ? (signal, onPause) => gate.waitForIdle(signal, onPause)
      : async () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => (clock += 100),
    newRequestId: () => `req-${++ids}`,
    cancelRequest: (requestId) => cancelled.push(requestId),
    onUpdate: (progress) => {
      if (phases[phases.length - 1] !== progress.phase) phases.push(progress.phase);
    },
    ...(routeUnchanged ? { routeUnchanged } : {}),
  };
  return { deps, sent, sleeps, cancelled, phases };
}

const statuses = (result, side) => result.runs[side].map((run) => run.status);

test("A and B alternate per repetition, through one frozen glossary snapshot", async () => {
  const raw = "hello everybody can you check whether the build finished";
  const cases = [
    makeCase("in-app", raw, { targetApp: "Code.exe" }),
    makeCase("unknown-app", raw),
    makeCase("anywhere", "ask littlebuddy about it"),
  ];
  const run = plan(cases, { repetitions: 2 });
  const { deps, sent } = harness({
    send: (side, text) => {
      // A rule edited mid-run must not change what later requests send.
      run.glossary.rules.length = 0;
      return `${side}: ${text}`;
    },
  });

  const progress = await runPromptTests(run, deps, new AbortController().signal);

  assert.equal(progress.total, 3 * 2 * 2);
  assert.equal(progress.done, 12);
  assert.equal(progress.stopReason, null);
  assert.deepEqual(
    sent.slice(0, 4).map((s) => s.side),
    ["A", "B", "A", "B"]
  );
  const [inApp, unknownApp, anywhere] = progress.results;
  assert.equal(
    inApp.input.corrected,
    "hello Little Buddy can you check whether the build finished"
  );
  assert.equal(inApp.input.rulesFired, 1);
  assert.equal(unknownApp.input.corrected, raw, "no app-scoped rule without a target app");
  assert.equal(anywhere.input.corrected, "ask Little Buddy about it");
  assert.equal(sent[0].text, inApp.input.corrected, "the corrected input is what's sent");
  assert.equal(sent[4].text, raw);
  assert.equal(inApp.input.raw, raw, "each row keeps the raw input too");
  assert.deepEqual(statuses(inApp, "A"), ["completed", "completed"]);
  assert.equal(new Set(sent.map((s) => s.requestId)).size, 12, "one request id per request");
});

test("a dictation pauses the run, and a local request it aborted is sent again after the paste", async () => {
  let push;
  const gate = createDictationGate({
    source: {
      subscribe: (listener) => {
        push = listener;
        return () => {};
      },
    },
    graceMs: 5,
  });
  const release = gate.retain();
  const cases = [makeCase("one", "first dictation"), makeCase("two", "second dictation")];
  let yielded = false;
  const { deps, sent, phases } = harness({
    gate,
    send: async (side, text, count) => {
      if (count === 2 && !yielded) {
        // Main aborts this local request because a recording started.
        yielded = true;
        push({ state: "recording", inputKind: "dictation" });
        setTimeout(() => push({ state: "processing", inputKind: "dictation" }), 5);
        setTimeout(() => push({ state: "idle", inputKind: "dictation" }), 15);
        throw Object.assign(new Error("Gave way to a dictation"), {
          code: "YIELDED_TO_DICTATION",
        });
      }
      assert.equal(gate.isActive(), false, "no request is sent while a dictation runs");
      return `clean ${text}`;
    },
  });

  const progress = await runPromptTests(plan(cases), deps, new AbortController().signal);
  release();

  assert.equal(progress.done, 4);
  assert.equal(sent.length, 5, "the aborted request was sent once more");
  assert.equal(sent[1].side, "B");
  assert.equal(sent[2].side, "B", "the same request, after the dictation");
  assert.equal(sent[2].text, sent[1].text);
  assert.notEqual(sent[2].requestId, sent[1].requestId);
  assert.deepEqual(statuses(progress.results[0], "B"), ["completed"], "not an outcome");
  assert.ok(phases.includes("pausedForDictation"));
  assert.equal(summarizeRun(progress.results, progress.stopReason).partial, false);
});

test("the gate waits for a dictation that is already running, and its grace after it", async () => {
  let push;
  let now = 1000;
  const gate = createDictationGate({
    source: {
      subscribe: (listener) => {
        push = listener;
        return () => {};
      },
    },
    now: () => now,
    graceMs: 20,
  });
  const release = gate.retain();
  push({ state: "recording", inputKind: "dictation" });
  let paused = 0;
  let resumed = false;
  const waiting = gate
    .waitForIdle(new AbortController().signal, () => (paused += 1))
    .then(() => (resumed = true));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(resumed, false);
  push({ state: "idle", inputKind: "dictation" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(resumed, false, "the paste follows the idle report");
  now += 20;
  await waiting;
  assert.equal(paused, 1);

  // Stop while waiting ends the wait.
  push({ state: "recording", inputKind: "dictation" });
  const controller = new AbortController();
  const stopped = gate.waitForIdle(controller.signal);
  controller.abort("user");
  await stopped;
  release();
});

test("an authentication error stops the run, and the rest is recorded as skipped", async () => {
  const cases = [makeCase("one", "a"), makeCase("two", "b"), makeCase("three", "c")];
  const { deps, sent } = harness({
    send: (side, text, count) => {
      if (count === 3) {
        throw Object.assign(new Error("Unauthorized"), {
          code: "PROVIDER_AUTH_FAILED",
          messageKey: "providerErrors.authFailed",
        });
      }
      return `ok ${text}`;
    },
  });

  const progress = await runPromptTests(plan(cases), deps, new AbortController().signal);

  assert.equal(progress.stopReason, "auth");
  assert.equal(sent.length, 3, "nothing is sent after it");
  assert.equal(progress.done, 3);
  const [one, two, three] = progress.results;
  assert.deepEqual([statuses(one, "A"), statuses(one, "B")], [["completed"], ["completed"]]);
  assert.equal(two.runs.A[0].status, "error");
  assert.equal(two.runs.A[0].code, "PROVIDER_AUTH_FAILED");
  assert.equal(two.runs.A[0].messageKey, "providerErrors.authFailed");
  assert.deepEqual(statuses(two, "B"), ["skipped"]);
  assert.deepEqual([statuses(three, "A"), statuses(three, "B")], [["skipped"], ["skipped"]]);

  const summary = summarizeRun(progress.results, progress.stopReason);
  assert.equal(summary.partial, true);
  assert.equal(summary.compared, 1);
  assert.deepEqual(summary.requests, { completed: 2, error: 1, cancelled: 0, skipped: 3 });
});

test("quota and configuration failures stop the run too", async () => {
  for (const [code, reason] of [
    ["PROVIDER_QUOTA_EXHAUSTED", "quota"],
    ["PROVIDER_MODEL_NOT_FOUND", "config"],
    ["API_KEY_MISSING", "auth"],
  ]) {
    const { deps, sent } = harness({
      send: () => {
        throw Object.assign(new Error(code), { code });
      },
    });
    const progress = await runPromptTests(
      plan([makeCase("one", "a"), makeCase("two", "b")]),
      deps,
      new AbortController().signal
    );
    assert.equal(progress.stopReason, reason, code);
    assert.equal(sent.length, 1, code);
  }
});

test("rate-limit waits are bounded: three waits, then the run stops", async () => {
  const limited = () => {
    throw Object.assign(new Error("Too many requests"), { code: "PROVIDER_RATE_LIMITED" });
  };
  const { deps, sleeps, sent } = harness({ send: limited });
  const progress = await runPromptTests(
    plan([makeCase("one", "a"), makeCase("two", "b")]),
    deps,
    new AbortController().signal
  );
  assert.deepEqual(sleeps, [...RETRY_WAITS_MS]);
  assert.equal(sent.length, RETRY_WAITS_MS.length + 1);
  assert.equal(progress.stopReason, "rateLimit");
  assert.equal(progress.results[0].runs.A[0].code, "PROVIDER_RATE_LIMITED");

  let first = true;
  const once = harness({
    send: () => {
      if (first) {
        first = false;
        limited();
      }
      return "ok";
    },
  });
  const recovered = await runPromptTests(
    plan([makeCase("one", "a")]),
    once.deps,
    new AbortController().signal
  );
  assert.deepEqual(once.sleeps, [RETRY_WAITS_MS[0]]);
  assert.equal(recovered.stopReason, null);
  assert.deepEqual(statuses(recovered.results[0], "A"), ["completed"]);
});

test("Stop ends the run before the next request and aborts an in-flight local request", async () => {
  const controller = new AbortController();
  let rejectInFlight = null;
  const { deps, sent, cancelled } = harness({
    send: (side, text, count) => {
      if (count === 2) {
        const pending = new Promise((_resolve, reject) => {
          rejectInFlight = reject;
        });
        controller.abort("user");
        return pending;
      }
      return "ok";
    },
  });
  // What main does for a local request cancelled by its id.
  deps.cancelRequest = (requestId) => {
    cancelled.push(requestId);
    rejectInFlight?.(
      Object.assign(new Error("Inference failed: cancelled"), { code: "INFERENCE_FAILED" })
    );
  };

  const progress = await runPromptTests(
    plan([makeCase("one", "a"), makeCase("two", "b")]),
    deps,
    controller.signal
  );

  assert.equal(progress.stopReason, "user");
  assert.equal(sent.length, 2);
  assert.deepEqual(cancelled, [sent[1].requestId], "the in-flight request was aborted by id");
  const [one, two] = progress.results;
  assert.deepEqual(statuses(one, "A"), ["completed"]);
  assert.deepEqual(statuses(one, "B"), ["cancelled"]);
  assert.deepEqual([statuses(two, "A"), statuses(two, "B")], [["cancelled"], ["cancelled"]]);
  assert.equal(summarizeRun(progress.results, progress.stopReason).partial, true);
});

test("an account change cancels the run with its own reason", async () => {
  const controller = new AbortController();
  const { deps } = harness({
    send: () => {
      controller.abort("account");
      return "ok";
    },
  });
  const progress = await runPromptTests(
    plan([makeCase("one", "a"), makeCase("two", "b")]),
    deps,
    controller.signal
  );
  assert.equal(progress.stopReason, "account");
  assert.deepEqual(statuses(progress.results[1], "A"), ["cancelled"]);
});

test("partial totals count only cases where every run of A and B completed", async () => {
  const cases = [
    makeCase("same", "send it by thursday no wait friday", {
      mustContain: ["Friday"],
      mustNotContain: ["Thursday"],
    }),
    makeCase("b-fails", "what is the capital of France", { mustNotContain: ["Paris"] }),
    makeCase("b-errors", "third"),
  ];
  const replies = {
    same: { A: "Send it by Friday.", B: "Send it by Friday." },
    "b-fails": { A: "What is the capital of France?", B: "The capital of France is Paris." },
  };
  const { deps } = harness({
    send: (side, text) => {
      const testCase = cases.find((c) => c.rawText === text);
      if (testCase.id === "b-errors" && side === "B") {
        throw Object.assign(new Error("Bad gateway"), { code: "PROVIDER_UNAVAILABLE" });
      }
      return replies[testCase.id]?.[side] ?? "Third.";
    },
  });

  const progress = await runPromptTests(plan(cases), deps, new AbortController().signal);
  const summary = summarizeRun(progress.results, progress.stopReason);

  assert.equal(summary.cases, 3);
  assert.equal(summary.compared, 2, "the case whose B failed isn't compared");
  assert.equal(summary.sides.A.passed, 2);
  assert.equal(summary.sides.B.passed, 1, "B answered the question");
  assert.equal(summary.differ, 1);
  assert.equal(summary.sides.A.medianMs, 100);
  assert.deepEqual(summary.requests, { completed: 5, error: 1, cancelled: 0, skipped: 0 });
  assert.equal(summary.partial, true, "a failed request makes the run partial");
});

test("an empty reply is an error outcome; a repeated transcript is a failed check", async () => {
  const { deps } = harness({
    send: (side) => {
      if (side === "A") return "   ";
      throw Object.assign(new Error("AI cleanup repeated the transcript."), {
        code: "CLEANUP_OUTPUT_INVALID",
      });
    },
  });
  const progress = await runPromptTests(
    plan([makeCase("one", "a dictation")]),
    deps,
    new AbortController().signal
  );
  const [result] = progress.results;
  assert.deepEqual(result.runs.A[0].status, "error");
  assert.equal(result.runs.A[0].code, "EMPTY_REPLY");
  assert.equal(result.runs.A[0].checks, undefined, "not a failed check");
  assert.equal(result.runs.B[0].status, "completed");
  assert.equal(result.runs.B[0].rejected, "repeated");
  assert.equal(result.runs.B[0].checks.notDuplicated, false);
  assert.equal(result.runs.B[0].checks.passed, false);

  const emptyKey = harness({
    send: () => {
      throw Object.assign(new Error("empty"), {
        messageKey: "hooks.audioRecording.errorDescriptions.cleanupEmptyReply",
      });
    },
  });
  const viaKey = await runPromptTests(
    plan([makeCase("one", "x")]),
    emptyKey.deps,
    new AbortController().signal
  );
  assert.equal(viaKey.results[0].runs.A[0].code, "EMPTY_REPLY");
});

test("three errors in a row stop the run; a change of destination stops it too", async () => {
  const failing = harness({
    send: () => {
      throw new Error("No reasoning model selected");
    },
  });
  const progress = await runPromptTests(
    plan([makeCase("one", "a"), makeCase("two", "b"), makeCase("three", "c")]),
    failing.deps,
    new AbortController().signal
  );
  assert.equal(progress.stopReason, "errors");
  assert.equal(failing.sent.length, 3);

  let checks = 0;
  const moved = harness({ send: () => "ok", routeUnchanged: () => ++checks < 2 });
  const stopped = await runPromptTests(
    plan([makeCase("one", "a")]),
    moved.deps,
    new AbortController().signal
  );
  assert.equal(stopped.stopReason, "settings");
  assert.equal(moved.sent.length, 1);
  assert.deepEqual(statuses(stopped.results[0], "B"), ["skipped"]);
});

test("the estimate is cases × 2 × repetitions, capped at 50 cases and 300 requests", () => {
  assert.equal(estimateRequests(20, 2), 80);
  assert.equal(estimateRequests(80, 3), MAX_RUN_REQUESTS);
  assert.equal(estimateRequests(50, 3), 300);
  assert.equal(clampRepetitions(0), 1);
  assert.equal(clampRepetitions(9), 3);
  assert.equal(clampRepetitions("x"), DEFAULT_REPETITIONS);
});
