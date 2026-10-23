const test = require("node:test");
const assert = require("node:assert/strict");

// The styled dictation chain: two steps (cleanup, then the restyle) or one
// step. The last good text always survives, and a change to line breaks
// alone is a change. Pure: the model calls are injected.

const load = () => import("../../src/helpers/styleChain.js");

const CLEANED =
  "Hey team, quick update: the deployment went out to ring one. We should be ready for ring two on Thursday.";
const STYLED =
  "Hey team 👋\n- The deployment went out to ring one.\n- We should be ready for ring two on Thursday.";

function makeOpts(overrides = {}) {
  const calls = [];
  const errors = { cleanup: [], style: [] };
  return {
    calls,
    errors,
    opts: {
      text: "raw transcript",
      runMode: "two-step",
      cleanupReachable: true,
      runCleanup: async (text) => {
        calls.push(["cleanup", text]);
        return CLEANED;
      },
      runRestyle: async (text) => {
        calls.push(["restyle", text]);
        return STYLED;
      },
      runOneStep: async (text) => {
        calls.push(["one-step", text]);
        return STYLED;
      },
      onCleanupError: (error) => errors.cleanup.push(error),
      onStyleError: (error) => errors.style.push(error),
      ...overrides,
    },
  };
}

test("two steps: cleanup first, then the restyle gets the cleaned text", async () => {
  const { executeStyleChain } = await load();
  const { opts, calls, errors } = makeOpts();
  const result = await executeStyleChain(opts);
  assert.deepEqual(calls, [
    ["cleanup", "raw transcript"],
    ["restyle", CLEANED],
  ]);
  assert.deepEqual(result, {
    text: STYLED,
    applied: true,
    cleaned: true,
    mode: "two-step",
    changed: true,
  });
  assert.deepEqual(errors, { cleanup: [], style: [] });
});

test("step two throwing keeps the cleaned text and reports the failure", async () => {
  const { executeStyleChain } = await load();
  const failure = Object.assign(new Error("timed out"), { code: "PROVIDER_TIMEOUT" });
  const { opts, errors } = makeOpts({
    runRestyle: async () => {
      throw failure;
    },
  });
  const result = await executeStyleChain(opts);
  assert.equal(result.text, CLEANED, "the last good text, not the raw transcript");
  assert.equal(result.applied, false);
  assert.equal(result.cleaned, true);
  assert.deepEqual(errors.style, [failure]);
});

test("an empty or blank restyle keeps the cleaned text too", async () => {
  const { executeStyleChain } = await load();
  for (const reply of ["", "   \n ", null, undefined]) {
    const { opts, errors } = makeOpts({ runRestyle: async () => reply });
    const result = await executeStyleChain(opts);
    assert.equal(result.text, CLEANED);
    assert.equal(result.applied, false);
    assert.deepEqual(errors.style, [null]);
  }
});

test("a change to line breaks alone is a change, unlike translation's check", async () => {
  const { executeStyleChain } = await load();
  const cleaned = "First point. Second point.";
  const relined = "First point.\nSecond point.";
  const { opts, errors } = makeOpts({
    runCleanup: async () => cleaned,
    runRestyle: async () => relined,
  });
  const result = await executeStyleChain(opts);
  assert.equal(result.text, relined);
  assert.equal(result.applied, true);
  assert.equal(result.changed, true);
  assert.deepEqual(errors.style, []);

  // An identical reply is still the style's result, just unchanged.
  const same = await executeStyleChain(makeOpts({ runRestyle: async () => CLEANED }).opts);
  assert.equal(same.text, CLEANED);
  assert.equal(same.applied, true);
  assert.equal(same.changed, false);
});

