// hermes-update: version gate, inspection, the explicit native backup before the update (and no redundant `--backup`), post-update checks
// (pm doctor gates, hermes doctor is reported, gateway readiness only when expected) and the honest "moved past 0.22.5" outcome.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { assertStateIdentical } from "./helpers/asserts.mjs";
import { REPO_ROOT, assemble, loadBlocks } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "hermes-update";
const seed = { env: "PUBLIC_FIXTURE=keep\n", config: "model.default: prior/model\n" };
const env = { HERMES_VERSION: "0.22.5", ALLOW_STABLE_UPDATE: "1" };
const run = (...ids) => assemble(["set +e\n", { skill: SKILL, ids }, SCRIPT_END]);
const sourceInstall = (sb) => sb.write(".hermes/hermes-agent/.git/fixture", "present");
const calls = (r) => r.sb.hermesCalls().map((c) => c.join(" "));
const artifacts = (r) => readdirSync(r.sb.home).filter((f) => /^hermes-backup-hstack-pre-update-.*\.zip$/.test(f));

describe("hermes-update: Step 0 version gate", { concurrency: 6 }, () => {
  for (const v of ["0.15.2", "0.21.6", "0.23.0", "10.22.5", "0.22.50"]) {
    it(`refuses HERMES_VERSION=${v} before contacting the target`, async () => {
      await scenario({ name: "upd-ver", seed, script: run("step0#1"), env: { ...env, HERMES_VERSION: v } }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /ABORT: .*0\.22\.5/);
        assert.equal(r.sb.sshCalls().length, 0);
        assertStateIdentical(r);
      });
    });
  }
  it("accepts an unset or exact HERMES_VERSION; there is no CANDIDATE_ACKNOWLEDGED opt-in", async () => {
    for (const e of [{ ...env, HERMES_VERSION: undefined }, env]) {
      await scenario({ name: "upd-ver-ok", seed, script: run("step0#1"), env: e }, async (r) => {
        assert.equal(r.code, 0, r.out);
        assert.doesNotMatch(r.out, /CANDIDATE|candidate/);
      });
    }
  });
});

describe("hermes-update: Step 1 inspection (nothing is written)", { concurrency: 6 }, () => {
  const step1 = run("step0#1", "step1#1");

  it("reads the version, the plan and the check, in that order, and changes nothing", async () => {
    await scenario({ name: "upd-insp", seed, script: step1, env, setup: sourceInstall }, async (r) => {
      assert.equal(r.code, 0, r.out);
      const c = calls(r);
      assert.deepEqual(c.filter((x) => /^(--version|update)/.test(x)), ["--version", "update --plan", "update --channel stable --check"]);
      assert.ok(!r.sb.log("hermes-profile.log").includes("unbound"));
      assert.ok(!r.sb.exists("state/update.ran"), "no update ran");
      assertStateIdentical(r);
    });
  });

  for (const banner of ["Hermes Agent v0.21.6 (2026.9.1)", "hermes 0.15.2", "Hermes Agent v0.22.50", "Hermes Agent v0.23.0"]) {
    it(`a ${JSON.stringify(banner)} banner is refused before the plan is even requested`, async () => {
      await scenario({ name: "upd-banner", seed, script: step1, env, setup: (sb) => { sourceInstall(sb); sb.write("hermes.version", `${banner}\n`); } }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /FROM Hermes 0\.22\.5/);
        assert.match(r.out, /ABORT: native updater inspection failed/);
        assert.ok(!calls(r).some((x) => x.startsWith("update")));
        assertStateIdentical(r);
      });
    });
  }

  it("a non-source installation (no checkout) is not updated by this recipe", async () => {
    await scenario({ name: "upd-nosrc", seed, script: step1, env }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /default POSIX source installation/);
      assert.ok(!calls(r).some((x) => x.startsWith("update")));
    });
  });

  it("a check that cannot fetch aborts without any fallback (no pip, no reinstall, no fabricated rollback)", async () => {
    await scenario({ name: "upd-nofetch", seed, script: step1, env, knobs: { "fail.update.check": true }, setup: sourceInstall }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /native updater inspection failed/);
      assert.ok(!r.out.includes("Rolled back"));
      assertStateIdentical(r);
    });
  });

  it("an image/package-managed install (admission refusal, exit 2) stops here", async () => {
    await scenario({ name: "upd-managed", seed, script: step1, env, knobs: { update_refused: true }, setup: sourceInstall }, async (r) => {
      // --plan is read-only and runs before the refusal gate, but --check then reports the refusal
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /native updater inspection failed/);
    });
  });
});

