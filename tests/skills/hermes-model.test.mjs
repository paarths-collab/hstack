// hermes-model: provider key names, key transport, input validation, and rollback on a bad or
// inconclusive inference smoke test. The real SKILL.md blocks run against a simulated VPS.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, writeEvents } from "./helpers/asserts.mjs";
import { assemble } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";
import { fake } from "./helpers/tokens.mjs";

const SKILL = "hermes-model";
const FLOW = [
  "step1#1", "step1#2", "step2#1", "step3#1", "step4#1", "step4#2",
  "step5.pathA#1", "step5.pathB#1", "step5.pathB#2", "step6#1", "step7#1", "step8#1", "capability-check#1",
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
    it(`${p.name}: ${p.keyvar} + model.provider=${p.id}, key over stdin, never in argv/config/output`, async () => {
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
        assert.match(cfg, /^prompt_caching\.enabled: true$/m);
        assert.ok(!cfg.includes(p.key), "key in config.yaml");
        // the key travelled on stdin: the ssh command line carries the variable NAME, never the value
        assert.ok(run.sb.sshCalls().some((c) => c.includes(`hermes config set ${p.keyvar} "$v"`)));
        assertNoSecretInArgv(run, [p.key]);
        assertSecretsNotPrinted(run, [p.key]);
        const calls = run.sb.hermesCalls();
        assert.ok(calls.some((c) => c[0] === "setup" && c[1] === "--non-interactive"));
        assert.ok(!calls.some((c) => c.includes("--portal")), "--portal hangs a headless run");
        assert.ok(!calls.some((c) => c[0] === "gateway" && c[1] === "restart"));
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

  it("capability check reports vision/web/compression degraded when no OpenRouter key exists", async () => {
    const p = PROVIDERS[1];
    await scenario({ name: "model-cap", script: flow(), env: { MODEL_PROVIDER: p.name, MODEL_API_KEY: p.key, HERMES_MODEL: p.model } }, async (run) => {
      assert.match(run.out, /vision\s+: DEGRADED \(missing OPENROUTER_API_KEY\)/);
    });
    await scenario({ name: "model-cap2", script: flow(), env: base }, async (run) => {
      assert.match(run.out, /vision\s+: active/);
    });
  });

  it("Path A failing falls back to Path B, which rewrites the model: block and keeps the rest", async () => {
    const seed = { env: oldState.env, config: "model:\n  default: old/model\n  provider: openrouter\nother_setting: 1\n" };
    await scenario({ name: "model-pathb", seed, knobs: { "fail.set.model.provider": true }, script: flow(), env: { ...base, FORCE: "1" } }, async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /Path A failed; trying Path B/);
      const cfg = run.sb.read(".hermes/config.yaml");
      assert.ok(cfg.includes("other_setting: 1"));
      assert.match(cfg, /^model:\n  default: anthropic\/claude-sonnet-4\n  provider: openrouter$/m);
      assert.ok(!cfg.includes("old/model"));
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

  for (const [label, knobs, msg] of [
    ["config set of the key fails", { "fail.set.OPENROUTER_API_KEY": true }, /could not write OPENROUTER_API_KEY/],
    ["hermes setup fails in both paths", { "fail.setup": true }, /could not apply model config/],
    ["gateway run fails", { "fail.gateway.run": true }, /gateway did not start/],
    ["gateway never reports the model", { "fail.logs": true }, /did not report model in logs/],
  ]) {
    it(`${label}: rolled back`, async () => {
      await scenario({ name: "model-fail", seed: oldState, knobs, script: flow(), env: { ...base, FORCE: "1" } }, async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assertStateIdentical(run);
      });
    });
  }

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
