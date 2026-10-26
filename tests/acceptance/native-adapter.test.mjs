import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundleTargetScript, NATIVE_ADAPTER_MARKER, NATIVE_ADAPTER_PATH, readTargetScript } from "../../packages/acceptance/artifacts.js";
import { sha256Hex } from "../../packages/acceptance/receipt.js";
import { DEFAULT_SCRIPT_PATH, resolvePython3 } from "../../packages/acceptance/transaction.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("native adapter model checks use structured release-shaped storage and never a live Hermes process", () => {
  const [command, ...prefix] = resolvePython3();
  const run = spawnSync(command, [...prefix, "-I", "-B", path.join(here, "helpers/test-native-adapter.py")], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /Ran 29 tests/);
});

test("the approved shell artifact contains the exact native adapter bytes and changes when either source changes", () => {
  const native = readFileSync(NATIVE_ADAPTER_PATH, "utf8");
  const shell = `#!/bin/bash\n${NATIVE_ADAPTER_MARKER}\n`;
  const bundled = bundleTargetScript(shell, native);
  assert.ok(bundled.includes(native.trimEnd()));
  assert.equal(bundled.includes(NATIVE_ADAPTER_MARKER), false);
  assert.notEqual(sha256Hex(bundled), sha256Hex(bundleTargetScript(shell, `${native}\n# changed native source`)));
  assert.notEqual(sha256Hex(bundled), sha256Hex(bundleTargetScript(`${shell}\n# changed shell source`, native)));
  assert.throws(() => bundleTargetScript(`${shell}${NATIVE_ADAPTER_MARKER}`, native));
  assert.equal(bundleTargetScript("legacy fixture", null), "legacy fixture");
  const actual = readTargetScript(DEFAULT_SCRIPT_PATH);
  if (readFileSync(DEFAULT_SCRIPT_PATH, "utf8").includes(NATIVE_ADAPTER_MARKER)) assert.ok(actual.includes(native.trimEnd()));
});
