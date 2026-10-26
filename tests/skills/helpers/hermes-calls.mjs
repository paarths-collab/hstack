// Extract every `hermes ...` invocation from the fenced bash blocks of a markdown skill and check it against the
// REAL Hermes v0.22.5 argparse builders vendored in tests/skills/fixtures (syntax only; see native-parser.py).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractBlocks } from "./blocks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "hermes-v0.22.5");
const PARSER = path.join(here, "native-parser.py");

const TERMINATORS = new Set([";", "|", "&", ">", "<", ")", "`"]);

/** Split the text after `hermes` into shell words, stopping at the first unquoted control operator. */
export function tokenizeInvocation(rest, outerQuote) {
  const words = [];
  let cur = "";
  let started = false;
  let q = null;
  const push = () => {
    if (started) words.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (q === '"' && c === "\\" && i + 1 < rest.length) { cur += rest[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < rest.length) {
      if (rest[i + 1] === "\n") { i++; continue; }
      cur += rest[++i]; started = true; continue;
    }
    if (outerQuote && c === outerQuote) break; // closes the string that wraps the whole remote command
    if (c === "'" || c === '"') {
      if (rest.indexOf(c, i + 1) < 0) break; // stray closing quote of a multi-line wrapper string
      q = c; started = true; continue;
    }
    if (c === " " || c === "\t") { push(); continue; }
    if (c === "\n") break;
    if (c === ">" && started && /^[0-9]+$/.test(cur)) { cur = ""; started = false; break; } // `2>/dev/null`
    if (TERMINATORS.has(c)) break;
    if (c === "$" && rest[i + 1] === "{") {
      const j = rest.indexOf("}", i);
      if (j < 0) break;
      const inner = rest.slice(i + 2, j);
      if (inner.includes(":+")) { i = j; continue; } // optional flag, e.g. ${GW_INTERRUPT:+ -y}: not part of the checked form
      cur += "X"; started = true; i = j; continue;
    }
    if (c === "$" && rest[i + 1] === "(") {
      // command substitution: replace the whole $( ... ) by a placeholder
      let depth = 0, j = i + 1;
      for (; j < rest.length; j++) { if (rest[j] === "(") depth++; if (rest[j] === ")" && --depth === 0) break; }
      cur += "X"; started = true; i = j; continue;
    }
    cur += c; started = true;
  }
  push();
  return words;
}

const placeholder = (w) =>
  w.replace(/\$\{[^}]*\}/g, "X").replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "X").replace(/<([A-Za-z][A-Za-z0-9_-]*)>/g, "X").replace(/\\\$/g, "$");

/** [{ line, block, argv, text }] for the whole document. */
export function hermesInvocations(markdown) {
  const out = [];
  for (const b of extractBlocks(markdown)) {
    // join backslash-continued lines (keeps the line numbering of the first physical line)
    const lines = b.code.replace(/\\\n[ \t]*/g, " ").split("\n");
    let heredoc = null; // { end, text }
    lines.forEach((raw, k) => {
      const line = raw;
      if (heredoc) {
        if (line.trim() === heredoc.end) { heredoc = null; return; }
        if (heredoc.text) return;
      } else {
        const h = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
        if (h) {
          const consumer = line.slice(0, h.index).trim();
          heredoc = { end: h[2], text: /^(cat|echo|printf)\b/.test(consumer) || /\|\s*(cat|tee)\b/.test(consumer) };
        }
      }
      const t = line.trim();
      if (!t || t.startsWith("#") || /^echo\b/.test(t) || /hermes-parse: skip/.test(t)) return;
      const re = /(^|[\s;&|("'`])(?:~\/\.local\/bin\/|\$H\/|\$HOME\/\.local\/bin\/|"\$H"\s*)?hermes(?=[\s"']|$)/g;
      let m;
      while ((m = re.exec(line))) {
        const before = line.slice(0, m.index + m[1].length);
        // inside a quoted string printed by echo/printf: prose, not an invocation
        const lastPrint = Math.max(before.lastIndexOf("echo "), before.lastIndexOf("printf "));
        if (lastPrint >= 0 && !/\|\s*(remote|ssh)\b/.test(before.slice(lastPrint))) {
          const seg = before.slice(lastPrint);
          const dq = (seg.match(/(?<!\\)"/g) || []).length, sq = (seg.match(/'/g) || []).length;
          if (dq % 2 === 1 || sq % 2 === 1) continue;
        }
        // a quote right before `hermes` only opens a command string after remote/ssh/bash -c
        if ((m[1] === '"' || m[1] === "'") && !/\b(remote|ssh|bash -c|sh -c|exec \S+|wsl)\b[^|;]*$/.test(before.slice(0, -1))) continue;
        // `command -v hermes`, `grep -q hermes`, `docker ps | grep hermes`: not an invocation
        if (/(command -v|grep(?: -\w+)*|which|type)\s+['"]?$/.test(before)) continue;
        let start = m.index + m[0].length;
        let outer = null;
        { // the quote (if any) that is still open where the invocation starts wraps a whole remote command
          let st = null;
          for (let z = 0; z < before.length; z++) {
            const ch = before[z];
            if (st) { if (ch === "\\" && st === '"') z++; else if (ch === st) st = null; }
            else if (ch === "'" || ch === '"') st = ch;
          }
          outer = st;
        }
        const words = tokenizeInvocation(line.slice(start).replace(/<([A-Za-z][A-Za-z0-9_-]*)>/g, "X"), outer).map(placeholder);
        if (words.length === 0) continue;
        out.push({ block: b.id, line: b.line + k + 1, argv: words, text: t });
      }
    });
  }
  return out;
}

/** Run the invocations through the vendored v0.22.5 parser. Returns [{...inv, code, output}]. */
export function checkAgainstV0225(invocations) {
  if (!invocations.length) return [];
  const r = spawnSync("python3", ["-I", PARSER, FIXTURE, JSON.stringify(invocations.map((i) => i.argv))], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`native parser failed: ${r.stderr || r.stdout}`);
  const rows = JSON.parse(r.stdout);
  return invocations.map((inv, i) => ({ ...inv, code: rows[i].code, output: rows[i].output || "" }));
}

export const readSkill = (file) => readFileSync(file, "utf8");
