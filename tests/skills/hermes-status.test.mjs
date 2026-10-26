// hermes-status: the real SKILL.md blocks, in document order, against a simulated VPS (helpers/sandbox.mjs).
// The skill is a READ-ONLY dashboard. It may show what `hermes status`, `gateway status`, `memory status`, `cron list`, `sessions`, `pairing`
// and the logs print, but it must never start, stop or restart anything, never write a file, never read .env, and never turn the TEXT of
// `gateway status` ("✗ Gateway is not running" contains "running") into a verdict. Model calls and `doctor` are opt-in.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { WRITE_EVENT, assertStateIdentical, writeEvents } from "./helpers/asserts.mjs";
import { assemble, loadBlocks, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "hermes-status";
const IDS = () => loadBlocks(SKILL).map((b) => b.id);
const flow = ({ replace = [] } = {}) => assemble(["set +e\n", { skill: SKILL, ids: IDS(), replace }, SCRIPT_END]);
const run = (opts, check) => scenario({ name: "status", script: flow(opts.flow), ...opts }, check);

const argvs = (r) => r.sb.hermesCalls().map((c) => (c[0] === "-p" ? c.slice(2) : c).join(" "));
// every file below HOME that a skill could create or change, except the stubs' own bookkeeping
const tree = (sb) => {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const rp = rel ? `${rel}/${name}` : name;
      if (!rel && ["logs", "knobs", "state", "local_bin", "remote_bin", ".hstack-native"].includes(name)) continue;
      if (rel === ".local" && name !== "bin" && name !== "state") continue;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, rp);
      else out[rp] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(sb.home, "");
  return out;
};
const seedTree = (sb) => { sb.__tree0 = tree(sb); };

// ---- reusable assertions (each also runs against a deliberately broken script as a negative control) ----
const MUTATING = /^gateway (ensure|restart|stop|start|run|install|uninstall|migrate|migrate-legacy)\b|^config (set|unset)\b|^mcp (add|remove)\b|^cron (create|remove|edit|pause|resume|run)\b|^sessions (prune|delete|archive|optimize|repair)|^pairing (approve|revoke|clear-pending)\b|^backup\b|^update\b|^doctor --fix|^setup\b|^memory (off|reset|setup)\b/;
const assertReadOnly = (r) => {
  const bad = argvs(r).filter((c) => MUTATING.test(c));
  assert.deepEqual(bad, [], "mutating hermes calls in a read-only skill");
  assert.deepEqual(writeEvents(r), []);
  assertStateIdentical(r, "read-only skill");
  assert.deepEqual(tree(r.sb), r.sb.__tree0, "a file under HOME was created or changed");
};
const assertNoSideEffectCommands = (r) => {
  for (const c of r.sb.sshCalls()) assert.doesNotMatch(c.replace(/[0-9]?>\s*\/dev\/null|[0-9]?>&[0-9]/g, ""), /\btouch\b|\brm\b|\btee\b|>|\.env\b|\bsed -i\b|\bchmod\b|\bkill|crontab|systemctl/, `side-effect or secret-file access in a remote command: ${c}`);
  assert.equal(r.sb.curlCalls().length, 0);
  assert.equal(r.sb.log("local-forbidden.log"), "");
};
const assertNoDerivedVerdict = (r) => {
  const own = r.out.split("\n").filter((l) => l.startsWith("---") || l.startsWith("("));
  assert.ok(own.length >= 5, "the skill labels each section (anti-vacuity)");
  for (const l of own) assert.doesNotMatch(l, /healthy|\bOK\b|\bis up\b|is running|all good/i, `a skill-authored line claims a state: ${l}`);
  assert.doesNotMatch(r.out, /\b(gateway|agent|hermes) (is )?(healthy|online|up and running)\b/i);
};

