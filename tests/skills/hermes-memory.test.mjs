// hermes-memory: input validation before any remote call, read-only inspection, `builtin` (memory off + snapshot + gateway reload + rollback),
// `external` (backup, catalog install with explicit consent, never an unattended wizard) and `verify`. Native behaviour is the stub's
// ASSUMPTION (tests/skills/stub-commands/{memory,plugins}.sh, strings from the v0.22.5 source); the call shapes are checked by the real argparse.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { assertStateIdentical } from "./helpers/asserts.mjs";
import { REPO_ROOT, assemble, loadBlocks } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

const SKILL = "hermes-memory";
const ALL = ["step0#1", "step1#1", "step2#1", "step3#1", "step3#2", "step4#1"];
const script = (ids = ALL) => assemble(["set +e\n", { skill: SKILL, ids }, SCRIPT_END]);
const withProvider = { env: "PUBLIC_FIXTURE=keep\n", config: "model.default: prior/model\nmemory.provider: honcho\n" };
const noProvider = { env: "PUBLIC_FIXTURE=keep\n", config: "model.default: prior/model\n" };
const calls = (r) => r.sb.hermesCalls().map((c) => c.join(" "));
const installed = (name) => (sb) => sb.write(`.hermes/plugins/${name}/plugin.yaml`, `name: ${name}\n`);
const artifacts = (r) => readdirSync(r.sb.home).filter((f) => /^hermes-backup-hstack-pre-memory-.*\.zip$/.test(f));

describe("hermes-memory: Step 0 validation (before any remote call)", { concurrency: 6 }, () => {
  const cases = [
    ["an unknown MODE", { MODE: "write" }, /MODE must be/],
    ["external without a PROVIDER", { MODE: "external" }, /choose an available native\/catalog memory provider/],
    ["verify without a PROVIDER", { MODE: "verify" }, /choose an available native\/catalog memory provider/],
    ["a PROVIDER with a command", { MODE: "external", PROVIDER: "mem0; touch pwned" }, /choose an available/],
    ["a PROVIDER with command substitution", { MODE: "verify", PROVIDER: "$(touch pwned)" }, /choose an available/],
    ["a catalog provider without DEPS_CONSENT", { MODE: "external", PROVIDER: "mem0" }, /DEPS_CONSENT=1/],
    ["a wrong HERMES_VERSION", { MODE: "inspect", HERMES_VERSION: "0.15.2" }, /0\.22\.5/],
    ["a malformed target", { MODE: "inspect", VPS_IP: "1.2.3.4;id" }, /malformed SSH target/],
  ];
  for (const [label, env, msg] of cases) {
    it(`rejects ${label} with zero ssh calls and nothing written`, async () => {
      await scenario({ name: "mem-val", seed: withProvider, script: script(["step0#1"]), env }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, msg);
        assert.match(r.out, /Nothing was written/);
        assert.equal(r.sb.sshCalls().length, 0);
        assert.ok(!r.sb.exists("pwned"));
        assertStateIdentical(r);
      });
    });
  }
  it("accepts the bundled providers and the default inspect mode without DEPS_CONSENT", async () => {
    for (const env of [{}, { MODE: "external", PROVIDER: "retaindb" }, { MODE: "external", PROVIDER: "byterover" }, { MODE: "external", PROVIDER: "mem0", DEPS_CONSENT: "1" }]) {
      await scenario({ name: "mem-val-ok", seed: withProvider, script: script(["step0#1"]), env }, async (r) => {
        assert.equal(r.code, 0, r.out);
      });
    }
  });
});

describe("hermes-memory: inspect (default) is read-only", { concurrency: 6 }, () => {
  it("reads the version and `memory status` only, then stops", async () => {
    await scenario({ name: "mem-inspect", seed: withProvider, script: script(), env: {} }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Inspection complete\. No provider was changed\./);
      assert.deepEqual(calls(r), ["--version", "memory status"]);
      assert.ok(!r.sb.log("hermes-profile.log").includes("unbound"));
      assertStateIdentical(r);
    });
  });
  for (const banner of ["hermes 0.15.2", "Hermes Agent v0.21.6", "Hermes Agent v0.22.50"]) {
    it(`a ${JSON.stringify(banner)} banner is refused before memory status`, async () => {
      await scenario({ name: "mem-banner", seed: withProvider, script: script(), env: {}, files: { "hermes.version": `${banner}\n` } }, async (r) => {
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /ABORT: .*0\.22\.5/);
        assert.deepEqual(calls(r), ["--version"]);
        assertStateIdentical(r);
      });
    });
  }
  it("an unavailable status command is reported, not papered over", async () => {
    await scenario({ name: "mem-nostatus", seed: withProvider, script: script(), env: {}, knobs: { "fail.memory": true } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /FAIL: native memory status unavailable/);
      assertStateIdentical(r);
    });
  });
});

