// A local Docker "VPS" for the hstack acceptance tests: a container running a REAL sshd (key-only, non-root
// `operator`, no systemd) with the bash TEST DOUBLES of hermes (and, for the Telegram skill test, curl).
//
// Isolation guarantees (each is asserted by a test or visible in this file):
//   * sshd is published on 127.0.0.1 only, on a random free host port chosen by Docker (`-p 127.0.0.1::22`).
//   * a throwaway ed25519 keypair is generated per run under os.tmpdir(); only the PUBLIC key enters the container.
//   * the host's ~/.ssh, ssh-agent, known_hosts and ssh config are never read: the `ssh` wrapper passes
//     `-F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o UserKnownHostsFile=/dev/null`, the child
//     environment has no SSH_AUTH_SOCK and HOME points at a temp dir.
//   * the container resolves api.telegram.org / api.github.com / github.com to 127.0.0.1, so even the real curl
//     in the image cannot reach a vendor; the curl TEST DOUBLE never opens a socket anyway.
//   * container, key dir and (unless HSTACK_DOCKER_KEEP=1) the image are removed at the end.
//
// This module has NO side effects at import time: `node --test tests/acceptance/` imports it with Docker absent.
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SshTransport } from "../../../../packages/acceptance/transports.js";
import { freshStubDeliveries } from "../../helpers/stub-observer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DOCKER_DIR = path.resolve(here, "..");
export const REPO = path.resolve(DOCKER_DIR, "..", "..", "..");
export const IMAGE_SRC = path.join(DOCKER_DIR, "image");
export const STUB_SRC = path.join(REPO, "tests", "acceptance", "stubs", "hermes");
export const VERSIONS_SRC = path.join(REPO, "VERSIONS.txt");

export const SSH_USER = "operator";
export const SSH_HOST = "127.0.0.1";
export const PATH_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"; ';
export const REMOTE_TMP = "/var/tmp/hstack"; // stub/curl logs live outside HOME so they never perturb tree hashes
export const FIXTURE_REMOTE = `${REMOTE_TMP}/github-fixture.txt`;
export const STUB_LOG_REMOTE = `${REMOTE_TMP}/stub.log`;
export const CURL_LOG_REMOTE = `${REMOTE_TMP}/curl.log`;

/** Env names the sshd accepts (sshd_config AcceptEnv) and the wrapper sends. Anything else is NOT forwarded. */
export const FORWARDED_KNOBS = [
  "HSTACK_STUB_LOG", "HSTACK_STUB_FAIL", "HSTACK_STUB_VERSION", "HSTACK_STUB_GITHUB_FIXTURE", "HSTACK_STUB_VULNERABLE",
  "HSTACK_STUB_SYNTHETIC_SECRET", "HSTACK_RELOAD_DELAY", "HSTACK_FAKE_GOOD_TOKEN",
];
const DEFAULT_KNOBS = Object.freeze({
  HSTACK_STUB_LOG: STUB_LOG_REMOTE,
  HSTACK_RELOAD_DELAY: "0",
  HSTACK_STUB_GITHUB_FIXTURE: FIXTURE_REMOTE,
});

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------------------------------------
// gating
// ---------------------------------------------------------------------------------------------

function have(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 15_000 });
  return !r.error && r.status === 0;
}

/**
 * `false` when the Docker tests may run, otherwise the explicit skip reason. A gated test is NEVER reported
 * as passed when it did not run: it is registered with { skip: <this string> }.
 */
export function dockerGate() {
  if (process.env.HSTACK_DOCKER !== "1") return "skipped: HSTACK_DOCKER=1 not set";
  const info = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 });
  if (info.error || info.status !== 0) return "skipped: HSTACK_DOCKER=1 but `docker info` failed (no reachable Docker daemon)";
  if (!have("ssh", ["-V"])) return "skipped: HSTACK_DOCKER=1 but no ssh client on the host";
  if (!have("ssh-keygen", ["-?"]) && spawnSync("sh", ["-c", "command -v ssh-keygen"], { stdio: "ignore" }).status !== 0) {
    return "skipped: HSTACK_DOCKER=1 but no ssh-keygen on the host";
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// small process helpers
// ---------------------------------------------------------------------------------------------

function docker(args, { input, timeoutMs = 120_000 } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", input, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

function run(command, args, { input, timeoutMs = 60_000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout: "", stderr: String(e.message), timedOut }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
    child.stdin.on("error", () => {});
    if (input === undefined || input === null) child.stdin.end(); else child.stdin.end(input);
  });
}

