const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Dictated text reaches a log only through logText (utils/logText.js), which
// keeps it out unless "Include dictated text" is on. A `*Preview:` field in a
// logging call is how text used to slip in (a cut of the transcript, the
// cleaned reply, the edited field), so any such field must be a logText(...).

const ROOT = path.join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "locales"]);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(absolute);
    return /\.(jsx?|tsx?)$/.test(entry.name) ? [absolute] : [];
  });
}

const LOG_CALL =
  /\b(?:debugLogger|logger|log)\.(?:trace|debug|info|warn|error|fatal|log|logReasoning|logSTTPipeline|logWhisperPipeline|logEntry)\s*\(/g;

/** Each logging call's argument text, parentheses (and strings) balanced. */
function loggingCalls(text) {
  const calls = [];
  for (const match of text.matchAll(LOG_CALL)) {
    let index = match.index + match[0].length;
    const start = index;
    let depth = 1;
    let quote = null;
    while (index < text.length && depth > 0) {
      const char = text[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      index += 1;
    }
    calls.push({ at: match.index, args: text.slice(start, index - 1) });
  }
  return calls;
}

test("no *Preview field is logged except through logText", () => {
  const files = [...sourceFiles(path.join(ROOT, "src")), path.join(ROOT, "main.js")];
  const offenders = [];
  let checked = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const { at, args } of loggingCalls(text)) {
      checked += 1;
      for (const field of args.matchAll(/\b(\w*Preview)\s*:\s*/g)) {
        const value = args.slice(field.index + field[0].length);
        if (value.startsWith("logText(")) continue;
        const line = text.slice(0, at).split("\n").length;
        offenders.push(`${path.relative(ROOT, file)}:${line} ${field[1]}`);
      }
    }
  }
  assert.ok(checked > 1000, `scanned the logging calls (${checked})`);
  assert.deepEqual(offenders, [], "log logText(value) instead");
});

test("the scan finds a Preview field written the old way", () => {
  const sample = [
    'logger.logReasoning("REASONING_SUCCESS", {',
    "  resultPreview: result.substring(0, 100),",
    "  textPreview: logText(text),",
    "});",
  ].join("\n");
  const [call] = loggingCalls(sample);
  const fields = [...call.args.matchAll(/\b(\w*Preview)\s*:\s*/g)].map((field) => ({
    name: field[1],
    viaLogText: call.args.slice(field.index + field[0].length).startsWith("logText("),
  }));
  assert.deepEqual(fields, [
    { name: "resultPreview", viaLogText: false },
    { name: "textPreview", viaLogText: true },
  ]);
});
