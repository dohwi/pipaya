#!/usr/bin/env node
/**
 * Lists every Korean source string passed to `t("…")` / `msg("…")` under src/, and compares it with the English
 * dictionary (src/lib/locales/en.ts).
 *
 *   node scripts/extract-i18n.cjs           report missing / unused entries (exit 1 when anything is missing)
 *   node scripts/extract-i18n.cjs --keys    print the keys as JSON
 */
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const HANGUL = /[가-힣]/;
// t("…") / t('…') / msg("…") with a plain string literal as the first argument (escaped quotes allowed).
const CALL = /\b(?:t|msg)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
// tc("context", "한국어") -> the dictionary key is "한국어\u0004context"
// A context-bearing key that is looked up dynamically (tc("approval", a.label)) is declared where the table is written:
//   msg("확인", "approval")  ->  "확인\u0004approval"
const MSG_CTX = /\bmsg\(\s*("(?:[^"\\\n]|\\.)*")\s*,\s*("(?:[^"\\\n]|\\.)*")\s*\)/g;
const CALL_CTX = /\btc\(\s*("(?:[^"\\\n]|\\.)*")\s*,\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
// An English key never contains Hangul, so a call whose argument is not Korean (t(label), t("ID")) is ignored here.

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walk(full, out);
    else if (/\.(ts|svelte)$/.test(name.name) && !full.includes(`${path.sep}locales${path.sep}`)) out.push(full);
  }
  return out;
}

function literal(raw) {
  const body = raw.slice(1, -1);
  return body.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex, c) => (hex ? String.fromCharCode(parseInt(hex, 16)) : ({ n: "\n", t: "\t" })[c] ?? c));
}

/** Remove comments so examples in docs (`t("…")` inside a comment) are not mistaken for calls. String literals are left alone. */
function stripComments(code) {
  let out = "";
  for (let i = 0; i < code.length; ) {
    const c = code[i], n = code[i + 1];
    if (c === "/" && n === "*") { const e = code.indexOf("*/", i + 2); i = e < 0 ? code.length : e + 2; out += " "; continue; }
    if (c === "<" && code.startsWith("<!--", i)) { const e = code.indexOf("-->", i + 4); i = e < 0 ? code.length : e + 3; out += " "; continue; }
    if (c === "/" && n === "/" && code[i - 1] !== ":") { const e = code.indexOf("\n", i); i = e < 0 ? code.length : e; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) { if (code[j] === "\\") j++; else if (c !== "`" && code[j] === "\n") break; j++; }
      out += code.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

function sourceKeys() {
  const keys = new Map();
  for (const file of walk(SRC)) {
    const text = stripComments(fs.readFileSync(file, "utf8"));
    for (const m of text.matchAll(CALL)) {
      const key = literal(m[1]);
      if (!HANGUL.test(key)) continue;
      if (!keys.has(key)) keys.set(key, path.relative(SRC, file));
    }
    for (const m of text.matchAll(MSG_CTX)) {
      const key = `${literal(m[1])}\u0004${literal(m[2])}`;
      if (!keys.has(key)) keys.set(key, path.relative(SRC, file));
    }
    for (const m of text.matchAll(CALL_CTX)) {
      const key = literal(m[2]);
      if (!HANGUL.test(key)) continue;
      const full = `${key}\u0004${literal(m[1])}`;
      if (!keys.has(full)) keys.set(full, path.relative(SRC, file));
    }
  }
  return keys;
}

function dictionaryKeys() {
  const text = fs.readFileSync(path.join(SRC, "lib", "locales", "en.ts"), "utf8");
  const keys = new Set();
  // entries look like:  "한국어": "English",   (values may contain escaped quotes)
  for (const m of text.matchAll(/^\s*("(?:[^"\\\n]|\\.)*")\s*:\s*"(?:[^"\\\n]|\\.)*"\s*,?\s*$/gm)) keys.add(literal(m[1]));
  return keys;
}

if (require.main === module) {
  const used = sourceKeys();
  if (process.argv.includes("--keys")) {
    console.log(JSON.stringify([...used.keys()], null, 2));
    process.exit(0);
  }
  const have = dictionaryKeys();
  const missing = [...used].filter(([k]) => !have.has(k));
  const unused = [...have].filter((k) => !used.has(k));
  for (const [k, file] of missing) console.log(`missing  ${file}: ${JSON.stringify(k)}`);
  for (const k of unused) console.log(`unused   ${JSON.stringify(k)}`);
  console.log(`${used.size} keys in source, ${have.size} in en.ts, ${missing.length} missing, ${unused.length} unused`);
  process.exit(missing.length ? 1 : 0);
}

module.exports = { sourceKeys, dictionaryKeys };
