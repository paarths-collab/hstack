// platform-whatsapp (the Baileys/Node bridge path): the real SKILL.md blocks against a simulated VPS (helpers/sandbox.mjs).
//
// What is real: the bash of the skill and the syntax of every `hermes ...` call it makes (the stub runs the vendored v0.22.5 argparse).
// What is assumed: what the stubs print (gateway log lines, the bridge's /health JSON, `hermes send`) and the human QR step, which a test
// can only simulate: the "human" is a `sleep` function injected before the run that creates the session file the way the pairing wizard
// (`hermes whatsapp`, hermes_cli/main_platform_setup.py:133-223) does after a successful scan.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateIdentical, idx, writeEvents } from "./helpers/asserts.mjs";
import { assemble, loadBlocks, skillPath } from "./helpers/blocks.mjs";
import { hermesInvocations } from "./helpers/hermes-calls.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "platform-whatsapp";
const N1 = "15550100101";
const N2 = "15550100102";
const OLD_N = "15550100177";
const CREDS = ".hermes/whatsapp/session/creds.json";
const CREDS_NEW = ".hermes/platforms/whatsapp/session/creds.json";
const HEALTH = '{"status":"connected","queueLength":0,"uptime":12.5,"scriptHash":"abc","sendReadReceipts":false,"session":"/x","capabilities":{"outboundMentions":true}}';
const ROUTES = `127.0.0.1:3000/health\t${HEALTH}\n`;

const FLOW = ["step1#1", "step2#1", "step3#1", "step3#2", "step4#1", "step5#1", "step5#2", "step6#1", "step7#1", "step8#1", "step9#1", "step10#1", "step10#2"];
// `prelude` runs after the Step 0 helpers and before the flow: the injected "human".
const flow = ({ ids = FLOW, replace = [], prelude = "" } = {}) =>
  assemble(["set +e\n", { skill: SKILL, ids: ["before-you-start#1", "step0#1"], replace }, prelude, { skill: SKILL, ids, replace }, SCRIPT_END]);
const gate = assemble(["set +e\n", { skill: SKILL, ids: ["step0#1", "step3#1"] }, SCRIPT_END]);

// A sleep() that makes the human pair on its Nth call: the wizard writes creds.json and, like the real one, WHATSAPP_ENABLED=true.
const human = (n = 2, extra = "") =>
  `__s=0\nsleep() { __s=$((__s + 1)); if [ "$__s" -eq ${n} ]; then mkdir -p "$HOME/.hermes/whatsapp/session"; echo '{"noiseKey":1}' > "$HOME/.hermes/whatsapp/session/creds.json"; printf 'WHATSAPP_ENABLED=true\\n' >> "$HOME/.hermes/.env"; ${extra} fi; }\n`;

const CONNECTED = [
  "2026-10-25 10:00:00,100 INFO gateway.run: ✓ whatsapp connected",
  "",
].join("\n");

const env = (over = {}) => ({ WHATSAPP_ALLOWED_USERS: N1, WHATSAPP_MODE: "bot", PAIR_TRIES: "4", ...over });
const paired = (sb) => sb.write(CREDS, '{"noiseKey":1}\n');
const oldState = {
  env: `FOO=bar\nWHATSAPP_ENABLED=true\nWHATSAPP_MODE=self-chat\nWHATSAPP_ALLOWED_USERS=${OLD_N}\nOTHER_KEY=keep-me\n`,
  config: "model.default: old/model\nplatforms.whatsapp.enabled: true\n",
};
const writeKeys = (r) => r.sb.events().filter((e) => e.startsWith("hermes config set ")).map((e) => e.slice("hermes config set ".length));
const gwCalls = (r) => r.sb.hermesCalls().map((c) => (c[0] === "-p" ? c.slice(2) : c)).filter((c) => c[0] === "gateway").map((c) => c.join(" "));
const run = (opts, fn) =>
  scenario({ valid: [], script: flow(), env: env(), files: { "logs.txt": CONNECTED }, ...opts, knobs: { curl_routes: ROUTES, ...(opts.knobs || {}) } }, fn);
const pairedRun = (opts, fn) => run({ setup: paired, ...opts }, fn);

