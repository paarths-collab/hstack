// hermes-model: provider key names, key transport, input validation, and rollback on a bad or
// inconclusive inference smoke test. The real SKILL.md blocks run against a simulated VPS.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readFileSync } from "node:fs";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, idx, writeEvents } from "./helpers/asserts.mjs";
import { assemble, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

const SKILL = "hermes-model";
const FLOW = [
  "step1#1", "step1#2", "step2#1", "step3#1", "step4#1", "step4#2",
  "step5#1", "step6#1", "step7#1", "step8#1", "capability-check#1",
];
const flow = (ids = FLOW) => assemble(["set +e\n", { skill: SKILL, ids: ["before-you-start#1", "step0#1"] }, { skill: SKILL, ids }, SCRIPT_END]);
const validateOnly = assemble(["set +e\n", { skill: SKILL, ids: ["step0#1"] }, SCRIPT_END]);

const PROVIDERS = [
  { name: "openrouter", keyvar: "OPENROUTER_API_KEY", id: "openrouter", key: fake.openrouter("K"), model: "anthropic/claude-sonnet-4" },
  { name: "anthropic", keyvar: "ANTHROPIC_API_KEY", id: "anthropic", key: fake.anthropic("K"), model: "claude-sonnet-4-6" },
  { name: "openai", keyvar: "OPENAI_API_KEY", id: "openai-api", key: fake.openai("K"), model: "gpt-5" },
  { name: "deepseek", keyvar: "DEEPSEEK_API_KEY", id: "deepseek", key: fake.deepseek("K"), model: "deepseek-chat" },
];
const OLD_KEY = fake.openrouter("O");
const oldState = { env: `FOO=bar\nOPENROUTER_API_KEY=${OLD_KEY}\n`, config: "model.default: old/model\nmodel.provider: openrouter\nprompt_caching.enabled: false\n" };
const base = { MODEL_PROVIDER: "openrouter", MODEL_API_KEY: PROVIDERS[0].key, HERMES_MODEL: PROVIDERS[0].model };

describe("hermes-model: provider key names and transport", { concurrency: 6 }, () => {
  for (const p of PROVIDERS) {
    it(`${p.name}: ${p.keyvar} + model.provider=${p.id}, key over stdin, never in ssh/curl argv, config or output`, async () => {
      await scenario({ name: `model-${p.name}`, script: flow(), env: { MODEL_PROVIDER: p.name, MODEL_API_KEY: p.key, HERMES_MODEL: p.model } }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.completed);
        const env = run.sb.read(".hermes/.env");
        const keys = env.split("\n").filter(Boolean).map((l) => l.split("=")[0]);
        assert.deepEqual(keys, [p.keyvar], "exactly one key, under the name Hermes reads");
        assert.match(env, new RegExp(`^${p.keyvar}=${p.key}$`, "m"));
        assert.equal(run.sb.mode(".hermes/.env"), 0o600);
        const cfg = run.sb.read(".hermes/config.yaml");
        assert.match(cfg, new RegExp(`^model\\.provider: ${p.id}$`, "m"));
        assert.match(cfg, new RegExp(`^model\\.default: ${p.model.replace(/[.]/g, "\\.")}$`, "m"));
        assert.ok(!/^prompt_caching\.enabled: true$/m.test(cfg), "model setup must not silently enable unrelated caching");
        assert.ok(!cfg.includes(p.key), "key in config.yaml");
        // the key travelled on stdin: the ssh command line carries the variable NAME, never the value
        assert.ok(run.sb.sshCalls().some((c) => c.includes(`hermes -p default config set ${p.keyvar} "$v"`)));
        assertNoSecretInArgv(run, [p.key]);
        assertSecretsNotPrinted(run, [p.key]);
        const calls = run.sb.hermesCalls();
        assert.ok(!calls.some((c) => c[0] === "setup"), "bounded config must not rerun the setup wizard");
        assert.ok(!calls.some((c) => c.includes("--portal")), "--portal hangs a headless run");
        // ONE native reload after every write (probe ensure, restart --detach, ensure until ready); never stop / foreground run.
        assert.deepEqual(run.sb.events().filter((e) => /^hermes gateway /.test(e)), ["hermes gateway ensure", "hermes gateway restart", "hermes gateway ensure"]);
        assert.ok(calls.some((c) => c.join(" ") === "gateway restart --detach"));
        assert.ok(!calls.some((c) => c[0] === "gateway" && ["stop", "run"].includes(c[1])));
        assert.ok(!calls.some((c) => c.some((x) => ["-y", "--yes", "--force", "--all", "--interrupt"].includes(x))));
        // `config show` prints the whole config (custom keys can hold secrets): the native single-key `config get` is used instead
        assert.ok(!calls.some((c) => c[0] === "config" && c[1] === "show"), "no whole-config dump");
        const ev = run.sb.events();
        assert.ok(idx(ev, /^hermes config get model\.default/) >= 0 && idx(ev, /^hermes config get model\.provider/) >= 0, "model state is read back with `config get`");
        // order: key + model/provider writes, then the reload, then the inference smoke (which goes through the ready gateway)
        assert.ok(ev.lastIndexOf("hermes config set model.default") < ev.indexOf("hermes gateway restart"));
        assert.ok(ev.lastIndexOf("hermes gateway ensure") < idx(ev, /^hermes -z/));
        assert.ok(calls.some((c) => c[0] === "-z" && c[1] === "reply with the single word OK" && c.length === 2), "-z gets exactly the prompt (no key, no toolsets)");
        assert.match(run.out, /OK: model .* responded/);
        assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-model.prev"));
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-model"));
      });
    });
  }

  it("the legacy OPENROUTER_API_KEY variable is still accepted for openrouter", async () => {
    const env = { MODEL_PROVIDER: undefined, MODEL_API_KEY: undefined, OPENROUTER_API_KEY: PROVIDERS[0].key, HERMES_MODEL: PROVIDERS[0].model };
    await scenario({ name: "model-legacy", script: flow(), env }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/.env"), /^OPENROUTER_API_KEY=/m);
    });
  });

  it("reports auxiliary capabilities as unverified instead of inferring them from key presence", async () => {
    for (const p of [PROVIDERS[0], PROVIDERS[1]]) {
      await scenario({ name: "model-cap", script: flow(), env: { MODEL_PROVIDER: p.name, MODEL_API_KEY: p.key, HERMES_MODEL: p.model } }, async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.match(run.out, /Unverified: auxiliary tools and messaging delivery/);
        assert.ok(!run.out.includes("vision           : active"));
      });
    }
  });

  it("native config refusal rolls back instead of bypassing validation through manual YAML", async () => {
    const seed = { env: oldState.env, config: "model:\n  default: old/model\n  provider: openrouter\nother_setting: 1\n" };
    await scenario({ name: "model-native-refusal", seed, knobs: { "fail.set.model.provider": true }, script: flow(), env: { ...base, FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: could not apply model config/);
      assertStateIdentical(run);
      assert.ok(!run.out.includes("Path A failed; trying Path B"));
    });
  });

  it("a longer model id that merely CONTAINS the requested one is not 'already set' (exact `config get` comparison)", async () => {
    const seed = { env: `OPENROUTER_API_KEY=${OLD_KEY}\n`, config: `model.default: ${base.HERMES_MODEL}-5\nmodel.provider: openrouter\n` };
    await scenario({ name: "model-idem-substr", seed, script: flow(), env: base }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.doesNotMatch(run.out, /Model already set/);
      assert.match(run.sb.read(".hermes/config.yaml"), new RegExp(`^model\\.default: ${base.HERMES_MODEL.replace(/[.]/g, "\\.")}$`, "m"));
    });
  });

  it("already configured to this model: exits 0 without touching anything; FORCE=1 reconfigures", async () => {
    const seed = { env: `OPENROUTER_API_KEY=${OLD_KEY}\n`, config: `model.default: ${base.HERMES_MODEL}\nmodel.provider: openrouter\n` };
    await scenario({ name: "model-idem", seed, script: flow(), env: base }, async (run) => {
      assert.equal(run.code, 0);
      assert.match(run.out, /Model already set/);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
    });
    await scenario({ name: "model-idem-force", seed, script: flow(), env: { ...base, FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assertStateChanged(run);
    });
  });
});

