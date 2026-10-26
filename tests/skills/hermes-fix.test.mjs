// hermes-fix: the real SKILL.md blocks, in document order, against a simulated VPS (helpers/sandbox.mjs).
// The skill diagnoses with `hermes doctor` (non-zero when issues remain at v0.22.5), repairs only with consent (`doctor --fix` edits .env,
// config.yaml and can repair state.db), reloads only through the native lifecycle, and must never schedule a nightly gateway outage
// (no crontab write), delete pid/lock files, grep `gateway status` for health, or write a secret through argv.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, idx } from "./helpers/asserts.mjs";
import { assemble, loadBlocks, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

const SKILL = "hermes-fix";
// The Rollback section's block ("undo a finished run") is an operator action, not part of the flow.
const IDS = () => loadBlocks(SKILL).map((b) => b.id).filter((id) => id !== "rollback#1");
const flow = ({ replace = [] } = {}) => assemble(["set +e\n", { skill: SKILL, ids: IDS(), replace }, SCRIPT_END]);
const run = (opts, check) => scenario({ name: "fix", script: flow(opts.flow), ...opts }, check);

const argvs = (r) => r.sb.hermesCalls().map((c) => (c[0] === "-p" ? c.slice(2) : c).join(" "));
const gw = (r) => argvs(r).filter((c) => c.startsWith("gateway"));
const SENTINELS = { ".hermes/gateway.pid": '{"pid": 4242}\n', ".local/state/hermes/gateway-locks/a.lock": "lock\n" };
const seedSentinels = (sb) => { for (const [f, c] of Object.entries(SENTINELS)) sb.write(f, c); };

const BASE_ENV = "OPENROUTER_API_KEY=keep-me-1\nHERMES_MAX_ITERATIONS=90\nOTHER=keep\n";
const BASE_CFG = "model.default: some/model\nagent.max_turns: 400\n";
const SEED = { env: BASE_ENV, config: BASE_CFG };
const ISSUES = "fixable:max_iterations\n";

// ---- reusable assertions (each also runs against a deliberately broken script as a negative control) ----
const assertNoScheduledOutage = (r) => {
  assert.equal(r.after.crontab, r.before.crontab, "crontab changed");
  for (const c of r.sb.sshCalls()) assert.doesNotMatch(c, /crontab|\bcron\b.*gateway|systemctl|--daemon/, `scheduling or supervisor call: ${c}`);
  assert.ok(!argvs(r).some((c) => /^cron (create|add)/.test(c)), "a hermes cron job was created");
};
const assertNoHandRolled = (r) => {
  for (const c of r.sb.sshCalls()) assert.doesNotMatch(c, /\brm\b|pgrep|pkill|\bkill\b|gateway\.pid|gateway-locks|\.lock\b|tmux|nohup|\b4000\b|\/health/, `hand-rolled lifecycle in: ${c}`);
  assert.ok(!gw(r).some((c) => /^gateway (stop|run|start)\b/.test(c)), gw(r).join(" | "));
  assert.doesNotMatch(r.sb.log("hermes-argv.log"), /--daemon/);
  for (const [f, c] of Object.entries(SENTINELS)) assert.equal(r.sb.read(f), c, `${f} was deleted or changed`);
  assert.equal(r.sb.curlCalls().length, 0);
};
// Without consent (and with a private .env) the skill must not even take a backup or a snapshot: those only prepare a repair that was never approved.
const assertNoBackupOrSnapshot = (r) => {
  assert.ok(!argvs(r).some((c) => /^backup\b/.test(c)), "a native backup ran without consent: " + argvs(r).join(" | "));
  assert.ok(!r.sb.exists(".hermes/.hstack-backup"), "a snapshot directory was created without consent");
  assert.deepEqual(r.sb.ls(".hermes").filter((f) => /backup|snapshot/i.test(f)), []);
};
const assertNoFix = (r) => {
  assert.ok(!argvs(r).some((c) => /^doctor .*--fix/.test(c)), "doctor --fix ran without consent: " + argvs(r).join(" | "));
  assert.ok(!r.sb.exists("state/state-db-repaired"));
};

describe("hermes-fix: diagnosis is read-only and doctor --fix needs its own consent", { concurrency: 4 }, () => {
  it("issues found, no ALLOW_DOCTOR_FIX (AUTO_APPROVE=1 is not consent for --fix): plain doctor only, nothing written, nothing reloaded", async () => {
    await run({ seed: SEED, knobs: { doctor_issues: ISSUES, doctor_state_db: true }, files: { ".hermes/gateway.state": "running\n" }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assertNoFix(r);
      assert.ok(argvs(r).includes("doctor"), argvs(r).join(" | "));
      assertStateIdentical(r, "no consent, no change");
      assertNoBackupOrSnapshot(r);
      assert.deepEqual(gw(r).filter((c) => /^gateway (restart|ensure)/.test(c)), [], "no reload without a change");
      assert.match(r.out, /ALLOW_DOCTOR_FIX=1/, "tells the operator how to consent");
      assert.match(r.out, /Found 1 issue\(s\) to address/, "doctor's own report is shown");
      assertNoHandRolled(r);
    });
  });

  it("doctor exits 0 and no symptom: nothing to fix, exit 0, the gateway text is shown but never called healthy and nothing is started", async () => {
    await run({ seed: SEED, files: { ".hermes/gateway.state": "stopped\n", ".hermes/gateway.instance": "3\n" } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(!r.completed, "the idempotent exit ends the run");
      assert.match(r.out, /All checks passed!/);
      assert.ok(r.out.includes("✗ Gateway is not running"), "informational status text shown verbatim");
      assert.doesNotMatch(r.out, /\bhealthy\b|already healthy/i);
      assert.match(r.out, /does not (check|cover|test)[^\n]*gateway|SYMPTOM/i, "says doctor does not cover whether the gateway runs");
      assert.equal(r.sb.read(".hermes/gateway.state").trim(), "stopped");
      assert.deepEqual(gw(r).filter((c) => /^gateway (restart|ensure|stop|run|start)/.test(c)), []);
      assertStateIdentical(r);
    });
  });
});

describe("hermes-fix: consented repair", { concurrency: 4 }, () => {
  it("ALLOW_DOCTOR_FIX=1: native quick backup, snapshot, doctor --fix, reload through gw_reload, verify with doctor, finish; env keeps mode 600", async () => {
    await run({ seed: SEED, env: { ALLOW_DOCTOR_FIX: "1" }, knobs: { doctor_issues: ISSUES }, files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "1\n" }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(r.completed);
      const ev = r.sb.events();
      const backup = idx(ev, /^hermes backup/);
      const fix = idx(ev, /^hermes doctor --fix/);
      const restart = idx(ev, /^hermes gateway restart/);
      const verify = idx(ev, /^hermes doctor$/, fix);
      assert.ok(backup >= 0 && backup < fix, "the native quick snapshot precedes the repair");
      assert.ok(fix < restart && restart < verify, `order backup < fix < restart < verify: ${ev.join(" | ")}`);
      assert.ok(argvs(r).some((c) => c === "backup --quick --label hermes-fix" || c === "backup -q -l hermes-fix"), argvs(r).join(" | "));
      assert.ok(r.sb.exists(".hermes/.hstack-backup/hermes-fix.prev"), "finish retired the snapshot to .prev");
      assert.ok(!r.sb.read(".hermes/.env").includes("HERMES_MAX_ITERATIONS"), "doctor's repair landed");
      assert.match(r.sb.read(".hermes/.env"), /^OPENROUTER_API_KEY=keep-me-1$/m);
      assert.equal(r.sb.mode(".hermes/.env"), 0o600);
      assertStateChanged(r);
      assert.ok(gw(r).includes("gateway restart --detach"), gw(r).join(" | "));
      assert.match(r.out, /"instance_id":"inst-2"/);
      assertNoHandRolled(r);
      assertNoScheduledOutage(r);
    });
  });

  it("the dry run says that doctor --fix is not limited to .env/config.yaml (state.db repair, WAL checkpoint)", async () => {
    await run({ seed: SEED, env: { ALLOW_DOCTOR_FIX: "1" }, knobs: { doctor_issues: ISSUES, doctor_state_db: true }, files: { ".hermes/gateway.state": "running\n" } }, async (r) => {
      assert.match(r.out, /state\.db/);
      assert.ok(r.sb.exists("state/state-db-repaired"), "the stub's state.db repair ran only because the operator consented");
    });
  });

  it("the reload fails after the repair: rollback restores .env and config.yaml byte for byte and the run fails", async () => {
    await run({ seed: SEED, env: { ALLOW_DOCTOR_FIX: "1" }, knobs: { doctor_issues: ISSUES, "fail.gateway.restart": true }, files: { ".hermes/gateway.state": "running\n" }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.ok(!r.completed);
      assertStateIdentical(r, "rollback restored the pre-fix files");
      assert.equal(r.sb.mode(".hermes/.env"), 0o600);
      assert.match(r.out, /rollback|restored/i);
      assertNoHandRolled(r);
      assertNoScheduledOutage(r);
    });
  });

  it("a world-readable .env is tightened to 600 (approved dry run) without doctor --fix and without a reload", async () => {
    await run({ seed: { ...SEED, envMode: 0o644 }, setup: seedSentinels, files: { ".hermes/gateway.state": "running\n" } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.equal(r.sb.mode(".hermes/.env"), 0o600);
      assertNoFix(r);
      assert.equal(r.after.env, r.before.env, "content unchanged: only the mode moved");
      assert.deepEqual(gw(r).filter((c) => /^gateway (restart|ensure)/.test(c)), [], "a mode change needs no reload");
      assert.ok(r.sb.exists(".hermes/.hstack-backup/hermes-fix.prev"));
    });
  });
});