describe("platform-whatsapp: good run", { concurrency: 6 }, () => {
  it("already paired: allowlist and policy first, enable flag only after, native reload, bridge /health confirms; no vendor call before the first write", async () => {
    await pairedRun({ name: "wa-good", env: env({ WHATSAPP_HOME_CHANNEL: N2 }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(r.completed);
      assert.deepEqual(writeKeys(r), ["WHATSAPP_MODE", "WHATSAPP_ALLOWED_USERS", "WHATSAPP_HOME_CHANNEL", "WHATSAPP_DM_POLICY", "WHATSAPP_ENABLED", "platforms.whatsapp.enabled"]);
      const text = r.sb.read(".hermes/.env");
      assert.match(text, /^WHATSAPP_MODE=bot$/m);
      assert.match(text, new RegExp(`^WHATSAPP_ALLOWED_USERS=${N1}$`, "m"));
      assert.match(text, new RegExp(`^WHATSAPP_HOME_CHANNEL=${N2}$`, "m"));
      assert.match(text, /^WHATSAPP_DM_POLICY=allowlist$/m, "the strict native policy: nobody outside the allowlist, no pairing codes to strangers");
      assert.match(text, /^WHATSAPP_ENABLED=true$/m);
      assert.ok(!text.includes("WHATSAPP_ALLOW_ALL_USERS") && !text.includes("WHATSAPP_GROUP_POLICY"));
      assert.equal(r.sb.mode(".hermes/.env"), 0o600);
      assert.match(r.sb.read(".hermes/config.yaml"), /^platforms\.whatsapp\.enabled: true$/m);
      // there is NO vendor-side preflight for the bridge: the only curl calls are the loopback bridge health polls after the reload
      const curls = r.sb.curlCalls();
      assert.ok(curls.length >= 1);
      for (const c of curls) assert.equal(c.url, "http://127.0.0.1:3000/health");
      const ev = r.sb.events();
      assert.ok(idx(ev, /^curl/) > idx(ev, /^hermes gateway restart/), "health is polled only after the reload");
      const gw = gwCalls(r);
      assert.ok(gw.includes("gateway restart --detach"), gw.join("\n"));
      assert.ok(!gw.some((c) => /\bstop\b|\brun\b|--daemon|status|-y\b|--force|--all/.test(c)), gw.join("\n"));
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-whatsapp.prev"));
      assert.match(r.out, /OK: WhatsApp connected/);
      assert.ok(r.sb.exists(CREDS), "the paired session is never touched");
      assertNoSecretInArgv(r, [N1, N2]);
      assertSecretsNotPrinted(r, [N1, N2]);
    });
  });

  it("a session paired through the dashboard (platforms/whatsapp/session) counts as paired: no human step", async () => {
    await run({ name: "wa-newpath", setup: (sb) => sb.write(CREDS_NEW, "{}\n") }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /HUMAN STEP/);
    });
  });

  it("not paired yet: stops for the human, prints the interactive command, continues once the session file appears, ends with one WHATSAPP_ENABLED line", async () => {
    await run({ name: "wa-human", script: flow({ prelude: human(2) }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /HUMAN STEP/);
      assert.match(r.out, /ssh -t /);
      assert.match(r.out, /hermes -p default whatsapp/);
      assert.match(r.out, /Linked Devices/);
      // nothing was enabled before the human finished
      const ev = r.sb.events();
      const pairedAt = idx(ev, /^hermes config set WHATSAPP_ENABLED/);
      assert.ok(pairedAt > idx(ev, /^hermes config set WHATSAPP_DM_POLICY/));
      assert.equal(r.sb.read(".hermes/.env").split("\n").filter((l) => l === "WHATSAPP_ENABLED=true").length, 1);
      assert.match(r.out, /OK: WhatsApp connected/);
    });
  });

  it("the interactive wizard is never executed by a block (it needs a terminal and a phone)", () => {
    const inv = hermesInvocations(readFileSync(skillPath(SKILL), "utf8"));
    assert.ok(inv.length > 5, "extractor sees the skill's hermes calls");
    assert.deepEqual(inv.filter((i) => /^whatsapp(-cloud)?$/.test(i.argv.filter((a) => a !== "-p" && a !== "default")[0] || "")).map((i) => i.text), []);
  });

  it("already wired (enabled, valid allowlist, paired, private file, no open switch) without FORCE: exits 0, nothing written", async () => {
    await pairedRun({ name: "wa-idem", seed: oldState }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /already wired/i);
      assert.ok(!r.completed);
      assertStateIdentical(r);
      assert.deepEqual(writeEvents(r), []);
      assert.equal(r.sb.curlCalls().length, 0);
    });
  });

  it("enabled but NOT paired is not 'already wired'", async () => {
    await run({ name: "wa-idem-unpaired", seed: oldState, script: flow({ prelude: human(2) }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /already wired/i);
      assert.match(r.out, /HUMAN STEP/);
    });
  });

  for (const [label, lines, mode] of [
    ["wildcard allowlist", "WHATSAPP_ALLOWED_USERS=*\n"],
    ["wildcard after a number", `WHATSAPP_ALLOWED_USERS=${OLD_N},*\n`],
    ["a plus sign in the allowlist", `WHATSAPP_ALLOWED_USERS=+${OLD_N}\n`],
    ["duplicate allowlist", `WHATSAPP_ALLOWED_USERS=${OLD_N}\nWHATSAPP_ALLOWED_USERS=${N1}\n`],
    ["open DM policy", `WHATSAPP_ALLOWED_USERS=${OLD_N}\nWHATSAPP_DM_POLICY=open\n`],
    ["open group policy", `WHATSAPP_ALLOWED_USERS=${OLD_N}\nWHATSAPP_GROUP_POLICY=open\n`],
    ["whatsapp allow-all switch", `WHATSAPP_ALLOWED_USERS=${OLD_N}\nWHATSAPP_ALLOW_ALL_USERS=true\n`],
    ["gateway allow-all switch", `WHATSAPP_ALLOWED_USERS=${OLD_N}\nGATEWAY_ALLOW_ALL_USERS=1\n`],
    ["world-readable env", `WHATSAPP_ALLOWED_USERS=${OLD_N}\n`, 0o644],
  ]) {
    it(`already wired with ${label}: aborts instead of reporting success`, async () => {
      const seed = { env: `WHATSAPP_ENABLED=true\n${lines}`, envMode: mode ?? 0o600 };
      await pairedRun({ name: "wa-idem-unsafe", seed }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /stored WhatsApp setup is unsafe/);
        assert.ok(!r.out.includes("already wired"));
        assertStateIdentical(r);
        assert.deepEqual(writeEvents(r), []);
      });
    });
  }
});