test("cleanup failing restyles the transcript it was given", async () => {
  const { executeStyleChain } = await load();
  const failure = new Error("cleanup down");
  const { opts, calls, errors } = makeOpts({
    runCleanup: async (text) => {
      calls.push(["cleanup", text]);
      throw failure;
    },
  });
  const result = await executeStyleChain(opts);
  assert.deepEqual(calls, [
    ["cleanup", "raw transcript"],
    ["restyle", "raw transcript"],
  ]);
  assert.equal(result.text, STYLED);
  assert.equal(result.cleaned, false);
  assert.deepEqual(errors.cleanup, [failure]);
});

test("with cleanup off, both run modes restyle the transcript in one request", async () => {
  const { executeStyleChain } = await load();
  for (const runMode of ["two-step", "one-step"]) {
    const { opts, calls } = makeOpts({ cleanupReachable: false, runMode });
    const result = await executeStyleChain(opts);
    assert.deepEqual(calls, [["restyle", "raw transcript"]], runMode);
    assert.equal(result.mode, "two-step");
    assert.equal(result.cleaned, false);
  }
});

test("one step sends one request with the transcript", async () => {
  const { executeStyleChain } = await load();
  const { opts, calls } = makeOpts({ runMode: "one-step" });
  const result = await executeStyleChain(opts);
  assert.deepEqual(calls, [["one-step", "raw transcript"]]);
  assert.equal(result.text, STYLED);
  assert.equal(result.mode, "one-step");
  assert.equal(result.applied, true);
});

test("one step failing falls back to a plain cleanup, so the cleaned text is pasted", async () => {
  const { executeStyleChain } = await load();
  const failure = Object.assign(new Error("cut off"), { code: "STYLE_OUTPUT_TRUNCATED" });
  const { opts, calls, errors } = makeOpts({
    runMode: "one-step",
    runOneStep: async (text) => {
      calls.push(["one-step", text]);
      throw failure;
    },
  });
  const result = await executeStyleChain(opts);
  assert.deepEqual(calls, [
    ["one-step", "raw transcript"],
    ["cleanup", "raw transcript"],
  ]);
  assert.equal(result.text, CLEANED);
  assert.equal(result.applied, false);
  assert.deepEqual(errors.style, [failure]);

  // And if cleanup fails too, the transcript stands.
  const both = makeOpts({
    runMode: "one-step",
    runOneStep: async () => "",
    runCleanup: async () => {
      throw new Error("down");
    },
  });
  const fallback = await executeStyleChain(both.opts);
  assert.equal(fallback.text, "raw transcript");
  assert.equal(both.errors.cleanup.length, 1);
});

test("a cancelled dictation makes no further calls", async () => {
  const { executeStyleChain } = await load();
  let cancelled = false;
  const { opts, calls } = makeOpts({
    runCleanup: async (text) => {
      calls.push(["cleanup", text]);
      cancelled = true;
      return CLEANED;
    },
    wasCancelled: () => cancelled,
  });
  const result = await executeStyleChain(opts);
  assert.deepEqual(calls, [["cleanup", "raw transcript"]]);
  assert.equal(result.text, CLEANED);
});

test("strict (test runs): a failed style or cleanup rejects instead of falling back", async () => {
  const { executeStyleChain } = await load();
  await assert.rejects(
    executeStyleChain(makeOpts({ strict: true, runRestyle: async () => "" }).opts),
    { code: "STYLE_EMPTY_REPLY" }
  );
  await assert.rejects(
    executeStyleChain(
      makeOpts({
        strict: true,
        runCleanup: async () => {
          throw Object.assign(new Error("auth"), { code: "PROVIDER_AUTH_FAILED" });
        },
      }).opts
    ),
    { code: "PROVIDER_AUTH_FAILED" }
  );
  const oneStep = makeOpts({
    strict: true,
    runMode: "one-step",
    runOneStep: async () => {
      throw Object.assign(new Error("cut"), { code: "STYLE_OUTPUT_TRUNCATED" });
    },
  });
  await assert.rejects(executeStyleChain(oneStep.opts), { code: "STYLE_OUTPUT_TRUNCATED" });
  assert.deepEqual(oneStep.calls, [], "no cleanup fallback in a test run");
});
