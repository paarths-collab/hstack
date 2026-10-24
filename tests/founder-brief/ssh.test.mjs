// Real SSH authentication/transport and loopback HTTP; Hermes remains a declared fixture.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SshTransport } from "../../packages/acceptance/transports.js";
import { resolvePython3 } from "../../packages/acceptance/transaction.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function port() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const result = server.address().port;
      server.close((error) => error ? reject(error) : resolve(result));
    });
  });
}

test("real disposable SSH transfers the bundle and isolates legacy and named install, canary, status and rollback", { timeout: 120_000 }, async (t) => {
  if (!existsSync("/usr/sbin/sshd")) return t.skip("local /usr/sbin/sshd unavailable; no system installation attempted");
  let chosen;
  try { chosen = await port(); }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return t.skip(`sandbox refuses loopback bind (${error.code}); run this test with authorized loopback access`);
    throw error;
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), "hstack-real-ssh-"));
  const home = path.join(scratch, "home");
  const [python, ...pythonArgs] = resolvePython3();
  let daemon;
  let daemonLog = "";
  let closed = false;
  try {
    mkdirSync(home, { mode: 0o700 });
    const user = os.userInfo().username;
    for (const key of ["host", "client"]) {
      const run = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "hstack-disposable-loopback", "-f", path.join(scratch, key)], { encoding: "utf8" });
      assert.equal(run.status, 0, "disposable SSH key generation must succeed");
    }
    const authorized = path.join(scratch, "authorized_keys");
    writeFileSync(authorized, readFileSync(path.join(scratch, "client.pub")), { mode: 0o600 });
    const forced = path.join(scratch, "force-command");
    writeFileSync(forced, `#!/bin/bash\nexec /usr/bin/env -i HOME=${quote(home)} HERMES_HOME=${quote(path.join(home, ".hermes"))} PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o700 });
    const config = path.join(scratch, "sshd_config");
    writeFileSync(config, [
      `Port ${chosen}`, "ListenAddress 127.0.0.1", `HostKey ${path.join(scratch, "host")}`,
      `PidFile ${path.join(scratch, "sshd.pid")}`, `AuthorizedKeysFile ${authorized}`, `AllowUsers ${user}`,
      "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "AuthenticationMethods publickey",
      "UsePAM no", "StrictModes yes", "AllowTcpForwarding no", "X11Forwarding no", "PermitTunnel no", "LogLevel ERROR",
      `ForceCommand ${forced}`, "",
    ].join("\n"), { mode: 0o600 });
    const checked = spawnSync("/usr/sbin/sshd", ["-t", "-f", config], { encoding: "utf8" });
    if (checked.status !== 0) return t.skip(`unprivileged sshd configuration unavailable: ${checked.stderr.trim().split("\n")[0].replaceAll(scratch, "<temporary>")}`);
    daemon = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
    daemon.stderr.on("data", (chunk) => { daemonLog += chunk; });
    daemon.on("close", () => { closed = true; });
    daemon.on("error", () => { closed = true; });
    const known = path.join(scratch, "known_hosts");
    writeFileSync(known, `[127.0.0.1]:${chosen} ${readFileSync(path.join(scratch, "host.pub"), "utf8").trim()}\n`, { mode: 0o600 });
    const wrapper = path.join(scratch, "ssh-client");
    writeFileSync(wrapper, `#!/bin/bash\nexec /usr/bin/ssh -F /dev/null -p ${chosen} -i ${quote(path.join(scratch, "client"))} -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quote(known)} -o GlobalKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o ConnectTimeout=2 -o LogLevel=ERROR "$@"\n`, { mode: 0o700 });
    const transport = new SshTransport({ host: "127.0.0.1", user, sshCommand: wrapper, timeoutMs: 3_000 });
    let connected;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      connected = await transport.exec({ remote: "printf hstack-loopback-ready", stdin: null });
      if (connected.code === 0 || closed) break;
      await delay(50);
    }
    if (connected?.code !== 0) {
      const reason = (daemonLog || connected?.stderr || "unknown local sshd limitation").trim().split("\n")[0].replaceAll(scratch, "<temporary>");
      return t.skip(`unprivileged loopback SSH unavailable: ${reason}`);
    }
    assert.equal(connected.stdout, "hstack-loopback-ready");
    transport.timeoutMs = 20_000;
    const build = spawnSync(python, [...pythonArgs, "-I", "-B", "-c", `import sys;sys.path.insert(0,${JSON.stringify(path.join(REPO, "packages/founder-brief"))});import build;sys.stdout.buffer.write(build.build())`], { maxBuffer: 8 * 1024 * 1024 });
    assert.equal(build.status, 0, String(build.stderr));
    const upload = async (relative, bytes, mode) => {
      const result = await transport.exec({ remote: `umask 077; cat > "$HOME/${relative}" && chmod ${mode} "$HOME/${relative}"`, stdin: bytes });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.transportError, false);
    };
    assert.equal((await transport.exec({ remote: 'mkdir -m 700 "$HOME/.hermes"', stdin: null })).code, 0);
    await upload("runtime.pyz", build.stdout, "600");
    await upload("ssh-workflow.py", readFileSync(path.join(HERE, "helpers/ssh-workflow.py")), "600");
    // Only this disposable fixture can dispatch the test wrapper. Production
    // Hermes source and the reviewed runtime have no endpoint override switches.
    const nativeFixture = readFileSync(path.join(HERE, "helpers/native-hermes-v0_22_5.py"), "utf8").replace(
      "else:sys.exit(92)",
      `elif args[1]=="run":\n import subprocess\n job=next(job for job in data["jobs"] if job["id"]==args[2])\n script=job["script"]\n instance=script[len("hstack-workflow-"):-3] if script.startswith("hstack-workflow-") else "-"\n raise SystemExit(subprocess.run([sys.executable,"-I","-B",str(pathlib.Path(os.environ["HOME"])/"ssh-workflow.py"),"worker",instance],check=False).returncode)\nelse:sys.exit(92)`);
    await upload("hermes-fixture", nativeFixture, "700");
    const call = async (operation, input = null, instance = "-") => {
      const result = await transport.exec({ remote: `${quote(python)} ${pythonArgs.map(quote).join(" ")} -I -B "$HOME/ssh-workflow.py" ${quote(operation)} ${quote(instance)}`, stdin: input });
      assert.equal(result.code, 0, `${operation}: ${result.stderr}`);
      assert.equal(result.transportError, false);
      return JSON.parse(result.stdout);
    };
    const input = JSON.stringify({ config: { schema_version: 1, repositories: ["acme/widget"], telegram_chat_id: "555000111", daily_time: "09:00", timezone: "UTC", window_hours: 24 },
      credentials: { GITHUB_TOKEN: "test_public_fixture_token", TELEGRAM_BOT_TOKEN: "123456:FAKExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } });
    const installation = await call("install", input);
    assert.equal(installation.status, "installed");
    assert.equal((await call("install", input)).status, "unchanged");
    assert.equal((await call("status")).phase, "complete");
    const canary = await call("canary");
    assert.equal(canary.status, "loopback_api_ack");
    assert.equal(canary.native_command, "cron run");
    assert.equal(canary.delivery_scope, "telegram-api-ack");
    assert.equal(canary.counts.sends, 1);
    assert.ok(canary.counts.github_gets >= 3);
    const ran = await call("status");
    assert.equal(ran.run_calls.length, 2);
    assert.ok(ran.run_calls.every((args) => JSON.stringify(args) === JSON.stringify(["--profile", "default", "cron", "run", installation.job_id])));
    assert.equal((await call("rollback")).status, "rolled_back");
    assert.equal((await call("rollback")).status, "already_rolled_back");
    const removed = await transport.exec({ remote: 'test ! -e "$HOME/.hermes/.hstack/founder-brief/credentials.json" && test ! -e "$HOME/.hermes/scripts/hstack-founder-brief.py" && printf private-payload-removed', stdin: null });
    assert.equal(removed.stdout, "private-payload-removed");
    const named = [];
    for (const workflow of ["review-queue", "release-watch"]) {
      const config = JSON.parse(input);
      config.config.workflow = workflow;
      config.config.instance_id = workflow;
      const installed = await call("install", JSON.stringify(config), workflow);
      assert.equal(installed.status, "installed");
      named.push({ instance: workflow, installation: installed });
    }
    assert.notEqual(named[0].installation.job_id, named[1].installation.job_id);
    const inventory = await call("list");
    assert.deepEqual(inventory.map((entry) => entry.instance_id), [null, "release-watch", "review-queue"]);
    for (const { instance, installation: installed } of named) {
      const result = await call("canary", null, instance);
      assert.equal(result.counts.sends, 1);
      assert.ok(result.counts.github_gets >= 1);
      const status = await call("status", null, instance);
      assert.equal(status.job_id, installed.job_id);
      assert.equal(status.run_calls.length, 2);
    }
    assert.equal((await call("rollback", null, named[0].instance)).status, "rolled_back");
    assert.equal((await call("status", null, named[1].instance)).phase, "complete");
    assert.equal((await call("rollback", null, named[1].instance)).status, "rolled_back");
  } finally {
    if (daemon && !closed) {
      daemon.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => daemon.once("close", resolve)), delay(1000)]);
      if (!closed) daemon.kill("SIGKILL");
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