describe("platform-whatsapp: hard gate (nothing is written, no snapshot)", { concurrency: 6 }, () => {
  for (const [label, users, msg] of [
    ["empty", "", /WHATSAPP_ALLOWED_USERS is empty/],
    ["only separators", " , ,", /WHATSAPP_ALLOWED_USERS is empty/],
    ["*", "*", /contains a wildcard/],
    ["number,*", `${N1},*`, /contains a wildcard/],
    ["with a plus sign", `+${N1}`, /invalid entries in WHATSAPP_ALLOWED_USERS/],
    ["with dashes", "1555-010-0101", /invalid entries in WHATSAPP_ALLOWED_USERS/],
    ["too short", "12345", /invalid entries in WHATSAPP_ALLOWED_USERS/],
    ["a JID", `${N1}@s.whatsapp.net`, /invalid entries in WHATSAPP_ALLOWED_USERS/],
    ["an @lid", "100000000000001@lid", /invalid entries in WHATSAPP_ALLOWED_USERS/],
    ["command injection", `${N1}; touch "$HOME/pwned"`, /invalid entries in WHATSAPP_ALLOWED_USERS/],
    ["command substitution", '$(touch "$HOME/pwned")', /invalid entries in WHATSAPP_ALLOWED_USERS/],
  ]) {
    it(`allowlist ${JSON.stringify(label)} is refused before any ssh/curl`, async () => {
      await scenario({ name: "wa-allow", script: gate, env: env({ WHATSAPP_ALLOWED_USERS: users }) }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, msg);
        assert.match(r.out, /Nothing was written/);
        assert.equal(r.sb.sshCalls().length, 0);
        assert.equal(r.sb.curlCalls().length, 0);
        assert.ok(!r.sb.exists("pwned"));
        assert.ok(!r.out.includes(N1), "entries are not echoed back");
      });
    });
  }

  for (const [label, over, msg] of [
    ["mode missing", { WHATSAPP_MODE: "" }, /WHATSAPP_MODE must be/],
    ["mode unknown", { WHATSAPP_MODE: "open" }, /WHATSAPP_MODE must be/],
    ["home channel with a plus", { WHATSAPP_HOME_CHANNEL: `+${N2}` }, /invalid WHATSAPP_HOME_CHANNEL/],
    ["home channel two numbers", { WHATSAPP_HOME_CHANNEL: `${N1},${N2}` }, /invalid WHATSAPP_HOME_CHANNEL/],
    ["home channel injection", { WHATSAPP_HOME_CHANNEL: `${N1};touch $HOME/pwned` }, /invalid WHATSAPP_HOME_CHANNEL/],
    ["bridge port with text", { BRIDGE_PORT: "3000;touch $HOME/pwned" }, /BRIDGE_PORT must be a port number/],
    ["bridge port zero", { BRIDGE_PORT: "0" }, /BRIDGE_PORT must be a port number/],
  ]) {
    it(`${label} is refused before any ssh/curl`, async () => {
      await scenario({ name: "wa-fmt", script: gate, env: env(over) }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, msg);
        assert.match(r.out, /Nothing was written/);
        assert.equal(r.sb.sshCalls().length, 0);
        assert.ok(!r.sb.exists("pwned"));
      });
    });
  }

  it("both modes are accepted, and the allowlist is normalised", async () => {
    await pairedRun({ name: "wa-selfchat", env: env({ WHATSAPP_MODE: "self-chat", WHATSAPP_ALLOWED_USERS: ` ${N1} , ${N2},, ` }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.sb.read(".hermes/.env"), new RegExp(`^WHATSAPP_ALLOWED_USERS=${N1},${N2}$`, "m"));
      assert.match(r.sb.read(".hermes/.env"), /^WHATSAPP_MODE=self-chat$/m);
    });
  });

  for (const [line, name] of [
    ["WHATSAPP_ALLOW_ALL_USERS=true", "WHATSAPP_ALLOW_ALL_USERS"], ["GATEWAY_ALLOW_ALL_USERS=1", "GATEWAY_ALLOW_ALL_USERS"], ["WHATSAPP_ALLOW_ALL_USERS=yes", "WHATSAPP_ALLOW_ALL_USERS"],
    ['GATEWAY_ALLOW_ALL_USERS="true"', "GATEWAY_ALLOW_ALL_USERS"], ["export WHATSAPP_ALLOW_ALL_USERS=1", "WHATSAPP_ALLOW_ALL_USERS"], [" GATEWAY_ALLOW_ALL_USERS = true", "GATEWAY_ALLOW_ALL_USERS"],
    ["WHATSAPP_DM_POLICY=open", "WHATSAPP_DM_POLICY"], ["WHATSAPP_DM_POLICY=OPEN", "WHATSAPP_DM_POLICY"], ['WHATSAPP_GROUP_POLICY="open"', "WHATSAPP_GROUP_POLICY"],
    ["WHATSAPP_ALLOWED_USERS=*", "WHATSAPP_ALLOWED_USERS"], [`WHATSAPP_ALLOWED_USERS=${N2},*`, "WHATSAPP_ALLOWED_USERS"],
    ["WHATSAPP_GROUP_ALLOWED_USERS=*", "WHATSAPP_GROUP_ALLOWED_USERS"], ["GATEWAY_ALLOWED_USERS=*", "GATEWAY_ALLOWED_USERS"],
  ]) {
    it(`pre-existing ${JSON.stringify(line)} aborts before any write`, async () => {
      await pairedRun({ name: "wa-open", seed: { env: `FOO=bar\n${line}\n` } }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, new RegExp(`turns on open access \\(${name}\\)`));
        assert.match(r.out, /Nothing was written/);
        assertStateIdentical(r);
        assert.deepEqual(writeEvents(r), []);
      });
    });
  }
  for (const lines of ["WHATSAPP_ALLOW_ALL_USERS=false\nGATEWAY_ALLOW_ALL_USERS=0\n", "WHATSAPP_DM_POLICY=pairing\nWHATSAPP_GROUP_POLICY=allowlist\n", "WHATSAPP_DM_POLICY=allowlist\n"]) {
    it(`non-open settings (${lines.trim().split("\n").join(", ")}) do not block`, async () => {
      await pairedRun({ name: "wa-off", seed: { env: lines } }, async (r) => {
        assert.equal(r.code, 0, r.out);
        assert.match(r.sb.read(".hermes/.env"), /^WHATSAPP_DM_POLICY=allowlist$/m);
      });
    });
  }

  it("a leftover snapshot makes snapshot refuse; nothing is written", async () => {
    await pairedRun({ name: "wa-left", seed: oldState, env: env({ FORCE: "1" }), setup: (sb) => { paired(sb); sb.write(".hermes/.hstack-backup/platform-whatsapp/.env", "junk\n"); } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /did not finish/);
      assert.match(r.out, /ABORT: could not snapshot/);
      assertStateIdentical(r);
      assert.deepEqual(writeEvents(r), []);
    });
  });
});

