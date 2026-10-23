import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));

test("three workflow packs match a supplied manual-native worker through report, replay and cleanup", { timeout: 120_000 }, () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "hstack-comparison-report-"));
  try {
    const output = path.join(scratch, "report.json");
    const result = spawnSync("python3", ["-I", "-B", path.join(here, "helpers/compare-workflows.py"), "--output", output], {
      encoding: "utf8", timeout: 110_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(report.cases.map((item) => item.workflow), ["activity-brief", "review-queue", "release-watch"]);
    for (const row of report.cases) {
      assert.equal(row.identical_report_body, true);
      assert.equal(row.native.body_sha256, row.hstack.body_sha256);
      assert.deepEqual(row.native.http_calls, row.hstack.http_calls);
      assert.deepEqual(row.native.operator_choices, row.hstack.operator_choices);
      assert.equal(row.hstack.runbook_supplied_integration_artifacts.length, 0);
      assert.deepEqual(row.native.runbook_supplied_integration_artifacts, ["config.json", "manual-brief.py"]);
      assert.ok(row.native.runbook_supplied_worker_nonblank_lines > 0);
      for (const arm of [row.native, row.hstack]) {
        assert.equal(arm.telegram_sends, 1);
        assert.equal(arm.full_transcript_process_invocations, arm.transcript.length);
        assert.equal(arm.setup_process_invocations, arm.transcript.filter((step) => step.phase === "setup").length);
        assert.ok(arm.machine_elapsed_ms > 0);
        assert.equal(arm.metric_provenance.human_assembly_observed, false);
        for (const key of ["cleanup_launcher_absent", "cleanup_private_payload_absent", "cleanup_delivery_evidence_retained", "unrelated_job_preserved"]) {
          assert.equal(arm.checks[key], true);
        }
        assert.ok(Object.values(arm.checks).every((value) => value === true));
      }
    }
    assert.equal(report.native_minimal_alternative.scheduled_ai_prompt_create_commands, 1);
    assert.equal(report.native_minimal_alternative.executed_here, false);
    assert.equal(report.limits.human_setup_time_measured, false);
    assert.equal(report.limits.native_lifecycle_safety_equivalent, false);
    for (const key of ["live_hermes", "live_github", "live_telegram"]) assert.equal(report.limits[key], false);
    assert.doesNotMatch(readFileSync(output, "utf8"), /ghp_FAKE|123456:FAKE/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
