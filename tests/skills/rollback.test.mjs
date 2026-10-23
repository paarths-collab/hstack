import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assemble, TEMPLATE_PATH } from "./helpers/blocks.mjs";
import { scenario } from "./helpers/sandbox.mjs";
import { assertStateIdentical } from "./helpers/asserts.mjs";
import { fake } from "./helpers/tokens.mjs";

const modelEnv = {
  MODEL_PROVIDER: "openrouter", MODEL_API_KEY: fake.openrouter("R"),
  HERMES_MODEL: "example/model", PLATFORM: "telegram", HOME_CHANNEL_ID: "555",
};
const seed = { env: "PUBLIC_FIXTURE=prior\n", config: "model.default: prior/model\n", soul: "prior soul\n", crontab: "0 1 * * * prior-command\n" };
const targets = ["integration-github", "integration-notion", "hermes-model", "platform-telegram", "hermes-deploy", TEMPLATE_PATH];

for (const skill of ["integration-github", "hermes-deploy"]) {
  it(`${skill}: a native stop refusal preserves the recovery point without forcing interruption`, async () => {
    const deploy = skill === "hermes-deploy";
    const snapshot = deploy ? "deploy_snapshot" : "snapshot";
    const rollback = deploy ? "deploy_rollback" : "rollback";
    const script = assemble([
      "set +e\n", { skill, ids: ["step0#1"] }, `${snapshot} || exit 2\n`,
      'touch "$HSTACK_FAKE/knobs/fail.gateway.stop"\n',
      `${rollback}\nrc=$?\nexit "$rc"\n`,
    ]);
    await scenario({ name: "rollback-stop-refusal", seed, script, env: modelEnv }, async run => {
      assert.equal(run.code, 1, run.out);
      assert.ok(run.sb.exists(`.hermes/.hstack-backup/${skill}`));
      assert.ok(!run.sb.exists(`.hermes/.hstack-backup/${skill}.prev`));
      assert.ok(!run.out.includes("rollback: restored"));
      assert.ok(!run.sb.hermesCalls().some(c => c.some(x => ["--force", "--all", "--yes", "--interrupt"].includes(x))));
      assertStateIdentical(run);
      const retry = assemble([{ skill, ids: ["step0#1"] }, 'rm "$HSTACK_FAKE/knobs/fail.gateway.stop"\n', `${rollback} || exit 1\n`]);
      const recovered = await run.sb.run(retry, { env: modelEnv });
      assert.equal(recovered.code, 0, recovered.out);
      assert.ok(run.sb.exists(`.hermes/.hstack-backup/${skill}.prev`));
    });
  });
}

describe("rollback requires a successful gateway health command", { concurrency: 6 }, () => {
  for (const skill of targets) {
    const name = skill === TEMPLATE_PATH ? "fixture-integration" : skill;
    const deploy = skill === "hermes-deploy";
    const rollback = deploy ? "deploy_rollback" : "rollback";
    const script = assemble([
      "set +e\n", { skill, ids: ["step0#1"], placeholders: { "skill-name": name } },
      `${deploy ? "deploy_snapshot" : "snapshot"} || exit 2\n`,
      'printf "gateway running\\n" > "$HSTACK_FAKE/knobs/status_override"\nprintf 1 > "$HSTACK_FAKE/knobs/status_exit"\n',
      `${rollback}\nrc=$?\nexit "$rc"\n`,
    ]);
    it(`${name}: nonzero status cannot retire the active recovery point`, async () => {
      await scenario({ name: "rollback-status-error", seed, script, env: modelEnv }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.ok(!run.out.includes("rollback: restored"));
        assert.ok(run.sb.exists(`.hermes/.hstack-backup/${name}`));
        assert.ok(!run.sb.exists(`.hermes/.hstack-backup/${name}.prev`));
        const retry = assemble([
          { skill, ids: ["step0#1"], placeholders: { "skill-name": name } },
          'rm "$HSTACK_FAKE/knobs/status_exit"\n', `${rollback} || exit 1\n`,
        ]);
        const recovered = await run.sb.run(retry, { env: modelEnv });
        assert.equal(recovered.code, 0, recovered.out);
        assert.ok(run.sb.exists(`.hermes/.hstack-backup/${name}.prev`));
        assertStateIdentical(run);
      });
    });
  }
});

