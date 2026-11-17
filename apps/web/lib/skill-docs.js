// Build-time reader for skills/<name>/ in the repo: frontmatter, rendered Markdown, highlighted source files.
// Only imported by server components; the output is static HTML, so no Markdown or highlighter code reaches the browser.
import fs from "node:fs/promises";
import path from "node:path";
import { Marked } from "marked";
import { createHighlighter } from "shiki";
import { entryForSkill, githubBlob } from "../app/docs-nav.js";

const REPO_ROOT = path.resolve(process.cwd(), "../..");
const SKILLS_DIR = path.join(REPO_ROOT, "skills");
const LANGS = ["bash", "shellscript", "json", "yaml", "ini", "python", "markdown", "text"];
const THEME = "github-light";

let highlighterPromise;
function highlighter() {
  highlighterPromise ??= createHighlighter({ themes: [THEME], langs: LANGS });
  return highlighterPromise;
}

const LANG_BY_EXT = { ".md": "markdown", ".py": "python", ".sh": "bash", ".json": "json", ".yaml": "yaml", ".yml": "yaml" };

function normaliseLang(lang) {
  const l = (lang || "").trim().split(/\s+/)[0].toLowerCase();
  if (l === "sh" || l === "shell" || l === "zsh") return "bash";
  return LANGS.includes(l) ? l : "text";
}

async function highlight(code, lang) {
  const h = await highlighter();
  return h.codeToHtml(code, { lang: normaliseLang(lang), theme: THEME });
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function slugify(text) {
  return text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[`*_~]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-");
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1).replace(/\\"/g, '"');
    data[kv[1]] = value;
  }
  return { data, body: raw.slice(m[0].length) };
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  // SKILL.md first, then the rest alphabetically.
  return out.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));
}

// Turn repo-relative links and /skill references into site or GitHub links.
function resolveHref(href, skillName) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [target, hash = ""] = href.split("#");
  const repoPath = path.posix.normalize(path.posix.join("skills", skillName, target));
  const skillMatch = repoPath.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (skillMatch) {
    const entry = entryForSkill(skillMatch[1]);
    if (entry) return entry.href + (hash ? `#${hash}` : "");
  }
  return githubBlob(repoPath) + (hash ? `#${hash}` : "");
}

export async function renderSkillMarkdown(body, skillName) {
  const toc = [];
  const used = new Map();
  const uniqueId = (text) => {
    const base = slugify(text) || "section";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };

  const marked = new Marked({ gfm: true, async: true });
  marked.use({
    async walkTokens(token) {
      if (token.type === "code") token.highlighted = await highlight(token.text, token.lang);
    },
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        const plain = text.replace(/`/g, "");
        const id = uniqueId(plain);
        if (depth === 1) return ""; // The page header already shows the title.
        const step = depth === 2 ? plain.match(/^Step\s+(\d+[a-z]?)\s*[—–-]\s*(.*)$/i) : null;
        if (depth <= 3) toc.push({ id, depth, text: step ? step[2] : plain, step: step ? step[1] : null });
        const anchor = `<a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a>`;
        if (step) {
          const rest = inner.replace(/^Step\s+\d+[a-z]?\s*[—–-]\s*/i, "");
          return `<h2 id="${id}" class="step-heading"><span class="step-badge">Step ${escapeHtml(step[1])}</span><span>${rest}</span>${anchor}</h2>\n`;
        }
        return `<h${depth} id="${id}">${inner}${anchor}</h${depth}>\n`;
      },
      code(token) {
        const lang = normaliseLang(token.lang);
        const label = lang === "text" ? "Text" : lang === "bash" ? "Shell" : lang.toUpperCase();
        return `<div class="code-block" data-lang="${lang}"><div class="code-bar"><span>${label}</span><button type="button" class="code-copy" data-copy-code>Copy</button></div>${token.highlighted}</div>\n`;
      },
      codespan({ text }) {
        const ref = text.match(/^\/([a-z0-9-]+)$/);
        const entry = ref ? entryForSkill(ref[1]) : null;
        if (entry) return `<a class="skill-ref" href="${entry.href}"><code>${escapeHtml(text)}</code></a>`;
        return `<code>${escapeHtml(text)}</code>`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const resolved = resolveHref(href, skillName);
        const external = /^https?:/.test(resolved);
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        return `<a href="${escapeHtml(resolved)}"${t}${external ? ' target="_blank" rel="noreferrer"' : ""}>${inner}</a>`;
      },
      table(token) {
        const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</th>`).join("");
        const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("");
        return `<div class="table-wrap" role="region" aria-label="Reference table" tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });

  const html = await marked.parse(body);
  return { html, toc };
}

export async function loadSkill(skillName) {
  const dir = path.join(SKILLS_DIR, skillName);
  const raw = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
  const { data, body } = parseFrontmatter(raw);
  const { html, toc } = await renderSkillMarkdown(body, skillName);
  const files = await Promise.all((await listFiles(dir)).map(async (rel) => {
    const content = rel === "SKILL.md" ? raw : await fs.readFile(path.join(dir, rel), "utf8");
    return {
      path: rel,
      repoPath: `skills/${skillName}/${rel}`,
      lines: content.split("\n").length,
      bytes: Buffer.byteLength(content),
      highlighted: await highlight(content, LANG_BY_EXT[path.extname(rel)] ?? "text"),
    };
  }));
  const steps = toc.filter((t) => t.step).length;
  return { name: data.name ?? skillName, description: data.description ?? "", html, toc, files, steps, lines: raw.split("\n").length };
}
