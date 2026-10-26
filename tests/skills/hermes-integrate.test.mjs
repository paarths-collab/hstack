// hermes-integrate: the orchestrator validates the picks, refuses specialists that are still legacy procedures, keeps a resumable
// plan, writes NO secret and does not reload, and verifies the batch with the native `mcp test` and `gateway ensure`.
// The real SKILL.md blocks run against a simulated VPS (stubs written from the v0.22.5 source).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assertStateIdentical, writeEvents } from "./helpers/asserts.mjs";
import { SKILLS_DIR, assemble, loadBlocks, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "hermes-integrate";
const PRE = ["before-you-start#1", "step0#1"];
const MARKER = "> **Compatibility:** legacy procedure written for Hermes 0.15.x - not yet re-verified on Hermes 0.22.5.\n";
const script = (ids, { replace = [], pre = "", post = "" } = {}) =>
  assemble(["set +e\n", pre, { skill: SKILL, ids: PRE, replace }, { skill: SKILL, ids, replace }, post, SCRIPT_END]);
const gate = (o) => script(["step1#1", "step2#1"], o);
const calls = (run) => run.sb.hermesCalls().map((c) => c.join(" "));
const skillFile = (dir, name, legacy = false) => ({ [`${dir}/integration-${name}/SKILL.md`]: `---\nname: integration-${name}\n---\n\n# /integration-${name}\n${legacy ? MARKER : ""}\nbody\n` });

describe("hermes-integrate: the catalog in the text is the catalog that exists", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const dirs = readdirSync(SKILLS_DIR).filter((n) => n.startsWith("integration-")).map((n) => n.slice("integration-".length)).sort();
  it("the KNOWN list in Step 2 equals skills/integration-* (no phantom integration, none missing)", () => {
    const m = /KNOWN="([^"]+)"/.exec(text);
    assert.ok(m, "KNOWN list");
    assert.deepEqual(m[1].split(" ").sort(), dirs);
  });
  it("every integration appears in the catalog table", () => {
    const table = text.slice(text.indexOf("| Category | Integrations"), text.indexOf("Do not re-implement"));
    for (const d of dirs) assert.ok(new RegExp(`(^|[^a-z0-9-])${d}([^a-z0-9-]|$)`, "m").test(table), `${d} missing from the table`);
  });
});

