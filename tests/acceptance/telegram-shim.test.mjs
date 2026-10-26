// Local regression for the Docker-only TEST DOUBLE (a Python argparse mirror of the v0.22.5 commands the Telegram skill
// calls, in front of the legacy stub). No daemon, SSH, Hermes or external API is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pick } from "../skills/helpers/blocks.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERSIONS = readFileSync(path.join(REPO, "VERSIONS.txt"), "utf8");
const PIN = /^HERMES_LEGACY_FIXTURE_VERSION=(.+)$/m.exec(VERSIONS)[1].trim();
const TARGET = /^HERMES_VERSION=(.+)$/m.exec(VERSIONS)[1].trim();

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
  const run = (args, knobs = {}) => spawnSync("python3", ["-I", hermes, ...args], { env: { ...env, ...knobs }, encoding: "utf8", timeout: 60_000 });
  const runScript = (script, knobs = {}) => spawnSync("/bin/bash", ["-c", script], { env: { ...env, ...knobs }, encoding: "utf8", timeout: 60_000 });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return { run, runScript, calls, state, home };
}

test("shim: default-profile spellings and the 0.22.5 report; the stub keeps the legacy fixture version", (t) => {
  const f = fixture(t);
  assert.notEqual(PIN, TARGET);
  for (const prefix of [[], ["-p", "default"], ["--profile", "default"], ["--profile=default"]]) {
    const result = f.run([...prefix, "--version"]);
    assert.equal(result.status, 0, result.stderr);
    // The shape of hermes_cli/_startup_fast.py print_fast_version_info; later lines carry unrelated x.y.z tokens.
    assert.match(result.stdout, new RegExp(`^Hermes Agent v${TARGET.replaceAll(".", "\\.")} \\(\\d{4}\\.\\d+\\.\\d+\\)`));
    assert.match(result.stdout, /\nPython: 3\.\d+\.\d+\nOpenAI SDK: \d+\.\d+\.\d+\n$/);
  }
  assert.deepEqual(f.calls(), Array(4).fill("--version"));
  assert.deepEqual(readdirSync(f.state), [], "a profile-aware version probe must remain read-only");
  assert.equal(f.run(["-p", "default", "--version"], { HSTACK_STUB_FAIL: "version" }).status, 1);
  assert.equal(spawnSync("/bin/bash", [path.join(REPO, "tests/acceptance/stubs/hermes"), "--version"], { env: { ...process.env, HOME: f.home, HSTACK_STUB_VERSION: "" }, encoding: "utf8" }).stdout, `hermes ${PIN}\n`);
});

test("shim: config set keeps values and the `--` guard; config unset removes a key", (t) => {
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
  assert.equal(f.run(["-p", "default", "config", "unset", "TELEGRAM_HOME_CHANNEL"]).status, 0);
  assert.doesNotMatch(readFileSync(path.join(f.state, ".env"), "utf8"), /TELEGRAM_HOME_CHANNEL/);
  assert.match(readFileSync(path.join(f.state, ".env"), "utf8"), /^TELEGRAM_ALLOWED_USERS=111222333$/m);
  assert.equal(f.run(["-p", "default", "config", "unset", "platforms.telegram.enabled"]).status, 0);
  assert.doesNotMatch(readFileSync(path.join(f.state, "config.yaml"), "utf8"), /telegram/);
  assert.equal(f.calls().at(-1), "config\tunset\tplatforms.telegram.enabled");
});

