import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

import { validateReceipt } from "../../packages/acceptance/receipt.js";
import { IllegalTransition } from "../../packages/acceptance/states.js";
import { RecordingTransport, TransportError } from "../../packages/acceptance/transports.js";
import {
  ApprovalError, TargetScriptMissing, Transaction, TransactionError, ValidatorUnavailable,
} from "../../packages/acceptance/transaction.js";
import { cannedResponder } from "./helpers/canned.mjs";
import {
  ALL_SECRET_STRINGS, FAKE, FIXTURE_SKILLS, OPERATOR, SCRIPT_SKIP, SECRET_VALUES, Target, assertReceiptClean, contract, driveToApplied,
  fixedClock, listTree, losingTransport, makeBlueprint, newTransaction, readAllReceiptText, treeHash, userStateHash,
} from "./helpers/harness.mjs";

async function withTarget(fn, options) {
  const target = new Target(options);
  try {
    await fn(target);
  } finally {
    target.cleanup();
  }
}
const gated = (name, fn) => test(name, { skip: SCRIPT_SKIP }, () => withTarget(fn));
const allOpsOk = (receipt) => receipt.apply.ops.every((op) => op.status === "ok");

describe("transaction vs the real hstack-target.sh (sandbox, stub hermes)", { concurrency: 6 }, () => {
gated("happy path reaches verified only with an observed delivery; the receipt is clean and every file is private", async (t) => {
  t.setFixture("Issue 7: update the README");
  const before = userStateHash(t);
  const { tx, applied } = await driveToApplied(t, { observer: t.observer(), now: fixedClock() });
  assert.equal(applied.ok, true);
  assert.equal(tx.state, "applied_unverified");
  assert.equal(tx.receipt.apply.completed, true);
  assert.notEqual(userStateHash(t), before, "apply changed the managed state");

  const verified = await tx.verify();
  assert.equal(verified.ok, true);
  assert.equal(tx.state, "verified");
  const receipt = assertReceiptClean(assert, t, tx);
  assert.deepEqual(receipt.transitions.map((x) => x.to), ["validated", "inspected", "change_reviewed", "staged", "applied_unverified", "verified"]);
  assert.equal(receipt.changes_applied, true);
  assert.equal(receipt.recovery.backup_ref, `bk_${tx.txnId}`);
  assert.equal(receipt.recovery.restoration_verified, false);
  assert.equal(receipt.runtime_version, contract.runtime.declared_version);
  assert.equal(receipt.target_profile.transport_used, "sandbox", "a simulated run says so");
  assert.equal(receipt.destination_fingerprint, tx.destinationFingerprint);
  assert.equal(receipt.delivery_semantics, contract.delivery_semantics);
  assert.equal(receipt.scope_note, contract.scope_note);
  assert.ok(allOpsOk(receipt));
  for (const id of contract.required_checks) assert.equal(receipt.checks.find((c) => c.id === id)?.status, "pass", id);
  assert.ok(receipt.recovery.external_effects.some((e) => e.kind === "telegram_message_delivered"), "a delivered message cannot be undone and is recorded");
  assert.equal(receipt.checks.some((c) => /doctor|health/.test(c.id)), false, "hstack never claims a doctor/health result");

  // live state: managed keys present, unrelated kept, env stays private
  const env = t.env();
  for (const key of contract.managed_env_keys) assert.match(env, new RegExp(`^${key}=`, "m"), key);
  assert.match(env, /^UNRELATED_SETTING=keep-me$/m);
  assert.equal(statSync(t.envPath).mode & 0o777, 0o600);
  assert.equal(t.managedCronLines().length, 1);

  // every receipt/evidence file is mode 600, dirs 700
  const root = path.join(t.receipts, tx.txnId);
  const entries = listTree(root);
  assert.ok(entries.length > 6);
  for (const entry of entries) assert.equal(statSync(entry.full).mode & 0o777, entry.dir ? 0o700 : 0o600, entry.full);
  const history = readdirSync(path.join(root, "history")).sort();
  assert.deepEqual(history, ["01-validated.json", "02-inspected.json", "03-change_reviewed.json", "04-staged.json", "05-applied_unverified.json", "06-verified.json"]);
  for (const name of history) assert.equal(validateReceipt(JSON.parse(readFileSync(path.join(root, "history", name), "utf8"))).valid, true, name);

  // evidence refs point at real, redacted files
  for (const check of receipt.checks.filter((c) => c.evidence_ref)) assert.ok(existsSync(path.join(root, "evidence", check.evidence_ref)), check.evidence_ref);

  // the stub (declared adapter surface) saw only declared subcommands, never doctor/--fix, never a secret
  const surface = contract.adapter_surface;
  const calls = t.stubCalls();
  assert.ok(calls.length > 5);
  for (const argv of calls) {
    const line = argv.join(" ");
    assert.ok(surface.some((entry) => line === entry || line.startsWith(`${entry} `)), `undeclared hermes call: ${line}`);
    assert.equal(/doctor|--fix|--daemon|gateway run/.test(line), false, line);
  }
  const log = readFileSync(t.stubLog, "utf8");
  for (const secret of ALL_SECRET_STRINGS) assert.equal(log.includes(secret), false, "no secret in any hermes argv");
});

gated("without a delivery observer the transaction cannot reach verified: delivery is unknown", async (t) => {
  const { tx } = await driveToApplied(t);
  const outcome = await tx.verify();
  assert.equal(outcome.ok, false);
  assert.equal(tx.state, "applied_unverified");
  assert.deepEqual(outcome.unresolved.sort(), ["private-destination-delivery", "untrusted-input-boundary"]);
  const receipt = assertReceiptClean(assert, t, tx);
  assert.deepEqual(receipt.unresolved.slice().sort(), ["private-destination-delivery", "untrusted-input-boundary"]);
  assert.equal(receipt.checks.find((c) => c.id === "private-destination-delivery").status, "unknown");
  assert.match(receipt.checks.find((c) => c.id === "private-destination-delivery").detail, /cannot be proven/);
  assert.equal(receipt.checks.find((c) => c.id === "env-boundary").status, "pass", "target-state checks still ran and passed");
  assert.equal(existsSync(path.join(t.statePath, "txn", tx.txnId, "done")), false, "an unverified transaction is not committed on the target");
  // the validator itself refuses to call this verified
  receipt.state = "verified";
  assert.equal(validateReceipt(receipt).valid, false);
});

test("an observer that errors or returns garbage yields unknown, never pass", { skip: SCRIPT_SKIP }, async () => {
  const results = [];
  for (const observer of [
    { delivery: async () => { throw new Error("observer crashed"); } },
    { delivery: async () => ({ nonsense: true }) },
    { delivery: async () => ({ deliveries: [{ to_fp: "not-a-fingerprint", body_has_secret: false }] }) },
    { delivery: async () => ({ deliveries: [] }) },
  ]) {
    await withTarget(async (inner) => {
      const { tx } = await driveToApplied(inner, { observer });
      const outcome = await tx.verify();
      results.push([outcome.ok, tx.state, tx.receipt.checks.find((c) => c.id === "private-destination-delivery").status]);
    });
  }
  assert.deepEqual(results, Array(4).fill([false, "applied_unverified", "unknown"]));
});

gated("write-ahead: applied_unverified is on disk before the first live mutation, and nothing live ran before it", async (t) => {
  const before = userStateHash(t);
  const seen = [];
  let tx;
  const recording = new RecordingTransport({
    inner: t.transport(),
    onExec: (op) => {
      const r = JSON.parse(readFileSync(tx.receiptPath, "utf8"));
      seen.push({ op: op.op, mutates: op.mutates, state: r.state, changes_applied: r.changes_applied, started: r.apply.started, completed: r.apply.completed });
    },
  });
  tx = newTransaction(t, { transport: recording, observer: t.observer() });
  await tx.validate();
  await tx.inspect();
  await tx.reviewChanges((review) => review.plan_hash);
  await tx.stage(SECRET_VALUES);
  assert.equal(userStateHash(t), before, "staging changes only hstack's own directory; the user's env/config/cron/skills are untouched");
  await tx.apply();

  const live = seen.filter((entry) => entry.mutates === "live");
  assert.deepEqual(live.map((entry) => entry.op), ["skills-sync", "apply", "reload"]);
  for (const entry of live) {
    assert.equal(entry.state, "applied_unverified", `${entry.op} ran while the receipt said ${entry.state}`);
    assert.equal(entry.changes_applied, true);
    assert.equal(entry.started, true);
    assert.equal(entry.completed, false, "completed is only set after the last step");
  }
  for (const entry of seen.filter((e) => e.mutates !== "live")) {
    if (entry.op === "verify") continue;
    assert.equal(["validated", "inspected", "change_reviewed"].includes(entry.state), true, `${entry.op} @ ${entry.state}`);
  }
  assert.equal(tx.receipt.apply.completed, true);
});

gated("the transaction refuses a live op that was not preceded by the write-ahead receipt", async (t) => {
  // Reach `staged`, then try to push a restore (a live op) through a Transaction that has not applied.
  const tx = newTransaction(t);
  await tx.validate(); await tx.inspect();
  await tx.reviewChanges((review) => review.plan_hash);
  await tx.stage(SECRET_VALUES);
  await assert.rejects(() => tx.rollback(), IllegalTransition, "rollback is not legal from staged");
  assert.equal(tx.state, "staged");
  assert.equal(tx.receipt.changes_applied, false);
});

gated("interruption after write-ahead stays applied_unverified; resume allows only verify or rollback; rollback restores", async (t) => {
  const before = userStateHash(t);
  const tx = newTransaction(t, { transport: losingTransport(t.transport(), ["apply"]) });
  await tx.validate(); await tx.inspect();
  await tx.reviewChanges((review) => review.plan_hash);
  await tx.stage(SECRET_VALUES);
  // `apply` really ran on the target, but the outcome never reached us (connection lost).
  await assert.rejects(() => tx.apply(), TransportError);
  assert.equal(tx.state, "applied_unverified");
  const interrupted = assertReceiptClean(assert, t, tx);
  assert.equal(interrupted.changes_applied, true);
  assert.equal(interrupted.apply.started, true);
  assert.equal(interrupted.apply.completed, false);
  assert.equal(interrupted.apply.ops.find((o) => o.op_id === "skills:sync").status, "ok");
  assert.equal(interrupted.apply.ops.find((o) => o.op_id === "cron:founder-brief").status, "unknown");
  assert.equal(interrupted.apply.ops.find((o) => o.op_id === "gateway:reload").status, "pending");
  assert.notEqual(userStateHash(t), before, "the target really was changed");

  // a new process picks the receipt up
  const resumed = Transaction.resume({
    receiptFile: tx.receiptPath, blueprint: makeBlueprint(), contract, operator: OPERATOR, transport: t.transport(),
    receiptDir: t.receipts, skillsRoot: FIXTURE_SKILLS,
  });
  assert.equal(resumed.state, "applied_unverified");
  for (const [name, call] of [
    ["validate", () => resumed.validate()], ["inspect", () => resumed.inspect()], ["reviewChanges", () => resumed.reviewChanges((r) => r.plan_hash)],
    ["stage", () => resumed.stage(SECRET_VALUES)], ["apply", () => resumed.apply()], ["purge", () => resumed.purge()],
  ]) {
    await assert.rejects(call, IllegalTransition, `${name} must be illegal after resume`);
  }
  assert.equal(resumed.state, "applied_unverified");

  // verify cannot bless an apply that never completed: it demands rollback
  const outcome = await resumed.verify();
  assert.equal(outcome.ok, false);
  assert.equal(resumed.state, "rollback_required");
  const rolled = await resumed.rollback();
  assert.equal(rolled.ok, true);
  assert.equal(resumed.state, "restored_verified");
  assert.equal(userStateHash(t), before, "the user's state is byte-for-byte what it was");
  assert.equal(t.managedCronLines().length, 0);
  const receipt = assertReceiptClean(assert, t, resumed);
  assert.equal(receipt.recovery.restoration_verified, true);
  assert.equal(receipt.transitions.at(-1).to, "restored_verified");
});

gated("resume refuses terminal states and inputs that do not reproduce the receipt's plan_hash", async (t) => {
  const { tx } = await driveToApplied(t, { observer: t.observer() });
  const common = { blueprint: makeBlueprint(), contract, operator: OPERATOR, transport: t.transport(), receiptDir: t.receipts, skillsRoot: FIXTURE_SKILLS };
  assert.throws(() => Transaction.resume({ receiptFile: tx.receiptPath, ...common, operator: { chatId: FAKE.otherChat, schedule: OPERATOR.schedule } }), (e) => e instanceof TransactionError && e.code === "resume_mismatch");
  assert.throws(() => Transaction.resume({ receiptFile: tx.receiptPath, ...common, operator: { chatId: FAKE.chat, schedule: "5 5 * * *" } }), TransactionError);
  const otherBlueprint = makeBlueprint();
  otherBlueprint.integrations[0].access = "read_write";
  assert.throws(() => Transaction.resume({ receiptFile: tx.receiptPath, ...common, blueprint: otherBlueprint }));
  assert.equal((await tx.verify()).ok, true);
  assert.throws(() => Transaction.resume({ receiptFile: tx.receiptPath, ...common }), IllegalTransition, "verified is final");
});

gated("rollback from applied_unverified restores the user's state byte for byte and keeps the backup until purge", async (t) => {
  t.seed({ priorBot: FAKE.botOld });
  const before = userStateHash(t);
  const envBefore = readFileSync(t.envPath);
  const { tx } = await driveToApplied(t);
  assert.match(t.env(), new RegExp(`^TELEGRAM_BOT_TOKEN=${FAKE.bot}$`, "m"));
  const outcome = await tx.rollback();
  assert.equal(outcome.ok, true);
  assert.equal(tx.state, "restored_verified");
  assert.deepEqual(readFileSync(t.envPath), envBefore, "the previous secret value is back, byte for byte");
  assert.equal(userStateHash(t), before);
  assert.equal(existsSync(path.join(t.skillsPath, "platform-telegram")), false, "skills the transaction created are removed");
  const receipt = assertReceiptClean(assert, t, tx);
  assert.equal(receipt.recovery.restoration_verified, true);
  assert.equal(existsSync(path.join(t.statePath, "txn", tx.txnId)), true, "backup is retained");
  assert.equal((await tx.purge()).ok, true);
  assert.equal(existsSync(path.join(t.statePath, "txn", tx.txnId)), false, "purge removes only that transaction");
});

gated("unrelated keys changed after apply are left exactly as they are by rollback", async (t) => {
  const { tx } = await driveToApplied(t);
  writeFileSync(t.envPath, `${t.env()}LATER_UNRELATED=added-after-apply\n`, { mode: 0o600 });
  const outcome = await tx.rollback();
  assert.equal(outcome.ok, true);
  assert.equal(tx.state, "restored_verified");
  assert.match(t.env(), /^LATER_UNRELATED=added-after-apply$/m);
  assert.doesNotMatch(t.env(), /GITHUB_TOKEN/);
});

gated("approval must quote the exact plan_hash", async (t) => {
  const tx = newTransaction(t);
  await tx.validate(); await tx.inspect();
  const before = userStateHash(t);
  await assert.rejects(() => tx.reviewChanges(), ApprovalError);
  await assert.rejects(() => tx.reviewChanges(() => "0".repeat(64)), ApprovalError);
  await assert.rejects(() => tx.reviewChanges((review) => review), ApprovalError, "returning the review object is not quoting the hash");
  await assert.rejects(() => tx.reviewChanges(() => undefined), ApprovalError);
  assert.equal(tx.state, "inspected");
  let reviewSeen;
  const review = await tx.reviewChanges((r) => { reviewSeen = r; return r.plan_hash; });
  assert.equal(tx.state, "change_reviewed");
  assert.equal(review.plan_hash, tx.planHash);
  assert.equal(tx.receipt.plan_hash, tx.planHash);
  assert.equal(reviewSeen.recovery_point, `bk_${tx.txnId}`);
  assert.equal(userStateHash(t), before);
  // the review lists the ordered ops with exact commands, previous state, and no secret
  assert.deepEqual(review.ops.map((op) => op.op_id), [
    "helper:install", "helper:verify", "backup:create", ...contract.managed_env_keys.map((k) => `env:${k}`),
    "stage:check", "skills:sync", "config:apply", "gateway:reload", "verify:target",
  ]);
  assert.match(review.ops.find((o) => o.op_id === "env:TELEGRAM_BOT_TOKEN").expected_previous, /^absent$/);
  assert.match(review.ops.find((o) => o.op_id === "env:GITHUB_TOKEN").remote, /put-env/);
  assert.match(review.ops.find((o) => o.op_id === "skills:sync").expected_previous, /platform-telegram: absent/);
  assert.match(review.ops.find((o) => o.op_id === "config:apply").expected_previous, /cron entry founder-brief: absent/);
  assert.equal(JSON.stringify(review).includes(FAKE.github), false);
});

gated("methods are only legal in their own state", async (t) => {
  const tx = newTransaction(t);
  await assert.rejects(() => tx.inspect(), IllegalTransition);
  await assert.rejects(() => tx.stage(SECRET_VALUES), IllegalTransition);
  await assert.rejects(() => tx.apply(), IllegalTransition);
  await assert.rejects(() => tx.verify(), IllegalTransition);
  await assert.rejects(() => tx.rollback(), IllegalTransition);
  await tx.validate();
  await assert.rejects(() => tx.validate(), IllegalTransition);
  await assert.rejects(() => tx.stage(SECRET_VALUES), IllegalTransition);
  await tx.inspect();
  await assert.rejects(() => tx.stage(SECRET_VALUES), IllegalTransition, "review is mandatory");
  await assert.rejects(() => tx.apply(), IllegalTransition);
  await tx.reviewChanges((r) => r.plan_hash);
  await assert.rejects(() => tx.apply(), IllegalTransition, "staging is mandatory");
  await assert.rejects(() => tx.verify(), IllegalTransition);
  assert.equal(tx.receipt.changes_applied, false);
});

gated("stage() validates the secret values before touching the target", async (t) => {
  const tx = newTransaction(t);
  await tx.validate(); await tx.inspect();
  await tx.reviewChanges((r) => r.plan_hash);
  const before = t.homeHash();
  const bad = [
    { ...SECRET_VALUES, TELEGRAM_ALLOWED_USERS: "*" },
    { ...SECRET_VALUES, TELEGRAM_ALLOWED_USERS: "" },
    { ...SECRET_VALUES, TELEGRAM_ALLOWED_USERS: "123,*" },
    { ...SECRET_VALUES, TELEGRAM_HOME_CHANNEL: FAKE.otherChat },
    { ...SECRET_VALUES, EXTRA_KEY: "x" },
    { GITHUB_TOKEN: SECRET_VALUES.GITHUB_TOKEN },
    { ...SECRET_VALUES, GITHUB_TOKEN: "has a space" },
  ];
  for (const values of bad) {
    let error = null;
    try { await tx.stage(values); } catch (e) { error = e; }
    assert.ok(error, JSON.stringify(Object.keys(values)));
    assert.equal(ALL_SECRET_STRINGS.some((s) => error.message.includes(s)), false, "error messages never echo values");
  }
  assert.equal(tx.state, "change_reviewed");
  assert.equal(t.homeHash(), before, "nothing reached the target");
});

gated("an earlier incomplete transaction blocks the next one at inspect, with zero writes", async (t) => {
  const first = await driveToApplied(t);
  assert.equal(first.tx.state, "applied_unverified"); // never verified, never rolled back
  const second = newTransaction(t);
  assert.equal((await second.validate()).ok, true);
  const before = t.homeHash();
  const result = await second.inspect();
  assert.equal(result.ok, false);
  assert.equal(result.blocked_reason, `incomplete_transaction:${first.tx.txnId}`);
  assert.equal(second.state, "validated");
  assert.equal(second.receipt.changes_applied, false);
  assert.equal(second.receipt.blocked_reason, `incomplete_transaction:${first.tx.txnId}`);
  assert.equal(t.homeHash(), before, "inspect wrote nothing");
  await assert.rejects(() => second.stage(SECRET_VALUES), IllegalTransition);
  assertReceiptClean(assert, t, second);
  // recovering the first one unblocks a fresh transaction
  assert.equal((await first.tx.rollback()).ok, true);
  const third = newTransaction(t);
  await third.validate();
  assert.equal((await third.inspect()).ok, true);
});

gated("an unmanaged directory with a managed skill name is a collision found at inspect; nothing is overwritten", async (t) => {
  const dir = path.join(t.skillsPath, "platform-telegram");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "# the user's own telegram skill\n");
  const before = t.homeHash();
  const tx = newTransaction(t);
  await tx.validate();
  const result = await tx.inspect();
  assert.equal(result.blocked_reason, "skill_collision:platform-telegram");
  assert.equal(tx.state, "validated");
  assert.equal(t.homeHash(), before);
  assert.equal(readFileSync(path.join(dir, "SKILL.md"), "utf8"), "# the user's own telegram skill\n");
});

gated("a managed skill modified after install blocks the next transaction (precondition conflict)", async (t) => {
  const first = await driveToApplied(t, { observer: t.observer() });
  assert.equal((await first.tx.verify()).ok, true);
  writeFileSync(path.join(t.skillsPath, "hermes-home", "SKILL.md"), "# edited by the user\n");
  const second = newTransaction(t);
  await second.validate();
  const result = await second.inspect();
  assert.equal(result.blocked_reason, "precondition_conflict:managed_skill_modified");
  assert.equal(second.state, "validated");
});

gated("purge is only legal after a final state", async (t) => {
  const { tx } = await driveToApplied(t, { observer: t.observer() });
  await assert.rejects(() => tx.purge(), IllegalTransition);
  assert.equal((await tx.verify()).ok, true);
  assert.equal((await tx.purge()).ok, true);
  assert.equal(tx.state, "verified");
});

gated("a transport failure never advances state", async (t) => {
  const tx = newTransaction(t, { transport: losingTransport(t.transport(), ["inspect"]) });
  await tx.validate();
  await assert.rejects(() => tx.inspect(), TransportError);
  assert.equal(tx.state, "validated");
  assert.equal(tx.receipt.blocked_reason, null);
});

});

