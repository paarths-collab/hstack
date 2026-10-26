// hermes-home: the real SKILL.md blocks against a simulated VPS. `hermes config get|set|unset` and `hermes send` are test doubles
// (stubs/hermes, stub-commands/send.sh) whose behaviour is written from the v0.22.5 output strings quoted in their headers; syntax is
// checked by the real vendored argparse, so a retired flag (`send --home`, `cron run --once`) cannot pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, idx } from "./helpers/asserts.mjs";
import { assemble, loadBlocks, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

const SKILL = "hermes-home";
const HEAD = ["before-you-start#1", "step0#1", "step1#1", "step2#1", "step3#1"];
const ALL = [...HEAD, "step4#1", "step5#1", "step6#1", "step7#1"];
const flow = ({ ids = ALL, replace = [] } = {}) => assemble(["set +e\n", { skill: SKILL, ids, replace }, SCRIPT_END]);

const TOKEN = fake.telegram("H");
const OLD_ENV = `FOO=bar\nTELEGRAM_BOT_TOKEN=${TOKEN}\nOTHER_KEY=keep-me\n`;
const SEED = { env: OLD_ENV, config: "model.default: prior/model\nplatforms.telegram.enabled: true\n" };
const TG = { PLATFORM: "telegram", HOME_CHAT_ID: "-1001234567890" };

const calls = (run) => run.sb.hermesCalls();
const sends = (run) => calls(run).filter((c) => c[0] === "send");
const probeCalls = (run) => sends(run).filter((c) => c[1] === "--to");
const sets = (run) => calls(run).filter((c) => c[0] === "config" && c[1] === "set");
const snapshotDir = ".hermes/.hstack-backup/hermes-home";
const gwEvents = (run) => run.sb.events().filter((e) => /^hermes gateway (restart|stop|run|start)/.test(e));

describe("hermes-home: set the home channel", { concurrency: 3 }, () => {
  it("telegram: snapshot, value over stdin with `--` (negative id), read back, bare-platform probe, no reload by default", async () => {
    await scenario({ name: "home-good", seed: SEED, script: flow(), env: TG, knobs: { strict_negnum: true } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      const text = run.sb.read(".hermes/.env");
      assert.equal((text.match(/^TELEGRAM_HOME_CHANNEL=/gm) || []).length, 1);
      assert.match(text, /^TELEGRAM_HOME_CHANNEL=-1001234567890$/m);
      assert.match(text, /^FOO=bar$/m);
      assert.match(text, /^OTHER_KEY=keep-me$/m);
      assert.equal(run.sb.mode(".hermes/.env"), 0o600);
      assert.equal(run.sb.read(".hermes/config.yaml"), SEED.config, "config.yaml is untouched: a home channel is an env setting");
      const s = sets(run);
      assert.equal(s.length, 1);
      assert.deepEqual(s[0], ["config", "set", "TELEGRAM_HOME_CHANNEL", "--", "-1001234567890"]);
      // order: wired check, read, snapshot, write, read back, probe
      const ev = run.sb.events();
      const iList = idx(ev, /^hermes send-list telegram/), iSet = idx(ev, /^hermes config set/), iProbe = idx(ev, /^hermes send telegram/);
      assert.ok(iList >= 0 && iList < iSet && iSet < iProbe, ev.join("\n"));
      assert.ok(idx(ev, /^hermes config get TELEGRAM_HOME_CHANNEL/, iSet) > iSet, "read back after the write");
      const p = probeCalls(run);
      assert.equal(p.length, 1);
      assert.deepEqual(p[0].slice(0, 3), ["send", "--to", "telegram"], "a bare platform name addresses the home channel");
      assert.match(p[0][3], /^hermes-home probe \d{4}-\d{2}-\d{2}T/);
      assert.match(run.sb.log("send-resolved.log"), /^telegram\t-1001234567890\thermes-home probe /m);
      assert.deepEqual(gwEvents(run), [], "no restart unless RELOAD_GATEWAY is set");
      assert.ok(run.sb.exists(`${snapshotDir}.prev`) && !run.sb.exists(snapshotDir), "finish retired the snapshot");
      assert.ok(!run.sb.log("hermes-profile.log").includes("unbound"));
      // the id travels over stdin: not in any ssh command string; never printed in full
      assert.ok(!run.sb.log("ssh-argv.log").includes("1001234567890"), "the chat id must not be in an ssh command string");
      assert.ok(!run.out.includes("-1001234567890"), "the chat id is printed only as a short prefix");
      assertSecretsNotPrinted(run, [TOKEN]);
    });
  });

  it("each platform writes ITS variable (matrix: MATRIX_HOME_ROOM) and nothing else", async () => {
    const rows = [
      ["telegram", "555", "TELEGRAM_HOME_CHANNEL"], ["discord", "123456789012345678", "DISCORD_HOME_CHANNEL"], ["slack", "C0123ABCD", "SLACK_HOME_CHANNEL"],
      ["mattermost", "abcdefghijklmnopqrstuvwxyz", "MATTERMOST_HOME_CHANNEL"], ["matrix", "!room:example.org", "MATRIX_HOME_ROOM"], ["signal", "+15551234567", "SIGNAL_HOME_CHANNEL"],
      ["whatsapp", "120363@g.us", "WHATSAPP_HOME_CHANNEL"], ["teams", "19:abc@thread.tacv2", "TEAMS_HOME_CHANNEL"], ["google-chat", "spaces/AAAAxyz", "GOOGLE_CHAT_HOME_CHANNEL"],
    ];
    for (const [platform, id, variable] of rows) {
      await scenario({ name: "home-plat", seed: SEED, script: flow(), env: { PLATFORM: platform, HOME_CHAT_ID: id }, files: { "send.platforms": "telegram\ndiscord\nslack\nmattermost\nmatrix\nsignal\nwhatsapp\nteams\ngoogle_chat\n" } }, async (run) => {
        assert.equal(run.code, 0, `${platform}: ${run.out}`);
        const lines = run.sb.read(".hermes/.env").split("\n").filter((l) => /HOME_(CHANNEL|ROOM)=/.test(l));
        assert.deepEqual(lines, [`${variable}=${id}`], platform);
        assert.ok(!run.sb.read(".hermes/.env").includes("MATRIX_HOME_CHANNEL"));
        assert.equal(probeCalls(run)[0][2], platform.replace("-", "_"), "the probe names the platform as Hermes spells it");
      });
    }
  });

  it("already set to the same id: exit 0 with no snapshot, no write and no message; FORCE=1 rewrites and probes again", async () => {
    const seed = { ...SEED, env: `${OLD_ENV}TELEGRAM_HOME_CHANNEL=-1001234567890\n` };
    await scenario({ name: "home-idem", seed, script: flow(), env: TG }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(!run.completed);
      assert.match(run.out, /already set to this id\. Nothing was written/);
      assertStateIdentical(run);
      assert.equal(sets(run).length, 0);
      assert.equal(probeCalls(run).length, 0);
      assert.ok(!run.sb.exists(snapshotDir));
    });
    await scenario({ name: "home-force", seed, script: flow(), env: { ...TG, FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(sets(run).length, 1);
      assert.equal(probeCalls(run).length, 1);
    });
  });

  it("a different existing value is replaced (the old one is only kept in the snapshot)", async () => {
    const seed = { ...SEED, env: `${OLD_ENV}TELEGRAM_HOME_CHANNEL=111\n` };
    await scenario({ name: "home-replace", seed, script: flow(), env: TG }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/.env"), /^TELEGRAM_HOME_CHANNEL=-1001234567890$/m);
      assert.doesNotMatch(run.sb.read(".hermes/.env"), /=111$/m);
      assert.match(run.sb.read(`${snapshotDir}.prev/.env`), /^TELEGRAM_HOME_CHANNEL=111$/m);
      assert.equal(run.sb.mode(`${snapshotDir}.prev/.env`), 0o600);
    });
  });

  it("the dry run says a real message will be sent, shows only a prefix of the id, and writes nothing", async () => {
    await scenario({ name: "home-dry", seed: SEED, script: flow({ ids: [...HEAD, "step4#1"] }), env: TG }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /DRY RUN/);
      assert.match(run.out, /Write TELEGRAM_HOME_CHANNEL \(length 14, starts '-10'\)/);
      assert.match(run.out, /Send ONE real probe message to the telegram home channel/);
      assert.match(run.out, /everyone in that chat will see it/);
      assert.match(run.out, /No gateway reload/);
      assert.ok(!run.out.includes("-1001234567890"));
      assertStateIdentical(run);
    });
  });
});

