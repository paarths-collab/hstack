// platform-teams: the real SKILL.md blocks against a simulated VPS (helpers/sandbox.mjs).
//
// What is real here: the bash of the skill, the argparse syntax of every `hermes` call (vendored v0.22.5 builders), the ssh/stdin
// plumbing. What is assumed: how the stubbed Hermes, curl and the Microsoft identity platform BEHAVE (each stub says so in its header).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, idx, writeEvents } from "./helpers/asserts.mjs";
import { assemble, loadBlocks, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "platform-teams";
// Assembled at run time so that no secret-shaped literal sits in the repository.
const secret = (tag, n = 40) => ["xx", "T8Q", "~", tag, "abcdefghijklmnopqrstuvwxyz0123456789_.-ABCDEFGHIJKLMNOP"].join("").slice(0, n);
const GOOD = secret("G");
const OLD = secret("O");
const CLIENT = "11111111-2222-3333-4444-555555555555";
const TENANT = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const USER_A = "aaaaaaaa-1111-2222-3333-444444444444";
const USER_B = "bbbbbbbb-1111-2222-3333-444444444444";

const GOOD_LOGS =
  "2026-01-01 INFO gateway.run: Connecting to teams...\n" +
  "2026-01-01 INFO plugins.platforms.teams.adapter: [teams] Webhook server listening on * (all interfaces, IPv4+IPv6):3978/api/messages\n" +
  "2026-01-01 INFO gateway.run: ✓ teams connected\n";

const FLOW = ["step1#1", "step2#1", "step3#1", "step3#2", "step3#3", "step4#1", "step5#1", "step5#2", "step6#1", "step7#1", "step7#2", "step8#1"];
const flow = ({ ids = FLOW, replace = [] } = {}) =>
  assemble(["set +e\n", { skill: SKILL, ids: ["before-you-start#1", "step0#1"] }, { skill: SKILL, ids, replace }, SCRIPT_END]);
const localGate = () => assemble(["set +e\n", { skill: SKILL, ids: ["step0#1", "step3#1"] }, SCRIPT_END]);

const env = (over = {}) => ({
  TEAMS_CLIENT_ID: CLIENT, TEAMS_TENANT_ID: TENANT, TEAMS_CLIENT_SECRET: GOOD, TEAMS_ALLOWED_USERS: USER_A, ...over,
});
const knobs = (over = {}) => ({ curl_routes: "127.0.0.1:3978/health\tok\n", ...over });
const oldState = {
  env: `FOO=bar\nTEAMS_CLIENT_ID=${CLIENT}\nTEAMS_TENANT_ID=${TENANT}\nTEAMS_CLIENT_SECRET=${OLD}\nTEAMS_ALLOWED_USERS=${USER_B}\nOTHER_KEY=keep-me\n`,
  config: "model.default: old/model\n",
};
const setKeys = (run) => run.sb.events().filter((e) => e.startsWith("hermes config set ")).map((e) => e.slice("hermes config set ".length));
const run1 = (opts, check) => scenario({ valid: [GOOD, OLD], files: { "logs.txt": GOOD_LOGS }, script: flow(), env: env(), ...opts, knobs: knobs(opts.knobs) }, check);

describe("platform-teams: good run", { concurrency: 6 }, () => {
  it("token request first (real tenant, client and secret), then writes allowlist .. secret LAST, native reload, three proofs, finish", async () => {
    await run1({ name: "teams-good", env: env({ TEAMS_PORT: "3978" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      const log = run.sb.log("curl.log");
      const calls = run.sb.curlCalls();
      // 1: preflight, 2: local /health, 3: read-back of the stored secret
      assert.equal(calls.length, 3, log);
      for (const i of [0, 2]) {
        assert.equal(calls[i].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
        assert.equal(calls[i].status, "200");
        assert.equal(Number(calls[i].token_len), GOOD.length, "the REAL secret reached the request, not an escaped variable name");
        assert.equal(calls[i].argv_has_token, "0");
      }
      assert.match(log, /form=grant_type=client_credentials&client_id=11111111-2222-3333-4444-555555555555&client_secret=<SECRET>&scope=https%3A%2F%2Fapi\.botframework\.com%2F\.default/);
      assert.equal(calls[1].url, "http://127.0.0.1:3978/health");

      const ev = run.sb.events();
      assert.ok(idx(ev, /^curl status=200/) >= 0 && idx(ev, /^curl status=200/) < idx(ev, /^hermes config set/), "the Microsoft token request must happen before the first write");
      assert.deepEqual(setKeys(run), ["TEAMS_ALLOWED_USERS", "TEAMS_PORT", "TEAMS_CLIENT_ID", "TEAMS_TENANT_ID", "TEAMS_CLIENT_SECRET"]);
      const text = run.sb.read(".hermes/.env");
      assert.match(text, new RegExp(`^TEAMS_ALLOWED_USERS=${USER_A}$`, "m"));
      assert.match(text, new RegExp(`^TEAMS_CLIENT_SECRET=${GOOD}$`, "m"));
      assert.match(text, /^TEAMS_PORT=3978$/m);
      assert.ok(!/TEAMS_ENABLED|ALLOW_ALL/.test(text), "no switch of any kind is written");
      assert.equal(run.sb.mode(".hermes/.env"), 0o600);
      const cfg = run.sb.read(".hermes/config.yaml");
      assert.ok(!cfg || (!cfg.includes(GOOD) && !/teams/.test(cfg)), "the secret and any teams key stay out of config.yaml");

      // native lifecycle: one restart --detach, ensure until ready; never stop/run/status text
      const gw = run.sb.events().filter((e) => /^hermes gateway /.test(e));
      assert.deepEqual(gw.filter((e) => e !== "hermes gateway ensure"), ["hermes gateway restart"]);
      assert.ok(!gw.some((e) => /stop|run|status/.test(e)));
      assert.ok(run.sb.hermesCalls().some((c) => c.join(" ") === "gateway restart --detach"));
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-teams.prev"));
      assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-teams"));
      assert.match(run.out, /Microsoft accepted the credentials/);
      assert.match(run.out, /gateway log reports Teams connected/);
      assertNoSecretInArgv(run, [GOOD]);
      assertSecretsNotPrinted(run, [GOOD]);
      // the only place the secret may appear in the hermes argv log is the documented `config set` line
      const argv = run.sb.log("hermes-argv.log").split("\n").filter((l) => l.includes(GOOD));
      assert.deepEqual(argv, [`config\tset\tTEAMS_CLIENT_SECRET\t${GOOD}`]);
    });
  });

  it("every hermes call is bound to the default profile", async () => {
    await run1({ name: "teams-profile" }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.sb.log("hermes-profile.log").split("\n").filter(Boolean).every((l) => l === "default"), run.sb.log("hermes-profile.log"));
    });
  });

  it("optional inputs: port, home channel (one native send), public URL probe from the VPS", async () => {
    const home = "19:abcDEF123@thread.tacv2";
    await run1(
      { name: "teams-opt", env: env({ TEAMS_PORT: "4000", TEAMS_HOME_CHANNEL: home, TEAMS_PUBLIC_URL: "https://bot.example.com/api/messages" }), knobs: { curl_routes: "127.0.0.1:4000/health\tok\n" } },
      async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.deepEqual(setKeys(run), ["TEAMS_ALLOWED_USERS", "TEAMS_PORT", "TEAMS_HOME_CHANNEL", "TEAMS_CLIENT_ID", "TEAMS_TENANT_ID", "TEAMS_CLIENT_SECRET"]);
        assert.match(run.sb.read(".hermes/.env"), new RegExp(`^TEAMS_HOME_CHANNEL=${home}$`, "m"));
        const urls = run.sb.curlCalls().map((c) => c.url);
        assert.ok(urls.includes("http://127.0.0.1:4000/health"));
        assert.ok(urls.includes("https://bot.example.com/api/messages"));
        assert.ok(run.sb.events().includes("hermes send teams"), run.sb.events().join("\n"));
        assert.match(run.out, /Whether Teams can reach it is NOT verified/);
      },
    );
  });

  it("a port stored by an earlier run is the one the health check uses; a malformed stored port falls back to 3978", async () => {
    await run1({ name: "teams-port", seed: { ...oldState, env: oldState.env + "TEAMS_PORT=4000\n" }, env: env({ FORCE: "1" }), knobs: { curl_routes: "127.0.0.1:4000/health\tok\n" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      const urls = run.sb.curlCalls().map((c) => c.url);
      assert.ok(urls.includes("http://127.0.0.1:4000/health"), urls.join("\n"));
      assert.ok(!urls.includes("http://127.0.0.1:3978/health"));
    });
    await run1({ name: "teams-port-bad", seed: { ...oldState, env: oldState.env + "TEAMS_PORT=eighty\n" }, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.sb.curlCalls().map((c) => c.url).includes("http://127.0.0.1:3978/health"));
    });
  });

  it("allowlist normalisation: case, whitespace, empty entries", async () => {
    await run1({ name: "teams-ws", env: env({ TEAMS_ALLOWED_USERS: ` ${USER_A.toUpperCase()} , ${USER_B},, ` }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/.env"), new RegExp(`^TEAMS_ALLOWED_USERS=${USER_A},${USER_B}$`, "m"));
    });
  });

  it("already stored and safe: exits 0 and says it is configuration only; no vendor call, no write", async () => {
    await run1({ name: "teams-idem", seed: oldState }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /already stored \(configuration only; this does not prove the bot is connected\)/);
      assert.ok(!run.completed);
      assertStateIdentical(run);
      assert.equal(run.sb.curlCalls().length, 0);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  for (const [label, lines, mode] of [
    ["wildcard in the stored allowlist", `TEAMS_ALLOWED_USERS=${USER_A},*\n`],
    ["an e-mail in the stored allowlist", `TEAMS_ALLOWED_USERS=alice@example.com\n`],
    ["duplicate allowlist", `TEAMS_ALLOWED_USERS=${USER_A}\nTEAMS_ALLOWED_USERS=${USER_B}\n`],
    ["TEAMS_ALLOW_ALL_USERS", `TEAMS_ALLOWED_USERS=${USER_A}\nTEAMS_ALLOW_ALL_USERS=true\n`],
    ["exported GATEWAY_ALLOW_ALL_USERS", `TEAMS_ALLOWED_USERS=${USER_A}\nexport GATEWAY_ALLOW_ALL_USERS=1\n`],
    ["GATEWAY_ALLOWED_USERS=*", `TEAMS_ALLOWED_USERS=${USER_A}\nGATEWAY_ALLOWED_USERS=555,*\n`],
    ["duplicate secret", `TEAMS_ALLOWED_USERS=${USER_A}\nTEAMS_CLIENT_SECRET=${OLD}\n`],
    ["world-readable .env", `TEAMS_ALLOWED_USERS=${USER_A}\n`, 0o644],
  ]) {
    it(`stored setup with ${label}: aborts instead of reporting success`, async () => {
      const seed = { env: `TEAMS_CLIENT_ID=${CLIENT}\nTEAMS_TENANT_ID=${TENANT}\nTEAMS_CLIENT_SECRET=${OLD}\n${lines}`, envMode: mode ?? 0o600 };
      await run1({ name: "teams-unsafe", seed }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /stored Teams setup is unsafe/);
        assert.ok(!run.out.includes("already stored"));
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
        assertSecretsNotPrinted(run, [OLD, GOOD]);
      });
    });
  }

  it("quoted stored values and explicit-off switches still count as safe", async () => {
    const seed = { env: `TEAMS_CLIENT_ID="${CLIENT}"\nTEAMS_TENANT_ID='${TENANT}'\nTEAMS_CLIENT_SECRET="${OLD}"\nTEAMS_ALLOWED_USERS="${USER_A},${USER_B}"\nTEAMS_ALLOW_ALL_USERS=false\n` };
    await run1({ name: "teams-quoted", seed }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /already stored/);
      assertStateIdentical(run);
    });
  });

  it("FORCE=1 rewrites over a safe stored setup and keeps the old values as .prev", async () => {
    await run1({ name: "teams-force", seed: oldState, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assertStateChanged(run);
      assert.match(run.sb.read(".hermes/.env"), new RegExp(`^TEAMS_CLIENT_SECRET=${GOOD}$`, "m"));
      assert.match(run.sb.read(".hermes/.env"), /^OTHER_KEY=keep-me$/m);
      assert.match(run.sb.read(".hermes/.hstack-backup/platform-teams.prev/.env"), new RegExp(`TEAMS_CLIENT_SECRET=${OLD}`));
    });
  });

  it("a Hermes that is not 0.22.5 is refused before anything", async () => {
    await run1({ name: "teams-ver", files: { "hermes.version": "hermes 0.17.2\n", "logs.txt": GOOD_LOGS } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /source-verified for Hermes 0.22.5 only/);
      assertStateIdentical(run);
      assert.equal(run.sb.curlCalls().length, 0);
    });
  });
});

