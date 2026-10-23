// integration-notion and integration-github: the same repaired shape, tested with one table of
// vendor facts. The real SKILL.md blocks run in ONE /bin/bash script against a simulated VPS
// (see helpers/sandbox.mjs); the assertions are about observable outcomes: what the stubs saw, in what
// order, and whether ~/.hermes/.env and config.yaml are byte-identical after a failure.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, curlEvents, idx, writeEvents } from "./helpers/asserts.mjs";
import { assemble } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

const VENDORS = [
  {
    skill: "integration-notion",
    var: "NOTION_TOKEN",
    mcp: "notion",
    url: /api\.notion\.com\/v1\/search/,
    token: fake.notion,
    legacy: fake.notionLegacy,
    wrongPrefix: "abcd_" + "x".repeat(30),
    extraEnv: {},
    registeredLog: "registered 3 tool(s) for 'notion'",
  },
  {
    skill: "integration-github",
    var: "GITHUB_TOKEN",
    mcp: "github",
    url: /api\.github\.com\/user/,
    token: fake.github,
    legacy: fake.githubFine,
    wrongPrefix: "abcd_" + "x".repeat(30),
    extraEnv: {},
    registeredLog: "registered tool github",
  },
];

const FLOW = ["step1#1", "step2#1", "step3#1", "step3#2", "step4#1", "step5#1", "step5#2", "step6.pathA#1", "step6.pathA#2", "step7#1", "step8#1", "step9#1"];

const flow = (v, { ids = FLOW, replace = [], pre = "" } = {}) =>
  assemble([
    "set +e\n",
    pre,
    { skill: v.skill, ids: ["before-you-start#1", "step0#1"], replace },
    { skill: v.skill, ids, replace },
    SCRIPT_END,
  ]);

const seedEnv = (v, oldTok) => `FOO=bar\n${v.var}=${oldTok}\nOTHER_KEY=keep-me\n`;
const seedConfig = (v) => `model.default: old/model\nmcp.${v.mcp}:\n  env: ${v.var}=\${${v.var}}\n  command: old\n`;

