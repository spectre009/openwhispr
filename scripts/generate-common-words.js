#!/usr/bin/env node
// Regenerates src/config/commonEnglishWords.json, the bundled common-word list Tidy up's
// "Ordinary words" check reads (CLAUDE.md 13h), from SCOWL's word lists.
//
// Source: SCOWL 2020.12.07 (Kevin Atkinson, http://wordlist.aspell.net/), the release tarball
// https://downloads.sourceforge.net/project/wordlist/SCOWL/2020.12.07/scowl-2020.12.07.tar.gz
// Download and extract it anywhere, then point this script at its `final/` folder:
//
//   node scripts/generate-common-words.js <path-to>/scowl-2020.12.07/final
//
// It reads the "words" lists at sizes 10 and 20 for en_US and en_GB (english-words.*,
// american-words.*, british-words.*; no variants, proper names, abbreviations or contractions),
// lowercases them, keeps letters only (a possessive or anything with an apostrophe is dropped),
// drops one-letter words, dedupes and sorts. The licence travels beside the list in
// src/config/commonEnglishWords.LICENSE.txt; keep both in step when the sizes or release change.

const fs = require("fs");
const path = require("path");

const SIZES = [10, 20];
const LISTS = ["english-words", "american-words", "british-words"];
const OUT_FILE = path.join(__dirname, "..", "src", "config", "commonEnglishWords.json");
const LINE_WIDTH = 100;

function readList(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${name} in ${dir}: point this script at SCOWL's final/ folder`);
  }
  // SCOWL's lists are ISO-8859-1.
  return fs.readFileSync(file, "latin1").split(/\r?\n/);
}

function commonWords(dir) {
  const words = new Set();
  for (const list of LISTS) {
    for (const size of SIZES) {
      for (const line of readList(dir, `${list}.${size}`)) {
        const word = line.trim().normalize("NFC").toLowerCase();
        if (word.length < 2 || !/^\p{L}+$/u.test(word)) continue;
        words.add(word);
      }
    }
  }
  return [...words].sort();
}

// A JSON array wrapped at LINE_WIDTH so a regenerated list diffs by line, not as one blob.
function formatArray(words) {
  const lines = [];
  let line = "";
  for (const word of words) {
    const item = `${JSON.stringify(word)},`;
    if (line && line.length + item.length > LINE_WIDTH) {
      lines.push(line);
      line = "";
    }
    line += item;
  }
  if (line) lines.push(line.replace(/,$/, ""));
  return `[\n${lines.join("\n")}\n]\n`;
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node scripts/generate-common-words.js <scowl>/final");
    process.exit(1);
  }
  const words = commonWords(path.resolve(dir));
  const text = formatArray(words);
  fs.writeFileSync(OUT_FILE, text);
  console.log(
    `Wrote ${words.length} words (${Buffer.byteLength(text)} bytes) to ${path.relative(
      process.cwd(),
      OUT_FILE
    )}`
  );
}

if (require.main === module) main();

module.exports = { commonWords, formatArray };
