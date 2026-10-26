// platform-signal: the real SKILL.md blocks against a simulated VPS (helpers/sandbox.mjs).
//
// What is real here: the bash of the skill, and the SYNTAX of every `hermes ...` call (the stub runs the vendored v0.22.5 argparse).
// What is assumed: what the stubs print and do (a signal-cli daemon answering /api/v1/check, the gateway log lines, `hermes send`).
// The log strings are the ones the v0.22.5 Signal adapter and gateway really log (see the skill's "Verified against" section).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateIdentical, curlEvents, idx, writeEvents } from "./helpers/asserts.mjs";
import { assemble, loadBlocks, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "platform-signal";
// Fictional numbers (555-01xx is reserved for fiction). They are PII, so the skill treats them like secrets: ssh stdin only.
const A1 = "+15550100101";
const A2 = "+15550100102";
const ACCT = "+15550100199";
const UUID = "123e4567-e89b-12d3-a456-426614174000";
const GROUP = "dGVzdC1ncm91cC1pZC0wMDAwMDAwMDAwMDAwMDAwMDA=";
const OLD_ACCT = "+15550100188";
const OLD_USER = "+15550100177";

const FLOW = ["step1#1", "step2#1", "step3#1", "step3#2", "step3#3", "step4#1", "step5#1", "step5#2", "step6#1", "step7#1", "step8#1", "step9#1", "step9#2"];
const flow = ({ ids = FLOW, replace = [] } = {}) =>
  assemble(["set +e\n", { skill: SKILL, ids: ["before-you-start#1", "step0#1"], replace }, { skill: SKILL, ids, replace }, SCRIPT_END]);
const gate = assemble(["set +e\n", { skill: SKILL, ids: ["step0#1", "step3#1"] }, SCRIPT_END]);

const CONNECTED = [
  "2026-10-25 10:00:00,001 INFO plugins.platforms.signal.adapter: Signal adapter initialized: url=http://127.0.0.1:8080 account=+155****0199 groups=disabled",
  "2026-10-25 10:00:00,120 INFO plugins.platforms.signal.adapter: Signal: connected to http://127.0.0.1:8080",
  "2026-10-25 10:00:00,200 INFO plugins.platforms.signal.adapter: Signal SSE: connected",
  "2026-10-25 10:00:00,300 INFO gateway.run: ✓ signal connected",
  "",
].join("\n");

const env = (over = {}) => ({ SIGNAL_ACCOUNT: ACCT, SIGNAL_ALLOWED_USERS: A1, ...over });
const oldState = {
  env: `FOO=bar\nSIGNAL_ACCOUNT=${OLD_ACCT}\nSIGNAL_HTTP_URL=http://127.0.0.1:8081\nSIGNAL_ALLOWED_USERS=${OLD_USER}\nOTHER_KEY=keep-me\n`,
  config: "model.default: old/model\nplatforms.signal.enabled: true\n",
};
const writeKeys = (run) => run.sb.events().filter((e) => e.startsWith("hermes config set ")).map((e) => e.slice("hermes config set ".length));
const gwCalls = (run) => run.sb.hermesCalls().map((c) => (c[0] === "-p" ? c.slice(2) : c)).filter((c) => c[0] === "gateway").map((c) => c.join(" "));
const run = (opts, fn) => scenario({ valid: [], script: flow(), env: env(), files: { "logs.txt": CONNECTED }, ...opts }, fn);

describe("platform-signal: good run", { concurrency: 6 }, () => {
  it("daemon preflight comes first and is read-only; allowlist, account, then the enabling URL LAST; .env is 600; reload is restart --detach + ensure", async () => {
    await run({ name: "sig-good", env: env({ SIGNAL_ALLOWED_USERS: `${A1},${A2}`, SIGNAL_GROUP_ALLOWED_USERS: GROUP, SIGNAL_HOME_CHANNEL: A1 }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(r.completed);
      const curls = r.sb.curlCalls();
      assert.equal(curls.length, 1, "exactly one vendor-side call: the daemon health check");
      assert.equal(curls[0].url, "http://127.0.0.1:8080/api/v1/check");
      assert.equal(curls[0].status, "200");
      const ev = r.sb.events();
      assert.ok(idx(ev, /^curl status=200/) >= 0 && idx(ev, /^curl status=200/) < idx(ev, /^hermes config set/), "preflight must come before the first write");
      assert.deepEqual(writeKeys(r), ["SIGNAL_ALLOWED_USERS", "SIGNAL_GROUP_ALLOWED_USERS", "SIGNAL_HOME_CHANNEL", "SIGNAL_ACCOUNT", "SIGNAL_HTTP_URL", "platforms.signal.enabled"]);
      const text = r.sb.read(".hermes/.env");
      assert.match(text, new RegExp(`^SIGNAL_ALLOWED_USERS=${A1.replace("+", "\\+")},${A2.replace("+", "\\+")}$`, "m"));
      assert.match(text, new RegExp(`^SIGNAL_ACCOUNT=${ACCT.replace("+", "\\+")}$`, "m"));
      assert.match(text, /^SIGNAL_HTTP_URL=http:\/\/127\.0\.0\.1:8080$/m);
      assert.match(text, /^SIGNAL_GROUP_ALLOWED_USERS=/m);
      assert.match(text, new RegExp(`^SIGNAL_HOME_CHANNEL=${A1.replace("+", "\\+")}$`, "m"));
      assert.ok(!text.includes("SIGNAL_ENABLED"), "there is no SIGNAL_ENABLED variable upstream");
      assert.ok(!text.includes("SIGNAL_ALLOW_ALL_USERS"));
      assert.equal(r.sb.mode(".hermes/.env"), 0o600);
      assert.match(r.sb.read(".hermes/config.yaml"), /^platforms\.signal\.enabled: true$/m);
      assert.ok(!r.sb.read(".hermes/config.yaml").includes(A1), "numbers belong in .env, not config.yaml");
      // native reload: restart --detach, then ensure --json; never stop/run/--daemon/status
      const gw = gwCalls(r);
      assert.ok(gw.includes("gateway restart --detach"), gw.join("\n"));
      assert.ok(gw.some((c) => c === "gateway ensure --json --timeout 60"));
      assert.ok(!gw.some((c) => /\bstop\b|\brun\b|--daemon|status|-y\b|--force|--all/.test(c)), gw.join("\n"));
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-signal.prev"));
      assert.ok(!r.sb.exists(".hermes/.hstack-backup/platform-signal"));
      assert.match(r.out, /OK: Signal connected/);
      assertNoSecretInArgv(r, [A1, A2, ACCT, GROUP]);
      assertSecretsNotPrinted(r, [A1, A2, ACCT, GROUP]);
    });
  });

  it("a custom DAEMON_PORT is used for the preflight and for SIGNAL_HTTP_URL; the URL is always loopback", async () => {
    await run({ name: "sig-port", env: env({ DAEMON_PORT: "18080" }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.equal(r.sb.curlCalls()[0].url, "http://127.0.0.1:18080/api/v1/check");
      assert.match(r.sb.read(".hermes/.env"), /^SIGNAL_HTTP_URL=http:\/\/127\.0\.0\.1:18080$/m);
    });
  });

  it("allowlist normalisation: whitespace and empty entries are dropped; a Signal UUID is a valid entry", async () => {
    await run({ name: "sig-ws", env: env({ SIGNAL_ALLOWED_USERS: ` ${A1} , ${UUID},, ` }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.sb.read(".hermes/.env"), new RegExp(`^SIGNAL_ALLOWED_USERS=${A1.replace("+", "\\+")},${UUID}$`, "m"));
    });
  });

  it("an explicit platforms.signal.enabled failure is only a WARN (the platform is enabled by the URL + account anyway)", async () => {
    await run({ name: "sig-flag", knobs: { "fail.set.platforms.signal.enabled": true } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /WARN: could not set platforms\.signal\.enabled/);
      assert.ok(r.completed);
    });
  });

  it("already wired (URL + account + allowlist, private file, no open switch) without FORCE: exits 0, no vendor call, nothing written", async () => {
    await run({ name: "sig-idem", seed: oldState }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /already wired/i);
      assert.ok(!r.completed);
      assertStateIdentical(r);
      assert.equal(r.sb.curlCalls().length, 0);
      assert.deepEqual(writeEvents(r), []);
    });
  });

  for (const [label, lines, mode] of [
    ["wildcard allowlist", "SIGNAL_ALLOWED_USERS=*\n"],
    ["wildcard after a number", `SIGNAL_ALLOWED_USERS=${OLD_USER},*\n`],
    ["malformed entry", "SIGNAL_ALLOWED_USERS=alice\n"],
    ["duplicate allowlist", `SIGNAL_ALLOWED_USERS=${OLD_USER}\nSIGNAL_ALLOWED_USERS=${A1}\n`],
    ["duplicate account", `SIGNAL_ALLOWED_USERS=${OLD_USER}\nSIGNAL_ACCOUNT=${A1}\n`],
    ["signal open-access switch", `SIGNAL_ALLOWED_USERS=${OLD_USER}\nSIGNAL_ALLOW_ALL_USERS=true\n`],
    ["gateway open-access switch", `SIGNAL_ALLOWED_USERS=${OLD_USER}\nGATEWAY_ALLOW_ALL_USERS=1\n`],
    ["all groups", `SIGNAL_ALLOWED_USERS=${OLD_USER}\nSIGNAL_GROUP_ALLOWED_USERS=*\n`],
    ["world-readable env", `SIGNAL_ALLOWED_USERS=${OLD_USER}\n`, 0o644],
  ]) {
    it(`already wired with ${label}: aborts instead of reporting success; no vendor call or write`, async () => {
      const seed = { env: `SIGNAL_ACCOUNT=${OLD_ACCT}\nSIGNAL_HTTP_URL=http://127.0.0.1:8081\n${lines}`, envMode: mode ?? 0o600 };
      await run({ name: "sig-idem-unsafe", seed }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /stored Signal setup is unsafe/);
        assert.ok(!r.out.includes("already wired"));
        assertStateIdentical(r);
        assert.deepEqual(writeEvents(r), []);
        assert.equal(r.sb.curlCalls().length, 0);
      });
    });
  }

  it("stored values in quotes, and explicit off switches, keep the safe idempotent path", async () => {
    const seed = { env: `SIGNAL_ACCOUNT="${OLD_ACCT}"\nSIGNAL_HTTP_URL='http://127.0.0.1:8081'\nSIGNAL_ALLOWED_USERS='${OLD_USER},${UUID}'\nSIGNAL_ALLOW_ALL_USERS=false\nGATEWAY_ALLOW_ALL_USERS=off\n` };
    await run({ name: "sig-idem-quoted", seed }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /already wired/i);
      assertStateIdentical(r);
    });
  });
});