for (const v of VENDORS) {
  describe(`${v.skill}`, { concurrency: 6 }, () => {
    const NEW = v.token("N");
    const OLD = v.token("O");
    const forced = { FORCE: "1", [v.var]: NEW };

    it("good token: vendor preflight BEFORE any write, secret only in .env (600), ${VAR} in config.yaml, snapshot kept as .prev", async () => {
      await scenario({ name: `${v.mcp}-good`, valid: [NEW], script: flow(v), env: { [v.var]: NEW } }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.completed);
        const ev = run.sb.events();
        const firstCurl = idx(ev, /^curl status=200/);
        const firstWrite = idx(ev, /^hermes (config set|mcp add|gateway (stop|run))/);
        assert.ok(firstCurl >= 0 && firstWrite >= 0 && firstCurl < firstWrite, `preflight (event ${firstCurl}) must come before the first write (event ${firstWrite})`);
        // exactly two vendor calls: the preflight and the smoke test, each against the vendor endpoint with the real token length
        const curls = run.sb.curlCalls();
        assert.equal(curls.length, 2);
        for (const c of curls) {
          assert.match(c.url, v.url);
          assert.equal(c.status, "200");
          assert.equal(Number(c.token_len), NEW.length, "the stub saw an empty or wrong token");
        }
        // writes: the secret via config set, MCP registered, gateway cycled with stop + ensure (never restart)
        const writes = writeEvents(run);
        assert.ok(writes.includes(`hermes config set ${v.var}`));
        assert.ok(writes.includes(`hermes mcp add ${v.mcp}`));
        assert.ok(idx(writes, /gateway stop/) < idx(writes, /gateway ensure/));
        assert.ok(!run.sb.hermesCalls().some((c) => c[0] === "gateway" && c[1] === "restart"));
        // storage
        const env = run.sb.read(".hermes/.env");
        assert.equal(env.split("\n").filter((l) => l === `${v.var}=${NEW}`).length, 1);
        assert.equal(run.sb.mode(".hermes/.env"), 0o600);
        const cfg = run.sb.read(".hermes/config.yaml");
        assert.ok(cfg.includes(`\${${v.var}}`), "config.yaml must reference the secret by ${VAR}");
        assert.ok(!cfg.includes(NEW), "plaintext secret in config.yaml");
        // snapshot -> .prev; a first run has nothing to restore, so both files are marked absent
        assert.ok(run.sb.exists(`.hermes/.hstack-backup/${v.skill}.prev/.env.absent`));
        assert.ok(run.sb.exists(`.hermes/.hstack-backup/${v.skill}.prev/config.yaml.absent`));
        assert.ok(!run.sb.exists(`.hermes/.hstack-backup/${v.skill}`), "snapshot dir must be gone after finish");
        assert.equal(run.sb.mode(`.hermes/.hstack-backup/${v.skill}.prev`), 0o700);
        assertNoSecretInArgv(run, [NEW]);
        assertSecretsNotPrinted(run, [NEW]);
      });
    });

    it("FORCE=1 over an old token: the smoke test reads the NEW token back from .env; .prev holds the old files", async () => {
      // Only the new token is valid: a smoke test that sent the old or an empty token would get 401.
      const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
      await scenario({ name: `${v.mcp}-force`, seed, valid: [NEW], script: flow(v), env: forced }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.completed);
        assertStateChanged(run);
        const env = run.sb.read(".hermes/.env");
        assert.match(env, new RegExp(`^${v.var}=${NEW}$`, "m"));
        assert.ok(!env.includes(OLD));
        assert.ok(env.includes("FOO=bar") && env.includes("OTHER_KEY=keep-me"), "unrelated keys must survive");
        assert.equal(run.sb.read(`.hermes/.hstack-backup/${v.skill}.prev/.env`), seed.env, ".prev must hold the exact old .env");
        assert.equal(run.sb.read(`.hermes/.hstack-backup/${v.skill}.prev/config.yaml`), seed.config);
        assert.equal(run.sb.mode(".hermes/.env"), 0o600);
        assert.equal(run.sb.curlCalls().at(-1).status, "200");
        assertNoSecretInArgv(run, [NEW, OLD]);
      });
    });

    it("quoted values in .env are stripped by the smoke test read-back", async () => {
      await scenario({ name: `${v.mcp}-quoted`, valid: [NEW], knobs: { quote_env: true }, script: flow(v), env: { [v.var]: NEW } }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.equal(run.sb.curlCalls().at(-1).status, "200");
      });
    });

    it("bad token: ABORT after the preflight, state byte-identical, no snapshot, no write calls", async () => {
      const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
      await scenario({ name: `${v.mcp}-bad`, seed, valid: [OLD], script: flow(v), env: { ...forced } }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /ABORT: .*rejected the token \(HTTP 401/);
        assert.ok(!run.completed);
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), [], "a hermes write call happened before/after a failed preflight");
        assert.equal(curlEvents(run).length, 1);
        assert.ok(!run.sb.exists(".hermes/.hstack-backup"), "no snapshot may exist: nothing was written");
        assert.equal(run.sb.read(".hermes/.env"), seed.env);
      });
    });

    it("vendor unreachable: ABORT, nothing written", async () => {
      await scenario({ name: `${v.mcp}-netdown`, valid: [NEW], knobs: { net_down: true }, script: flow(v), env: forced }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /ABORT:/);
        assert.deepEqual(writeEvents(run), []);
        assert.ok(!run.sb.exists(".hermes/.env"));
      });
    });

    it("FORCE=1 re-run + failing smoke test: rollback restores the old .env AND config.yaml byte-for-byte", async () => {
      const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
      await scenario({ name: `${v.mcp}-smoke-fail`, seed, valid: [NEW, OLD], knobs: { curl_force: "2=401\n" }, script: flow(v), env: forced }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /FAIL: .*smoke test returned HTTP 401/);
        assert.match(run.out, /rollback: restored/);
        assertStateIdentical(run, "rollback must restore the exact old files");
        assert.equal(run.sb.read(".hermes/.env"), seed.env);
        assert.equal(run.sb.read(".hermes/config.yaml"), seed.config);
        assert.equal(run.sb.mode(".hermes/.env"), 0o600);
        assert.ok(run.sb.exists(`.hermes/.hstack-backup/${v.skill}.prev`), "snapshot moves to .prev after rollback");
        assert.ok(writeEvents(run).includes("hermes config set " + v.var), "the new token WAS written before the failure (so restoring is meaningful)");
        assert.equal(run.sb.read(".hermes/gateway.state").trim(), "running", "rollback reloads the gateway");
      });
    });

    // Failures at every later step must roll back to the identical state.
    for (const [label, knob, extra] of [
      ["config set fails", `fail.set.${v.var}`, /FAIL: could not write/],
      ["mcp add fails", "fail.mcp.add", /FAIL: hermes -p default mcp add/],
      ["gateway run fails", "fail.gateway.run", /FAIL: gateway did not start/],
      ["no registration in the logs", "fail.logs", /not in logs after 30s/],
    ]) {
      it(`${label}: rollback restores the old state`, async () => {
        const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
        await scenario({ name: `${v.mcp}-${knob}`, seed, valid: [NEW, OLD], knobs: { [knob]: true }, script: flow(v), env: forced }, async (run) => {
          assert.equal(run.code, 1);
          assert.match(run.out, extra);
          assert.match(run.out, /rollback:/);
          assertStateIdentical(run);
        });
      });
    }

    it("the plaintext token found in config.yaml is a failure that rolls back", async () => {
      // hermes mcp add is made to inline the secret: the guard after Step 6 must catch it.
      const bad = assemble([
        "set +e\n",
        { skill: v.skill, ids: ["before-you-start#1", "step0#1"] },
        { skill: v.skill, ids: FLOW.slice(0, 8) },
        // simulate a Hermes build that resolved ${VAR} into the config
        `remote "printf '  env: ${v.var}=%s\\n' \\"\\$(sed -n 's/^${v.var}=//p' ~/.hermes/.env | tail -n1)\\" >> ~/.hermes/config.yaml"\n`,
        { skill: v.skill, ids: ["step6.pathA#2"] },
        SCRIPT_END,
      ]);
      await scenario({ name: `${v.mcp}-leak`, valid: [NEW], script: bad, env: forced }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /found in config\.yaml/);
        assertStateIdentical(run);
      });
    });

    it("a leftover snapshot makes snapshot refuse; rollback then restores the pre-crash files; a clean re-run succeeds", async () => {
      const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
      await scenario({ name: `${v.mcp}-leftover`, seed, valid: [NEW], script: "true\n", env: forced }, async (run) => {
        const sb = run.sb;
        // 1. a run that snapshots, writes, and crashes before finishing
        const crashed = assemble([
          "set +e\n",
          { skill: v.skill, ids: ["step0#1"] },
          `snapshot && remote 'hermes config set ${v.var} half-written-value >/dev/null' && exit 7\n`,
        ]);
        assert.equal((await sb.run(crashed, { env: forced })).code, 7);
        const crashedState = sb.state();
        assert.notDeepEqual(crashedState, run.before, "the crash must have left a half-written .env");
        // 2. re-running the skill: snapshot REFUSES and the half-written files are left alone
        const rerun = await sb.run(flow(v), { env: forced });
        assert.equal(rerun.code, 1);
        assert.match(rerun.out, /did not finish/);
        assert.match(rerun.out, /ABORT: snapshot failed/);
        assert.deepEqual(sb.state(), crashedState);
        // 3. rollback restores the state from before the crashed run
        const rb = await sb.run(assemble([{ skill: v.skill, ids: ["step0#1"] }, "rollback\n"]), { env: forced });
        assert.equal(rb.code, 0, rb.out);
        assert.deepEqual(sb.state(), run.before);
        assert.equal(sb.read(".hermes/.env"), seed.env);
        // 4. now the skill runs to completion
        const ok = await sb.run(flow(v), { env: forced });
        assert.equal(ok.code, 0, ok.out);
        assert.ok(ok.out.includes("SCRIPT-COMPLETED"));
      });
    });

    it("rollback with no snapshot is a harmless no-op", async () => {
      const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
      await scenario({ name: `${v.mcp}-nosnap`, seed, script: assemble([{ skill: v.skill, ids: ["step0#1"] }, "rollback; echo RC=$?\n"]) }, async (run) => {
        assert.match(run.out, /no snapshot for .*nothing was written/);
        assertStateIdentical(run);
      });
    });

    it("already wired without FORCE: exits 0 before any vendor call or write", async () => {
      const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
      await scenario({ name: `${v.mcp}-idem`, seed, valid: [NEW], script: flow(v), env: { [v.var]: NEW } }, async (run) => {
        assert.equal(run.code, 0);
        assert.match(run.out, /already wired/i);
        assert.ok(!run.completed);
        assertStateIdentical(run);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.deepEqual(writeEvents(run), []);
      });
    });

    // ---- the local format gate: hostile values are refused before ANY ssh or curl call ----
    const hostile = [
      ["double quote", `${NEW}"x`],
      ["command substitution", `${NEW}$(touch "$HOME/pwned")`],
      ["backtick", `${NEW}\`touch "$HOME/pwned"\``],
      ["embedded newline", `${NEW}\nINJECTED=1`],
      ["space", `${NEW} extra`],
      ["backslash", `${NEW}\\x`],
      ["semicolon", `${NEW};id`],
      ["empty", ""],
      ["wrong prefix", v.wrongPrefix],
    ];
    for (const [label, tok] of hostile) {
      it(`hostile token (${label}) is rejected locally with ZERO ssh/curl calls`, async () => {
        const gate = assemble(["set +e\n", { skill: v.skill, ids: ["step0#1", "step3#1", "step3#2"] }, SCRIPT_END]);
        await scenario({ name: `${v.mcp}-hostile`, valid: [NEW], script: gate, env: { [v.var]: tok, FORCE: "1" } }, async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, /ABORT:/);
          assert.equal(run.sb.sshCalls().length, 0, "the token reached ssh");
          assert.equal(run.sb.curlCalls().length, 0);
          assert.ok(!run.sb.exists("pwned"), "command substitution executed");
          assertStateIdentical(run);
        });
      });
    }

    it("hostile token through the WHOLE flow: no write, no execution", async () => {
      const tok = `${NEW}$(touch "$HOME/pwned")`;
      await scenario({ name: `${v.mcp}-hostile-full`, valid: [NEW], script: flow(v), env: { [v.var]: tok, FORCE: "1" } }, async (run) => {
        assert.equal(run.code, 1);
        assert.deepEqual(writeEvents(run), []);
        assert.ok(!run.sb.exists("pwned"));
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });

    it("legacy / alternative token prefixes pass the local gate", async () => {
      const gate = assemble(["set +e\n", { skill: v.skill, ids: ["step0#1", "step3#1"] }, SCRIPT_END]);
      await scenario({ name: `${v.mcp}-prefix`, script: gate, env: { [v.var]: v.legacy("L") } }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.completed);
      });
    });

    it("NEGATIVE CONTROL: a bare `ssh ... \"$@\"` remote() cannot find hermes (the PATH export matters)", async () => {
      const bare = [['export PATH=\\"\\$HOME/.local/bin:\\$PATH\\"; ', ""]];
      // the control must really edit the block, otherwise it proves nothing
      const script = flow(v, { replace: bare });
      assert.ok(!script.includes(".local/bin:"), "control did not remove the PATH export");
      await scenario({ name: `${v.mcp}-barepath`, valid: [NEW], script, env: forced }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /hermes not found/);
        assert.match(run.out, /ABORT: Hermes is not installed/);
        assert.deepEqual(writeEvents(run), []);
      });
    });
  });
}

