// hermes-deploy: variable transport to the VPS, input validation, the open-bot gate, and the
// COMPOSITION with the delegated skills (/hermes-model, /platform-telegram) that all run in ONE shell and
// each redefine the generic helper names. The real SKILL.md blocks run against a simulated VPS.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, writeEvents } from "./helpers/asserts.mjs";
import { assemble, loadBlocks } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

// A Discord-shaped numeric id, built at run time (no id-shaped literal in the repo).
const DISCORD_ID = "1".repeat(18);
const SSH_CHECK = "confirm-ssh-access-before-doing-anything#1";
const ROUTE_GATE = '[ "$PLATFORM" = telegram ] || { echo "ABORT: /hermes-deploy supports Telegram only for now; the other platforms are being re-verified for Hermes 0.22.5 one at a time. Nothing was written."; exit 1; }';
const SSH_ROUTE_GATE = ROUTE_GATE.replace('"$PLATFORM"', '"${PLATFORM:-}"');
const TG = fake.telegram("G");
const OR = fake.openrouter("K");
const OLD_OR = fake.openrouter("O");
const OLD_TG = fake.telegram("O", "987654321");

const baseEnv = {
  FORCE: "1",
  HERMES_VERSION: "0.22.5",
  MODEL_PROVIDER: "openrouter",
  MODEL_API_KEY: OR,
  HERMES_MODEL: "anthropic/claude-sonnet-4",
  PLATFORM: "telegram",
  HOME_CHANNEL_ID: "555",
  TELEGRAM_BOT_TOKEN: TG,
  TELEGRAM_ALLOWED_USERS: "555",
};
const seed = {
  env: `FOO=bar\nOPENROUTER_API_KEY=${OLD_OR}\nTELEGRAM_BOT_TOKEN=${OLD_TG}\nTELEGRAM_ALLOWED_USERS=111\n`,
  config: "model.default: old/model\nmodel.provider: openrouter\n",
  soul: "old soul\n",
  crontab: "30 3 * * * oldcron\n",
};

// The delegated skills are modernized by other owners and their block ids move, so the run-order is derived from the files instead of
// pinned: every non-quoted bash block except the pre-flight SSH echo, the "undo a finished run" snippets and /hermes-model's hostname hint.
const flowIds = (skill, skip = []) => loadBlocks(skill).filter((b) => !b.quoted && !/^(before-you-start|rollback)/.test(b.id) && !skip.includes(b.id)).map((b) => b.id);
const MODEL_IDS = flowIds("hermes-model", ["step1#2"]);
const TG_IDS = flowIds("platform-telegram");
const GENERIC_NAMES = [["deploy_snapshot", "snapshot"], ["deploy_rollback", "rollback"], ["deploy_finish", "finish"], ["DEPLOY_SKILL", "SKILL_NAME"]];

/** Source deploy Step 0, then the delegated skills' Step 0s in the same shell, then deploy's Step 6 onward. */
function compose({ tamper = "", late = "", generic = false, gateReplace = [] } = {}) {
  const D = (ids, replace = []) => ({ skill: "hermes-deploy", ids, replace: [...(generic ? GENERIC_NAMES : []), ...replace] });
  return assemble([
    "set +e\n",
    D([SSH_CHECK, "step0#1", "step1#1", "step2#1", "step3#1", "step4#1", "step5#1"]),
    { skill: "hermes-model", ids: MODEL_IDS },
    { skill: "platform-telegram", ids: TG_IDS },
    tamper,
    D(["step6#1"], gateReplace),
    D(["step7#1", "step8#1"]),
    late,
    D(["step9#1"]),
    SCRIPT_END,
  ]);
}

// Shell snippets that tamper with the VPS between the delegated skills and the deploy gate.
const rmKey = (k) => `remote "grep -v '^${k}=' ~/.hermes/.env > ~/.hermes/.env.t; cat ~/.hermes/.env.t > ~/.hermes/.env; rm -f ~/.hermes/.env.t"\n`;
const addLine = (l) => `printf '%s\\n' '${l}' | remote 'cat >> ~/.hermes/.env'\n`;
const setAllow = (v) => rmKey("TELEGRAM_ALLOWED_USERS") + (v === null ? "" : addLine(`TELEGRAM_ALLOWED_USERS=${v}`));