describe("hermes-memory: builtin (memory off)", { concurrency: 6 }, () => {
  const env = { MODE: "builtin" };

  it("snapshot, `memory off`, gateway reload (restart --detach then ensure), status check, finish; built-in notes and .env untouched", async () => {
    await scenario({ name: "mem-builtin", seed: withProvider, script: script(), env }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /OK: external memory is off/);
      assert.match(r.sb.read(".hermes/config.yaml"), /^memory\.provider: ""$/m);
      assert.match(r.sb.read(".hermes/config.yaml"), /^model\.default: prior\/model$/m, "other config is untouched");
      assert.equal(r.sb.read(".hermes/.env"), withProvider.env);
      const c = calls(r);
      assert.ok(c.includes("memory off"));
      assert.ok(c.indexOf("memory off") < c.indexOf("gateway restart --detach") && c.indexOf("gateway restart --detach") < c.lastIndexOf("gateway ensure --json --timeout 60"), c.join(" | "));
      assert.ok(!c.some((x) => /^memory (reset|setup)|^backup|^plugins|^gateway (stop|run|status)|--daemon|gateway restart --detach -y/.test(x)), c.join(" | "));
      assert.ok(r.sb.exists(".hermes/.hstack-backup/hermes-memory.prev"));
      assert.equal(r.sb.read(".hermes/.hstack-backup/hermes-memory.prev/config.yaml"), withProvider.config);
      assert.ok(!r.sb.exists(".hermes/.hstack-backup/hermes-memory"));
      assert.equal(artifacts(r).length, 0);
    });
  });

  it("`memory off` failing restores the exact pre-run config and reloads the gateway", async () => {
    await scenario({ name: "mem-off-fail", seed: withProvider, script: script(), env, knobs: { "fail.memory.off": true } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /FAIL: memory off/);
      assert.match(r.out, /rollback: restored/);
      assertStateIdentical(r);
      assert.ok(r.sb.exists(".hermes/.hstack-backup/hermes-memory.prev"));
    });
  });

  it("a gateway that cannot restart rolls the config back; a rollback that cannot reload either keeps the recovery point", async () => {
    await scenario({ name: "mem-gw-fail", seed: withProvider, script: script(), env, knobs: { "fail.gateway.restart": true } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /FAIL: gateway did not restart ready\. Rolling back\./);
      assert.match(r.out, /files restored, but the gateway did NOT come back/);
      assertStateIdentical(r);
      assert.ok(r.sb.exists(".hermes/.hstack-backup/hermes-memory"), "snapshot stays active");
    });
  });

  it("live sessions: the restart refusal is reported, -y is never added, the config is restored", async () => {
    await scenario({ name: "mem-live", seed: withProvider, script: script(), env, knobs: { live_sessions: true } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /live sessions\?/);
      assert.ok(!calls(r).some((x) => / -y$| --yes$| --interrupt$/.test(x)));
      assertStateIdentical(r);
    });
    await scenario({ name: "mem-live-int", seed: withProvider, script: script(), env: { ...env, GW_INTERRUPT: "1" }, knobs: { live_sessions: true } }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.ok(calls(r).includes("gateway restart --detach -y"));
    });
  });

  it("a status that still names the provider after `memory off` rolls back", async () => {
    await scenario({ name: "mem-still", seed: withProvider, script: script(), env, files: { "memory.out": "  Provider:  honcho\n" } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /memory status still names an external provider/);
      assertStateIdentical(r);
    });
  });

  it("a leftover snapshot from a crashed run stops the new run before any write", async () => {
    await scenario({ name: "mem-left", seed: withProvider, script: script(), env, setup: (sb) => sb.write(".hermes/.hstack-backup/hermes-memory/.env", "junk\n") }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /did not finish/);
      assert.ok(!calls(r).includes("memory off"));
      assertStateIdentical(r);
    });
  });
});

