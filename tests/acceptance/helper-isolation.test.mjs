import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindHelper, helperPath, opHelperVerify, opInstallHelper } from "../../packages/acceptance/ops.js";
import { readTargetScript } from "../../packages/acceptance/artifacts.js";
import { sha256Hex } from "../../packages/acceptance/receipt.js";
import { DEFAULT_SCRIPT_PATH, Transaction } from "../../packages/acceptance/transaction.js";
import { TransportError } from "../../packages/acceptance/transports.js";
import { FIXTURE_SKILLS, OPERATOR, SECRET_VALUES, Target, contract, makeBlueprint, newTransaction } from "./helpers/harness.mjs";

const reviewed = async (tx) => {
  assert.equal((await tx.validate()).ok, true);
  assert.equal((await tx.inspect()).ok, true);
  return tx.reviewChanges((review) => review.plan_hash);
};
const actualPath = (target, sha) => path.join(target.home, helperPath(sha).slice(2));

test("a competing transaction cannot replace the helper another transaction reviewed", async () => {
  const target = new Target();
  const dir = mkdtempSync(path.join(os.tmpdir(), "hstack-helper-isolation-"));
  try {
    // Copy the current source so changes in a development checkout cannot alter a running Bash file.
    const body = readTargetScript(DEFAULT_SCRIPT_PATH);
    const variant = body.replace("out op put-env", "out helper_variant variant_b\n  out op put-env");
    assert.notEqual(variant, body);
    const scriptA = path.join(dir, "a.sh");
    const scriptB = path.join(dir, "b.sh");
    writeFileSync(scriptA, body); writeFileSync(scriptB, variant);
    const base = target.transport();
    let competing, refused, injected = false;
    const output = [];
    const transport = { kind: "sandbox", exec: async (op) => {
      if (op.op === "put-env" && !injected) {
        injected = true;
        refused = await competing.stage(SECRET_VALUES);
      }
      const result = await base.exec(op);
      output.push(result.stdout);
      return result;
    } };
    const first = newTransaction(target, { transport, scriptPath: scriptA, observer: target.observer() });
    competing = newTransaction(target, { scriptPath: scriptB });
    const reviewA = await reviewed(first);
    await reviewed(competing);
    assert.equal((await first.stage(SECRET_VALUES)).ok, true);
    assert.match(refused.blocked_reason, /^incomplete_transaction:/);
    assert.equal(output.some((text) => text.includes("helper_variant=variant_b")), false);
    assert.equal(sha256Hex(readFileSync(actualPath(target, reviewA.artifacts.script_sha256))), reviewA.artifacts.script_sha256);
    assert.ok(existsSync(actualPath(target, sha256Hex(variant))), "different helper versions coexist");
    assert.equal((await first.apply()).ok, true);
    assert.equal((await first.verify()).ok, true);
    assert.equal(existsSync(path.join(target.statePath, "bin", "hstack-target.sh")), false);
  } finally { target.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("helper publication is atomic, idempotent and refuses an occupied digest path", async () => {
  const target = new Target();
  try {
    const transport = target.transport();
    const body = "#!/bin/bash\nprintf 'ready\\n'\n";
    const install = opInstallHelper(body);
    const results = await Promise.all([transport.exec(install), transport.exec(install)]);
    assert.deepEqual(results.map((r) => r.code), [0, 0]);
    const file = actualPath(target, install.helperSha);
    const inode = statSync(file).ino;
    assert.equal(readFileSync(file, "utf8"), body);
    assert.equal(statSync(file).mode & 0o777, 0o700);
    assert.equal((await transport.exec(install)).code, 0);
    assert.equal(statSync(file).ino, inode, "published helper inode is never replaced");
    const measured = await transport.exec(bindHelper(opHelperVerify(), install.helperSha));
    assert.equal(measured.stdout.split(/\s+/)[0], install.helperSha);
    writeFileSync(file, "user-owned collision\n");
    assert.notEqual((await transport.exec(install)).code, 0);
    assert.equal(readFileSync(file, "utf8"), "user-owned collision\n");
    unlinkSync(file); mkdirSync(file);
    assert.notEqual((await transport.exec(install)).code, 0);
    assert.deepEqual(readdirSync(file), [], "a destination directory is never used as an ln container");
    rmSync(file, { recursive: true });
    const userDir = path.join(target.root, "user-dir"); mkdirSync(userDir); symlinkSync(userDir, file);
    assert.notEqual((await transport.exec(install)).code, 0);
    assert.deepEqual(readdirSync(userDir), [], "a destination symlink is never followed");
  } finally { target.cleanup(); }
});

test("resume safely installs the reviewed helper when only a legacy shared helper exists", async () => {
  const target = new Target();
  try {
    const tx = newTransaction(target, { observer: target.observer() });
    await reviewed(tx);
    assert.equal((await tx.stage(SECRET_VALUES)).ok, true);
    assert.equal((await tx.apply()).ok, true);
    const pinned = actualPath(target, tx.receipt.artifacts.script_sha256);
    unlinkSync(pinned);
    const legacy = path.join(target.statePath, "bin", "hstack-target.sh");
    const sentinel = "#!/bin/bash\nprintf 'legacy helper must never execute\\n'; exit 97\n";
    writeFileSync(legacy, sentinel);
    const resumed = Transaction.resume({
      receipt: tx.receipt, blueprint: makeBlueprint(), contract, operator: OPERATOR,
      transport: target.transport(), receiptDir: target.receipts, skillsRoot: FIXTURE_SKILLS,
      observer: target.observer(),
    });
    assert.equal((await resumed.verify()).ok, true);
    assert.equal(sha256Hex(readFileSync(pinned)), tx.receipt.artifacts.script_sha256);
    assert.equal(readFileSync(legacy, "utf8"), sentinel);
  } finally { target.cleanup(); }
});

test("resume refuses a legacy helper when the reviewed script bytes are unavailable locally", async () => {
  const target = new Target();
  try {
    const tx = newTransaction(target);
    await reviewed(tx);
    assert.equal((await tx.stage(SECRET_VALUES)).ok, true);
    unlinkSync(actualPath(target, tx.receipt.artifacts.script_sha256));
    const legacy = path.join(target.statePath, "bin", "hstack-target.sh");
    const sentinel = "#!/bin/bash\nprintf 'unreviewed helper executed\\n'; exit 97\n";
    writeFileSync(legacy, sentinel);
    const changed = path.join(target.root, "changed.sh");
    writeFileSync(changed, "#!/bin/bash\nexit 0\n");
    const resumed = Transaction.resume({
      receipt: tx.receipt, blueprint: makeBlueprint(), contract, operator: OPERATOR,
      transport: target.transport(), receiptDir: target.receipts, skillsRoot: FIXTURE_SKILLS, scriptPath: changed,
    });
    const result = await resumed.abandon();
    assert.equal(result.ok, false, "cleanup cannot use a helper whose bytes were not approved");
    assert.notEqual(resumed.receipt.blocked_reason, "abandoned");
    assert.equal(readFileSync(legacy, "utf8"), sentinel);
    assert.equal(existsSync(actualPath(target, tx.receipt.artifacts.script_sha256)), false);
  } finally { target.cleanup(); }
});

test("a lost commit reply can be resumed and retried against the already committed target", async () => {
  const target = new Target();
  try {
    const base = target.transport();
    let lost = false;
    const transport = { kind: "sandbox", exec: async (op) => {
      const result = await base.exec(op);
      if (op.op === "commit" && !lost) {
        lost = true;
        return { ...result, transportError: true };
      }
      return result;
    } };
    const tx = newTransaction(target, { transport, observer: target.observer() });
    await reviewed(tx);
    assert.equal((await tx.stage(SECRET_VALUES)).ok, true);
    assert.equal((await tx.apply()).ok, true);
    await assert.rejects(() => tx.verify(), TransportError);
    assert.equal(tx.state, "applied_unverified");
    assert.ok(existsSync(path.join(target.statePath, "txn", tx.txnId, "done")), "commit succeeded before its reply was lost");
    const resumed = Transaction.resume({
      receiptFile: tx.receiptPath, blueprint: makeBlueprint(), contract, operator: OPERATOR,
      transport: target.transport(), receiptDir: target.receipts, skillsRoot: FIXTURE_SKILLS,
      observer: target.observer(),
    });
    assert.equal((await resumed.verify()).ok, true, "the target accepts an idempotent confirmed commit retry");
    assert.equal(resumed.state, "verified");
  } finally { target.cleanup(); }
});

test("overlapping calls on one transaction are rejected without corrupting staging", async () => {
  const target = new Target();
  let release;
  try {
    const base = target.transport();
    const entered = new Promise((resolve) => { release = resolve; });
    let signal;
    const held = new Promise((resolve) => { signal = resolve; });
    const transport = { kind: "sandbox", exec: async (op) => {
      if (op.op === "install-helper") { signal(); await entered; }
      return base.exec(op);
    } };
    const tx = newTransaction(target, { transport });
    await reviewed(tx);
    const staging = tx.stage(SECRET_VALUES);
    await held;
    const before = tx.receipt;
    for (const call of [
      () => tx.validate(), () => tx.inspect(), () => tx.reviewChanges((r) => r.plan_hash),
      () => tx.stage(SECRET_VALUES), () => tx.apply(), () => tx.verify(), () => tx.rollback(),
      () => tx.abandon(), () => tx.purge(),
    ]) await assert.rejects(call, (error) => error.code === "operation_in_progress");
    assert.deepEqual(tx.receipt, before);
    release();
    assert.equal((await staging).ok, true);
    assert.equal(tx.receipt.recovery.backup_ref, `bk_${tx.txnId}`);
    assert.equal((await tx.apply()).ok, true);
    assert.equal((await tx.rollback()).ok, true);
  } finally { release?.(); target.cleanup(); }
});