describe("hermes-model: input validation happens locally, before any ssh call", { concurrency: 6 }, () => {
  const long = (n) => "a".repeat(n);
  const cases = [
    ["unknown provider", { MODEL_PROVIDER: "bogus" }, /MODEL_PROVIDER must be/],
    ["provider injection", { MODEL_PROVIDER: 'openrouter; touch "$HOME/pwned"' }, /MODEL_PROVIDER must be/],
    ["model id with a command", { HERMES_MODEL: 'x; touch "$HOME/pwned"' }, /HERMES_MODEL is empty or has unexpected/],
    ["model id with command substitution", { HERMES_MODEL: '$(touch "$HOME/pwned")' }, /HERMES_MODEL/],
    ["model id with a leading dash", { HERMES_MODEL: "-x" }, /HERMES_MODEL/],
    ["empty model id", { HERMES_MODEL: "" }, /HERMES_MODEL/],
    ["model id of 129 characters", { HERMES_MODEL: long(129) }, /HERMES_MODEL/],
    ["openrouter key with the wrong prefix", { MODEL_API_KEY: PROVIDERS[1].key }, /does not look like a openrouter key/],
    ["key with a quote", { MODEL_API_KEY: `${PROVIDERS[0].key}'x` }, /does not look like/],
    ["key with a newline", { MODEL_API_KEY: `${PROVIDERS[0].key}\nX=1` }, /does not look like/],
    ["key with command substitution", { MODEL_API_KEY: `${PROVIDERS[0].key}$(id)` }, /does not look like/],
    ["empty key", { MODEL_API_KEY: "", OPENROUTER_API_KEY: "" }, /does not look like/],
    // hermes_cli/auth.py:208-213: sk-ant-oat... is a Claude Code OAuth token; Hermes sends ANTHROPIC_API_KEY as x-api-key, which rejects it.
    ["anthropic Claude Code OAuth token (not an API key)", { MODEL_PROVIDER: "anthropic", MODEL_API_KEY: ["sk-", "ant-", "oat01-", "a".repeat(32)].join("") }, /Claude Code OAuth token/],
    ["openai key of 256 characters", { MODEL_PROVIDER: "openai", MODEL_API_KEY: long(256) }, /does not look like a openai key/],
    ["openai key of 15 characters", { MODEL_PROVIDER: "openai", MODEL_API_KEY: long(15) }, /does not look like/],
    ["malformed VPS_IP", { VPS_IP: "1.2.3.4;id" }, /VPS_IP \/ VPS_USER look malformed/],
    ["malformed VPS_USER", { VPS_USER: "Root User" }, /VPS_IP \/ VPS_USER look malformed/],
  ];
  for (const [label, over, msg] of cases) {
    it(`rejects ${label}`, async () => {
      await scenario({ name: "model-val", script: validateOnly, env: { ...base, ...over } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /Nothing was written/);
        assert.equal(run.sb.sshCalls().length, 0);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.ok(!run.sb.exists("pwned"));
      });
    });
  }
  it("accepts an openai key of exactly 255 characters", async () => {
    await scenario({ name: "model-255", script: validateOnly, env: { ...base, MODEL_PROVIDER: "openai", MODEL_API_KEY: "a".repeat(255) } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.completed);
    });
  });
  it("hostile model id through the whole flow: no write, no execution", async () => {
    await scenario({ name: "model-hostile", script: flow(), env: { ...base, HERMES_MODEL: 'x$(touch "$HOME/pwned")' } }, async (run) => {
      assert.equal(run.code, 1);
      assert.deepEqual(writeEvents(run), []);
      assert.ok(!run.sb.exists("pwned"));
    });
  });
});