describe("platform-signal: hard gate (nothing is written, no snapshot)", { concurrency: 6 }, () => {
  it("signal-cli daemon unreachable from the VPS: ABORT before the snapshot, state byte-identical, no write", async () => {
    await run({ name: "sig-down", seed: oldState, knobs: { local_down: true }, env: env({ FORCE: "1" }) }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /ABORT: the signal-cli daemon at http:\/\/127\.0\.0\.1:8080 did not answer/);
      assert.match(r.out, /Nothing was written/);
      assertStateIdentical(r);
      assert.deepEqual(writeEvents(r), []);
      assert.ok(!r.sb.exists(".hermes/.hstack-backup"), "no snapshot may exist: the failure is before the first write");
      assert.equal(curlEvents(r).length, 1);
      assert.ok(!gwCalls(r).some((c) => /restart/.test(c)), "no gateway reload for a failure that wrote nothing");
    });
  });

  it("daemon answers but not 200 (503): ABORT, nothing written", async () => {
    await run({ name: "sig-503", knobs: { local_status: "503" } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /HTTP 503/);
      assert.deepEqual(writeEvents(r), []);
      assert.ok(!r.sb.exists(".hermes/.env"));
    });
  });

  // Format problems are caught before ANY ssh or curl call (the gate-only script runs the local half of Step 3 only).
  for (const [label, users, msg] of [
    ["empty", "", /SIGNAL_ALLOWED_USERS is empty/],
    ["only separators", " , ,", /SIGNAL_ALLOWED_USERS is empty/],
    ["*", "*", /contains a wildcard/],
    ["number,*", `${A1},*`, /contains a wildcard/],
    ["*,number", `*,${A1}`, /contains a wildcard/],
    ["no plus sign (WhatsApp style)", "15550100101", /invalid entries in SIGNAL_ALLOWED_USERS/],
    ["too short", "+12345", /invalid entries in SIGNAL_ALLOWED_USERS/],
    ["a username", "alice.01", /invalid entries in SIGNAL_ALLOWED_USERS/],
    ["command injection", `${A1}; touch "$HOME/pwned"`, /invalid entries in SIGNAL_ALLOWED_USERS/],
    ["command substitution", '$(touch "$HOME/pwned")', /invalid entries in SIGNAL_ALLOWED_USERS/],
    ["backticks", "`touch $HOME/pwned`", /invalid entries in SIGNAL_ALLOWED_USERS/],
  ]) {
    it(`allowlist ${JSON.stringify(label)} is refused before any ssh/curl`, async () => {
      await scenario({ name: "sig-allow", script: gate, env: env({ SIGNAL_ALLOWED_USERS: users }) }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, msg);
        assert.match(r.out, /Nothing was written/);
        assert.equal(r.sb.sshCalls().length, 0);
        assert.equal(r.sb.curlCalls().length, 0);
        assert.ok(!r.sb.exists("pwned"));
        assert.ok(!r.out.includes(A1), "the offending entries are not echoed back");
      });
    });
  }

  for (const [label, over, msg] of [
    ["account empty", { SIGNAL_ACCOUNT: "" }, /SIGNAL_ACCOUNT must be E\.164/],
    ["account without plus", { SIGNAL_ACCOUNT: "15550100199" }, /SIGNAL_ACCOUNT must be E\.164/],
    ["account is a UUID", { SIGNAL_ACCOUNT: UUID }, /SIGNAL_ACCOUNT must be E\.164/],
    ["account injection", { SIGNAL_ACCOUNT: `${ACCT};touch $HOME/pwned` }, /SIGNAL_ACCOUNT must be E\.164/],
    ["every group", { SIGNAL_GROUP_ALLOWED_USERS: "*" }, /SIGNAL_GROUP_ALLOWED_USERS contains a wildcard/],
    ["group list with a wildcard", { SIGNAL_GROUP_ALLOWED_USERS: `${GROUP},*` }, /SIGNAL_GROUP_ALLOWED_USERS contains a wildcard/],
    ["group id with shell characters", { SIGNAL_GROUP_ALLOWED_USERS: 'abc"$(touch x)' }, /invalid entries in SIGNAL_GROUP_ALLOWED_USERS/],
    ["group id that is a phone number list", { SIGNAL_GROUP_ALLOWED_USERS: `${A1},${A2}` }, /invalid entries in SIGNAL_GROUP_ALLOWED_USERS/],
    ["home channel garbage", { SIGNAL_HOME_CHANNEL: "hello world" }, /invalid SIGNAL_HOME_CHANNEL/],
    ["home channel two values", { SIGNAL_HOME_CHANNEL: `${A1},${A2}` }, /invalid SIGNAL_HOME_CHANNEL/],
    ["home channel injection", { SIGNAL_HOME_CHANNEL: `${A1};touch $HOME/pwned` }, /invalid SIGNAL_HOME_CHANNEL/],
    ["port with text", { DAEMON_PORT: "80;touch $HOME/pwned" }, /DAEMON_PORT must be a port number/],
    ["port zero", { DAEMON_PORT: "0" }, /DAEMON_PORT must be a port number/],
    ["port too large", { DAEMON_PORT: "70000" }, /DAEMON_PORT must be a port number/],
  ]) {
    it(`${label} is refused before any ssh/curl`, async () => {
      await scenario({ name: "sig-fmt", script: gate, env: env(over) }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, msg);
        assert.match(r.out, /Nothing was written/);
        assert.equal(r.sb.sshCalls().length, 0);
        assert.equal(r.sb.curlCalls().length, 0);
        assert.ok(!r.sb.exists("pwned"));
      });
    });
  }

  it("a group id and a home channel written as group:<id> are accepted", async () => {
    await run({ name: "sig-group-ok", env: env({ SIGNAL_GROUP_ALLOWED_USERS: `${GROUP},-abcdEFGH12345678`, SIGNAL_HOME_CHANNEL: `group:${GROUP}` }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.sb.read(".hermes/.env"), /^SIGNAL_HOME_CHANNEL=group:/m);
      assert.match(r.sb.read(".hermes/.env"), /^SIGNAL_GROUP_ALLOWED_USERS=.*,-abcdEFGH12345678$/m);
    });
  });

  // Open-access switches already in the VPS .env make the allowlist meaningless.
  for (const [line, name] of [
    ["SIGNAL_ALLOW_ALL_USERS=true", "SIGNAL_ALLOW_ALL_USERS"], ["GATEWAY_ALLOW_ALL_USERS=1", "GATEWAY_ALLOW_ALL_USERS"], ["SIGNAL_ALLOW_ALL_USERS=yes", "SIGNAL_ALLOW_ALL_USERS"],
    ['GATEWAY_ALLOW_ALL_USERS="true"', "GATEWAY_ALLOW_ALL_USERS"], ["export SIGNAL_ALLOW_ALL_USERS=1", "SIGNAL_ALLOW_ALL_USERS"], [" GATEWAY_ALLOW_ALL_USERS = true", "GATEWAY_ALLOW_ALL_USERS"],
    ["SIGNAL_ALLOW_ALL_USERS=anything-else", "SIGNAL_ALLOW_ALL_USERS"],
    ["SIGNAL_ALLOWED_USERS=*", "SIGNAL_ALLOWED_USERS"], [`SIGNAL_ALLOWED_USERS=${A2},*`, "SIGNAL_ALLOWED_USERS"],
    ["SIGNAL_GROUP_ALLOWED_USERS=*", "SIGNAL_GROUP_ALLOWED_USERS"], ["GATEWAY_ALLOWED_USERS=*", "GATEWAY_ALLOWED_USERS"],
  ]) {
    it(`pre-existing ${JSON.stringify(line)} aborts before any write`, async () => {
      await run({ name: "sig-open", seed: { env: `FOO=bar\n${line}\n` } }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, new RegExp(`turns on open access \\(${name}\\)`));
        assert.match(r.out, /Nothing was written/);
        assertStateIdentical(r);
        assert.deepEqual(writeEvents(r), []);
        assert.equal(r.sb.curlCalls().length, 0, "refused before the vendor-side call");
      });
    });
  }
  for (const lines of ["SIGNAL_ALLOW_ALL_USERS=false\nGATEWAY_ALLOW_ALL_USERS=0\n", "GATEWAY_ALLOW_ALL_USERS=off\nSIGNAL_ALLOW_ALL_USERS=no\n"]) {
    it(`explicitly-off switches (${lines.trim().split("\n").join(", ")}) do not block`, async () => {
      await run({ name: "sig-off", seed: { env: lines } }, async (r) => {
        assert.equal(r.code, 0, r.out);
        assert.ok(r.completed);
      });
    });
  }

  it("an unreadable (symlinked) .env aborts instead of being skipped", async () => {
    await run({ name: "sig-link", setup: (sb) => { sb.write("real.env", "FOO=1\n"); } , seed: {} , script: assemble(["set +e\n", { skill: SKILL, ids: ["step0#1"] }, 'ln -s "$HOME/real.env" "$HOME/.hermes/.env"\n', { skill: SKILL, ids: ["step3#1", "step3#2"] }, SCRIPT_END]) }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /could not read ~\/\.hermes\/\.env/);
      assert.deepEqual(writeEvents(r), []);
    });
  });

  it("a leftover snapshot makes snapshot refuse; nothing is written", async () => {
    await run({ name: "sig-left", seed: oldState, env: env({ FORCE: "1" }), setup: (sb) => sb.write(".hermes/.hstack-backup/platform-signal/.env", "junk\n") }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /did not finish/);
      assert.match(r.out, /ABORT: could not snapshot/);
      assertStateIdentical(r);
      assert.deepEqual(writeEvents(r), []);
    });
  });
});

