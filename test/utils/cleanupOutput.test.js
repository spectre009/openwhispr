const test = require("node:test");
const assert = require("node:assert/strict");

const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";
const LONG_RAW =
  "the team wants to ship the release next week but the team also wants the tests to pass first so the release might slip to the week after";
const LONG_CLEAN =
  "The team wants to ship the release next week, but the team also wants the tests to pass first, so the release might slip to the week after.";

// #2225: these synthetic cases cover duplication. CUS-227's original raw/final
// pair and configuration are still missing, so example substitution is unverified.
test("cleanup rejects whole-output duplication without requiring a match to raw speech", async () => {
  const { assertValidCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const output of [
    `${CLEAN} ${CLEAN}`,
    `Cleaned transcript:\n${CLEAN}\n\n${CLEAN}`,
    `**Cleaned transcript:**\n${CLEAN}\n**Cleaned transcript:**\n${CLEAN}`,
    `**Cleaned transcript**:\n${CLEAN}\n${CLEAN}`,
    `Can you send me\nCleaned transcript:\nthe report by Friday? ${CLEAN}`,
    `${CLEAN}\n${CLEAN}\nCleaned transcript:`,
    "CAN YOU SEND ME THE REPORT BY FRIDAY!\ncan you send me the report by Friday?",
    "Ｃａｎ you send me the report by Friday?\nCan you send me the report by Friday?",
    "Please send the updated report tomorrow. Please send the updated report tomorrow.",
    "请你明天把修改后的报告发送给项目负责人。请你明天把修改后的报告发送给项目负责人。",
    "Envoyez le rapport complet à Marie demain. Envoyez le rapport complet à Marie demain.",
  ]) {
    assert.throws(
      () => assertValidCleanupOutput(RAW, output),
      {
        code: "CLEANUP_OUTPUT_INVALID",
        messageKey: "hooks.audioRecording.errorDescriptions.cleanupDuplicated",
      },
      output
    );
  }
  // Filler-heavy speech can be as long as its cleanup said twice, and longer or
  // stuttered speech repeats words without being said twice.
  for (const [raw, output] of [
    ["um so uh basically can you uh like send me the report by friday um yeah", CLEAN],
    [LONG_RAW, LONG_CLEAN],
    [
      "I I I think we we should uh we should move the the meeting to to friday because because the the client is is out on on thursday",
      "I think we should move the meeting to Friday because the client is out on Thursday.",
    ],
  ]) {
    assert.throws(() => assertValidCleanupOutput(raw, `${output} ${output}`), {
      code: "CLEANUP_OUTPUT_INVALID",
    });
  }
});

test("cleanup leaves legitimate, ambiguous, and out-of-scope output alone", async () => {
  const { assertValidCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const [raw, output] of [
    [RAW, CLEAN],
    [RAW, "Please send the report tomorrow. Please send the report tomorrow."],
    [RAW, "I'm sorry, I can't. I'm sorry, I can't."],
    [RAW, `${CLEAN} Can you send me the report by Monday?`],
    [RAW, `Introduction. ${CLEAN} ${CLEAN}`],
    [RAW, `${CLEAN} ${CLEAN} Additional details.`],
    [RAW, `**Cleaned transcript:**\n${CLEAN}`],
    [RAW, `**${CLEAN}**`],
    [RAW, "What's the capital of France?"],
    [RAW, ""],
    [RAW, "  \n "],
    [`${CLEAN} ${CLEAN}`, `${CLEAN.toUpperCase()}\n${CLEAN}`],
    ["Send it Thursday no wait Friday", "Send it Friday."],
    ["déjà vu élève", "Déjà vu, élève."],
    [
      "um please send the report by friday please send the report by friday",
      "Please send the report by Friday. Please send the report by Friday.",
    ],
    [
      "im gonna send the report to marie tomorrow im gonna send the report to marie tomorrow",
      "I'm going to send the report to Marie tomorrow. I'm going to send the report to Marie tomorrow.",
    ],
    [`${LONG_RAW} ${LONG_RAW}`, `${LONG_CLEAN} ${LONG_CLEAN}`],
    [
      "were gonna ship it on friday for sure um were gonna ship it on friday for sure",
      "We're going to ship it on Friday for sure. We're going to ship it on Friday for sure.",
    ],
  ]) {
    assert.doesNotThrow(() => assertValidCleanupOutput(raw, output), output);
  }
});

// A reply that hands back the transcript, then a "Cleaned:"-style label, then
// the cleaned text (seen once with Claude Haiku 5.5 on a verbatim transcript).
const VERBATIM =
  "Nice one. Now, so we have this new session ID that's been sent, well, rather recorded in the logs. I want to pull that out as a column, since this is an interesting field that would allow us to count the sessions.";
const CLEANED =
  "Nice one. Now, we have this new session ID that's been recorded in the logs. I want to pull that out as a column, since it would allow us to count the sessions.";

test("a labelled copy of the transcript keeps only the cleaned text", async () => {
  const { finishCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const output of [
    `${VERBATIM}\n\nCleaned:\n\n${CLEANED}`,
    `${VERBATIM}\n\n**Cleaned:**\n${CLEANED}`,
    `${VERBATIM}\n\n**Cleaned version**:\n${CLEANED}`,
    `${VERBATIM}\n\n## Cleaned transcript:\n\n${CLEANED}`,
    `Original:\n${VERBATIM}\n\nCleaned:\n${CLEANED}`,
    `**Original transcript:**\n${VERBATIM}\n\n**Cleaned transcript:**\n${CLEANED}`,
    `${VERBATIM}\n\nHere's the cleaned version:\n${CLEANED}`,
    `${VERBATIM}\nCleaned: ${CLEANED}`,
    `${VERBATIM.replace("well, rather", "or rather")}\n\nCleaned:\n${CLEANED}`,
  ]) {
    assert.equal(finishCleanupOutput(VERBATIM, output), CLEANED, output);
  }
});

test("a labelled copy with nothing after the label is rejected", async () => {
  const { finishCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const output of [`${VERBATIM}\n\nCleaned:`, `${VERBATIM}\n\n**Cleaned:**\n\n  `]) {
    assert.throws(() => finishCleanupOutput(VERBATIM, output), {
      code: "CLEANUP_OUTPUT_INVALID",
      messageKey: "hooks.audioRecording.errorDescriptions.cleanupDuplicated",
    });
  }
  // The cleaned part is still checked: a repeated cleaned text is rejected.
  assert.throws(
    () => finishCleanupOutput(VERBATIM, `${VERBATIM}\n\nCleaned:\n${CLEANED} ${CLEANED}`),
    {
      code: "CLEANUP_OUTPUT_INVALID",
    }
  );
});

test("a label without a copy of the transcript above it is left alone", async () => {
  const { finishCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const [raw, output] of [
    [VERBATIM, CLEANED],
    [RAW, `**Cleaned transcript:**\n${CLEAN}`],
    [RAW, `Cleaned:\n${CLEAN}`],
    [
      "first draft the intro then final the summary",
      "First, draft the intro.\nFinal: the summary.",
    ],
    [
      "write the plan then cleaned up version of the plan goes to the team",
      "Write the plan.\nCleaned-up version: the plan goes to the team.",
    ],
    [VERBATIM, `A different paragraph about something else entirely.\n\nCleaned:\n${CLEANED}`],
  ]) {
    assert.equal(finishCleanupOutput(raw, output), output, output);
  }
  // Duplication is still rejected when there's no label.
  assert.throws(() => finishCleanupOutput(RAW, `${CLEAN} ${CLEAN}`), {
    code: "CLEANUP_OUTPUT_INVALID",
  });
});