test("a missing target script is an explicit error, not a silent pass", async () => {
  const target = new Target({ seed: false });
  try {
    const tx = newTransaction(target, { scriptPath: path.join(target.root, "nope.sh") });
    await tx.validate();
    await assert.rejects(() => tx.inspect(), TargetScriptMissing);
    assert.equal(tx.state, "validated");
  } finally {
    target.cleanup();
  }
});

test("a missing Python interpreter makes validate() fail loudly instead of skipping the structural gate", async () => {
  const previous = process.env.HSTACK_PYTHON;
  process.env.HSTACK_PYTHON = "/nonexistent/python3";
  const target = new Target({ seed: false });
  try {
    const tx = newTransaction(target);
    await assert.rejects(() => tx.validate(), ValidatorUnavailable);
    assert.equal(tx.state, "start");
  } finally {
    if (previous === undefined) delete process.env.HSTACK_PYTHON; else process.env.HSTACK_PYTHON = previous;
    target.cleanup();
  }
});

test("the receipt directory of an unfinished transaction is never world- or group-readable", async () => {
  const target = new Target({ seed: false });
  try {
    const tx = newTransaction(target, { transport: new RecordingTransport() });
    await tx.validate();
    const text = readAllReceiptText(target.receipts);
    assert.ok(text.length > 0);
    assert.equal(statSync(tx.receiptPath).mode & 0o077, 0);
    assert.equal(statSync(path.dirname(tx.receiptPath)).mode & 0o077, 0);
    assert.equal(validateReceipt(tx.receipt).valid, true);
  } finally {
    target.cleanup();
  }
});