describe("hermes-status: read-only dashboard", { concurrency: 4 }, () => {
  it("shows the native reports, changes nothing, starts nothing, reads no .env, never calls the helper that starts a gateway", async () => {
    await run({ seed: { env: "NOTION_TOKEN=ntn_super_secret_value_1234567890\n", config: "model.default: x/y\n" }, files: { ".hermes/gateway.state": "running\n" }, setup: seedTree }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(r.completed);
      const calls = argvs(r);
      for (const want of ["status --full", "gateway status", "gateway list", "memory status", "cron list", "sessions stats", "pairing list", "logs gateway -n 30"]) {
        assert.ok(calls.includes(want), `missing ${want}: ${calls.join(" | ")}`);
      }
      assert.ok(calls.some((c) => c.startsWith("sessions list")));
      assert.ok(!calls.some((c) => /^(-z|doctor)\b|--deep/.test(c)), "opt-in checks must not run by default: " + calls.join(" | "));
      assertReadOnly(r);
      assertNoSideEffectCommands(r);
      assert.doesNotMatch(r.out, /ntn_super_secret/);
      assert.deepEqual([...new Set(r.sb.read("logs/hermes-profile.log").split("\n").filter(Boolean))], ["default"]);
    });
  });

  for (const [state, text, status] of [["stopped", "✗ Gateway is not running", "✗ stopped"], ["running", "✓ Gateway is running (PID: 4242)", "✓ running"]]) {
    it(`gateway ${state}: the native text is shown verbatim and the skill derives no verdict from it`, async () => {
      await run({ files: { ".hermes/gateway.state": `${state}\n` }, setup: seedTree }, async (r) => {
        assert.equal(r.code, 0, r.out);
        assert.ok(r.out.includes(text), "gateway status text shown verbatim");
        assert.ok(r.out.includes(status), "status --full row shown verbatim");
        assertNoDerivedVerdict(r);
        assertReadOnly(r);
      });
    });
  }

  it("a stopped gateway is not 'fixed' by looking at it: no ensure/start even though the text says not running", async () => {
    await run({ files: { ".hermes/gateway.state": "stopped\n", ".hermes/gateway.instance": "4\n" }, setup: seedTree }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.equal(r.sb.read(".hermes/gateway.state").trim(), "stopped", "still stopped: the skill started nothing");
      assert.equal(r.sb.read(".hermes/gateway.instance").trim(), "4");
      assert.ok(!argvs(r).some((c) => c.startsWith("gateway ensure") || c.startsWith("gateway restart")));
    });
  });

  it("every report is optional: failing commands are reported with their exit code and the run still completes", async () => {
    const knobs = { "fail.status": true, "fail.logs": true, "fail.sessions": true, "fail.memory": true, "fail.pairing": true, "fail.gateway.status": true };
    await run({ knobs, setup: seedTree }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(r.completed);
      assert.ok((r.out.match(/exited 1/g) || []).length >= 5, "each failure is reported: " + r.out);
      assertReadOnly(r);
    });
  });
});

describe("hermes-status: opt-in checks", { concurrency: 4 }, () => {
  it("DEEP=1 adds status --deep and nothing else", async () => {
    await run({ env: { DEEP: "1" }, setup: seedTree }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(argvs(r).includes("status --deep"));
      assert.ok(!argvs(r).some((c) => c.startsWith("doctor") || c.startsWith("-z")));
      assertReadOnly(r);
    });
  });

  it("RUN_DOCTOR=1 runs plain `doctor` (never --fix, never --live), shows its exit code and keeps going when issues remain", async () => {
    await run({ env: { RUN_DOCTOR: "1" }, knobs: { doctor_issues: "Run 'hermes setup' to configure API keys\n" }, setup: seedTree }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(r.completed);
      assert.ok(argvs(r).includes("doctor"), argvs(r).join(" | "));
      assert.ok(!argvs(r).some((c) => /^doctor .*(--fix|--live|--ack)/.test(c)));
      assert.match(r.out, /doctor exit code: 1/);
      assert.match(r.out, /Found 1 issue\(s\) to address/);
      assertReadOnly(r);
    });
  });

  it("RUN_DOCTOR=1 with a clean report shows exit code 0 and the native line, not a claim of its own", async () => {
    await run({ env: { RUN_DOCTOR: "1" }, setup: seedTree }, async (r) => {
      assert.match(r.out, /doctor exit code: 0/);
      assert.match(r.out, /All checks passed!/);
      assertReadOnly(r);
    });
  });

  it("SMOKE_MODEL=1 makes exactly one `-z` model call with a fixed prompt and prints the reply verbatim (no substring verdict)", async () => {
    await run({ env: { SMOKE_MODEL: "1" }, files: { "infer.out": "There was a token problem, not OK\n" }, setup: seedTree }, async (r) => {
      assert.equal(r.code, 0, r.out);
      const z = r.sb.hermesCalls().filter((c) => (c[0] === "-p" ? c[2] : c[0]) === "-z");
      assert.equal(z.length, 1);
      assert.match(r.out, /There was a token problem, not OK/);
      assert.doesNotMatch(r.out, /end-to-end: OK|smoke (test )?(passed|OK)/i, "a reply containing the letters OK must not become a pass");
      assert.match(r.out, /model|provider/i);
    });
  });
});