describe("hermes-update: Step 2 authorization", () => {
  it("applying needs ALLOW_STABLE_UPDATE=1; nothing runs without it", async () => {
    const script = run("step0#1", "step2#1", "step3#1");
    await scenario({ name: "upd-gate", seed, script, env: { ...env, ALLOW_STABLE_UPDATE: undefined }, setup: sourceInstall }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /ALLOW_STABLE_UPDATE=1/);
      assert.ok(!calls(r).some((x) => x.startsWith("update") || x.startsWith("backup")));
      assert.equal(artifacts(r).length, 0);
      assertStateIdentical(r);
    });
  });
});

describe("hermes-update: Step 3 backup, then update", { concurrency: 6 }, () => {
  const step3 = run("step0#1", "step2#1", "step3#1");

  it("takes a native full backup first (outside ~/.hermes, mode 600, --keep 0), then runs update --channel stable --yes WITHOUT --backup", async () => {
    await scenario({ name: "upd-run", seed, script: step3, env, setup: sourceInstall }, async (r) => {
      assert.equal(r.code, 0, r.out);
      const arts = artifacts(r);
      assert.equal(arts.length, 1, r.sb.ls(".").join(","));
      assert.equal(r.sb.mode(arts[0]), 0o600);
      assert.ok(r.sb.exists(`${arts[0]}.version`));
      assert.match(r.out, /Recovery artifact: .*hermes-backup-hstack-pre-update-.*\.zip/);
      const c = calls(r);
      const iBackup = c.findIndex((x) => x.startsWith("backup "));
      const iUpdate = c.findIndex((x) => x.startsWith("update ") && !/--check|--plan/.test(x));
      assert.ok(iBackup >= 0 && iUpdate > iBackup, c.join(" | "));
      assert.match(c[iBackup], /^backup --output \S*\/hermes-backup-hstack-pre-update-\S+\.zip --keep 0$/);
      assert.equal(c[iUpdate], "update --channel stable --yes");
      assert.equal(r.sb.read("state/update.ran").trim(), "--channel stable --yes");
      assert.ok(!c.some((x) => /^update .*--backup|^update .*--force|--set-channel|--no-backup|--branch/.test(x)), "no redundant or overriding update flags");
      assert.ok(!c.some((x) => x.startsWith("gateway")), "the updater restarts the fleet itself; this step runs no gateway command");
      assert.ok(!r.sb.exists(".hermes/.hstack-backup"), "the artifact is not nested in the tree it archives");
    });
  });

  it("a backup that fails or is incomplete stops BEFORE the update (nothing is upgraded without a recovery artifact)", async () => {
    for (const knob of ["backup_incomplete", "fail.backup"]) {
      await scenario({ name: "upd-nobackup", seed, script: step3, env, knobs: { [knob]: true }, setup: sourceInstall }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /FAIL: update not confirmed/);
        assert.ok(!calls(r).some((x) => x.startsWith("update ") && !/--check|--plan/.test(x)), calls(r).join(" | "));
        assert.equal(r.sb.read("state/update.ran"), null);
        assertStateIdentical(r);
      });
    }
  });

  it("the updater's own pre-update snapshot failing is best-effort upstream and does not stop an update that already has the explicit artifact", async () => {
    await scenario({ name: "upd-snapfail", seed, script: step3, env, knobs: { update_backup_fail: true }, setup: sourceInstall }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Pre-update snapshot FAILED/);
      assert.equal(artifacts(r).length, 1);
    });
  });

  it("an updater failure keeps the artifact path on screen and reports FAIL; no downgrade is attempted", async () => {
    await scenario({ name: "upd-fail", seed, script: step3, env, knobs: { "fail.update": true }, setup: sourceInstall }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /Recovery artifact: /);
      assert.match(r.out, /FAIL: update not confirmed/);
      assert.equal(artifacts(r).length, 1);
      assert.ok(!calls(r).some((x) => /import|restore|pip|^update .*--version/.test(x)));
    });
  });
});

