// Builders for syntactically and semantically valid receipts in every state (receipt tests mutate these).
import { contract } from "./harness.mjs";

const T = "2026-01-01T00:00:00.000Z";
const PATHS = {
  validated: ["validated"],
  inspected: ["validated", "inspected"],
  change_reviewed: ["validated", "inspected", "change_reviewed"],
  staged: ["validated", "inspected", "change_reviewed", "staged"],
  applied_unverified: ["validated", "inspected", "change_reviewed", "staged", "applied_unverified"],
  verified: ["validated", "inspected", "change_reviewed", "staged", "applied_unverified", "verified"],
  rollback_required: ["validated", "inspected", "change_reviewed", "staged", "applied_unverified", "rollback_required"],
  restored_verified: ["validated", "inspected", "change_reviewed", "staged", "applied_unverified", "rollback_required", "restored_verified"],
  manual_recovery_required: ["validated", "inspected", "change_reviewed", "staged", "applied_unverified", "rollback_required", "manual_recovery_required"],
};
const APPLIED = new Set(["applied_unverified", "verified", "rollback_required", "restored_verified", "manual_recovery_required"]);

const ARTIFACTS = () => ({
  script_sha256: "c".repeat(64),
  skills_tar_sha256: "d".repeat(64),
  skills: contract.managed_skills.map((name, i) => ({ name, sha256: String(i).repeat(64) })),
});

export function validReceipt(state = "validated") {
  const steps = PATHS[state];
  const transitions = [];
  let from = "start";
  for (const to of steps) {
    transitions.push({ from, to, at: T });
    from = to;
  }
  const applied = APPLIED.has(state);
  const checks = state === "verified"
    ? contract.required_checks.map((id) => ({
      id, status: "pass", observed_at: T, evidence_ref: `${id}-1.txt`,
      scope: id === "private-destination-delivery" ? "delivery-observer" : "target-state", detail: "ok",
    }))
    : state === "restored_verified"
      ? ["restoration", "gateway-reloaded"].map((id) => ({ id, status: "pass", observed_at: T, evidence_ref: `${id}-1.txt`, scope: "target-state", detail: "ok" }))
      : [];
  return {
    schema_version: 1,
    txn_id: "abcd1234efgh",
    recipe: contract.recipe,
    plan_hash: "a".repeat(64),
    contract_hash: "b".repeat(64),
    runtime_version: "0.15.2",
    adapter_versions: { github: contract.adapters.github.mcp_pkg, telegram: "platform-telegram@sha256:0123456789ab" },
    target_profile: { os: "linux", shell: "bash", declared_transport: "ssh", transport_used: "sandbox", observed_os: "linux", service_manager: "systemd", adapter_surface: contract.adapter_surface_status },
    state,
    changes_applied: applied,
    blocked_reason: null,
    transitions,
    checks,
    apply: { started: applied, completed: state === "verified", ops: applied ? [{ op_id: "skills:sync", status: state === "verified" ? "ok" : "pending" }] : [] },
    recovery: {
      backup_ref: ["staged", ...APPLIED].includes(state) ? "bk_abcd1234efgh" : null,
      restoration_verified: state === "restored_verified",
      external_effects: [],
    },
    ...(["change_reviewed", "staged", ...APPLIED].includes(state) ? { artifacts: ARTIFACTS() } : {}),
    destination_fingerprint: "0123456789abcdef",
    delivery_semantics: contract.delivery_semantics,
    scope_note: contract.scope_note,
    created_at: T,
    updated_at: T,
  };
}

export const ALL_STATES = Object.keys(PATHS);