describe("hermes-home: input validation and the wired gate come before any write", { concurrency: 4 }, () => {
  const refuse = (name, env, re, files) =>
    it(name, async () => {
      await scenario({ name: "home-bad", seed: SEED, script: flow(), env: { ...TG, ...env }, files }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, re);
        assert.match(run.out, /Nothing was written\./);
        assertStateIdentical(run);
        assert.equal(sets(run).length, 0);
        assert.equal(probeCalls(run).length, 0);
        assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      });
    });
  refuse("unknown platform", { PLATFORM: "irc" }, /PLATFORM must be telegram, discord/);
  refuse("telegram: a username instead of a number", { HOME_CHAT_ID: "@mychannel" }, /Telegram id is a number/);
  refuse("telegram: letters", { HOME_CHAT_ID: "12ab" }, /Telegram id is a number/);
  refuse("discord: the channel name", { PLATFORM: "discord", HOME_CHAT_ID: "general" }, /Discord channel id is the numeric snowflake/, { "send.platforms": "discord\n" });
  refuse("slack: #name", { PLATFORM: "slack", HOME_CHAT_ID: "#general" }, /Slack home must be a channel id/, { "send.platforms": "slack\n" });
  refuse("mattermost: a channel name", { PLATFORM: "mattermost", HOME_CHAT_ID: "town-square" }, /26 lowercase letters/, { "send.platforms": "mattermost\n" });
  refuse("matrix: not a room id", { PLATFORM: "matrix", HOME_CHAT_ID: "myroom" }, /Matrix room id looks like/, { "send.platforms": "matrix\n" });
  refuse("a value with a space", { HOME_CHAT_ID: "123 456" }, /characters an id never contains/);
  refuse("a value with a quote", { HOME_CHAT_ID: "123'456" }, /characters an id never contains/);
  it("a platform that is not wired stops the run (hermes send --list PLATFORM exits 1)", async () => {
    await scenario({ name: "home-unwired", seed: { env: "FOO=bar\n", config: "x: 1\n" }, script: flow(), env: TG }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /telegram is not wired .*Run \/platform-telegram first/);
      assertStateIdentical(run);
      assert.equal(sets(run).length, 0);
    });
  });
  it("a Hermes that is not 0.22.5 stops at the version gate", async () => {
    await scenario({ name: "home-version", seed: SEED, script: flow(), env: TG, files: { "hermes.version": "hermes 0.22.4\n" } }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /source-verified for Hermes 0\.22\.5 only/);
      assertStateIdentical(run);
    });
  });
});