describe("hermes-deploy: composed run", { concurrency: 6 }, () => {
  it("good run: real PLATFORM / provider / home channel reach the VPS; keys under the names Hermes reads", async () => {
    await scenario({ name: "dep-good", seed, valid: [TG], script: compose(), env: { ...baseEnv, HOME_CHANNEL_ID: "-1001234567890" }, knobs: { strict_negnum: true } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
        assert.ok(!run.sb.log("hermes-profile.log").includes("unbound"), "all delegated native calls bind the default recovery root");
      assert.match(run.out, /OK: OPENROUTER_API_KEY, telegram credentials and TELEGRAM_ALLOWED_USERS present; TELEGRAM_HOME_CHANNEL set\./);
      const env = run.sb.read(".hermes/.env");
      assert.match(env, new RegExp(`^OPENROUTER_API_KEY=${OR}$`, "m"));
      assert.match(env, new RegExp(`^TELEGRAM_BOT_TOKEN=${TG}$`, "m"));
      assert.match(env, /^TELEGRAM_ALLOWED_USERS=555$/m);
      assert.match(env, /^TELEGRAM_HOME_CHANNEL=-1001234567890$/m);
      const keys = env.split("\n").filter(Boolean).map((l) => l.split("=")[0]).sort();
      assert.deepEqual(keys, ["FOO", "OPENROUTER_API_KEY", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_BOT_TOKEN", "TELEGRAM_HOME_CHANNEL"], "only the names Hermes reads");
      assert.equal(run.sb.mode(".hermes/.env"), 0o600);
      assert.ok(run.sb.hermesCalls().some((c) => c.join(" ") === "config set TELEGRAM_HOME_CHANNEL -- -1001234567890"));
      // Native service ownership replaces the unvalidated nightly restart workaround.
      assert.equal(run.sb.read("crontab.store"), seed.crontab, "unrelated crontab is unchanged");
      assert.ok(run.sb.exists("state/gateway.install"), "gateway install ran");
      // Step 7 = install the service without starting it, then the shared reload: restart --detach, then ensure --json.
      // The stub logs argv after the global `-p default` (asserted separately through hermes-profile.log).
      const gwCmds = run.sb.hermesCalls().map((c) => c.join(" ")).filter((c) => c.startsWith("gateway "));
      const iInstall = gwCmds.indexOf("gateway install --if-missing --no-start-now");
      const iRestart = gwCmds.lastIndexOf("gateway restart --detach");
      assert.ok(iInstall >= 0 && iRestart > iInstall, `install then restart expected: ${gwCmds.join(" | ")}`);
      assert.ok(gwCmds.slice(iRestart).some((c) => c === "gateway ensure --json --timeout 60"), "ensure --json must follow the restart");
      assert.ok(!gwCmds.some((c) => /^gateway (run|stop|status)\b|--daemon|--force|--all| -y$| --yes$/.test(c)), `no retired or overriding gateway command: ${gwCmds.join(" | ")}`);
      // snapshots: deploy's own and the delegated skills' are all finished (.prev) and hold the pre-run files
      for (const s of ["hermes-deploy", "hermes-model", "platform-telegram"]) assert.ok(run.sb.exists(`.hermes/.hstack-backup/${s}.prev`), s);
      assert.equal(run.sb.read(".hermes/.hstack-backup/hermes-deploy.prev/.env"), seed.env);
      assert.equal(run.sb.read(".hermes/.hstack-backup/hermes-deploy.prev/SOUL.md"), seed.soul);
      assert.equal(run.sb.read(".hermes/.hstack-backup/hermes-deploy.prev/crontab"), seed.crontab);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-deploy"));
      assertSecretsNotPrinted(run, [OR, TG]);
      assert.match(run.out, /ACTION REQUIRED/);
    });
  });

  it("CONTROL: the OLD shape (quoted heredoc referencing local variables) delivers EMPTY values", async () => {
    // Reproduction of the pre-repair pattern: nothing expands locally, the remote shell has no such variables.
    const old = [
      "set +e\n",
      "remote() { ssh -o BatchMode=yes \"$VPS_USER@$VPS_IP\" \"export PATH=\\\"\\$HOME/.local/bin:\\$PATH\\\"; $*\"; }\n",
      "MODEL_KEYVAR=OPENROUTER_API_KEY\n",
      "remote 'bash -s' <<'REMOTE'\n",
      "echo \"values: provider=[$MODEL_PROVIDER] keyvar=[$MODEL_KEYVAR] platform=[$PLATFORM] home=[$HOME_CHANNEL_ID]\"\n",
      "REMOTE\n",
    ].join("");
    await scenario({ name: "dep-old", script: old, env: baseEnv }, async (run) => {
      assert.ok(run.out.includes("values: provider=[] keyvar=[] platform=[] home=[]"), run.out);
    });
  });

  it("CONTROL on the real block: dropping the env prefix from Step 6 makes the gate fail and roll back", async () => {
    const replace = [['remote "$REMOTE_ENV bash -s"', "remote 'bash -s'"]];
    const script = compose({ gateReplace: replace });
    assert.ok(script.includes("remote 'bash -s' <<'REMOTE' || { echo \"FAIL: Step 6 wiring gate"), "control did not edit the block");
    await scenario({ name: "dep-notransport", seed, valid: [TG], script, env: baseEnv }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /FAIL:\s+not set for provider\s+\(re-run/);
      assert.match(run.out, /FAIL: Step 6 wiring gate\. Rolling back\./);
      assertStateIdentical(run);
    });
  });
});

describe("hermes-deploy: Step 6 open-bot gate rolls back to the pre-deploy state", { concurrency: 6 }, () => {
  // Every gate failure also tampers with SOUL.md and the crontab so the restore of all four files is visible.
  const dirty = `printf 'tampered\\n' | remote 'cat > ~/.hermes/SOUL.md'\nprintf '* * * * * evil\\n' | remote 'crontab -'\n`;
  const cases = [
    ["empty allowlist", setAllow(null), /TELEGRAM_ALLOWED_USERS is empty/],
    ["wildcard *", setAllow("*"), /contains a wildcard/],
    ["wildcard 555,*", setAllow("555,*"), /contains a wildcard/],
    ["quoted wildcard", setAllow('"555,*"'), /contains a wildcard/],
    ["TELEGRAM_ALLOW_ALL_USERS=true", addLine("TELEGRAM_ALLOW_ALL_USERS=true"), /TELEGRAM_ALLOW_ALL_USERS is turned on/],
    ["GATEWAY_ALLOW_ALL_USERS=1", addLine("GATEWAY_ALLOW_ALL_USERS=1"), /GATEWAY_ALLOW_ALL_USERS is turned on/],
    ['GATEWAY_ALLOW_ALL_USERS="yes"', addLine('GATEWAY_ALLOW_ALL_USERS="yes"'), /GATEWAY_ALLOW_ALL_USERS is turned on/],
    ["model key missing", rmKey("OPENROUTER_API_KEY"), /OPENROUTER_API_KEY not set for provider openrouter/],
    ["bot token missing", rmKey("TELEGRAM_BOT_TOKEN"), /TELEGRAM_BOT_TOKEN not set for telegram/],
    ["SOUL.md missing", `remote 'rm -f ~/.hermes/SOUL.md'\n`, /SOUL\.md missing/],
    ["SOUL.md over 1 KB", `remote 'head -c 2000 /dev/zero | tr "\\0" x > ~/.hermes/SOUL.md'\n`, /SOUL\.md > 1 KB/],
  ];
  for (const [label, tamper, msg] of cases) {
    it(`${label}: Step 6 refuses, deploy_rollback restores .env, config.yaml, SOUL.md and crontab`, async () => {
      const t = label.startsWith("SOUL") ? tamper : dirty + tamper;
      await scenario({ name: "dep-gate", seed, valid: [TG], script: compose({ tamper: t }), env: baseEnv }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /FAIL: Step 6 wiring gate\. Rolling back\./);
        assert.match(run.out, /rollback: restored ~\/\.hermes\/\.env, config\.yaml, SOUL\.md and crontab/);
        assertStateIdentical(run);
        assert.equal(run.sb.read(".hermes/.env"), seed.env);
        assert.equal(run.sb.read(".hermes/SOUL.md"), seed.soul);
        assert.equal(run.sb.read("crontab.store"), seed.crontab);
        assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"));
        assert.ok(!run.sb.exists("state/gateway.install"), "Step 7 must not have run");
      });
    });
  }

  for (const line of ["TELEGRAM_ALLOW_ALL_USERS=false", "GATEWAY_ALLOW_ALL_USERS=0"]) {
    it(`${line} (switched off) passes the gate`, async () => {
      await scenario({ name: "dep-off", seed, valid: [TG], script: compose({ tamper: addLine(line) }), env: baseEnv }, async (run) => {
        assert.equal(run.code, 0, run.out);
      });
    });
  }

  it("other platform (discord): the gate checks DISCORD_ALLOWED_USERS and refuses an empty one", async () => {
    const script = assemble([
      "set +e\n",
      { skill: "hermes-deploy", ids: [SSH_CHECK, "step0#1", "step1#1", "step2#1", "step3#1", "step4#1"], replace: [[ROUTE_GATE, ""], [SSH_ROUTE_GATE, ""]] },
      `printf '%s\\n' 'OPENROUTER_API_KEY=x' 'DISCORD_BOT_TOKEN=y' | remote 'cat >> ~/.hermes/.env'\n`,
      `remote 'echo soul > ~/.hermes/SOUL.md'\n`,
      { skill: "hermes-deploy", ids: ["step6#1"] },
      SCRIPT_END,
    ]);
    await scenario({ name: "dep-discord", seed, script, env: { ...baseEnv, PLATFORM: "discord", HOME_CHANNEL_ID: DISCORD_ID } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /DISCORD_ALLOWED_USERS is empty/);
      assertStateIdentical(run);
    });
  });
});

