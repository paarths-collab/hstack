import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvePython3 } from "../../packages/acceptance/transaction.js";

test("workflow selection, target-free preview and hidden credential capture", () => {
  const [python, ...prefix] = resolvePython3();
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers/test-pack-runtime.py");
  const result = spawnSync(python, [...prefix, "-I", "-B", script], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 7 tests/);
});
