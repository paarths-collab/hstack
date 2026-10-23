// The approved helper is one self-contained artifact: its digest covers the Bash
// target and the release-specific native adapter, never a mutable remote sibling.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const NATIVE_ADAPTER_PATH = path.join(here, "target", "native-hermes-v0_22_5.py");
export const NATIVE_ADAPTER_MARKER = "# HSTACK_NATIVE_HERMES_V0225_PYTHON";

export function bundleTargetScript(shell, nativeAdapter) {
  const count = shell.split(NATIVE_ADAPTER_MARKER).length - 1;
  if (count === 0) return shell; // Previously reviewed helpers and test fixtures.
  if (count !== 1 || typeof nativeAdapter !== "string" || nativeAdapter.trim() === "") {
    throw new TypeError("the native helper must have exactly one nonempty bundled adapter");
  }
  return shell.replace(NATIVE_ADAPTER_MARKER, () => nativeAdapter.trimEnd());
}

/** Read exactly the bytes review, inspect and install will all use. */
export function readTargetScript(scriptPath) {
  const shell = readFileSync(scriptPath, "utf8");
  return bundleTargetScript(shell, shell.includes(NATIVE_ADAPTER_MARKER) ? readFileSync(NATIVE_ADAPTER_PATH, "utf8") : null);
}