describe("hermes-fix: symptoms", { concurrency: 4 }, () => {
  it("gateway-down: ensure is the fix (no stop/run/rm), the result is the ready JSON", async () => {
    await run({ seed: SEED, env: { SYMPTOM: "gateway-down" }, files: { ".hermes/gateway.state": "stopped\n", ".hermes/gateway.instance": "3\n" }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.equal(r.sb.read(".hermes/gateway.state").trim(), "running");
      assert.ok(gw(r).some((c) => c.startsWith("gateway ensure --json")));
      assert.match(r.out, /"state":"ready"/);
      assertNoHandRolled(r);
      assertNoScheduledOutage(r);
    });
  });

  it("gateway-down but ensure answers 5 (deadline): the JSON and the gateway log are shown, exit 1, nothing deleted or killed", async () => {
    await run({ seed: SEED, env: { SYMPTOM: "gateway-down" }, knobs: { ensure_exit: "5" }, files: { ".hermes/gateway.state": "stopped\n" }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /"reason_code":"deadline"/);
      assert.ok(argvs(r).some((c) => c.startsWith("logs gateway")));
      assertNoHandRolled(r);
    });
  });

  it("wedged: the native reload; live sessions are reported, never overridden without GW_INTERRUPT=1", async () => {
    await run({ seed: SEED, env: { SYMPTOM: "wedged" }, knobs: { live_sessions: true }, files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "5\n" }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.ok(gw(r).includes("gateway restart --detach"), gw(r).join(" | "));
      assert.ok(!gw(r).some((c) => / -y\b| --force\b| --all\b/.test(c)));
      assert.match(r.out, /GW_INTERRUPT=1/);
      assertStateIdentical(r);
      assertNoHandRolled(r);
    });
    await run({ seed: SEED, env: { SYMPTOM: "wedged", GW_INTERRUPT: "1" }, knobs: { live_sessions: true }, files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "5\n" } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(gw(r).includes("gateway restart --detach -y"));
    });
  });

  it("bot-silent: reads the gateway log and `pairing list` only; approving someone is never automatic", async () => {
    await run({ seed: SEED, env: { SYMPTOM: "bot-silent" }, files: { ".hermes/gateway.state": "running\n", "pairing.out": "\n  Pending Pairing Requests (1):\n  telegram     abc123def456       777                  alice                3m ago\n" }, setup: seedSentinels }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(argvs(r).includes("pairing list"));
      assert.ok(argvs(r).some((c) => c.startsWith("logs gateway")));
      assert.ok(!argvs(r).some((c) => /^pairing (approve|revoke|clear-pending)/.test(c)));
      assert.match(r.out, /Pending Pairing Requests/);
      assert.match(r.out, /pairing approve/, "the approval command is explained, not run");
      assertStateIdentical(r);
    });
  });

  it("oom: no crontab, no nightly outage, no gateway stop/run; it reports what native supervision gives and why the cron was removed", async () => {
    await run({ seed: SEED, env: { SYMPTOM: "oom" }, setup: (sb) => { sb.write("crontab.store", "# existing\n17 3 * * * /usr/local/bin/backup.sh\n"); seedSentinels(sb); }, files: { ".hermes/gateway.state": "running\n" } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assertNoScheduledOutage(r);
      assertNoHandRolled(r);
      assert.match(r.out, /Restart=always|supervis/i);
      assert.match(r.out, /nightly|cron/i);
      assert.equal(r.sb.read("crontab.store"), "# existing\n17 3 * * * /usr/local/bin/backup.sh\n");
    });
  });
});

