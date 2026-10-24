// Local regression for the Docker-only TEST DOUBLE. No daemon, SSH, Hermes or external API is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pick } from "../skills/helpers/blocks.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PIN = /^HERMES_VERSION=(.+)$/m.exec(readFileSync(path.join(REPO, "VERSIONS.txt"), "utf8"))[1].trim();

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "hstack-tg-shim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, ".local/bin");
  const state = path.join(home, ".hermes");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { mode: 0o700 });
  const hermes = path.join(bin, "hermes");
  copyFileSync(path.join(REPO, "tests/acceptance/docker/image/hermes-tg-shim"), hermes);
  chmodSync(hermes, 0o700);
  symlinkSync(path.join(REPO, "tests/acceptance/stubs/hermes"), path.join(bin, "hermes.stub"));
  const log = path.join(root, "stub.log");
  writeFileSync(log, "");
  const env = { ...process.env, HOME: home, HSTACK_STUB_LOG: log };
  for (const key of ["HSTACK_STUB_FAIL", "HSTACK_STUB_VERSION", "HSTACK_STUB_GITHUB_FIXTURE", "HSTACK_STUB_VULNERABLE"])
    delete env[key];
  const run = (args, knobs = {}) => spawnSync("/bin/bash", [hermes, ...args], { env: { ...env, ...knobs }, encoding: "utf8", timeout: 5_000 });
  const runScript = (script, knobs = {}) => spawnSync("/bin/bash", ["-c", script], { env: { ...env, ...knobs }, encoding: "utf8", timeout: 5_000 });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { run, runScript, calls, state, home };
}

test("Telegram Docker shim accepts explicit default-profile spelling while preserving the legacy version pin", (t) => {
  const f = fixture(t);
  for (const prefix of [[], ["-p", "default"], ["--profile", "default"], ["--profile=default"]]) {
    const result = f.run([...prefix, "--version"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `hermes ${PIN}\n`);
  }
  assert.deepEqual(f.calls(), Array(4).fill("--version"));
  assert.deepEqual(readdirSync(f.state), [], "a profile-aware version probe must remain read-only");
  const failure = f.run(["-p", "default", "--version"], { HSTACK_STUB_FAIL: "version" });
  assert.equal(failure.status, 1);
});

test("Telegram Docker shim preserves config values and removes only the end-of-options guard", (t) => {
  const f = fixture(t);
  for (const [prefix, key, value] of [
    [["-p", "default"], "TELEGRAM_ALLOWED_USERS", "111222333"],
    [["--profile", "default"], "TELEGRAM_HOME_CHANNEL", "-100555000111"],
    [["--profile=default"], "TELEGRAM_BOT_TOKEN", "synthetic:literal_$value"],
  ]) {
    const result = f.run([...prefix, "config", "set", key, "--", value]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(f.state, ".env"), "utf8"), new RegExp(`^${key}=` + value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "m"));
    assert.equal(f.calls().at(-1), `config\tset\t${key}\t${value}`);
  }
  assert.equal(f.run(["-p", "default", "config", "set", "platforms.telegram.enabled", "true"]).status, 0);
  assert.equal(readFileSync(path.join(f.state, "config.yaml"), "utf8"), "platforms.telegram.enabled: true\n");
});

test("Telegram Docker shim models ensure/stop/status/logs and propagates native-double failures", (t) => {
  const f = fixture(t);
  const command = ["-p", "default", "gateway", "ensure", "--json", "--timeout", "60"];
  const ready = f.run(command);
  assert.equal(ready.status, 0, ready.stderr);
  assert.deepEqual(JSON.parse(ready.stdout), { state: "ready", evidence: "test-double" });
  assert.equal(f.calls().at(-1), "gateway\trun\t--daemon");
  assert.equal(f.run(["--profile", "default", "gateway", "status"]).stdout, "gateway: running\n");
  assert.match(f.run(["-p", "default", "logs", "gateway", "-n", "200"]).stdout, /telegram connected/);
  assert.equal(f.run(["-p", "default", "gateway", "stop"]).status, 0);
  assert.equal(f.run(["-p", "default", "gateway", "status"]).stdout, "gateway: stopped\n");
  assert.doesNotMatch(f.run(["-p", "default", "logs", "gateway", "-n", "50"]).stdout, /telegram connected/);
  const failed = f.run(command, { HSTACK_STUB_FAIL: "gateway-run" });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "", "failure cannot emit fixture readiness");
  assert.equal(readFileSync(path.join(f.state, "gateway.state"), "utf8"), "stopped\n");
  assert.equal(f.run(command).status, 0);
  assert.equal(f.run(["-p", "default", "gateway", "stop"], { HSTACK_STUB_FAIL: "gateway-stop" }).status, 1);
  assert.equal(readFileSync(path.join(f.state, "gateway.state"), "utf8"), "running\n");
});

test("Telegram Docker shim rejects named profiles and malformed lifecycle requests before invoking the stub", (t) => {
  const f = fixture(t);
  for (const args of [
    ["-p"], ["--profile"], ["-p", "default"], ["-p", "other", "--version"], ["--profile=other", "--version"],
    ["-p", "default", "gateway", "ensure"],
    ["--profile", "default", "gateway", "ensure", "--json", "--timeout", "60", "--force"],
    ["-p", "default", "gateway", "ensure", "--json", "--timeout", "bad"],
    ["-p", "default", "gateway", "status", "--force"],
    ["-p", "default", "logs", "gateway", "-n", "bad"],
    ["-p", "default", "logs", "gateway", "--force"],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 99, `unexpected acceptance of ${JSON.stringify(args)}: ${result.stderr}`);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(f.calls(), []);
  assert.deepEqual(readdirSync(f.state), []);
  assert.equal(existsSync(path.join(f.home, ".hermes/gateway.state")), false);
});

test("Telegram Docker shim runs the actual skill reachability and reload blocks locally", (t) => {
  const f = fixture(t);
  const blocks = pick("platform-telegram", ["step1#1", "step7#1"]).map((block) => block.code).join("\n");
  // Only transport and pacing are replaced. Both fenced command blocks above are unchanged.
  const script = `export PATH="$HOME/.local/bin:$PATH"\nremote() { /bin/bash -c "$1"; }\nsleep() { :; }\nrollback() { echo fixture-rollback >&2; return 1; }\n${blocks}`;
  const result = f.runScript(script);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Post-setup nudge/);
  assert.deepEqual(f.calls(), ["--version", "gateway\tstop", "gateway\trun\t--daemon", "gateway\tstop", "gateway\trun\t--daemon"]);
  const failed = f.runScript(script, { HSTACK_STUB_FAIL: "gateway-run" });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL: gateway did not start/);
  assert.match(failed.stderr, /fixture-rollback/);
});