describe("hermes-home: verify-only mode (the chat did /sethome; no id given)", { concurrency: 3 }, () => {
  it("reads the stored value, sends one probe, writes and snapshots nothing", async () => {
    const seed = { ...SEED, env: `${OLD_ENV}TELEGRAM_HOME_CHANNEL=777000111\n` };
    await scenario({ name: "home-verify", seed, script: flow(), env: { PLATFORM: "telegram" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /verify only: TELEGRAM_HOME_CHANNEL is set \(length 9, starts '777'\)/);
      assertStateIdentical(run);
      assert.equal(sets(run).length, 0);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      assert.equal(probeCalls(run).length, 1);
      assert.match(run.sb.log("send-resolved.log"), /^telegram\t777000111\t/m);
      assert.ok(!run.out.includes("777000111"));
    });
  });
  it("nothing set: stops and says how to set it, including Slack's namespaced command", async () => {
    await scenario({ name: "home-verify-none", seed: SEED, script: flow(), env: { PLATFORM: "slack" }, files: { "send.platforms": "slack\n" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /no home channel is set for slack \(SLACK_HOME_CHANNEL\)\. Type \/sethome in the target chat \(Slack: \/hermes sethome\)/);
      assertStateIdentical(run);
      assert.equal(probeCalls(run).length, 0);
    });
  });
  it("a verify-only probe failure exits 1 and has nothing to roll back", async () => {
    const seed = { ...SEED, env: `${OLD_ENV}TELEGRAM_HOME_CHANNEL=777000111\n` };
    await scenario({ name: "home-verify-fail", seed, script: flow(), env: { PLATFORM: "telegram" }, knobs: { "fail.send": true } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: the probe was not delivered/);
      assertStateIdentical(run);
      assert.deepEqual(gwEvents(run), [], "no rollback, so no gateway restart");
    });
  });
});

