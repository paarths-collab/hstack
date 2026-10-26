// Cross-cutting static checks over the repaired skills and the skill template: the helpers they share
// must stay identical, nothing may be called before it is defined, and every block must parse.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { existsSync, readdirSync, readFileSync } from "node:fs";

import { SKILLS_DIR, TEMPLATE_PATH, extractBlocks, fillPlaceholders, loadBlocks, skillPath } from "./helpers/blocks.mjs";
import { checkAgainstV0225, hermesInvocations } from "./helpers/hermes-calls.mjs";

// The skills this wave modernized (and the template they copy). Every skill that defines the Step 0 `remote()` helper is
// "canonical": it must carry byte-identical copies of the shared helpers. hermes-deploy is the one namespaced variant.
const ALL_SKILLS = readdirSync(SKILLS_DIR).filter((n) => existsSync(skillPath(n))).sort();
const OWNED = ALL_SKILLS.filter((n) => /^(hermes-|platform-)/.test(n) || ["integration-notion", "integration-github", "integration-obsidian"].includes(n));
const DEPLOY = "hermes-deploy";
const definesRemote = (n) => loadBlocks(n).some((b) => /^remote\(\) \{/m.test(b.code));
const GENERIC = OWNED.filter((n) => n !== DEPLOY && definesRemote(n));
const SOURCES = [...GENERIC, DEPLOY, TEMPLATE_PATH];
const label = (s) => (s.includes("/") ? "template" : s);

/** The Step 0 block (helpers) of a skill: the block that defines remote(). */
const step0 = (src) => {
  const b = loadBlocks(src).find((x) => /^remote\(\) \{/m.test(x.code));
  assert.ok(b, `${label(src)}: no block defines remote()`);
  return b;
};
/** Text of a shell function `name() {` ... first line that is exactly `}`; null when absent. */
function fn(code, name) {
  const lines = code.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) return null;
  if (lines[start].trimEnd().endsWith("}")) return lines[start]; // one-line definition
  const end = lines.findIndex((l, i) => i > start && l === "}");
  assert.ok(end > start, `unterminated function ${name}`);
  return lines.slice(start, end + 1).join("\n");
}
const codeLines = (code) => code.split("\n").filter((l) => !/^\s*#/.test(l));
/** A line with the contents of its quoted strings blanked, so words inside messages ("...; snapshot kept.") are not calls. */
const unquoted = (l) => l.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''");

describe("block extractor", () => {
  const md = [
    "# T", "## Step 1 — a", "```bash", "echo one", "```", "```yaml", "x: 1", "```",
    "## Step 2 — b", "```bash", "echo two", "```", "> alternative:", "> ```bash", "> echo quoted", "> ```",
    "### Path A (preferred)", "```bash", "echo a", "```",
  ].join("\n");
  const blocks = extractBlocks(md);
  it("numbers bash blocks in document order and ignores other languages", () => {
    assert.deepEqual(blocks.map((b) => b.index), [1, 2, 3, 4]);
    assert.deepEqual(blocks.map((b) => b.code.trim()), ["echo one", "echo two", "echo quoted", "echo a"]);
  });
  it("names blocks by section and marks blockquoted alternatives", () => {
    assert.deepEqual(blocks.map((b) => b.id), ["step1#1", "step2#1", "step2#q1", "step2.pathA#1"]);
    assert.deepEqual(blocks.map((b) => b.quoted), [false, false, true, false]);
  });
  it("fills only named placeholders unless generic", () => {
    assert.equal(fillPlaceholders("a <x> <<EOF <y-z>", { x: "1" }), "a 1 <<EOF <y-z>");
    assert.equal(fillPlaceholders("<y-z> <<EOF", {}, { generic: true }), "X_y_z <<EOF");
  });
});

describe("shared helpers are identical across the repaired skills", () => {
  it("remote() is byte-identical in all skills and the template", () => {
    const defs = SOURCES.map((s) => fn(step0(s).code, "remote"));
    defs.forEach((d, i) => assert.ok(d, `${label(SOURCES[i])}: remote() missing`));
    for (const d of defs) assert.equal(d, defs[0]);
    assert.match(defs[0], /export PATH=\\"\\\$HOME\/\.local\/bin:\\\$PATH\\";/, "remote() must put ~/.local/bin on PATH");
  });

  for (const name of ["gw_ready", "gw_reload"]) {
    it(`${name}() is byte-identical in every canonical skill, the deploy skill and the template`, () => {
      const defs = SOURCES.map((s) => fn(step0(s).code, name));
      defs.forEach((d, i) => assert.ok(d, `${label(SOURCES[i])}: ${name}() missing`));
      for (const d of defs) assert.equal(d, defs[0]);
    });
  }
  it("the whole lifecycle helper chunk (comments included) is identical and documents the ensure side effect", () => {
    const chunk = (src) => {
      const code = step0(src).code;
      const a = code.indexOf("# gw_ready [SECONDS]");
      const b = code.indexOf("gw_reload() {");
      const end = code.indexOf("\n}\n", b);
      assert.ok(a >= 0 && b > a && end > b, `${label(src)}: lifecycle chunk not found`);
      return code.slice(a, end + 3);
    };
    const want = chunk(TEMPLATE_PATH);
    assert.match(want, /STARTS a gateway when none is running/);
    for (const sk of SOURCES) assert.equal(chunk(sk), want, `${label(sk)}: lifecycle helper comments/functions differ from the template`);
  });
  it("the lifecycle helpers use only the native mechanism: restart --detach, ensure --json, instance_id", () => {
    const code = step0(TEMPLATE_PATH).code;
    const ready = fn(code, "gw_ready");
    const reload = fn(code, "gw_reload");
    assert.match(ready, /hermes -p default gateway ensure --json --timeout "\$T"/);
    assert.match(ready, /"state":"ready"/);
    assert.match(reload, /hermes -p default gateway restart --detach\$\{interrupt:\+ -y\}/);
    assert.match(reload, /if \[ "\$\{GW_INTERRUPT:-0\}" = 1 \]; then interrupt=1; fi/);
    assert.doesNotMatch(reload, /GW_INTERRUPT:\+/);
    assert.match(reload, /instance_id/);
    assert.doesNotMatch(reload, /gateway stop|gateway run|--daemon|gateway status/);
    assert.doesNotMatch(ready, /gateway status/);
  });

  for (const name of ["snapshot", "rollback", "finish"]) {
    it(`${name}() is identical in the four generic skills and the template (SKILL_NAME is a variable)`, () => {
      const tpl = fn(step0(TEMPLATE_PATH).code, name);
      assert.ok(tpl, `template: ${name}() missing`);
      let n = 0;
      for (const sk of GENERIC) {
        const d = fn(step0(sk).code, name);
        if (d === null) continue; // read-only skills have nothing to snapshot
        n++;
        assert.equal(d, tpl, `${sk}: ${name}() differs from the template`);
      }
      assert.ok(n >= 4, "expected the canonical write skills to define it");
    });
  }

  // Lines the deploy variant adds on purpose: it also snapshots/restores SOUL.md and the crontab, leaves the gateway
  // stopped when no .env existed before the deploy (exit code 11 from the restore script), and names its own helpers.
  const DEPLOY_ONLY = /\bstop_flag\b|SOUL\.md|crontab|\.env\.absent|exit 11|"\$rc" = 11|gateway stop|gateway left stopped|no \.env before this deploy|else$|elif \[ "\$rc" = 0 \]|^fi$|return "\$rc"|^\}?$|gateway could not be stopped|^# 11 = restored/;
  it("deploy_snapshot/deploy_rollback/deploy_finish equal the generic ones modulo the documented extras", () => {
    const code = step0(DEPLOY).code;
    const norm = (t) => t.replaceAll("deploy_", "").replaceAll("DEPLOY_SKILL", "SKILL_NAME").replaceAll("hermes-deploy", "SKILL");
    for (const name of ["snapshot", "rollback", "finish"]) {
      const d = fn(code, `deploy_${name}`);
      assert.ok(d, `deploy_${name}() missing`);
      const g = fn(step0(TEMPLATE_PATH).code, name).split("\n").map((l) => l.trim());
      const dn = norm(d).split("\n").map((l) => l.trim());
      for (const l of dn) if (!g.includes(l)) assert.match(l, DEPLOY_ONLY, `deploy_${name}: unexpected line not in the generic helper: ${l}`);
      // Nothing of the generic restore logic may silently disappear (only the final retire/echo lines differ).
      for (const l of g) if (!dn.includes(l) && l && !l.startsWith("#")) assert.match(l, /^for f in \.env config\.yaml; do$|^gw_reload |rollback: restored|\|\| \{ echo "rollback: files restored|finish \|\| return 1|^\[ "\$rc" = 0 \] \|\| return|^\[ -f "\$HOME\/\.hermes\/\.env" \] && chmod 600|^exit 0$|SKILL_NAME='\$SKILL_NAME'|DEPLOY|^\|\| \{ echo/, `deploy_${name}: generic line dropped without explanation: ${l}`);
    }
  });

  it("no helper is defined by `declare -f` or a second time later in the file", () => {
    for (const s of SOURCES) {
      const blocks = loadBlocks(s);
      for (const b of blocks) assert.ok(!codeLines(b.code).some((l) => /declare -f/.test(l)), `${label(s)} ${b.id}: declare -f`);
      for (const name of ["snapshot", "rollback", "finish", "deploy_snapshot", "deploy_rollback", "deploy_finish", "remote", "gw_ready", "gw_reload"]) {
        const defs = blocks.filter((b) => b.code.split("\n").some((l) => l.startsWith(`${name}() {`)));
        assert.ok(defs.length <= 1, `${label(s)}: ${name}() defined in ${defs.map((d) => d.id).join(", ")}`);
      }
    }
  });
});

describe("definition order", () => {
  const callRe = (name) => new RegExp(`(^|[;&|{(]\\s*|\\|\\|\\s*|&&\\s*)${name}(\\s|;|$)`);
  it("no block calls rollback/snapshot/finish/remote before the block that defines it", () => {
    for (const s of SOURCES) {
      const blocks = loadBlocks(s);
      const names = s === DEPLOY ? ["deploy_snapshot", "deploy_rollback", "deploy_finish"] : ["snapshot", "rollback", "finish"];
      for (const name of [...names, "remote", "gw_ready", "gw_reload"]) {
        const def = blocks.findIndex((b) => b.code.split("\n").some((l) => l.startsWith(`${name}() {`)));
        const used = blocks.some((b) => codeLines(b.code).some((l) => callRe(name).test(unquoted(l))));
        if (def < 0 && !used) continue; // a read-only skill has nothing to snapshot or roll back
        assert.ok(def >= 0, `${label(s)}: ${name}() is called but never defined`);
        blocks.slice(0, def).forEach((b) => {
          codeLines(b.code).forEach((l) => assert.ok(!callRe(name).test(unquoted(l)), `${label(s)} ${b.id} calls ${name} before it is defined: ${l}`));
        });
      }
    }
  });
  it("deploy only calls its own namespaced helpers", () => {
    for (const b of loadBlocks(DEPLOY)) {
      codeLines(b.code).forEach((l) => {
        for (const bare of ["rollback", "snapshot", "finish"]) assert.ok(!callRe(bare).test(unquoted(l)), `${b.id}: calls bare ${bare}: ${l}`);
      });
    }
  });
});

describe("forbidden writes and shapes", () => {
  it("no skill block writes TELEGRAM_ENABLED or TELEGRAM_ALLOWED_CHATS", () => {
    for (const s of SOURCES) for (const b of loadBlocks(s)) {
      codeLines(b.code).forEach((l) => assert.ok(!/TELEGRAM_ENABLED|TELEGRAM_ALLOWED_CHATS/.test(l), `${label(s)} ${b.id}: ${l}`));
    }
  });
  it("secrets are never passed as arguments of the remote command in the write steps", () => {
    for (const [skill, secrets] of [["integration-notion", ["NOTION_TOKEN"]], ["integration-github", ["GITHUB_TOKEN"]], ["platform-telegram", ["TELEGRAM_BOT_TOKEN"]], ["hermes-model", ["MODEL_API_KEY"]]]) {
      for (const b of loadBlocks(skill)) {
        codeLines(b.code).forEach((l) => {
          for (const v of secrets) assert.ok(!new RegExp(`remote\\s+["'][^|]*\\$\\{?${v}\\b`).test(l.replace(/\\\$/g, "")) || /echo|ABORT|FAIL/.test(l), `${skill} ${b.id}: ${v} inside a remote command string: ${l}`);
        });
      }
    }
  });
});

describe("every fenced bash block parses", () => {
  for (const s of SOURCES) {
    const blocks = loadBlocks(s);
    it(`${label(s)}: ${blocks.length} blocks pass bash -n`, () => {
      for (const b of blocks) {
        const code = fillPlaceholders(b.code, {}, { generic: true });
        const r = spawnSync("/bin/bash", ["-n"], { input: code, encoding: "utf8" });
        assert.equal(r.status, 0, `${label(s)} ${b.id} (line ${b.line}): ${r.stderr}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Catalogue-wide gates for the modernized skills (hermes-*, platform-*, notion, github, obsidian) and the template.
// They exist because the stub used to accept `gateway run --daemon`, so nothing noticed that it does not exist.
// ---------------------------------------------------------------------------------------------------------------
const FILES = [...OWNED.map((n) => [n, skillPath(n)]), ["template", TEMPLATE_PATH]];
const text = (f) => readFileSync(f, "utf8");

describe("modernized skills: no retired or nonexistent gateway commands", () => {
  for (const [name, file] of FILES) {
    it(`${name}: no \`gateway run --daemon\`, no daemon flag claims, no stop/run reload recipe`, () => {
      const t = text(file);
      for (const l of t.split("\n")) assert.ok(!/gateway\s+run[^|;&]*--daemon/.test(l), `${name}: line matches the validator's daemon regex: ${l}`);
      assert.ok(!/gateway run --daemon|run --daemon/.test(t), `${name}: mentions \`run --daemon\` (the flag does not exist at v0.22.5; \`gateway run\` is the foreground command)`);
      for (const l of t.split("\n")) {
        if (!/--daemon/.test(l)) continue;
        assert.match(l, /\b(no|not|never|nonexistent|does not exist|has no)\b/i, `${name}: --daemon mentioned without saying it does not exist: ${l}`);
      }
      for (const b of loadBlocks(file)) {
        codeLines(b.code).forEach((l) => assert.ok(!/gateway run\b/.test(l) || /hermes-parse: skip/.test(l), `${name} ${b.id}: runs \`gateway run\` (foreground, blocks the ssh call): ${l}`));
      }
    });

    it(`${name}: no claim that restart does not re-read .env`, () => {
      const t = text(file);
      assert.doesNotMatch(t, /does NOT (reliably )?re-?read|not re-?read\s+`?\.env|never use `?gateway restart|NOT restart\)/i, `${name}: still carries the unsupported "restart does not re-read .env" rule`);
    });

    it(`${name}: gateway health is never decided by grepping \`gateway status\` text`, () => {
      for (const b of loadBlocks(file)) {
        // A statement = logical line (backslash continuations joined) plus the line after a trailing pipe.
        const statements = b.code.replace(/\\\n\s*/g, " ").replace(/\|\s*\n\s*/g, "| ").split("\n").filter((l) => !/^\s*#/.test(l));
        for (const st of statements) {
          if (!/gateway status/.test(st)) continue;
          assert.doesNotMatch(st, /\b(grep|awk|sed|case)\b[^\n]*\b(running|active|ok|healthy|started|online|ready)\b/i, `${name} ${b.id}: decides health from \`gateway status\` text ("✗ Gateway is not running" contains "running"): ${st}`);
        }
        if (/gateway status/.test(b.code)) {
          assert.doesNotMatch(b.code.replace(/^\s*#.*$/gm, ""), /grep[^\n]*\b(running|active|healthy|started|online)\b/i, `${name} ${b.id}: greps for a health word in a block that reads \`gateway status\``);
        }
      }
    });
  }
});

describe("modernized skills: version and marker", () => {
  for (const [name, file] of FILES.filter(([n]) => n !== "template")) {
    it(`${name}: names Hermes 0.22.5 and carries no legacy compatibility marker`, () => {
      const t = text(file);
      assert.match(t, /0\.22\.5/, `${name}: does not name the target version 0.22.5`);
      assert.ok(!/^> \*\*Compatibility:\*\* legacy procedure/m.test(t), `${name}: still carries the legacy marker, so it is not modernized`);
      assert.doesNotMatch(t, /\b0\.15\.\d|0\.17\.x/, `${name}: mentions an older Hermes version as if supported`);
    });
  }
});

describe("every `hermes ...` invocation in the modernized skills parses at v0.22.5", () => {
  for (const [name, file] of FILES) {
    it(`${name}: all invocations are accepted by the real v0.22.5 argparse builders`, () => {
      const inv = hermesInvocations(text(file));
      const bad = checkAgainstV0225(inv).filter((r) => r.code !== 0);
      assert.deepEqual(bad.map((r) => `line ${r.line} [${r.block}]: hermes ${r.argv.join(" ")}  =>  ${r.output.split("\n").filter(Boolean).pop()}`), []);
    });
  }
  it("the extractor sees the calls it must check (anti-vacuity)", () => {
    const inv = hermesInvocations(text(TEMPLATE_PATH)).map((i) => i.argv.join(" "));
    for (const want of ["-p default gateway restart --detach", "-p default mcp add X --url X --auth header", "-p default mcp test X", "-p default config set X X"]) {
      assert.ok(inv.includes(want), `extractor missed: ${want}`);
    }
  });
  it("the vendored parser rejects the retired forms (control)", () => {
    const rows = checkAgainstV0225([
      { argv: ["-p", "default", "gateway", "run", "--daemon"] },
      { argv: ["-p", "default", "mcp", "add", "x", "--auth-header", "Authorization"] },
      { argv: ["-p", "default", "gateway", "restart", "--detach", "-y"] },
    ]);
    assert.deepEqual(rows.map((r) => r.code !== 0), [true, true, false]);
  });
});

describe("frontmatter of every skill is valid YAML (plain scalars may not contain `: ` or ` #`)", () => {
  for (const n of ALL_SKILLS) {
    it(`${n}: frontmatter`, () => {
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text(skillPath(n)));
      assert.ok(m, `${n}: no frontmatter`);
      const keys = new Set();
      for (const line of m[1].split("\n")) {
        const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
        assert.ok(kv, `${n}: frontmatter line is not "key: value": ${line}`);
        keys.add(kv[1]);
        const v = kv[2];
        if (v === "" || /^["'|>\[{]/.test(v)) continue;
        assert.doesNotMatch(v, /: |\s#/, `${n}: unquoted ${kv[1]} contains ": " or " #", which YAML reads as a mapping/comment — quote it`);
      }
      assert.ok(keys.has("name") && keys.has("description"), `${n}: name/description missing`);
    });
  }
});

describe("MCP package versions written in skills equal the VERSIONS.txt pins", () => {
  const versions = readFileSync(new URL("../../VERSIONS.txt", import.meta.url), "utf8");
  const pins = Object.fromEntries([...versions.matchAll(/^([A-Z0-9_]+_MCP_PKG)=(.+)$/gm)].map((m) => [m[1], m[2].trim()]));
  for (const [key, pin] of Object.entries(pins)) {
    const name = pin.replace(/(@|==)[^@=]*$/, "");
    if (!name || name === pin) continue;
    it(`${key}: every literal ${name}<version> in an owned skill is exactly ${pin}`, () => {
      for (const [skill, file] of FILES) {
        for (const m of text(file).matchAll(new RegExp(`${name.replace(/[/@.-]/g, "\\$&")}(@|==)([0-9][0-9A-Za-z.]*)`, "g"))) {
          assert.equal(m[0], pin, `${skill}: ${m[0]} differs from the VERSIONS.txt pin ${pin}`);
        }
      }
    });
  }
});