describe("platform-teams: hard gate (nothing written)", { concurrency: 6 }, () => {
  it("Microsoft rejects the secret (401): ABORT with the error code, state byte-identical, no snapshot, no write", async () => {
    await run1({ name: "teams-bad", seed: oldState, valid: [OLD], env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: Microsoft rejected the credentials \(error: invalid_client, AADSTS code: 7000215\)/);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      assert.equal(run.sb.curlCalls().length, 1);
      assertSecretsNotPrinted(run, [GOOD]);
    });
  });

  it("the VPS cannot reach Microsoft: ABORT, nothing written", async () => {
    await run1({ name: "teams-net", knobs: { net_down: true } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /could not reach login\.microsoftonline\.com/);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  // Allowlist problems are caught before ANY ssh or curl call (the gate-only script runs the local checks only).
  for (const [label, users, msg] of [
    ["empty", "", /TEAMS_ALLOWED_USERS is empty/],
    ["only separators", " , ,", /TEAMS_ALLOWED_USERS is empty/],
    ["*", "*", /wildcard/],
    ["a GUID and *", `${USER_A},*`, /wildcard/],
    ["an e-mail", "alice@example.com", /invalid entries in TEAMS_ALLOWED_USERS/],
    ["a UPN", "alice@contoso.onmicrosoft.com", /invalid entries/],
    ["a short GUID", "aaaaaaaa-1111-2222-3333-44444444444", /invalid entries/],
    ["command injection", '555; touch "$HOME/pwned"', /invalid entries/],
    ["command substitution", '$(touch "$HOME/pwned")', /invalid entries/],
  ]) {
    it(`allowlist ${JSON.stringify(label)} is refused before any ssh/curl`, async () => {
      await scenario({ name: "teams-allow", valid: [GOOD], script: localGate(), env: env({ TEAMS_ALLOWED_USERS: users }) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /Nothing was written/);
        assert.equal(run.sb.sshCalls().length, 0);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }

  for (const [label, over, msg] of [
    ["client id not a GUID", { TEAMS_CLIENT_ID: "not-a-guid" }, /TEAMS_CLIENT_ID is not a GUID/],
    ["tenant id not a GUID", { TEAMS_TENANT_ID: "contoso.onmicrosoft.com" }, /TEAMS_TENANT_ID is not a GUID/],
    ["secret empty", { TEAMS_CLIENT_SECRET: "" }, /TEAMS_CLIENT_SECRET is empty/],
    ["secret too short", { TEAMS_CLIENT_SECRET: "short~secret" }, /shorter than 20/],
    ["secret with a double quote", { TEAMS_CLIENT_SECRET: `${GOOD}"x` }, /TEAMS_CLIENT_SECRET/],
    ["secret with a command substitution", { TEAMS_CLIENT_SECRET: `${GOOD}$(touch "$HOME/pwned")` }, /TEAMS_CLIENT_SECRET/],
    ["secret with a newline", { TEAMS_CLIENT_SECRET: `${GOOD}\nX=1` }, /TEAMS_CLIENT_SECRET/],
    ["secret with a space", { TEAMS_CLIENT_SECRET: `${GOOD} x` }, /TEAMS_CLIENT_SECRET/],
    ["secret starting with a dash", { TEAMS_CLIENT_SECRET: `-${GOOD}` }, /starts with '-'/],
    ["port 0", { TEAMS_PORT: "0" }, /TEAMS_PORT/],
    ["port 70000", { TEAMS_PORT: "70000" }, /TEAMS_PORT/],
    ["port with letters", { TEAMS_PORT: "80a" }, /TEAMS_PORT/],
    ["home channel with a space-free injection", { TEAMS_HOME_CHANNEL: "a;touch$IFS$HOME/pwned" }, /TEAMS_HOME_CHANNEL/],
    ["home channel starting with a dash", { TEAMS_HOME_CHANNEL: "-19:abc" }, /TEAMS_HOME_CHANNEL/],
    ["public URL over http", { TEAMS_PUBLIC_URL: "http://bot.example.com/api/messages" }, /TEAMS_PUBLIC_URL/],
    ["public URL with another path", { TEAMS_PUBLIC_URL: "https://bot.example.com/hook" }, /TEAMS_PUBLIC_URL/],
    ["public URL with credentials", { TEAMS_PUBLIC_URL: "https://u:p@bot.example.com/api/messages" }, /TEAMS_PUBLIC_URL/],
  ]) {
    it(`${label}: refused before any ssh, vendor call or write`, async () => {
      await scenario({ name: "teams-fmt", valid: [GOOD], script: flow(), env: env(over), knobs: knobs() }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /Nothing was written/);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.deepEqual(writeEvents(run), []);
        assert.ok(!run.sb.exists("pwned"));
        assert.ok(!run.sb.sshCalls().some((c) => c.includes("pwned")));
      });
    });
  }

  // Open-access switches already in the VPS .env make the allowlist meaningless.
  for (const [line, name] of [
    ["TEAMS_ALLOW_ALL_USERS=true", "TEAMS_ALLOW_ALL_USERS"], ["GATEWAY_ALLOW_ALL_USERS=1", "GATEWAY_ALLOW_ALL_USERS"], ["TEAMS_ALLOW_ALL_USERS=yes", "TEAMS_ALLOW_ALL_USERS"],
    ['GATEWAY_ALLOW_ALL_USERS="true"', "GATEWAY_ALLOW_ALL_USERS"], ["TEAMS_ALLOW_ALL_USERS=on", "TEAMS_ALLOW_ALL_USERS"], ["export TEAMS_ALLOW_ALL_USERS=1", "TEAMS_ALLOW_ALL_USERS"],
    [" GATEWAY_ALLOW_ALL_USERS = true", "GATEWAY_ALLOW_ALL_USERS"], ["GATEWAY_ALLOWED_USERS=555,*", "GATEWAY_ALLOWED_USERS"], ["GATEWAY_ALLOWED_USERS=*", "GATEWAY_ALLOWED_USERS"],
  ]) {
    it(`pre-existing ${line.trim()} aborts before any write`, async () => {
      await run1({ name: "teams-open", seed: { env: `FOO=bar\n${line}\n` } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, new RegExp(`turns on open access \\(${name}\\)`));
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });
  }
  for (const lines of ["TEAMS_ALLOW_ALL_USERS=false\nGATEWAY_ALLOW_ALL_USERS=0\n", "GATEWAY_ALLOW_ALL_USERS=off\nTEAMS_ALLOW_ALL_USERS=no\n", "GATEWAY_ALLOWED_USERS=555,666\n"]) {
    it(`explicitly-off or non-wildcard settings (${lines.trim().split("\n").join(", ")}) do not block`, async () => {
      await run1({ name: "teams-off", seed: { env: lines } }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.completed);
      });
    });
  }

  it("an explicit platforms.teams.enabled: false refuses (credentials would do nothing)", async () => {
    await run1({ name: "teams-disabled", seed: { config: "platforms.teams.enabled: false\n" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /platforms\.teams\.enabled is false/);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
      assert.equal(run.sb.curlCalls().length, 0);
    });
  });

  for (const key of ["client_id", "client_secret", "tenant_id", "port", "allowed_users", "allow_from"]) {
    it(`a platforms.teams.extra.${key} in config.yaml refuses (it is read before the env values)`, async () => {
      await run1({ name: "teams-shadow", seed: { config: `platforms.teams.extra.${key}: x\n` } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, new RegExp(`platforms\\.teams in config\\.yaml already sets: ${key}`));
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });
  }

  it("a harmless platforms.teams block (enabled: true, require_mention) does not block", async () => {
    await run1({ name: "teams-benign", seed: { config: "platforms.teams.enabled: true\nplatforms.teams.require_mention: true\n" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
    });
  });

  it("lazy installs off: refuses (the gateway could not install the SDK), unless the SDK is declared preinstalled", async () => {
    await run1({ name: "teams-lazy", seed: { config: "security.allow_lazy_installs: false\n" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /lazy installs are off on the VPS/);
      assertStateIdentical(run);
      assert.equal(run.sb.curlCalls().length, 0);
    });
    await run1({ name: "teams-lazy-env", seed: { env: "HERMES_DISABLE_LAZY_INSTALLS=1\n" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /lazy installs are off on the VPS/);
      assert.deepEqual(writeEvents(run), []);
    });
    await run1({ name: "teams-lazy-ok", seed: { config: "security.allow_lazy_installs: false\n" }, env: env({ TEAMS_SDK_PREINSTALLED: "1" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
    });
  });

  it("a leftover snapshot makes snapshot refuse; nothing is written", async () => {
    await run1({ name: "teams-left", seed: oldState, env: env({ FORCE: "1" }), setup: (sb) => sb.write(".hermes/.hstack-backup/platform-teams/.env", "junk\n") }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /did not finish/);
      assert.match(run.out, /ABORT: could not snapshot/);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
    });
  });
});

describe("platform-teams: failure after the snapshot restores byte for byte", { concurrency: 6 }, () => {
  const cases = [
    ["config set TEAMS_ALLOWED_USERS fails", { "fail.set.TEAMS_ALLOWED_USERS": true }, /could not write TEAMS_ALLOWED_USERS/],
    ["config set TEAMS_CLIENT_SECRET fails (everything else already written)", { "fail.set.TEAMS_CLIENT_SECRET": true }, /could not write TEAMS_CLIENT_SECRET/],
    ["the third config set fails", { "fail.set_nth": "3\n" }, /could not write/],
    ["no teams line in the logs", { "fail.logs": true }, /did not appear as connected/],
    ["the health route does not answer ok", { curl_routes: "127.0.0.1:3978/health\tnope\n" }, /did not answer ok/],
    ["nothing listens on the port", { local_down: true }, /did not answer ok/],
    ["the stored secret is rejected on read-back", { curl_force: "3=401\n" }, /did not get a Microsoft token/],
  ];
  for (const [label, kn, msg] of cases) {
    it(`FORCE=1 re-run: ${label}`, async () => {
      await run1({ name: "teams-rb", seed: oldState, knobs: kn, env: env({ FORCE: "1", TEAMS_HOME_CHANNEL: "19:abc@thread.tacv2" }), ...(kn["fail.logs"] ? { files: {} } : {}) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /rollback: restored/);
        assertStateIdentical(run);
        assert.equal(run.sb.read(".hermes/.env"), oldState.env);
        assert.equal(run.sb.read(".hermes/config.yaml"), oldState.config);
        assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-teams.prev"));
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-teams"));
        assertSecretsNotPrinted(run, [GOOD, OLD]);
      });
    });
  }

  it("open access appearing during the write is caught after the write and rolled back", async () => {
    const script = flow({ replace: [['COUNT=$(remote', `printf 'GATEWAY_ALLOW_ALL_USERS=true\\n' >> "$HOME/.hermes/.env"\nCOUNT=$(remote`]] });
    await run1({ name: "teams-inject", seed: oldState, script, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /turns on open access \(GATEWAY_ALLOW_ALL_USERS\)/);
      assert.match(run.out, /rollback: restored/);
      assertStateIdentical(run);
    });
  });

  it("a client secret that lands in config.yaml is caught and rolled back", async () => {
    const script = flow({ replace: [['COUNT=$(remote', `printf 'leak: %s\\n' "${GOOD}" >> "$HOME/.hermes/config.yaml"\nCOUNT=$(remote`]] });
    await run1({ name: "teams-cfgleak", seed: oldState, script, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /found in config\.yaml/);
      assertStateIdentical(run);
    });
  });

  it("a failing home-channel send rolls back and says how to proceed", async () => {
    await run1({ name: "teams-send", seed: oldState, knobs: { "fail.send": true }, env: env({ FORCE: "1", TEAMS_HOME_CHANNEL: "19:abc@thread.tacv2" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /failed \(wrong TEAMS_HOME_CHANNEL/);
      assert.match(run.out, /rollback: restored/);
      assertStateIdentical(run);
    });
  });

  it("first run (no .env before): rollback removes the files this skill created", async () => {
    await run1({ name: "teams-rb-first", knobs: { "fail.logs": true } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.ok(!run.sb.exists(".hermes/.env"), ".env created by the run must be removed");
      assertStateIdentical(run);
    });
  });

  it("the gateway never restarts ready: files restored, snapshot KEPT, rollback can be retried and then retires it", async () => {
    await run1({ name: "teams-rb-gw", seed: oldState, knobs: { "fail.gateway.restart": true }, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /gateway did not restart ready/);
      assert.match(run.out, /files restored, but the gateway did NOT come back/);
      assert.equal(run.sb.read(".hermes/.env"), oldState.env);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-teams"));
      assert.ok(!run.sb.exists(".hermes/.hstack-backup/platform-teams.prev"));
      const retry = assemble([{ skill: SKILL, ids: ["step0#1"] }, 'rm "$HSTACK_FAKE/knobs/fail.gateway.restart"\nrollback || exit 1\necho RECOVERED\n']);
      const recovered = await run.sb.run(retry);
      assert.equal(recovered.code, 0, recovered.out);
      assert.match(recovered.out, /RECOVERED/);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-teams.prev"));
    });
  });

  it("live sessions: the restart refusal is reported and never forced with -y", async () => {
    await run1({ name: "teams-live", seed: oldState, knobs: { live_sessions: true }, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /refused|live session/i);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/platform-teams"), "recovery point stays active until the gateway can reload");
      assert.ok(!run.sb.hermesCalls().some((c) => c.some((x) => ["-y", "--yes", "--force", "--all", "--interrupt"].includes(x))));
      assert.equal(run.sb.read(".hermes/.env"), oldState.env);
    });
  });
});

describe("platform-teams: what counts as connected in the gateway log", { concurrency: 6 }, () => {
  const L = (...lines) => lines.join("\n") + "\n";
  const ok = L("2026-01-01 INFO gateway.run: ✓ teams connected");
  const cases = [
    ["a plain connected line", ok, true],
    ["the adapter's listening line alone", L("INFO [teams] Webhook server listening on *:3978/api/messages"), true],
    ["failure then a newer success", L("✗ teams failed to connect", "✓ teams connected"), true],
    ["success then a newer failure", L("✓ teams connected", "✗ teams failed to connect"), false],
    ["success then a newer disconnect", L("✓ teams connected", "✓ teams disconnected (0.10s)"), false],
    ["a degraded connect", L("✓ teams connected (degraded)"), false],
    ["a fatal adapter error", L("✓ teams connected", "ERROR Fatal teams adapter error (MISSING_SDK): microsoft-teams-apps could not be installed"), false],
    ["the adapter's own connect failure", L("ERROR [teams] Failed to connect: boom"), false],
    ["an exception while connecting", L("✗ teams error: boom"), false],
    ["the startup summary of a parked platform", L("ERROR 1 configured platform(s) failed to start and are parked (fix the reported error): teams: Teams connection failed"), false],
    ["only another platform is connected", L("✓ telegram connected"), false],
    ["Connecting... but no result", L("INFO Connecting to teams..."), false],
    ["empty log", "", false],
  ];
  for (const [label, logs, want] of cases) {
    it(`${label}: ${want ? "connected" : "not connected (rolls back)"}`, async () => {
      await run1({ name: "teams-logs", seed: oldState, env: env({ FORCE: "1" }), files: { "logs.txt": logs || "\n" } }, async (run) => {
        if (want) {
          assert.equal(run.code, 0, run.out);
        } else {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, /did not appear as connected/);
          assertStateIdentical(run);
        }
      });
    });
  }
});