describe("hermes-fix: a missing tool key (the only secret this skill writes)", { concurrency: 4 }, () => {
  const KEY = fake.deepseek("K");
  const base = { seed: SEED, setup: seedSentinels, knobs: { doctor_issues: "web search (provider not configured) (missing TAVILY_API_KEY)\n" }, files: { ".hermes/gateway.state": "running\n", ".hermes/gateway.instance": "1\n" } };

  it("written over stdin with `config set`, chmod 600, reload, `doctor --live` to look at the backend, finish; never in argv or output", async () => {
    await run({ ...base, env: { SYMPTOM: "tools", NEW_KEY_NAME: "TAVILY_API_KEY", NEW_KEY_VALUE: KEY } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(r.completed);
      assert.match(r.sb.read(".hermes/.env"), new RegExp(`^TAVILY_API_KEY=${KEY}$`, "m"));
      assert.match(r.sb.read(".hermes/.env"), /^OPENROUTER_API_KEY=keep-me-1$/m, "other keys untouched");
      assert.equal(r.sb.mode(".hermes/.env"), 0o600);
      assert.ok(!r.sb.read(".hermes/config.yaml").includes(KEY));
      assert.ok(argvs(r).includes("doctor --live"));
      assert.ok(r.sb.exists(".hermes/.hstack-backup/hermes-fix.prev"));
      assertNoSecretInArgv(r, [KEY]);
      assertSecretsNotPrinted(r, [KEY]);
      assertNoHandRolled(r);
    });
  });

  for (const [label, name, value] of [["lower-case name", "tavily_api_key", KEY], ["name with a space", "TAVILY API", KEY], ["value with whitespace", "TAVILY_API_KEY", "abc def ghi jkl"], ["empty value", "TAVILY_API_KEY", ""]]) {
    it(`rejects ${label} before the snapshot: nothing written`, async () => {
      await run({ ...base, env: { SYMPTOM: "tools", NEW_KEY_NAME: name, NEW_KEY_VALUE: value } }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /ABORT/);
        assertStateIdentical(r);
        assert.ok(!r.sb.exists(".hermes/.hstack-backup/hermes-fix"));
      });
    });
  }

  it("a name that the doctor report did not list as missing is refused (the skill does not invent keys)", async () => {
    await run({ ...base, env: { SYMPTOM: "tools", NEW_KEY_NAME: "SOME_OTHER_API_KEY", NEW_KEY_VALUE: KEY } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /ABORT/);
      assertStateIdentical(r);
    });
  });

  it("the write fails: rollback restores the previous files", async () => {
    await run({ ...base, knobs: { ...base.knobs, "fail.set.TAVILY_API_KEY": true }, env: { SYMPTOM: "tools", NEW_KEY_NAME: "TAVILY_API_KEY", NEW_KEY_VALUE: KEY } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assertStateIdentical(r);
      assertSecretsNotPrinted(r, [KEY]);
    });
  });
});

