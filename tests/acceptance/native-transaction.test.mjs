// Exercises the real JS transaction and bundled Bash/Python adapter against an
// offline release-shaped CLI fixture. This is NOT a Hermes/Telegram runtime test.
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readTargetScript } from "../../packages/acceptance/artifacts.js";
import { loadContract, REPO_ROOT } from "../../packages/acceptance/contract.js";
import { sha256Hex, validateReceipt } from "../../packages/acceptance/receipt.js";
import { DEFAULT_SCRIPT_PATH, Transaction } from "../../packages/acceptance/transaction.js";
import { ALL_SECRET_STRINGS, FIXTURE_SKILLS, OPERATOR, SECRET_VALUES, Target, makeBlueprint, readAllReceiptText } from "./helpers/harness.mjs";

const contract = loadContract(path.join(REPO_ROOT, "acceptance/founder-brief-github-telegram.hermes-0.22.5.candidate.contract.json"));
const fixture = path.join(REPO_ROOT, "tests/acceptance/target/helpers/native-hermes-v0_22_5");
const commit = "bf0203a794a07aac3ff764972ab9087baa4e4f4e";
const jobs = (target) => {
  const file = path.join(target.hermesDir, "cron/jobs.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).jobs : [];
};

async function appliedNative(target, observer = null) {
  symlinkSync(fixture, path.join(target.home, ".local/bin/hermes"));
  const scriptPath = path.join(target.root, "reviewed-target.sh");
  const script = readTargetScript(DEFAULT_SCRIPT_PATH);
  writeFileSync(scriptPath, script);
  const transport = target.transport({ env: { HSTACK_NATIVE_COMMIT: commit, PYTHONDONTWRITEBYTECODE: "1" } });
  const tx = new Transaction({
    blueprint: makeBlueprint(), contract, operator: OPERATOR, transport, receiptDir: target.receipts,
    skillsRoot: FIXTURE_SKILLS, scriptPath, allowNonLinuxTarget: true, observer,
  });
  assert.equal((await tx.validate()).ok, true);
  assert.equal((await tx.inspect()).ok, true);
  assert.equal(tx.inspection.runtime_version, "0.22.5");
  const review = await tx.reviewChanges((review) => review.plan_hash);
  assert.equal(review.artifacts.script_sha256, sha256Hex(script), "review pins the bundled shell and Python bytes");
  assert.equal((await tx.stage(SECRET_VALUES)).ok, true);
  assert.equal((await tx.apply()).ok, true);
  assert.equal(jobs(target).length, 1);
  assert.equal(jobs(target)[0].deliver, "telegram");
  assert.deepEqual(jobs(target)[0].skills, contract.managed_skills);
  return tx;
}

test("candidate Transaction review through verify uses the native structured adapter and marks simulation honestly", async () => {
  const target = new Target({ hermes: false });
  let tx;
  let observations = 0;
  try {
    // Deliberately synthetic observation; no real message is sent or observed.
    const observer = { delivery: async () => {
      observations += 1;
      assert.equal(jobs(target).length, 1);
      return { deliveries: [{ to_fp: tx.destinationFingerprint, body_has_secret: false }] };
    } };
    tx = await appliedNative(target, observer);
    assert.equal((await tx.verify()).ok, true);
    assert.equal(tx.state, "verified");
    assert.equal(observations, 1);
    const receipt = tx.receipt;
    assert.equal(receipt.runtime_version, "0.22.5");
    assert.equal(receipt.target_profile.transport_used, "sandbox");
    assert.equal(receipt.target_profile.adapter_surface, "declared-unverified-against-real-hermes");
    assert.equal(validateReceipt(receipt, { requiredChecks: contract.required_checks }).valid, true);
    for (const secret of ALL_SECRET_STRINGS) assert.equal(readAllReceiptText(target.receipts).includes(secret), false);
    assert.ok(existsSync(path.join(target.statePath, "txn", tx.txnId, "done")));
    assert.ok(target.stubCalls().every((argv) => argv[0] === "--profile" && argv[1] === "default"));
    assert.equal(target.stubCalls().some((argv) => argv.includes("--daemon")), false);
  } finally { target.cleanup(); }
});

test("candidate Transaction rollback restores its native cron and env changes through the public CLI fixture", async () => {
  const target = new Target({ hermes: false });
  try {
    const originalEnv = target.env();
    const originalConfig = readFileSync(path.join(target.hermesDir, "config.yaml"), "utf8");
    const originalUnrelatedCron = target.cron();
    const tx = await appliedNative(target);
    assert.equal((await tx.rollback()).ok, true);
    assert.equal(tx.state, "restored_verified");
    assert.equal(target.env(), originalEnv);
    assert.equal(readFileSync(path.join(target.hermesDir, "config.yaml"), "utf8"), originalConfig);
    assert.equal(target.cron(), originalUnrelatedCron);
    assert.deepEqual(jobs(target), []);
    assert.equal(tx.receipt.recovery.restoration_verified, true);
    assert.equal(validateReceipt(tx.receipt, { requiredChecks: contract.required_checks }).valid, true);
  } finally { target.cleanup(); }
});