describe("hermes-memory: external (prepare for attended setup)", { concurrency: 6 }, () => {
  it("bundled provider: native backup, no install, prints the attended command, exits non-zero, writes nothing", async () => {
    await scenario({ name: "mem-ext-bundled", seed: noProvider, script: script(), env: { MODE: "external", PROVIDER: "retaindb" } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /Bundled provider: nothing to install/);
      assert.match(r.out, /ACTION REQUIRED: in your attended terminal run: ssh -t root@203\.0\.113\.9 .*hermes -p default memory setup retaindb/);
      assert.match(r.out, /External memory is NOT verified/);
      const c = calls(r);
      assert.ok(c.some((x) => /^backup --output \S*\/hermes-backup-hstack-pre-memory-\S+\.zip --keep 0$/.test(x)), c.join(" | "));
      assert.ok(!c.some((x) => /^plugins|^memory (setup|reset|off)|^gateway/.test(x)), `nothing is installed, configured or reloaded: ${c.join(" | ")}`);
      assert.equal(artifacts(r).length, 1);
      assert.equal(r.sb.mode(artifacts(r)[0]), 0o600);
      assertStateIdentical(r);
    });
  });

  it("catalog provider with consent: installs disabled (--yes-deps --no-enable), never activates, never runs the wizard", async () => {
    await scenario({ name: "mem-ext-catalog", seed: noProvider, script: script(), env: { MODE: "external", PROVIDER: "honcho", DEPS_CONSENT: "1" } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      const c = calls(r);
      assert.ok(c.includes("plugins install honcho --yes-deps --no-enable"), c.join(" | "));
      assert.ok(c.indexOf("plugins install honcho --yes-deps --no-enable") > c.findIndex((x) => x.startsWith("backup ")), "backup comes first");
      assert.ok(!c.some((x) => /^memory (setup|reset|off)|plugins enable|--enable|^gateway/.test(x)), c.join(" | "));
      assert.ok(r.sb.exists(".hermes/plugins/honcho/plugin.yaml"));
      assert.ok(!/^memory\.provider:/m.test(r.sb.read(".hermes/config.yaml")), "the provider is not selected by this skill");
      assert.match(r.out, /ACTION REQUIRED/);
      assertStateIdentical(r);
    });
  });

  it("without --yes-deps the native install is refused in a session with no terminal (control: why Step 0 insists on DEPS_CONSENT)", async () => {
    await scenario({ name: "mem-ctl", seed: noProvider, script: assemble(["set +e\n", { skill: SKILL, ids: ["step0#1"] }, 'remote "hermes -p default plugins install mem0 --no-enable"; echo "RC=$?"\n']), env: { MODE: "inspect" } }, async (r) => {
      assert.match(r.out, /RC=1/);
      assert.match(r.out, /consent is required/);
    });
  });

  it("a plugin install that fails stops with FAIL and leaves everything as it was", async () => {
    await scenario({ name: "mem-ext-fail", seed: noProvider, script: script(), env: { MODE: "external", PROVIDER: "mem0", DEPS_CONSENT: "1" }, knobs: { "fail.plugins": true } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /FAIL: plugin install refused or failed/);
      assert.doesNotMatch(r.out, /ACTION REQUIRED/);
      assertStateIdentical(r);
    });
  });

  it("a backup that fails stops before the install", async () => {
    await scenario({ name: "mem-ext-nobackup", seed: noProvider, script: script(), env: { MODE: "external", PROVIDER: "mem0", DEPS_CONSENT: "1" }, knobs: { backup_incomplete: true } }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /FAIL: memory backup unavailable/);
      assert.ok(!calls(r).some((x) => x.startsWith("plugins")));
    });
  });

  it("no secret is ever requested or placed in argv", async () => {
    await scenario({ name: "mem-ext-argv", seed: noProvider, script: script(), env: { MODE: "external", PROVIDER: "supermemory", DEPS_CONSENT: "1", SUPERMEMORY_API_KEY: "sm_fixture_key_that_must_not_travel" } }, async (r) => {
      for (const c of r.sb.sshCalls()) assert.ok(!c.includes("sm_fixture_key_that_must_not_travel"));
      assert.ok(!r.out.includes("sm_fixture_key_that_must_not_travel"));
    });
  });
});