describe("hermes-fix: gates", { concurrency: 4 }, () => {
  it("a Hermes that is not 0.22.5 aborts before any diagnosis", async () => {
    await run({ files: { "hermes.version": "hermes 0.15.2\n" }, seed: SEED }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /ABORT/);
      assert.ok(!argvs(r).some((c) => c.startsWith("doctor")));
      assertStateIdentical(r);
    });
  });
  it("an unreachable VPS aborts first", async () => {
    await run({ knobs: { ssh_down: true } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.equal(r.sb.hermesCalls().length, 0);
    });
  });
});

describe("hermes-fix: the text", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const code = loadBlocks(SKILL).map((b) => b.code).join("\n");
  it("no crontab, no pid/lock sweep, no run --daemon, no .env HERMES_UID advice, no status-text health grep in any block", () => {
    assert.doesNotMatch(code, /\|\s*crontab\b|\bcrontab\s+-|\brm -f ~\/\.hermes|gateway\.pid|gateway-locks|gateway run|--daemon|HERMES_UID|HERMES_GID|v2026\.4\.23|\.bashrc.*echo|echo .*>> *~\/\.hermes\/\.env/);
    assert.doesNotMatch(code, /sed -i/);
  });
  it("states the facts the old text got wrong", () => {
    assert.match(text, /exit(s)? (status )?(is )?(non-zero|1)[^\n]*(issues|doctor)|doctor[^\n]*(exit|non-zero)/i);
    assert.match(text, /lifecycle_guard\.py:\d+/, "native cron refuses gateway restart/stop jobs");
    assert.match(text, /doctor_config\.py:\d+/);
    assert.match(text, /docker run -e HERMES_UID/, "the Docker UID fix is a container-creation setting");
    assert.doesNotMatch(text, /restart does not (reliably )?re-?read/i);
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /(not|nothing)[^.\n]*run against a (live|real)/i);
  });
});

