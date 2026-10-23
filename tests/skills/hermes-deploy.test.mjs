// hermes-deploy: variable transport to the VPS, input validation, the open-bot gate, and the
// COMPOSITION with the delegated skills (/hermes-model, /platform-telegram) that all run in ONE shell and
// each redefine the generic helper names. The real SKILL.md blocks run against a simulated VPS.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, writeEvents } from "./helpers/asserts.mjs";
import { assemble } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

// A Discord-shaped numeric id, built at run time (no id-shaped literal in the repo).
const DISCORD_ID = "1".repeat(18);
const SSH_CHECK = "confirm-ssh-access-before-doing-anything#1";
const ROUTE_GATE = '[ "$PLATFORM" = telegram ] || { echo "ABORT: this compatibility candidate supports Telegram only; other platform recipes still require native lifecycle migration. Nothing was written."; exit 1; }';
const SSH_ROUTE_GATE = ROUTE_GATE.replace('"$PLATFORM"', '"${PLATFORM:-}"');
const TG = fake.telegram("G");
const OR = fake.openrouter("K");
const OLD_OR = fake.openrouter("O");
const OLD_TG = fake.telegram("O", "987654321");

const baseEnv = {
  FORCE: "1",
  HERMES_VERSION: "0.22.5",
  CANDIDATE_ACKNOWLEDGED: "1",
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

const MODEL_IDS = ["step0#1", "step1#1", "step2#1", "step3#1", "step4#1", "step4#2", "step5.pathA#1", "step5.pathB#1", "step5.pathB#2", "step6#1", "step7#1", "step8#1", "capability-check#1"];
const TG_IDS = ["step0#1", "step1#1", "step2#1", "step3#1", "step4#1", "step5#1", "step5#2", "step6#1", "step7#1", "step8#1", "step9#1"];
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
    D(["step7#1", "step7#2", "step8#1"]),
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
      { skill: "hermes-deploy", ids: ["step7#2"] }, SCRIPT_END,
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
      assert.ok(run.sb.hermesCalls().some(c => c.join(" ") === "gateway install --if-missing --no-start-now"));
      assert.ok(run.sb.hermesCalls().some(c => c.join(" ") === "gateway ensure --json --timeout 60"));
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

  it("Step 9b: 'not running' does not count as running; rollback", async () => {
    await scenario({ name: "dep-9b", seed, valid: [TG], script: compose({ late: `printf 'Gateway: not running\\n' > "$HSTACK_FAKE/knobs/status_override"\n` }), env: baseEnv }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /FAIL: gateway not reported running\. Rolling back\./);
      assertStateIdentical(run);
    });
  });

  it("Step 9b: a nonzero status command cannot finish deployment despite running text", async () => {
    const script = assemble([
      "set +e\n", { skill: "hermes-deploy", ids: ["step0#1"] },
      "deploy_snapshot || exit 2\n",
      'printf "gateway running\\n" > "$HSTACK_FAKE/knobs/status_override"\nprintf 1 > "$HSTACK_FAKE/knobs/status_exit"\n',
      { skill: "hermes-deploy", ids: ["step9#1"] }, SCRIPT_END,
    ]);
    await scenario({ name: "dep-status-error", seed, script, env: baseEnv }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.ok(!run.out.includes("ACTION REQUIRED"));
      assert.match(run.out, /FAIL: gateway not reported running/);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-deploy"));
      assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-deploy.prev"));
    });
  });

  it("Signal home channel is skipped unless CONFIRM_SIGNAL_HOME_CHANNEL=1", async () => {
    const sig = `SIGNAL_ACCOUNT=+15550001111\\nSIGNAL_HTTP_URL=http://127.0.0.1:8080\\nSIGNAL_ALLOWED_USERS=+15551112222\\nOPENROUTER_API_KEY=x\\n`;
    const mk = (extra) => assemble([
      "set +e\n",
      { skill: "hermes-deploy", ids: [SSH_CHECK, "step0#1", "step1#1", "step2#1", "step3#1", "step4#1"], replace: [[ROUTE_GATE, ""], [SSH_ROUTE_GATE, ""]] },
      `remote 'printf "${sig}" >> ~/.hermes/.env; echo soul > ~/.hermes/SOUL.md'\n`,
      { skill: "hermes-deploy", ids: ["step6#1"] }, extra, SCRIPT_END,
    ]);
    const env = { ...baseEnv, PLATFORM: "signal", HOME_CHANNEL_ID: "+15551234567" };
    await scenario({ name: "dep-sig", seed, script: mk(""), env }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /NOTE: SIGNAL_HOME_CHANNEL NOT written/);
      assert.ok(!run.sb.read(".hermes/.env").includes("SIGNAL_HOME_CHANNEL="));
    });
    await scenario({ name: "dep-sig2", seed, script: mk(""), env: { ...env, CONFIRM_SIGNAL_HOME_CHANNEL: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/.env"), /^SIGNAL_HOME_CHANNEL=\+15551234567$/m);
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

  it("per-platform home channel formats", async () => {
    const table = [
      ["telegram", "-1001234567890", true], ["telegram", "555", true], ["telegram", "abc", false],
      ["discord", DISCORD_ID, true], ["discord", "123", false],
      ["slack", "C01234ABCDE", true], ["slack", "c01", false],
      ["mattermost", "abcdefghijklmnopqrstuvwxyz", true],
      ["whatsapp", "15551234567@s.whatsapp.net", true],
      ["teams", "19:abc@thread.tacv2", true],
      ["google-chat", "spaces/AAAA-bb_1", true],
      ["signal", "+15551234567", true], ["signal", "abcdEFGH1234", true], ["signal", "a;b", false],
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
});