test("shim: gateway restart/ensure/status model a gateway whose instance_id changes only on a real restart", (t) => {
  const f = fixture(t);
  const ensure = (timeout = "60") => f.run(["-p", "default", "gateway", "ensure", "--json", "--timeout", timeout]);
  const status = () => f.run(["-p", "default", "gateway", "status"]).stdout;
  assert.match(status(), /Gateway is not running/, "the stopped gateway prints a line that contains the word 'running'");
  const first = ensure();
  assert.equal(first.status, 0, first.stderr);
  const a = JSON.parse(first.stdout);
  assert.equal(a.state, "ready");
  assert.match(a.endpoint.instance_id, /^shim-instance-\d+$/);
  assert.match(first.stdout, /"state":"ready"/, "compact JSON, as gw_ready greps it");
  assert.match(status(), /Gateway is running/);
  assert.equal(JSON.parse(ensure("10").stdout).endpoint.instance_id, a.endpoint.instance_id, "ensure on a running gateway restarts nothing");
  // restart with the flags the skill uses; each real restart is a new process, hence a new instance_id
  for (const flags of [["--detach"], ["--detach", "-y"], ["-y", "--detach"], ["--yes", "--detach"], []]) {
    const before = JSON.parse(ensure().stdout).endpoint.instance_id;
    assert.equal(f.run(["-p", "default", "gateway", "restart", ...flags]).status, 0, flags.join(" "));
    assert.notEqual(JSON.parse(ensure().stdout).endpoint.instance_id, before, flags.join(" "));
  }
  // linger case: exit 0, nothing restarted, same instance_id
  const same = JSON.parse(ensure().stdout).endpoint.instance_id;
  assert.equal(f.run(["-p", "default", "gateway", "restart", "--detach"], { HSTACK_SHIM_RESTART_NOOP: "1" }).status, 0);
  assert.equal(JSON.parse(ensure().stdout).endpoint.instance_id, same);
  // live sessions: refused without -y (exit 1), allowed with it
  const refused = f.run(["-p", "default", "gateway", "restart", "--detach"], { HSTACK_SHIM_LIVE_SESSIONS: "1" });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /live session/);
  assert.equal(f.run(["-p", "default", "gateway", "restart", "-y", "--detach"], { HSTACK_SHIM_LIVE_SESSIONS: "1" }).status, 0);
  // stop, and propagated stub failures
  assert.equal(f.run(["-p", "default", "gateway", "stop"]).status, 0);
  assert.match(status(), /Gateway is not running/);
  const failed = ensure.call(null) && f.run(["-p", "default", "gateway", "stop"], { HSTACK_STUB_FAIL: "gateway-stop" });
  assert.equal(failed.status, 1);
  assert.equal(f.run(["-p", "default", "gateway", "restart", "--detach"], { HSTACK_STUB_FAIL: "gateway-restart" }).status, 1);
  const down = f.run(["-p", "default", "gateway", "stop"]);
  assert.equal(down.status, 0);
  const noStart = f.run(["-p", "default", "gateway", "ensure", "--json", "--timeout", "60"], { HSTACK_STUB_FAIL: "gateway-restart" });
  assert.equal(noStart.status, 1);
  assert.equal(noStart.stdout, "", "a failed start cannot emit a ready report");
});

test("shim: logs, send and pairing accept the skill's forms; the gateway log shows a connection only while it runs", (t) => {
  const f = fixture(t);
  const logs = (...args) => f.run(["-p", "default", "logs", "gateway", ...args]);
  assert.doesNotMatch(logs("-n", "50", "--since", "30s").stdout, /telegram connected/);
  f.run(["-p", "default", "gateway", "ensure", "--json", "--timeout", "60"]);
  assert.match(logs("-n", "200", "--since", "30s").stdout, /telegram connected/);
  assert.equal(f.run(["-p", "default", "send", "--to", "telegram", "hello"]).status, 0);
  assert.equal(f.run(["-p", "default", "pairing", "list"]).status, 0);
  assert.match(f.calls().join("\n"), /send\t--to\ttelegram\thello/);
});

