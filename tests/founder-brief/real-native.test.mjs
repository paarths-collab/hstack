import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = process.env.HSTACK_REAL_HERMES_SOURCE;
const python = process.env.HSTACK_REAL_HERMES_PYTHON;

test("opt-in exact Hermes cron source: three simultaneous packs, real claims/subprocesses and rollback; loopback vendors",
  { skip: !source || !python, timeout: 200_000 }, () => {
    assert.ok(path.isAbsolute(source), "HSTACK_REAL_HERMES_SOURCE must be absolute");
    assert.ok(path.isAbsolute(python), "HSTACK_REAL_HERMES_PYTHON must be absolute");
    const result = spawnSync(python, ["-I", "-B", path.join(here, "helpers/real-native-workflow.py"), "--source", source],
      { encoding: "utf8", timeout: 190_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const proof = JSON.parse(result.stdout.trim());
    assert.equal(proof.evidence_scope, "real-native-cron-with-loopback-vendors");
    assert.equal(proof.native_jobs, 3);
    assert.equal(proof.api_acknowledgements, 5);
    assert.equal(proof.confirmed_replay_sends, 0);
    assert.equal(proof.jobs_after_rollback, 0);
    assert.equal(proof.native_failure_recovery, true);
    assert.equal(proof.native_scheduler_tick, true);
    assert.equal(proof.live_telegram, false);
    assert.equal(proof.linux_systemd_readiness, false);
  });