describe("platform-whatsapp: the human step", { concurrency: 4 }, () => {
  it("the QR is never scanned: the skill gives up after PAIR_TRIES polls, restores everything and reloads", async () => {
    await run({ name: "wa-nopair", seed: oldState, env: env({ FORCE: "1", PAIR_TRIES: "3" }), setup: undefined }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /no WhatsApp session appeared/);
      assert.equal(r.sb.read(".hermes/.env"), oldState.env);
      assert.equal(r.sb.read(".hermes/config.yaml"), oldState.config);
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-whatsapp.prev"));
      assert.ok(!writeEvents(r).some((e) => /WHATSAPP_ENABLED/.test(e)), "never enabled without a session");
    });
  });

  it("the wizard's allowlist answer replaced ours with a wildcard: detected, rolled back", async () => {
    const swap = `printf 'WHATSAPP_ALLOWED_USERS=*\\n' >> "$HOME/.hermes/.env";`;
    await run({ name: "wa-wizard-star", seed: oldState, env: env({ FORCE: "1" }), script: flow({ prelude: human(2, swap) }) }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /(turns on open access \(WHATSAPP_ALLOWED_USERS\)|allowlist on the VPS no longer matches)/);
      assert.equal(r.sb.read(".hermes/.env"), oldState.env);
      assert.ok(r.sb.exists(CREDS), "the paired session is kept so the operator does not need a second QR scan");
    });
  });

  it("the wizard's allowlist answer replaced ours with other numbers: detected, rolled back", async () => {
    const swap = `grep -v '^WHATSAPP_ALLOWED_USERS=' "$HOME/.hermes/.env" > "$HOME/.hermes/.env.tmp"; cat "$HOME/.hermes/.env.tmp" > "$HOME/.hermes/.env"; rm -f "$HOME/.hermes/.env.tmp"; printf 'WHATSAPP_ALLOWED_USERS=${N2}\\n' >> "$HOME/.hermes/.env";`;
    await run({ name: "wa-wizard-swap", seed: oldState, env: env({ FORCE: "1" }), script: flow({ prelude: human(2, swap) }) }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /allowlist on the VPS no longer matches/);
      assert.equal(r.sb.read(".hermes/.env"), oldState.env);
    });
  });

  it("a snapshot taken BEFORE the human step is what rollback restores (the wizard's own .env edits are undone too)", async () => {
    await run({ name: "wa-wizard-rb", seed: oldState, env: env({ FORCE: "1" }), knobs: { "fail.logs": true }, script: flow({ prelude: human(2) }) }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.equal(r.sb.read(".hermes/.env"), oldState.env);
      assert.ok(r.sb.exists(CREDS));
    });
  });
});