describe("platform-teams: secrets stay out of argv, files and output", { concurrency: 4 }, () => {
  it("the secret appears in no ssh command string, no curl argv, no output, and not in config.yaml, even on a failing run", async () => {
    await run1({ name: "teams-sec-fail", seed: oldState, knobs: { "fail.logs": true }, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1);
      assertNoSecretInArgv(run, [GOOD, OLD]);
      assertSecretsNotPrinted(run, [GOOD, OLD]);
    });
  });

  it("CONTROL: a skill that put the secret in the remote command would be caught by the same check", async () => {
    // Mutate the live preflight so the secret rides in the ssh command string; the argv check must now fail.
    const script = flow({ replace: [['| remote "curl -sS --max-time 15 --config -"', '| remote "curl -sS --max-time 15 --config - # $3"']] });
    await run1({ name: "teams-sec-ctl", script }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.throws(() => assertNoSecretInArgv(run, [GOOD]), /a secret appears in ssh call/);
    });
  });
});

describe("platform-teams: negative controls (the tests can see each defect)", { concurrency: 4 }, () => {
  it("CONTROL: without the exit after a rejected token, the run would continue and write", async () => {
    const script = flow({ replace: [['Nothing was written."\n  fi\n  exit 1', 'Nothing was written."\n  fi']] });
    // sanity: the replacement text exists in the real block, otherwise this control proves nothing
    assert.ok(loadBlocks(SKILL).find((b) => b.id === "step3#3").code.includes('Nothing was written."\n  fi\n  exit 1'));
    await run1({ name: "teams-ctl-exit", seed: oldState, valid: [OLD], script, env: env({ FORCE: "1" }) }, async (run) => {
      assert.ok(writeEvents(run).length > 0, "the mutated skill wrote after a rejected credential, so the real test above can detect that");
    });
  });

  it("CONTROL: with the open-access names removed from the scanner, TEAMS_ALLOW_ALL_USERS=true slips through (the real test above would fail)", async () => {
    const script = flow({ replace: [["(TEAMS_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS|GATEWAY_ALLOWED_USERS)=/) next", "(NOSUCH_NAME_ONE|NOSUCH_NAME_TWO|NOSUCH_NAME_THREE)=/) next"]] });
    await run1({ name: "teams-ctl-open", seed: { env: "TEAMS_ALLOW_ALL_USERS=true\n" }, script }, async (run) => {
      assert.ok(!run.out.includes("turns on open access"), run.out);
      assert.ok(writeEvents(run).length > 0, "the mutated skill wrote although open access was on");
    });
  });

  it("CONTROL: without the rollback on a missing connected log, the previous values are NOT restored", async () => {
    const script = flow({ replace: [['within 60s. Rolling back."; rollback; exit 1; }', 'within 60s. Rolling back."; exit 1; }']] });
    await run1({ name: "teams-ctl-rb", seed: oldState, knobs: { "fail.logs": true }, script, env: env({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1);
      assert.notDeepEqual(run.after, run.before, "the mutated skill leaves the half-written state behind");
    });
  });
});

describe("platform-teams: text-level guarantees", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const blocks = loadBlocks(SKILL);
  const codeLines = blocks.flatMap((b) => b.code.split("\n").filter((l) => !/^\s*#/.test(l)));

  it("names the human steps and the v0.22.5 facts the legacy text got wrong", () => {
    assert.match(text, /\*\*Human\*\*/);
    assert.match(text, /public HTTPS endpoint/);
    assert.match(text, /There is \*\*no `TEAMS_ENABLED` variable\*\*/);
    assert.match(text, /default is \*\*deny\*\*/);
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /plugins\/platforms\/teams\/adapter\.py/);
    assert.match(text, /\*\*Not verified:\*\*/);
  });

  it("never writes TEAMS_ENABLED, never uses a retired lifecycle, never appends to .env by hand", () => {
    for (const l of codeLines) {
      assert.ok(!/TEAMS_ENABLED/.test(l), l);
      assert.ok(!/gateway (run|stop)|--daemon/.test(l), l);
      assert.ok(!/>>\s*~?\/?\$?H?O?M?E?\/?\.hermes\/\.env/.test(l) || /fail/.test(l), l);
    }
  });

  it("every hermes call in a block is bound to the default profile", () => {
    // only lines that run something (through remote, or a bare hermes), not prose in a printed message
    for (const l of codeLines.filter((x) => /\bremote\b|^\s*hermes\b/.test(x) && !/^\s*(echo|HOME_LINE=)/.test(x))) {
      assert.doesNotMatch(l, /\bhermes (?!-p default)(config|gateway|logs|send|pairing|mcp|cron|setup|status|doctor)\b/, l);
    }
  });

  it("the client secret is never inside a remote command string", () => {
    for (const l of codeLines) {
      const stripped = l.replace(/\\\$/g, "");
      assert.ok(!/remote\s+["'][^|]*\$\{?TEAMS_CLIENT_SECRET\b/.test(stripped) || /echo|ABORT|FAIL/.test(l), l);
    }
  });
});
