// Extract the fenced ```bash blocks of a SKILL.md in document order, name them, and assemble selected
// blocks into one shell script. The skills are written to be run block by block in ONE shell session,
// so the tests run them exactly that way instead of re-implementing what they do.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root. HSTACK_REPO_ROOT lets a mutated COPY of skills/ and templates/ be tested instead. */
export const REPO_ROOT = path.resolve(process.env.HSTACK_REPO_ROOT || path.join(here, "..", "..", ".."));
export const SKILLS_DIR = path.join(REPO_ROOT, "skills");
export const TEMPLATE_PATH = path.join(REPO_ROOT, "templates", "SKILL.template.md");

export const skillPath = (name) => path.join(SKILLS_DIR, name, "SKILL.md");

const FENCE_OPEN = /^(\s*(?:>\s?)*)```([A-Za-z0-9_-]*)\s*$/;
const FENCE_CLOSE = /^\s*(?:>\s?)*```\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

/** A stable section key for a heading: "Step 5 — ..." -> step5, "Path A (...)" under step 6 -> step6.pathA. */
function sectionKey(text, state) {
  let m = /^Step\s+(\d+[a-z]?)\b/i.exec(text);
  if (m) {
    state.step = `step${m[1]}`;
    return state.step;
  }
  m = /^Path\s+([A-Za-z])\b/.exec(text);
  if (m) return `${state.step || "path"}.path${m[1].toUpperCase()}`;
  const head = text.split(/\s+[—–-]\s+|\s*\(/)[0];
  return head.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "top";
}

/**
 * All fenced bash blocks of a markdown document, in order.
 * Each block: { index (1-based among bash blocks), id ("step5#2", "step5#q1" for a block inside a
 * blockquote, i.e. a fallback/alternative), section, quoted, line, code }.
 */
export function extractBlocks(markdown) {
  const lines = markdown.split("\n");
  const out = [];
  const state = { step: "" };
  const counters = new Map();
  let section = "top";
  let open = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (!open) {
      const f = FENCE_OPEN.exec(line);
      if (f) {
        open = { lang: f[2], quoted: f[1].includes(">"), start: i + 1, body: [] };
        return;
      }
      const h = HEADING.exec(line);
      if (h) section = sectionKey(h[2], state);
      return;
    }
    if (FENCE_CLOSE.test(line)) {
      if (open.lang === "bash") {
        const kind = open.quoted ? "q" : "";
        const key = `${section}|${kind}`;
        const k = (counters.get(key) || 0) + 1;
        counters.set(key, k);
        out.push({
          index: out.length + 1,
          id: `${section}#${kind}${k}`,
          section,
          quoted: open.quoted,
          line: open.start,
          code: open.body.join("\n") + "\n",
        });
      }
      open = null;
      return;
    }
    open.body.push(open.quoted ? line.replace(/^\s*(?:>\s?)*/, "") : line);
  });
  return out;
}

const cache = new Map();
/** The bash blocks of skills/<name>/SKILL.md (or any markdown path). */
export function loadBlocks(nameOrPath) {
  const file = nameOrPath.includes("/") ? nameOrPath : skillPath(nameOrPath);
  if (!cache.has(file)) cache.set(file, extractBlocks(readFileSync(file, "utf8")));
  return cache.get(file);
}

/** Pick blocks by id ("step3#1") or 1-based document index. Unknown selectors throw, so a renamed or
 *  re-ordered block fails loudly instead of silently running fewer steps. */
export function pick(skill, selectors) {
  const blocks = loadBlocks(skill);
  return selectors.map((s) => {
    const b = typeof s === "number" ? blocks[s - 1] : blocks.find((x) => x.id === s);
    if (!b) throw new Error(`${skill}: no bash block ${JSON.stringify(s)} (have: ${blocks.map((x) => x.id).join(", ")})`);
    return b;
  });
}

/**
 * Replace `<placeholder>` tokens (never a here-doc `<<`). Names in `map` get their value; any other
 * placeholder becomes a bash-safe word when `generic` is true (syntax checks) and is left alone
 * otherwise (executed blocks legitimately contain text such as `bot<redacted>`).
 */
export function fillPlaceholders(code, map = {}, { generic = false } = {}) {
  return code.replace(/(?<!<)<([A-Za-z][A-Za-z0-9_-]*)>/g, (all, name) => {
    if (name in map) return map[name];
    return generic ? `X_${name.replace(/-/g, "_")}` : all;
  });
}

/**
 * Build one script from parts. A part is a raw shell string, or
 *   { skill, ids: [...], replace?: [[from, to], ...], placeholders?: {name: value} }
 * `replace` is plain text substitution applied to the chosen blocks (used for negative controls);
 * it throws when `from` is absent so a control cannot silently stop mutating anything.
 */
export function assemble(parts) {
  const chunks = [];
  for (const part of parts) {
    if (typeof part === "string") {
      chunks.push(part.endsWith("\n") ? part : `${part}\n`);
      continue;
    }
    for (const b of pick(part.skill, part.ids)) {
      let code = fillPlaceholders(b.code, part.placeholders || {});
      for (const [from, to] of part.replace || []) {
        if (!code.includes(from)) continue;
        code = code.split(from).join(to);
      }
      chunks.push(`echo ">>> ${part.skill} ${b.id}"\n${code}`);
    }
  }
  return chunks.join("");
}

/** Apply `replace` pairs to a block and report whether each `from` was found in ANY chosen block. */
export function mustReplace(part) {
  const blocks = pick(part.skill, part.ids);
  for (const [from] of part.replace || []) {
    if (!blocks.some((b) => b.code.includes(from))) throw new Error(`control cannot apply: ${JSON.stringify(from)} not in ${part.skill} ${part.ids.join(",")}`);
  }
}