describe("hermes-deploy: composition (deploy + delegated skills in the same shell)", { concurrency: 6 }, () => {
  it("a Step 6 gate failure after both delegated skills finished restores the PRE-DEPLOY files", async () => {
    await scenario({ name: "dep-comp", seed, valid: [TG], script: compose({ tamper: setAllow(null) }), env: baseEnv }, async (run) => {
      assert.equal(run.code, 1);
      assertStateIdentical(run);
      // the delegated skills finished and moved their snapshots aside; deploy's own was the one used
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-telegram.prev"));
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-model.prev"));
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"));
    });
  });

  it("CONTROL: with the generic names (snapshot/rollback/SKILL_NAME) the SAME failure restores the WRONG snapshot", async () => {
    const script = compose({ generic: true, tamper: setAllow(null) });
    assert.ok(script.includes("SKILL_NAME=hermes-deploy") && !script.includes("deploy_rollback"), "control did not apply");
    await scenario({ name: "dep-generic", seed, valid: [TG], script, env: baseEnv }, async (run) => {
      assert.equal(run.code, 1);
      assertStateChanged(run);
      assert.match(run.out, /rollback: no snapshot for platform-telegram; nothing was written/);
      assert.notEqual(run.sb.read(".hermes/.env"), seed.env, "the pre-deploy .env must NOT have come back");
    });
  });

  it("a delegated skill aborting mid-deploy: re-running Step 0 then deploy_rollback restores everything", async () => {
    const badTg = fake.telegram("B", "999999999");
    await scenario({ name: "dep-recover", seed, valid: [TG], script: compose(), env: { ...baseEnv, TELEGRAM_BOT_TOKEN: badTg } }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /ABORT: Telegram getMe/);
      assertStateChanged(run); // hermes-model finished and wrote its key before telegram aborted
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy"), "deploy snapshot is the recovery point");
      const rec = await run.sb.run(assemble([{ skill: "hermes-deploy", ids: ["step0#1"] }, "deploy_rollback; echo RECOVERED\n"]), { env: baseEnv });
      assert.equal(rec.code, 0, rec.out);
      assert.ok(rec.out.includes("RECOVERED"));
      assert.deepEqual(run.sb.state(), run.before);
      assert.equal(run.sb.read("crontab.store"), seed.crontab);
    });
  });

  it("a leftover deploy snapshot makes deploy_snapshot refuse before any write", async () => {
    await scenario({ name: "dep-left", seed, valid: [TG], script: compose(), env: baseEnv, setup: (sb) => sb.write(".hermes/.hstack-backup/hermes-deploy/.env", "junk\n") }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /did not finish/);
      assert.match(run.out, /ABORT: could not snapshot/);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  it("failure after native service setup preserves the pre-deploy crontab", async () => {
    // Logs stay healthy for the delegated skills and go quiet only once deploy's own Step 8 looks.
    const quiet = `printf 'nothing useful\\n' > "$HSTACK_FAKE/logs.txt"\n`;
    const script = compose().replace('echo ">>> hermes-deploy step8#1"', `${quiet}echo ">>> hermes-deploy step8#1"`);
    assert.ok(script.includes(quiet), "control did not apply");
    await scenario({ name: "dep-cron", seed, valid: [TG], script, env: baseEnv }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: gateway\/platform not visible in logs/);
      assert.ok(run.sb.exists("state/gateway.install"), "Step 7 ran, so the cron was installed before the failure");
      assertStateIdentical(run);
      assert.equal(run.sb.read("crontab.store"), seed.crontab);
    });
  });

  it("Step 7 gateway install fails: rollback", async () => {
    await scenario({ name: "dep-install", seed, valid: [TG], script: compose(), env: baseEnv, knobs: { "fail.gateway.install": true } }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /FAIL: native gateway service setup\. Rolling back\./);
      assertStateIdentical(run);
      assert.ok(!run.out.includes("OK: native gateway service installed and ready"));
    });
  });

  // Step 7 reload failures (knobs fail.gateway.restart / fail.gateway.ensure / restart_noop / live_sessions /
  // ensure_exit). They are set by a snippet that runs right before Step 7 so the delegated skills' own reloads succeed.
  const beforeStep7 = (knob, content = "") => `printf '${content}' > "$HSTACK_FAKE/knobs/${knob}"\n`;
  const step7Cases = [
    ["restart exits non-zero", "fail.gateway.restart", "", /FAIL: gateway did not restart ready\. Rolling back\./, /gateway restart failed or was refused/],
    ["restart refused because of live sessions (no -y by default)", "live_sessions", "", /FAIL: gateway did not restart ready\. Rolling back\./, /live sessions\?/],
    ["restart exits 0 but the instance did not change", "restart_noop", "", /FAIL: gateway did not restart ready\. Rolling back\./, /instance did not change/],
    ["ensure never reports ready (exit 5)", "ensure_exit", "5", /FAIL: gateway did not restart ready\. Rolling back\./, /deadline/],
  ];
  for (const [label, knob, content, failMsg, why] of step7Cases) {
    it(`Step 7: ${label} -> rollback restores the files; a rollback that cannot reload keeps the recovery point`, async () => {
      await scenario({ name: "dep-s7", seed, valid: [TG], script: compose({ tamper: beforeStep7(knob, content) }), env: baseEnv }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, failMsg);
        assert.match(run.out, why);
        // The same broken gateway also fails the rollback's own reload, so the files are restored but the snapshot stays active.
        assertStateIdentical(run);
        assert.match(run.out, /files restored, but the gateway did NOT come back/);
        assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy"), "recovery point stays active until the gateway is back");
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"));
        assert.ok(!run.out.includes("ACTION REQUIRED"));
        const calls = run.sb.hermesCalls().map((c) => c.join(" "));
        assert.ok(!calls.some((c) => / -y$| --yes$| --interrupt$|--force|--all/.test(c) && c.startsWith("gateway")), `no interruption flag unless GW_INTERRUPT is set: ${calls.filter((c) => c.startsWith("gateway")).join(" | ")}`);
      });
    });
  }

  it("Step 7: GW_INTERRUPT=1 is the only way -y reaches restart (live sessions)", async () => {
    await scenario({ name: "dep-s7-int", seed, valid: [TG], script: compose({ tamper: beforeStep7("live_sessions") }), env: { ...baseEnv, GW_INTERRUPT: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.sb.hermesCalls().some((c) => c.join(" ") === "gateway restart --detach -y"));
    });
  });

  it("rollback when there was NO .env before the deploy stops the gateway (credentials are gone) and finishes", async () => {
    const script = assemble([
      "set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] },
      "deploy_snapshot || exit 2\n",
      `remote 'printf "OPENROUTER_API_KEY=x\\n" > ~/.hermes/.env; echo running > ~/.hermes/gateway.state'\n`,
      "deploy_rollback; echo \"ROLLBACK_RC=$?\"\n", SCRIPT_END,
    ]);
    await scenario({ name: "dep-noenv", seed: { config: seed.config, soul: seed.soul, crontab: seed.crontab }, script, env: baseEnv }, async (run) => {
      assert.match(run.out, /ROLLBACK_RC=0/, run.out);
      assert.ok(!run.sb.exists(".hermes/.env"), "the .env created during the deploy is removed");
      assert.equal(run.sb.read(".hermes/gateway.state").trim(), "stopped");
      const calls = run.sb.hermesCalls().map((c) => c.join(" "));
      assert.ok(calls.includes("gateway stop"), calls.join(" | "));
      assert.ok(!calls.some((c) => c.startsWith("gateway restart")), "no restart onto missing credentials");
      assert.match(run.out, /gateway left stopped/);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"));
      assertStateIdentical(run);
    });
  });

  it("rollback with no prior .env and live sessions: the stop is refused, the recovery point is kept, no -y is added", async () => {
    const script = assemble([
      "set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] },
      "deploy_snapshot || exit 2\n",
      `remote 'printf "OPENROUTER_API_KEY=x\\n" > ~/.hermes/.env; echo running > ~/.hermes/gateway.state'\n`,
      'touch "$HSTACK_FAKE/knobs/live_sessions"\n',
      "deploy_rollback; echo \"ROLLBACK_RC=$?\"\n", SCRIPT_END,
    ]);
    await scenario({ name: "dep-noenv-live", seed: { config: seed.config, soul: seed.soul, crontab: seed.crontab }, script, env: baseEnv }, async (run) => {
      assert.match(run.out, /ROLLBACK_RC=1/, run.out);
      assert.match(run.out, /gateway could not be stopped/);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy"), "snapshot retained for a retry");
      assert.ok(!run.sb.hermesCalls().some((c) => c.join(" ") === "gateway stop -y"));
      assertStateIdentical(run);
    });
  });

  for (const [label, logs] of [
    ["generic gateway readiness", "gateway ready\nregistered tool github\n"],
    ["a disconnected target", "gateway ready\ntelegram disconnected\n"],
    ["a later target failure", "telegram connected\ntelegram connection failed\n"],
  ]) {
    it(`Step 8: ${label} cannot prove the selected platform connected`, async () => {
      const script = assemble([
        "set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] },
        "deploy_snapshot || exit 2\n", { skill: "hermes-deploy", ids: ["step8#1"] }, SCRIPT_END,
      ]);
      await scenario({ name: "dep-platform-log", seed, script, env: baseEnv, files: { "logs.txt": logs } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /FAIL: gateway\/platform not visible/);
        assert.ok(!run.out.includes("OK: gateway up, telegram connected"));
        assertStateIdentical(run);
      });
    });
  }

  it("Step 7: native service setup never reads or rewrites the unrelated crontab", async () => {
    const script = assemble([
      "set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] },
      "deploy_snapshot || exit 2\n",
      'touch "$HSTACK_FAKE/knobs/refuse-crontab"\n',
      { skill: "hermes-deploy", ids: ["step7#1"] }, SCRIPT_END,
    ]);
    await scenario({
      name: "dep-native-service", seed, script, env: baseEnv,
      setup: (sb) => {
        sb.write("remote_bin/crontab.original", sb.read("remote_bin/crontab"), 0o755);
        sb.write("remote_bin/crontab", `#!/bin/bash
if [ -f "$HOME/knobs/refuse-crontab" ]; then
  echo unexpected-crontab >> "$HOME/logs/events.log"; exit 1
fi
exec /bin/bash "$HOME/remote_bin/crontab.original" "$@"
`, 0o755);
      },
    }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(run.sb.read("crontab.store"), seed.crontab);
      assert.ok(!run.sb.events().includes("unexpected-crontab"));
      const calls = run.sb.hermesCalls().map(c => c.join(" "));
      assert.ok(calls.includes("gateway install --if-missing --no-start-now"));
      assert.ok(calls.indexOf("gateway restart --detach") > calls.indexOf("gateway install --if-missing --no-start-now"), "reload happens after the install");
      assert.ok(calls.includes("gateway ensure --json --timeout 60"));
    });
  });

  it("Step 9a: an inconclusive model reply is UNVERIFIED, not done, and the snapshot stays", async () => {
    await scenario({ name: "dep-9a", seed, valid: [TG], script: compose({ late: `echo "banana split" > "$HSTACK_FAKE/infer.out"\n` }), env: baseEnv }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /UNVERIFIED: the model smoke test returned an unexpected reply/);
      assert.ok(!run.out.includes("ACTION REQUIRED"));
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy"), "snapshot must remain for deploy_rollback");
      assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"), "deploy_finish must not have run");
      assertStateChanged(run);
    });
  });

  it("Step 9a: an empty model reply rolls back", async () => {
    await scenario({ name: "dep-9a-empty", seed, valid: [TG], script: compose({ late: `: > "$HSTACK_FAKE/infer.out"\n` }), env: baseEnv }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /FAIL: empty response/);
      assertStateIdentical(run);
    });
  });

  it("Step 9a: a failed inference command printing OK cannot finish the deploy", async () => {
    const late = `stub="$HSTACK_FAKE/.local/bin/hermes"
      awk '/event -z; inject infer/ { print; print "    echo OK; exit 1"; next } {print}' "$stub" > "$stub.new"
      cat "$stub.new" > "$stub"; rm "$stub.new"
`;
    await scenario({ name: "dep-9a-failed-ok", seed, valid: [TG], script: compose({ late }), env: baseEnv }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: model smoke command failed/);
      assert.ok(!run.out.includes("ACTION REQUIRED"));
      assert.match(run.out, /rollback: restored/);
      assertStateIdentical(run);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"));
    });
  });

  it("Step 9b: readiness is gateway ensure --json, never status text: a status line saying running cannot make a draining gateway ready", async () => {
    // Everything before 9b is healthy; at 9b the gateway reports draining (exit 6) while `gateway status` would print "running".
    const late = `printf 'gateway running\\n' > "$HSTACK_FAKE/knobs/status_override"\nprintf 6 > "$HSTACK_FAKE/knobs/ensure_exit"\n`;
    await scenario({ name: "dep-9b", seed, valid: [TG], script: compose({ late }), env: baseEnv }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: gateway not ready\. Rolling back\./);
      assert.ok(!run.out.includes("ACTION REQUIRED"));
      assert.ok(!run.sb.hermesCalls().slice(-12).some((c) => c[0] === "gateway" && c[1] === "status"), "9b must not consult gateway status");
      // rollback restored the files; the gateway cannot come back ready either (ensure still exits 6), so the snapshot is KEPT
      assertStateIdentical(run);
      assert.match(run.out, /files restored, but the gateway did NOT come back/);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy"), "recovery point must stay active");
      assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"));
    });
  });

  for (const [code, label] of [[5, "deadline"], [3, "incompatible"], [7, "conflict"]]) {
    it(`Step 9b: ensure exit ${code} (${label}) is not ready and deploy_finish does not run`, async () => {
      const script = assemble([
        "set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] },
        "deploy_snapshot || exit 2\n", `printf ${code} > "$HSTACK_FAKE/knobs/ensure_exit"\n`,
        { skill: "hermes-deploy", ids: ["step9#1"] }, SCRIPT_END,
      ]);
      await scenario({ name: "dep-9b-code", seed, script, env: baseEnv }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /FAIL: gateway not ready/);
        assert.ok(!run.out.includes("ACTION REQUIRED"));
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"));
      });
    });
  }

  it("Step 9b: a gateway that is ready lets the deploy finish (control for the failures above)", async () => {
    const script = assemble([
      "set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] },
      "deploy_snapshot || exit 2\n", { skill: "hermes-deploy", ids: ["step9#1"] }, SCRIPT_END,
    ]);
    await scenario({ name: "dep-9b-ok", seed, script, env: baseEnv }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /OK: gateway reports ready\./);
      assert.match(run.out, /ACTION REQUIRED/);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"));
    });
  });

  it("Signal home channel is written (SIGNAL_HOME_CHANNEL is read by plugins/platforms/signal/gateway_env.py:16); no confirmation switch exists", async () => {
    const sig = `SIGNAL_ACCOUNT=+15550001111\\nSIGNAL_HTTP_URL=http://127.0.0.1:8080\\nSIGNAL_ALLOWED_USERS=+15551112222\\nOPENROUTER_API_KEY=x\\n`;
    const script = assemble([
      "set +e\n",
      { skill: "hermes-deploy", ids: [SSH_CHECK, "step0#1", "step1#1", "step2#1", "step3#1", "step4#1"], replace: [[ROUTE_GATE, ""], [SSH_ROUTE_GATE, ""]] },
      `remote 'printf "${sig}" >> ~/.hermes/.env; echo soul > ~/.hermes/SOUL.md'\n`,
      { skill: "hermes-deploy", ids: ["step6#1"] }, SCRIPT_END,
    ]);
    const env = { ...baseEnv, PLATFORM: "signal", HOME_CHANNEL_ID: "+15551234567" };
    await scenario({ name: "dep-sig", seed, script, env }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/.env"), /^SIGNAL_HOME_CHANNEL=\+15551234567$/m);
      assert.doesNotMatch(run.out, /NOT written|CONFIRM_SIGNAL/);
    });
  });
});