describe("hermes-model: a bad or inconclusive inference test rolls back", { concurrency: 6 }, () => {
  const replies = [
    ["401 (key rejected)", "Error: provider rejected request, 401 unauthorized\n", /FAIL: API key rejected/],
    ["403 (quota/billing)", "error: forbidden, billing quota exceeded\n", /FAIL: key valid but no quota/],
    ["401 echoing OK", "HTTP 401: invalid API key. Request prompt: reply with the single word OK\n", /FAIL: API key rejected/],
    ["403 echoing OK", "HTTP 403: billing quota exceeded; requested reply OK\n", /FAIL: key valid but no quota/],
    ["599: prompt echo", "reply with the single word OK\n", /could not confirm the key works/],
    ["599: negated OK", "The provider is not OK\n", /could not confirm the key works/],
    ["599: unrecognisable reply", "banana split\n", /could not confirm the key works/],
    ["599: connection error", "connection reset by peer\n", /could not confirm the key works/],
    ["599: empty reply", "\n", /could not confirm the key works/],
  ];
  for (const [label, reply, msg] of replies) {
    it(`${label}: FORCE=1 re-run restores the old key, model and config byte-for-byte`, async () => {
      await scenario({ name: "model-infer", seed: oldState, files: { "infer.out": reply }, script: flow(), env: { ...base, FORCE: "1" } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.match(run.out, /rollback: restored/);
        assertStateIdentical(run);
        assert.equal(run.sb.read(".hermes/.env"), oldState.env);
        assert.equal(run.sb.read(".hermes/config.yaml"), oldState.config);
        assert.ok(writeEvents(run).includes("hermes config set OPENROUTER_API_KEY"), "the new key was written before the failure");
      });
    });
  }

  it("a nonzero inference command that prints exactly OK still rolls back", async () => {
    await scenario({
      name: "model-nonzero-ok", seed: oldState, script: flow(), env: { ...base, FORCE: "1" },
      setup: (sb) => {
        const stub = sb.read(".local/bin/hermes");
        const changed = stub.replace("event -z; inject infer", "event -z; inject infer\n    echo OK; exit 1");
        assert.notEqual(changed, stub, "the nonzero inference control must change the stub");
        sb.write(".local/bin/hermes", changed, 0o755);
      },
    }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /could not confirm the key works/);
      assert.match(run.out, /rollback: restored/);
      assertStateIdentical(run);
    });
  });

  for (const [label, knobs, msg] of [
    ["config set of the key fails", { "fail.set.OPENROUTER_API_KEY": true }, /could not write OPENROUTER_API_KEY/],
    ["native model selection fails", { "fail.set.model.default": true }, /could not apply model config/],
    // The retired log-scraping check ("gateway.*(ready|started)" / model name in `logs`) is replaced by the native readback:
    // `config get model.default|model.provider` must return exactly what was set. A failing readback fails closed.
    ["the native readback of the model fails", { "fail.get": true }, /could not read back the model config/],
  ]) {
    it(`${label}: rolled back`, async () => {
      await scenario({ name: "model-fail", seed: oldState, knobs, script: flow(), env: { ...base, FORCE: "1" } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assertStateIdentical(run);
      });
    });
  }

  // Each gateway failure also makes rollback's own reload fail (same knob): files restored, snapshot KEPT, non-zero exit, and a
  // retry after the fault is fixed recovers. The refusal because of live sessions is never overridden with -y.
  for (const [label, knobs, knob] of [
    ["gateway restart fails", { "fail.gateway.restart": true }, "fail.gateway.restart"],
    ["gateway never reports ready (ensure exit 5)", { ensure_exit: "5\n" }, "ensure_exit"],
    ["restart refused because of live sessions", { live_sessions: true }, "live_sessions"],
    ["restart exits 0 but the instance never changes", { restart_noop: true }, "restart_noop"],
  ]) {
    it(`${label}: files restored, snapshot kept, no recovery claim; retry after the fault recovers`, async () => {
      await scenario({ name: "model-gw", seed: oldState, knobs, script: flow(), env: { ...base, FORCE: "1" } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /FAIL: gateway did not restart ready/);
        assert.match(run.out, /files restored, but the gateway did NOT come back ready/);
        assert.ok(!run.out.includes("rollback: restored"));
        assertStateIdentical(run);
        assert.equal(run.sb.read(".hermes/.env"), oldState.env);
        assert.equal(run.sb.read(".hermes/config.yaml"), oldState.config);
        assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-model"));
        assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-model.prev"));
        assert.ok(!run.sb.hermesCalls().some((c) => c[0] === "-z"), "no inference test against a gateway that is not ready");
        assert.ok(!run.sb.hermesCalls().some((c) => c.some((x) => ["-y", "--yes", "--force", "--all", "--interrupt"].includes(x))));
        if (knob === "live_sessions") assert.match(run.out, /GW_INTERRUPT=1/);
        const retry = assemble([{ skill: SKILL, ids: ["step0#1"] }, `rm "$HSTACK_FAKE/knobs/${knob}"\nrollback || exit 1\necho RECOVERED\n`]);
        const recovered = await run.sb.run(retry, { env: { ...base, FORCE: "1" } });
        assert.equal(recovered.code, 0, recovered.out);
        assert.match(recovered.out, /RECOVERED/);
        assert.equal(run.sb.read(".hermes/.env"), oldState.env);
        assert.ok(run.sb.exists(".hermes/.hstack-backup/hermes-model.prev"));
      });
    });
  }

  it("a stored model that differs from the requested one (silent normalisation) is caught by the readback and rolled back", async () => {
    await scenario({
      name: "model-drift", seed: oldState, script: flow(), env: { ...base, FORCE: "1" },
      setup: (sb) => {
        const stub = sb.read(".local/bin/hermes");
        const changed = stub.replace('upsert_cfg "$key" "$val"', 'upsert_cfg "$key" "$val$([ "$key" = model.default ] && echo -drift)"');
        assert.notEqual(changed, stub, "the drift control must change the stub");
        sb.write(".local/bin/hermes", changed, 0o755);
      },
    }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /FAIL: stored model\/provider differ from what was set/);
      assert.match(run.out, /rollback: restored/);
      assertStateIdentical(run);
      assert.ok(!run.sb.hermesCalls().some((c) => c[0] === "-z"), "no inference test on a config that does not match the request");
    });
  });

  it("live sessions with GW_INTERRUPT=1: -y is passed only because the operator asked for it", async () => {
    await scenario({ name: "model-interrupt", knobs: { live_sessions: true }, script: flow(), env: { ...base, GW_INTERRUPT: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.sb.hermesCalls().some((c) => c.join(" ") === "gateway restart --detach -y"));
    });
  });

  it("-z exiting 2 (a failed turn, nothing on stdout) is not a pass even though no error text matches", async () => {
    await scenario({
      name: "model-exit2", seed: oldState, script: flow(), env: { ...base, FORCE: "1" },
      setup: (sb) => {
        const stub = sb.read(".local/bin/hermes");
        const changed = stub.replace("event -z; inject infer", "event -z; inject infer\n    exit 2");
        assert.notEqual(changed, stub);
        sb.write(".local/bin/hermes", changed, 0o755);
      },
    }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /could not confirm the key works/);
      assertStateIdentical(run);
    });
  });

  it("Step 1 is a version gate: a banner that does not name 0.22.5 aborts before any write", async () => {
    await scenario({
      name: "model-version", script: flow(), env: base,
      setup: (sb) => sb.write(".local/bin/hermes", sb.read(".local/bin/hermes").replace('echo "hermes 0.22.5"', 'echo "hermes 0.22.4"'), 0o755),
    }, async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: .*0\.22\.5 only \(got: hermes 0\.22\.4\)\. Nothing was written/);
      assert.deepEqual(writeEvents(run), []);
      assertStateIdentical(run);
    });
  });

  it("a leftover snapshot makes snapshot refuse and nothing is written", async () => {
    await scenario({ name: "model-left", seed: oldState, script: flow(), env: { ...base, FORCE: "1" }, setup: (sb) => sb.write(".hermes/.hstack-backup/hermes-model/.env", "junk\n") }, async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /did not finish/);
      assert.match(run.out, /ABORT: could not snapshot/);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
    });
  });
});