describe("hermes-home: failures restore the previous state", { concurrency: 3 }, () => {
  it("a probe that is not delivered restores .env byte for byte (an old value comes back) and reloads the gateway through the rollback", async () => {
    const seed = { ...SEED, env: `${OLD_ENV}TELEGRAM_HOME_CHANNEL=111\n` };
    await scenario({ name: "home-probe-fail", seed, script: flow(), env: TG, knobs: { "fail.send": true } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: the probe was not delivered \(hermes send exit 1\)/);
      assert.match(run.out, /rollback: restored ~\/\.hermes\/\.env and config\.yaml/);
      assertStateIdentical(run, "the previous .env and config.yaml are back");
      assert.match(run.sb.read(".hermes/.env"), /^TELEGRAM_HOME_CHANNEL=111$/m);
      assert.ok(gwEvents(run).includes("hermes gateway restart"), "rollback reloads through gw_reload");
      assert.ok(run.sb.exists(`${snapshotDir}.prev`));
    });
  });
  it("with no previous value the variable is gone again (not left empty)", async () => {
    await scenario({ name: "home-probe-fail2", seed: SEED, script: flow(), env: TG, knobs: { "fail.send": true } }, async (run) => {
      assert.equal(run.code, 1);
      assert.doesNotMatch(run.sb.read(".hermes/.env"), /HOME_CHANNEL/);
      assertStateIdentical(run);
    });
  });
  it("a failing write rolls back (nothing half-written)", async () => {
    await scenario({ name: "home-write-fail", seed: SEED, script: flow(), env: TG, knobs: { "fail.set.TELEGRAM_HOME_CHANNEL": true } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: could not write TELEGRAM_HOME_CHANNEL/);
      assertStateIdentical(run);
      assert.equal(probeCalls(run).length, 0, "no message is sent for a value that was not stored");
    });
  });
  it("a probe that resolves to a DIFFERENT id is reported (another source is winning) but is not a failure", async () => {
    await scenario({ name: "home-other-id", seed: SEED, script: flow(), env: TG, knobs: { send_other_id: "999" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /WARN: the probe resolved to a different id than TELEGRAM_HOME_CHANNEL holds/);
    });
  });
  it("SKIP_PROBE sends nothing and says delivery is not proven", async () => {
    await scenario({ name: "home-skip", seed: SEED, script: flow(), env: { ...TG, SKIP_PROBE: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(probeCalls(run).length, 0);
      assert.match(run.out, /WARN: probe skipped: delivery to the telegram home channel is NOT proven/);
    });
  });
});

describe("hermes-home: gateway reload is opt-in and never forced", { concurrency: 3 }, () => {
  it("RELOAD_GATEWAY=1 restarts natively (restart --detach, ensure --json) BEFORE the probe", async () => {
    await scenario({ name: "home-reload", seed: SEED, script: flow(), env: { ...TG, RELOAD_GATEWAY: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /OK: gateway reloaded/);
      const ev = run.sb.events();
      assert.ok(idx(ev, /^hermes gateway restart/) > idx(ev, /^hermes config set/));
      assert.ok(idx(ev, /^hermes gateway restart/) < idx(ev, /^hermes send telegram/));
      assert.ok(!calls(run).some((c) => c[0] === "gateway" && /(^| )(-y|--yes|--force|--all)( |$)/.test(c.join(" "))));
    });
  });
  it("a reload refused because of live sessions restores the files, is not overridden, and keeps the snapshot", async () => {
    await scenario({ name: "home-reload-live", seed: SEED, script: flow(), env: { ...TG, RELOAD_GATEWAY: "1" }, knobs: { live_sessions: true } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: gateway did not restart ready/);
      assert.match(run.out, /rollback: files restored, but the gateway did NOT come back ready/);
      assertStateIdentical(run, "files are restored even though the reload was refused");
      assert.ok(run.sb.exists(snapshotDir), "the recovery point is kept for a retry");
      assert.equal(probeCalls(run).length, 0);
      assert.ok(!calls(run).some((c) => c[0] === "gateway" && c.includes("-y")));
    });
  });
});

