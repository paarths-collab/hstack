// Three installed packs share a Hermes home. Vendors and native Hermes are explicit fixtures.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvePython3 } from "../../packages/acceptance/transaction.js";

test("independent workflow instances dispatch their installed launcher, retain delivery proofs and isolate failures", { timeout: 150_000 }, () => {
  const [python, ...prefix] = resolvePython3();
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers/test-multi-instance.py");
  const result = spawnSync(python, [...prefix, "-I", "-B", helper], {
    encoding: "utf8", timeout: 145_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 8 tests/);
});
