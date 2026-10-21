import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ReceiptInvalid, canonicalHash, canonicalJson, destinationFingerprint, findDuplicateKeys, loadSchema, parseStrictJson,
  validateReceipt, validateReceiptText, writeReceiptAtomic, readReceipt, looksLikeSecret,
} from "../../packages/acceptance/receipt.js";
import { STATES } from "../../packages/acceptance/states.js";
import { ALL_STATES, validReceipt } from "./helpers/receipts.mjs";
import { contract, fingerprint } from "./helpers/harness.mjs";

const errorsOf = (receipt, options) => validateReceipt(receipt, options).errors;
const has = (errors, fragment) => errors.some((message) => message.includes(fragment));

test("schema is the single source: its state enum is the state list and verified-requires equals the contract's required checks", () => {
  const schema = loadSchema();
  assert.deepEqual(schema.properties.state.enum, [...STATES]);
  assert.deepEqual(schema["x-hstack"].verified_requires_checks, contract.required_checks);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.required.length, 20);
});

test("a consistent receipt in every one of the nine states is valid", () => {
  assert.equal(ALL_STATES.length, 9);
  for (const state of ALL_STATES) {
    const result = validateReceipt(validReceipt(state));
    assert.deepEqual(result.errors, [], `state ${state}`);
    assert.equal(result.valid, true);
  }
});

test("removing any required key, or adding an unknown key, makes the receipt invalid (driven by the schema file)", () => {
  for (const key of loadSchema().required) {
    const receipt = validReceipt("validated");
    delete receipt[key];
    assert.equal(validateReceipt(receipt).valid, false, `missing ${key}`);
  }
  const extra = { ...validReceipt("validated"), notes: "hello" };
  assert.equal(validateReceipt(extra).valid, false);
  const nested = validReceipt("validated");
  nested.recovery.extra = true;
  assert.equal(validateReceipt(nested).valid, false);
});

test("unknown state names are rejected, in state and in transitions", () => {
  const a = validReceipt("validated");
  a.state = "done";
  assert.equal(validateReceipt(a).valid, false);
  const b = validReceipt("validated");
  b.transitions[0].to = "success";
  assert.equal(validateReceipt(b).valid, false);
  const c = validReceipt("staged");
  c.state = "success";
  assert.equal(validateReceipt(c).valid, false);
});

test("secret shapes are rejected anywhere: values, nested notes, and keys", () => {
  const shapes = {
    githubPat: ["github", "_pat_", "A".repeat(30)].join(""),
    ghp: ["g", "hp_", "B".repeat(30)].join(""),
    xoxb: ["xo", "xb-", "123456789012-abcdef"].join(""),
    telegram: ["123456789", `${"C".repeat(35)}`].join(":"),
    skLive: ["sk", "_live_", "D".repeat(24)].join(""),
    aws: ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
    google: ["AI", "za", "E".repeat(35)].join(""),
  };
  for (const [name, secret] of Object.entries(shapes)) {
    assert.equal(looksLikeSecret(secret), true, name);
    const inCheck = validReceipt("validated");
    inCheck.checks.push({ id: "x", status: "pass", observed_at: "2026-01-01T00:00:00Z", evidence_ref: null, scope: "t", detail: `leaked ${secret} here` });
    assert.ok(has(errorsOf(inCheck), "secret shape"), `${name} in check detail`);
    const inNote = validReceipt("validated");
    inNote.recovery.external_effects.push({ kind: "k", note: secret });
    assert.ok(has(errorsOf(inNote), "secret shape"), `${name} in external effect`);
  }
  const keyed = validReceipt("validated");
  keyed.recovery.external_effects.push({ kind: "k", note: "n", [shapes.ghp]: 1 });
  assert.equal(validateReceipt(keyed).valid, false);
  assert.equal(looksLikeSecret("TELEGRAM_BOT_TOKEN"), false, "variable NAMES are fine");
  assert.equal(looksLikeSecret("0123456789abcdef"), false, "a fingerprint is fine");
});

