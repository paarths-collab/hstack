// Golden-file helper. Normal runs diff against tests/acceptance/golden/<name>; UPDATE_GOLDEN=1 regenerates.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.resolve(here, "..", "golden");

export function assertGolden(name, actual) {
  const file = path.join(GOLDEN_DIR, name);
  const text = actual.endsWith("\n") ? actual : `${actual}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  assert.ok(existsSync(file), `golden file ${name} is missing; run with UPDATE_GOLDEN=1 to create it and review the diff`);
  assert.equal(text, readFileSync(file, "utf8"), `golden mismatch for ${name}; if the change is intended run UPDATE_GOLDEN=1 and review the diff`);
}
