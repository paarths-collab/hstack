// platform-telegram: the real SKILL.md blocks against a simulated VPS (helpers/sandbox.mjs).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, curlEvents, idx, writeEvents } from "./helpers/asserts.mjs";
import { assemble, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

const SKILL = "platform-telegram";
const GOOD = fake.telegram("G");
const OLD = fake.telegram("O", "987654321");
const FLOW = ["step1#1", "step2#1", "step3#1", "step4#1", "step5#1", "step5#2", "step6#1", "step7#1", "step8#1", "step9#1"];

const flow = ({ ids = FLOW, replace = [] } = {}) =>
  assemble(["set +e\n", { skill: SKILL, ids: ["before-you-start#1", "step0#1"], replace }, { skill: SKILL, ids, replace }, SCRIPT_END]);
const gate = assemble(["set +e\n", { skill: SKILL, ids: ["step0#1", "step3#1"] }, SCRIPT_END]);

const env = (over = {}) => ({ TELEGRAM_BOT_TOKEN: GOOD, TELEGRAM_ALLOWED_USERS: "555", ...over });
const oldState = {
  env: `FOO=bar\nTELEGRAM_BOT_TOKEN=${OLD}\nTELEGRAM_ALLOWED_USERS=111\nOTHER_KEY=keep-me\n`,
  config: "model.default: old/model\nplatforms.telegram.enabled: true\n",
};
const gwEvents = (run) => run.sb.events().filter((e) => /^hermes gateway /.test(e));
const writeKeys = (run) => run.sb.events().filter((e) => e.startsWith("hermes config set ")).map((e) => e.slice("hermes config set ".length));

describe("platform-telegram: good run", { concurrency: 6 }, () => {
  it("preflight getMe carries the EXPANDED token, comes before any write; allowlist, home channel, token land in .env (600)", async () => {
    await scenario({ name: "tg-good", valid: [GOOD], script: flow(), env: env({ TELEGRAM_HOME_CHANNEL: "-1001234567890" }), knobs: { strict_negnum: true } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      const curls = run.sb.curlCalls();
      assert.equal(curls.length, 2, "preflight and post-write getMe");
      for (const c of curls) {
        assert.equal(c.url, "https://api.telegram.org/bot<TOKEN>/getMe");
        assert.equal(Number(c.token_len), GOOD.length, "getMe URL must contain the real token, not an escaped variable name");
        assert.equal(c.token_has_dollar, "0");
        assert.equal(c.status, "200");
        assert.equal(c.argv_has_token, "0");
      }
      const ev = run.sb.events();
      const firstCurl = idx(ev, /^curl status=200/);
      const firstWrite = idx(ev, /^hermes config set/);
      assert.ok(firstCurl >= 0 && firstCurl < firstWrite, "getMe must happen before the first write");
      // order: allowlist, home channel, token LAST, then the enable flag
      assert.deepEqual(writeKeys(run), ["TELEGRAM_ALLOWED_USERS", "TELEGRAM_HOME_CHANNEL", "TELEGRAM_BOT_TOKEN", "platforms.telegram.enabled"]);
      const text = run.sb.read(".hermes/.env");
      assert.match(text, /^TELEGRAM_ALLOWED_USERS=555$/m);
      assert.match(text, /^TELEGRAM_HOME_CHANNEL=-1001234567890$/m, "a negative id needs the `--` separator");
      assert.match(text, new RegExp(`^TELEGRAM_BOT_TOKEN=${GOOD}$`, "m"));
      assert.equal(run.sb.mode(".hermes/.env"), 0o600);
      assert.match(run.sb.read(".hermes/config.yaml"), /^platforms\.telegram\.enabled: true$/m);
      assert.ok(!run.sb.read(".hermes/config.yaml").includes(GOOD));
      // gateway: ONE native reload (probe ensure, restart --detach, ensure until ready). No stop, no foreground run, and no second
      // "nudge" cycle: the retired folk-lore cycle has no basis in the v0.22.5 adapter source.
      assert.deepEqual(gwEvents(run), ["hermes gateway ensure", "hermes gateway restart", "hermes gateway ensure"]);
      assert.ok(run.sb.hermesCalls().some((c) => c.join(" ") === "gateway restart --detach"), "restart must be detached");
      assert.ok(!run.sb.hermesCalls().some((c) => c.some((x) => ["-y", "--yes", "--force", "--all", "--interrupt"].includes(x))), "no interruption flag by default");
      assert.doesNotMatch(run.out, /POST-SETUP NUDGE|Post-setup nudge|second stop/i);
      assert.match(run.out, /gateway restart --detach/, "the dry run names the real reload command");
      assert.ok(!text.includes("TELEGRAM_ENABLED") && !text.includes("ALLOWED_CHATS"));
      assert.match(run.out, /Token OK: bot is @fake_test_bot/);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-telegram.prev"));
      assertNoSecretInArgv(run, [GOOD]);
      assertSecretsNotPrinted(run, [GOOD]);
    });
  });

  it("native smoke: with a home channel the skill sends ONE message with `hermes send --to telegram` and lists pairing (read-only)", async () => {
    await scenario({ name: "tg-send", valid: [GOOD], script: flow(), env: env({ TELEGRAM_HOME_CHANNEL: "555" }), files: { "pairing.out": "\n  Approved Users (1):\n  telegram     777                  mallory\n" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      const sends = run.sb.hermesCalls().filter((c) => c[0] === "send");
      assert.equal(sends.length, 1, "exactly one smoke message");
      assert.deepEqual(sends[0].slice(0, 3), ["send", "--to", "telegram"], "the home channel is addressed by platform name only");
      assert.ok(run.sb.events().includes("hermes send telegram"));
      // the pairing store is a SECOND way in (a union with the allowlist): the operator must be shown who is approved there
      assert.ok(run.sb.events().includes("hermes pairing list"));
      assert.match(run.out, /Approved Users/);
      assert.match(run.out, /pairing store|union/i);
      assert.ok(!run.sb.hermesCalls().some((c) => c[0] === "pairing" && c[1] !== "list"), "never approve/revoke/clear on the user's behalf");
      // order: the message is sent after the gateway is ready and after the snapshot was retired
      const ev = run.sb.events();
      assert.ok(idx(ev, /^hermes send/) > ev.lastIndexOf("hermes gateway restart"));
    });
  });

  it("native smoke: no home channel means no `hermes send` call (nothing to address)", async () => {
    await scenario({ name: "tg-nosend", valid: [GOOD], script: flow(), env: env(), }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(!run.sb.hermesCalls().some((c) => c[0] === "send"));
      assert.match(run.out, /TELEGRAM_HOME_CHANNEL.*(not set|none)|no home channel/i);
    });
  });

  it("a failing `hermes send` is a WARN, not a rollback: wiring is already proven by the gateway log", async () => {
    await scenario({ name: "tg-send-fail", valid: [GOOD], script: flow(), env: env({ TELEGRAM_HOME_CHANNEL: "555" }), knobs: { "fail.send": true } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /WARN: hermes send .*failed/);
      assert.ok(run.completed);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-telegram.prev"));
      assert.match(run.sb.read(".hermes/.env"), /^TELEGRAM_BOT_TOKEN=/m);
    });
  });

  it("Step 1 is a version gate: a banner that does not name 0.22.5 aborts with nothing written and no vendor call", async () => {
    await scenario({
      name: "tg-version", valid: [GOOD], script: flow(), env: env(),
      setup: (sb) => sb.write(".local/bin/hermes", sb.read(".local/bin/hermes").replace('echo "hermes 0.22.5"', 'echo "hermes 0.22.4"'), 0o755),
    }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: .*0\.22\.5 only \(got: hermes 0\.22\.4\)\. Nothing was written/);
      assert.deepEqual(writeEvents(run), []);
      assert.equal(run.sb.curlCalls().length, 0);
      assertStateIdentical(run);
    });
  });

  it("CONTROL: the stub replacement used by the version-gate test really changes the banner", async () => {
    await scenario({
      name: "tg-version-ctl", script: "export PATH=\"$HOME/.local/bin:$PATH\"; hermes -p default --version\n",
      setup: (sb) => sb.write(".local/bin/hermes", sb.read(".local/bin/hermes").replace('echo "hermes 0.22.5"', 'echo "hermes 0.22.4"'), 0o755),
    }, async (run) => {
      assert.match(run.out, /0\.22\.4/);
    });
  });

  it("the connect scan only reads log lines since the reload (`logs gateway --since Ns`), so an older success cannot satisfy it", async () => {
    // The stub's `logs` ignores --since; what is asserted is the call shape that makes the real command filter by time.
    await scenario({ name: "tg-since", valid: [GOOD], script: flow(), env: env() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      const logCalls = run.sb.hermesCalls().filter((c) => c[0] === "logs" && c[1] === "gateway");
      assert.ok(logCalls.length >= 2, "scan + final redacted tail");
      const scan = logCalls[0];
      const i = scan.indexOf("--since");
      assert.ok(i > 0, `the connect scan must pass --since: ${scan.join(" ")}`);
      assert.match(scan[i + 1], /^\d+s$/);
      assert.ok(Number(scan[i + 1].slice(0, -1)) < 600, "a window of minutes, not the whole log");
    });
  });

  it("allowlist normalisation: whitespace and empty entries are dropped", async () => {
    await scenario({ name: "tg-ws", valid: [GOOD], script: flow(), env: env({ TELEGRAM_ALLOWED_USERS: " 555 , 666,, " }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/.env"), /^TELEGRAM_ALLOWED_USERS=555,666$/m);
    });
  });

  it("TELEGRAM_ALLOWED_CHATS is never written anywhere", async () => {
    await scenario({ name: "tg-chats", valid: [GOOD], script: flow(), env: env({ TELEGRAM_ALLOWED_CHATS: "-1001234567890,-100999", TELEGRAM_HOME_CHANNEL: "-1001234567890" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(!run.sb.read(".hermes/.env").includes("ALLOWED_CHATS"));
      assert.ok(!run.sb.log("hermes-argv.log").includes("ALLOWED_CHATS"));
      assert.ok(!run.out.includes("ALLOWED_CHATS"));
    });
  });

  it("an explicit platforms.telegram.enabled failure is only a WARN", async () => {
    await scenario({ name: "tg-flag", valid: [GOOD], script: flow(), env: env(), knobs: { "fail.set.platforms.telegram.enabled": true } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /WARN: could not set platforms\.telegram\.enabled/);
      assert.ok(run.completed);
    });
  });

  it("already wired (token + allowlist present) without FORCE: exits 0 with no vendor call", async () => {
    await scenario({ name: "tg-idem", seed: oldState, valid: [GOOD], script: flow(), env: env() }, async (run) => {
      assert.equal(run.code, 0);
      assert.match(run.out, /already wired/i);
      assert.ok(!run.completed);
      assertStateIdentical(run);
      assert.equal(run.sb.curlCalls().length, 0);
    });
  });
  for (const [label, lines, mode] of [
    ["wildcard after a numeric ID", "TELEGRAM_ALLOWED_USERS=111,*\n"],
    ["malformed user ID", "TELEGRAM_ALLOWED_USERS=111,alice\n"],
    ["duplicate allowlist", "TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_ALLOWED_USERS=222\n"],
    ["gateway open-access override", "TELEGRAM_ALLOWED_USERS=111\nGATEWAY_ALLOW_ALL_USERS=true\n"],
    ["group-wide authorization", "TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_ALLOWED_CHATS=-100123456\n"],
    ["exported open-access override", "TELEGRAM_ALLOWED_USERS=111\nexport TELEGRAM_ALLOW_ALL_USERS=1\n"],
    ["duplicate token", `TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_BOT_TOKEN=${OLD}\n`],
    ["world-readable env", "TELEGRAM_ALLOWED_USERS=111\n", 0o644],
    ["wildcard in the global allowlist (GATEWAY_ALLOWED_USERS admits everyone)", "TELEGRAM_ALLOWED_USERS=111\nGATEWAY_ALLOWED_USERS=*\n"],
    ["wildcard in the group-sender allowlist", "TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_ALLOWED_USERS=222,*\n"],
  ]) {
    it(`already wired with ${label}: aborts before reporting success, no vendor call or write`, async () => {
      const seed = { env: `TELEGRAM_BOT_TOKEN=${OLD}\n${lines}`, envMode: mode ?? 0o600 };
      await scenario({ name: "tg-idem-unsafe", seed, valid: [GOOD], script: flow(), env: env() }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /stored Telegram setup is unsafe/);
        assert.ok(!run.out.includes("already wired"));
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
        assertSecretsNotPrinted(run, [OLD, GOOD]);
      });
    });
  }

  it("stored quoted allowlist and explicit off switches retain the safe idempotency path", async () => {
    const seed = { env: `TELEGRAM_BOT_TOKEN="${OLD}"\nTELEGRAM_ALLOWED_USERS='111,222'\nGATEWAY_ALLOW_ALL_USERS=false\n` };
    await scenario({ name: "tg-idem-quoted", seed, valid: [GOOD], script: flow(), env: env() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /already wired/i);
      assertStateIdentical(run);
      assert.equal(run.sb.curlCalls().length, 0);
    });
  });
});