// ---------------------------------------------------------------------------------------------
// remote scripts (run on the container through the real ssh path)
// ---------------------------------------------------------------------------------------------

const TREE_HASH_PY = `import hashlib, os, stat, sys
root = sys.argv[1]
excl = sys.argv[2:]
lines = []
def skip(rel):
    return any(rel == x or rel.startswith(x + "/") for x in excl)
def walk(d):
    for n in sorted(os.listdir(d)):
        f = os.path.join(d, n)
        rel = os.path.relpath(f, root)
        if skip(rel):
            continue
        st = os.lstat(f)
        mode = oct(st.st_mode & 0o7777)[2:]
        if stat.S_ISLNK(st.st_mode):
            lines.append("%s|L|%s" % (rel, os.readlink(f)))
        elif stat.S_ISDIR(st.st_mode):
            lines.append("%s|D|%s" % (rel, mode)); walk(f)
        else:
            lines.append("%s|F|%s|%s" % (rel, mode, hashlib.sha256(open(f, "rb").read()).hexdigest()))
if os.path.exists(root):
    walk(root)
print(hashlib.sha256("\\n".join(lines).encode()).hexdigest())
`;

const ARGV_SAMPLER_PY = `import os, sys, time
stop = "/tmp/hstack-sampler-stop"
if os.path.exists(stop):
    os.remove(stop)
seen = set()
print("ready", flush=True)
while not os.path.exists(stop):
    for p in os.listdir("/proc"):
        if p.isdigit():
            try:
                with open("/proc/%s/cmdline" % p, "rb") as fh:
                    c = fh.read()
            except OSError:
                continue
            if c:
                seen.add(c)
    time.sleep(0.0005)
for c in sorted(seen):
    sys.stdout.buffer.write(c.replace(b"\\0", b" ") + b"\\n")
`;

function seedScript({ priorBot }) {
  return [
    "set -e",
    // restore the pure stub if a previous scenario swapped in the Telegram doubles
    'd="$HOME/.local/bin"',
    'if [ -e "$d/hermes.stub" ]; then mv -f "$d/hermes.stub" "$d/hermes"; fi',
    'rm -f "$d/curl"',
    'rm -rf "$HOME/.hermes"',
    `: > ${STUB_LOG_REMOTE}; : > ${CURL_LOG_REMOTE}; rm -f ${FIXTURE_REMOTE}`,
    'mkdir -p "$HOME/.hermes/skills/my-own-skill"',
    "printf '# my own skill\\nuser content\\n' > \"$HOME/.hermes/skills/my-own-skill/SKILL.md\"",
    `printf 'UNRELATED_SETTING=keep-me\\nANOTHER_KEY=also-keep\\n${priorBot ? `TELEGRAM_BOT_TOKEN=${priorBot}\\n` : ""}' > "$HOME/.hermes/.env"`,
    'printf \'model: example\\nlogging: info\\n\' > "$HOME/.hermes/config.yaml"',
    "printf 'job-0\\t30 2 * * *\\tunrelated nightly job\\n' > \"$HOME/.hermes/cron.db\"",
    'printf \'0\\n\' > "$HOME/.hermes/cron.seq"',
    'chmod 600 "$HOME/.hermes/.env" "$HOME/.hermes/config.yaml" "$HOME/.hermes/cron.db" "$HOME/.hermes/cron.seq"',
    "",
  ].join("\n");
}

const TELEGRAM_DOUBLES_SCRIPT = [
  "set -e",
  'd="$HOME/.local/bin"',
  'if [ ! -e "$d/hermes.stub" ]; then mv "$d/hermes" "$d/hermes.stub"; fi',
  'install -m 755 /opt/hstack-docker/hermes-tg-shim "$d/hermes"',
  'install -m 755 /opt/hstack-docker/curl-stub "$d/curl"',
  "",
].join("\n");

// ---------------------------------------------------------------------------------------------
// the target
// ---------------------------------------------------------------------------------------------

let singleton = null;
let exitHooked = false;

/** Start (once per test process) and return the shared target. */
export function getTarget() {
  singleton ??= DockerTarget.start();
  return singleton;
}