describe("skill rollback preserves its recovery point when file restoration fails", { concurrency: 6 }, () => {
  for (const skill of targets) {
    const name = skill === TEMPLATE_PATH ? "fixture-integration" : skill;
    const deploy = skill === "hermes-deploy";
    const snapshot = deploy ? "deploy_snapshot" : "snapshot";
    const rollback = deploy ? "deploy_rollback" : "rollback";
    for (const behavior of ["error", "silent-no-copy"]) {
      it(`${name}: ${behavior} cannot claim a restore or retire the active snapshot, and retry recovers`, async () => {
        const script = assemble([
          "set +e\n",
          { skill, ids: ["step0#1"], placeholders: { "skill-name": name } },
          `${snapshot} || exit 2\n`,
          "printf 'PUBLIC_FIXTURE=new\\n' | remote 'cat > ~/.hermes/.env'\n",
          'touch "$HSTACK_FAKE/knobs/fail-restore"\n',
          `${rollback}\nrc=$?\necho "ROLLBACK_RC=$rc"\nexit "$rc"\n`,
        ]);
        await scenario({
          name: `restore-${name}-${behavior}`, seed, script, env: modelEnv,
          setup: (sb) => sb.write("remote_bin/cp", `#!/bin/bash
source_arg=$1
[ "$source_arg" = -p ] && source_arg=$2
if [ -f "$HOME/knobs/fail-restore" ]; then
  case "$source_arg" in
    */.hstack-backup/*/.env) ${behavior === "error" ? "echo 'cp: injected restore failure' >&2; exit 1" : "exit 0"} ;;
  esac
fi
exec /bin/cp "$@"
`, 0o755),
        }, async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, /restoration failed; active snapshot retained/);
          assert.ok(!run.out.includes("rollback: restored"));
          assert.equal(run.sb.read(".hermes/.env"), "PUBLIC_FIXTURE=new\n");
          assert.equal(run.sb.read(`.hermes/.hstack-backup/${name}/.env`), seed.env);
          assert.ok(!run.sb.exists(`.hermes/.hstack-backup/${name}.prev`));
          const retry = assemble([
            "set +e\n", { skill, ids: ["step0#1"], placeholders: { "skill-name": name } },
            'rm "$HSTACK_FAKE/knobs/fail-restore"\n', `${rollback} || exit 1\necho RECOVERED\n`,
          ]);
          const recovered = await run.sb.run(retry, { env: modelEnv });
          assert.equal(recovered.code, 0, recovered.out);
          assert.match(recovered.out, /RECOVERED/);
          assert.equal(run.sb.read(".hermes/.env"), seed.env);
          assert.equal(run.sb.read(".hermes/config.yaml"), seed.config);
          assert.ok(run.sb.exists(`.hermes/.hstack-backup/${name}.prev`));
          assert.ok(!run.sb.exists(`.hermes/.hstack-backup/${name}`));
        });
      });
    }
  }
});

describe("skill snapshots publish complete, checked recovery points", { concurrency: 4 }, () => {
  for (const skill of ["integration-github", "hermes-deploy"]) {
    const deploy = skill === "hermes-deploy";
    const snapshot = deploy ? "deploy_snapshot" : "snapshot";
    const rollback = deploy ? "deploy_rollback" : "rollback";
    const step0 = { skill, ids: ["step0#1"] };
    for (const behavior of ["error-after-partial-copy", "silent-partial-copy"]) {
      it(`${skill}: ${behavior} leaves live state intact and no published or locked snapshot`, async () => {
        const script = assemble(["set +e\n", step0, `${snapshot}\nrc=$?\nexit "$rc"\n`]);
        await scenario({
          name: `snapshot-${behavior}`, seed, script, env: modelEnv,
          setup: (sb) => sb.write("remote_bin/cp", `#!/bin/bash
if [ "$1" = -p ] && [ "$2" = "$HOME/.hermes/config.yaml" ]; then
  printf partial > "$3"
  exit ${behavior === "error-after-partial-copy" ? "1" : "0"}
fi
exec /bin/cp "$@"
`, 0o755),
        }, async (run) => {
          assert.equal(run.code, 1, run.out);
          assertStateIdentical(run);
          assert.ok(!run.sb.exists(`.hermes/.hstack-backup/${skill}`));
          assert.ok(!run.sb.exists(`.hermes/.hstack-backup/${skill}.creating`));
          assert.deepEqual(run.sb.ls(".hermes/.hstack-backup"), []);
        });
      });
    }
    for (const corrupt of [false, true]) {
      it(`${skill}: ${corrupt ? "corrupt" : "legacy incomplete"} recovery point is refused before any live restore`, async () => {
        const before = corrupt ? `${snapshot} || exit 2\n` : `remote 'mkdir -p ~/.hermes/.hstack-backup/${skill}; printf old > ~/.hermes/.hstack-backup/${skill}/.env'\n`;
        const script = assemble([
          "set +e\n", step0, before,
          "printf 'PUBLIC_FIXTURE=new\\n' | remote 'cat > ~/.hermes/.env'\n",
          corrupt ? `remote 'printf corrupt > ~/.hermes/.hstack-backup/${skill}/config.yaml'\n` : "",
          `${rollback}\nrc=$?\nexit "$rc"\n`,
        ]);
        await scenario({ name: "snapshot-invalid", seed, script, env: modelEnv }, async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, corrupt ? /corrupt backup/ : /incomplete or legacy/);
          assert.equal(run.sb.read(".hermes/.env"), "PUBLIC_FIXTURE=new\n", "reject the whole recovery point before replacing even its valid env backup");
          assert.equal(run.sb.read(".hermes/config.yaml"), seed.config);
          assert.ok(run.sb.exists(`.hermes/.hstack-backup/${skill}`));
          assert.ok(!run.sb.exists(`.hermes/.hstack-backup/${skill}.prev`));
        });
      });
    }
  }
});

