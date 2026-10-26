// Runtime-version and transport gating of the acceptance transaction (offline; canned target answers).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readTargetScript } from "../../packages/acceptance/artifacts.js";
import { RecordingTransport } from "../../packages/acceptance/transports.js";
import { DEFAULT_SCRIPT_PATH, Transaction, TransactionError } from "../../packages/acceptance/transaction.js";
import { cannedResponder } from "./helpers/canned.mjs";
import { FIXTURE_SKILLS, OPERATOR, SECRET_VALUES, contract, fixedClock, makeBlueprint } from "./helpers/harness.mjs";

const inspectAnswering = (runtimeVersion) => cannedResponder({ scriptBody: "", txn: "x", overrides: {
  inspect: { stdout: `op=inspect\nhermes_present=1\nruntime_version=${runtimeVersion}\nruntime_evidence=measured\nos=linux\nservice_manager=systemd\nenv_keys=\ncron_managed_ids=\nskills_unmanaged=\nskills_managed=\nskills_managed_modified=\ntxn_incomplete=\n` },
} });

async function inspectWith(runtimeVersion) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hstack-gating-"));
  try {
    const tx = new Transaction({
      blueprint: makeBlueprint(), contract, operator: OPERATOR, transport: new RecordingTransport({ respond: inspectAnswering(runtimeVersion) }),
      receiptDir: dir, skillsRoot: FIXTURE_SKILLS, allowNonLinuxTarget: true,
    });
    assert.equal((await tx.validate()).ok, true);
    const result = await tx.inspect();
    return { result, receipt: tx.receipt, state: tx.state };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the exactly supported runtime version passes inspect", async () => {
  const { result, receipt } = await inspectWith(contract.runtime.declared_version);
  assert.equal(result.ok, true);
  assert.equal(receipt.runtime_version, contract.runtime.declared_version);
});

test("a supported x.y.z with any suffix is a runtime_version_mismatch, recorded verbatim (the shell side also reports it verbatim)", async () => {
  const base = contract.runtime.declared_version;
  for (const observed of [`${base}.1`, `${base}.dev3`, `${base}-rc1`, `${base}+local`, `${base}.0.1`]) {
    const { result, receipt, state } = await inspectWith(observed);
    assert.equal(result.ok, false, observed);
    assert.equal(receipt.blocked_reason, "runtime_version_mismatch", observed);
    assert.equal(receipt.runtime_version, observed, `the observed string is recorded verbatim: ${observed}`);
    assert.equal(state, "validated", observed);
  }
});

test("an observed version that cannot be recorded faithfully is unknown (blocked), never truncated to a supported x.y.z", async () => {
  const base = contract.runtime.declared_version;
  for (const observed of [`v${base}`, `${base} (build)`, `x${base}`, `${base}.${"a".repeat(40)}`, "banana"]) {
    const { result, receipt } = await inspectWith(observed);
    assert.equal(result.ok, false, observed);
    assert.equal(receipt.runtime_version, "unknown", observed);
    assert.equal(receipt.blocked_reason, "runtime_unknown", observed);
  }
});

// ---- resume must run on the transport the receipt claims ------------------------------------------------

test("resume refuses a transport whose kind differs from the receipt's transport_used, and accepts the same kind", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hstack-resume-kind-"));
  try {
    const scriptBody = readTargetScript(DEFAULT_SCRIPT_PATH);
    const txn = "abcdef123456";
    const respond = cannedResponder({ scriptBody, txn });
    // A stand-in that claims to be ssh; every answer is canned, nothing is executed.
    const claimsSsh = { kind: "ssh", exec: async (op) => ({ code: 0, stdout: "", stderr: "", transportError: false, ...(await respond(op)) }) };
    const options = { blueprint: makeBlueprint(), contract, operator: OPERATOR, receiptDir: dir, skillsRoot: FIXTURE_SKILLS, txnId: txn, now: fixedClock(), allowNonLinuxTarget: true };
    const tx = new Transaction({ ...options, transport: claimsSsh });
    await tx.validate(); await tx.inspect(); await tx.reviewChanges((review) => review.plan_hash); await tx.stage(SECRET_VALUES); await tx.apply();
    assert.equal(tx.state, "applied_unverified");
    assert.equal(tx.receipt.target_profile.transport_used, "ssh");
    const receiptFile = path.join(dir, txn, "receipt.json");

    const recording = new RecordingTransport({ respond });
    assert.throws(() => Transaction.resume({ receiptFile, ...options, transport: recording }),
      (error) => error instanceof TransactionError && error.code === "resume_transport_mismatch" && /ssh/.test(error.message) && /recording/.test(error.message));
    assert.equal(recording.calls.length, 0, "nothing ran on the mismatching transport");

    const again = Transaction.resume({ receiptFile, ...options, transport: claimsSsh });
    assert.equal(again.state, "applied_unverified");
    assert.equal(again.receipt.target_profile.transport_used, "ssh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