describe("platform-telegram: hard gate", { concurrency: 6 }, () => {
  it("bad token (getMe 401): ABORT, state byte-identical, no snapshot, no write", async () => {
    await scenario({ name: "tg-bad", seed: oldState, valid: [OLD], script: flow(), env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /ABORT: Telegram getMe .* did not accept the token/);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      assert.equal(curlEvents(run).length, 1);
    });
  });

  it("VPS cannot reach Telegram: ABORT, nothing written", async () => {
    await scenario({ name: "tg-net", valid: [GOOD], knobs: { net_down: true }, script: flow(), env: env() }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /ABORT: Telegram getMe/);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  // Allowlist problems are caught before ANY ssh or curl call (the gate-only script runs Step 3 only).
  for (const [label, users, msg] of [
    ["empty", "", /TELEGRAM_ALLOWED_USERS is empty/],
    ["only separators", " , ,", /TELEGRAM_ALLOWED_USERS is empty/],
    ["*", "*", /contains a wildcard/],
    ["555,*", "555,*", /contains a wildcard/],
    ["*,555", "*,555", /contains a wildcard/],
    ["@alice", "@alice", /invalid entries in TELEGRAM_ALLOWED_USERS/],
    ["negative id", "-100123", /invalid entries/],
    ["command injection", '555; touch "$HOME/pwned"', /invalid entries/],
    ["command substitution", '$(touch "$HOME/pwned")', /invalid entries/],
  ]) {
    it(`allowlist ${JSON.stringify(label)} is refused before any ssh/curl`, async () => {
      await scenario({ name: "tg-allow", valid: [GOOD], script: gate, env: env({ TELEGRAM_ALLOWED_USERS: users }) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /Nothing was written/);
        assert.equal(run.sb.sshCalls().length, 0);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }

  for (const [label, home, msg] of [
    ["several ids", "1,2", /takes ONE chat ID/],
    ["injection", '-1; touch "$HOME/pwned"', /invalid entries in TELEGRAM_HOME_CHANNEL/],
    ["not a number", "abc", /invalid entries in TELEGRAM_HOME_CHANNEL/],
  ]) {
    it(`home channel ${JSON.stringify(label)} is refused before any ssh/curl`, async () => {
      await scenario({ name: "tg-home", valid: [GOOD], script: gate, env: env({ TELEGRAM_HOME_CHANNEL: home }) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.equal(run.sb.sshCalls().length, 0);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }

  for (const [label, token] of [
    ["double quote", `${GOOD}"x`],
    ["command substitution", `${GOOD}$(touch "$HOME/pwned")`],
    ["newline", `${GOOD}\nX=1`],
    ["space", `${GOOD} x`],
    ["only the part before the colon", "123456789"],
    ["too short", "123456789:short"],
    ["empty", ""],
  ]) {
    it(`token ${JSON.stringify(label)} is refused without any vendor call or write`, async () => {
      await scenario({ name: "tg-tok", valid: [GOOD], script: flow(), env: env({ TELEGRAM_BOT_TOKEN: token }) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /ABORT: TELEGRAM_BOT_TOKEN/);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.deepEqual(writeEvents(run), []);
        assert.ok(!run.sb.exists("pwned"));
        assert.ok(!run.sb.sshCalls().some((c) => token.length > 8 && c.includes(token)));
      });
    });
  }

  // Open-access switches already in the VPS .env make the allowlist meaningless.
  for (const line of ["TELEGRAM_ALLOW_ALL_USERS=true", "GATEWAY_ALLOW_ALL_USERS=1", "TELEGRAM_ALLOW_ALL_USERS=yes", "GATEWAY_ALLOW_ALL_USERS=TRUE", 'GATEWAY_ALLOW_ALL_USERS="true"', "TELEGRAM_ALLOW_ALL_USERS='yes'", "TELEGRAM_ALLOW_ALL_USERS=anything-else", "export GATEWAY_ALLOW_ALL_USERS=true", "export TELEGRAM_ALLOW_ALL_USERS=1", " GATEWAY_ALLOW_ALL_USERS = true"]) {
    it(`pre-existing ${line} aborts before any write`, async () => {
      const seed = { env: `FOO=bar\n${line}\n` };
      await scenario({ name: "tg-open", seed, valid: [GOOD], script: flow(), env: env() }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /turns on open access \((TELEGRAM|GATEWAY)_ALLOW_ALL_USERS\)/);
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });
  }
  for (const line of ["TELEGRAM_GROUP_ALLOWED_CHATS=-100123456", "export TELEGRAM_GROUP_ALLOWED_CHATS='-100123456'"]) {
    it(`a forced rewire refuses pre-existing group-wide grant ${line}`, async () => {
      await scenario({ name: "tg-group", seed: { ...oldState, env: oldState.env + line + "\n" }, valid: [GOOD], script: flow(), env: env({ FORCE: "1" }) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /turns on open access \(TELEGRAM_GROUP_ALLOWED_CHATS\)/);
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });
  }
  // Source: gateway/authz_mixin.py unions TELEGRAM_ALLOWED_USERS, TELEGRAM_GROUP_ALLOWED_USERS and GATEWAY_ALLOWED_USERS and honours a "*"
  // in the union, so a wildcard in ANY of them defeats the per-user allowlist this skill writes.
  for (const line of ["GATEWAY_ALLOWED_USERS=*", "GATEWAY_ALLOWED_USERS=111,*", "TELEGRAM_GROUP_ALLOWED_USERS=*", "export TELEGRAM_GROUP_ALLOWED_USERS='222, *'"]) {
    it(`pre-existing wildcard ${line} aborts before any write`, async () => {
      await scenario({ name: "tg-wild", seed: { env: `FOO=bar\n${line}\n` }, valid: [GOOD], script: flow(), env: env() }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /turns on open access \((GATEWAY_ALLOWED_USERS|TELEGRAM_GROUP_ALLOWED_USERS)\)/);
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });
  }
  it("a non-wildcard GATEWAY_ALLOWED_USERS / TELEGRAM_GROUP_ALLOWED_USERS is not open access and does not block", async () => {
    await scenario({ name: "tg-listed", seed: { env: "GATEWAY_ALLOWED_USERS=111\nTELEGRAM_GROUP_ALLOWED_USERS=222\n" }, valid: [GOOD], script: flow(), env: env() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
    });
  });
  for (const lines of ["TELEGRAM_ALLOW_ALL_USERS=false\nGATEWAY_ALLOW_ALL_USERS=0\n", "GATEWAY_ALLOW_ALL_USERS=off\nTELEGRAM_ALLOW_ALL_USERS=no\n"]) {
    it(`explicitly-off switches (${lines.trim().split("\n").join(", ")}) do not block`, async () => {
      await scenario({ name: "tg-off", seed: { env: lines }, valid: [GOOD], script: flow(), env: env() }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.completed);
      });
    });
  }

  it("a leftover snapshot makes snapshot refuse; nothing is written", async () => {
    await scenario({ name: "tg-left", seed: oldState, valid: [GOOD], script: flow(), env: env({ FORCE: "1" }), setup: (sb) => sb.write(".hermes/.hstack-backup/platform-telegram/.env", "junk\n") }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /did not finish/);
      assert.match(run.out, /ABORT: could not snapshot/);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
    });
  });
});

describe("platform-telegram: connect evidence in the gateway log", { concurrency: 6 }, () => {
  // Source: plugins/platforms/telegram/adapter.py logs "Connected to Telegram (polling mode)" at WARNING only after the cold-start
  // readiness gate saw a successful getUpdates (adapter.py:1941-2027, 3231), so that line is the evidence that the bot is polling.
  it("the real upstream connect line is accepted", async () => {
    const logs = "[Telegram] Connecting to Telegram (attempt 1/8)\u2026\n[Telegram] Cold boot: dropping Telegram updates queued while offline (platforms.telegram.extra.drop_pending_on_cold_boot: true)\n[Telegram] Connected to Telegram (polling mode)\n";
    await scenario({ name: "tg-log-ok", valid: [GOOD], script: flow(), env: env(), files: { "logs.txt": logs } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /OK: Telegram connected/);
    });
  });
  it("connecting / conflict lines alone (e.g. another process polls the same token) are not a connected bot: rolled back", async () => {
    const logs = "[Telegram] Connecting to Telegram (attempt 1/8)\u2026\n[Telegram] Telegram polling bootstrap conflict; gateway stays alive while conflict retry runs: Conflict: terminated by other getUpdates request\n";
    await scenario({ name: "tg-log-conflict", seed: oldState, valid: [GOOD, OLD], script: flow(), env: env({ FORCE: "1" }), files: { "logs.txt": logs } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /did not appear in gateway logs/);
      assert.ok(!run.out.includes("OK: Telegram connected"));
      assertStateIdentical(run);
    });
  });
  it("the failure message tells the operator what to look for (conflict, token, cold boot) without claiming a cause", async () => {
    await scenario({ name: "tg-log-hint", seed: oldState, valid: [GOOD, OLD], knobs: { "fail.logs": true }, script: flow(), env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /Conflict|another process|same token/i);
    });
  });
});

describe("platform-telegram: failure after the snapshot rolls back byte-for-byte", { concurrency: 6 }, () => {
  for (const [label, logs] of [
    ["disconnected", "telegram disconnected\n"],
    ["failed after connecting", "telegram connected\ntelegram webhook failed\n"],
  ]) {
    it(`logs reporting ${label} cannot finish setup`, async () => {
      await scenario({ name: "tg-negative-log", seed: oldState, valid: [GOOD, OLD], script: flow(), env: env({ FORCE: "1" }), files: { "logs.txt": logs } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /did not appear in gateway logs/);
        assert.ok(!run.out.includes("OK: Telegram connected"));
        assertStateIdentical(run);
      });
    });
  }

  // Each gateway failure also makes rollback's own reload fail (same knob), so the files are restored but the snapshot is KEPT and
  // the exit is non-zero: rollback never claims a recovery it could not prove ("files restored, but the gateway did NOT come back").
  const gatewayCases = [
    ["gateway restart fails", { "fail.gateway.restart": true }, "fail.gateway.restart", /gateway did not restart ready/],
    ["gateway never reports ready (ensure exit 5)", { ensure_exit: "5\n" }, "ensure_exit", /gateway did not restart ready/],
    ["restart refused because of live sessions", { live_sessions: true }, "live_sessions", /gateway did not restart ready/],
    ["restart exits 0 but the instance never changes", { restart_noop: true }, "restart_noop", /gateway did not restart ready/],
  ];
  const cases = [
    ["config set TELEGRAM_ALLOWED_USERS fails", { "fail.set.TELEGRAM_ALLOWED_USERS": true }, /could not write TELEGRAM_ALLOWED_USERS/],
    ["config set TELEGRAM_BOT_TOKEN fails (allowlist already written)", { "fail.set.TELEGRAM_BOT_TOKEN": true }, /could not write TELEGRAM_BOT_TOKEN/],
    ["third config set fails", { "fail.set_nth": "3\n" }, /could not write/],
    ["no telegram line in the logs", { "fail.logs": true }, /did not appear in gateway logs/],
    ["post-write getMe is rejected", { curl_force: "2=401\n" }, /getMe with the token stored on the VPS did not return/],
    ["open access appears during the write", { inject_allowall: true }, /turns on open access/],
  ];
  for (const [label, knobs, msg] of cases) {
    it(`FORCE=1 re-run: ${label}`, async () => {
      await scenario({ name: "tg-rb", seed: oldState, valid: [GOOD, OLD], knobs, script: flow(), env: env({ FORCE: "1", TELEGRAM_HOME_CHANNEL: "777" }) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /rollback:/);
        assertStateIdentical(run);
        assert.equal(run.sb.read(".hermes/.env"), oldState.env);
        assert.equal(run.sb.read(".hermes/config.yaml"), oldState.config);
        assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-telegram.prev"));
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-telegram"));
        assert.ok(writeEvents(run).some((e) => e.startsWith("hermes config set")) || /open access/.test(msg) === false, "a write must have happened for the rollback to be meaningful");
        // The successful rollback reloaded the gateway natively; it never stopped or ran it.
        assert.ok(!run.sb.hermesCalls().some((c) => c[0] === "gateway" && ["stop", "run"].includes(c[1])));
        assert.ok(!run.sb.hermesCalls().some((c) => c[0] === "send"), "no smoke message after a failed wiring");
      });
    });
  }
  for (const [label, knobs, knob, msg] of gatewayCases) {
    it(`FORCE=1 re-run: ${label}: files restored, snapshot kept, rollback says so, a retry after the fault recovers`, async () => {
      await scenario({ name: "tg-rb-gw2", seed: oldState, valid: [GOOD, OLD], knobs, script: flow(), env: env({ FORCE: "1", TELEGRAM_HOME_CHANNEL: "777" }) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /files restored, but the gateway did NOT come back ready/);
        assert.ok(!run.out.includes("rollback: restored"), "no recovery claim");
        assertStateIdentical(run);
        assert.equal(run.sb.read(".hermes/.env"), oldState.env);
        assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-telegram"), "an unconfirmed gateway recovery keeps the active snapshot");
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-telegram.prev"));
        assert.ok(!run.sb.hermesCalls().some((c) => c.some((x) => ["-y", "--yes", "--force", "--all", "--interrupt"].includes(x))), "a refusal is never overridden");
        assert.ok(!run.sb.hermesCalls().some((c) => c[0] === "gateway" && ["stop", "run"].includes(c[1])));
        if (knob === "live_sessions") assert.match(run.out, /GW_INTERRUPT=1/, "the refusal names the deliberate override");
        const retry = assemble([
          { skill: "platform-telegram", ids: ["step0#1"] },
          `rm "$HSTACK_FAKE/knobs/${knob}"\nrollback || exit 1\necho RECOVERED\n`,
        ]);
        const recovered = await run.sb.run(retry, { env: env({ FORCE: "1" }) });
        assert.equal(recovered.code, 0, recovered.out);
        assert.match(recovered.out, /RECOVERED/);
        assert.equal(run.sb.read(".hermes/.env"), oldState.env);
        assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-telegram.prev"));
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-telegram"));
      });
    });
  }

  it("live sessions: GW_INTERRUPT=1 is the only way -y is ever passed, and only when the operator sets it", async () => {
    await scenario({ name: "tg-interrupt", valid: [GOOD], knobs: { live_sessions: true }, script: flow(), env: env({ GW_INTERRUPT: "1" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.sb.hermesCalls().some((c) => c.join(" ") === "gateway restart --detach -y"));
    });
  });

  it("first run (no .env before): rollback removes the files this skill created", async () => {
    await scenario({ name: "tg-rb-first", valid: [GOOD], knobs: { "fail.gateway.restart": true }, script: flow(), env: env() }, async (run) => {
      assert.equal(run.code, 1);
      assert.ok(!run.sb.exists(".hermes/.env"), ".env created by the run must be removed");
      assert.ok(!run.sb.exists(".hermes/config.yaml"));
      assertStateIdentical(run);
    });
  });
});