describe("negative controls: each assertion above detects the bug it exists for", () => {
  const MUT = (name, from, to, check, opts = {}) =>
    it(`control: ${name}`, async () => {
      mustReplace({ skill: SKILL, ids: IDS(), replace: [[from, to]] });
      await run({ seed: SEED, knobs: { doctor_issues: ISSUES }, files: { ".hermes/gateway.state": "running\n" }, setup: (sb) => { sb.write("crontab.store", "# c\n"); seedSentinels(sb); }, flow: { replace: [[from, to]] }, ...opts }, async (r) => {
        assert.throws(() => check(r), undefined, `${name}: the assertion did not notice the injected bug`);
      });
    });
  const DIAG = "echo \"--- diagnose";
  MUT("a nightly crontab is detected", DIAG, `remote 'printf "0 4 * * * hermes gateway stop\\n" | crontab -'; ${DIAG}`, assertNoScheduledOutage);
  MUT("a pid sweep is detected", DIAG, `remote 'rm -f ~/.hermes/gateway.pid'; ${DIAG}`, assertNoHandRolled);
  MUT("an unconsented doctor --fix is detected", DIAG, `remote 'hermes -p default doctor --fix'; ${DIAG}`, assertNoFix);
  MUT("a backup/snapshot without ALLOW_DOCTOR_FIX consent is detected", '[ "${ALLOW_DOCTOR_FIX:-0}" = "1" ] && [ "$DOCTOR_RC" != "0" ] && NEED_WRITE=1', '[ "$DOCTOR_RC" != "0" ] && NEED_WRITE=1', assertNoBackupOrSnapshot);
  MUT("a gateway stop is detected", DIAG, `remote 'hermes -p default gateway stop'; ${DIAG}`, assertNoHandRolled);
});