test("keys named token/secret/password are rejected even with innocuous values", () => {
  for (const key of ["token", "secret", "password", "bot_token", "apiToken", "client-secret"]) {
    const receipt = validReceipt("validated");
    receipt.target_profile[key] = "x";
    const errors = errorsOf(receipt);
    assert.ok(errors.length > 0, key);
  }
  // Strictness is not just the schema's additionalProperties: the key rule fires on its own.
  const receipt = validReceipt("validated");
  receipt.checks.push({ id: "c", status: "pass", observed_at: "2026-01-01T00:00:00Z", evidence_ref: null, scope: "s" });
  receipt.checks[0].token = "x";
  assert.ok(has(errorsOf(receipt), "forbidden") || has(errorsOf(receipt), "unknown key"));
});

test("verified with any required check not pass (or missing) is rejected", () => {
  for (const status of ["unknown", "blocked", "skipped", "fail"]) {
    const receipt = validReceipt("verified");
    receipt.checks.find((c) => c.id === "private-destination-delivery").status = status;
    assert.ok(has(errorsOf(receipt), "private-destination-delivery"), status);
  }
  const missing = validReceipt("verified");
  missing.checks = missing.checks.filter((c) => c.id !== "untrusted-input-boundary");
  assert.ok(has(errorsOf(missing), "missing"));
  const unresolved = validReceipt("verified");
  unresolved.unresolved = ["env-boundary"];
  assert.equal(validateReceipt(unresolved).valid, false);
  const incomplete = validReceipt("verified");
  incomplete.apply.completed = false;
  assert.equal(validateReceipt(incomplete).valid, false);
  assert.deepEqual(errorsOf(validReceipt("verified")), []);
});

test("the required-check list can be narrowed only by the caller, and defaults to the schema's seven", () => {
  const receipt = validReceipt("verified");
  receipt.checks = receipt.checks.filter((c) => c.id !== "env-boundary");
  assert.equal(validateReceipt(receipt).valid, false);
  assert.equal(validateReceipt(receipt, { requiredChecks: contract.required_checks.filter((id) => id !== "env-boundary") }).valid, true);
});

test("restored_verified requires recovery.restoration_verified, and only that state may claim it", () => {
  const receipt = validReceipt("restored_verified");
  receipt.recovery.restoration_verified = false;
  assert.ok(has(errorsOf(receipt), "restoration_verified"));
  const other = validReceipt("manual_recovery_required");
  other.recovery.restoration_verified = true;
  assert.ok(has(errorsOf(other), "restoration_verified"));
  const verified = validReceipt("verified");
  verified.recovery.restoration_verified = true;
  assert.equal(validateReceipt(verified).valid, false);
});

test("changes_applied before applied_unverified is rejected; applied states must record the write-ahead", () => {
  for (const state of ["validated", "inspected", "change_reviewed", "staged"]) {
    const receipt = validReceipt(state);
    receipt.changes_applied = true;
    assert.ok(has(errorsOf(receipt), "changes_applied"), state);
  }
  const noFlag = validReceipt("applied_unverified");
  noFlag.changes_applied = false;
  assert.ok(has(errorsOf(noFlag), "changes_applied:true"));
  const noStart = validReceipt("applied_unverified");
  noStart.apply.started = false;
  assert.equal(validateReceipt(noStart).valid, false);
  const early = validReceipt("staged");
  early.apply.started = true;
  assert.equal(validateReceipt(early).valid, false);
  const noBackup = validReceipt("applied_unverified");
  noBackup.recovery.backup_ref = null;
  assert.ok(has(errorsOf(noBackup), "backup"));
  const skipped = validReceipt("applied_unverified");
  skipped.transitions = skipped.transitions.filter((t) => t.to !== "applied_unverified");
  assert.equal(validateReceipt(skipped).valid, false);
});

