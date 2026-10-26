// Execute the actual host/version preflights and stop gates against an isolated simulated VPS.
// Native argparse validates command syntax; injected process state is not live Hermes evidence.
import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { describe, it } from "node:test";
import { assemble, loadBlocks, SKILLS_DIR, TEMPLATE_PATH } from "./helpers/blocks.mjs";
import { assertStateIdentical } from "./helpers/asserts.mjs";
import { scenario } from "./helpers/sandbox.mjs";

const migrated = readdirSync(SKILLS_DIR).filter(n => /^(hermes-|platform-)/.test(n) || ["integration-github", "integration-notion", "integration-obsidian"].includes(n));
const bannerSkills = [...migrated, TEMPLATE_PATH].filter(skill => loadBlocks(skill).some(b => /HERMES_BANNER=/.test(b.code)));
const helpers = { skill: TEMPLATE_PATH, ids: ["step0#1"], placeholders: { "skill-name": "preflight-fixture" } };
const preflight = skill => assemble(["set +e\n", helpers, { skill, ids: loadBlocks(skill).filter(b => /HERMES_BANNER=/.test(b.code)).map(b => b.id) }, 'echo PREFLIGHT-ACCEPTED\n']);
const seed = { env: "PUBLIC_FIXTURE=keep\n", config: "model.default: prior/model\n" };

// Every copied preflight executes here, preventing one skill from keeping a stale substring or Docker fallback.
describe("all migrated host/version preflights", { concurrency: 4 }, () => {
  for (const skill of bannerSkills) {
    const label = skill === TEMPLATE_PATH ? "template" : skill;
    it(`${label} accepts the two native banner formats and rejects near-match versions before writes`, async () => {
      for (const version of ["hermes 0.22.5", "Hermes Agent v0.22.5 (2026.9.1)", "hermes 0.22.50", "hermes 10.22.5", "hermes 0.22.5-rc1"]) {
        const allowed = version === "hermes 0.22.5" || version.startsWith("Hermes Agent v0.22.5 ");
        await scenario({ name: "banner-boundary", seed, script: preflight(skill), files: { "hermes.version": `${version}\n` } }, async run => {
          assert.equal(run.code, allowed ? 0 : 1, `${label}: ${version}\n${run.out}`);
          assert.equal(run.out.includes("PREFLIGHT-ACCEPTED"), allowed);
          if (!allowed) assert.match(run.out, /ABORT:.*0\.22\.5/);
          assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
          assertStateIdentical(run);
        });
      }
    });
    it(`${label} refuses a container-only installation before any snapshot or native write`, async () => {
      await scenario({
        name: "host-boundary", seed, script: preflight(skill),
        setup: sb => {
          rmSync(sb.p(".local/bin/hermes"));
          sb.write("remote_bin/docker", `#!/bin/bash
printf '%s\\n' "$*" >> "$HOME/logs/container-probe.log"
case "$1" in
  ps) echo hermes ;;
  exec) echo 'Hermes Agent v0.22.5' ;;
  *) exit 1 ;;
esac
`, 0o755);
        },
      }, async run => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /host|PATH|container-only/i);
        assert.ok(!run.out.includes("PREFLIGHT-ACCEPTED"));
        assert.equal(run.sb.log("container-probe.log"), "", "must not use a Docker banner as host evidence");
        assert.deepEqual(run.sb.hermesCalls(), []);
        assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
        assertStateIdentical(run);
      });
    });
  }
});

const deployEnv = { PLATFORM: "telegram", HOME_CHANNEL_ID: "555", MODEL_PROVIDER: "openai", MODEL_API_KEY: "public_fixture_key_long_enough", HERMES_MODEL: "example/model", HERMES_VERSION: "0.22.5" };
const calls = run => run.sb.hermesCalls().map(c => c.join(" "));

describe("direct gateway stop interruption gates", { concurrency: 4 }, () => {
  for (const interrupt of [undefined, "", "0", "false", "1"]) {
    it(`backup restore: GW_INTERRUPT=${JSON.stringify(interrupt)} only interrupts when literally 1`, async () => {
      const script = assemble(["set +e\n", helpers, 'SAFETY=/public-fixture/pre-restore.zip\n', { skill: "hermes-backup", ids: ["restore-4#1"] }, 'echo STOP-ACCEPTED\n']);
      await scenario({ name: "backup-stop-gate", seed, script, knobs: { live_sessions: true }, env: { GW_INTERRUPT: interrupt } }, async run => {
        const allowed = interrupt === "1";
        assert.equal(run.code, allowed ? 0 : 1, run.out);
        assert.equal(run.out.includes("STOP-ACCEPTED"), allowed);
        assert.equal(calls(run).includes("gateway stop -y"), allowed);
        assertStateIdentical(run);
      });
    });
    it(`deploy rollback: GW_INTERRUPT=${JSON.stringify(interrupt)} only interrupts when literally 1`, async () => {
      // No pre-deploy .env: rollback must stop the gateway instead of retiring its last recovery point while it still runs.
      const script = assemble(["set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] }, 'deploy_snapshot || exit 1\ndeploy_rollback; echo "ROLLBACK_RC=$?"\n']);
      await scenario({ name: "deploy-stop-gate", script, knobs: { live_sessions: true }, env: { ...deployEnv, GW_INTERRUPT: interrupt } }, async run => {
        const allowed = interrupt === "1";
        assert.match(run.out, allowed ? /ROLLBACK_RC=0/ : /ROLLBACK_RC=1/);
        assert.equal(calls(run).includes("gateway stop -y"), allowed);
        assert.equal(run.sb.exists(".hermes/.hstack-backup/hermes-deploy"), !allowed, "refusal must retain the recovery point");
        assert.equal(run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"), allowed);
      });
    });
  }
});