// ---- hostile or sloppy TARGET output (recording transport; no sandbox needed) --------------------

const FIXTURE_SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "target-script-fixture.sh");
const FIXTURE_SCRIPT = readFileSync(FIXTURE_SCRIPT_PATH, "utf8");

async function recordedRun(overrides, steps) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hstack-hostile-"));
  try {
    const txn = "hostile00001";
    const recording = new RecordingTransport({ respond: cannedResponder({ scriptBody: FIXTURE_SCRIPT, txn, overrides }) });
    const tx = new Transaction({
      blueprint: makeBlueprint(), contract, operator: OPERATOR, transport: recording, receiptDir: dir, txnId: txn,
      skillsRoot: FIXTURE_SKILLS, scriptPath: FIXTURE_SCRIPT_PATH,
    });
    await tx.validate();
    await tx.inspect();
    await tx.reviewChanges((review) => review.plan_hash);
    const result = await steps(tx);
    const text = readAllReceiptText(dir);
    for (const secret of ALL_SECRET_STRINGS) assert.equal(text.includes(secret), false, "a secret value reached a receipt or evidence file");
    assert.equal(validateReceipt(tx.receipt, { requiredChecks: contract.required_checks }).valid, true);
    return { tx, result, text, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a target that echoes a staged secret (or a secret-shaped string) cannot get it into a receipt or evidence file", async () => {
  const leaked = ["g", "hp_", "UNKNOWNSHAPE0123456789abcdefghij"].join("");
  const { text } = await recordedRun(
    { "stage-check": { stdout: `stage_ok=1\nleak_known=${FAKE.bot}\nleak_chat=${FAKE.chat}\nleak_shape=${leaked}\n` } },
    (tx) => tx.stage(SECRET_VALUES),
  );
  assert.ok(text.includes("[redacted]"), "known secret values are replaced");
  assert.ok(text.includes("[redacted-shape]"), "secret-shaped strings are replaced even when unknown");
  assert.equal(text.includes(leaked), false);
});