test("shim and stub reject undeclared options like argparse (exit 2), including the nonexistent `gateway run --daemon`", (t) => {
  const f = fixture(t);
  const direct = spawnSync("/bin/bash", [path.join(REPO, "tests/acceptance/stubs/hermes"), "gateway", "run", "--daemon"], { env: { ...process.env, HOME: f.home }, encoding: "utf8" });
  assert.equal(direct.status, 2);
  assert.match(direct.stderr, /unrecognized arguments: --daemon/);
  for (const args of [
    ["gateway", "run", "--daemon"], ["gateway", "restart", "--daemon"], ["gateway", "restart", "--bogus"], ["gateway", "stop", "--bogus"],
    ["gateway", "ensure", "--json", "--timeout", "60", "--force"], ["gateway", "ensure", "--daemon"], ["gateway", "status", "--force"],
    ["gateway", "start", "--detach"], ["logs", "gateway", "--force"], ["logs", "gateway", "-n", "bad"], ["logs", "gateway", "--since", "soon"],
    ["config", "set", "--bogus"], ["config", "unset", "--bogus"], ["send", "--bogus"], ["pairing", "list", "--bogus"], ["pairing", "approve", "telegram"],
  ]) {
    const result = f.run(["-p", "default", ...args]);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(f.calls(), [], "a usage error never reaches the stub");
  assert.deepEqual(readdirSync(f.state), []);
});

test("shim: named profiles and commands it does not model are exit 99 and change nothing", (t) => {
  const f = fixture(t);
  for (const args of [
    ["-p"], ["--profile"], ["-p", "default"], ["-p", "other", "--version"], ["--profile=other", "--version"],
    ["-p", "default", "doctor"], ["-p", "default", "gateway"], ["-p", "default", "gateway", "run"], ["-p", "default", "logs", "agent"],
    ["-p", "default", "config", "get", "X"], ["-p", "default", "totally-unknown"],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 99, `unexpected acceptance of ${JSON.stringify(args)}: ${result.stderr}`);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(readdirSync(f.state), []);
  assert.equal(existsSync(path.join(f.home, ".hermes/gateway.state")), false);
});

test("Telegram Docker shim runs the actual skill version gate and gateway-reload blocks locally", (t) => {
  const f = fixture(t);
  // Step 0 defines gw_reload/gw_ready (and its own ssh `remote`), Step 1 gates on the Hermes version, Step 7 reloads.
  const step0 = pick("platform-telegram", ["step0#1"]).map((block) => block.code).join("\n");
  const blocks = pick("platform-telegram", ["step1#1", "step7#1"]).map((block) => block.code).join("\n");
  // Only transport and pacing are replaced (after Step 0); every command block is unchanged.
  const script = `export PATH="$HOME/.local/bin:$PATH"\n${step0}\nremote() { /bin/bash -c "$1"; }\nsleep() { :; }\nrollback() { echo fixture-rollback >&2; return 1; }\n${blocks}`;
  const result = f.runScript(script);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Using: Hermes Agent v0\.22\.5 /, "the 0.22.5-only version gate saw the shim's 0.22.5 report");
  // The skill owns HOW it reloads; the double only models commands that exist at 0.22.5. `gateway run --daemon` and a
  // stop/run pair must never appear, and the gateway ends running.
  const gateway = f.calls().filter((call) => call.startsWith("gateway\t"));
  assert.equal(f.calls()[0], "--version");
  assert.ok(gateway.length >= 1, f.calls().join(" | "));
  assert.ok(gateway.every((call) => call === "gateway\trestart" || call.startsWith("gateway\tensure\t--json\t--timeout\t")), `unexpected gateway call: ${gateway.join(" | ")}`);
  assert.ok(gateway.includes("gateway\trestart"), "the skill restarts the gateway natively");
  assert.ok(gateway.lastIndexOf("gateway\trestart") < gateway.findLastIndex((call) => call.startsWith("gateway\tensure")), "readiness is checked after the restart");
  assert.equal(f.calls().some((call) => /--daemon|gateway\trun|gateway\tstop|gateway\tstatus/.test(call)), false, "no status-text health check and no stop/run");
  assert.equal(readFileSync(path.join(f.state, "gateway.state"), "utf8"), "running\n");
  const failed = f.runScript(script, { HSTACK_STUB_FAIL: "gateway-restart" });
  assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
  assert.match(failed.stdout + failed.stderr, /FAIL|gw_reload|did not/);
  assert.match(failed.stderr, /fixture-rollback/);
});