describe("hermes-deploy: Step 0 input validation (before any remote call)", { concurrency: 6 }, () => {
  const only = assemble(["set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] }, SCRIPT_END]);
  const cases = [
    ["PLATFORM with a command", { PLATFORM: 'telegram; rm -rf "$HOME/x"; touch "$HOME/pwned"' }, /PLATFORM must be/],
    ["unknown PLATFORM", { PLATFORM: "myspace" }, /PLATFORM must be/],
    ["home channel with command substitution", { HOME_CHANNEL_ID: '$(touch "$HOME/pwned")' }, /HOME_CHANNEL_ID is not a valid telegram id/],
    ["home channel with a semicolon", { HOME_CHANNEL_ID: '1; touch "$HOME/pwned"' }, /HOME_CHANNEL_ID is not a valid/],
    ["home channel with a newline", { HOME_CHANNEL_ID: "5\n6" }, /HOME_CHANNEL_ID is not a valid/],
    ["unknown provider", { MODEL_PROVIDER: "bogus" }, /MODEL_PROVIDER must be/],
    ["model id with command substitution", { HERMES_MODEL: 'x$(touch "$HOME/pwned")' }, /HERMES_MODEL/],
    ["empty model key", { MODEL_API_KEY: "" }, /MODEL_API_KEY is empty/],
    ["malformed host", { VPS_IP: "1.2.3.4;id" }, /VPS_IP \/ VPS_USER look malformed/],
    ["a wrong HERMES_VERSION (the legacy 0.15.2 fixture)", { HERMES_VERSION: "0.15.2" }, /HERMES_VERSION must be 0\.22\.5/],
    ["a newer HERMES_VERSION (nothing newer is verified)", { HERMES_VERSION: "0.23.0" }, /HERMES_VERSION must be 0\.22\.5/],
    ["HERMES_VERSION that merely contains 0.22.5", { HERMES_VERSION: "10.22.51" }, /HERMES_VERSION must be 0\.22\.5/],
  ];
  for (const [label, over, msg] of cases) {
    it(`rejects ${label} with zero ssh/curl calls`, async () => {
      await scenario({ name: "dep-val", script: only, env: { ...baseEnv, ...over } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /Nothing was written/);
        assert.equal(run.sb.sshCalls().length, 0);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }

  it("HERMES_VERSION is optional: unset, or exactly 0.22.5, passes; CANDIDATE_ACKNOWLEDGED is not required", async () => {
    const script = assemble([
      "set +e\n", { skill: "hermes-deploy", ids: ["step0#1"], replace: [["\ndeploy_validate_inputs || exit 1\n", "\n"], [ROUTE_GATE, ""]] },
      "( unset HERMES_VERSION CANDIDATE_ACKNOWLEDGED; deploy_validate_inputs >/dev/null 2>&1 && echo UNSET_OK || echo UNSET_REJ )\n",
      "( HERMES_VERSION=0.22.5; unset CANDIDATE_ACKNOWLEDGED; deploy_validate_inputs >/dev/null 2>&1 && echo PINNED_OK || echo PINNED_REJ )\n",
    ]);
    await scenario({ name: "dep-ver", script, env: { ...baseEnv, HERMES_VERSION: undefined } }, async (run) => {
      assert.ok(run.out.includes("UNSET_OK") && run.out.includes("PINNED_OK"), run.out);
    });
  });

  it("per-platform home channel formats", async () => {
    const table = [
      ["telegram", "-1001234567890", true], ["telegram", "555", true], ["telegram", "abc", false],
      ["discord", DISCORD_ID, true], ["discord", "123", false],
      ["slack", "C01234ABCDE", true], ["slack", "c01", false],
      ["mattermost", "abcdefghijklmnopqrstuvwxyz", true],
      ["whatsapp", "15551234567@s.whatsapp.net", true],
      ["teams", "19:abc@thread.tacv2", true],
      ["google-chat", "spaces/AAAA-bb_1", true],
      ["signal", "+15551234567", true], ["signal", "group:abcdEFGH1234", true], ["signal", "abcdEFGH1234", false], ["signal", "a;b", false],
      ["telegram;ls", "1", false],
    ];
    const lines = table.map(([p, h]) => `( PLATFORM='${p}' HOME_CHANNEL_ID='${h}'; if deploy_validate_inputs >/dev/null 2>&1; then echo "RESULT ${p} ${h} OK"; else echo "RESULT ${p} ${h} REJ"; fi )\n`).join("");
    const script = assemble([
      "set +e\n",
      { skill: "hermes-deploy", ids: ["step0#1"], replace: [["\ndeploy_validate_inputs || exit 1\n", "\n"], [ROUTE_GATE, ""]] },
      lines,
    ]);
    assert.ok(!/^deploy_validate_inputs \|\| exit 1$/m.test(script), "control: the trailing validate call must be removed");
    await scenario({ name: "dep-table", script, env: baseEnv }, async (run) => {
      for (const [p, h, ok] of table) assert.ok(run.out.includes(`RESULT ${p} ${h} ${ok ? "OK" : "REJ"}`), `${p} ${h}: ${run.out}`);
    });
  });

  it("per-platform variable names match the v0.22.5 plugin sources (credentials, allowlist, home channel)", async () => {
    // Source: plugins/platforms/<p>/gateway_env.py (ENV_ENABLE_CREDENTIALS, ENV_OVERRIDES home_step, AUTHZ allowed_users_env);
    // slack SLACK_APP_TOKEN: slack/adapter.py:1791-1793; teams: teams/adapter.py:162-164,183,850; google_chat: adapter.py:1590-1592,1626,1629,1673,1684
    // (inbound needs a project AND a Pub/Sub subscription name, so GOOGLE_CHAT_SUBSCRIPTION_NAME is required); signal home: gateway_env.py:16.
    const want = {
      telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_HOME_CHANNEL"],
      discord: ["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USERS", "DISCORD_HOME_CHANNEL"],
      slack: ["SLACK_BOT_TOKEN SLACK_APP_TOKEN", "SLACK_ALLOWED_USERS", "SLACK_HOME_CHANNEL"],
      mattermost: ["MATTERMOST_URL MATTERMOST_TOKEN", "MATTERMOST_ALLOWED_USERS", "MATTERMOST_HOME_CHANNEL"],
      whatsapp: ["", "WHATSAPP_ALLOWED_USERS", "WHATSAPP_HOME_CHANNEL"],
      teams: ["TEAMS_CLIENT_ID TEAMS_CLIENT_SECRET TEAMS_TENANT_ID", "TEAMS_ALLOWED_USERS", "TEAMS_HOME_CHANNEL"],
      "google-chat": ["GOOGLE_CHAT_PROJECT_ID GOOGLE_CHAT_SUBSCRIPTION_NAME GOOGLE_CHAT_SERVICE_ACCOUNT_JSON", "GOOGLE_CHAT_ALLOWED_USERS", "GOOGLE_CHAT_HOME_CHANNEL"],
      signal: ["SIGNAL_ACCOUNT SIGNAL_HTTP_URL", "SIGNAL_ALLOWED_USERS", "SIGNAL_HOME_CHANNEL"],
    };
    const homes = { telegram: "555", discord: DISCORD_ID, slack: "C01234ABCDE", mattermost: "abcdefghijklmnopqrstuvwxyz", whatsapp: "15551234567@s.whatsapp.net", teams: "19:abc@thread.tacv2", "google-chat": "spaces/AAAA-bb_1", signal: "+15551234567" };
    const lines = Object.keys(want).map((p) => `( PLATFORM='${p}' HOME_CHANNEL_ID='${homes[p]}'; deploy_validate_inputs >/dev/null 2>&1; echo "NAMES ${p}|$CRED_VARS|$ALLOW_VAR|$HOME_VAR" )\n`).join("");
    const script = assemble([
      "set +e\n",
      { skill: "hermes-deploy", ids: ["step0#1"], replace: [["\ndeploy_validate_inputs || exit 1\n", "\n"], [ROUTE_GATE, ""]] },
      lines,
    ]);
    await scenario({ name: "dep-names", script, env: baseEnv }, async (run) => {
      for (const [p, [cred, allow, home]] of Object.entries(want)) assert.ok(run.out.includes(`NAMES ${p}|${cred}|${allow}|${home}\n`), `${p}: ${run.out}`);
    });
  });
});

describe("hermes-deploy: Step 4 version gate (before the first write)", { concurrency: 6 }, () => {
  const step4 = assemble(["set +e\n", { skill: "hermes-deploy", ids: ["step0#1", "step4#1"] }, SCRIPT_END]);
  const banner = (v) => (sb) => sb.write(".local/bin/hermes", `#!/bin/bash\necho '${v}'\n`, 0o755);

  it("accepts the 0.22.5 banner and takes the deploy snapshot", async () => {
    await scenario({ name: "dep-v-ok", seed, script: step4, env: baseEnv }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy"));
    });
  });

  for (const v of ["hermes 0.15.2", "Hermes Agent v0.21.6 (2026.9.1)", "Hermes Agent v0.22.50", "Hermes Agent v10.22.5", "hermes version unknown"]) {
    it(`refuses the banner ${JSON.stringify(v)} before any snapshot or write`, async () => {
      await scenario({ name: "dep-v-bad", seed, script: step4, env: baseEnv, setup: banner(v) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /ABORT: .*0\.22\.5/);
        assert.ok(!run.sb.exists(".hermes/.hstack-backup"), "no snapshot directory");
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
      });
    });
  }

  it("an unreadable version (command fails) aborts too", async () => {
    await scenario({ name: "dep-v-fail", seed, script: step4, env: baseEnv, knobs: { "fail.version": true } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT:/);
      assertStateIdentical(run);
    });
  });

  it("a wrong HERMES_VERSION never reaches a remote call (Step 0 refuses)", async () => {
    const only = assemble(["set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] }, SCRIPT_END]);
    await scenario({ name: "dep-v-env", script: only, env: { ...baseEnv, HERMES_VERSION: "0.15.2" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.equal(run.sb.sshCalls().length, 0);
    });
  });
});
