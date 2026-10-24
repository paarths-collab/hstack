import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvePython3 } from "../../packages/acceptance/transaction.js";

test("workflow instances isolate paths, locks, native jobs, failures and rollback", () => {
  const [command, ...prefix] = resolvePython3();
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers/test-multi-deployment.py");
  const result = spawnSync(command, [...prefix, "-I", "-B", script], { encoding: "utf8", timeout: 90_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 18 tests/);
});