describe("platform-telegram: secrets stay out of argv and logs", { concurrency: 6 }, () => {
  it("Bot API URLs in gateway logs are redacted before they are shown", async () => {
    const line = `2026-01-01 INFO telegram connected: POST https://api.telegram.org/bot${GOOD}/getUpdates 200\n`;
    await scenario({ name: "tg-redact", valid: [GOOD], script: flow(), env: env(), files: { "logs.txt": line } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(!run.out.includes(GOOD), "token leaked into the output");
      assert.ok(!run.out.includes(GOOD.split(":")[1]), "token secret half leaked into the output");
      assert.match(run.out, /bot<redacted>\/getUpdates/);
    });
  });

  it("CONTROL: without the redaction the same log line WOULD leak (the test can see a leak)", async () => {
    const line = `2026-01-01 INFO telegram connected: POST https://api.telegram.org/bot${GOOD}/getUpdates 200\n`;
    const script = flow({ replace: [["sed -E 's#bot[0-9]+:[A-Za-z0-9_-]+#bot<redacted>#g' | ", ""]] });
    assert.ok(!script.includes("bot<redacted>"), "control did not remove the redaction");
    await scenario({ name: "tg-redact-ctl", valid: [GOOD], script, env: env(), files: { "logs.txt": line } }, async (run) => {
      assert.ok(run.out.includes(GOOD));
    });
  });
});

