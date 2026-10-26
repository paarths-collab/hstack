// hermes-restart: the real SKILL.md blocks, in document order, against a simulated VPS (helpers/sandbox.mjs).
// The hermes stub validates every call against the real v0.22.5 argparse; what a command PRINTS or DOES is an assumption of the stub.
// The skill documents and drives the canonical reload (gw_reload / gw_ready) and must never do what the 0.15-era text did:
// delete pid/lock files, kill processes, probe an HTTP port, call `gateway run --daemon`, or decide health from `gateway status` text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assemble, loadBlocks, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "hermes-restart";
const IDS = () => loadBlocks(SKILL).map((b) => b.id);
const flow = ({ replace = [], before = "" } = {}) =>
  assemble(["set +e\n", before, { skill: SKILL, ids: IDS(), replace }, SCRIPT_END]);
const run = (opts, check) => scenario({ name: "restart", script: flow(opts.flow), ...opts }, check);

const gw = (r) => r.sb.hermesCalls().map((c) => (c[0] === "-p" ? c.slice(2) : c)).filter((c) => c[0] === "gateway").map((c) => c.join(" "));
const SENTINELS = {
  ".hermes/gateway.pid": '{"pid": 4242}\n',
  ".hermes/gateway.lock": "lock-held\n",
  ".local/state/hermes/gateway-locks/abc.lock": "stale-lock\n",
};
const seedSentinels = (sb) => { for (const [f, c] of Object.entries(SENTINELS)) sb.write(f, c); };

// ---- reusable assertions (each is also applied to a deliberately broken script as a negative control) ----
const assertSentinelsIntact = (r) => {
  for (const [f, c] of Object.entries(SENTINELS)) assert.equal(r.sb.read(f), c, `${f} was deleted or changed (the 0.15-era pid/lock sweep)`);
};
const assertNoHttpProbe = (r) => {
  assert.equal(r.sb.curlCalls().length, 0, "the skill probed an HTTP endpoint (the base gateway has no listener; 4000 is not a Hermes port)");
  assert.equal(r.sb.log("local-forbidden.log"), "", "curl/wget ran on the local machine");
  for (const c of r.sb.sshCalls()) assert.doesNotMatch(c, /4000|\/health|curl|wget/, `remote command probes a port: ${c}`);
};
const FORBIDDEN_REMOTE = /\brm\b|pgrep|pkill|\bkill\b|killall|gateway\.pid|gateway-locks|\.lock\b|tmux|nohup|loginctl|systemctl|crontab|\.bashrc|\.env\b/;
const assertNoHandRolledLifecycle = (r) => {
  for (const c of r.sb.sshCalls()) assert.doesNotMatch(c, FORBIDDEN_REMOTE, `hand-rolled lifecycle/side effect in a remote command: ${c}`);
  assert.doesNotMatch(r.sb.log("hermes-argv.log"), /--daemon/);
};
const assertNativeReload = (r) => {
  const calls = gw(r);
  const restart = calls.indexOf("gateway restart --detach");
  assert.ok(restart >= 0, "no `gateway restart --detach`: " + calls.join(" | "));
  assert.ok(calls.slice(restart + 1).some((c) => c.startsWith("gateway ensure --json --timeout")), "no readiness `gateway ensure --json` after the restart");
  assert.ok(!calls.some((c) => /^gateway (stop|run|start)\b/.test(c)), "stop/run/start are not part of the reload: " + calls.join(" | "));
  assert.ok(!calls.some((c) => / -y\b| --yes\b| --force\b| --all\b| --interrupt\b/.test(c)), "interrupt/evasion flags without the operator's say-so: " + calls.join(" | "));
};
const assertNoWrites = (r) => {
  assert.equal(r.after.env, r.before.env);
  assert.equal(r.after.config, r.before.config);
  assert.equal(r.after.crontab, r.before.crontab);
};

