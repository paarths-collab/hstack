// Cross-cutting static checks over the repaired skills and the skill template: the helpers they share
// must stay identical, nothing may be called before it is defined, and every block must parse.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { TEMPLATE_PATH, extractBlocks, fillPlaceholders, loadBlocks } from "./helpers/blocks.mjs";

const GENERIC = ["integration-notion", "integration-github", "platform-telegram", "hermes-model"];
const DEPLOY = "hermes-deploy";
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

  for (const name of ["snapshot", "rollback", "finish"]) {
    it(`${name}() is identical in the four generic skills and the template (SKILL_NAME is a variable)`, () => {
      const defs = [...GENERIC, TEMPLATE_PATH].map((s) => fn(step0(s).code, name));
      defs.forEach((d, i) => assert.ok(d, `${label([...GENERIC, TEMPLATE_PATH][i])}: ${name}() missing`));
      for (const d of defs) assert.equal(d, defs[0]);
    });
  }

  // Generic lines the deploy variant replaces on purpose (it also covers SOUL.md and the crontab and calls the
  // absolute hermes path).
  const REPLACED = [
    "for f in .env config.yaml; do",
    "hermes -p default gateway stop",
    "sleep 2",
    "hermes -p default gateway ensure --json --timeout 60 >/dev/null",
    'st=$(hermes -p default gateway status 2>&1) || status_rc=$?',
    'echo "rollback: restored ~/.hermes/.env and config.yaml to their pre-$SKILL_NAME state."',
  ];
  it("deploy_snapshot/deploy_rollback/deploy_finish equal the generic ones modulo the documented extras", () => {
    const code = step0(DEPLOY).code;
    // Documented extras: SOUL.md and the crontab are also snapshotted/restored; the rollback uses the
    // absolute hermes path and leaves the gateway stopped when no .env existed before the deploy.
    const extra = /SOUL\.md|crontab|\bH=|"\$H"|GW_WANTED|\.env\.absent|else sleep 2|restored ~\/\.hermes\/\.env, config\.yaml, SOUL\.md|rollback: gateway left stopped/;
    const norm = (t) => t.replaceAll("deploy_", "").replaceAll("DEPLOY_SKILL", "SKILL_NAME").replaceAll("hermes-deploy", "SKILL").replace(/^snapshot\(\)/, "snapshot()");
    for (const name of ["snapshot", "rollback", "finish"]) {
      const d = fn(code, `deploy_${name}`);
      assert.ok(d, `deploy_${name}() missing`);
      const g = fn(step0(GENERIC[0]).code, name).split("\n").map((l) => l.trim());
      const dn = norm(d).split("\n").map((l) => l.trim());
      for (const l of dn) if (!g.includes(l)) assert.match(l, extra, `deploy_${name}: unexpected line not in the generic helper: ${l}`);
      for (const l of g) if (!dn.includes(l) && l && !l.startsWith("#")) assert.ok(REPLACED.includes(l), `deploy_${name}: generic line dropped without explanation: ${l}`);
    }
  });

  it("no helper is defined by `declare -f` or a second time later in the file", () => {
    for (const s of SOURCES) {
      const blocks = loadBlocks(s);
      for (const b of blocks) assert.ok(!codeLines(b.code).some((l) => /declare -f/.test(l)), `${label(s)} ${b.id}: declare -f`);
      for (const name of ["snapshot", "rollback", "finish", "deploy_snapshot", "deploy_rollback", "deploy_finish", "remote"]) {
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
      for (const name of [...names, "remote"]) {
        const def = blocks.findIndex((b) => b.code.split("\n").some((l) => l.startsWith(`${name}() {`)));
        assert.ok(def >= 0, `${label(s)}: ${name}() is never defined`);
        blocks.slice(0, def).forEach((b) => {
          codeLines(b.code).forEach((l) => assert.ok(!callRe(name).test(l), `${label(s)} ${b.id} calls ${name} before it is defined: ${l}`));
        });
      }
    }
  });
  it("deploy only calls its own namespaced helpers", () => {
    for (const b of loadBlocks(DEPLOY)) {
      codeLines(b.code).forEach((l) => {
        for (const bare of ["rollback", "snapshot", "finish"]) assert.ok(!callRe(bare).test(l), `${b.id}: calls bare ${bare}: ${l}`);
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