describe("platform-signal: a failure after the snapshot restores the previous values and reloads", { concurrency: 6 }, () => {
  const cases = [
    ["config set SIGNAL_ALLOWED_USERS fails", { "fail.set.SIGNAL_ALLOWED_USERS": true }, /could not write SIGNAL_ALLOWED_USERS/],
    ["config set SIGNAL_HTTP_URL fails (allowlist and account already written)", { "fail.set.SIGNAL_HTTP_URL": true }, /could not write SIGNAL_HTTP_URL/],
    ["second config set fails", { "fail.set_nth": "2\n" }, /could not write/],
    ["no Signal line in the logs", { "fail.logs": true }, /did not appear in gateway logs/],
    ["open access appears during the write", { inject_allowall: true }, /turns on open access/],
  ];
  for (const [label, knobs, msg] of cases) {
    it(`FORCE=1 re-run: ${label}`, async () => {
      await run({ name: "sig-rb", seed: oldState, knobs, env: env({ FORCE: "1", SIGNAL_HOME_CHANNEL: A2 }) }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, msg);
        assert.match(r.out, /rollback: restored/);
        assertStateIdentical(r);
        assert.equal(r.sb.read(".hermes/.env"), oldState.env);
        assert.equal(r.sb.read(".hermes/config.yaml"), oldState.config);
        assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-signal.prev"));
        assert.ok(!r.sb.exists(".hermes/.hstack-backup/platform-signal"));
        assert.ok(writeEvents(r).some((e) => e.startsWith("hermes config set")), "a write must have happened for the rollback to be meaningful");
        // the restored values are only live after a reload: rollback reloads the gateway through the same native helper
        assert.ok(gwCalls(r).filter((c) => c === "gateway restart --detach").length >= 1);
      });
    });
  }

  for (const [label, logs] of [
    ["disconnected", `${CONNECTED}2026-10-25 10:01:00,000 INFO plugins.platforms.signal.adapter: Signal: disconnected\n`],
    ["the gateway reports a failed connect", "2026-10-25 10:00:00,300 WARNING gateway.run: ✗ signal failed to connect\n"],
    ["a later daemon outage", `${CONNECTED}2026-10-25 10:02:00,000 ERROR plugins.platforms.signal.adapter: Signal: cannot reach signal-cli at http://127.0.0.1:8080: All connection attempts failed\n`],
    ["a later failed health check", `${CONNECTED}2026-10-25 10:02:00,000 ERROR plugins.platforms.signal.adapter: Signal: health check failed (status 503)\n`],
    ["missing configuration", "2026-10-25 10:00:00,000 ERROR plugins.platforms.signal.adapter: Signal: SIGNAL_HTTP_URL and SIGNAL_ACCOUNT are required\n"],
    ["only the unrelated lines", "2026-10-25 10:00:00,000 INFO gateway.run: ✓ telegram connected\n"],
    ["degraded", "2026-10-25 10:00:00,300 INFO gateway.run: ✓ signal connected (degraded)\n"],
  ]) {
    it(`logs reporting ${label} cannot finish setup: rollback to the previous values`, async () => {
      await run({ name: "sig-neglog", seed: oldState, files: { "logs.txt": logs }, env: env({ FORCE: "1" }) }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /did not appear in gateway logs/);
        assert.ok(!r.out.includes("OK: Signal connected"));
        assertStateIdentical(r);
        assert.equal(r.sb.read(".hermes/.env"), oldState.env);
      });
    });
  }

  it("the LATEST Signal status line wins: an earlier failure followed by a connect is connected", async () => {
    const logs = `2026-10-25 09:59:00,000 ERROR plugins.platforms.signal.adapter: Signal: cannot reach signal-cli at http://127.0.0.1:8080: refused\n${CONNECTED}`;
    await run({ name: "sig-latest", files: { "logs.txt": logs } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /OK: Signal connected/);
    });
  });

  it("gateway lines alone are enough (the gateway logs the connect as well as the adapter)", async () => {
    await run({ name: "sig-gwline", files: { "logs.txt": "2026-10-25 10:00:00,300 INFO gateway.run: ✓ signal connected\n" } }, async (r) => {
      assert.equal(r.code, 0, r.out);
    });
  });

  it("first run (no .env before): rollback removes the files this skill created", async () => {
    await run({ name: "sig-rb-first", knobs: { "fail.logs": true } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.ok(!r.sb.exists(".hermes/.env"), ".env created by the run must be removed");
      assert.ok(!r.sb.exists(".hermes/config.yaml"));
      assertStateIdentical(r);
    });
  });

  it("the reload failing (live sessions refuse the restart): reported, rolled back, and the refusal is NOT overridden with -y", async () => {
    await run({ name: "sig-live", seed: oldState, knobs: { live_sessions: true }, env: env({ FORCE: "1" }) }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /gateway did not restart ready/);
      assert.match(r.out, /GW_INTERRUPT=1/);
      assert.equal(r.sb.read(".hermes/.env"), oldState.env, "files restored");
      // the rollback's own reload is refused too, so the recovery point is KEPT and the failure says so
      assert.match(r.out, /files restored, but the gateway did NOT come back/);
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-signal"));
      assert.ok(!r.sb.exists(".hermes/.hstack-backup/platform-signal.prev"));
      assert.ok(!gwCalls(r).some((c) => / -y\b/.test(c)));
    });
  });

  it("GW_INTERRUPT=1 is the one deliberate way to restart over live sessions", async () => {
    await run({ name: "sig-live-ok", knobs: { live_sessions: true }, env: env({ GW_INTERRUPT: "1" }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(gwCalls(r).includes("gateway restart --detach -y"), gwCalls(r).join("\n"));
    });
  });

  it("a restart that did nothing (same instance) is a failure, rolled back, snapshot kept for the next try", async () => {
    await run({ name: "sig-noop", seed: oldState, knobs: { restart_noop: true }, env: env({ FORCE: "1" }) }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /instance did not change/);
      assert.equal(r.sb.read(".hermes/.env"), oldState.env);
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-signal"));
    });
  });

  it("recovery: once the fault is gone, the Step 0 rollback completes and retires the snapshot", async () => {
    await run({ name: "sig-recover", seed: oldState, knobs: { restart_noop: true }, env: env({ FORCE: "1" }) }, async (r) => {
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-signal"));
      const retry = assemble([{ skill: SKILL, ids: ["step0#1"] }, 'rm "$HSTACK_FAKE/knobs/restart_noop"\nrollback || exit 1\necho RECOVERED\n']);
      const again = await r.sb.run(retry);
      assert.equal(again.code, 0, again.out);
      assert.match(again.out, /RECOVERED/);
      assert.equal(r.sb.read(".hermes/.env"), oldState.env);
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-signal.prev"));
      assert.ok(!r.sb.exists(".hermes/.hstack-backup/platform-signal"));
    });
  });
});