describe("deploy rollback requires a confirmed crontab read", { concurrency: 2 }, () => {
  for (const crontab of ["", null]) {
    it(`${crontab === null ? "absent" : "empty"} saved table cannot be verified by a failed read`, async () => {
      const script = assemble([
        "set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] },
        "deploy_snapshot || exit 2\n",
        'touch "$HSTACK_FAKE/knobs/fail-cron-read"\n',
        'deploy_rollback\nrc=$?\nexit "$rc"\n',
      ]);
      await scenario({
        name: "rollback-cron-read", seed: { ...seed, crontab }, script, env: modelEnv,
        setup: (sb) => {
          sb.write("remote_bin/crontab.original", sb.read("remote_bin/crontab"), 0o755);
          sb.write("remote_bin/crontab", `#!/bin/bash
if [ -f "$HOME/knobs/fail-cron-read" ] && [ "$1" = -l ]; then
  echo 'crontab: injected permission denial' >&2; exit 1
fi
exec /bin/bash "$HOME/remote_bin/crontab.original" "$@"
`, 0o755);
        },
      }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.ok(!run.out.includes("rollback: restored"));
        assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy"));
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"));
        assertStateIdentical(run);
      });
    });
  }
});

describe("snapshot retirement failures preserve the active recovery point", { concurrency: 4 }, () => {
  for (const skill of ["integration-github", "hermes-deploy"]) {
    const deploy = skill === "hermes-deploy";
    const snapshot = deploy ? "deploy_snapshot" : "snapshot";
    for (const action of ["finish", "rollback"]) {
    const retire = deploy ? `deploy_${action}` : action;
    for (const command of ["rm", "mv"]) {
      for (const silent of [false, true]) {
        it(`${skill} ${action}: ${command} ${silent ? "silently ignored" : "failed"} retains an accessible recovery point`, async () => {
          const script = assemble([
            "set +e\n", { skill, ids: ["step0#1"] }, `${snapshot} || exit 2\n`,
            `remote 'mkdir -p ~/.hermes/.hstack-backup/${skill}.prev; printf previous > ~/.hermes/.hstack-backup/${skill}.prev/fixture'\n`,
            'touch "$HSTACK_FAKE/knobs/fail-retirement"\n',
            `${retire}\nrc=$?\nexit "$rc"\n`,
          ]);
          await scenario({
            name: "finish-retirement", seed, script, env: modelEnv,
            setup: (sb) => sb.write(`remote_bin/${command}`, `#!/bin/bash
if [ -f "$HOME/knobs/fail-retirement" ]; then
  exit ${silent ? "0" : "1"}
fi
exec /bin/${command} "$@"
`, 0o755),
          }, async (run) => {
            assert.equal(run.code, 1, run.out);
            assert.equal(run.sb.read(`.hermes/.hstack-backup/${skill}/.env`), seed.env);
            assert.ok(!run.sb.exists(`.hermes/.hstack-backup/${skill}.prev/${skill}`), "do not nest the active snapshot under the previous one");
            assertStateIdentical(run);
          });
        });
      }
    }
    }
  }
});
