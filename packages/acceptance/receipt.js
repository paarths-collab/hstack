// Receipt construction, validation, canonical hashing and atomic persistence.
//
// A receipt is a secret-free JSON attestation of ONE acceptance transaction. The JSON schema
// file (schema/receipt.schema.json) is the single source for enums and required keys; this module
// evaluates it with a small built-in subset validator (no dependencies) and then applies the
// cross-field rules a schema cannot express.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, chmodSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canTransition, isAtLeast } from "./states.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(here, "schema", "receipt.schema.json");

let schemaCache = null;
export function loadSchema() {
  if (schemaCache === null) {
    schemaCache = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  }
  return schemaCache;
}

export class ReceiptInvalid extends Error {
  constructor(errors) {
    super(`receipt invalid: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? "; ..." : ""}`);
    this.name = "ReceiptInvalid";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------------------------
// hashing / canonical JSON
// ---------------------------------------------------------------------------------------------

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Canonical JSON: keys sorted at every depth, no whitespace. Rejects values JSON cannot carry faithfully. */
export function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonicalJson: only plain objects are allowed");
      }
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function canonicalHash(value) {
  return sha256Hex(canonicalJson(value));
}

/** Hash of a whole receipt (canonical form); useful for pinning a receipt from outside. */
export function receiptHash(receipt) {
  return canonicalHash(receipt);
}

/** sha256("telegram:" + chat_id), first 16 hex. The raw chat id never enters a receipt. */
export function destinationFingerprint(chatId) {
  return sha256Hex(`telegram:${chatId}`).slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// secret shapes
// ---------------------------------------------------------------------------------------------

// First three mirror SECRET_PATTERNS in skills/blueprint-install/scripts/validate_blueprint.py.
export const SECRET_PATTERNS = Object.freeze([
  /\b(?:sk_live|sk-proj|ghp|xoxb)-?[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{28,}\b/,
  // Telegram bot token shape.
  /\d{6,}:[A-Za-z0-9_-]{30,}/,
  // Prefix families, deliberately looser than the Python gate (a short remainder is still a leak signal).
  /github_pat_[A-Za-z0-9_]{8,}/,
  /gh[pousr]_[A-Za-z0-9]{8,}/,
  /xox[abprs]-[A-Za-z0-9-]{6,}/,
  /xapp-[A-Za-z0-9-]{8,}/,
  /sk-ant-[A-Za-z0-9_-]{16,}/,
  /\bsk-[A-Za-z0-9_-]{32,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
]);

export function looksLikeSecret(text) {
  return typeof text === "string" && SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function forbiddenKeyWords() {
  return new Set(loadSchema()["x-hstack"].forbidden_key_words);
}

function keyIsForbidden(key) {
  const words = forbiddenKeyWords();
  const segments = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return segments.some((segment) => words.has(segment)) || words.has(String(key).toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// strict JSON (duplicate keys are an error; JSON.parse silently keeps the last one)
// ---------------------------------------------------------------------------------------------

export function findDuplicateKeys(text) {
  const duplicates = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      const token = text.slice(i, j + 1);
      const top = stack[stack.length - 1];
      if (top && top.type === "object" && top.expectKey) {
        const key = JSON.parse(token);
        if (top.keys.has(key)) duplicates.push(key);
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === "{") stack.push({ type: "object", keys: new Set(), expectKey: true });
    else if (ch === "[") stack.push({ type: "array" });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top && top.type === "object") top.expectKey = true;
    }
    i += 1;
  }
  return duplicates;
}

/** JSON.parse that throws on duplicate object keys. */
export function parseStrictJson(text) {
  const value = JSON.parse(text);
  const duplicates = findDuplicateKeys(text);
  if (duplicates.length > 0) {
    throw new SyntaxError(`duplicate JSON key: ${duplicates[0]}`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// minimal JSON-schema subset evaluator (type, enum, const, pattern, min/maxLength, min/maxItems,
// required, properties, additionalProperties:false, items)
// ---------------------------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

export function evaluateSchema(value, schema, at, errors) {
  if (schema === undefined) return;
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: not one of the allowed values`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${at}: must be ${types.join(" or ")}`);
      return;
    }
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match the required pattern`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: too long`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: too many items`);
    if (schema.items) value.forEach((item, index) => evaluateSchema(item, schema.items, `${at}[${index}]`, errors));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required`);
    }
    const properties = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) {
        evaluateSchema(value[key], properties[key], `${at}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}.${key}: unknown key`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

function walkStrings(value, at, visit) {
  if (typeof value === "string") {
    visit(value, at, false);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${at}[${index}]`, visit));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visit(key, `${at}.${key}`, true);
      walkStrings(child, `${at}.${key}`, visit);
    }
  }
}

/**
 * Validate a parsed receipt object. Returns { valid, errors }.
 * options.requiredChecks overrides the schema's verified_requires_checks list.
 */
export function validateReceipt(receipt, options = {}) {
  const schema = loadSchema();
  const meta = schema["x-hstack"];
  const errors = [];

  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, errors: ["receipt: must be an object"] };
  }

  evaluateSchema(receipt, schema, "receipt", errors);
  const structurallySound = errors.length === 0;

  // Secret shapes and forbidden key names anywhere in the document, keys included.
  walkStrings(receipt, "receipt", (text, at, isKey) => {
    if (looksLikeSecret(text)) errors.push(`${at}: ${isKey ? "key" : "value"} matches a secret shape`);
    if (isKey && keyIsForbidden(text)) errors.push(`${at}: key name is forbidden in a receipt`);
  });

  // Cross-field rules only make sense once the structure is sound.
  if (!structurallySound) {
    return { valid: false, errors };
  }

  const { state } = receipt;
  const required = options.requiredChecks ?? meta.verified_requires_checks;
  const appliedStates = meta.applied_states;

  if (receipt.changes_applied && !isAtLeast(state, "applied_unverified")) {
    errors.push("changes_applied is true while state is before applied_unverified");
  }
  if (!receipt.changes_applied && appliedStates.includes(state)) {
    errors.push(`state ${state} requires changes_applied:true (write-ahead is recorded before the first live mutation)`);
  }
  if (appliedStates.includes(state) && !receipt.apply.started) {
    errors.push(`state ${state} requires apply.started:true`);
  }
  if (!appliedStates.includes(state) && (receipt.apply.started || receipt.apply.completed)) {
    errors.push(`apply.started/completed must be false before applied_unverified (state ${state})`);
  }
  if (receipt.apply.completed && !receipt.apply.started) {
    errors.push("apply.completed without apply.started");
  }
  if (receipt.blocked_reason !== null && appliedStates.includes(state)) {
    errors.push("blocked_reason is only meaningful before apply; record post-apply problems as checks");
  }
  if (receipt.blocked_reason !== null && receipt.changes_applied) {
    errors.push("blocked_reason requires changes_applied:false");
  }
  if (appliedStates.includes(state) && receipt.recovery.backup_ref === null) {
    errors.push("a receipt past staging must reference its backup (recovery.backup_ref)");
  }
  if (receipt.recovery.backup_ref !== null && receipt.recovery.backup_ref !== `bk_${receipt.txn_id}`) {
    errors.push("recovery.backup_ref must equal bk_<txn_id>");
  }

  // transitions must form a legal chain from `start` ending at `state`.
  let previous = meta.initial_state;
  receipt.transitions.forEach((transition, index) => {
    if (transition.from !== previous) {
      errors.push(`transitions[${index}] starts at ${transition.from} but the previous step ended at ${previous}`);
    }
    previous = transition.to;
  });
  if (previous !== state) errors.push(`state ${state} does not match the last transition target ${previous}`);
  receipt.transitions.forEach((transition, index) => {
    if (!canTransition(transition.from, transition.to)) errors.push(`transitions[${index}] ${transition.from} -> ${transition.to} is not a legal transition`);
  });
  // changes_applied cannot be true unless the transition into applied_unverified is recorded.
  if (receipt.changes_applied && !receipt.transitions.some((t) => t.to === "applied_unverified")) {
    errors.push("changes_applied:true without a recorded transition to applied_unverified");
  }

  const byId = new Map();
  for (const check of receipt.checks) {
    if (byId.has(check.id)) errors.push(`duplicate check id ${check.id}`);
    byId.set(check.id, check);
  }

  if (state === "verified") {
    if (!receipt.apply.completed) errors.push("verified requires apply.completed:true");
    for (const id of required) {
      const check = byId.get(id);
      if (!check) errors.push(`verified requires check ${id}, which is missing`);
      else if (check.status !== "pass") errors.push(`verified requires check ${id} to pass (it is ${check.status})`);
    }
    // Stricter than the required list: no check of any kind may be fail/blocked/unknown, and `skipped` is
    // allowed only where the schema says so and only on a simulated transport.
    const simulated = meta.simulated_transports.includes(receipt.target_profile.transport_used);
    for (const check of receipt.checks) {
      if (["fail", "blocked", "unknown"].includes(check.status)) errors.push(`verified must not carry check ${check.id} with status ${check.status}`);
      if (check.status === "skipped" && !(meta.skipped_allowed_checks.includes(check.id) && simulated)) {
        errors.push(`verified must not carry check ${check.id} as skipped`);
      }
    }
    const delivery = byId.get(meta.delivery_check.id);
    if (delivery) {
      if (delivery.scope !== meta.delivery_check.scope) errors.push(`verified requires ${delivery.id} to have scope ${meta.delivery_check.scope}`);
      if (delivery.evidence_ref === null) errors.push(`verified requires ${delivery.id} to carry an evidence_ref`);
    }
    if (receipt.runtime_version === "unknown") errors.push("verified requires an observed runtime_version");
    if (receipt.apply.ops.length === 0) errors.push("verified requires recorded apply ops");
    for (const op of receipt.apply.ops) {
      if (op.status !== "ok") errors.push(`verified requires apply op ${op.op_id} to be ok (it is ${op.status})`);
    }
    if (receipt.recovery.restoration_verified) errors.push("verified must not claim restoration_verified");
    if ((receipt.unresolved ?? []).length > 0) errors.push("verified must have no unresolved checks");
  }
  if (isAtLeast(state, meta.artifacts_required_from) && !receipt.artifacts) {
    errors.push(`a receipt in state ${state} must record the reviewed artifact digests (artifacts)`);
  }
  if (state === "restored_verified") {
    for (const id of meta.restored_requires_checks) {
      if (byId.get(id)?.status !== "pass") errors.push(`restored_verified requires check ${id} to pass`);
    }
  }
  if (state === "restored_verified" && receipt.recovery.restoration_verified !== true) {
    errors.push("restored_verified requires recovery.restoration_verified:true");
  }
  if (state !== "restored_verified" && receipt.recovery.restoration_verified === true) {
    errors.push("recovery.restoration_verified:true is only valid in state restored_verified");
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidReceipt(receipt, options) {
  const result = validateReceipt(receipt, options);
  if (!result.valid) throw new ReceiptInvalid(result.errors);
  return receipt;
}

/** Parse + validate receipt text, including the duplicate-key rule. */
export function validateReceiptText(text, options) {
  let parsed;
  try {
    parsed = parseStrictJson(text);
  } catch (error) {
    return { valid: false, errors: [`receipt: ${error.message}`], receipt: null };
  }
  return { ...validateReceipt(parsed, options), receipt: parsed };
}

// ---------------------------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------------------------

export function newReceipt({
  txnId, recipe, planHash, contractHash, destinationFingerprint: fingerprint, adapterVersions,
  targetProfile, deliverySemantics, scopeNote, now,
}) {
  return {
    schema_version: 1,
    txn_id: txnId,
    recipe,
    plan_hash: planHash,
    contract_hash: contractHash,
    runtime_version: "unknown",
    adapter_versions: { ...adapterVersions },
    target_profile: { ...targetProfile },
    state: "validated",
    changes_applied: false,
    blocked_reason: null,
    transitions: [{ from: "start", to: "validated", at: now }],
    checks: [],
    apply: { started: false, completed: false, ops: [] },
    recovery: { backup_ref: null, restoration_verified: false, external_effects: [] },
    destination_fingerprint: fingerprint,
    delivery_semantics: deliverySemantics,
    scope_note: scopeNote,
    created_at: now,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------------------------
// persistence: tmp + rename, mode 600, directories 700
// ---------------------------------------------------------------------------------------------

export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write `text` to `file` atomically with mode 600 (tmp file in the same directory, fsync, rename). */
export function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
  closeSync(fd);
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Validate, then write. An invalid receipt is never written. */
export function writeReceiptAtomic(file, receipt, options) {
  assertValidReceipt(receipt, options);
  writeFileAtomic(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

export function readReceipt(file, options) {
  const result = validateReceiptText(readFileSync(file, "utf8"), options);
  if (!result.valid) throw new ReceiptInvalid(result.errors);
  return result.receipt;
}