describe("platform-telegram: tg_username", { concurrency: 4 }, () => {
  const bodies = [
    ["ok", '{"ok":true,"result":{"id":1,"username":"my_bot","x":1}}', "my_bot"],
    ["ok:false", '{"ok":false,"result":{"username":"my_bot"}}', ""],
    ["shell metacharacters in the name", '{"ok":true,"result":{"username":"evil;rm"}}', ""],
    ['"ok" as a string', '{"ok": "true","result":{"username":"x"}}', ""],
    ["not json", "<html>nope</html>", ""],
  ];
  const hasPython = spawnSync("python3", ["--version"]).status === 0;
  for (const [withPython, label] of [[true, "python3"], [false, "no python3 (grep/sed fallback)"]]) {
    for (const [name, body, want] of bodies) {
      it(`${label}: ${name}`, { skip: withPython && !hasPython ? "python3 not available" : false }, async () => {
        const hide = withPython ? "" : 'command() { if [ "$1" = -v ] && [ "$2" = python3 ]; then return 1; fi; builtin command "$@"; }\n';
        // the fallback has no ok-as-string guard of its own beyond the grep, which the string body fails as well
        const script = assemble([{ skill: SKILL, ids: ["step0#1"] }, hide, `printf 'RESULT[%s]\\n' "$(printf '%s' '${body}' | tg_username)"\n`]);
        await scenario({ name: "tg-user", script }, async (run) => {
          assert.ok(run.out.includes(`RESULT[${want}]`), run.out);
        });
      });
    }
  }
});