describe("hermes-home: static facts about the text", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const code = loadBlocks(SKILL).map((b) => b.code).join("\n");
  it("none of the retired commands survives: `config show` readback, `send --home`, `cron run --once`, stop/run reload", () => {
    assert.doesNotMatch(code, /config show|send --home|cron run|--once|gateway stop|gateway run/);
    assert.doesNotMatch(text, /does NOT survive a gateway restart|lives in process memory/i);
  });
  it("the false premise is corrected: /sethome persists (config.yaml and env), Slack uses /hermes sethome, Matrix uses MATRIX_HOME_ROOM", () => {
    assert.match(text, /`\/sethome` persists/);
    assert.match(text, /\/hermes sethome/);
    assert.match(text, /MATRIX_HOME_ROOM/);
  });
  it("it cites its sources and states what was not verified", () => {
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /hermes_cli\/send_cmd\.py/);
    assert.match(text, /gateway\/slash_commands\.py:659-701/);
    assert.match(text, /Not verified: nothing here was run against a real Hermes or a real chat/);
  });
  it("the chat id only travels over stdin: the write block never puts it on a command line", () => {
    const write = loadBlocks(SKILL).find((b) => b.id === "step5#1").code;
    assert.match(write, /printf '%s\\n' "\$HOME_CHAT_ID" \\\n\s*\| remote "IFS= read -r v && hermes -p default config set \$HOME_VAR -- \\"\\\$v\\" >\/dev\/null/);
  });
});

describe("hermes-home: mutation controls (each guard is load-bearing)", { concurrency: 3 }, () => {
  const control = (name, ids, replace, opts, check) =>
    it(name, async () => {
      mustReplace({ skill: SKILL, ids, replace });
      await scenario({ name: "home-ctl", seed: opts.seed || SEED, script: flow({ replace }), env: opts.env, files: opts.files, knobs: opts.knobs }, check);
    });

  control("without `--` a negative Telegram id is parsed as an option", ["step5#1"], [[" -- \\\"\\$v\\\"", " \\\"\\$v\\\""]], { env: TG, knobs: { strict_negnum: true } }, async (run) => {
    assert.equal(run.code, 1, "control applied: the write fails");
    assert.match(run.out, /FAIL: could not write/);
  });
  control("with the wrong variable name for Matrix nothing Hermes reads is set", ["step2#1"], [["matrix) HOME_VAR=MATRIX_HOME_ROOM ;;", "matrix) HOME_VAR=MATRIX_HOME_CHANNEL ;;"]],
    { env: { PLATFORM: "matrix", HOME_CHAT_ID: "!r:example.org" }, files: { "send.platforms": "matrix\n" } }, async (run) => {
      assert.equal(run.code, 1, "control applied: Hermes finds no home channel under the wrong name, so the probe fails");
      assert.match(run.out, /No home channel set for matrix .*MATRIX_HOME_ROOM/);
    });
  control("without the wired gate a platform that is not configured gets a variable written", ["step2#1"], [['remote "hermes -p default send --list $PLATFORM" >/dev/null 2>&1 \\', "true \\"]],
    { env: TG, seed: { env: "FOO=bar\n", config: "x: 1\n" } }, async (run) => {
      assertStateChanged(run);
      assert.equal(sets(run).length, 1, "control applied");
    });
  control("without the rollback a failed probe leaves the new value behind", ["step7#1"], [["    [ \"$MODE\" = set ] && rollback\n    exit 1", "    exit 1"]],
    { env: TG, knobs: { "fail.send": true } }, async (run) => {
      assert.match(run.sb.read(".hermes/.env"), /^TELEGRAM_HOME_CHANNEL=-1001234567890$/m, "control applied: the value stayed");
    });
  control("without the idempotency check a repeat run rewrites and re-sends", ["step3#1"], [['[ "$CURRENT" = "$HOME_CHAT_ID" ] &&', "false &&"]],
    { env: TG, seed: { ...SEED, env: `${OLD_ENV}TELEGRAM_HOME_CHANNEL=-1001234567890\n` } }, async (run) => {
      assert.equal(sets(run).length, 1, "control applied: it wrote again");
    });
});
