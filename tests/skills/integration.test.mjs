// integration-notion and integration-github: the same repaired shape, tested with one table of vendor facts. The real
// SKILL.md blocks run in ONE /bin/bash script against a simulated VPS (see helpers/sandbox.mjs); the assertions are about
// observable outcomes: what the stubs saw, in what order, and whether ~/.hermes/.env and config.yaml are byte-identical
// after a failure.
//
// The truth encoded here is Hermes v0.22.5 as read from source: `mcp add` is interactive (answers on stdin; a closed stdin
// cancels and saves nothing), the gateway is reloaded with `gateway restart --detach` + `gateway ensure --json`, and the
// connection is verified with `mcp list` + `mcp test` (no log grepping). The stub's syntax layer is the real argparse; its
// behaviour is an assumption (see stubs/hermes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, curlEvents, idx, writeEvents } from "./helpers/asserts.mjs";
import { REPO_ROOT, assemble, loadBlocks, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

const pin = (key) => new RegExp(`^${key}=(.+)$`, "m").exec(readFileSync(path.join(REPO_ROOT, "VERSIONS.txt"), "utf8"))[1].trim();

const VENDORS = [
  {
    skill: "integration-notion",
    inputVar: "NOTION_TOKEN", // what the operator exports locally
    storedVar: "NOTION_TOKEN", // what lands in ~/.hermes/.env
    mcp: "notion",
    url: /api\.notion\.com\/v1\/search/,
    token: fake.notion,
    legacy: fake.notionLegacy,
    wrongPrefix: "abcd_" + "x".repeat(30),
    feed: "printf 'y\\n' | ", // stdio: one question (enable all tools)
    // `--args` swallows the rest of the line, so it is last; the secret appears only as the ${VAR} reference
    addArgv: ["mcp", "add", "notion", "--env", "NOTION_TOKEN=${NOTION_TOKEN}", "--command", "npx", "--args", "-y", pin("NOTION_MCP_PKG")],
    cfgRef: (cfg) => cfg.includes("env: NOTION_TOKEN=${NOTION_TOKEN}") && cfg.includes("command: npx"),
    seedBlock: "mcp.notion:\n  env: NOTION_TOKEN=${NOTION_TOKEN}\n  command: old\n",
  },
  {
    skill: "integration-github",
    inputVar: "GITHUB_TOKEN",
    storedVar: "MCP_GITHUB_API_KEY", // the variable Hermes itself reads for `--auth header` (mcp_config.py:305-336)
    mcp: "github",
    url: /api\.github\.com\/user/,
    token: fake.github,
    legacy: fake.githubFine,
    wrongPrefix: "abcd_" + "x".repeat(30),
    feed: "printf 'y\\ny\\n' | ", // HTTP: authentication question, then enable all tools
    addArgv: ["mcp", "add", "github", "--url", "https://api.githubcopilot.com/mcp/", "--auth", "header"],
    cfgRef: (cfg) => cfg.includes("Authorization: Bearer ${MCP_GITHUB_API_KEY}") && cfg.includes("url: https://api.githubcopilot.com/mcp/"),
    seedBlock: "mcp.github:\n  headers: Authorization: Bearer ${MCP_GITHUB_API_KEY}\n  url: https://old.example.test/mcp\n",
  },
];

const FLOW = ["step1#1", "step2#1", "step3#1", "step3#2", "step4#1", "step5#1", "step5#2", "step6#1", "step6#2", "step7#1", "step8#1", "step9#1"];
const GATE = ["step0#1", "step3#1", "step3#2"];

const flow = (v, { ids = FLOW, replace = [], pre = "" } = {}) =>
  assemble([
    "set +e\n",
    pre,
    { skill: v.skill, ids: ["before-you-start#1", "step0#1"], replace },
    { skill: v.skill, ids, replace },
    SCRIPT_END,
  ]);

const seedEnv = (v, oldTok) => `FOO=bar\n${v.storedVar}=${oldTok}\nOTHER_KEY=keep-me\n`;
const seedConfig = (v) => `model.default: old/model\n${v.seedBlock}`;
const mcpAdd = (run) => run.sb.hermesCalls().find((c) => c[0] === "mcp" && c[1] === "add");
const gwCalls = (run) => run.sb.hermesCalls().filter((c) => c[0] === "gateway").map((c) => c.join(" "));

for (const v of VENDORS) {
  describe(`${v.skill}`, { concurrency: 6 }, () => {
    const NEW = v.token("N");
    const OLD = v.token("O");
    const forced = { FORCE: "1", [v.inputVar]: NEW };
    const env = { [v.inputVar]: NEW };

    it("good token: vendor preflight BEFORE any write, secret only in .env (600), ${VAR} reference in config.yaml, snapshot kept as .prev", async () => {
      await scenario({ name: `${v.mcp}-good`, valid: [NEW], script: flow(v), env }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.completed);
        const ev = run.sb.events();
        const firstCurl = idx(ev, /^curl status=200/);
        const firstWrite = idx(ev, /^hermes (config set|mcp add|gateway (restart|ensure))/);
        assert.ok(firstCurl >= 0 && firstWrite >= 0 && firstCurl < firstWrite, `preflight (event ${firstCurl}) must come before the first write (event ${firstWrite})`);
        // exactly two vendor calls: the preflight and the smoke test, each against the vendor endpoint with the real token length
        const curls = run.sb.curlCalls();
        assert.equal(curls.length, 2);
        for (const c of curls) {
          assert.match(c.url, v.url);
          assert.equal(c.status, "200");
          assert.equal(Number(c.token_len), NEW.length, "the stub saw an empty or wrong token");
        }
        // the secret first, then the native registration, then the reload, then the native verification
        const writes = writeEvents(run);
        assert.ok(writes.includes(`hermes config set ${v.storedVar}`));
        assert.ok(writes.includes(`hermes mcp add ${v.mcp}`));
        const iSet = idx(ev, new RegExp(`^hermes config set ${v.storedVar}$`));
        const iAdd = idx(ev, /^hermes mcp add /);
        const iList = idx(ev, /^hermes mcp list/, iAdd);
        const iRestart = idx(ev, /^hermes gateway restart/);
        const iTest = idx(ev, /^hermes mcp test /);
        assert.ok(iSet >= 0 && iSet < iAdd && iAdd < iList && iList < iRestart && iRestart < iTest, `order: ${[iSet, iAdd, iList, iRestart, iTest]}`);
        assert.ok(idx(ev, /^hermes gateway ensure/, iRestart) > iRestart, "readiness (ensure --json) must follow the restart");
        // gateway: restart --detach (never stop / run), no interruption flag by default, no log grepping
        const gw = gwCalls(run);
        assert.ok(gw.includes("gateway restart --detach"), gw.join("\n"));
        assert.ok(!gw.some((c) => /\bstop\b|\brun\b|--daemon|status|\s-y\b|--yes|--force|--all/.test(c)), gw.join("\n"));
        assert.equal(idx(ev, /^hermes logs/), -1, "verification is mcp test, not log grepping");
        // the exact native registration; the secret never reaches its argv
        assert.deepEqual(mcpAdd(run), v.addArgv);
        assert.ok(!mcpAdd(run).join(" ").includes(NEW));
        assert.deepEqual(run.sb.hermesCalls().find((c) => c[0] === "mcp" && c[1] === "test"), ["mcp", "test", v.mcp]);
        // storage
        const envText = run.sb.read(".hermes/.env");
        assert.equal(envText.split("\n").filter((l) => l === `${v.storedVar}=${NEW}`).length, 1);
        assert.equal(run.sb.mode(".hermes/.env"), 0o600);
        const cfg = run.sb.read(".hermes/config.yaml");
        assert.ok(v.cfgRef(cfg), `config.yaml must reference the secret by \${VAR}:\n${cfg}`);
        assert.match(cfg, /enabled: true/);
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

    it("FORCE=1 over an old token: remove then re-add; the smoke test reads the NEW token back from .env; .prev holds the old files", async () => {
      // Only the new token is valid: a smoke test that sent the old or an empty token would get 401.
      const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
      await scenario({ name: `${v.mcp}-force`, seed, valid: [NEW], script: flow(v), env: forced }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.completed);
        assertStateChanged(run);
        const envText = run.sb.read(".hermes/.env");
        assert.match(envText, new RegExp(`^${v.storedVar}=${NEW}$`, "m"));
        assert.ok(!envText.includes(OLD));
        assert.ok(envText.includes("FOO=bar") && envText.includes("OTHER_KEY=keep-me"), "unrelated keys must survive");
        const cfg = run.sb.read(".hermes/config.yaml");
        assert.ok(v.cfgRef(cfg) && !cfg.includes("command: old") && !cfg.includes("old.example.test"), cfg);
        assert.ok(cfg.includes("model.default: old/model"), "unrelated config must survive");
        assert.equal(run.sb.read(`.hermes/.hstack-backup/${v.skill}.prev/.env`), seed.env, ".prev must hold the exact old .env");
        assert.equal(run.sb.read(`.hermes/.hstack-backup/${v.skill}.prev/config.yaml`), seed.config);
        assert.equal(run.sb.mode(".hermes/.env"), 0o600);
        assert.equal(run.sb.curlCalls().at(-1).status, "200");
        const ev = run.sb.events();
        assert.ok(idx(ev, new RegExp(`^hermes mcp remove ${v.mcp}$`)) >= 0 && idx(ev, new RegExp(`^hermes mcp remove ${v.mcp}$`)) < idx(ev, /^hermes mcp add /), "FORCE removes the old entry first");
        assertNoSecretInArgv(run, [NEW, OLD]);
      });
    });

    it("quoted values in .env are stripped by the secret-in-config guard and the smoke test read-back", async () => {
      await scenario({ name: `${v.mcp}-quoted`, valid: [NEW], knobs: { quote_env: true }, script: flow(v), env }, async (run) => {
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

    it("a Hermes that is not v0.22.5 is refused before anything is written", async () => {
      await scenario({ name: `${v.mcp}-version`, valid: [NEW], files: { "hermes.version": "hermes 0.17.3\n" }, script: flow(v), env }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /ABORT: .*0\.22\.5 only/);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.ok(!run.sb.exists(".hermes/.env"));
      });
    });

    it("FORCE=1 re-run + failing smoke test: rollback restores the old .env AND config.yaml byte-for-byte and reloads the gateway", async () => {
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
        assert.ok(writeEvents(run).includes("hermes config set " + v.storedVar), "the new token WAS written before the failure (so restoring is meaningful)");
        assert.equal(run.sb.read(".hermes/gateway.state").trim(), "running", "rollback reloads the gateway");
        assert.equal(gwCalls(run).filter((c) => c.startsWith("gateway restart --detach")).length, 2, "one reload for the run, one for the rollback");
      });
    });

    // Failures at every later step must roll back to the identical state. When the failure is in the gateway itself the
    // rollback's own reload fails too: the files are still restored, and the snapshot is KEPT for a retry (not retired).
    for (const [label, knob, extra, gwBroken] of [
      ["config set fails", `fail.set.${v.storedVar}`, /FAIL: could not write/, false],
      ["mcp add fails", "fail.mcp.add", /FAIL: hermes -p default mcp add/, false],
      ["mcp add cannot connect and saves a DISABLED entry", "fail.mcp.probe", /not listed as enabled/, false],
      ["gateway restart fails", "fail.gateway.restart", /FAIL: gateway did not restart ready/, true],
      ["gateway ensure fails", "fail.gateway.ensure", /FAIL: gateway did not restart ready/, true],
      ["restart that did nothing (same instance)", "restart_noop", /instance did not change/, true],
      ["mcp test fails", "fail.mcp.test", /did not connect within 30s/, false],
    ]) {
      it(`${label}: rollback restores the old state`, async () => {
        const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
        await scenario({ name: `${v.mcp}-${knob}`, seed, valid: [NEW, OLD], knobs: { [knob]: true }, script: flow(v), env: forced }, async (run) => {
          assert.equal(run.code, 1);
          assert.match(run.out, extra);
          assert.match(run.out, /rollback:/);
          assertStateIdentical(run);
          if (gwBroken) {
            assert.match(run.out, /files restored, but the gateway did NOT come back ready/);
            assert.ok(run.sb.exists(`.hermes/.hstack-backup/${v.skill}`), "the active snapshot is kept when the gateway cannot be reloaded");
          } else {
            assert.match(run.out, /rollback: restored/);
            assert.ok(run.sb.exists(`.hermes/.hstack-backup/${v.skill}.prev`) && !run.sb.exists(`.hermes/.hstack-backup/${v.skill}`));
          }
        });
      });
    }

    it("gateway still draining (ensure exit 6): never reported ready, rollback keeps the snapshot", async () => {
      const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
      await scenario({ name: `${v.mcp}-draining`, seed, valid: [NEW], knobs: { ensure_exit: "6" }, script: flow(v), env: forced }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /FAIL: gateway did not restart ready/);
        assert.doesNotMatch(run.out, /"state":"ready"/);
        assertStateIdentical(run);
        assert.ok(run.sb.exists(`.hermes/.hstack-backup/${v.skill}`));
      });
    });

    it("live sessions: the restart refusal is reported, never overridden with -y; GW_INTERRUPT=1 interrupts deliberately", async () => {
      const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
      await scenario({ name: `${v.mcp}-live`, seed, valid: [NEW], knobs: { live_sessions: true }, script: flow(v), env: forced }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /refused|live session/i);
        assert.ok(!gwCalls(run).some((c) => /\s-y\b/.test(c)), gwCalls(run).join("\n"));
        assertStateIdentical(run);
      });
      await scenario({ name: `${v.mcp}-live-yes`, valid: [NEW], knobs: { live_sessions: true }, script: flow(v), env: { ...forced, GW_INTERRUPT: "1" } }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(gwCalls(run).includes("gateway restart --detach -y"), gwCalls(run).join("\n"));
      });
    });

    it("the plaintext token found in config.yaml is a failure that rolls back", async () => {
      // Simulate a Hermes build that resolved ${VAR} into the config: the guard after Step 6 must catch it.
      const bad = assemble([
        "set +e\n",
        { skill: v.skill, ids: ["before-you-start#1", "step0#1"] },
        { skill: v.skill, ids: FLOW.slice(0, 8) },
        `remote "printf '  env: ${v.storedVar}=%s\\n' \\"\\$(sed -n 's/^${v.storedVar}=//p' ~/.hermes/.env | tail -n1)\\" >> ~/.hermes/config.yaml"\n`,
        { skill: v.skill, ids: ["step6#2"] },
        SCRIPT_END,
      ]);
      await scenario({ name: `${v.mcp}-leak`, valid: [NEW], script: bad, env: forced }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /found in config\.yaml/);
        assertStateIdentical(run);
      });
    });

    it("NEGATIVE CONTROL: without the answers on stdin `mcp add` saves nothing and the skill notices (it does not trust the exit code)", async () => {
      const replace = [[v.feed, ""]];
      mustReplace({ skill: v.skill, ids: ["step6#1"], replace });
      const seed = { env: seedEnv(v, OLD), config: seedConfig(v) };
      await scenario({ name: `${v.mcp}-nostdin`, seed, valid: [NEW], script: flow(v, { replace }), env: forced }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /not listed as enabled/);
        assertStateIdentical(run);
        assert.ok(mcpAdd(run), "mcp add must have been attempted");
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
          `snapshot && remote 'hermes -p default config set ${v.storedVar} half-written-value >/dev/null' && exit 7\n`,
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
      await scenario({ name: `${v.mcp}-idem`, seed, valid: [NEW], script: flow(v), env }, async (run) => {
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
        const gate = assemble(["set +e\n", { skill: v.skill, ids: GATE }, SCRIPT_END]);
        await scenario({ name: `${v.mcp}-hostile`, valid: [NEW], script: gate, env: { [v.inputVar]: tok, FORCE: "1" } }, async (run) => {
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
      await scenario({ name: `${v.mcp}-hostile-full`, valid: [NEW], script: flow(v), env: { [v.inputVar]: tok, FORCE: "1" } }, async (run) => {
        assert.equal(run.code, 1);
        assert.deepEqual(writeEvents(run), []);
        assert.ok(!run.sb.exists("pwned"));
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });

    it("legacy / alternative token prefixes pass the local gate", async () => {
      const gate = assemble(["set +e\n", { skill: v.skill, ids: ["step0#1", "step3#1"] }, SCRIPT_END]);
      await scenario({ name: `${v.mcp}-prefix`, script: gate, env: { [v.inputVar]: v.legacy("L") } }, async (run) => {
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
        assert.match(run.out, /ABORT: Hermes is not installed/);
        assert.deepEqual(writeEvents(run), []);
      });
    });

    it("the skill text carries none of the retired forms (invalid mcp flags, stop/run reload, log-grep verification)", () => {
      const text = readFileSync(skillPath(v.skill), "utf8");
      const code = loadBlocks(v.skill).map((b) => b.code).join("\n");
      assert.doesNotMatch(text, /--auth-header|--auth-scheme|--args '-y,|gateway stop/);
      assert.doesNotMatch(code, /hermes -p default logs|gateway (stop|run)|registered\.\*tool/, "no log grepping, no stop/run reload in any block");
      assert.doesNotMatch(text, /0\.15|0\.17/);
      assert.match(text, /Verified against Hermes v0\.22\.5/);
      assert.match(text, /source-verified|SOURCE-verified|not live-verified|unverified/i);
    });
  });
}

describe("integration-github: MCP URL gate and the stdio alternative", { concurrency: 6 }, () => {
  const v = VENDORS[1];
  const NEW = v.token("N");
  const gate = assemble(["set +e\n", { skill: v.skill, ids: GATE }, SCRIPT_END]);
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

  it("registers a custom https URL and keeps the token as ${MCP_GITHUB_API_KEY}", async () => {
    const url = "https://api.example.test/mcp/";
    await scenario({ name: "gh-url-ok", valid: [NEW], script: flow(v), env: { GITHUB_TOKEN: NEW, GITHUB_MCP_URL: url } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      const cfg = run.sb.read(".hermes/config.yaml");
      assert.ok(cfg.includes(`url: ${url}`) && cfg.includes("Authorization: Bearer ${MCP_GITHUB_API_KEY}") && !cfg.includes(NEW));
      assert.deepEqual(mcpAdd(run), ["mcp", "add", "github", "--url", url, "--auth", "header"]);
    });
  });

  it("GITHUB_MCP_MODE=stdio registers the pinned npm server with the token as a ${MCP_GITHUB_API_KEY} env reference", async () => {
    await scenario({ name: "gh-stdio", valid: [NEW], script: flow(v), env: { GITHUB_TOKEN: NEW, GITHUB_MCP_MODE: "stdio" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(mcpAdd(run), ["mcp", "add", "github", "--env", "GITHUB_PERSONAL_ACCESS_TOKEN=${MCP_GITHUB_API_KEY}", "--command", "npx", "--args", "-y", pin("GITHUB_MCP_PKG")]);
      const cfg = run.sb.read(".hermes/config.yaml");
      assert.ok(cfg.includes("env: GITHUB_PERSONAL_ACCESS_TOKEN=${MCP_GITHUB_API_KEY}") && cfg.includes("command: npx") && cfg.includes("enabled: true"), cfg);
      assert.ok(!cfg.includes(NEW) && !cfg.includes("headers:"));
      assert.equal(run.sb.read(".hermes/.env").split("\n").filter((l) => l === `MCP_GITHUB_API_KEY=${NEW}`).length, 1);
      assertNoSecretInArgv(run, [NEW]);
    });
  });

  it("an unknown GITHUB_MCP_MODE is refused locally with zero ssh/curl", async () => {
    await scenario({ name: "gh-mode", valid: [NEW], script: gate, env: { GITHUB_TOKEN: NEW, GITHUB_MCP_MODE: "sse" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /GITHUB_MCP_MODE must be remote or stdio/);
      assert.equal(run.sb.sshCalls().length, 0);
    });
  });
});
