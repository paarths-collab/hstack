// integration-obsidian: the real SKILL.md blocks against a simulated VPS (helpers/sandbox.mjs).
//
// What is under test is the shrunk, source-verifiable shape at Hermes v0.22.5:
//   Path A  vault as files: only OBSIDIAN_VAULT_PATH (the variable Hermes' bundled `obsidian` skill reads) goes into ~/.hermes/.env;
//           no MCP server, no gateway reload, no cron, no helper scripts. The vault directory must already exist.
//   Path C  Local REST API plugin through the stdio MCP server mcp-obsidian: native `mcp add` (answers on stdin), gateway reload with
//           `restart --detach` + `ensure --json`, verification with `mcp list` + `mcp test`.
// The hermes stub's syntax layer is the real argparse; its behaviour is an assumption (see stubs/hermes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, idx, writeEvents } from "./helpers/asserts.mjs";
import { REPO_ROOT, assemble, loadBlocks, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "integration-obsidian";
const pin = (key) => new RegExp(`^${key}=(.+)$`, "m").exec(readFileSync(path.join(REPO_ROOT, "VERSIONS.txt"), "utf8"))[1].trim();
// Not token-shaped literals: assembled at run time, never valid anywhere.
const key = (tag) => ["0123456789abcdef".repeat(3), tag.padEnd(16, "0")].join("");
const NEW = key("aa");
const OLD = key("bb");

const FLOW = ["step1#1", "step2#1", "step3#1", "step3.pathA#1", "step3.pathC#1", "step4#1", "step5#1", "step5#2", "step6#1", "step6#2", "step7#1", "step8#1", "step9#1"];
const GATE = ["step0#1", "step3#1", "step3.pathA#1", "step3.pathC#1"];
const flow = ({ ids = FLOW, replace = [], pre = "", mid = [] } = {}) =>
  assemble(["set +e\n", pre, { skill: SKILL, ids: ["before-you-start#1", "step0#1"], replace }, { skill: SKILL, ids, replace }, ...mid, SCRIPT_END]);

const VAULT_PRE = 'mkdir -p "$HOME/vault/Daily" && printf "# note\\n" > "$HOME/vault/Daily/n.md"\nexport OBSIDIAN_VAULT_PATH="$HOME/vault"\n';
const A = { OBSIDIAN_PATH: "A", WRITES_ACKNOWLEDGED: "1" };
const C = { OBSIDIAN_PATH: "C", WRITES_ACKNOWLEDGED: "1", OBSIDIAN_HOST: "vault.example.test", OBSIDIAN_PORT: "27124", OBSIDIAN_API_KEY: NEW };
const gwCalls = (run) => run.sb.hermesCalls().filter((c) => c[0] === "gateway").map((c) => c.join(" "));
const mcpAdd = (run) => run.sb.hermesCalls().find((c) => c[0] === "mcp" && c[1] === "add");
const setKeys = (run) => run.sb.events().filter((e) => e.startsWith("hermes config set ")).map((e) => e.slice(18));

describe("integration-obsidian Path A: vault as files", { concurrency: 6 }, () => {
  it("good run: only OBSIDIAN_VAULT_PATH is written (600); no MCP, no gateway reload, no cron, no vendor call; the probe note is removed; snapshot kept as .prev", async () => {
    await scenario({ name: "obs-a-good", script: flow({ pre: VAULT_PRE }), env: A }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      assert.deepEqual(setKeys(run), ["OBSIDIAN_VAULT_PATH"]);
      assert.equal(run.sb.read(".hermes/.env"), `OBSIDIAN_VAULT_PATH=${run.sb.home}/vault\n`);
      assert.equal(run.sb.mode(".hermes/.env"), 0o600);
      assert.ok(!run.sb.exists(".hermes/config.yaml"), "Path A must not touch config.yaml");
      const ev = run.sb.events();
      assert.equal(idx(ev, /^hermes mcp (add|remove)/), -1, "no MCP server for Path A");
      assert.deepEqual(gwCalls(run), [], "Path A needs no gateway call at all (.env is read per turn)");
      assert.equal(idx(ev, /^curl/), -1);
      assert.ok(!run.sb.exists("crontab.store"), "the old cron sync is gone");
      assert.deepEqual(run.sb.ls("vault").sort(), ["Daily"], "the probe note must be removed from the user's vault");
      assert.equal(run.sb.read("vault/Daily/n.md"), "# note\n", "existing notes are untouched");
      assert.ok(run.sb.exists(".hermes/.hstack-backup/integration-obsidian.prev/.env.absent"));
      assert.ok(!run.sb.exists(".hermes/.hstack-backup/integration-obsidian"));
      assert.ok(run.sb.sshCalls().every((c) => !(c.includes("config set") && c.includes(`${run.sb.home}/vault`))), "the value travels over stdin, not in the remote command string");
    });
  });

  it("a vault path with spaces is stored verbatim and works end to end", async () => {
    const pre = 'mkdir -p "$HOME/My Vault" && export OBSIDIAN_VAULT_PATH="$HOME/My Vault"\n';
    await scenario({ name: "obs-a-space", script: flow({ pre }), env: A }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(run.sb.read(".hermes/.env"), `OBSIDIAN_VAULT_PATH=${run.sb.home}/My Vault\n`);
    });
  });

  it("existing .env keys survive and the old value is restorable from .prev", async () => {
    const seed = { env: "FOO=bar\nOBSIDIAN_VAULT_PATH=/old/place\nOTHER_KEY=keep-me\n" };
    await scenario({ name: "obs-a-force", seed, script: flow({ pre: VAULT_PRE }), env: { ...A, FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assertStateChanged(run);
      const env = run.sb.read(".hermes/.env");
      assert.ok(env.includes("FOO=bar") && env.includes("OTHER_KEY=keep-me") && !env.includes("/old/place"));
      assert.equal(run.sb.read(".hermes/.hstack-backup/integration-obsidian.prev/.env"), seed.env);
    });
  });

  it("a missing vault directory aborts BEFORE any write: the vault must exist already (nothing is cloned or created)", async () => {
    await scenario({ name: "obs-a-nodir", script: flow({ pre: 'export OBSIDIAN_VAULT_PATH="$HOME/nope"\n' }), env: A }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /ABORT: .*vault/i);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
      assert.ok(!run.sb.exists("nope"));
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
    });
  });

  it("consent gate: without WRITES_ACKNOWLEDGED=1 nothing runs, not even ssh", async () => {
    const gate = assemble(["set +e\n", VAULT_PRE, { skill: SKILL, ids: GATE }, SCRIPT_END]);
    await scenario({ name: "obs-a-consent", script: gate, env: { OBSIDIAN_PATH: "A" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /WRITES_ACKNOWLEDGED=1 required/);
      assert.equal(run.sb.sshCalls().length, 0);
    });
  });

  for (const [label, p] of [
    ["relative path", "vault/notes"],
    ["command substitution", '/tmp/$(touch "$HOME/pwned")'],
    ["backtick", '/tmp/`touch "$HOME/pwned"`'],
    ["double quote", '/tmp/a"b'],
    ["single quote", "/tmp/a'b"],
    ["semicolon", "/tmp/a;id"],
    ["newline", "/tmp/a\nb"],
    ["backslash", "/tmp/a\\b"],
    ["dollar", "/tmp/$HOME"],
    ["empty", ""],
  ]) {
    it(`hostile vault path (${label}) is rejected locally with ZERO ssh calls`, async () => {
      const gate = assemble(["set +e\n", { skill: SKILL, ids: GATE }, SCRIPT_END]);
      await scenario({ name: "obs-a-hostile", script: gate, env: { ...A, OBSIDIAN_VAULT_PATH: p } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /ABORT:/);
        assert.equal(run.sb.sshCalls().length, 0);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }

  it("already wired (OBSIDIAN_VAULT_PATH present) without FORCE: exits 0 before any write", async () => {
    await scenario({ name: "obs-a-idem", seed: { env: "OBSIDIAN_VAULT_PATH=/somewhere\n" }, script: flow({ pre: VAULT_PRE }), env: A }, async (run) => {
      assert.equal(run.code, 0);
      assert.match(run.out, /already wired/i);
      assert.ok(!run.completed);
      assertStateIdentical(run);
    });
  });

  it("config set failing, or the vault disappearing before the smoke test: rollback restores the exact old .env", async () => {
    const seed = { env: "FOO=bar\nOBSIDIAN_VAULT_PATH=/old/place\n" };
    await scenario({ name: "obs-a-setfail", seed, knobs: { "fail.set.OBSIDIAN_VAULT_PATH": true }, script: flow({ pre: VAULT_PRE }), env: { ...A, FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /FAIL: could not write OBSIDIAN_VAULT_PATH/);
      assertStateIdentical(run);
      assert.equal(run.sb.read(".hermes/.env"), seed.env);
    });
    const upto = FLOW.slice(0, FLOW.indexOf("step9#1"));
    const script = assemble([
      "set +e\n", VAULT_PRE,
      { skill: SKILL, ids: ["before-you-start#1", "step0#1"] },
      { skill: SKILL, ids: upto },
      'rm -rf "$HOME/vault"\n',
      { skill: SKILL, ids: ["step9#1"] },
      SCRIPT_END,
    ]);
    await scenario({ name: "obs-a-smokefail", seed, script, env: { ...A, FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /FAIL: .*vault/i);
      assertStateIdentical(run);
      assert.equal(run.sb.read(".hermes/.env"), seed.env);
    });
  });
});

describe("integration-obsidian Path C: Local REST API through the mcp-obsidian stdio server", { concurrency: 6 }, () => {
  const add = ["mcp", "add", "obsidian", "--env", "OBSIDIAN_API_KEY=${OBSIDIAN_API_KEY}", "OBSIDIAN_HOST=${OBSIDIAN_HOST}", "OBSIDIAN_PORT=${OBSIDIAN_PORT}", "--command", "uvx", "--args", "--from", pin("OBSIDIAN_MCP_PKG"), "mcp-obsidian"];
  const seedBlock = "mcp.obsidian:\n  command: old\n  enabled: true\n";

  it("good run: vendor preflight (key on stdin, TLS relaxed) BEFORE any write; key + host + port in .env (600); ${VAR} references only; native add/list/restart/test", async () => {
    await scenario({ name: "obs-c-good", valid: [NEW], script: flow(), env: C }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      const curls = run.sb.curlCalls();
      assert.equal(curls.length, 2, "preflight and smoke test");
      for (const c of curls) {
        assert.equal(c.url, "https://vault.example.test:27124/vault/");
        assert.equal(c.status, "200");
        assert.equal(Number(c.token_len), NEW.length);
        assert.match(c.argv, /(^| )-k( |$)/, "insecure TLS mode (the plugin's self-signed certificate) passes -k");
      }
      const ev = run.sb.events();
      const iCurl = idx(ev, /^curl status=200/);
      const iSet = idx(ev, /^hermes config set/);
      const iAdd = idx(ev, /^hermes mcp add /);
      const iList = idx(ev, /^hermes mcp list/, iAdd);
      const iRestart = idx(ev, /^hermes gateway restart/);
      const iTest = idx(ev, /^hermes mcp test /);
      assert.ok(iCurl >= 0 && iCurl < iSet && iSet < iAdd && iAdd < iList && iList < iRestart && iRestart < iTest, `order: ${[iCurl, iSet, iAdd, iList, iRestart, iTest]}`);
      assert.deepEqual(setKeys(run).sort(), ["OBSIDIAN_API_KEY", "OBSIDIAN_HOST", "OBSIDIAN_PORT"]);
      const env = run.sb.read(".hermes/.env");
      assert.match(env, new RegExp(`^OBSIDIAN_API_KEY=${NEW}$`, "m"));
      assert.match(env, /^OBSIDIAN_HOST=vault\.example\.test$/m);
      assert.match(env, /^OBSIDIAN_PORT=27124$/m);
      assert.equal(run.sb.mode(".hermes/.env"), 0o600);
      assert.deepEqual(mcpAdd(run), add);
      assert.ok(!mcpAdd(run).join(" ").includes(NEW));
      const cfg = run.sb.read(".hermes/config.yaml");
      assert.ok(cfg.includes("env: OBSIDIAN_API_KEY=${OBSIDIAN_API_KEY},OBSIDIAN_HOST=${OBSIDIAN_HOST},OBSIDIAN_PORT=${OBSIDIAN_PORT}") && cfg.includes("command: uvx") && cfg.includes("enabled: true"), cfg);
      assert.ok(!cfg.includes(NEW));
      const gw = gwCalls(run);
      assert.ok(gw.includes("gateway restart --detach") && !gw.some((c) => /\bstop\b|\brun\b|--daemon|status|\s-y\b/.test(c)), gw.join("\n"));
      assert.equal(idx(ev, /^hermes logs/), -1);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/integration-obsidian.prev"));
      assertNoSecretInArgv(run, [NEW]);
      assertSecretsNotPrinted(run, [NEW]);
    });
  });

  it("strict TLS mode does not pass -k", async () => {
    await scenario({ name: "obs-c-strict", valid: [NEW], script: flow(), env: { ...C, OBSIDIAN_TLS_MODE: "strict" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      for (const c of run.sb.curlCalls()) assert.doesNotMatch(c.argv, /(^| )-k( |$)/);
    });
  });

  it("FORCE=1 replaces an existing entry (remove, then add) and a failing smoke test restores the old files", async () => {
    const seed = { env: `FOO=bar\nOBSIDIAN_API_KEY=${OLD}\n`, config: `model.default: x/y\n${seedBlock}` };
    await scenario({ name: "obs-c-force", seed, valid: [NEW], script: flow(), env: { ...C, FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      const ev = run.sb.events();
      assert.ok(idx(ev, /^hermes mcp remove obsidian$/) >= 0 && idx(ev, /^hermes mcp remove obsidian$/) < idx(ev, /^hermes mcp add /));
      assert.ok(!run.sb.read(".hermes/config.yaml").includes("command: old"));
      assert.equal(run.sb.read(".hermes/.hstack-backup/integration-obsidian.prev/config.yaml"), seed.config);
    });
    await scenario({ name: "obs-c-force-fail", seed, valid: [NEW, OLD], knobs: { curl_force: "2=401\n" }, script: flow(), env: { ...C, FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /rollback: restored/);
      assertStateIdentical(run);
      assert.equal(run.sb.read(".hermes/.env"), seed.env);
      assert.equal(run.sb.read(".hermes/config.yaml"), seed.config);
    });
  });

  it("bad key / unreachable plugin: ABORT after the preflight, nothing written", async () => {
    await scenario({ name: "obs-c-bad", valid: [OLD], script: flow(), env: C }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /ABORT: .*HTTP 401/);
      assert.deepEqual(writeEvents(run), []);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
    });
    await scenario({ name: "obs-c-down", valid: [NEW], knobs: { net_down: true }, script: flow(), env: C }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /ABORT: .*(no response|HTTP)/);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  for (const [label, knob, extra, gwBroken] of [
    ["config set fails", "fail.set.OBSIDIAN_API_KEY", /FAIL: could not write OBSIDIAN_API_KEY/, false],
    ["mcp add fails", "fail.mcp.add", /FAIL: hermes -p default mcp add/, false],
    ["mcp add cannot connect and saves a DISABLED entry", "fail.mcp.probe", /not listed as enabled/, false],
    ["gateway restart fails", "fail.gateway.restart", /FAIL: gateway did not restart ready/, true],
    ["gateway ensure fails", "fail.gateway.ensure", /FAIL: gateway did not restart ready/, true],
    ["mcp test fails", "fail.mcp.test", /did not connect within 30s/, false],
  ]) {
    it(`${label}: rollback restores the old state`, async () => {
      const seed = { env: `FOO=bar\nOBSIDIAN_API_KEY=${OLD}\n`, config: `model.default: x/y\n${seedBlock}` };
      await scenario({ name: `obs-c-${knob}`, seed, valid: [NEW], knobs: { [knob]: true }, script: flow(), env: { ...C, FORCE: "1" } }, async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, extra);
        assertStateIdentical(run);
        if (gwBroken) {
          assert.match(run.out, /files restored, but the gateway did NOT come back ready/);
          assert.ok(run.sb.exists(".hermes/.hstack-backup/integration-obsidian"));
        } else {
          assert.match(run.out, /rollback: restored/);
        }
      });
    });
  }

  it("NEGATIVE CONTROL: without the answer on stdin `mcp add` saves nothing and the skill notices", async () => {
    const replace = [["printf 'y\\n' | ", ""]];
    mustReplace({ skill: SKILL, ids: ["step6#1"], replace });
    await scenario({ name: "obs-c-nostdin", valid: [NEW], script: flow({ replace }), env: C }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /not listed as enabled/);
      assertStateIdentical(run);
    });
  });

  it("the plaintext key found in config.yaml is a failure that rolls back", async () => {
    const bad = assemble([
      "set +e\n",
      { skill: SKILL, ids: ["before-you-start#1", "step0#1"] },
      { skill: SKILL, ids: FLOW.slice(0, FLOW.indexOf("step6#2")) },
      `remote "printf '  env: OBSIDIAN_API_KEY=%s\\n' \\"\\$(sed -n 's/^OBSIDIAN_API_KEY=//p' ~/.hermes/.env | tail -n1)\\" >> ~/.hermes/config.yaml"\n`,
      { skill: SKILL, ids: ["step6#2"] },
      SCRIPT_END,
    ]);
    await scenario({ name: "obs-c-leak", valid: [NEW], script: bad, env: C }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /found in config\.yaml/);
      assertStateIdentical(run);
    });
  });

  for (const [label, over] of [
    ["host with a path", { OBSIDIAN_HOST: "vault.example.test/x" }],
    ["host with a scheme", { OBSIDIAN_HOST: "https://vault.example.test" }],
    ["host with command substitution", { OBSIDIAN_HOST: '$(touch "$HOME/pwned")' }],
    ["host with a quote", { OBSIDIAN_HOST: "a'b" }],
    ["empty host", { OBSIDIAN_HOST: "" }],
    ["non-numeric port", { OBSIDIAN_PORT: "27124;id" }],
    ["port out of range", { OBSIDIAN_PORT: "70000" }],
    ["short key", { OBSIDIAN_API_KEY: "short" }],
    ["key with a quote", { OBSIDIAN_API_KEY: `${NEW}"x` }],
    ["key with command substitution", { OBSIDIAN_API_KEY: `${NEW}$(touch "$HOME/pwned")` }],
    ["key with a newline", { OBSIDIAN_API_KEY: `${NEW}\nINJECTED=1` }],
    ["unknown TLS mode", { OBSIDIAN_TLS_MODE: "off" }],
  ]) {
    it(`hostile input (${label}) is rejected locally with ZERO ssh/curl calls`, async () => {
      const gate = assemble(["set +e\n", { skill: SKILL, ids: GATE }, SCRIPT_END]);
      await scenario({ name: "obs-c-hostile", valid: [NEW], script: gate, env: { ...C, ...over } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /ABORT:/);
        assert.equal(run.sb.sshCalls().length, 0);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }

  it("already wired (mcp list shows obsidian) without FORCE: exits 0 before any vendor call or write", async () => {
    const seed = { config: seedBlock };
    await scenario({ name: "obs-c-idem", seed, valid: [NEW], script: flow(), env: C }, async (run) => {
      assert.equal(run.code, 0);
      assert.match(run.out, /already wired/i);
      assert.equal(run.sb.curlCalls().length, 0);
      assertStateIdentical(run);
    });
  });
});

describe("integration-obsidian: shared gates", { concurrency: 6 }, () => {
  it("a Hermes that is not v0.22.5 is refused before anything is written", async () => {
    await scenario({ name: "obs-version", files: { "hermes.version": "hermes 0.17.3\n" }, script: flow({ pre: VAULT_PRE }), env: A }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /ABORT: .*0\.22\.5 only/);
      assert.deepEqual(writeEvents(run), []);
    });
  });

  it("an unknown OBSIDIAN_PATH is refused locally (the retired Path B no longer exists)", async () => {
    for (const p of ["B", "", "a"]) {
      const gate = assemble(["set +e\n", { skill: SKILL, ids: GATE }, SCRIPT_END]);
      await scenario({ name: "obs-path", script: gate, env: { ...A, OBSIDIAN_PATH: p } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /OBSIDIAN_PATH must be A or C/);
        assert.equal(run.sb.sshCalls().length, 0);
      });
    }
  });

  it("a leftover snapshot makes snapshot refuse; rollback restores the pre-crash files; a clean re-run succeeds", async () => {
    const seed = { env: "FOO=bar\n" };
    const FA = { ...A, FORCE: "1" }; // the crash leaves OBSIDIAN_VAULT_PATH behind, which the idempotency check would otherwise honour
    await scenario({ name: "obs-leftover", seed, script: "true\n", env: FA }, async (run) => {
      const sb = run.sb;
      const crashed = assemble(["set +e\n", { skill: SKILL, ids: ["step0#1"] }, "snapshot && remote 'hermes -p default config set OBSIDIAN_VAULT_PATH /half >/dev/null' && exit 7\n"]);
      assert.equal((await sb.run(crashed, { env: FA })).code, 7);
      const crashedState = sb.state();
      const rerun = await sb.run(flow({ pre: VAULT_PRE }), { env: FA });
      assert.equal(rerun.code, 1);
      assert.match(rerun.out, /did not finish/);
      assert.deepEqual(sb.state(), crashedState);
      const rb = await sb.run(assemble([{ skill: SKILL, ids: ["step0#1"] }, "rollback\n"]), { env: FA });
      assert.equal(rb.code, 0, rb.out);
      assert.deepEqual(sb.state(), run.before);
      assert.equal((await sb.run(flow({ pre: VAULT_PRE }), { env: FA })).code, 0);
    });
  });

  it("the skill text and its bash blocks carry none of the retired forms", () => {
    const text = readFileSync(skillPath(SKILL), "utf8");
    const code = loadBlocks(SKILL).map((b) => b.code).join("\n");
    assert.doesNotMatch(text, /run --daemon|gateway stop|hermes gateway env|0\.15|0\.17/);
    assert.doesNotMatch(code, /gateway (stop|run)\b|crontab|\/usr\/local\/bin|\/opt\/data|git clone|OBSIDIAN_VAULT_DIR|OBSIDIAN_SYNC_MODE|OBSIDIAN_GIT_REMOTE|OBSIDIAN_API_URL/);
    assert.match(text, /Verified against Hermes v0\.22\.5/);
    assert.match(text, /skills\/note-taking\/obsidian\/SKILL\.md/);
    assert.match(text, /OBSIDIAN_VAULT_PATH/);
  });

  it("the frontmatter is real YAML (the old unquoted description was not)", () => {
    const text = readFileSync(skillPath(SKILL), "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
    const r = spawnSync("python3", ["-I", "-c", "import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read())))"], { input: fm, encoding: "utf8" });
    if (r.status !== 0 && /No module named/.test(r.stderr)) return; // PyYAML not installed: the static plain-scalar check still covers this
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.name, SKILL);
    assert.equal(typeof doc.description, "string");
    assert.ok(doc.description.length > 40);
  });
});