describe("platform-signal: log output never carries phone numbers", { concurrency: 4 }, () => {
  it("on a failed connect the Signal lines shown to the operator have numbers masked", async () => {
    const logs = `2026-10-25 10:00:00,000 INFO plugins.platforms.signal.adapter: Signal: message from ${A1} in ${A2}\n2026-10-25 10:00:01,000 ERROR plugins.platforms.signal.adapter: Signal: cannot reach signal-cli at http://127.0.0.1:8080: refused (account ${ACCT})\n`;
    await run({ name: "sig-mask", files: { "logs.txt": logs } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      for (const n of [A1, A2, ACCT]) assert.ok(!r.out.includes(n), `${n} leaked into the output`);
      assert.match(r.out, /cannot reach signal-cli/);
    });
  });

  it("CONTROL: without the mask the same line WOULD leak (the test can see a leak)", async () => {
    const logs = `2026-10-25 10:00:01,000 ERROR plugins.platforms.signal.adapter: Signal: cannot reach signal-cli at http://127.0.0.1:8080: refused (account ${ACCT})\n`;
    const script = flow({ replace: [["sed -E 's/\\+[0-9]{7,15}/+<redacted>/g' | ", ""]] });
    assert.ok(script !== flow(), "control did not remove the mask");
    await run({ name: "sig-mask-ctl", files: { "logs.txt": logs }, script }, async (r) => {
      assert.ok(r.out.includes(ACCT));
    });
  });
});