describe("hermes-status: gates", { concurrency: 4 }, () => {
  it("a Hermes that is not 0.22.5 aborts before any report", async () => {
    await run({ files: { "hermes.version": "hermes 0.15.2\n" } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /ABORT/);
      assert.ok(!r.completed);
      assert.ok(!argvs(r).some((c) => c.startsWith("status") || c.startsWith("gateway")));
    });
  });
  it("an unreachable VPS aborts before touching anything", async () => {
    await run({ knobs: { ssh_down: true } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /ABORT/);
      assert.equal(r.sb.hermesCalls().length, 0);
    });
  });
});

describe("hermes-status: the text", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const code = loadBlocks(SKILL).map((b) => b.code).join("\n");
  it("none of the retired claims survive", () => {
    assert.doesNotMatch(text, /sqlite \/ postgres \/ qdrant|ceiling|usage vs/i, "`memory status` prints no backend, usage or ceiling");
    assert.doesNotMatch(text, /hermes-status\.ok|\/tmp\//, "no marker file");
    assert.doesNotMatch(text, /RSS\s*>\s*3\s*GB|3 GB/i, "unverified leak threshold");
    assert.doesNotMatch(code, /pgrep|\.env\b|--sort|touch\b/);
    assert.doesNotMatch(text, /gateway → router → model → memory → reply/, "-z does not go through the gateway");
  });
  it("says that status text is informational and which checks change anything", () => {
    assert.match(text, /informational/i);
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /hermes_cli\/status\.py:\d+/);
    assert.match(text, /hermes_cli\/gateway\.py:\d+/);
    assert.match(text, /(not|nothing)[^.\n]*run against a (live|real)/i);
    for (const w of ["RUN_DOCTOR", "SMOKE_MODEL", "DEEP"]) assert.ok(text.includes(w), w);
  });
});

describe("negative controls: each assertion above detects the bug it exists for", () => {
  const MUT = (name, from, to, check, extra = {}) =>
    it(`control: ${name}`, async () => {
      mustReplace({ skill: SKILL, ids: IDS(), replace: [[from, to]] });
      await run({ flow: { replace: [[from, to]] }, setup: seedTree, ...extra }, async (r) => {
        assert.throws(() => check(r), undefined, `${name}: the assertion did not notice the injected bug`);
      });
    });
  const LIST = "remote 'hermes -p default gateway list'";
  MUT("starting a gateway is detected", LIST, `remote 'hermes -p default gateway ensure --json --timeout 5'; ${LIST}`, assertReadOnly);
  MUT("a stray file write is detected", LIST, `remote 'echo x > ~/stray-marker'; ${LIST}`, assertReadOnly);
  MUT("reading .env is detected", LIST, `remote 'cat ~/.hermes/.env'; ${LIST}`, assertNoSideEffectCommands);
  MUT("a skill-authored 'healthy' claim is detected", `echo "--- gateway list`, `echo "--- gateway healthy`, assertNoDerivedVerdict);
  MUT("an unconditional model call is detected", LIST, `remote "hermes -p default -z 'ping'"; ${LIST}`, (r) => {
    assert.ok(!argvs(r).some((c) => c.startsWith("-z")));
  });
});
