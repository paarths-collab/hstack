import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
test("Telegram sender: real loopback HTTP acknowledgements, journal recovery and negative cases", { timeout: 60_000 }, () => {
  const result = spawnSync("python3", ["-I", "-B", path.join(here, "helpers/test-telegram-delivery.py")], {
    encoding: "utf8", timeout: 55_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 14 tests/);
});
