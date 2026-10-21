// The acceptance transaction: validate -> inspect -> review -> stage -> apply -> verify, with
// write-ahead persistence, rollback, and a receipt that never says more than was observed.
//
// Honesty rules enforced here:
//  * `applied_unverified` is persisted BEFORE the first live mutation (write-ahead).
//  * Delivery cannot be proven without an observer: no observer => check `unknown` => never `verified`.
//  * A transport failure (unknown outcome) never advances state; it throws TransportError.
//  * Secrets exist only in memory and on stdin; every string that reaches a receipt/evidence file is redacted.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, contractHash, runtimeVersionSupported } from "./contract.js";
import {
  buildSkillsTar, describeOp, opApply, opBackup, opCommit, opHelperVerify, opInspect, opInstallHelper,
  opPurge, opPutEnv, opReload, opRestore, opSkillsSync, opStageCheck, opVerify, skillsTreeHash,
} from "./ops.js";
import {
  SECRET_PATTERNS, assertValidReceipt, newReceipt, readReceipt, sha256Hex, writeFileAtomic, writeReceiptAtomic,
} from "./receipt.js";
import { IllegalTransition, MAY_HAVE_APPLIED, assertTransition } from "./states.js";
import { TransportError } from "./transports.js";
import {
  BlueprintRejected, deriveExecutionGraph, describeBlueprintForDisplay, planHash, renderUntrustedText, sanitizeLine, validateOperatorInput,
} from "./untrusted.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCRIPT_PATH = path.join(here, "target", "hstack-target.sh");
export const DEFAULT_SKILLS_ROOT = path.join(REPO_ROOT, "skills");
export const VALIDATOR_PATH = path.join(REPO_ROOT, "skills", "blueprint-install", "scripts", "validate_blueprint.py");

export class TransactionError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "TransactionError";
    this.code = code;
  }
}
export class ApprovalError extends TransactionError {
  constructor() {
    super("approval_mismatch", "approval must quote the exact plan_hash of the reviewed change set");
    this.name = "ApprovalError";
  }
}
export class TargetScriptMissing extends TransactionError {
  constructor(file) {
    super("target_script_missing", `target script not found: ${path.basename(file)}`);
    this.name = "TargetScriptMissing";
  }
}
export class ValidatorUnavailable extends TransactionError {
  constructor(message) {
    super("validator_unavailable", message);
    this.name = "ValidatorUnavailable";
  }
}

// ---------------------------------------------------------------------------------------------
// the structural gate: the existing Python blueprint validator
// ---------------------------------------------------------------------------------------------

/** [command, ...prefixArgs] of the first interpreter that runs and reports Python 3; HSTACK_PYTHON is the only candidate when set. */
export function resolvePython3() {
  const override = process.env.HSTACK_PYTHON;
  const candidates = override ? [[override]] : [["python3"], ["python"], ["py", "-3"]];
  for (const [command, ...prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, "--version"], { encoding: "utf8", stdio: "pipe" });
    if (probe.error || probe.status !== 0) continue;
    if (/^Python 3\./.test(`${probe.stdout}${probe.stderr}`.trim())) return [command, ...prefix];
  }
  throw new ValidatorUnavailable("Python 3 not found; the structural blueprint gate cannot run (set HSTACK_PYTHON)");
}