describe("hermes-memory: verify (after the attended setup)", { concurrency: 6 }, () => {
  const env = { MODE: "verify", PROVIDER: "honcho" };

  it("reloads the gateway and requires: selected provider, plugin installed, status available", async () => {
    await scenario({ name: "mem-verify", seed: withProvider, script: script(), env, setup: installed("honcho") }, async (r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /OK: honcho is the configured memory provider and reports available\./);
      assert.match(r.out, /storage canary is still a separate, authorized step/);
      const c = calls(r);
      assert.ok(c.includes("gateway restart --detach") && c.includes("gateway ensure --json --timeout 60"));
      assert.ok(!c.some((x) => /^(plugins|backup|memory (setup|off|reset))|^gateway (stop|run|status)/.test(x)));
      assertStateIdentical(r);
    });
  });

  it("the provider is not selected yet (native setup not completed): FAIL, nothing changed", async () => {
    await scenario({ name: "mem-verify-unset", seed: noProvider, script: script(), env, setup: installed("honcho") }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /memory\.provider is not honcho yet/);
      assertStateIdentical(r);
    });
  });

  it("a different provider is selected: FAIL", async () => {
    await scenario({ name: "mem-verify-other", seed: { env: noProvider.env, config: "memory.provider: retaindb\n" }, script: script(), env, setup: installed("honcho") }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /memory\.provider is not honcho yet/);
    });
  });

  it("selected but the plugin is not installed: FAIL", async () => {
    await scenario({ name: "mem-verify-noplugin", seed: withProvider, script: script(), env }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /plugin is not installed/);
    });
  });

  it("selected and installed but unavailable (missing credentials): FAIL", async () => {
    await scenario({ name: "mem-verify-unavail", seed: withProvider, script: script(), env, knobs: { memory_unavailable: true }, setup: installed("honcho") }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /selected but not available/);
    });
  });

  it("a gateway that will not restart ready fails the verification (no -y)", async () => {
    await scenario({ name: "mem-verify-gw", seed: withProvider, script: script(), env, knobs: { live_sessions: true }, setup: installed("honcho") }, async (r) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /FAIL: gateway did not restart ready/);
      assert.ok(!calls(r).some((x) => / -y$/.test(x)));
      assertStateIdentical(r);
    });
  });

  it("a bundled provider needs no plugin directory", async () => {
    await scenario({ name: "mem-verify-bundled", seed: { env: noProvider.env, config: "memory.provider: retaindb\n" }, script: script(), env: { MODE: "verify", PROVIDER: "retaindb" } }, async (r) => {
      assert.equal(r.code, 0, r.out);
    });
  });
});

describe("hermes-memory: text invariants", () => {
  const text = readFileSync(path.join(REPO_ROOT, "skills/hermes-memory/SKILL.md"), "utf8");
  const body = loadBlocks(SKILL).filter((b) => b.id !== "step0#1").map((b) => b.code).join("\n");
  it("never runs the wizard, reset, plugins enable, a manifest install script, or the retired stop+ensure reload", () => {
    assert.doesNotMatch(body, /hermes -p default memory reset|remote [^\n]*memory setup|plugins enable|byterover\.dev|gateway stop|gateway run|--daemon/);
    assert.match(text, /`plugins enable` cannot activate a memory provider/);
  });
  it("--yes-deps only appears behind DEPS_CONSENT, and the provider is allowlisted before it is used", () => {
    assert.match(text, /DEPS_CONSENT/);
    const step0 = loadBlocks(SKILL).find((b) => b.id === "step0#1").code;
    assert.match(step0, /case "\$\{PROVIDER:-\}" in retaindb\|byterover\|honcho\|hindsight\|supermemory\|mem0\|openviking\|holographic\)/);
    assert.match(step0, /DEPS_CONSENT:-0/);
  });
  it("lists the verified provider credentials and has a Verified section with citations", () => {
    for (const v of ["RETAINDB_API_KEY", "BRV_API_KEY", "HONCHO_API_KEY", "SUPERMEMORY_API_KEY"]) assert.ok(text.includes(v), v);
    assert.match(text, /## Verified against Hermes v0\.22\.5/);
    for (const cite of ["hermes_cli/memory_setup.py", "hermes_cli/main_agent_cmds.py", "hermes_cli/plugins_cmd_install.py", "plugin-catalog/"]) assert.ok(text.includes(cite), cite);
    assert.match(text, /Not verified:/);
  });
});
