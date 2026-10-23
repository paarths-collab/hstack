import assert from "node:assert/strict";
import { it } from "node:test";
import { assemble } from "./helpers/blocks.mjs";
import { scenario } from "./helpers/sandbox.mjs";
import { assertStateIdentical } from "./helpers/asserts.mjs";

const candidate = { HERMES_VERSION: "0.22.5", CANDIDATE_ACKNOWLEDGED: "1" };
const seed = { env: "PUBLIC_FIXTURE=keep\n", config: "model.default: prior/model\n" };

for (const env of [{}, { HERMES_VERSION: "0.15.2", CANDIDATE_ACKNOWLEDGED: "1" }, { HERMES_VERSION: "0.22.5" }]) {
  it(`install refuses an unapproved candidate before contacting a target: ${JSON.stringify(env)}`, async () => {
    await scenario({ name: "candidate-optin", seed, env, script: assemble([{ skill: "hermes-install", ids: ["step0#1"] }]) }, async run => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT:/);
      assert.equal(run.sb.sshCalls().length, 0);
      assertStateIdentical(run);
    });
  });
}

it("fresh-install recipe refuses an existing launcher without uninstalling or mutating its user state", async () => {
  await scenario({ name: "install-existing", seed, env: candidate, script: assemble([{ skill: "hermes-install", ids: ["step0#1", "step1#1"] }]) }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /installation already exists/);
    assert.ok(run.sb.exists(".local/bin/hermes"));
    assertStateIdentical(run);
  });
});

for (const corrupt of [false, true]) {
  it(`installer ${corrupt ? "digest mismatch" : "download failure"} cannot execute a response or delete state`, async () => {
    await scenario({
      name: "installer-transport", seed, env: candidate,
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
  await scenario({ name: "update-native-refusal", seed, env: candidate, script: assemble([{ skill: "hermes-update", ids: ["step0#1", "step1#1"] }]), setup: sb => sb.write(".hermes/hermes-agent/.git/fixture", "present") }, async run => {
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
    assertStateIdentical(run);
  });
});

it("model setup refuses a legacy version before snapshot or credential writes", async () => {
  await scenario({ name: "model-legacy-boundary", seed, script: assemble([{ skill: "hermes-model", ids: ["step0#1", "step1#1"] }]), env: { MODEL_PROVIDER: "openai", MODEL_API_KEY: "public_fixture_key_long_enough", HERMES_MODEL: "example/model" }, setup: sb => sb.write(".local/bin/hermes", "#!/bin/bash\necho 'hermes 0.15.2'\n", 0o755) }, async run => {
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /candidate host installation not confirmed/);
    assert.ok(!run.sb.exists(".hermes/.hstack-backup/hermes-model"));
    assertStateIdentical(run);
  });
});

for (const id of ["confirm-ssh-access-before-doing-anything#1", "step0#1"]) {
  it(`candidate deploy rejects Slack before any remote call from ${id}`, async () => {
    await scenario({ name: "candidate-platform-boundary", seed, env: { ...candidate, PLATFORM: "slack", HOME_CHANNEL_ID: "C01234ABCDE", MODEL_PROVIDER: "openai", MODEL_API_KEY: "public_fixture_key_long_enough", HERMES_MODEL: "example/model" }, script: assemble([{ skill: "hermes-deploy", ids: [id] }]) }, async run => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /supports Telegram only/);
      assert.equal(run.sb.sshCalls().length, 0);
      assertStateIdentical(run);
    });
  });
}