describe("hermes-restart: the native reload", { concurrency: 4 }, () => {
  for (const state of ["stopped", "running"]) {
    it(`gateway ${state}: restart --detach, then ensure --json until ready; no stop/run/start, no -y, no state change`, async () => {
      const next = state === "running" ? "inst-8" : "inst-9"; // stopped: gw_reload's pre-read starts one (8), the restart replaces it (9)
      await run({ files: { ".hermes/gateway.state": `${state}\n`, ".hermes/gateway.instance": "7\n" }, setup: seedSentinels }, async (r) => {
        assert.equal(r.code, 0, r.out);
        assert.ok(r.completed);
        assertNativeReload(r);
        assert.match(r.out, /"state":"ready"/);
        assert.ok(r.out.includes(`"instance_id":"${next}"`), `a NEW instance id is reported (7 -> ${next})`);
        assertSentinelsIntact(r);
        assertNoHttpProbe(r);
        assertNoHandRolledLifecycle(r);
        assertNoWrites(r);
        assert.deepEqual([...new Set(r.sb.read("logs/hermes-profile.log").split("\n").filter(Boolean))], ["default"], "every hermes call is bound to -p default");
      });
    });
  }

  it("the text of `gateway status` never decides anything: 'not running' and 'running' lines lead to the same restart", async () => {
    for (const [state, text] of [["running", "✗ Gateway is not running\n"], ["stopped", "✓ Gateway is running (PID: 4242)\n"]]) {
      await run({ files: { ".hermes/gateway.state": `${state}\n`, ".hermes/gateway.instance": "3\n" }, knobs: { status_override: text } }, async (r) => {
        assert.equal(r.code, 0, r.out);
        assertNativeReload(r);
        assert.ok(r.out.includes(state === "running" ? '"instance_id":"inst-4"' : '"instance_id":"inst-5"'));
        assert.ok(r.out.includes(text.trim()), "the status text is shown verbatim as information");
      });
    }
  });

  it("a gateway that was already healthy is still restarted when the operator asked for a reload (no 'already healthy' skip)", async () => {
    await run({ files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "1\n" }, env: { FORCE: undefined } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assertNativeReload(r);
      assert.doesNotMatch(r.out, /already healthy/i);
    });
  });
});

describe("hermes-restart: refusals are read, not evaded", { concurrency: 4 }, () => {
  it("live sessions: the refusal stops the run (exit 1), nothing is interrupted, no -y, nothing deleted", async () => {
    await run({ files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "5\n" }, knobs: { live_sessions: true }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.ok(!r.completed);
      assert.match(r.out, /refus|live session/i);
      assert.match(r.out, /GW_INTERRUPT=1/, "tells the operator how to interrupt deliberately");
      assert.ok(!gw(r).some((c) => / -y\b| --yes\b| --interrupt\b| --force\b| --all\b/.test(c)), gw(r).join(" | "));
      assert.ok(!gw(r).some((c) => /^gateway (stop|run|start)\b/.test(c)));
      assert.equal(r.sb.read(".hermes/gateway.instance").trim(), "5", "the gateway was not restarted");
      assertSentinelsIntact(r);
      assertNoHandRolledLifecycle(r);
    });
  });

  it("GW_INTERRUPT=1 is the only way to interrupt: restart --detach -y, then ready with a new instance", async () => {
    await run({ files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "5\n" }, knobs: { live_sessions: true }, env: { GW_INTERRUPT: "1" }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(gw(r).includes("gateway restart --detach -y"), gw(r).join(" | "));
      assert.match(r.out, /"instance_id":"inst-6"/);
      assertSentinelsIntact(r);
    });
  });

  it("a restart that exits 0 but changes nothing (same instance_id) is a failure", async () => {
    await run({ files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "5\n" }, knobs: { restart_noop: true }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.ok(!r.completed);
      assert.match(r.out, /instance did not change|did not restart/i);
      assertSentinelsIntact(r);
      assertNoHandRolledLifecycle(r);
    });
  });

  for (const [code, label] of [[5, "deadline"], [6, "draining / update paused"], [3, "incompatible"], [4, "authorization"], [7, "conflicting supervisor"]]) {
    it(`gateway ensure exit ${code} (${label}): reported with its JSON, diagnosed read-only, exit 1, never a success`, async () => {
      await run({ files: { ".hermes/gateway.state": "stopped\n" }, knobs: { ensure_exit: String(code) }, setup: seedSentinels }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.ok(!r.completed);
        assert.doesNotMatch(r.out, /^\{[^\n]*"state":"ready"[^\n]*\}$/m, "no ready JSON line");
        assert.match(r.out, /"reason_code":"/, "the ensure JSON (reason_code) is shown to the operator");
        // read-only diagnosis: status text for display + the gateway log
        const calls = r.sb.hermesCalls().map((c) => (c[0] === "-p" ? c.slice(2) : c).join(" "));
        assert.ok(calls.includes("gateway status"), calls.join(" | "));
        assert.ok(calls.some((c) => c.startsWith("logs gateway")), calls.join(" | "));
        assert.ok(!calls.some((c) => /^gateway (stop|run|start)\b/.test(c)));
        assertSentinelsIntact(r);
        assertNoHandRolledLifecycle(r);
        assertNoHttpProbe(r);
      });
    });
  }

  it("a failing `gateway restart` itself is a failure that diagnoses and stops (no stop/run fallback)", async () => {
    await run({ files: { ".hermes/gateway.state": "running\n" }, knobs: { "fail.gateway.restart": true }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.ok(!r.completed);
      assert.ok(gw(r).includes("gateway restart --detach"), "the native restart was attempted: " + gw(r).join(" | "));
      assert.ok(!gw(r).some((c) => /^gateway (stop|run|start)\b/.test(c)), gw(r).join(" | "));
      assertSentinelsIntact(r);
    });
  });
});

