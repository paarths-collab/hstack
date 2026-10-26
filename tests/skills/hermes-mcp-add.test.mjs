// hermes-mcp-add: the real SKILL.md blocks run against a simulated VPS. The hermes stub checks every call with the REAL v0.22.5
// argparse (so --auth-header / --auth-scheme / --placeholder-token / --yes cannot pass) and models `mcp add` as the interactive
// command it is (stdin answers; a closed stdin cancels without saving, exit 0), `mcp test` exit codes, the catalog (all HTTP:
// OAuth or no-auth) and `mcp login` (exit 0 even on failure). Behaviour of the stubs is an assumption written from the source.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, idx, writeEvents } from "./helpers/asserts.mjs";
import { assemble, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

const SKILL = "hermes-mcp-add";
const TOKEN = fake.deepseek("M");
const OLD = fake.deepseek("O");
const URL = "https://mcp.acme.example.test/mcp";
const PRE = ["before-you-start#1", "step0#1"];
const GATE = ["step1#1", "step2#1", "step3#1", "step4#1", "step5#1"];
const TAIL = ["step8#1", "step9#1", "step10#1"];
const base = (over = {}) => ({ MCP_NAME: "acme", MCP_URL: URL, MCP_TOKEN: TOKEN, MCP_AUTH: "bearer", ...over });

const flow = (path, { ids, replace = [], pre = "", mid = "" } = {}) =>
  assemble([
    "set +e\n",
    pre,
    { skill: SKILL, ids: PRE, replace },
    { skill: SKILL, ids: GATE, replace },
    { skill: SKILL, ids: ["step6#1"], replace },
    { skill: SKILL, ids: [path], replace },
    mid,
    { skill: SKILL, ids: ids || TAIL, replace },
    SCRIPT_END,
  ]);
const bearer = (o) => flow("step7.pathB#1", o);
const custom = (o) => flow("step7.pathC#1", o);
const catalog = (o) => flow("step7.pathA#1", o);

const calls = (run) => run.sb.hermesCalls().map((c) => c.join(" "));
const shapes = (run) => run.sb.log("curl-shape.log").split("\n").filter(Boolean).map((l) => l.split("shape=")[1]);
const noWrites = (run) => {
  assert.deepEqual(writeEvents(run), [], "nothing may be written before the gate passes");
  assert.ok(!calls(run).some((c) => /^(mcp (add|install|remove)|config set|gateway)/.test(c)), `unexpected write call: ${calls(run)}`);
};
const CFG_OLD = "model.default: old/model\n";
const ENV_OLD = `FOO=bar\nMCP_ACME_API_KEY=${OLD}\n`;

describe("hermes-mcp-add: bearer token through the native `mcp add --auth header`", { concurrency: 6 }, () => {
  it("probe BEFORE any write; token over stdin into .env (600); `mcp add` gets the two answers on stdin; reload; mcp test; secret never in argv/config/output", async () => {
    await scenario({ name: "mcp-good", valid: [TOKEN], script: bearer(), env: base() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
      const ev = run.sb.events();
      const firstWrite = idx(ev, /^hermes (config set|mcp add|mcp install|gateway)/);
      assert.ok(idx(ev, /^curl status=200/) >= 0 && idx(ev, /^curl status=200/) < firstWrite, `probe must precede the first write: ${ev}`);
      const c = calls(run);
      assert.ok(c.includes(`mcp add acme --url ${URL} --auth header`), c.join("\n"));
      assert.ok(!c.some((x) => /--auth-header|--auth-scheme|--placeholder-token|--yes|--env/.test(x)));
      assert.ok(!run.sb.log("hermes-profile.log").includes("unbound"));
      const env = run.sb.read(".hermes/.env");
      assert.match(env, new RegExp(`^MCP_ACME_API_KEY=${TOKEN}$`, "m"));
      assert.equal(run.sb.mode(".hermes/.env"), 0o600);
      const cfg = run.sb.read(".hermes/config.yaml");
      assert.match(cfg, /Bearer \$\{MCP_ACME_API_KEY\}/);
      assert.ok(!cfg.includes(TOKEN), "the secret must not be in config.yaml");
      // order: snapshot (via ssh) -> config set -> mcp add -> restart --detach -> ensure -> mcp test
      const iSet = idx(ev, /^hermes config set MCP_ACME_API_KEY/);
      const iAdd = idx(ev, /^hermes mcp add acme/);
      const iRestart = idx(ev, /^hermes gateway restart/);
      const iTest = idx(ev, /^hermes mcp test acme/);
      assert.ok(iSet >= 0 && iSet < iAdd && iAdd < iRestart && iRestart < iTest, ev.join("\n"));
      assert.ok(c.includes("gateway restart --detach") && c.some((x) => x === "gateway ensure --json --timeout 60"));
      assert.ok(!c.some((x) => /gateway (stop|run)|--daemon/.test(x)));
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-mcp-add.prev"));
      assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-mcp-add"));
      assert.match(run.out, /OK: acme connected/);
      assertNoSecretInArgv(run, [TOKEN]);
      assertSecretsNotPrinted(run, [TOKEN]);
    });
  });

  it("with a closed stdin `mcp add` saves nothing (exit 0), and the skill notices instead of reporting success", async () => {
    // control: feed no answers by replacing the two-line stdin
    mustReplace({ skill: SKILL, ids: ["step7.pathB#1"], replace: [["printf 'y\\ny\\n' |", ""]] });
    await scenario({ name: "mcp-nostdin", seed: { env: ENV_OLD, config: CFG_OLD }, valid: [TOKEN], script: bearer({ replace: [["printf 'y\\ny\\n' |", ""]] }), env: base() }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: acme is not listed as enabled/);
      assertStateIdentical(run, "rollback restores the pre-run files");
    });
  });

  it("a name with a dash maps to MCP_ACME_CORP_API_KEY exactly as Hermes derives it", async () => {
    await scenario({ name: "mcp-dash", valid: [TOKEN], script: bearer(), env: base({ MCP_NAME: "acme-corp" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/.env"), /^MCP_ACME_CORP_API_KEY=/m);
      assert.match(run.sb.read(".hermes/config.yaml"), /Bearer \$\{MCP_ACME_CORP_API_KEY\}/);
    });
  });

  it("the stored value is read back from ~/.hermes/.env for the smoke test (not an empty ssh-shell variable)", async () => {
    await scenario({ name: "mcp-smoke", valid: [TOKEN], script: bearer(), env: base() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      const curls = run.sb.curlCalls();
      assert.equal(curls.length, 3, "unauthenticated probe, bearer probe, smoke test");
      for (const cc of curls.slice(1)) {
        assert.equal(Number(cc.token_len), TOKEN.length);
        assert.equal(cc.argv_has_token, "0");
      }
      assert.deepEqual(shapes(run), ["", "bearer", "bearer"]);
    });
  });
});

describe("hermes-mcp-add: shapes `mcp add` cannot express are written with `config set` and a ${VAR} reference", { concurrency: 6 }, () => {
  const autoFlow = () => custom();
  it("auto: probes bearer first, then the custom header; the working one is registered as headers.<name> with a reference", async () => {
    await scenario({ name: "mcp-hdr", valid: [TOKEN], knobs: { curl_shape: "header" }, script: autoFlow(), env: base({ MCP_AUTH: "auto" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(shapes(run).slice(0, 3), ["", "bearer", "header"], "order of the probes");
      assert.match(run.out, /Auth shape: header/);
      const cfg = run.sb.read(".hermes/config.yaml");
      assert.match(cfg, /^mcp_servers\.acme\.headers\.x-api-key: \$\{MCP_ACME_API_KEY\}$/m);
      assert.match(cfg, new RegExp(`^mcp_servers\\.acme\\.url: ${URL.replace(/[.]/g, "\\.")}$`, "m"));
      assert.match(cfg, /^mcp_servers\.acme\.enabled: true$/m);
      assert.ok(!cfg.includes(TOKEN));
      assert.match(run.sb.read(".hermes/.env"), new RegExp(`^MCP_ACME_API_KEY=${TOKEN}$`, "m"));
      assert.ok(!calls(run).some((c) => c.startsWith("mcp add")), "mcp add cannot express this header");
      assert.ok(calls(run).includes("mcp test acme"));
      assertNoSecretInArgv(run, [TOKEN]);
    });
  });
  it("MCP_HEADER_NAME is honoured", async () => {
    await scenario({ name: "mcp-hdr2", valid: [TOKEN], knobs: { curl_shape: "header" }, script: autoFlow(), env: base({ MCP_AUTH: "header", MCP_HEADER_NAME: "X-Custom-Key" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/config.yaml"), /^mcp_servers\.acme\.headers\.X-Custom-Key: \$\{MCP_ACME_API_KEY\}$/m);
    });
  });
  it("path token: the URL stored in config.yaml carries the reference, not the token", async () => {
    await scenario({ name: "mcp-path", valid: [TOKEN], knobs: { curl_shape: "path" }, script: autoFlow(), env: base({ MCP_AUTH: "auto" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(shapes(run).slice(0, 4), ["", "bearer", "header", "path"]);
      assert.match(run.sb.read(".hermes/config.yaml"), /^mcp_servers\.acme\.url: https:\/\/mcp\.acme\.example\.test\/mcp\/\$\{MCP_ACME_API_KEY\}$/m);
      assert.ok(!run.sb.read(".hermes/config.yaml").includes(TOKEN));
      assertNoSecretInArgv(run, [TOKEN]);
    });
  });
  it("query token", async () => {
    await scenario({ name: "mcp-query", valid: [TOKEN], knobs: { curl_shape: "query" }, script: autoFlow(), env: base({ MCP_AUTH: "auto" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/config.yaml"), /^mcp_servers\.acme\.url: https:\/\/mcp\.acme\.example\.test\/mcp\?token=\$\{MCP_ACME_API_KEY\}$/m);
    });
  });
  it("no authentication needed: no secret is written, no credential variable exists", async () => {
    await scenario({ name: "mcp-none", knobs: { curl_force: "1=200\n" }, script: autoFlow(), env: base({ MCP_AUTH: "none", MCP_TOKEN: undefined }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(!(run.sb.read(".hermes/.env") || "").includes("MCP_ACME_API_KEY"));
      assert.match(run.sb.read(".hermes/config.yaml"), /^mcp_servers\.acme\.url: /m);
    });
  });
});

describe("hermes-mcp-add: HARD GATE - the probe runs before anything is written", { concurrency: 6 }, () => {
  it("a rejected token: ABORT, byte-identical state, no snapshot, no write call", async () => {
    await scenario({ name: "mcp-badtok", seed: { env: ENV_OLD, config: CFG_OLD }, valid: [OLD], script: bearer(), env: base({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: the server rejected the credential sent as bearer \(HTTP 401\)\. Nothing was written/);
      assertStateIdentical(run);
      noWrites(run);
      assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      assertSecretsNotPrinted(run, [TOKEN, OLD]);
    });
  });
  it("auto: no shape accepted -> ABORT listing nothing written", async () => {
    await scenario({ name: "mcp-noshape", seed: { env: ENV_OLD, config: CFG_OLD }, valid: [OLD], script: custom(), env: base({ MCP_AUTH: "auto" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: no auth shape was accepted/);
      assertStateIdentical(run);
      noWrites(run);
    });
  });
  it("auto: a server that answers initialize without credentials cannot be probed - the skill refuses to guess", async () => {
    await scenario({ name: "mcp-open", valid: [TOKEN], knobs: { curl_force: "1=200\n" }, script: custom(), env: base({ MCP_AUTH: "auto" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /cannot reveal its auth shape/);
      noWrites(run);
    });
  });
  it("explicit shape on an open server: continues, but warns that the probe proves nothing", async () => {
    await scenario({ name: "mcp-open-warn", valid: [TOKEN], knobs: { curl_force: "1=200\n" }, script: bearer(), env: base() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /WARN: initialize also answers 200 without credentials/);
    });
  });
  it("no network from the VPS: ABORT (the probe is also the egress check)", async () => {
    await scenario({ name: "mcp-net", valid: [TOKEN], knobs: { net_down: true }, script: bearer(), env: base() }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT/);
      noWrites(run);
    });
  });
  it("the credential is sent to curl as a config on stdin: never in curl argv, ssh argv or a local curl", async () => {
    await scenario({ name: "mcp-argv", valid: [TOKEN], script: bearer(), env: base() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assertNoSecretInArgv(run, [TOKEN]);
      assert.equal(run.sb.log("local-forbidden.log"), "");
    });
  });
});

describe("hermes-mcp-add: inputs are validated locally before any write", { concurrency: 6 }, () => {
  const cases = [
    ["uppercase name", { MCP_NAME: "Acme" }, /MCP_NAME/],
    ["name with a shell metacharacter", { MCP_NAME: "acme;touch$HOME/pwned" }, /MCP_NAME/],
    ["name starting with a dash", { MCP_NAME: "-acme" }, /MCP_NAME/],
    ["name longer than 32", { MCP_NAME: "a".repeat(33) }, /longer than 32/],
    ["unknown MCP_AUTH", { MCP_AUTH: "basic" }, /MCP_AUTH must be/],
    ["header name with a colon", { MCP_AUTH: "header", MCP_HEADER_NAME: "X:Y" }, /MCP_HEADER_NAME/],
    ["http URL", { MCP_URL: "http://mcp.acme.example.test/mcp" }, /https:\/\//],
    ["URL with a space", { MCP_URL: "https://mcp.acme.example.test/m cp" }, /MCP_URL has characters/],
    ["URL with a quote and command", { MCP_URL: `https://x.example.test/mcp'; touch "$HOME/pwned" #` }, /MCP_URL has characters/],
    ["URL with command substitution", { MCP_URL: "https://x.example.test/$(touch pwned)" }, /MCP_URL has characters/],
    ["URL with a ${VAR} reference", { MCP_URL: "https://x.example.test/${HOME}" }, /MCP_URL has characters/],
    ["empty token", { MCP_TOKEN: "" }, /MCP_TOKEN is empty/],
    ["token with a quote", { MCP_TOKEN: `${TOKEN}'x` }, /MCP_TOKEN is empty/],
    ["token with a newline", { MCP_TOKEN: `${TOKEN}\nX=1` }, /MCP_TOKEN is empty/],
    ["token with command substitution", { MCP_TOKEN: `${TOKEN}$(id)` }, /MCP_TOKEN is empty/],
    ["oauth without a URL", { MCP_AUTH: "oauth", MCP_URL: "" }, /needs MCP_URL/],
    ["neither catalog entry nor URL", { MCP_URL: "" }, /not in the Hermes catalog/],
  ];
  for (const [label, over, re] of cases) {
    it(`${label}: ABORT, nothing written, nothing executed`, async () => {
      await scenario({ name: "mcp-val", seed: { env: ENV_OLD, config: CFG_OLD }, valid: [TOKEN], script: bearer(), env: base(over) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /ABORT/);
        assert.match(run.out, re);
        assert.match(run.out, /Nothing was written/);
        assertStateIdentical(run);
        noWrites(run);
        assert.ok(!run.sb.exists("pwned"));
        assert.equal(run.sb.curlCalls().length, 0, "no probe either");
      });
    });
  }
});

describe("hermes-mcp-add: idempotency uses the exact server name", { concurrency: 6 }, () => {
  it("already configured: exit 0, no probe, no write", async () => {
    await scenario({ name: "mcp-idem", seed: { env: ENV_OLD, config: "mcp.acme:\n  url: https://x.example.test/m\n  enabled: true\n" }, valid: [TOKEN], script: bearer(), env: base() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /already configured/);
      assert.ok(!run.completed);
      assertStateIdentical(run);
      assert.equal(run.sb.curlCalls().length, 0);
    });
  });
  it("a server called acme-corp does not block acme (no substring match)", async () => {
    await scenario({ name: "mcp-substr", seed: { config: "mcp.acme-corp:\n  url: https://x.example.test/m\n  enabled: true\n" }, valid: [TOKEN], script: bearer(), env: base() }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/config.yaml"), /^mcp\.acme:$/m);
      assert.match(run.sb.read(".hermes/config.yaml"), /^mcp\.acme-corp:$/m, "the neighbour is untouched");
    });
  });
  it("FORCE=1 removes the old entry first, so `mcp add` does not stop on its overwrite question", async () => {
    await scenario({ name: "mcp-force", seed: { env: ENV_OLD, config: "mcp.acme:\n  url: https://old.example.test/m\n  enabled: true\n" }, valid: [TOKEN], script: bearer(), env: base({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      const c = calls(run);
      assert.ok(idx(c, /^mcp remove acme/) >= 0 && idx(c, /^mcp remove acme/) < idx(c, /^mcp add acme/));
      assert.ok(!run.sb.read(".hermes/config.yaml").includes("old.example.test"));
      assert.match(run.sb.read(".hermes/.env"), new RegExp(`^MCP_ACME_API_KEY=${TOKEN}$`, "m"));
    });
  });
});

describe("hermes-mcp-add: failures after the snapshot restore the previous state", { concurrency: 6 }, () => {
  const seeded = { env: ENV_OLD, config: CFG_OLD };
  const failing = [
    ["the probe inside `mcp add` fails (server saved disabled)", { "fail.mcp.probe": true }, /FAIL: acme is not listed as enabled/],
    ["`mcp add` itself fails", { "fail.mcp.add": true }, /FAIL: hermes -p default mcp add/],
    ["`mcp test` never connects", { "fail.mcp.test": true }, /FAIL: acme did not connect within 30s/],
  ];
  for (const [label, knobs, re] of failing) {
    it(`${label}: rollback puts .env and config.yaml back byte for byte and reloads the gateway`, async () => {
      await scenario({ name: "mcp-rb", seed: seeded, valid: [TOKEN], knobs, script: bearer(), env: base({ FORCE: "1" }) }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, re);
        assertStateIdentical(run, "pre-run state");
        assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-mcp-add.prev"));
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-mcp-add"));
        assert.equal(run.sb.mode(".hermes/.env"), 0o600);
        assert.ok(calls(run).filter((c) => c === "gateway restart --detach").length >= 1);
        assertSecretsNotPrinted(run, [TOKEN]);
      });
    });
  }
  it("a failed smoke test (401 from the stored credential) rolls back and keeps the previous working token", async () => {
    await scenario({ name: "mcp-smoke401", seed: seeded, valid: [TOKEN, OLD], knobs: { curl_force: "3=401\n" }, script: bearer(), env: base({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: smoke test returned HTTP 401/);
      assertStateIdentical(run);
    });
  });
  it("a gateway that will not restart: rollback restores the files and says the gateway did not come back (snapshot kept)", async () => {
    await scenario({ name: "mcp-gw", seed: seeded, valid: [TOKEN], knobs: { "fail.gateway.restart": true }, script: bearer(), env: base({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: gateway did not restart ready/);
      assert.match(run.out, /files restored, but the gateway did NOT come back/);
      assertStateIdentical(run);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-mcp-add"), "snapshot retained for recovery");
    });
  });
  it("a leftover snapshot from a crashed run blocks the next run before anything is written", async () => {
    await scenario({ name: "mcp-left", seed: seeded, valid: [TOKEN], files: { ".hermes/.hstack-backup/hermes-mcp-add/.complete": "hstack-snapshot-v1\n" }, script: bearer(), env: base() }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: snapshot failed/);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
    });
  });
  it("a live-session refusal during the reload is reported, never overridden", async () => {
    await scenario({ name: "mcp-live", seed: seeded, valid: [TOKEN], knobs: { live_sessions: true }, script: bearer(), env: base({ FORCE: "1" }) }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /GW_INTERRUPT=1/);
      assert.ok(!calls(run).some((c) => /gateway restart --detach -y/.test(c)));
    });
  });
});

describe("hermes-mcp-add: native catalog", { concurrency: 4 }, () => {
  const catalogEnv = (name) => ({ MCP_NAME: name, MCP_URL: undefined, MCP_TOKEN: undefined, MCP_AUTH: undefined });
  it("a no-auth catalog entry: `mcp install NAME`, no probe, no credential, no curl", async () => {
    await scenario({ name: "mcp-cat", script: catalog(), env: catalogEnv("deepwiki") }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /Route: catalog/);
      assert.ok(calls(run).includes("mcp install deepwiki"));
      assert.ok(!calls(run).some((c) => c.startsWith("mcp add") || c.startsWith("config set")));
      assert.equal(run.sb.curlCalls().length, 0);
      assert.match(run.sb.read(".hermes/config.yaml"), /^mcp\.deepwiki:$/m);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-mcp-add.prev"));
      assert.ok(calls(run).includes("mcp test deepwiki"));
    });
  });
  it("an OAuth catalog entry installs but is NOT signed in: PENDING (exit 3), the snapshot stays, nothing is rolled back", async () => {
    await scenario({ name: "mcp-oauth", script: catalog(), env: catalogEnv("linear") }, async (run) => {
      assert.equal(run.code, 3, run.out);
      assert.match(run.out, /PENDING: linear is installed but not signed in/);
      assert.match(run.out, /mcp login linear --flow device/);
      assert.match(run.sb.read(".hermes/config.yaml"), /^mcp\.linear:$/m, "the install is kept for the sign-in");
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-mcp-add"), "snapshot still active");
    });
  });
  it("after the attended sign-in (mcp login exits 0 either way; only `mcp test` decides) the same block finishes the run", async () => {
    const withLogin = catalog({ mid: 'remote "hermes -p default mcp login linear" </dev/null\n', ids: ["step8#1", "step9#1", "step10#1"] });
    await scenario({ name: "mcp-oauth-ok", knobs: { mcp_oauth_ok: true }, script: withLogin, env: catalogEnv("linear") }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-mcp-add.prev"));
    });
    await scenario({ name: "mcp-oauth-fail", script: withLogin, env: catalogEnv("linear") }, async (run) => {
      assert.equal(run.code, 3, "login failed silently (exit 0) - mcp test still says not connected");
      assert.match(run.out, /PENDING/);
    });
  });
  it("a name that is neither in the catalog nor given a URL is refused before anything runs", async () => {
    await scenario({ name: "mcp-nocat", script: catalog(), env: catalogEnv("no-such-vendor") }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /not in the Hermes catalog/);
      noWrites(run);
    });
  });
  it("a name in the catalog WITH a URL is a custom server, not the catalog entry", async () => {
    await scenario({ name: "mcp-cat-url", valid: [TOKEN], script: bearer(), env: base({ MCP_NAME: "linear" }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /Route: custom/);
      assert.ok(!calls(run).some((c) => c.startsWith("mcp install")));
    });
  });
});

describe("hermes-mcp-add: custom OAuth server and stdio server", { concurrency: 4 }, () => {
  it("--auth oauth: saved by `mcp add` (one `y`), signed in by the user, enabled with config set, then verified by mcp test", async () => {
    const mid = 'remote "hermes -p default mcp login acme" </dev/null\nremote "hermes -p default config set mcp_servers.acme.enabled true" </dev/null\n';
    const script = assemble([
      "set +e\n", { skill: SKILL, ids: PRE }, { skill: SKILL, ids: GATE }, { skill: SKILL, ids: ["step6#1", "step7.pathE#1"] }, mid, { skill: SKILL, ids: TAIL }, SCRIPT_END,
    ]);
    await scenario({ name: "mcp-oauth-custom", knobs: { mcp_oauth_ok: true }, script, env: base({ MCP_AUTH: "oauth", MCP_TOKEN: undefined }) }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(calls(run).includes(`mcp add acme --url ${URL} --auth oauth`));
      assert.equal(run.sb.curlCalls().length, 0, "an OAuth server cannot be probed headlessly");
      assert.ok(!(run.sb.read(".hermes/.env") || "").includes("MCP_ACME"));
    });
    const pending = assemble(["set +e\n", { skill: SKILL, ids: PRE }, { skill: SKILL, ids: GATE }, { skill: SKILL, ids: ["step6#1", "step7.pathE#1", "step8#1", "step9#1"] }, SCRIPT_END]);
    await scenario({ name: "mcp-oauth-custom-pending", script: pending, env: base({ MCP_AUTH: "oauth", MCP_TOKEN: undefined }) }, async (run) => {
      assert.equal(run.code, 3, run.out);
      assert.match(run.out, /PENDING/);
    });
  });
  it("stdio: the secret stays a ${VAR} reference in --env, never a value; --args is last", async () => {
    const script = assemble(["set +e\n", { skill: SKILL, ids: PRE }, { skill: SKILL, ids: ["step7.pathD#1"] }, SCRIPT_END]);
    await scenario({ name: "mcp-stdio", script, env: { MCP_NAME: "local" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      const add = calls(run).find((c) => c.startsWith("mcp add"));
      assert.match(add, /^mcp add local --env EXAMPLE_API_KEY=\$\{EXAMPLE_API_KEY\} --command npx --args -y @example\/mcp-server$/);
      assert.match(run.sb.read(".hermes/config.yaml"), /^mcp\.local:$/m);
    });
  });
});

describe("hermes-mcp-add: mutation controls (each guard is load-bearing)", { concurrency: 4 }, () => {
  it("writing the secret BEFORE the probe would replace a working token with a typo'd one", async () => {
    const swapped = assemble([
      "set +e\n", { skill: SKILL, ids: PRE }, { skill: SKILL, ids: ["step1#1", "step2#1", "step3#1"] },
      "SHAPE=bearer\n", { skill: SKILL, ids: ["step6#1"] }, { skill: SKILL, ids: ["step4#1", "step5#1"] }, SCRIPT_END,
    ]);
    await scenario({ name: "mcp-ctl-order", seed: { env: ENV_OLD, config: CFG_OLD }, valid: [OLD], script: swapped, env: base({ FORCE: "1" }) }, async (run) => {
      assertStateChanged(run);
      assert.ok(writeEvents(run).length > 0, "control: with the order swapped the bad token reaches .env");
    });
  });
  it("a name derivation without the dash mapping breaks the variable Hermes reads", async () => {
    mustReplace({ skill: SKILL, ids: ["step2#1"], replace: [["tr 'a-z-' 'A-Z_'", "tr 'a-z' 'A-Z'"]] });
    await scenario({ name: "mcp-ctl-dash", valid: [TOKEN], script: bearer({ replace: [["tr 'a-z-' 'A-Z_'", "tr 'a-z' 'A-Z'"]] }), env: base({ MCP_NAME: "acme-corp" }) }, async (run) => {
      assert.ok(!/^MCP_ACME_CORP_API_KEY=/m.test(run.sb.read(".hermes/.env") || ""), "control: the real variable is not written");
    });
  });
  it("without the enabled check a cancelled `mcp add` would be reported as success", async () => {
    const drop = [["printf 'y\\ny\\n' |", ""], [`  || { echo "FAIL: $MCP_NAME is not listed as enabled (the add was cancelled or the connection failed)."; rollback; exit 1; }`, ""]];
    mustReplace({ skill: SKILL, ids: ["step7.pathB#1"], replace: drop });
    await scenario({ name: "mcp-ctl-enabled", valid: [TOKEN], script: bearer({ replace: drop }), env: base() }, async (run) => {
      // the add saved nothing, yet the run goes on until mcp test finally notices (exit 3: no such server)
      assert.ok(!/^mcp\.acme:/m.test(run.sb.read(".hermes/config.yaml") || ""));
      assert.ok(calls(run).includes("mcp test acme"), "control applied: the skill proceeded past the cancelled add");
    });
  });
});

describe("hermes-mcp-add: static facts about the text", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  const fences = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
  it("no retired mcp flags and no secret on an argv", () => {
    assert.doesNotMatch(fences, /--auth-header|--auth-scheme|--placeholder-token|mcp add[^\n]*--yes/);
    assert.doesNotMatch(fences, /--env\s+'?[A-Z_]+=\$\{?MCP_TOKEN/);
    assert.doesNotMatch(fences, /config set [^\n]*\$MCP_TOKEN|-H ["']Authorization: Bearer \$/);
  });
  it("the catalog comes first and the catalog facts are stated", () => {
    assert.match(text, /hermes -p default mcp catalog/);
    assert.match(text, /mcp install/);
    assert.match(text, /66 manifests/);
    assert.match(text, /56 use OAuth, 10 need no authentication, none\s+takes an API key/);
  });
  it("cites its source and says what was not verified", () => {
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    assert.match(text, /hermes_cli\/mcp_config\.py:618-721/);
    assert.match(text, /\*\*Not verified:\*\*/);
  });
});