export async function stopTarget() {
  if (!singleton) return;
  const t = await singleton.catch(() => null);
  singleton = null;
  if (t) t.stop();
}

export class DockerTarget {
  static async start() {
    const t = new DockerTarget();
    try {
      t.#prepareHostSide();
      t.#buildImage();
      t.#runContainer();
      await t.#waitForSsh();
    } catch (error) {
      t.stop();
      throw error;
    }
    return t;
  }

  scratch = mkdtempSync(path.join(os.tmpdir(), "hstack-docker-"));
  binDir = path.join(this.scratch, "bin");
  keyDir = path.join(this.scratch, "key");
  homeDir = path.join(this.scratch, "home");
  receiptsRoot = path.join(this.scratch, "receipts");
  #receiptsDir = null;
  wrapperLog = path.join(this.scratch, "ssh-wrapper.log");
  containerName = `hstack-acc-${randomBytes(4).toString("hex")}`;
  imageTag = null;
  builtImage = false;
  port = null;
  stopped = false;
  #realSsh = null;
  #receiptSeq = 0;

  constructor() {
    for (const d of [this.binDir, this.keyDir, this.homeDir, this.receiptsRoot]) mkdirSync(d, { recursive: true, mode: 0o700 });
    this.#hookExit();
  }

  #hookExit() {
    if (exitHooked) return;
    exitHooked = true;
    const cleanup = () => { try { singleton = null; this.stop(); } catch { /* best effort */ } };
    process.on("exit", cleanup);
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
  }

  // ---- host side: key, wrapper, build context -------------------------------------------------

  #prepareHostSide() {
    const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "hstack-docker-test", "-f", path.join(this.keyDir, "id_ed25519")], { encoding: "utf8" });
    if (keygen.status !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr}`);
    chmodSync(path.join(this.keyDir, "id_ed25519"), 0o600);
    const found = spawnSync("sh", ["-c", "command -v ssh"], { encoding: "utf8" });
    this.#realSsh = found.stdout.trim();
    if (!this.#realSsh) throw new Error("no ssh client found");
  }

  #writeWrapper() {
    const sends = FORWARDED_KNOBS.map((k) => `-o SendEnv=${k}`).join(" ");
    const lines = [
      "#!/bin/bash",
      "# Test-only `ssh` wrapper. Adds the container port/key and disables every host ssh convenience; callers'",
      "# arguments are forwarded untouched (and logged, record-separated) so their argv stays exactly as shipped.",
      "LC_ALL=C",
      `printf '%s\\036' "$*" >> '${this.wrapperLog}'`,
      `exec '${this.#realSsh}' -F /dev/null -p ${this.port} -i '${path.join(this.keyDir, "id_ed25519")}' \\`,
      "  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null \\",
      "  -o LogLevel=ERROR -o IdentitiesOnly=yes -o IdentityAgent=none -o ConnectTimeout=10 \\",
      `  ${sends} "$@"`,
      "",
    ];
    const file = path.join(this.binDir, "ssh");
    writeFileSync(file, lines.join("\n"), { mode: 0o700 });
    chmodSync(file, 0o700);
  }

  #buildImage() {
    const ctx = path.join(this.scratch, "context");
    mkdirSync(ctx, { recursive: true });
    cpSync(IMAGE_SRC, ctx, { recursive: true });
    copyFileSync(STUB_SRC, path.join(ctx, "hermes-stub"));
    copyFileSync(VERSIONS_SRC, path.join(ctx, "VERSIONS.txt"));
    const h = createHash("sha256");
    for (const name of readdirSync(ctx).sort()) h.update(name).update(readFileSync(path.join(ctx, name)));
    this.imageTag = `hstack-acceptance-sshd:${h.digest("hex").slice(0, 12)}`;
    const exists = docker(["image", "inspect", this.imageTag]).code === 0;
    if (exists) return;
    const build = docker(["build", "--quiet", "-t", this.imageTag, ctx], { timeoutMs: 20 * 60_000 });
    if (build.code !== 0) throw new Error(`docker build failed:\n${(build.stderr || build.stdout).split("\n").slice(-25).join("\n")}`);
    this.builtImage = true;
  }

  #runContainer() {
    const pub = readFileSync(path.join(this.keyDir, "id_ed25519.pub"), "utf8").trim();
    const started = docker([
      "run", "-d", "--name", this.containerName, "--label", "hstack-acceptance=1",
      "-p", "127.0.0.1::22", // loopback only, random free host port
      "--add-host", "api.telegram.org:127.0.0.1", "--add-host", "api.github.com:127.0.0.1", "--add-host", "github.com:127.0.0.1",
      "-e", `HSTACK_AUTHORIZED_KEY=${pub}`, // a PUBLIC key
      this.imageTag,
    ]);
    if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr}`);
    const mapped = docker(["port", this.containerName, "22/tcp"]);
    const line = mapped.stdout.split("\n").find((l) => l.startsWith("127.0.0.1:"));
    if (!line) throw new Error(`sshd is not published on 127.0.0.1: ${mapped.stdout}`);
    this.port = Number(line.split(":").pop());
    this.#writeWrapper();
  }

  async #waitForSsh() {
    let last = "";
    for (let i = 0; i < 60; i += 1) {
      const r = await this.ssh("true", { timeoutMs: 8000 });
      if (r.code === 0) return;
      last = r.stderr;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const logs = docker(["logs", "--tail", "30", this.containerName]);
    throw new Error(`sshd did not become reachable: ${last}\n${logs.stdout}${logs.stderr}`);
  }

  // ---- ssh ------------------------------------------------------------------------------------

  /** Environment for any child that runs ssh: the wrapper first on PATH, no agent, temp HOME, stub knobs. */
  childEnv(knobs = {}) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith("SSH_") || k.startsWith("HSTACK_")) continue;
      env[k] = v;
    }
    env.PATH = `${this.binDir}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`;
    env.HOME = this.homeDir;
    return { ...env, ...DEFAULT_KNOBS, ...knobs };
  }

  /** Runs `ssh -o BatchMode=yes operator@127.0.0.1 <remote>` (the wrapper adds port/key). */
  ssh(remote, { input, knobs, timeoutMs = 60_000 } = {}) {
    return run("ssh", ["-o", "BatchMode=yes", `${SSH_USER}@${SSH_HOST}`, remote], { input, timeoutMs, env: this.childEnv(knobs) });
  }

  /** The shipped SshTransport, argv untouched; only the child environment (PATH, knobs) is supplied. */
  transport({ env = {}, timeoutMs } = {}) {
    const knobs = env;
    const spawnImpl = (command, args, options) => spawn(command, args, { ...options, env: this.childEnv(knobs) });
    return new SshTransport({ host: SSH_HOST, user: SSH_USER, spawnImpl, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  /** Receipt directory of the current scenario (rotated by reset(); stable between reset() calls). */
  get receipts() {
    if (!this.#receiptsDir) this.#rotateReceipts();
    return this.#receiptsDir;
  }
  #rotateReceipts() {
    this.#receiptSeq += 1;
    this.#receiptsDir = path.join(this.receiptsRoot, String(this.#receiptSeq));
    mkdirSync(this.#receiptsDir, { recursive: true });
  }

  wrapperCalls() {
    return existsSync(this.wrapperLog) ? readFileSync(this.wrapperLog, "utf8").split("\x1e").filter(Boolean) : [];
  }
  clearWrapperLog() { writeFileSync(this.wrapperLog, ""); }

  // ---- docker-side helpers --------------------------------------------------------------------

  dockerExec(args, options) { return docker(["exec", this.containerName, ...args], options); }
  dockerPort() { return docker(["port", this.containerName, "22/tcp"]).stdout.trim(); }

  // ---- scenario state -------------------------------------------------------------------------

  /** Wipe ~/.hermes and seed the pre-existing USER state a transaction must never disturb. */
  async reset({ priorBot = null } = {}) {
    const r = await this.ssh("bash -s", { input: seedScript({ priorBot }) });
    if (r.code !== 0) throw new Error(`reset failed: ${r.stderr}`);
    this.#rotateReceipts();
    this.clearWrapperLog();
  }

  async installTelegramDoubles() {
    const r = await this.ssh("bash -s", { input: TELEGRAM_DOUBLES_SCRIPT });
    if (r.code !== 0) throw new Error(`installing the telegram doubles failed: ${r.stderr}`);
  }

  async setFixture(text) {
    const r = await this.ssh(`cat > ${FIXTURE_REMOTE}`, { input: text });
    if (r.code !== 0) throw new Error(`setFixture failed: ${r.stderr}`);
  }

  async treeHash(root, excludes = []) {
    const quoted = excludes.map((x) => `'${x}'`).join(" ");
    const r = await this.ssh(`python3 - ${root} ${quoted}`, { input: TREE_HASH_PY });
    if (r.code !== 0) throw new Error(`treeHash failed: ${r.stderr}`);
    return r.stdout.trim();
  }
  /** Everything the user owns that a transaction must leave alone or restore (hstack's own state dir excluded). */
  userStateHash() { return this.treeHash('"$HOME/.hermes"', [".hstack", "cron.seq", "gateway.state", "outbox.log"]); }
  homeHash() { return this.treeHash('"$HOME"'); }

  async fileSha(remotePath) {
    const r = await this.ssh(`sha256sum ${remotePath} | cut -d' ' -f1`);
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async cat(remotePath) {
    const r = await this.ssh(`cat ${remotePath} 2>/dev/null; true`);
    return r.stdout;
  }
  async envText() { return this.cat('"$HOME/.hermes/.env"'); }
  async cronText() { return this.cat('"$HOME/.hermes/cron.db"'); }
  async outboxLines() { return (await this.cat('"$HOME/.hermes/outbox.log"')).split("\n").filter(Boolean); }
  async stubLog() { return this.cat(STUB_LOG_REMOTE); }
  async curlLog() { return this.cat(CURL_LOG_REMOTE); }
  async managedCronLines() { return (await this.cronText()).split("\n").filter((l) => l.includes("[hstack:founder-brief]")); }

  /** Test observer: successful SSH dispatch plus only fresh, run-correlated stub output. */
  observer({ knobs = {}, secret = null } = {}) {
    const run1 = (remote) => this.ssh(remote, { knobs });
    return {
      delivery: async () => {
        const list = await run1(`${PATH_EXPORT}hermes cron list`);
        if (list.code !== 0 || list.transportError) return { deliveries: [] };
        const entries = list.stdout.split("\n").filter((l) => l.includes("[hstack:founder-brief]"));
        if (entries.length !== 1) return { deliveries: [] };
        const jobId = entries[0].split("\t")[0];
        if (!/^[A-Za-z0-9-]+$/.test(jobId)) return { deliveries: [] };
        const before = await this.cat('"$HOME/.hermes/outbox.log"');
        const runId = randomBytes(16).toString("hex");
        const dispatched = await run1(`${PATH_EXPORT}HSTACK_STUB_RUN_ID=${runId} hermes cron run ${jobId}`);
        if (dispatched.code !== 0 || dispatched.transportError) return { deliveries: [] };
        const after = await this.cat('"$HOME/.hermes/outbox.log"');
        return { deliveries: freshStubDeliveries(before, after, runId, [secret]) };
      },
    };
  }

  // newTransaction()/assertReceiptClean() from tests/acceptance/helpers/harness.mjs only need `receipts` and
  // `transport()`, so this class can stand in for the sandbox Target there.

  // ---- process-argv sampler (what `ps` could have shown) --------------------------------------

  /** Starts a root-in-container sampler of every process cmdline under /proc. Call `.stop()` to get the distinct argv lines. */
  async startArgvSampler() {
    const child = spawn("docker", ["exec", "-i", this.containerName, "python3", "-u", "-c", ARGV_SAMPLER_PY], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    child.stdout.on("data", (c) => { chunks.push(c); if (Buffer.concat(chunks).toString().includes("ready\n")) resolveReady(); });
    const closed = new Promise((resolve) => child.on("close", resolve));
    await Promise.race([ready, closed]);
    return {
      stop: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300)); // let the last short-lived process be sampled
        docker(["exec", this.containerName, "touch", "/tmp/hstack-sampler-stop"]);
        await closed;
        return Buffer.concat(chunks).toString("utf8").replace(/^ready\n/, "");
      },
    };
  }

  // ---- cleanup --------------------------------------------------------------------------------

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    docker(["rm", "-f", "-v", this.containerName], { timeoutMs: 60_000 });
    if (this.imageTag && process.env.HSTACK_DOCKER_KEEP !== "1") docker(["rmi", "-f", this.imageTag], { timeoutMs: 60_000 });
    rmSync(this.scratch, { recursive: true, force: true });
  }
}