describe("hermes-model: skill text states what is verified and what is not", () => {
  const text = readFileSync(skillPath(SKILL), "utf8");
  it("has a 'Verified against Hermes v0.22.5' section citing the config writer, the provider registry and the -z path", () => {
    const m = /\n## Verified against Hermes v0\.22\.5\n([\s\S]*?)(\n## |\n---\n|$)/.exec(text);
    assert.ok(m, "missing section");
    for (const cite of [/hermes_cli\/config\.py:\d+/, /hermes_cli\/auth\.py:\d+/, /hermes_cli\/oneshot\.py:\d+/, /hermes_cli\/gateway_chat\.py:\d+/]) assert.match(m[1], cite);
    assert.match(m[1], /Unverified|not run against|source-verified/i);
  });
  it("carries no candidate / unpromoted framing, no retired gate, no Path A/B split", () => {
    assert.doesNotMatch(text, /candidate|unpromoted|CANDIDATE_ACKNOWLEDGED|HERMES_VERSION=0\.22\.5 explicit|Path B|apply_model_path/i);
  });
  it("documents the -z contract: only the final reply on stdout, exit 0 only for a completed turn, approvals auto-bypassed", () => {
    assert.match(text, /exit(s)? 0 only|only .*exit 0/i);
    assert.match(text, /auto-?bypass/i);
  });
});
