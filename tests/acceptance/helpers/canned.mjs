// Canned target responses for golden command sequences: the transport never runs anything.
import { sha256 } from "./harness.mjs";

const kv = (pairs) => Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";

export function cannedResponder({ scriptBody, txn, overrides = {} }) {
  return (op) => {
    if (Object.hasOwn(overrides, op.op)) return overrides[op.op];
    switch (op.op) {
      case "inspect":
        return { stdout: kv({
          op: "inspect", hermes_present: 1, runtime_version: "0.15.2", runtime_evidence: "measured", os: "linux",
          service_manager: "systemd", env_file: "present", env_keys: "UNRELATED_SETTING", env_perm: 600,
          config_fingerprint: "0123456789abcdef", cron_managed_ids: "", cron_other_count: 0, skills_unmanaged: "my-own-skill",
          skills_unmanaged_unlisted: 0, skills_managed: "", skills_managed_modified: "", txn_incomplete: "", diagnostics: "unknown",
        }) };
      case "install-helper": return {};
      case "helper-verify": return { stdout: `${sha256(scriptBody)}  /home/u/.hermes/.hstack/bin/hstack-target.sh\n` };
      case "backup": return { stdout: kv({ backup_handle: `bk_${txn}`, txn }) };
      case "put-env": return { stdout: kv({ staged_key: /put-env '[a-z0-9]+' '([A-Z_]+)'/.exec(op.remote)[1], previous: "absent" }) };
      case "stage-check": return { stdout: kv({ stage_ok: 1 }) };
      case "skills-sync": return { stdout: kv({ skills_changed: 4 }) };
      case "apply": return { stdout: kv({ env_swapped: 1, "cron_founder-brief": "created", applied: 1 }) };
      case "reload": return { stdout: kv({ reloaded: 1 }) };
      case "verify": return { stdout: kv({
        "check.env-boundary": "pass", "check.env-boundary.detail": "ok", "check.schedule-single": "pass", "check.schedule-single.detail": "ok",
        "check.managed-skills-intact": "pass", "check.managed-skills-intact.detail": "ok",
        "check.unrelated-state-unchanged": "pass", "check.unrelated-state-unchanged.detail": "ok",
      }) };
      case "commit": return {};
      case "restore": return { stdout: kv({ restore_verified: 1 }) };
      case "purge": return {};
      default: return { code: 99, stderr: "unexpected op" };
    }
  };
}