describe("hermes-integrate: Step 2 validates the picks before anything runs", { concurrency: 6 }, () => {
  it("normalises case, commas and spaces, keeps the order and drops duplicates", async () => {
    await scenario({ name: "int-norm", script: gate(), env: { CHOSEN: "Notion, github  NOTION,stripe" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /Plan \(in this order\): notion github stripe\n/);
      assert.deepEqual(writeEvents(run), []);
    });
  });
  for (const [label, chosen, re] of [
    ["an unknown integration", "notion, bogus", /'bogus' is not in the hstack integration catalog/],
    ["a provider that has a native skill", "openai", /'openai' is not in the hstack integration catalog/],
    ["a shell metacharacter", "notion;touch$HOME/pwned", /is not an integration name/],
    ["command substitution", "$(touch pwned)", /is not an integration name/],
    ["a leading dash", "-notion", /is not an integration name/],
    ["a path", "../etc/passwd", /is not an integration name/],
    ["a glob", "*", /is not an integration name/],
    ["an empty list", "", /CHOSEN is empty/],
  ]) {
    it(`${label}: ABORT, nothing written or executed`, async () => {
      await scenario({ name: "int-val", seed: { env: "A=1\n", config: "x: 1\n" }, script: gate(), env: { CHOSEN: chosen } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /ABORT/);
        assert.match(run.out, re);
        assert.match(run.out, /Nothing was written/);
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }
  it("an unreachable SSH host aborts at the first block", async () => {
    await scenario({ name: "int-ssh", knobs: { ssh_down: true }, script: gate(), env: { CHOSEN: "notion" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: SSH/);
    });
  });
  it("a Hermes that is not 0.22.5 stops before the plan is built", async () => {
    await scenario({ name: "int-ver", files: { "hermes.version": "hermes 0.17.1\n" }, script: gate(), env: { CHOSEN: "notion" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: .*0\.22\.5/);
      assert.ok(!/Plan \(in this order\)/.test(run.out));
    });
  });
});

describe("hermes-integrate: legacy specialists are refused unless the user accepts the risk", { concurrency: 6 }, () => {
  const files = { ...skillFile(".claude/skills", "notion"), ...skillFile(".claude/skills", "stripe", true), ...skillFile(".agents/skills", "hubspot", true) };
  it("a specialist carrying the legacy marker stops the batch before anything is written", async () => {
    await scenario({ name: "int-legacy", files, script: gate(), env: { CHOSEN: "notion, stripe, hubspot" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: still legacy procedures.*: stripe hubspot\./);
      assert.match(run.out, /ALLOW_LEGACY=1/);
      assert.deepEqual(writeEvents(run), []);
    });
  });
  it("modernized specialists alone pass", async () => {
    await scenario({ name: "int-modern", files, script: gate(), env: { CHOSEN: "notion" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(!/NOTE: integration-notion is not installed/.test(run.out));
    });
  });
  it("ALLOW_LEGACY=1 proceeds with a WARN naming them", async () => {
    await scenario({ name: "int-allow", files, script: gate(), env: { CHOSEN: "notion, stripe", ALLOW_LEGACY: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /WARN: ALLOW_LEGACY=1: running unverified legacy specialists: stripe/);
      assert.match(run.out, /Plan \(in this order\): notion stripe/);
    });
  });
  it("a specialist that is not installed locally is a NOTE (the agent must read it), not a pass or a failure", async () => {
    await scenario({ name: "int-missing", script: gate(), env: { CHOSEN: "notion" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /NOTE: integration-notion is not installed in a known skill folder/);
    });
  });
  it("without the check, a legacy specialist would run (control)", async () => {
    const rep = [["grep -q '^> \\*\\*Compatibility:\\*\\* legacy procedure' \"$f\"", "false"]];
    mustReplace({ skill: SKILL, ids: ["step2#1"], replace: rep });
    await scenario({ name: "int-ctl", files, script: gate({ replace: rep }), env: { CHOSEN: "stripe" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /Plan \(in this order\): stripe/);
    });
  });
});

describe("hermes-integrate: the dry run and the resumable plan", { concurrency: 6 }, () => {
  it("the dry run says up front that the gateway restarts once per specialist and that this skill writes no secret", async () => {
    await scenario({ name: "int-dry", script: script(["step1#1", "step2#1", "step3#1"]), env: { CHOSEN: "notion, github" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /DRY RUN/);
      assert.match(run.out, /For each of: notion github/);
      assert.match(run.out, /one per specialist/);
      assert.match(run.out, /writes no secret/);
      assert.deepEqual(writeEvents(run), []);
    });
  });
  it("next_specialist walks the plan in order and resumes after the ones marked done", async () => {
    const post = 'a=$(next_specialist); mark_done "$a"; b=$(next_specialist); mark_done "$b"; c=$(next_specialist); mark_done "$c"; d=$(next_specialist); echo "ORDER=$a,$b,$c RC_LAST=$? DONE=[$DONE]"\n';
    await scenario({ name: "int-plan", script: script(["step1#1", "step2#1", "step4#1"], { post }), env: { CHOSEN: "github, notion, stripe" } }, async (run) => {
      assert.match(run.out, /ORDER=github,notion,stripe RC_LAST=1 DONE=\[github notion stripe\]/);
    });
  });
});

describe("hermes-integrate: Step 5 verifies natively and never reloads", { concurrency: 6 }, () => {
  const seed = { config: "mcp.notion:\n  url: https://mcp.example.test/n\n  enabled: true\nmcp.github:\n  url: https://mcp.example.test/g\n  enabled: true\n" };
  const run5 = (done) =>
    assemble(["set +e\n", { skill: SKILL, ids: PRE }, { skill: SKILL, ids: ["step1#1", "step2#1", "step4#1"] }, `${done.split(" ").map((n) => `mark_done "${n}"; `).join("")}\n`, { skill: SKILL, ids: ["step5#1", "step6#1"] }, SCRIPT_END]);
  it("every wired MCP server is tested by its exact name; the gateway readiness is checked; no reload, no write", async () => {
    await scenario({ name: "int-ok", seed, script: run5("notion github"), env: { CHOSEN: "notion, github" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /OK: notion connected\./);
      assert.match(run.out, /OK: github connected\./);
      assert.match(run.out, /Wired and verified: notion github\n/);
      assert.match(run.out, /Not finished: *none/);
      const c = calls(run);
      assert.ok(c.includes("mcp test notion") && c.includes("mcp test github"));
      assert.ok(c.includes("gateway ensure --json --timeout 60"));
      assert.ok(!c.some((x) => /^gateway (restart|stop|start|run|install)|^config set|^mcp (add|remove|install)/.test(x)), `orchestrator must not change anything: ${c}`);
      assert.deepEqual(writeEvents(run).filter((e) => e !== "hermes gateway ensure"), [], "ensure is a readiness probe, not a write");
      assertStateIdentical(run);
    });
  });
  it("a server that does not connect fails the batch (exit 1) and names the specialist's own rollback", async () => {
    await scenario({ name: "int-bad", seed, knobs: { "fail.mcp.test": true }, script: run5("notion"), env: { CHOSEN: "notion" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: mcp test notion did not connect/);
      assert.match(run.out, /Rollback/);
    });
  });
  it("a REST-only integration has no MCP row: a NOTE, not a failure", async () => {
    await scenario({ name: "int-rest", seed, script: run5("stripe"), env: { CHOSEN: "stripe", ALLOW_LEGACY: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /NOTE: no MCP server named stripe is registered/);
      assert.ok(!calls(run).includes("mcp test stripe"));
    });
  });
  it("the name match is exact: a server called github-enterprise does not count as github", async () => {
    await scenario({ name: "int-exact", seed: { config: "mcp.github-enterprise:\n  url: https://mcp.example.test/g\n  enabled: true\n" }, script: run5("github"), env: { CHOSEN: "github" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /NOTE: no MCP server named github is registered/);
      assert.ok(!calls(run).includes("mcp test github"));
    });
  });
  it("a gateway that is not ready fails the batch", async () => {
    await scenario({ name: "int-gw", seed, knobs: { ensure_exit: "5" }, script: run5("notion"), env: { CHOSEN: "notion" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: the gateway is not ready/);
    });
  });
});

describe("hermes-integrate: static facts about the text", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  it("no step writes a secret, registers a server or restarts the gateway", () => {
    for (const b of loadBlocks(SKILL)) {
      if (b.id === "step0#1") continue;
      const code = b.code.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      assert.doesNotMatch(code, /\bhermes\b[^\n]*\b(config set|mcp (add|install|remove)|gateway (restart|stop|start|run|install))\b|\bgw_reload\b|>>?\s*\S*\.env/, `${b.id}`);
    }
  });
  it("does not invent specialist options and says why the reload is not batched", () => {
    const fences = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
    assert.doesNotMatch(fences, /--no-reload|--secret-already-written|--smoke-test|SKIP_RELOAD/);
    assert.match(text, /does not batch the gateway reload/);
    assert.match(text, /up to N times/);
  });
  it("cites its source and says what was not verified", () => {
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /\*\*Not verified:\*\*/);
  });
});