describe("platform-whatsapp: a failure after the snapshot restores the previous values and reloads", { concurrency: 6 }, () => {
  const cases = [
    ["config set WHATSAPP_ALLOWED_USERS fails", { "fail.set.WHATSAPP_ALLOWED_USERS": true }, /could not write WHATSAPP_ALLOWED_USERS/],
    ["config set WHATSAPP_DM_POLICY fails", { "fail.set.WHATSAPP_DM_POLICY": true }, /could not write WHATSAPP_DM_POLICY/],
    ["config set WHATSAPP_ENABLED fails", { "fail.set.WHATSAPP_ENABLED": true }, /could not write WHATSAPP_ENABLED/],
    ["second config set fails", { "fail.set_nth": "2\n" }, /could not write/],
    ["no WhatsApp line in the logs", { "fail.logs": true }, /did not become ready/],
    ["open access appears during the write", { inject_allowall: true }, /turns on open access/],
    ["the bridge is not reachable (nothing listens)", { local_down: true }, /did not become ready/],
    ["the bridge answers but WhatsApp is not connected", { curl_routes: '127.0.0.1:3000/health\t{"status":"disconnected","session":"/x"}\n' }, /did not become ready/],
    ["the bridge answers 503", { local_status: "503" }, /did not become ready/],
  ];
  for (const [label, knobs, msg] of cases) {
    it(`FORCE=1 re-run: ${label}`, async () => {
      await pairedRun({ name: "wa-rb", seed: oldState, knobs, env: env({ FORCE: "1", WHATSAPP_HOME_CHANNEL: N2 }) }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, msg);
        assert.match(r.out, /rollback: restored/);
        assertStateIdentical(r);
        assert.equal(r.sb.read(".hermes/.env"), oldState.env);
        assert.equal(r.sb.read(".hermes/config.yaml"), oldState.config);
        assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-whatsapp.prev"));
        assert.ok(!r.sb.exists(".hermes/.hstack-backup/platform-whatsapp"));
        assert.ok(r.sb.exists(CREDS), "rollback never deletes the paired session");
        assert.ok(writeEvents(r).some((e) => e.startsWith("hermes config set")), "a write must have happened for the rollback to be meaningful");
        assert.ok(gwCalls(r).filter((c) => c === "gateway restart --detach").length >= 1);
      });
    });
  }

  for (const [label, logs] of [
    ["a failed connect", "2026-10-25 10:00:00,300 WARNING gateway.run: ✗ whatsapp failed to connect\n"],
    ["a later failure", `${CONNECTED}2026-10-25 10:05:00,000 ERROR gateway.run: ✗ whatsapp error: bridge exited\n`],
    ["enabled but not paired", "2026-10-25 10:00:00,300 WARNING plugins.platforms.whatsapp.adapter: [whatsapp] WhatsApp is enabled but not paired (no creds.json at /root/.hermes/whatsapp/session/creds.json). Pair from the dashboard or run `hermes whatsapp`; remove WHATSAPP_ENABLED from your .env to disable.\n"],
    ["bridge start failure", "2026-10-25 10:00:00,300 ERROR plugins.platforms.whatsapp.adapter: [whatsapp] Failed to start bridge: boom\n"],
    ["only unrelated lines", "2026-10-25 10:00:00,300 INFO gateway.run: ✓ telegram connected\n"],
  ]) {
    it(`logs reporting ${label} cannot finish setup, even though the bridge /health says connected`, async () => {
      await pairedRun({ name: "wa-neglog", seed: oldState, files: { "logs.txt": logs }, env: env({ FORCE: "1" }) }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /did not become ready/);
        assert.ok(!r.out.includes("OK: WhatsApp connected"));
        assert.equal(r.sb.read(".hermes/.env"), oldState.env);
      });
    });
  }

  it("the LATEST WhatsApp status line wins", async () => {
    const logs = `2026-10-25 09:59:00,000 WARNING gateway.run: ✗ whatsapp failed to connect\n${CONNECTED}`;
    await pairedRun({ name: "wa-latest", files: { "logs.txt": logs } }, async (r) => {
      assert.equal(r.code, 0, r.out);
    });
  });

  it("a custom bridge port (BRIDGE_PORT) is the one probed", async () => {
    await pairedRun({ name: "wa-port", env: env({ BRIDGE_PORT: "3042" }), knobs: { curl_routes: `127.0.0.1:3042/health\t${HEALTH}\n` } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(r.sb.curlCalls().every((c) => c.url === "http://127.0.0.1:3042/health"));
    });
  });

  it("the bridge port recorded by Hermes (platforms/whatsapp/bridge_port) is used when BRIDGE_PORT is not set", async () => {
    await pairedRun({ name: "wa-port-rec", knobs: { curl_routes: `127.0.0.1:3055/health\t${HEALTH}\n` }, setup: (sb) => { paired(sb); sb.write(".hermes/platforms/whatsapp/bridge_port", "3055"); } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(r.sb.curlCalls().every((c) => c.url === "http://127.0.0.1:3055/health"));
    });
  });

  it("first run (no .env before): rollback removes the files this skill created", async () => {
    await pairedRun({ name: "wa-rb-first", knobs: { "fail.logs": true } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.ok(!r.sb.exists(".hermes/.env"));
      assert.ok(!r.sb.exists(".hermes/config.yaml"));
      assertStateIdentical(r);
    });
  });

  it("live sessions refuse the restart: reported, rolled back, never overridden with -y; the recovery point is kept", async () => {
    await pairedRun({ name: "wa-live", seed: oldState, knobs: { live_sessions: true }, env: env({ FORCE: "1" }) }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /GW_INTERRUPT=1/);
      assert.match(r.out, /files restored, but the gateway did NOT come back/);
      assert.equal(r.sb.read(".hermes/.env"), oldState.env);
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-whatsapp"));
      assert.ok(!gwCalls(r).some((c) => / -y\b/.test(c)));
    });
  });

  it("recovery: once the fault is gone, the Step 0 rollback completes and retires the snapshot", async () => {
    await pairedRun({ name: "wa-recover", seed: oldState, knobs: { restart_noop: true }, env: env({ FORCE: "1" }) }, async (r) => {
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-whatsapp"));
      const retry = assemble([{ skill: SKILL, ids: ["step0#1"] }, 'rm "$HSTACK_FAKE/knobs/restart_noop"\nrollback || exit 1\necho RECOVERED\n']);
      const again = await r.sb.run(retry);
      assert.equal(again.code, 0, again.out);
      assert.match(again.out, /RECOVERED/);
      assert.equal(r.sb.read(".hermes/.env"), oldState.env);
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-whatsapp.prev"));
    });
  });
});