test("blocked receipts: blocked_reason is pre-apply only and requires changes_applied:false", () => {
  const blocked = validReceipt("validated");
  blocked.blocked_reason = "runtime_version_mismatch";
  assert.deepEqual(errorsOf(blocked), []);
  for (const reason of ["incomplete_transaction:abcd1234", "skill_collision:platform-telegram", "precondition_conflict:changed_since_backup", "invalid_blueprint"]) {
    blocked.blocked_reason = reason;
    assert.deepEqual(errorsOf(blocked), [], reason);
  }
  blocked.blocked_reason = "Not A Machine Code!";
  assert.equal(validateReceipt(blocked).valid, false);
  const applied = validReceipt("applied_unverified");
  applied.blocked_reason = "runtime_unknown";
  assert.equal(validateReceipt(applied).valid, false);
});

test("transition chains must start at `start`, be contiguous, legal, and end at the current state", () => {
  const gap = validReceipt("staged");
  gap.transitions.splice(1, 1);
  assert.equal(validateReceipt(gap).valid, false);
  const mismatch = validReceipt("staged");
  mismatch.state = "verified";
  assert.equal(validateReceipt(mismatch).valid, false);
  const illegal = validReceipt("verified");
  illegal.transitions[illegal.transitions.length - 1] = { from: "applied_unverified", to: "restored_verified", at: "2026-01-01T00:00:00Z" };
  assert.equal(validateReceipt(illegal).valid, false);
});

test("opaque references: evidence_ref is a bare name, backup_ref is bk_<txn>", () => {
  for (const ref of ["/etc/passwd", "../x", "a/b.txt", "~/.hermes/.env", ".hidden"]) {
    const receipt = validReceipt("validated");
    receipt.checks.push({ id: "c", status: "pass", observed_at: "2026-01-01T00:00:00Z", evidence_ref: ref, scope: "s" });
    assert.equal(validateReceipt(receipt).valid, false, ref);
  }
  const badBackup = validReceipt("applied_unverified");
  badBackup.recovery.backup_ref = "/home/u/.hermes/.hstack/txn/abcd1234efgh";
  assert.equal(validateReceipt(badBackup).valid, false);
  const wrongTxn = validReceipt("applied_unverified");
  wrongTxn.recovery.backup_ref = "bk_zzzzzzzzzzzz";
  assert.ok(has(errorsOf(wrongTxn), "bk_<txn_id>"));
  const dup = validReceipt("validated");
  const check = { id: "c", status: "pass", observed_at: "2026-01-01T00:00:00Z", evidence_ref: null, scope: "s" };
  dup.checks.push(check, { ...check });
  assert.ok(has(errorsOf(dup), "duplicate check"));
});

test("duplicate JSON keys are rejected in receipt text (JSON.parse would keep the last silently)", () => {
  const good = JSON.stringify(validReceipt("validated"));
  assert.equal(validateReceiptText(good).valid, true);
  const dupTop = good.replace('"state":"validated"', '"state":"validated","state":"verified"');
  assert.equal(JSON.parse(dupTop).state, "verified", "premise: plain JSON.parse hides the duplicate");
  const topResult = validateReceiptText(dupTop);
  assert.equal(topResult.valid, false);
  assert.ok(has(topResult.errors, "duplicate"));
  const dupNested = good.replace('"restoration_verified":false', '"restoration_verified":false,"restoration_verified":true');
  assert.equal(validateReceiptText(dupNested).valid, false);
  assert.deepEqual(findDuplicateKeys('{"a":{"b":1},"c":{"b":2}}'), [], "same key in different objects is fine");
  assert.deepEqual(findDuplicateKeys('{"a":"x\\",\\"a\\":1"}'), [], "keys inside string values are not keys");
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate/);
  assert.equal(validateReceiptText("{not json").valid, false);
});

test("canonical JSON: sorted keys, no whitespace, stable hash independent of key order", () => {
  assert.equal(canonicalJson({ b: [2, { z: 1, a: null }], a: "x" }), '{"a":"x","b":[2,{"a":null,"z":1}]}');
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
  assert.notEqual(canonicalHash({ a: 1, b: 2 }), canonicalHash({ a: 1, b: 3 }));
  assert.throws(() => canonicalJson({ a: undefined }), TypeError);
  assert.throws(() => canonicalJson({ a: Number.NaN }), TypeError);
  assert.throws(() => canonicalJson({ a: () => 1 }), TypeError);
  assert.throws(() => canonicalJson({ a: new Date() }), TypeError);
});