/** Runs the real validate_blueprint.py --json. Never skipped: a missing interpreter throws. */
export function validateBlueprintStructure(blueprint) {
  const [command, ...prefix] = resolvePython3();
  const dir = mkdtempSync(path.join(os.tmpdir(), "hstack-blueprint-"));
  try {
    const file = path.join(dir, "plan.hstack-blueprint.json");
    writeFileSync(file, `${JSON.stringify(blueprint, null, 2)}\n`, { mode: 0o600 });
    const run = spawnSync(command, [...prefix, "-I", VALIDATOR_PATH, file, "--json"], { encoding: "utf8", stdio: "pipe", timeout: 30_000 });
    if (run.error) throw new ValidatorUnavailable("the blueprint validator could not be executed");
    if (run.status === 0) {
      return { valid: true, errors: [], resolved_skills: JSON.parse(run.stdout).resolved_skills };
    }
    const errors = `${run.stderr}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("-") || line.startsWith("INVALID"));
    return { valid: false, errors: errors.length > 0 ? errors : ["INVALID"], resolved_skills: [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// small parsing helpers (target output is data, not instructions)
// ---------------------------------------------------------------------------------------------

export function parseKv(text) {
  const kv = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+)=(.*)$/.exec(line);
    if (match) kv[match[1]] = match[2];
  }
  return kv;
}

function splitList(value) {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "none" || trimmed === "-") return [];
  if (trimmed === "unknown") return null;
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

function normaliseVersion(raw) {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?)/.exec(raw ?? "");
  return match ? match[1] : "unknown";
}

function safeToken(raw) {
  return typeof raw === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(raw) ? raw : "unknown";
}

function safeReasonCode(raw, fallback) {
  return typeof raw === "string" && /^[a-z][a-z_]{0,48}(:[A-Za-z0-9_.,:-]{1,120})?$/.test(raw) ? raw : fallback;
}

const ENV_PREV = new Set(["present", "absent"]);

// ---------------------------------------------------------------------------------------------
// reviewable change set (pure: no network, no receipt)
// ---------------------------------------------------------------------------------------------

/**
 * Build the full ordered op list with exact commands (secrets redacted), expected previous state per op
 * and the recovery point. `inspection` may be null (CLI review before any contact with the target).
 */
export function buildReview({ blueprint, contract, operator, txnId, scriptBody = null, skillsRoot = DEFAULT_SKILLS_ROOT, inspection = null }) {
  const input = validateOperatorInput(contract, operator);
  const graph = deriveExecutionGraph(blueprint, contract, operator);
  const hash = planHash(graph);
  const placeholderValue = "PLACEHOLDER";
  const script = scriptBody ?? "";
  const scriptOps = (build) => (scriptBody ? build(script) : null);
  const keys = contract.managed_env_keys;
  const prevEnv = (key) => (inspection ? (inspection.env_keys.includes(key) ? "present" : "absent") : "unknown (target not inspected)");
  const prevSkill = (name) => {
    if (!inspection) return "unknown (target not inspected)";
    const managed = inspection.skills_managed.find((item) => item.name === name);
    if (managed) return `managed, sha256 ${managed.sha.slice(0, 12)}`;
    return inspection.skills_unmanaged.includes(name) ? "UNMANAGED directory present (would collide)" : "absent";
  };
  const prevCron = inspection
    ? (inspection.cron_managed_ids.includes(graph.schedule.id) ? "present (replaced only if different)" : "absent")
    : "unknown (target not inspected)";

  const ops = [];
  const add = (op_id, phase, op, expected_previous) => {
    const described = op ? describeOp(op) : { op: "(target script unavailable)", remote: "(unavailable)", stdin: null, mutates: "unknown" };
    ops.push({ op_id, phase, ...described, expected_previous });
  };

  const installHelper = scriptOps(opInstallHelper);
  add("helper:install", "staging", installHelper, "hstack-owned directory only; no user state is read or changed");
  add("helper:verify", "staging", opHelperVerify(), "n/a (read-only hash of the installed helper)");
  add("backup:create", "staging", opBackup({ txn: txnId, keys }), "no recovery point yet; a refusal if another transaction is incomplete");
  for (const key of keys) {
    const staged = opPutEnv({ txn: txnId, key, allow: keys, value: placeholderValue });
    ops.push({ op_id: `env:${key}`, phase: "staging", ...describeOp({ ...staged, redactedStdin: "<STDIN secret len=?>" }), expected_previous: prevEnv(key) });
  }
  add("stage:check", "staging", opStageCheck({ txn: txnId }), "staged copy only");
  let tar = null;
  try {
    tar = buildSkillsTar(skillsRoot, graph.managed_skills);
  } catch {
    tar = null;
  }
  add("skills:sync", "live", tar ? opSkillsSync({ txn: txnId, names: graph.managed_skills, tar }) : null,
    graph.managed_skills.map((name) => `${name}: ${prevSkill(name)}`).join("; "));
  add("config:apply", "live", opApply({ txn: txnId, cron: { id: graph.schedule.id, schedule: input.schedule, prompt: contract.schedule.prompt } }),
    `env swap for ${keys.join(", ")} and cron entry ${graph.schedule.id}: ${prevCron}`);
  add("gateway:reload", "live", opReload({ txn: txnId }), "gateway stop then run (never restart)");
  add("verify:target", "read", opVerify({
    txn: txnId, destinationFp: input.destinationFingerprint, allowVar: contract.destination.allow_var,
    destVar: contract.destination.env_key, cronId: graph.schedule.id, schedule: input.schedule, skills: graph.managed_skills,
  }), "target-state checks only; delivery is checked by an injected observer, never by the target");

  let skillDigests = null;
  try {
    skillDigests = graph.managed_skills.map((name) => ({ name, sha256: skillsTreeHash(skillsRoot, [name]) }));
  } catch {
    skillDigests = null;
  }
  return {
    recipe: contract.recipe,
    txn_id: txnId,
    plan_hash: hash,
    // Digests of what will actually be shipped. stage()/apply() refuse to proceed if the artifacts differ.
    artifacts: {
      script_sha256: scriptBody ? sha256Hex(scriptBody) : null,
      skills_tar_sha256: tar ? sha256Hex(tar) : null,
      skills: skillDigests,
    },
    contract_hash: contractHash(contract),
    destination_fingerprint: input.destinationFingerprint,
    recovery_point: `bk_${txnId}`,
    schedule: { id: graph.schedule.id, cron: input.schedule, prompt: contract.schedule.prompt },
    display: describeBlueprintForDisplay(blueprint),
    ops,
    notes: [
      "Blueprint text above is display-only and never influences these commands.",
      "Rollback restores only the managed env keys, managed skills and the managed cron entry, then reloads the gateway; it refuses to overwrite anything changed since apply.",
      "The helper script and the skills archive are pinned by sha256 at review; if either changes before staging/apply the transaction refuses to continue.",
      "A message already delivered to Telegram cannot be recalled by rollback.",
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------------------------

/** Test seam: `tx[EXEC_FOR_TESTS](op)` runs an op through the same guarded path as every internal call. */
export const EXEC_FOR_TESTS = Symbol("hstack.acceptance.exec-for-tests");

export class Transaction {
  #contract;
  #blueprint;
  #operator;
  #transport;
  #observer;
  #now;
  #dir;
  #scriptPath;
  #skillsRoot;
  #validator;
  #allowNonLinux;
  #receipt = null;
  #graph = null;
  #planHash = null;
  #inspection = null;
  #secrets = new Map();
  #evidenceSeq = 0;
  #inspectedScript = null;
  #preApplyRestoreAllowed = false;
  #cronStatus = "unknown";
  #approved = null;

  constructor(options) {
    const { blueprint, contract, operator, transport, receiptDir } = options ?? {};
    if (!blueprint || !contract || !transport || !receiptDir) {
      throw new TypeError("Transaction requires blueprint, contract, operator, transport and receiptDir");
    }
    this.#contract = contract;
    this.#blueprint = blueprint;
    this.#operator = validateOperatorInput(contract, operator);
    if (!["ssh", "sandbox", "recording"].includes(transport.kind)) {
      throw new TypeError("transport.kind must be 'ssh', 'sandbox' or 'recording' so a receipt can say whether the run was simulated");
    }
    this.#transport = transport;
    this.#observer = options.observer ?? null;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.txnId = options.txnId ?? randomBytes(6).toString("hex");
    if (!/^[a-z0-9]{8,32}$/.test(this.txnId)) throw new TypeError("txnId must match ^[a-z0-9]{8,32}$");
    this.#dir = path.join(receiptDir, this.txnId);
    this.#scriptPath = options.scriptPath ?? DEFAULT_SCRIPT_PATH;
    this.#skillsRoot = options.skillsRoot ?? DEFAULT_SKILLS_ROOT;
    this.#validator = options.validator ?? validateBlueprintStructure;
    this.#allowNonLinux = options.allowNonLinuxTarget === true;
  }

  // ---- read-only views -----------------------------------------------------------------------

  get state() {
    return this.#receipt ? this.#receipt.state : "start";
  }
  get receipt() {
    return this.#receipt ? structuredClone(this.#receipt) : null;
  }
  get receiptPath() {
    return path.join(this.#dir, "receipt.json");
  }
  get evidenceDir() {
    return path.join(this.#dir, "evidence");
  }
  get planHash() {
    return this.#planHash;
  }
  get inspection() {
    return this.#inspection ? structuredClone(this.#inspection) : null;
  }
  get destinationFingerprint() {
    return this.#operator.destinationFingerprint;
  }

  // ---- internals -----------------------------------------------------------------------------

  [EXEC_FOR_TESTS](op) {
    return this.#exec(op);
  }

  #requireState(operation, allowed) {
    if (this.#receipt?.blocked_reason === "abandoned") {
      throw new IllegalTransition(this.state, operation, "this transaction was abandoned and its staging closed on the target; start a new transaction");
    }
    if (!allowed.includes(this.state)) {
      throw new IllegalTransition(this.state, operation, `'${operation}' is only legal in: ${allowed.join(", ")}`);
    }
  }

  #redact(text) {
    let result = String(text ?? "");
    const values = [...this.#secrets.values(), this.#operator.chatId].filter((value) => typeof value === "string" && value.length >= 6);
    for (const value of values) result = result.split(value).join("[redacted]");
    for (const pattern of SECRET_PATTERNS) result = result.replace(new RegExp(pattern.source, "g"), "[redacted-shape]");
    return result;
  }

  /** Single-line, control-free, redacted, path-free text suitable for a receipt `detail`. */
  #safeText(text, max = 300) {
    let result = sanitizeLine(this.#redact(text));
    result = result.replace(/(?:\/[A-Za-z0-9._@+-]+){2,}/g, "<path>").replace(/~\/[A-Za-z0-9._/@+-]*/g, "<path>");
    return result.length > max ? `${result.slice(0, max - 1)}…` : result;
  }

  #assertArtifactUnchanged(what, reviewed, current) {
    if (reviewed !== current) {
      throw new TransactionError("artifact_changed",
        `${what} changed after it was reviewed (reviewed sha256 ${String(reviewed).slice(0, 12)}, now ${String(current).slice(0, 12)}); nothing was changed on the target; start a new transaction and review again`);
    }
  }

  #scriptBody() {
    if (!existsSync(this.#scriptPath)) throw new TargetScriptMissing(this.#scriptPath);
    return readFileSync(this.#scriptPath, "utf8");
  }

  #evidence(label, text) {
    let name;
    do {
      this.#evidenceSeq += 1;
      name = `${label.replace(/[^a-z0-9-]/g, "-")}-${this.#evidenceSeq}.txt`;
    } while (existsSync(path.join(this.#dir, "evidence", name)));
    writeFileAtomic(path.join(this.#dir, "evidence", name), `${this.#redact(text).trimEnd()}\n`);
    return name;
  }

  #requiredChecks() {
    return this.#contract.required_checks;
  }

  #save(mutator, historyLabel = null) {
    const next = structuredClone(this.#receipt);
    mutator(next);
    next.updated_at = this.#now();
    const options = { requiredChecks: this.#requiredChecks() };
    writeReceiptAtomic(path.join(this.#dir, "receipt.json"), next, options);
    if (historyLabel) {
      const name = `${String(next.transitions.length).padStart(2, "0")}-${historyLabel}.json`;
      writeReceiptAtomic(path.join(this.#dir, "history", name), next, options);
    }
    this.#receipt = next;
  }

  #move(next, to) {
    assertTransition(next.state, to);
    next.transitions.push({ from: next.state, to, at: this.#now() });
    next.state = to;
  }

  #setCheck(next, id, status, scope, detail, evidenceRef = null) {
    const entry = { id, status, observed_at: this.#now(), evidence_ref: evidenceRef, scope };
    if (detail) entry.detail = this.#safeText(detail, 480);
    const index = next.checks.findIndex((check) => check.id === id);
    if (index >= 0) next.checks[index] = entry;
    else next.checks.push(entry);
  }

  #setOp(next, opId, status) {
    const entry = next.apply.ops.find((op) => op.op_id === opId);
    if (entry) entry.status = status;
  }

  #assertWriteAhead(op) {
    const r = this.#receipt;
    const ok = r && MAY_HAVE_APPLIED.includes(r.state) && r.changes_applied === true && r.apply.started === true;
    if (!ok) throw new TransactionError("write_ahead_violation", `refusing live op '${op.op}': applied_unverified has not been persisted`);
  }

  async #exec(op) {
    if (op.mutates === "live" && !this.#preApplyRestoreAllowed) this.#assertWriteAhead(op);
    let result;
    try {
      result = await this.#transport.exec(op);
    } catch {
      throw new TransportError(`unknown outcome of '${op.op}': transport threw`);
    }
    if (result.transportError) {
      throw new TransportError(`unknown outcome of '${op.op}': transport failure; inspect the target before retrying`);
    }
    const stdout = this.#redact(result.stdout ?? "");
    const stderr = this.#redact(result.stderr ?? "");
    return { code: result.code, stdout, stderr, kv: parseKv(stdout) };
  }

  #block(reason, { check = null, detail = "", runtimeVersion = null } = {}) {
    this.#save((next) => {
      next.blocked_reason = reason;
      if (runtimeVersion) next.runtime_version = runtimeVersion;
      if (check) this.#setCheck(next, check.id, check.status, check.scope, check.detail ?? detail, check.evidence ?? null);
    });
    return { ok: false, state: this.state, blocked_reason: reason, changes_applied: false, detail: this.#safeText(detail) };
  }

  // ---- validate ------------------------------------------------------------------------------

  /** Structural gate (real Python validator) + execution-graph derivation. Writes the first receipt. */
  async validate() {
    this.#requireState("validate", ["start"]);
    if (existsSync(this.receiptPath)) throw new TransactionError("txn_exists", "a receipt for this transaction id already exists");
    const structural = await this.#validator(this.#blueprint);
    if (!structural.valid) {
      return { ok: false, state: "start", blocked_reason: "invalid_blueprint", errors: structural.errors.map((line) => renderUntrustedText(line)) };
    }
    let graph;
    try {
      graph = deriveExecutionGraph(this.#blueprint, this.#contract, this.#operator);
    } catch (error) {
      if (error instanceof BlueprintRejected) return { ok: false, state: "start", blocked_reason: "invalid_blueprint", errors: [error.message] };
      throw error;
    }
    this.#graph = graph;
    this.#planHash = planHash(graph);
    const contract = this.#contract;
    let telegramSkill = `${contract.adapters.telegram.skill}@unshipped`;
    try {
      telegramSkill = `${contract.adapters.telegram.skill}@sha256:${skillsTreeHash(this.#skillsRoot, [contract.adapters.telegram.skill]).slice(0, 12)}`;
    } catch { /* skill tree not available in this checkout: recorded as unshipped */ }
    const now = this.#now();
    const receipt = newReceipt({
      txnId: this.txnId,
      recipe: contract.recipe,
      planHash: this.#planHash,
      contractHash: contractHash(contract),
      destinationFingerprint: this.#operator.destinationFingerprint,
      adapterVersions: { github: contract.adapters.github.mcp_pkg, telegram: telegramSkill },
      targetProfile: {
        os: contract.target.os,
        shell: contract.target.shell,
        declared_transport: contract.target.transport,
        transport_used: this.#transport.kind,
        observed_os: "unknown",
        service_manager: "unknown",
        adapter_surface: contract.adapter_surface_status,
      },
      deliverySemantics: contract.delivery_semantics,
      scopeNote: contract.scope_note,
      now,
    });
    receipt.checks.push({
      id: "blueprint-structure", status: "pass", observed_at: now, evidence_ref: null, scope: "local-validator",
      detail: "validate_blueprint.py accepted the plan; execution graph derived from structural fields only",
    });
    const options = { requiredChecks: this.#requiredChecks() };
    writeReceiptAtomic(this.receiptPath, receipt, options);
    writeReceiptAtomic(path.join(this.#dir, "history", `01-validated.json`), receipt, options);
    this.#receipt = receipt;
    return { ok: true, state: this.state, plan_hash: this.#planHash, destination_fingerprint: this.destinationFingerprint };
  }

  // ---- inspect -------------------------------------------------------------------------------

  /** Strictly read-only inspection of the target. Blocked outcomes leave `state` unchanged. */
  async inspect() {
    this.#requireState("inspect", ["validated"]);
    const script = this.#scriptBody();
    this.#inspectedScript = script;
    const res = await this.#exec(opInspect(script));
    const evidence = this.#evidence("inspect", res.stdout);
    const kv = res.kv;

    if (res.code !== 0) {
      const reason = res.code === 4 ? safeReasonCode(kv.error, "target_blocked") : "inspect_failed";
      return this.#block(reason, {
        detail: `inspect exited ${res.code}: ${kv.error ?? ""} ${kv.detail ?? ""}`,
        check: { id: "runtime-version", status: "unknown", scope: "target-state", evidence, detail: "inspect did not complete; runtime version not measured" },
      });
    }

    const insp = {
      hermes_present: kv.hermes_present === "1",
      runtime_version: kv.hermes_present === "1" ? normaliseVersion(kv.runtime_version) : "unknown",
      runtime_evidence: safeToken(kv.runtime_evidence),
      os: safeToken(kv.os),
      service_manager: safeToken(kv.service_manager),
      env_keys: splitList(kv.env_keys) ?? [],
      cron_managed_ids: splitList(kv.cron_managed_ids),
      skills_unmanaged: splitList(kv.skills_unmanaged) ?? [],
      skills_managed: (splitList(kv.skills_managed) ?? []).map((pair) => {
        const [name, sha = ""] = pair.split(":");
        return { name, sha };
      }),
      skills_managed_modified: splitList(kv.skills_managed_modified) ?? [],
      txn_incomplete: splitList(kv.txn_incomplete) ?? [],
    };
    this.#inspection = insp;
    const contract = this.#contract;
    const profile = (next) => {
      next.target_profile.observed_os = insp.os;
      next.target_profile.service_manager = insp.service_manager;
    };

    // 1. target OS (a sandbox run on a non-Linux host must opt in explicitly and is recorded as skipped).
    if (insp.os !== contract.target.os) {
      if (!this.#allowNonLinux) {
        return this.#blockWith(profile, `unsupported_target:${insp.os}`, "target-os", "fail", `observed os '${insp.os}', contract requires ${contract.target.os}`, evidence);
      }
    }

    // 2. runtime version
    if (insp.runtime_version === "unknown") {
      return this.#blockWith(profile, "runtime_unknown", "runtime-version", "unknown",
        `hermes ${insp.hermes_present ? "present but its version could not be measured" : "not found on the target"}; no guess is made`, evidence, "unknown");
    }
    if (!runtimeVersionSupported(contract, insp.runtime_version)) {
      return this.#blockWith(profile, "runtime_version_mismatch", "runtime-version", "fail",
        `observed ${insp.runtime_version}, contract supports ${contract.runtime.supported_versions.join(",")}`, evidence, insp.runtime_version);
    }
    if (insp.cron_managed_ids === null) {
      return this.#blockWith(profile, "runtime_unknown", "runtime-version", "unknown", "cron list unreadable; target state cannot be established", evidence, insp.runtime_version);
    }
    // 3. earlier incomplete transaction
    if (insp.txn_incomplete.length > 0) {
      const id = /^[a-z0-9]{8,32}$/.test(insp.txn_incomplete[0]) ? insp.txn_incomplete[0] : "unknown";
      return this.#blockWith(profile, `incomplete_transaction:${id}`, "runtime-version", "pass",
        "an earlier transaction has no done/restored marker; resume or roll it back first", evidence, insp.runtime_version);
    }
    // 4. skill collisions / modified managed skills (all detectable without writing)
    const collision = this.#graph.managed_skills.find((name) => insp.skills_unmanaged.includes(name));
    if (collision) {
      return this.#blockWith(profile, `skill_collision:${collision}`, "runtime-version", "pass",
        "an unmanaged skill directory with a managed name exists; hstack will not overwrite it", evidence, insp.runtime_version);
    }
    const modified = this.#graph.managed_skills.find((name) => insp.skills_managed_modified.includes(name));
    if (modified) {
      return this.#blockWith(profile, "precondition_conflict:managed_skill_modified", "runtime-version", "pass",
        `managed skill '${modified}' was modified after hstack installed it`, evidence, insp.runtime_version);
    }

    this.#save((next) => {
      profile(next);
      next.runtime_version = insp.runtime_version;
      next.blocked_reason = null;
      this.#setCheck(next, "runtime-version", "pass", "target-state", `hermes ${insp.runtime_version} (${insp.runtime_evidence})`, evidence);
      if (insp.os !== contract.target.os) {
        this.#setCheck(next, "target-os", "skipped", "target-state", `observed '${insp.os}'; non-linux target permitted only by explicit sandbox configuration`, evidence);
      } else {
        this.#setCheck(next, "target-os", "pass", "target-state", `observed ${insp.os}`, evidence);
      }
      this.#move(next, "inspected");
    }, "inspected");
    return { ok: true, state: this.state, runtime_version: insp.runtime_version };
  }

  #blockWith(profile, reason, checkId, status, detail, evidence, runtimeVersion = null) {
    this.#save((next) => {
      profile(next);
      next.blocked_reason = reason;
      if (runtimeVersion) next.runtime_version = runtimeVersion;
      this.#setCheck(next, checkId, status, "target-state", detail, evidence);
    });
    return { ok: false, state: this.state, blocked_reason: reason, changes_applied: false, detail: this.#safeText(detail) };
  }

  // ---- review --------------------------------------------------------------------------------

  /** Pure preview of the change set; does not change state. */
  previewChanges() {
    return buildReview({
      blueprint: this.#blueprint,
      contract: this.#contract,
      operator: this.#operator,
      txnId: this.txnId,
      scriptBody: existsSync(this.#scriptPath) ? readFileSync(this.#scriptPath, "utf8") : null,
      skillsRoot: this.#skillsRoot,
      inspection: this.#inspection,
    });
  }

  /**
   * `approve(review)` must resolve to the exact plan_hash of the review (quote it), or this throws.
   * On success the state becomes change_reviewed.
   */
  async reviewChanges(approve) {
    this.#requireState("reviewChanges", ["inspected"]);
    if (typeof approve !== "function") throw new ApprovalError();
    const review = this.previewChanges();
    const quoted = await approve(structuredClone(review));
    if (typeof quoted !== "string" || quoted !== review.plan_hash) throw new ApprovalError();
    const { artifacts } = review;
    if (!artifacts.script_sha256 || !artifacts.skills_tar_sha256 || !artifacts.skills) {
      throw new TransactionError("artifact_unavailable", "the target script or a managed skill directory is not available, so there is nothing reproducible to approve");
    }
    this.#approved = structuredClone(artifacts);
    this.#save((next) => {
      next.artifacts = structuredClone(artifacts);
      this.#setCheck(next, "change-review", "pass", "operator", `operator approved plan_hash ${review.plan_hash.slice(0, 12)}`);
      this.#move(next, "change_reviewed");
    }, "change_reviewed");
    return review;
  }

  // ---- stage ---------------------------------------------------------------------------------

  #validateValues(values) {
    const contract = this.#contract;
    const destKey = contract.destination.env_key;
    const expected = contract.managed_env_keys.filter((key) => key !== destKey);
    if (values === null || typeof values !== "object") throw new TypeError("stage() requires the secret values object");
    const map = new Map();
    for (const key of Object.keys(values)) {
      if (!expected.includes(key) && key !== destKey) throw new TransactionError("unexpected_secret_key", `'${key}' is not a managed env key`);
    }
    for (const key of expected) {
      if (typeof values[key] !== "string" || values[key].length === 0) throw new TransactionError("missing_secret_value", `a value for ${key} is required`);
      map.set(key, values[key]);
    }
    if (values[destKey] !== undefined && values[destKey] !== this.#operator.chatId) {
      throw new TransactionError("destination_mismatch", `${destKey} must equal the operator-supplied chat id`);
    }
    map.set(destKey, this.#operator.chatId);
    const allow = map.get(contract.destination.allow_var);
    if (!/^[0-9]+(,[0-9]+)*$/.test(allow)) {
      throw new TransactionError("allowlist_invalid", `${contract.destination.allow_var} must be a comma-separated list of numeric ids (no wildcard)`);
    }
    return map;
  }

  /** Install helper, take the recovery point, stage secrets (stdin only) in a copy, and check the staged copy. */
  async stage(values) {
    this.#requireState("stage", ["change_reviewed"]);
    const contract = this.#contract;
    const secrets = this.#validateValues(values);
    this.#secrets = secrets;
    if (this.#receipt.recovery.backup_ref !== null) {
      throw new TransactionError("stage_already_started", "a recovery point already exists for this transaction; abandon() it and start a new transaction");
    }
    const script = this.#scriptBody();
    this.#assertArtifactUnchanged("target script", this.#approved.script_sha256, sha256Hex(script));
    const txn = this.txnId;
    const keys = contract.managed_env_keys;
    // Build every op first so a bad argument can never leave a half-staged target.
    const putOps = keys.map((key) => opPutEnv({ txn, key, allow: keys, value: secrets.get(key) }));
    let backupMade = false;

    const failStage = async (reason, detail) => {
      let abandoned = false;
      if (backupMade) abandoned = (await this.#closeStaging()).ok;
      return { ...this.#block(reason, { detail, check: { id: "staging", status: "fail", scope: "target-state", detail } }), abandoned };
    };

    const install = await this.#exec(opInstallHelper(script));
    if (install.code !== 0) return failStage("stage_failed:install-helper", `helper install exited ${install.code}`);
    const scriptSha = sha256Hex(script);
    const verifyHelper = await this.#exec(opHelperVerify());
    const remoteSha = (verifyHelper.stdout.trim().split(/\s+/)[0] ?? "").toLowerCase();
    if (verifyHelper.code !== 0 || remoteSha !== scriptSha) {
      return failStage("stage_failed:helper-integrity", "installed helper hash does not match the shipped script");
    }

    const backup = await this.#exec(opBackup({ txn, keys }));
    if (backup.code !== 0) {
      if (backup.code === 4) {
        const reason = backup.kv.error === "incomplete_transaction"
          ? `incomplete_transaction:${/^[a-z0-9]{8,32}$/.test((backup.kv.detail ?? "").split(",")[0]) ? backup.kv.detail.split(",")[0] : "unknown"}`
          : safeReasonCode(backup.kv.error, "target_blocked");
        return failStage(reason, `backup refused: ${backup.kv.error ?? ""} ${backup.kv.detail ?? ""}`);
      }
      return failStage("stage_failed:backup", `backup exited ${backup.code}: ${backup.kv.error ?? ""}`);
    }
    if (backup.kv.backup_handle !== `bk_${txn}`) {
      return failStage("stage_failed:backup", "backup did not report the expected recovery point");
    }
    backupMade = true;
    this.#save((next) => {
      next.recovery.backup_ref = `bk_${txn}`;
    });

    const previous = {};
    for (let index = 0; index < keys.length; index += 1) {
      const put = await this.#exec(putOps[index]);
      if (put.code !== 0 || put.kv.staged_key !== keys[index]) {
        return failStage(`stage_failed:put-env`, `staging ${keys[index]} exited ${put.code}: ${put.kv.error ?? ""}`);
      }
      previous[keys[index]] = ENV_PREV.has(put.kv.previous) ? put.kv.previous : "unknown";
    }
    const staged = await this.#exec(opStageCheck({ txn }));
    const evidence = this.#evidence("stage", staged.stdout);
    if (staged.code !== 0 || staged.kv.stage_ok !== "1") {
      return failStage("stage_failed:stage-check", `stage-check exited ${staged.code}: ${staged.kv.error ?? ""} ${staged.kv.detail ?? ""}`);
    }
    this.#save((next) => {
      this.#setCheck(next, "staging", "pass", "target-state",
        `helper installed and hash-verified; recovery point taken; ${keys.length} keys staged (previous: ${keys.map((k) => `${k}=${previous[k]}`).join(",")})`, evidence);
      next.blocked_reason = null;
      this.#move(next, "staged");
    }, "staged");
    return { ok: true, state: this.state, previous };
  }

  /** Pre-apply `restore` on the target: removes staged secrets, restores nothing (nothing was applied), closes the txn. */
  async #closeStaging() {
    this.#preApplyRestoreAllowed = true;
    try {
      const res = await this.#exec(opRestore({ txn: this.txnId }));
      return { ok: res.code === 0, res };
    } catch {
      return { ok: false, res: null };
    } finally {
      this.#preApplyRestoreAllowed = false;
    }
  }

  /**
   * Give up on a transaction that was reviewed or staged but never applied (for example after a crash between
   * stage and apply). Runs the target-side pre-apply restore/cleanup, leaves `state` unchanged, sets
   * blocked_reason `abandoned` and keeps changes_applied:false. If the cleanup cannot be confirmed, the result
   * carries the exact manual command.
   */
  async abandon() {
    this.#requireState("abandon", ["change_reviewed", "staged"]);
    const manualCommand = `${opRestore({ txn: this.txnId }).remote}   # then: ${opPurge({ txn: this.txnId }).remote}`;
    if (this.#receipt.recovery.backup_ref === null) {
      this.#save((next) => {
        next.blocked_reason = "abandoned";
        this.#setCheck(next, "abandon", "pass", "target-state", "no recovery point had been taken, so nothing was staged on the target");
      });
      return { ok: true, state: this.state, blocked_reason: "abandoned" };
    }
    const closed = await this.#closeStaging();
    const evidence = closed.res ? this.#evidence("abandon", closed.res.stdout) : null;
    if (!closed.ok) {
      this.#save((next) => {
        this.#setCheck(next, "abandon", "fail", "target-state", "the target-side cleanup could not be confirmed; staged secrets may remain on the target until restore is run by hand", evidence);
      });
      return { ok: false, state: this.state, manual_command: manualCommand };
    }
    this.#save((next) => {
      next.blocked_reason = "abandoned";
      this.#setCheck(next, "abandon", "pass", "target-state", "staged secrets removed and the transaction closed on the target; the recovery point is retained until purge", evidence);
    });
    return { ok: true, state: this.state, blocked_reason: "abandoned", manual_command: manualCommand };
  }

  // ---- apply ---------------------------------------------------------------------------------

  /** Write-ahead, then skills-sync -> apply -> reload. A definite failure moves to rollback_required. */
  async apply() {
    this.#requireState("apply", ["staged"]);
    const contract = this.#contract;
    const graph = this.#graph;
    const txn = this.txnId;
    const tar = buildSkillsTar(this.#skillsRoot, graph.managed_skills);
    if (sha256Hex(tar) !== this.#approved.skills_tar_sha256) {
      const changed = this.#approved.skills.filter((item) => {
        try { return skillsTreeHash(this.#skillsRoot, [item.name]) !== item.sha256; } catch { return true; }
      }).map((item) => item.name);
      this.#assertArtifactUnchanged(`managed skill(s) ${changed.join(", ") || "(archive)"}`, this.#approved.skills_tar_sha256, sha256Hex(tar));
    }
    const cron = { id: graph.schedule.id, schedule: this.#operator.schedule, prompt: contract.schedule.prompt };
    const steps = [
      { op: opSkillsSync({ txn, names: graph.managed_skills, tar }), ids: ["skills:sync"] },
      { op: opApply({ txn, cron }), ids: [...contract.managed_env_keys.map((key) => `env:${key}`), `cron:${cron.id}`] },
      { op: opReload({ txn }), ids: ["gateway:reload"] },
    ];

    // Write-ahead: persisted BEFORE the first live mutation.
    this.#save((next) => {
      next.changes_applied = true;
      next.apply.started = true;
      next.apply.completed = false;
      next.apply.ops = steps.flatMap((step) => step.ids.map((op_id) => ({ op_id, status: "pending" })));
      this.#move(next, "applied_unverified");
    }, "applied_unverified");

    for (const step of steps) {
      let res;
      try {
        res = await this.#exec(step.op);
      } catch (error) {
        this.#save((next) => step.ids.forEach((id) => this.#setOp(next, id, "unknown")));
        throw error; // unknown outcome: state deliberately stays applied_unverified
      }
      const evidence = this.#evidence(`apply-${step.op.op}`, res.stdout);
      if (res.code !== 0) {
        const detail = `${step.op.op} exited ${res.code}: ${res.kv.error ?? ""} ${res.kv.detail ?? ""}`;
        this.#save((next) => {
          step.ids.forEach((id) => this.#setOp(next, id, "failed"));
          this.#setCheck(next, "apply", "fail", "target-state", detail, evidence);
          this.#move(next, "rollback_required");
        }, "rollback_required");
        return { ok: false, state: this.state, failed_op: step.op.op, detail: this.#safeText(detail) };
      }
      const cronStatus = res.kv[`cron_${cron.id}`];
      if (step.op.op === "apply" && (res.kv.applied !== "1" || !["created", "unchanged", "updated"].includes(cronStatus))) {
        this.#save((next) => {
          step.ids.forEach((id) => this.#setOp(next, id, "failed"));
          this.#setCheck(next, "apply", "fail", "target-state", "apply exited 0 but did not report applied=1 and a cron status", evidence);
          this.#move(next, "rollback_required");
        }, "rollback_required");
        return { ok: false, state: this.state, failed_op: "apply", detail: "apply did not confirm" };
      }
      this.#save((next) => step.ids.forEach((id) => this.#setOp(next, id, "ok")));
      if (step.op.op === "apply") this.#cronStatus = cronStatus;
    }
    this.#save((next) => {
      next.apply.completed = true;
      this.#setCheck(next, "apply", "pass", "target-state", `all apply steps reported success; cron ${this.#cronStatus}`);
    });
    return { ok: true, state: this.state, cron: this.#cronStatus };
  }

  // ---- verify --------------------------------------------------------------------------------

  /** Target-state checks + runtime version + injected delivery observer. Never "verified" on unknowns. */
  async verify() {
    this.#requireState("verify", ["applied_unverified"]);
    const contract = this.#contract;
    const graph = this.#graph;
    const fp = this.destinationFingerprint;

    if (!this.#receipt.apply.completed) {
      this.#save((next) => {
        this.#setCheck(next, "apply", "fail", "target-state", "apply did not complete (interrupted or failed); the target may be partially changed");
        this.#move(next, "rollback_required");
      }, "rollback_required");
      return { ok: false, state: this.state, unresolved: [], reason: "apply_incomplete" };
    }

    const results = new Map(); // id -> {status, detail, evidence, scope}
    const set = (id, status, scope, detail, evidence = null) => results.set(id, { status, scope, detail, evidence });

    // target-state checks
    const targetRes = await this.#exec(opVerify({
      txn: this.txnId, destinationFp: fp, allowVar: contract.destination.allow_var, destVar: contract.destination.env_key,
      cronId: graph.schedule.id, schedule: this.#operator.schedule, skills: graph.managed_skills,
    }));
    const targetEvidence = this.#evidence("verify", targetRes.stdout);
    for (const id of ["env-boundary", "schedule-single", "managed-skills-intact", "unrelated-state-unchanged"]) {
      const raw = targetRes.code === 0 ? targetRes.kv[`check.${id}`] : undefined;
      const status = ["pass", "fail", "unknown"].includes(raw) ? raw : "unknown";
      const detail = raw === undefined ? `target did not report ${id}${targetRes.code !== 0 ? ` (verify exited ${targetRes.code})` : ""}` : targetRes.kv[`check.${id}.detail`];
      set(id, status, "target-state", detail, targetEvidence);
    }

    // runtime version, re-measured now
    try {
      const again = await this.#exec(opInspect(this.#inspectedScript ?? this.#scriptBody()));
      const version = again.code === 0 && again.kv.hermes_present === "1" ? normaliseVersion(again.kv.runtime_version) : "unknown";
      const evidence = this.#evidence("runtime", again.stdout);
      if (version === "unknown") set("runtime-version", "unknown", "target-state", "runtime version could not be measured after apply", evidence);
      else if (runtimeVersionSupported(contract, version)) set("runtime-version", "pass", "target-state", `hermes ${version}`, evidence);
      else set("runtime-version", "fail", "target-state", `observed ${version} after apply`, evidence);
    } catch {
      set("runtime-version", "unknown", "target-state", "runtime version could not be measured after apply (transport failure)");
    }

    // delivery (observer) and the untrusted-input boundary
    let recomputed = null;
    try {
      recomputed = planHash(deriveExecutionGraph(this.#blueprint, contract, this.#operator));
    } catch { recomputed = null; }
    const planStable = recomputed === this.#receipt.plan_hash;

    let deliveries = null;
    let observerNote = "no delivery observer configured: delivery cannot be proven (process health is not delivery)";
    if (this.#observer) {
      try {
        const observed = await this.#observer.delivery({ destinationFp: fp });
        const list = observed?.deliveries;
        const wellFormed = Array.isArray(list) && list.every((d) => d && typeof d.to_fp === "string" && /^[0-9a-f]{16}$/.test(d.to_fp) && typeof d.body_has_secret === "boolean");
        if (wellFormed) {
          deliveries = list.map((d) => ({ to_fp: d.to_fp, body_has_secret: d.body_has_secret }));
          observerNote = "";
        } else {
          observerNote = "delivery observer returned a malformed observation";
        }
      } catch {
        observerNote = "delivery observer failed";
      }
    }
    const observerEvidence = deliveries
      ? this.#evidence("delivery", deliveries.map((d) => `to_fp=${d.to_fp} body_has_secret=${d.body_has_secret}`).join("\n") || "(no deliveries observed)")
      : null;
    const foreign = deliveries ? deliveries.filter((d) => d.to_fp !== fp).length : 0;
    const leaked = deliveries ? deliveries.filter((d) => d.body_has_secret).length : 0;
    const toConfigured = deliveries ? deliveries.length - foreign : 0;

    if (deliveries === null) set("private-destination-delivery", "unknown", "delivery-observer", observerNote);
    else if (foreign > 0) set("private-destination-delivery", "fail", "delivery-observer", `${foreign} delivery(ies) went to a destination other than the configured one`, observerEvidence);
    else if (toConfigured === 0) set("private-destination-delivery", "unknown", "delivery-observer", "the observer saw no delivery; absence of evidence is not a pass", observerEvidence);
    else set("private-destination-delivery", "pass", "delivery-observer", `${toConfigured} delivery(ies) observed, all to the configured destination fingerprint`, observerEvidence);

    const BOUNDARY_SCOPE = "observed-outcome-single-run";
    const BOUNDARY_NOTE = "observed outcome of one synthetic run; not an injection-resistance test";
    if (!planStable) set("untrusted-input-boundary", "fail", BOUNDARY_SCOPE, `${BOUNDARY_NOTE}: re-deriving the execution graph from the inputs no longer reproduces the receipt's plan_hash`);
    else if (deliveries === null) set("untrusted-input-boundary", "unknown", BOUNDARY_SCOPE, `${BOUNDARY_NOTE}: ${observerNote}`);
    else if (foreign > 0 || leaked > 0) set("untrusted-input-boundary", "fail", BOUNDARY_SCOPE, `${BOUNDARY_NOTE}: observed ${foreign} misdirected and ${leaked} secret-bearing delivery(ies)`, observerEvidence);
    else if (deliveries.length === 0) set("untrusted-input-boundary", "unknown", BOUNDARY_SCOPE, `${BOUNDARY_NOTE}: no delivery observed, so no evidence about retrieved-content handling`, observerEvidence);
    else set("untrusted-input-boundary", "pass", BOUNDARY_SCOPE, `${BOUNDARY_NOTE}: plan_hash reproduced; no misdirected or secret-bearing delivery observed in that run`, observerEvidence);

    const required = contract.required_checks;
    const statusOf = (id) => results.get(id)?.status ?? "unknown";
    const failing = required.filter((id) => statusOf(id) === "fail");
    const unresolved = required.filter((id) => statusOf(id) !== "pass");

    const record = (next) => {
      for (const [id, r] of results) this.#setCheck(next, id, r.status, r.scope, r.detail, r.evidence);
      if (deliveries && deliveries.length > 0) {
        const effects = next.recovery.external_effects;
        const upsert = (kind, note) => {
          const index = effects.findIndex((e) => e.kind === kind);
          if (index >= 0) effects[index] = { kind, note };
          else effects.push({ kind, note });
        };
        if (toConfigured > 0) upsert("telegram_message_delivered", `${toConfigured} message(s) observed at the configured destination; rollback cannot recall them`);
        if (foreign > 0) upsert("telegram_message_misdirected", `${foreign} message(s) observed at another destination; rollback cannot recall them`);
      }
    };

    if (failing.length > 0) {
      this.#save((next) => {
        record(next);
        next.unresolved = [];
        this.#move(next, "rollback_required");
      }, "rollback_required");
      return { ok: false, state: this.state, failed: failing, unresolved: [] };
    }
    if (unresolved.length > 0) {
      this.#save((next) => {
        record(next);
        next.unresolved = unresolved;
      });
      return { ok: false, state: this.state, failed: [], unresolved };
    }

    const commit = await this.#exec(opCommit({ txn: this.txnId }));
    if (commit.code !== 0) {
      this.#save((next) => {
        record(next);
        this.#setCheck(next, "commit", "fail", "target-state", `commit exited ${commit.code}: ${commit.kv.error ?? ""}`);
        next.unresolved = ["commit"];
      });
      return { ok: false, state: this.state, failed: [], unresolved: ["commit"] };
    }
    this.#save((next) => {
      record(next);
      this.#setCheck(next, "commit", "pass", "target-state", "transaction closed on the target; backup retained until purge");
      delete next.unresolved;
      this.#move(next, "verified");
    }, "verified");
    return { ok: true, state: this.state, unresolved: [] };
  }

  // ---- rollback ------------------------------------------------------------------------------

  /** Restore from the recovery point. Conflicts and missing backups end in manual_recovery_required, never an overwrite. */
  async rollback() {
    this.#requireState("rollback", ["applied_unverified", "rollback_required"]);
    if (this.state === "applied_unverified") {
      this.#save((next) => {
        this.#setCheck(next, "rollback-requested", "pass", "operator", "rollback requested from applied_unverified");
        this.#move(next, "rollback_required");
      }, "rollback_required");
    }
    const res = await this.#exec(opRestore({ txn: this.txnId })); // TransportError: stays rollback_required
    const evidence = this.#evidence("restore", res.stdout);
    const verified = res.code === 0 && res.kv.restore_verified === "1";
    if (verified) {
      // Files and cron are back; the RUNNING gateway may still hold the new environment, so reload it.
      let reload = null;
      try {
        reload = await this.#exec(opReload({ txn: this.txnId }));
      } catch { /* unknown outcome: recorded below */ }
      const reloaded = reload !== null && reload.code === 0 && reload.kv.reloaded === "1";
      const reloadEvidence = reload ? this.#evidence("restore-reload", reload.stdout) : null;
      if (reloaded) {
        this.#save((next) => {
          this.#setCheck(next, "restoration", "pass", "target-state", "restore re-verified against the recorded hashes", evidence);
          this.#setCheck(next, "gateway-reloaded", "pass", "target-state", "gateway stopped and started again after the restore", reloadEvidence);
          next.recovery.restoration_verified = true;
          this.#move(next, "restored_verified");
        }, "restored_verified");
        return { ok: true, state: this.state };
      }
      const detail = reload === null
        ? "files restored and verified, but the outcome of the gateway reload is unknown (transport failure); the running gateway may still hold the new environment"
        : `files restored and verified, but the gateway reload failed (exit ${reload.code}: ${reload.kv.error ?? "no reloaded=1"}); the running gateway may still hold the new environment`;
      this.#save((next) => {
        this.#setCheck(next, "restoration", "pass", "target-state", "restore re-verified against the recorded hashes", evidence);
        this.#setCheck(next, "gateway-reloaded", reload === null ? "unknown" : "fail", "target-state", detail, reloadEvidence);
        next.recovery.restoration_verified = false;
        this.#move(next, "manual_recovery_required");
      }, "manual_recovery_required");
      return { ok: false, state: this.state, detail: this.#safeText(detail) };
    }
    let status = "fail";
    let detail;
    if (res.code === 0 && res.kv.already_restored === "1") {
      status = "unknown";
      detail = "a restore marker already existed (earlier run); restoration was not re-verified in this run";
    } else if (res.code === 3) {
      detail = `conflict, nothing overwritten: ${res.kv.conflict ?? res.kv.detail ?? "unspecified"}`;
    } else {
      detail = `restore exited ${res.code}: ${res.kv.error ?? ""} ${res.kv.detail ?? ""}`;
    }
    this.#save((next) => {
      this.#setCheck(next, "restoration", status, "target-state", detail, evidence);
      next.recovery.restoration_verified = false;
      this.#move(next, "manual_recovery_required");
    }, "manual_recovery_required");
    return { ok: false, state: this.state, detail: this.#safeText(detail) };
  }

  // ---- retention -----------------------------------------------------------------------------

  /** Explicit retention: remove this transaction's backup on the target. Only after verified / restored_verified. */
  async purge() {
    this.#requireState("purge", ["verified", "restored_verified"]);
    const res = await this.#exec(opPurge({ txn: this.txnId }));
    return { ok: res.code === 0, detail: this.#safeText(res.kv.error ?? "") };
  }

  // ---- resume --------------------------------------------------------------------------------

  /**
   * Re-attach to a persisted receipt after an interruption. Resumable states and what is legal afterwards:
   * change_reviewed -> stage (only if no recovery point exists yet) or abandon; staged -> apply or abandon;
   * applied_unverified -> verify or rollback; rollback_required -> rollback. Inputs must reproduce the receipt's plan_hash.
   */
  static resume({ receipt, receiptFile, ...options }) {
    const requiredChecks = options.contract.required_checks;
    const loaded = receiptFile ? readReceipt(receiptFile, { requiredChecks }) : assertValidReceipt(structuredClone(receipt), { requiredChecks });
    if (!["change_reviewed", "staged", "applied_unverified", "rollback_required"].includes(loaded.state)) {
      throw new IllegalTransition(loaded.state, "resume", "only change_reviewed, staged, applied_unverified or rollback_required can be resumed; start a new transaction");
    }
    const tx = new Transaction({ ...options, txnId: loaded.txn_id });
    const graph = deriveExecutionGraph(options.blueprint, options.contract, tx.#operator);
    if (planHash(graph) !== loaded.plan_hash || contractHash(options.contract) !== loaded.contract_hash) {
      throw new TransactionError("resume_mismatch", "the supplied blueprint/contract/operator input does not reproduce the receipt's plan_hash");
    }
    tx.#graph = graph;
    tx.#planHash = loaded.plan_hash;
    tx.#receipt = loaded;
    tx.#approved = loaded.artifacts ? structuredClone(loaded.artifacts) : null; // the digests the operator approved
    return tx;
  }
}