describe("platform-signal: smoke send is opt-in", { concurrency: 4 }, () => {
  it("default: no message is sent anywhere", async () => {
    await run({ name: "sig-nosend" }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(!r.sb.events().some((e) => e.startsWith("hermes send")));
    });
  });

  it("SMOKE_SEND=1 sends ONE fixed message to the first allowlisted E.164 number with the native `hermes send --to`", async () => {
    await run({ name: "sig-send", env: env({ SMOKE_SEND: "1", SIGNAL_ALLOWED_USERS: `${UUID},${A2},${A1}` }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      const sends = r.sb.events().filter((e) => e.startsWith("hermes send"));
      assert.deepEqual(sends, [`hermes send signal:${A2}`]);
      const argv = r.sb.hermesCalls().find((c) => c[0] === "send" || c[2] === "send");
      assert.ok(argv.join(" ").includes("hstack platform-signal"), argv.join(" "));
      assertSecretsNotPrinted(r, [A2]);
      assertNoSecretInArgv(r, [A2]);
    });
  });

  it("SMOKE_SEND=1 with only UUID entries: skipped with a note, not an error", async () => {
    await run({ name: "sig-send-uuid", env: env({ SMOKE_SEND: "1", SIGNAL_ALLOWED_USERS: UUID }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(!r.sb.events().some((e) => e.startsWith("hermes send")));
      assert.match(r.out, /skipped/i);
    });
  });

  it("a failing smoke send is a WARN only: Signal is already verified connected and stays wired", async () => {
    await run({ name: "sig-send-fail", knobs: { "fail.send": true }, env: env({ SMOKE_SEND: "1" }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /WARN: the smoke message was not delivered/);
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-signal.prev"));
    });
  });
});

describe("platform-signal: text and structure", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const code = loadBlocks(SKILL).map((b) => b.code).join("\n");
  it("never writes or recommends SIGNAL_ENABLED (not an upstream variable)", () => {
    assert.ok(!/SIGNAL_ENABLED=|config set SIGNAL_ENABLED/.test(code));
    assert.ok(!/SIGNAL_ENABLED/.test(code));
  });
  it("never uses the retired lifecycle or non-native shortcuts", () => {
    assert.ok(!/gateway (stop|run)|--daemon|systemctl|journalctl/.test(code), "no systemd/stop/run in executed blocks");
    assert.ok(!/>>\s*\S*\.env\b/.test(code), "no appending to .env by redirection");
  });
  it("states plainly that nothing here was run against a real Signal account", () => {
    assert.match(text, /Verified against Hermes v0\.22\.5/);
    assert.match(text, /not\s+(been\s+)?(run|exercised|tested)\s+against\s+a\s+real/i);
  });
  it("treats SIGNAL_GROUP_ALLOWED_USERS as group IDs, not phone numbers (upstream plugin.yaml)", () => {
    assert.match(text, /SIGNAL_GROUP_ALLOWED_USERS[^\n]*group IDs/i);
  });
});
