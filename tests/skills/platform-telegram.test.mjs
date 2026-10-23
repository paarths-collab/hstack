// platform-telegram: the real SKILL.md blocks against a simulated VPS (helpers/sandbox.mjs).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, curlEvents, idx, writeEvents } from "./helpers/asserts.mjs";
import { assemble } from "./helpers/blocks.mjs";
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
      // gateway: stop+run twice (initial + nudge), never restart
      const gw = run.sb.events().filter((e) => /^hermes gateway (stop|ensure)/.test(e));
      assert.deepEqual(gw, ["hermes gateway stop", "hermes gateway ensure", "hermes gateway stop", "hermes gateway ensure"]);
      assert.ok(!text.includes("TELEGRAM_ENABLED") && !text.includes("ALLOWED_CHATS"));
      assert.match(run.out, /Token OK: bot is @fake_test_bot/);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-telegram.prev"));
      assertNoSecretInArgv(run, [GOOD]);
      assertSecretsNotPrinted(run, [GOOD]);
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

  const cases = [
    ["gateway run fails", { "fail.gateway.run": true }, /gateway did not start/],
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
        if (knobs["fail.gateway.run"]) {
          assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-telegram"), "an unconfirmed gateway recovery keeps the active snapshot");
          assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-telegram.prev"));
          const retry = assemble([
            { skill: "platform-telegram", ids: ["step0#1"] },
            'rm "$HSTACK_FAKE/knobs/fail.gateway.run"\nrollback || exit 1\necho RECOVERED\n',
          ]);
          const recovered = await run.sb.run(retry);
          assert.equal(recovered.code, 0, recovered.out);
          assert.match(recovered.out, /RECOVERED/);
          assert.equal(run.sb.read(".hermes/.env"), oldState.env);
        }
        assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-telegram.prev"));
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-telegram"));
        assert.ok(writeEvents(run).some((e) => e.startsWith("hermes config set")) || /open access/.test(msg) === false, "a write must have happened for the rollback to be meaningful");
      });
    });
  }

  it("first run (no .env before): rollback removes the files this skill created", async () => {
    await scenario({ name: "tg-rb-first", valid: [GOOD], knobs: { "fail.gateway.run": true }, script: flow(), env: env() }, async (run) => {
      assert.equal(run.code, 1);
      assert.ok(!run.sb.exists(".hermes/.env"), ".env created by the run must be removed");
      assert.ok(!run.sb.exists(".hermes/config.yaml"));
      assertStateIdentical(run);
    });
  });

  it("rollback says so when the gateway does not come back", async () => {
    await scenario({ name: "tg-rb-gw", seed: oldState, valid: [GOOD], knobs: { "fail.gateway.run": true }, script: flow(), env: env({ FORCE: "1" }) }, async (run) => {
      assert.match(run.out, /restoration failed; active snapshot retained/);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-telegram"));
      assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-telegram.prev"));
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