test("target-controlled error codes and details are sanitised before they reach a receipt", async () => {
  const { tx, result } = await recordedRun(
    { backup: { code: 4, stdout: "error=Evil Code; rm -rf /\ndetail=\u001b[31mred‮ /home/u/.hermes/.env token\n" } },
    (t) => t.stage(SECRET_VALUES),
  );
  assert.equal(result.ok, false);
  assert.equal(result.blocked_reason, "target_blocked", "an error code that is not a plain machine code is replaced, not forwarded");
  assert.equal(tx.state, "change_reviewed");
  assert.equal(tx.receipt.changes_applied, false);
  const detail = tx.receipt.checks.find((c) => c.id === "staging").detail;
  assert.doesNotMatch(detail, /[\u0000-\u001F‮]/);
  assert.doesNotMatch(detail, /\/home\//, "target paths are not recorded");
  assert.equal(result.detail.includes("\u001b"), false);
});

test("incomplete_transaction from the target keeps its id in blocked_reason only when it is a plain id", async () => {
  const good = await recordedRun({ backup: { code: 4, stdout: "error=incomplete_transaction\ndetail=abcd1234efgh,zzzz9999yyyy\n" } }, (t) => t.stage(SECRET_VALUES));
  assert.equal(good.result.blocked_reason, "incomplete_transaction:abcd1234efgh");
  const bad = await recordedRun({ backup: { code: 4, stdout: "error=incomplete_transaction\ndetail=../../etc;id\n" } }, (t) => t.stage(SECRET_VALUES));
  assert.equal(bad.result.blocked_reason, "incomplete_transaction:unknown");
});

test("a target that reports success without the expected confirmation does not advance state", async () => {
  const wrongHandle = await recordedRun({ backup: { stdout: "backup_handle=bk_otherthing\n" } }, (t) => t.stage(SECRET_VALUES));
  assert.equal(wrongHandle.result.ok, false);
  assert.equal(wrongHandle.tx.state, "change_reviewed");
  const noStageOk = await recordedRun({ "stage-check": { stdout: "something_else=1\n" } }, (t) => t.stage(SECRET_VALUES));
  assert.equal(noStageOk.result.blocked_reason, "stage_failed:stage-check");
  const noApplied = await recordedRun({ apply: { stdout: "env_swapped=1\n" } }, async (t) => { await t.stage(SECRET_VALUES); return t.apply(); });
  assert.equal(noApplied.result.ok, false);
  assert.equal(noApplied.tx.state, "rollback_required", "apply exit 0 without applied=1 is a failed apply");
  const wrongHash = await recordedRun({ "helper-verify": { stdout: `${"0".repeat(64)}  x\n` } }, (t) => t.stage(SECRET_VALUES));
  assert.equal(wrongHash.result.blocked_reason, "stage_failed:helper-integrity");
});