describe("hermes-restart: gates", { concurrency: 4 }, () => {
  it("a Hermes that is not 0.22.5 aborts before any gateway command", async () => {
    await run({ files: { "hermes.version": "hermes 0.15.2\n" } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /ABORT/);
      assert.ok(!r.completed);
      assert.equal(gw(r).length, 0, gw(r).join(" | "));
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

describe("hermes-restart: consent-gated persistent service", { concurrency: 4 }, () => {
  it("without INSTALL_SERVICE=1 no service is ever installed", async () => {
    await run({ files: { ".hermes/gateway.state": "running\n" } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(!gw(r).some((c) => c.startsWith("gateway install")), gw(r).join(" | "));
    });
  });

  it("INSTALL_SERVICE=1: `gateway install --if-missing --no-start-now` first, then the native reload starts it", async () => {
    await run({ files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "2\n" }, env: { INSTALL_SERVICE: "1" } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      const calls = gw(r);
      const install = calls.indexOf("gateway install --if-missing --no-start-now");
      assert.ok(install >= 0, calls.join(" | "));
      assert.ok(install < calls.indexOf("gateway restart --detach"), "the service exists before the reload");
      assert.ok(!calls.some((c) => /--system|--run-as-user|--force/.test(c)), "no system-level or forced install");
      assertNativeReload(r);
    });
  });
});

describe("hermes-restart: the text no longer teaches the retired recipe", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const code = loadBlocks(SKILL).map((b) => b.code).join("\n");
  it("no pid/lock sweep, pgrep/pkill, port 4000, /health, gateway run, --daemon, tmux/nohup autostart in any block", () => {
    assert.doesNotMatch(code, /\brm\b|pgrep|pkill|gateway\.pid|gateway-locks|\b4000\b|\/health|gateway run|--daemon|tmux|nohup|loginctl|systemctl/);
  });
  it("states what was verified and what was not", () => {
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /hermes_cli\/gateway\.py:\d+/);
    assert.match(text, /hermes_cli\/gateway_lifecycle_guards\.py:\d+/);
    assert.match(text, /(not|nothing)[^.\n]*run against a (live|real)/i);
  });
  it("explains the refusal guidance for --all / --force / gateway list / migrate-legacy and GW_INTERRUPT", () => {
    for (const w of ["GW_INTERRUPT", "--all", "--force", "gateway list", "migrate-legacy", "78"]) assert.ok(text.includes(w), `missing guidance: ${w}`);
  });
});

describe("negative controls: each assertion above detects the bug it exists for", () => {
  const ANCHOR = "gw_reload || RELOAD_FAILED=1";
  const MUT = (name, from, to, check) =>
    it(`control: ${name}`, async () => {
      mustReplace({ skill: SKILL, ids: IDS(), replace: [[from, to]] });
      await run({ files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "1\n" }, flow: { replace: [[from, to]] }, setup: seedSentinels }, async (r) => {
        assert.throws(() => check(r), undefined, `${name}: the assertion did not notice the injected bug`);
      });
    });
  MUT("a pid/lock sweep is detected", ANCHOR, `remote 'rm -f ~/.hermes/gateway.pid ~/.local/state/hermes/gateway-locks/*.lock'; ${ANCHOR}`, assertSentinelsIntact);
  MUT("a port-4000 health probe is detected", ANCHOR, `remote 'curl -sS http://127.0.0.1:4000/health'; ${ANCHOR}`, assertNoHttpProbe);
  MUT("a stop+ensure reload is detected", ANCHOR, `remote 'hermes -p default gateway stop'; remote 'hermes -p default gateway ensure --json --timeout 60' || RELOAD_FAILED=1`, assertNativeReload);
  MUT("an unconditional -y is detected", ANCHOR, `remote 'hermes -p default gateway restart --detach -y'; gw_ready || RELOAD_FAILED=1`, assertNativeReload);
  MUT("a pkill is detected", ANCHOR, `remote 'pkill -f hermes'; ${ANCHOR}`, assertNoHandRolledLifecycle);
});
