// Review-driven hardening: artifact pinning (TOCTOU between review and stage/apply), the write-ahead guard,
// strict rollback confirmation, gateway reload after restore, abandon/resume of pre-apply transactions.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

import { opApply, opReload, opRestore, opSkillsSync } from "../../packages/acceptance/ops.js";
import { sha256Hex } from "../../packages/acceptance/receipt.js";
import { IllegalTransition } from "../../packages/acceptance/states.js";
import { RecordingTransport } from "../../packages/acceptance/transports.js";
import { EXEC_FOR_TESTS, Transaction, TransactionError } from "../../packages/acceptance/transaction.js";
import { cannedResponder } from "./helpers/canned.mjs";
import {
  FAKE, FIXTURE_SKILLS, OPERATOR, SCRIPT_SKIP, SECRET_VALUES, Target, assertReceiptClean, contract, driveToApplied, filesContaining,
  fingerprint, losingTransport, makeBlueprint, newTransaction, readAllReceiptText, userStateHash,
} from "./helpers/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SCRIPT_PATH = path.join(here, "fixtures", "target-script-fixture.sh");
const TXN = "harden000001";
const check = (receipt, id) => receipt.checks.find((c) => c.id === id);

/** A recorded (canned) transaction with its OWN copies of the script and the skills, so tests can edit them. */
function recorded({ overrides = {}, observer = null, contract: suppliedContract = contract } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hstack-harden-"));
  const scriptPath = path.join(dir, "target.sh");
  cpSync(FIXTURE_SCRIPT_PATH, scriptPath);
  const skillsRoot = path.join(dir, "skills");
  cpSync(FIXTURE_SKILLS, skillsRoot, { recursive: true });
  const receiptDir = path.join(dir, "receipts");
  const scriptBody = () => readFileSync(scriptPath, "utf8");
  const recording = new RecordingTransport({ respond: (op, i) => cannedResponder({ scriptBody: scriptBody(), txn: TXN, overrides })(op, i) });
  const options = { blueprint: makeBlueprint(), contract: suppliedContract, operator: OPERATOR, transport: recording, receiptDir, txnId: TXN, skillsRoot, scriptPath, observer };
  return { dir, scriptPath, skillsRoot, receiptDir, recording, options, tx: new Transaction(options), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function toReviewed(r) {
  assert.equal((await r.tx.validate()).ok, true);
  assert.equal((await r.tx.inspect()).ok, true);
  return r.tx.reviewChanges((review) => review.plan_hash);
}
async function toApplied(r) {
  await toReviewed(r);
  assert.equal((await r.tx.stage(SECRET_VALUES)).ok, true);
  assert.equal((await r.tx.apply()).ok, true);
}
const liveCalls = (r) => r.recording.calls.filter((c) => c.mutates === "live").map((c) => c.op);

test("a caller's nested contract edits cannot change approved commands or verification requirements", async () => {
  const mutable = structuredClone(contract);
  const observer = { delivery: async () => ({ deliveries: [{ to_fp: fingerprint(OPERATOR.chatId), body_has_secret: false }] }) };
  const r = recorded({ contract: mutable, observer });
  try {
    const review = await toReviewed(r);
    mutable.schedule.prompt = "An unreviewed changed prompt";
    mutable.required_checks.splice(0);
    mutable.runtime.supported_versions.splice(0);
    await r.tx.stage(SECRET_VALUES);
    assert.equal((await r.tx.apply()).ok, true);
    const approvedApply = review.ops.find((op) => op.op === "apply");
    const actualApply = r.recording.calls.find((op) => op.op === "apply");
    assert.equal(actualApply.remote, approvedApply.remote, "the exact approved prompt is executed");
    assert.equal((await r.tx.verify()).ok, true, "verification retains the original supported version and checks");
    assert.equal(check(r.tx.receipt, "runtime-version").status, "pass");
    assertReceiptClean(assert, { receipts: r.receiptDir }, r.tx);
  } finally { r.cleanup(); }
});

test("apply requires an explicit reload confirmation before it can be verified", async () => {
  for (const stdout of ["", "reloaded=0\n"]) {
    const r = recorded({ overrides: { reload: { stdout } } });
    try {
      await toReviewed(r);
      await r.tx.stage(SECRET_VALUES);
      const outcome = await r.tx.apply();
      assert.equal(outcome.ok, false);
      assert.equal(outcome.failed_op, "reload");
      assert.equal(r.tx.state, "rollback_required");
      assert.equal(r.tx.receipt.apply.completed, false);
      assert.equal(r.tx.receipt.apply.ops.find((op) => op.op_id === "gateway:reload").status, "unknown");
      await assert.rejects(() => r.tx.verify(), IllegalTransition);
      assert.equal(r.recording.calls.some((op) => op.op === "commit"), false);
    } finally { r.cleanup(); }
  }
});

test("a missing commit acknowledgement stays unverified and a confirmed retry can finish", async () => {
  for (const stdout of ["", "committed=0\n"]) {
    const observer = { delivery: async () => ({ deliveries: [{ to_fp: fingerprint(OPERATOR.chatId), body_has_secret: false }] }) };
    const r = recorded({ overrides: { commit: { stdout } }, observer });
    try {
      await toApplied(r);
      const outcome = await r.tx.verify();
      assert.equal(outcome.ok, false);
      assert.deepEqual(outcome.unresolved, ["commit"]);
      assert.equal(r.tx.state, "applied_unverified");
      assert.equal(check(r.tx.receipt, "commit").status, "unknown");
      r.recording.respond = cannedResponder({ scriptBody: readFileSync(r.scriptPath, "utf8"), txn: TXN });
      assert.equal((await r.tx.verify()).ok, true);
      assert.equal(r.recording.calls.filter((op) => op.op === "commit").length, 2);
      assert.equal(check(r.tx.receipt, "commit").status, "pass");
    } finally { r.cleanup(); }
  }
});

// ---- F1: what was reviewed is what runs ---------------------------------------------------------

test("the review pins the helper script and the skills archive; the receipt records them for ALL managed skills", async () => {
  const r = recorded();
  try {
    const review = await toReviewed(r);
    const script = readFileSync(r.scriptPath, "utf8");
    assert.equal(review.artifacts.script_sha256, sha256Hex(script));
    assert.match(review.artifacts.skills_tar_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(review.artifacts.skills.map((s) => s.name), contract.managed_skills);
    const receipt = assertReceiptClean(assert, { receipts: r.receiptDir }, r.tx);
    assert.deepEqual(receipt.artifacts, review.artifacts);
    assert.equal(new Set(receipt.artifacts.skills.map((s) => s.sha256)).size, contract.managed_skills.length, "each skill has its own digest");
    // the tar digest shown as redacted stdin in the review is the same digest the receipt pins
    assert.ok(review.ops.find((o) => o.op_id === "skills:sync").stdin.includes(review.artifacts.skills_tar_sha256));
    assert.ok(review.ops.find((o) => o.op_id === "helper:install").stdin.includes(review.artifacts.script_sha256));
  } finally { r.cleanup(); }
});

test("TOCTOU: a script edited after approval is refused at stage, with nothing sent to the target", async () => {
  const r = recorded();
  try {
    await toReviewed(r);
    const callsBefore = r.recording.calls.length;
    writeFileSync(r.scriptPath, `${readFileSync(r.scriptPath, "utf8")}\n# edited after review\n`);
    await assert.rejects(() => r.tx.stage(SECRET_VALUES), (error) => {
      assert.ok(error instanceof TransactionError);
      assert.equal(error.code, "artifact_changed");
      assert.match(error.message, /target script changed after it was reviewed/);
      assert.match(error.message, /nothing was changed on the target/);
      return true;
    });
    assert.equal(r.recording.calls.length, callsBefore, "not a single op was sent");
    assert.equal(r.tx.state, "change_reviewed");
    assert.equal(r.tx.receipt.changes_applied, false);
  } finally { r.cleanup(); }
});

test("TOCTOU: a skill edited after approval is refused at apply, before write-ahead and before any live op", async () => {
  const r = recorded();
  try {
    await toReviewed(r);
    assert.equal((await r.tx.stage(SECRET_VALUES)).ok, true);
    writeFileSync(path.join(r.skillsRoot, "hermes-cron", "SKILL.md"), "# edited after the operator approved the plan\n");
    await assert.rejects(() => r.tx.apply(), (error) => {
      assert.equal(error.code, "artifact_changed");
      assert.match(error.message, /managed skill\(s\) hermes-cron changed after it was reviewed/);
      return true;
    });
    assert.deepEqual(liveCalls(r), [], "no live op ran");
    assert.equal(r.tx.state, "staged");
    assert.equal(r.tx.receipt.changes_applied, false);
    assert.equal(r.tx.receipt.apply.started, false, "write-ahead was not persisted for an apply that never began");
    // restoring the reviewed content makes the very same transaction applicable again
    cpSync(path.join(FIXTURE_SKILLS, "hermes-cron", "SKILL.md"), path.join(r.skillsRoot, "hermes-cron", "SKILL.md"));
    assert.equal((await r.tx.apply()).ok, true);
  } finally { r.cleanup(); }
});

test("an added or removed skill file also changes the pinned archive", async () => {
  const r = recorded();
  try {
    await toReviewed(r);
    await r.tx.stage(SECRET_VALUES);
    writeFileSync(path.join(r.skillsRoot, "hermes-home", "extra.sh"), "echo injected\n");
    await assert.rejects(() => r.tx.apply(), /managed skill\(s\) hermes-home changed/);
    assert.deepEqual(liveCalls(r), []);
  } finally { r.cleanup(); }
});

test("a resumed transaction keeps enforcing the digests recorded in the receipt", async () => {
  const r = recorded();
  try {
    await toReviewed(r);
    await r.tx.stage(SECRET_VALUES); // ... and the process dies here
    writeFileSync(path.join(r.skillsRoot, "integration-github", "SKILL.md"), "# swapped while the process was down\n");
    const resumed = Transaction.resume({ receiptFile: r.tx.receiptPath, ...r.options });
    assert.equal(resumed.state, "staged");
    await assert.rejects(() => resumed.apply(), /integration-github changed after it was reviewed/);
    assert.deepEqual(liveCalls(r), []);
  } finally { r.cleanup(); }
});

// ---- F5(a): the write-ahead guard itself ---------------------------------------------------------

test("a live op is refused unless the write-ahead receipt is on disk (guard exercised in every pre-apply state)", async () => {
  const r = recorded();
  try {
    const live = [
      opRestore({ txn: TXN }), opReload({ txn: TXN }),
      opApply({ txn: TXN, cron: { id: "founder-brief", schedule: "0 8 * * 1-5", prompt: contract.schedule.prompt } }),
      opSkillsSync({ txn: TXN, names: ["hermes-home"], tar: Buffer.from("x") }),
    ];
    for (const op of live) await assert.rejects(() => r.tx[EXEC_FOR_TESTS](op), (e) => e.code === "write_ahead_violation", `${op.op} @ start`);
    await toReviewed(r);
    for (const op of live) await assert.rejects(() => r.tx[EXEC_FOR_TESTS](op), (e) => e.code === "write_ahead_violation", `${op.op} @ change_reviewed`);
    await r.tx.stage(SECRET_VALUES);
    for (const op of live) await assert.rejects(() => r.tx[EXEC_FOR_TESTS](op), (e) => e.code === "write_ahead_violation", `${op.op} @ staged`);
    assert.deepEqual(liveCalls(r), [], "the refused ops never reached the transport");
    assert.equal(r.tx.state, "staged");
  } finally { r.cleanup(); }
});

// ---- F5(b)+F10: rollback needs explicit confirmation, then reloads the gateway ----------------------

async function rolledBack(overrides) {
  const r = recorded({ overrides });
  try {
    await toApplied(r);
    const outcome = await r.tx.rollback();
    const text = readAllReceiptText(r.receiptDir);
    for (const s of [FAKE.github, FAKE.bot, FAKE.chat]) assert.equal(text.includes(s), false);
    return { r, outcome, receipt: r.tx.receipt, calls: r.recording.calls.map((c) => c.op), state: r.tx.state };
  } finally { r.cleanup(); }
}

test("restore exit 0 WITHOUT restore_verified=1 is not a verified restoration", async () => {
  const { state, receipt, calls } = await rolledBack({ restore: { stdout: "restored=1\n" } });
  assert.equal(state, "manual_recovery_required");
  assert.equal(check(receipt, "restoration").status, "fail");
  assert.match(check(receipt, "restoration").detail, /restore exited 0/);
  assert.equal(receipt.recovery.restoration_verified, false);
  assert.equal(calls.filter((op) => op === "reload").length, 1, "no reload after an unconfirmed restore (only the apply-time reload)");
});

test("restore reporting already_restored=1 is not re-verified in this run => manual_recovery_required", async () => {
  const { state, receipt } = await rolledBack({ restore: { stdout: "already_restored=1\n" } });
  assert.equal(state, "manual_recovery_required");
  assert.equal(check(receipt, "restoration").status, "unknown");
  assert.match(check(receipt, "restoration").detail, /not re-verified/);
});

test("restore_verified=1 with a non-zero exit is still a failure", async () => {
  const { state } = await rolledBack({ restore: { code: 1, stdout: "restore_verified=1\nerror=restore_failed\n" } });
  assert.equal(state, "manual_recovery_required");
});

test("a verified restore is followed by a gateway reload, recorded as gateway-reloaded, before restored_verified", async () => {
  const { state, receipt, calls } = await rolledBack({});
  assert.equal(state, "restored_verified");
  assert.deepEqual(calls.slice(-2), ["restore", "reload"], "reload comes after the restore");
  assert.equal(check(receipt, "restoration").status, "pass");
  assert.equal(check(receipt, "gateway-reloaded").status, "pass");
  assert.equal(receipt.recovery.restoration_verified, true);
});

test("files restored but the gateway reload failed => manual_recovery_required with that detail (never restored_verified)", async () => {
  for (const [name, reload, status] of [
    ["non-zero exit", { code: 1, stdout: "error=gateway_restart_failed\n" }, "fail"],
    ["exit 0 without reloaded=1", { stdout: "something=else\n" }, "fail"],
    ["unknown outcome", { transportError: true }, "unknown"],
  ]) {
    // The apply-time reload must succeed; only the second reload (after the restore) fails.
    let reloads = 0;
    const r = recorded();
    try {
      const canned = cannedResponder({ scriptBody: readFileSync(r.scriptPath, "utf8"), txn: TXN });
      r.recording.respond = (op, i) => {
        if (op.op === "reload" && (reloads += 1) === 2) return reload;
        return canned(op, i);
      };
      await toApplied(r);
      const outcome = await r.tx.rollback();
      const receipt = r.tx.receipt;
      assert.equal(outcome.ok, false, name);
      assert.equal(r.tx.state, "manual_recovery_required", name);
      assert.equal(check(receipt, "restoration").status, "pass", `${name}: the files really were restored and verified`);
      assert.equal(check(receipt, "gateway-reloaded").status, status, name);
      assert.match(check(receipt, "gateway-reloaded").detail, /running gateway may still hold the new environment/);
      assert.equal(receipt.recovery.restoration_verified, false);
      assertReceiptClean(assert, { receipts: r.receiptDir }, r.tx);
    } finally { r.cleanup(); }
  }
});

// ---- F9: crash between stage and apply ------------------------------------------------------------

test("abandon() after a crash between stage and apply: restore-cleanup on the target, state unchanged, blocked_reason abandoned", async () => {
  const r = recorded();
  try {
    await toReviewed(r);
    await r.tx.stage(SECRET_VALUES); // crash: the process is gone, only the receipt on disk remains
    const resumed = Transaction.resume({ receiptFile: r.tx.receiptPath, ...r.options });
    assert.equal(resumed.state, "staged");
    const outcome = await resumed.abandon();
    assert.equal(outcome.ok, true);
    assert.equal(outcome.blocked_reason, "abandoned");
    assert.match(outcome.manual_command, /hstack-target-[0-9a-f]{64}\.sh restore 'harden000001'.*purge 'harden000001'/, "the exact manual recovery commands are reported");
    assert.equal(resumed.state, "staged", "state is unchanged");
    const receipt = assertReceiptClean(assert, { receipts: r.receiptDir }, resumed);
    assert.equal(receipt.blocked_reason, "abandoned");
    assert.equal(receipt.changes_applied, false);
    assert.equal(receipt.apply.started, false);
    assert.equal(check(receipt, "abandon").status, "pass");
    const ops = r.recording.calls.map((c) => c.op);
    assert.equal(ops.at(-1), "restore", "the target-side pre-apply restore ran");
    assert.equal(liveCalls(r).length, 1, "and it is the only live op: nothing was applied");
    // an abandoned transaction is dead
    for (const call of [() => resumed.apply(), () => resumed.stage(SECRET_VALUES), () => resumed.abandon(), () => resumed.verify(), () => resumed.rollback()]) {
      await assert.rejects(call, IllegalTransition);
    }
  } finally { r.cleanup(); }
});

test("abandon() whose cleanup cannot be confirmed does not claim success and reports the manual command", async () => {
  const r = recorded({ overrides: { restore: { code: 1, stdout: "error=backup_missing\n" } } });
  try {
    await toReviewed(r);
    await r.tx.stage(SECRET_VALUES);
    const outcome = await r.tx.abandon();
    assert.equal(outcome.ok, false);
    assert.match(outcome.manual_command, /restore/);
    assert.equal(r.tx.receipt.blocked_reason, null);
    assert.equal(check(r.tx.receipt, "abandon").status, "fail");
    assert.equal(r.tx.state, "staged");
  } finally { r.cleanup(); }
});

test("a crash between review and stage can be abandoned without touching the target", async () => {
  const r = recorded();
  try {
    await toReviewed(r); // crash before stage()
    const before = r.recording.calls.length;
    const resumed = Transaction.resume({ receiptFile: r.tx.receiptPath, ...r.options });
    assert.equal(resumed.state, "change_reviewed");
    const outcome = await resumed.abandon();
    assert.equal(outcome.ok, true);
    assert.equal(r.recording.calls.length, before, "no recovery point existed, so nothing is sent");
    assert.equal(resumed.receipt.blocked_reason, "abandoned");
  } finally { r.cleanup(); }
});

test("backup intent is persisted before dispatch, so resume reconciles a lost backup reply", async () => {
  const r = recorded();
  try {
    await toReviewed(r);
    let persistedAtDispatch;
    r.recording.onExec = (op) => {
      if (op.op !== "backup") return;
      persistedAtDispatch = JSON.parse(readFileSync(r.tx.receiptPath, "utf8"));
      throw new Error("connection lost after dispatch");
    };
    await assert.rejects(() => r.tx.stage(SECRET_VALUES), { name: "TransportError" });
    assert.equal(persistedAtDispatch.state, "change_reviewed");
    assert.equal(persistedAtDispatch.recovery.backup_ref, `bk_${TXN}`);
    assert.equal(check(persistedAtDispatch, "backup-create").status, "unknown");
    const resumed = Transaction.resume({ receiptFile: r.tx.receiptPath, ...r.options });
    await assert.rejects(() => resumed.stage(SECRET_VALUES), (e) => e.code === "stage_already_started");
    assert.equal((await resumed.abandon()).ok, true);
    assert.equal(r.recording.calls.at(-1).op, "restore", "the unacknowledged backup is reconciled on the target");
    assert.equal(check(resumed.receipt, "abandon").status, "pass");
  } finally { r.cleanup(); }
});

test("missing backup after an unknown outcome is not proof that a delayed backup cannot still publish", async () => {
  const r = recorded({ overrides: {
    backup: { transportError: true }, restore: { code: 1, stdout: "error=backup_missing\n" },
  } });
  try {
    await toReviewed(r);
    await assert.rejects(() => r.tx.stage(SECRET_VALUES), { name: "TransportError" });
    const resumed = Transaction.resume({ receiptFile: r.tx.receiptPath, ...r.options });
    assert.equal((await resumed.abandon()).ok, false);
    assert.equal(resumed.receipt.blocked_reason, null);
    assert.equal(check(resumed.receipt, "abandon").status, "fail");
  } finally { r.cleanup(); }
});

test("legacy null-ref receipts reconcile on the target instead of assuming backup was never requested", async () => {
  const r = recorded();
  try {
    await toReviewed(r);
    const legacy = r.tx.receipt;
    legacy.checks = legacy.checks.filter((entry) => entry.id !== "backup-create");
    assert.equal(legacy.recovery.backup_ref, null);
    const resumed = Transaction.resume({ receipt: legacy, ...r.options });
    const before = r.recording.calls.length;
    assert.equal((await resumed.abandon()).ok, true);
    assert.deepEqual(r.recording.calls.slice(before).map((op) => op.op), ["helper-verify", "restore"]);
  } finally { r.cleanup(); }
});

test("abandon does not accept exit zero without a cleanup confirmation", async () => {
  const r = recorded({ overrides: { restore: { stdout: "something=else\n" } } });
  try {
    await toReviewed(r);
    await r.tx.stage(SECRET_VALUES);
    assert.equal((await r.tx.abandon()).ok, false);
    assert.equal(r.tx.receipt.blocked_reason, null);
    assert.equal(check(r.tx.receipt, "abandon").status, "fail");
  } finally { r.cleanup(); }
});

test("a definite backup refusal does not make abandon restore an older target transaction", async () => {
  const r = recorded({ overrides: { backup: { code: 2, stdout: "error=txn_exists\n" } } });
  try {
    await toReviewed(r);
    assert.equal((await r.tx.stage(SECRET_VALUES)).ok, false);
    assert.equal(r.tx.receipt.recovery.backup_ref, null);
    const before = r.recording.calls.length;
    assert.equal((await r.tx.abandon()).ok, true);
    assert.equal(r.recording.calls.length, before);
  } finally { r.cleanup(); }
});

test("abandon() is only legal before apply, and resume refuses other states", async () => {
  const r = recorded();
  try {
    await assert.rejects(() => r.tx.abandon(), IllegalTransition);
    await toApplied(r);
    await assert.rejects(() => r.tx.abandon(), IllegalTransition, "after apply only verify/rollback exist");
  } finally { r.cleanup(); }
});

test("stage() on a resumed change_reviewed transaction that already took a recovery point is refused (abandon it)", async () => {
  const r = recorded({ overrides: { "stage-check": { stdout: "stage_ok=0\n" } } });
  try {
    await toReviewed(r);
    const failed = await r.tx.stage(SECRET_VALUES);
    assert.equal(failed.ok, false);
    const resumed = Transaction.resume({ receiptFile: r.tx.receiptPath, ...r.options });
    await assert.rejects(() => resumed.stage(SECRET_VALUES), (e) => e.code === "stage_already_started");
  } finally { r.cleanup(); }
});

describe("against the real hstack-target.sh (sandbox)", { concurrency: 3 }, () => {
  const gated = (name, fn) => test(name, { skip: SCRIPT_SKIP }, async () => {
    const target = new Target();
    try { await fn(target); } finally { target.cleanup(); }
  });

  gated("lost backup response: resume and abandon close the actual target transaction and unblock the next run", async (t) => {
    const before = userStateHash(t);
    const tx = newTransaction(t, { transport: losingTransport(t.transport(), ["backup"]) });
    await tx.validate(); await tx.inspect();
    await tx.reviewChanges((review) => review.plan_hash);
    await assert.rejects(() => tx.stage(SECRET_VALUES), { name: "TransportError" });
    assert.equal(tx.receipt.recovery.backup_ref, `bk_${tx.txnId}`);
    assert.ok(existsSync(path.join(t.statePath, "txn", tx.txnId)), "the remote backup really ran");
    const resumed = Transaction.resume({
      receiptFile: tx.receiptPath, blueprint: makeBlueprint(), contract, operator: OPERATOR,
      transport: t.transport(), receiptDir: t.receipts, skillsRoot: FIXTURE_SKILLS,
    });
    assert.equal((await resumed.abandon()).ok, true);
    assert.ok(existsSync(path.join(t.statePath, "txn", tx.txnId, "restored")));
    assert.equal(userStateHash(t), before);
    const next = newTransaction(t);
    await next.validate();
    assert.equal((await next.inspect()).ok, true);
    assertReceiptClean(assert, t, resumed);
  });

  gated("crash after stage: resume + abandon removes the staged secrets, leaves the user's state alone, and unblocks the next transaction", async (t) => {
    const before = userStateHash(t);
    const tx = newTransaction(t);
    await tx.validate(); await tx.inspect();
    await tx.reviewChanges((review) => review.plan_hash);
    await tx.stage(SECRET_VALUES);
    assert.ok(filesContaining(t.statePath, FAKE.bot).length > 0, "premise: the staged secret is on the target");
    assert.equal(userStateHash(t), before, "premise: staging touched nothing the user owns");

    const resumed = Transaction.resume({
      receiptFile: tx.receiptPath, blueprint: makeBlueprint(), contract, operator: OPERATOR, transport: t.transport(), receiptDir: t.receipts, skillsRoot: FIXTURE_SKILLS,
    });
    assert.equal(resumed.state, "staged");
    const outcome = await resumed.abandon();
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.deepEqual(filesContaining(t.statePath, FAKE.bot), [], "the staged secret was removed from the target");
    assert.equal(userStateHash(t), before);
    assert.equal(resumed.receipt.blocked_reason, "abandoned");
    assert.equal(resumed.receipt.changes_applied, false);
    assertReceiptClean(assert, t, resumed);

    const next = newTransaction(t);
    await next.validate();
    assert.equal((await next.inspect()).ok, true, "the abandoned transaction no longer blocks the next one");
  });

  gated("crash after stage: a resumed staged transaction can also simply continue to apply and verify", async (t) => {
    const tx = newTransaction(t);
    await tx.validate(); await tx.inspect();
    await tx.reviewChanges((review) => review.plan_hash);
    await tx.stage(SECRET_VALUES);
    const resumed = Transaction.resume({
      receiptFile: tx.receiptPath, blueprint: makeBlueprint(), contract, operator: OPERATOR, transport: t.transport(), receiptDir: t.receipts,
      skillsRoot: FIXTURE_SKILLS, observer: t.observer(),
    });
    assert.equal((await resumed.apply()).ok, true);
    assert.equal((await resumed.verify()).ok, true);
    assert.equal(resumed.state, "verified");
    assertReceiptClean(assert, t, resumed);
  });

  gated("rollback reloads the gateway after the restore (`gateway restart`) and records gateway-reloaded", async (t) => {
    const { tx } = await driveToApplied(t);
    const callsBefore = t.stubCalls().length;
    const outcome = await tx.rollback();
    assert.equal(outcome.ok, true);
    const after = t.stubCalls().slice(callsBefore).map((c) => c.join(" "));
    assert.ok(after.includes("gateway restart"), after.join(" | "));
    assert.equal(after.some((line) => /--daemon|gateway run|gateway stop/.test(line)), false, after.join(" | "));
    assert.equal(check(tx.receipt, "gateway-reloaded").status, "pass");
    assert.equal(existsSync(t.gatewayPath) && readFileSync(t.gatewayPath, "utf8").trim(), "running");
  });
});