test("destination fingerprint is the first 16 hex of sha256('telegram:'+id) and never the raw id", () => {
  const fp = destinationFingerprint("555000111");
  assert.equal(fp, fingerprint("555000111"));
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp.includes("555000111"), false);
  assert.notEqual(fp, destinationFingerprint("555000112"));
});

test("receipts are written atomically with mode 600 in a 700 directory; invalid receipts are never written", { skip: process.platform === "win32" ? "skipped: POSIX modes" : false }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hstack-receipt-"));
  try {
    const file = path.join(root, "txn", "receipt.json");
    writeReceiptAtomic(file, validReceipt("validated"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(path.dirname(file)), ["receipt.json"], "no temp file left behind");
    assert.equal(readReceipt(file).state, "validated");

    // Rewrite keeps mode 600 and replaces content wholesale.
    const next = validReceipt("inspected");
    writeReceiptAtomic(file, next);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).state, "inspected");

    // An invalid receipt (secret shape) throws and leaves the previous file intact.
    const bad = validReceipt("inspected");
    bad.checks.push({ id: "c", status: "pass", observed_at: "2026-01-01T00:00:00Z", evidence_ref: null, scope: "s", detail: ["g", "hp_", "Z".repeat(30)].join("") });
    assert.throws(() => writeReceiptAtomic(file, bad), ReceiptInvalid);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).state, "inspected");
    assert.equal(readFileSync(file, "utf8").includes("Z".repeat(30)), false);
    assert.deepEqual(readdirSync(path.dirname(file)), ["receipt.json"]);

    // A permissive umask in the caller does not widen the mode.
    const old = process.umask(0o000);
    try {
      writeReceiptAtomic(path.join(root, "other", "r.json"), validReceipt("validated"));
    } finally {
      process.umask(old);
    }
    assert.equal(statSync(path.join(root, "other", "r.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readReceipt refuses a tampered file on disk", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hstack-receipt-"));
  try {
    const file = path.join(root, "r.json");
    const receipt = validReceipt("verified");
    receipt.checks[0].status = "unknown";
    writeFileSync(file, JSON.stringify(receipt));
    assert.throws(() => readReceipt(file), ReceiptInvalid);
    assert.equal(existsSync(file), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- stricter `verified` (F4) ---------------------------------------------------------------------

test("verified rejects ANY check that is fail/blocked/unknown, not only the required ones", () => {
  for (const status of ["fail", "blocked", "unknown"]) {
    const receipt = validReceipt("verified");
    receipt.checks.push({ id: "staging", status, observed_at: "2026-01-01T00:00:00Z", evidence_ref: null, scope: "target-state" });
    assert.ok(has(errorsOf(receipt), `check staging with status ${status}`), status);
  }
  const extraPass = validReceipt("verified");
  extraPass.checks.push({ id: "staging", status: "pass", observed_at: "2026-01-01T00:00:00Z", evidence_ref: null, scope: "target-state" });
  assert.deepEqual(errorsOf(extraPass), []);
});

test("verified allows `skipped` only for target-os and only on a simulated transport", () => {
  const skipped = (id, transport) => {
    const receipt = validReceipt("verified");
    receipt.target_profile.transport_used = transport;
    receipt.checks.push({ id, status: "skipped", observed_at: "2026-01-01T00:00:00Z", evidence_ref: null, scope: "target-state" });
    return errorsOf(receipt);
  };
  assert.deepEqual(skipped("target-os", "sandbox"), []);
  assert.deepEqual(skipped("target-os", "recording"), []);
  assert.ok(has(skipped("target-os", "ssh"), "skipped"), "a real ssh run may not skip the OS check");
  assert.ok(has(skipped("staging", "sandbox"), "skipped"), "no other check may be skipped");
  const requiredSkipped = validReceipt("verified");
  requiredSkipped.checks.find((c) => c.id === "env-boundary").status = "skipped";
  assert.equal(validateReceipt(requiredSkipped).valid, false);
});

test("verified needs the delivery check to come from the observer and to carry evidence", () => {
  const wrongScope = validReceipt("verified");
  wrongScope.checks.find((c) => c.id === "private-destination-delivery").scope = "target-state";
  assert.ok(has(errorsOf(wrongScope), "scope delivery-observer"));
  const noEvidence = validReceipt("verified");
  noEvidence.checks.find((c) => c.id === "private-destination-delivery").evidence_ref = null;
  assert.ok(has(errorsOf(noEvidence), "evidence_ref"));
});

test("verified needs an observed runtime version and every recorded apply op ok", () => {
  const unknownRuntime = validReceipt("verified");
  unknownRuntime.runtime_version = "unknown";
  assert.ok(has(errorsOf(unknownRuntime), "runtime_version"));
  for (const status of ["pending", "failed", "unknown", "skipped"]) {
    const receipt = validReceipt("verified");
    receipt.apply.ops[0].status = status;
    assert.ok(has(errorsOf(receipt), "apply op"), status);
  }
  const noOps = validReceipt("verified");
  noOps.apply.ops = [];
  assert.ok(has(errorsOf(noOps), "apply ops"));
});

test("restored_verified requires both a passing restoration and a passing gateway-reloaded check", () => {
  for (const id of ["restoration", "gateway-reloaded"]) {
    const missing = validReceipt("restored_verified");
    missing.checks = missing.checks.filter((c) => c.id !== id);
    assert.ok(has(errorsOf(missing), id), `${id} missing`);
    const failed = validReceipt("restored_verified");
    failed.checks.find((c) => c.id === id).status = "fail";
    assert.ok(has(errorsOf(failed), id), `${id} failed`);
  }
});

test("receipts past change_reviewed must record the reviewed artifact digests", () => {
  for (const state of ["change_reviewed", "staged", "applied_unverified", "verified", "restored_verified"]) {
    const receipt = validReceipt(state);
    delete receipt.artifacts;
    assert.ok(has(errorsOf(receipt), "artifacts"), state);
  }
  const bad = validReceipt("staged");
  bad.artifacts.script_sha256 = "short";
  assert.equal(validateReceipt(bad).valid, false);
  bad.artifacts = validReceipt("staged").artifacts;
  bad.artifacts.skills = [];
  assert.equal(validateReceipt(bad).valid, false);
  assert.equal(validateReceipt(validReceipt("inspected")).valid, true, "artifacts are optional before review");
});

test("the receipt records that the adapter surface is declared-unverified", () => {
  const receipt = validReceipt("validated");
  assert.equal(receipt.target_profile.adapter_surface, "declared-unverified-against-real-hermes");
  receipt.target_profile.adapter_surface = "verified-against-real-hermes";
  assert.equal(validateReceipt(receipt).valid, false);
});

test("more secret shapes are rejected (sk-ant-, long sk-, xapp-, AIza), assembled at runtime", () => {
  const shapes = {
    anthropic: ["sk", "-ant-", "api03-", "A".repeat(24)].join(""),
    genericSk: ["sk", "-", "B".repeat(40)].join(""),
    xapp: ["xa", "pp-", "1-A0123456789-", "C".repeat(12)].join(""),
    google: ["AI", "za", "D".repeat(24)].join(""),
  };
  for (const [name, secret] of Object.entries(shapes)) {
    assert.equal(looksLikeSecret(secret), true, name);
    const receipt = validReceipt("validated");
    receipt.checks.push({ id: "x", status: "pass", observed_at: "2026-01-01T00:00:00Z", evidence_ref: null, scope: "t", detail: `leaked ${secret}` });
    assert.ok(has(errorsOf(receipt), "secret shape"), name);
  }
  assert.equal(looksLikeSecret("sk-short"), false, "short sk- strings are ordinary words");
  assert.equal(looksLikeSecret("risk-assessment-for-the-quarterly-planning-review-meeting"), false, "a hyphenated word is not an sk- key");
});