describe("integration-github: MCP URL gate", { concurrency: 6 }, () => {
  const v = VENDORS[1];
  const NEW = v.token("N");
  const gate = assemble(["set +e\n", { skill: v.skill, ids: ["step0#1", "step3#1", "step3#2"] }, SCRIPT_END]);
  for (const [label, url] of [
    ["http", "http://api.example.test/mcp/"],
    ["quote and command", `https://x.example.test/mcp'; touch "$HOME/pwned" #`],
    ["command substitution", 'https://x.example.test/mcp/$(touch "$HOME/pwned")'],
    ["whitespace", "https://x.example.test/a b"],
    ["bare scheme", "https://"],
  ]) {
    it(`rejects GITHUB_MCP_URL (${label}) locally with zero ssh/curl`, async () => {
      await scenario({ name: "gh-url", valid: [NEW], script: gate, env: { GITHUB_TOKEN: NEW, GITHUB_MCP_URL: url } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /GITHUB_MCP_URL must be a plain https/);
        assert.equal(run.sb.sshCalls().length, 0);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }
  it("registers a custom https URL and keeps the token as ${GITHUB_TOKEN}", async () => {
    const url = "https://api.example.test/mcp/";
    await scenario({ name: "gh-url-ok", valid: [NEW], script: flow(v), env: { GITHUB_TOKEN: NEW, GITHUB_MCP_URL: url } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      const cfg = run.sb.read(".hermes/config.yaml");
      assert.ok(cfg.includes(url) && cfg.includes("${GITHUB_TOKEN}") && !cfg.includes(NEW));
    });
  });
});