describe("platform-whatsapp: numbers stay out of argv, output and shown logs", { concurrency: 4 }, () => {
  it("log lines shown on failure have long digit runs masked", async () => {
    const logs = `2026-10-25 10:00:00,000 INFO gateway.run: whatsapp message from ${N1}@s.whatsapp.net\n2026-10-25 10:00:01,000 WARNING gateway.run: ✗ whatsapp failed to connect (${N2})\n`;
    await pairedRun({ name: "wa-mask", files: { "logs.txt": logs } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.ok(!r.out.includes(N1) && !r.out.includes(N2), "a number leaked into the output");
      assert.match(r.out, /failed to connect/);
    });
  });

  it("CONTROL: without the mask the same line WOULD leak (the test can see a leak)", async () => {
    const logs = `2026-10-25 10:00:01,000 WARNING gateway.run: ✗ whatsapp failed to connect (${N2})\n`;
    const script = flow({ replace: [["sed -E 's/[0-9]{7,15}/<n>/g' | ", ""]] });
    assert.ok(script !== flow(), "control did not remove the mask");
    await pairedRun({ name: "wa-mask-ctl", files: { "logs.txt": logs }, script }, async (r) => {
      assert.ok(r.out.includes(N2));
    });
  });
});

describe("platform-whatsapp: smoke send is opt-in", { concurrency: 4 }, () => {
  it("default: no message is sent", async () => {
    await pairedRun({ name: "wa-nosend" }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(!r.sb.events().some((e) => e.startsWith("hermes send")));
    });
  });
  it("SMOKE_SEND=1 sends ONE fixed message to the first allowlisted number with the native `hermes send --to`, the number travelling over stdin", async () => {
    await pairedRun({ name: "wa-send", env: env({ SMOKE_SEND: "1", WHATSAPP_ALLOWED_USERS: `${N2},${N1}` }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(r.sb.events().filter((e) => e.startsWith("hermes send")), [`hermes send whatsapp:+${N2}`]);
      assertNoSecretInArgv(r, [N2]);
      assertSecretsNotPrinted(r, [N2]);
    });
  });
  it("a failing smoke send is a WARN only", async () => {
    await pairedRun({ name: "wa-send-fail", knobs: { "fail.send": true }, env: env({ SMOKE_SEND: "1" }) }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /WARN: the smoke message was not delivered/);
      assert.ok(r.sb.exists(".hermes/.hstack-backup/platform-whatsapp.prev"));
    });
  });
});

describe("platform-whatsapp: text and structure", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const code = loadBlocks(SKILL).map((b) => b.code).join("\n");
  it("does not claim that an empty allowlist fails open (source: bridge.js rejects, gateway default-denies) and does not cite the stale LID bug", () => {
    assert.doesNotMatch(text, /fails? OPEN/i);
    assert.doesNotMatch(text, /#14486|#15108/);
  });
  it("uses the real session location and states which WhatsApp integration it is", () => {
    assert.match(text, /whatsapp\/session\/creds\.json/);
    assert.match(text, /whatsapp-cloud/);
    assert.match(text, /WHATSAPP_CLOUD_ACCESS_TOKEN/);
  });
  it("never uses the retired lifecycle", () => {
    assert.ok(!/gateway (stop|run)|--daemon/.test(code));
  });
  it("states plainly that nothing here was run against a real WhatsApp account", () => {
    assert.match(text, /Verified against Hermes v0\.22\.5/);
    assert.match(text, /not\s+(been\s+)?(run|exercised|tested)\s+against\s+a\s+real/i);
  });
});
