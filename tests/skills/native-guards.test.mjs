// Guards that fire before a target is contacted or any user state changes. v0.22.5 is the ONLY supported target (there is no opt-in, no
// CANDIDATE_ACKNOWLEDGED): the refusals are a HERMES_VERSION other than 0.22.5, an installed version banner other than 0.22.5, an existing
// installation, a download that fails its pinned digest, and a platform recipe that has not been re-verified yet.
import assert from "node:assert/strict";
import { it } from "node:test";
import { assemble } from "./helpers/blocks.mjs";
import { scenario } from "./helpers/sandbox.mjs";
import { assertStateIdentical } from "./helpers/asserts.mjs";

const target = { HERMES_VERSION: "0.22.5" };
const seed = { env: "PUBLIC_FIXTURE=keep\n", config: "model.default: prior/model\n" };

for (const skill of ["hermes-install", "hermes-update", "hermes-memory"]) {
  for (const v of ["0.15.2", "0.23.0", "10.22.5", "0.22.5-rc1"]) {
    it(`${skill} refuses HERMES_VERSION=${v} before contacting a target`, async () => {
      await scenario({ name: "version-refusal", seed, env: { HERMES_VERSION: v }, script: assemble([{ skill, ids: ["step0#1"] }]) }, async run => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /ABORT:.*0\.22\.5/);
        assert.equal(run.sb.sshCalls().length, 0);
        assertStateIdentical(run);
      });
    });
  }
}

it("deploy refuses HERMES_VERSION other than 0.22.5 before any remote call (the opt-in variable no longer exists)", async () => {
  const env = { HERMES_VERSION: "0.15.2", PLATFORM: "telegram", HOME_CHANNEL_ID: "555", MODEL_PROVIDER: "openai", MODEL_API_KEY: "public_fixture_key_long_enough", HERMES_MODEL: "example/model" };
  await scenario({ name: "deploy-version", seed, env, script: assemble([{ skill: "hermes-deploy", ids: ["step0#1"] }]) }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /HERMES_VERSION must be 0\.22\.5/);
    assert.equal(run.sb.sshCalls().length, 0);
    assertStateIdentical(run);
  });
});

it("an update recipe refuses an installed version banner other than 0.22.5 before asking for a plan", async () => {
  await scenario({
    name: "update-banner", seed, env: target, script: assemble([{ skill: "hermes-update", ids: ["step0#1", "step1#1"] }]),
    setup: sb => { sb.write(".hermes/hermes-agent/.git/fixture", "present"); sb.write("hermes.version", "Hermes Agent v0.21.6 (2026.9.1)\n"); },
  }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /FROM Hermes 0\.22\.5/);
    assert.ok(!run.sb.hermesCalls().some(c => c[0] === "update"));
    assertStateIdentical(run);
  });
});

it("the memory recipe refuses an installed version banner other than 0.22.5 before reading memory status", async () => {
  await scenario({ name: "memory-banner", seed, env: target, script: assemble([{ skill: "hermes-memory", ids: ["step0#1", "step1#1"] }]), files: { "hermes.version": "hermes 0.15.2\n" } }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /ABORT:.*0\.22\.5/);
    assert.deepEqual(run.sb.hermesCalls().map(c => c.join(" ")), ["--version"]);
    assertStateIdentical(run);
  });
});

it("deploy refuses an installed version banner other than 0.22.5 before the first snapshot", async () => {
  const env = { ...target, PLATFORM: "telegram", HOME_CHANNEL_ID: "555", MODEL_PROVIDER: "openai", MODEL_API_KEY: "public_fixture_key_long_enough", HERMES_MODEL: "example/model" };
  await scenario({ name: "deploy-banner", seed, env, script: assemble([{ skill: "hermes-deploy", ids: ["step0#1", "step4#1"] }]), files: { "hermes.version": "hermes 0.15.2\n" } }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /ABORT: Hermes 0\.22\.5 is not installed/);
    assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
    assertStateIdentical(run);
  });
});

