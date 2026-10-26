import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvePython3 } from "../../packages/acceptance/transaction.js";

test("first-install deployment, native CLI reconciliation and conflict-safe rollback pass offline", () => {
  const [command, ...prefix] = resolvePython3();
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers/test-deployment.py");
  const result = spawnSync(command, [...prefix, "-I", "-B", script], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 17 tests/);
});