describe("hermes-update: post-update verification", { concurrency: 6 }, () => {
  const after = run("step0#1", "step2#1", "step3#1", "step3#2");
  const bumped = "Hermes Agent v0.22.6 (2026.11.1)\n";

  it("same version after the update: says so, pm doctor passes, gateway readiness is NOT probed unless expected", async () => {
    await scenario({ name: "upd-same", seed, script: after, env, setup: sourceInstall }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Still Hermes 0\.22\.5/);
      assert.match(r.out, /Gateway readiness not checked/);
      assert.ok(calls(r).includes("pm doctor"));
      assert.ok(!calls(r).some((x) => x.startsWith("gateway")), "ensure would start a gateway that was stopped on purpose");
      assert.equal((r.sb.read(".hermes/gateway.state") || "stopped").trim(), "stopped");
    });
  });

  it("a newer stable is applied but reported as UNVERIFIED FOR HSTACK", async () => {
    await scenario({ name: "upd-moved", seed, script: after, env, knobs: { update_to: "" }, setup: (sb) => { sourceInstall(sb); sb.write("knobs/update_to", bumped); } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Version after update: Hermes Agent v0\.22\.6/);
      assert.match(r.out, /UNVERIFIED FOR HSTACK/);
      assert.doesNotMatch(r.out, /Still Hermes 0\.22\.5/);
    });
  });

  it("pm doctor failing after the update fails the step and keeps the artifact", async () => {
    await scenario({ name: "upd-pm", seed, script: after, env, knobs: { "fail.pm.doctor": true }, setup: sourceInstall }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /FAIL: pm doctor reports/);
      assert.equal(artifacts(r).length, 1);
    });
  });

  it("hermes doctor with issues remaining is reported (exit code in the message), not fatal", async () => {
    await scenario({ name: "upd-doctor", seed, script: after, env, knobs: { doctor_issues: "Run 'hermes setup' to configure API keys\n" }, setup: sourceInstall }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /NOTE: hermes -p default doctor exited 1/);
    });
  });

  it("GATEWAY_EXPECTED=1: readiness is gateway ensure --json (never status text) and must be ready", async () => {
    await scenario({ name: "upd-gw", seed, script: after, env: { ...env, GATEWAY_EXPECTED: "1" }, setup: sourceInstall }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /OK: gateway reports ready\./);
      assert.ok(calls(r).includes("gateway ensure --json --timeout 60"));
      assert.ok(!calls(r).some((x) => x.startsWith("gateway status") || x.startsWith("gateway run") || x.startsWith("gateway stop")));
    });
  });

  for (const code of ["5", "3"]) {
    it(`GATEWAY_EXPECTED=1 and ensure exit ${code}: the update is reported as not ready, whatever 'gateway status' would print`, async () => {
      await scenario({ name: "upd-gw-bad", seed, script: after, env: { ...env, GATEWAY_EXPECTED: "1" }, knobs: { ensure_exit: code, status_override: "gateway running\n" }, setup: sourceInstall }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /FAIL: gateway is not ready after the update/);
        assert.equal(artifacts(r).length, 1);
      });
    });
  }

  it("inference must return exactly OK; an error text containing OK is not success", async () => {
    const infer = run("step0#1", "step4#1");
    await scenario({ name: "upd-infer", seed, script: infer, env, files: { "infer.out": "Error: OK was not accepted\n" } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /UNVERIFIED: inference did not return exact OK/);
    });
    await scenario({ name: "upd-infer-ok", seed, script: infer, env, files: { "infer.out": "OK\n" } }, async (r) => {
      assert.equal(r.code, 0, r.out);
    });
  });
});

describe("hermes-update: text invariants", () => {
  const text = readFileSync(path.join(REPO_ROOT, "skills/hermes-update/SKILL.md"), "utf8");
  const code = loadBlocks(SKILL).map((b) => b.code).join("\n");
  it("no candidate framing or opt-in, no pip, no moving-main installer, no invented flags", () => {
    assert.doesNotMatch(text, /CANDIDATE_ACKNOWLEDGED|compatibility candidate|opt-in|unpromoted/i);
    assert.doesNotMatch(code, /pip install|\/main\/scripts\/install|update --version|--tag|hermes restore|--force-venv|git reset/);
    assert.match(text, /source-verified/i);
  });
  it("does not repeat `--backup` on top of the explicit native backup, and never stops/runs/restarts the gateway itself", () => {
    const body = loadBlocks(SKILL).filter((b) => b.id !== "step0#1").map((b) => b.code).join("\n");
    assert.doesNotMatch(body, /update[^\n]*--backup/);
    assert.doesNotMatch(body, /gateway (stop|run|restart)|--daemon/);
  });
  it("has a Verified section with file:line citations and says what is not verified", () => {
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    for (const cite of ["hermes_cli/subcommands/update.py", "hermes_cli/update_cmd_maint.py", "hermes_cli/config_defaults.py", "hermes_cli/backup.py", "pm/cli.py"]) assert.ok(text.includes(cite), cite);
    assert.match(text, /Not verified:/);
  });
});