it("fresh-install recipe refuses an existing launcher without uninstalling or mutating its user state", async () => {
  await scenario({ name: "install-existing", seed, env: target, script: assemble([{ skill: "hermes-install", ids: ["step0#1", "step1#1"] }]) }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /installation already exists/);
    assert.ok(run.sb.exists(".local/bin/hermes"));
    assertStateIdentical(run);
  });
});

for (const corrupt of [false, true]) {
  it(`installer ${corrupt ? "digest mismatch" : "download failure"} cannot execute a response or delete state`, async () => {
    await scenario({
      name: "installer-transport", seed, env: target,
      script: assemble([{ skill: "hermes-install", ids: ["step0#1", "step3#1"] }]),
      setup: sb => sb.write("remote_bin/curl", corrupt ? `#!/bin/bash
while [ $# -gt 0 ]; do
  if [ "$1" = -o ]; then shift; printf 'touch "$HOME/installer-executed"\n' > "$1"; exit 0; fi
  shift
done
exit 1
` : "#!/bin/bash\nexit 22\n", 0o755),
    }, async run => {
      assert.equal(run.code, 1, run.out);
      assert.ok(!run.sb.exists("installer-executed"));
      assert.ok(run.sb.exists(".local/bin/hermes"));
      assertStateIdentical(run);
    });
  });
}

it("native updater inspection failure does not fall back to pip, installation, or a fabricated rollback", async () => {
  // v0.22.5 supports `update --plan` / `--check`; the failure is injected (the check cannot fetch: update_cmd.py:682-690 exits 1).
  await scenario({ name: "update-native-refusal", seed, env: target, knobs: { "fail.update.check": true }, script: assemble([{ skill: "hermes-update", ids: ["step0#1", "step1#1"] }]), setup: sb => sb.write(".hermes/hermes-agent/.git/fixture", "present") }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /native updater inspection failed/);
    assert.ok(!run.out.includes("Rolled back"));
    assertStateIdentical(run);
  });
});

it("memory provider selection rejects injected identifiers before contacting a target", async () => {
  await scenario({ name: "memory-local-gate", seed, env: { MODE: "external", PROVIDER: "mem0; touch pwned" }, script: assemble([{ skill: "hermes-memory", ids: ["step0#1"] }]) }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.equal(run.sb.sshCalls().length, 0);
    assert.ok(!run.sb.exists("pwned"));
    assertStateIdentical(run);
  });
});

it("model setup refuses a legacy version before snapshot or credential writes", async () => {
  await scenario({ name: "model-legacy-boundary", seed, script: assemble([{ skill: "hermes-model", ids: ["step0#1", "step1#1"] }]), env: { MODEL_PROVIDER: "openai", MODEL_API_KEY: "public_fixture_key_long_enough", HERMES_MODEL: "example/model" }, setup: sb => sb.write(".local/bin/hermes", "#!/bin/bash\necho 'hermes 0.15.2'\n", 0o755) }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /ABORT:/);
    assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-model"));
    assertStateIdentical(run);
  });
});

for (const id of ["confirm-ssh-access-before-doing-anything#1", "step0#1"]) {
  it(`deploy rejects Slack before any remote call from ${id} and says the other platforms are being re-verified`, async () => {
    await scenario({ name: "deploy-platform-boundary", seed, env: { ...target, PLATFORM: "slack", HOME_CHANNEL_ID: "C01234ABCDE", MODEL_PROVIDER: "openai", MODEL_API_KEY: "public_fixture_key_long_enough", HERMES_MODEL: "example/model" }, script: assemble([{ skill: "hermes-deploy", ids: [id] }]) }, async run => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /supports Telegram only/);
      assert.match(run.out, /re-verified/);
      assert.equal(run.sb.sshCalls().length, 0);
      assertStateIdentical(run);
    });
  });
}