describe("platform-telegram: skill text states what is verified and what is not", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  it("has a 'Verified against Hermes v0.22.5' section with file:line citations for the env bridge, authorization and send", () => {
    const m = /\n## Verified against Hermes v0\.22\.5\n([\s\S]*?)(\n## |\n---\n|$)/.exec(text);
    assert.ok(m, "missing section");
    for (const cite of [/plugins\/platforms\/telegram\/gateway_env\.py:\d+/, /plugins\/platforms\/telegram\/adapter\.py:\d+/, /gateway\/authz_mixin\.py:\d+/, /hermes_cli\/send_cmd\.py:\d+/, /hermes_cli\/config\.py:\d+/]) {
      assert.match(m[1], cite);
    }
    assert.match(m[1], /not (been )?(run|verified) against a (live|real)|source-verified|Unverified/i, "must say what was not run");
  });
  it("carries no candidate / unpromoted framing and no retired gate", () => {
    assert.doesNotMatch(text, /candidate|unpromoted|CANDIDATE_ACKNOWLEDGED|HERMES_VERSION=0\.22\.5 explicit/i);
  });
  it("explains why the post-setup nudge was dropped instead of silently removing it", () => {
    assert.match(text, /nudge[\s\S]{0,400}(dropped|removed|no longer)/i);
    assert.match(text, /drop_pending_on_cold_boot/);
  });
});
