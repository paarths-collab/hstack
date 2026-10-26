// A throw-away simulated VPS + agent machine for running SKILL.md blocks offline.
//
//   <root>/home          HOME of both the local script and the simulated VPS (the stubs key off it)
//   <root>/home/.hermes  the VPS's Hermes state (.env, config.yaml, SOUL.md, snapshots)
//   <root>/home/.local/bin/hermes   stub, ONLY here: a remote() that forgets to export PATH cannot find it
//   <root>/home/remote_bin          stubs seen by the simulated VPS only (curl, crontab, sleep)
//   <root>/home/local_bin           stubs seen by the local script (ssh, sleep, curl/wget that fail)
//   <root>/home/logs, knobs         what the stubs recorded / how a test makes them misbehave
//
// Nothing here touches the network or anything outside os.tmpdir().
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STUBS = path.join(here, "..", "stubs");
export const BASH = "/bin/bash";

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

export function installStubs(home) {
  const put = (dir, stub, as = stub) => {
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, as);
    copyFileSync(path.join(STUBS, stub), dest);
    chmodSync(dest, 0o755);
  };
  put(path.join(home, "local_bin"), "ssh");
  put(path.join(home, "local_bin"), "sleep");
  put(path.join(home, "local_bin"), "forbidden", "curl");
  put(path.join(home, "local_bin"), "forbidden", "wget");
  put(path.join(home, "remote_bin"), "curl");
  put(path.join(home, "remote_bin"), "crontab");
  put(path.join(home, "remote_bin"), "sleep");
  put(path.join(home, "remote_bin"), "forbidden", "docker");
  // A mutation/control test may run a skill variant that kills processes by name. On the real host that would signal the
  // node test processes themselves (their command lines contain "hermes"), so the simulated VPS must never have a working
  // process killer: the attempt is logged (logs/local-forbidden.log) and fails.
  for (const tool of ["pkill", "killall", "pgrep"]) put(path.join(home, "remote_bin"), "forbidden", tool);
  put(path.join(home, ".local", "bin"), "hermes");
  // The hermes stub rejects invalid invocations with the REAL v0.22.5 argparse (vendored fixture + syntax-only
  // harness), so it needs to find them from the clean environment of the simulated VPS. It also sources
  // $HOME/.local/hermes.d/<command>.sh for per-command behaviour.
  mkdirSync(path.join(home, ".hstack-native"), { recursive: true });
  writeFileSync(path.join(home, ".hstack-native", "parser"), path.join(here, "native-parser.py"));
  writeFileSync(path.join(home, ".hstack-native", "fixture"), path.join(here, "..", "fixtures", "hermes-v0.22.5"));
  // Cross-sandbox cache of the (pure) argparse verdicts; see nat_parse_check in stubs/hermes.
  writeFileSync(path.join(home, ".hstack-native", "cache"), path.join(os.tmpdir(), "hstack-native-parse-cache"));
  const hd = path.join(here, "..", "stub-commands");
  if (existsSync(hd)) {
    mkdirSync(path.join(home, ".local", "hermes.d"), { recursive: true });
    for (const f of readdirSync(hd)) copyFileSync(path.join(hd, f), path.join(home, ".local", "hermes.d", f));
  }
}

export class Sandbox {
  constructor(name = "run") {
    this.root = mkdtempSync(path.join(os.tmpdir(), `hstack-skill-${name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 24)}-`));
    this.home = path.join(this.root, "home");
    for (const d of [".hermes", "logs", "knobs", "state"]) mkdirSync(path.join(this.home, d), { recursive: true });
    installStubs(this.home);
    writeFileSync(path.join(this.home, "valid_tokens"), "");
  }

  p(rel) {
    return path.join(this.home, rel);
  }
  write(rel, content, mode) {
    const f = this.p(rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
    if (mode !== undefined) chmodSync(f, mode);
  }
  read(rel) {
    return existsSync(this.p(rel)) ? readFileSync(this.p(rel), "utf8") : null;
  }
  exists(rel) {
    return existsSync(this.p(rel));
  }
  mode(rel) {
    return statSync(this.p(rel)).mode & 0o777;
  }
  ls(rel) {
    return existsSync(this.p(rel)) ? readdirSync(this.p(rel)).sort() : [];
  }
  /** Seed the VPS: env/config/soul/crontab are text (or null/undefined = absent). */
  seed({ env, config, soul, crontab, envMode = 0o600 } = {}) {
    if (env != null) this.write(".hermes/.env", env, envMode);
    if (config != null) this.write(".hermes/config.yaml", config, 0o644);
    if (soul != null) this.write(".hermes/SOUL.md", soul, 0o644);
    if (crontab != null) this.write("crontab.store", crontab, 0o644);
    return this;
  }
  validTokens(list) {
    writeFileSync(this.p("valid_tokens"), list.map((t) => `${t}\n`).join(""));
    return this;
  }
  knob(name, content = "") {
    this.write(`knobs/${name}`, content);
    return this;
  }
  /** Content-addressed view (sha256 prefix + length) of everything a skill may change, plus the mode of .env. */
  state() {
    const one = (rel) => {
      if (!existsSync(this.p(rel))) return "ABSENT";
      const buf = readFileSync(this.p(rel));
      return `${sha(buf)}:${buf.length}`;
    };
    const envMode = existsSync(this.p(".hermes/.env")) ? (statSync(this.p(".hermes/.env")).mode & 0o777).toString(8) : "ABSENT";
    return { env: one(".hermes/.env"), envMode, config: one(".hermes/config.yaml"), soul: one(".hermes/SOUL.md"), crontab: one("crontab.store") };
  }
  // ---- recorded evidence ----
  log(name) {
    return this.read(`logs/${name}`) || "";
  }
  events() {
    return this.log("events.log").split("\n").filter(Boolean);
  }
  /** Each ssh call as the exact string the remote shell received. */
  sshCalls() {
    return this.log("ssh-argv.log").split("----ssh-call----\n").filter(Boolean).map((c) => c.replace(/^host=[^\n]*\n/, "").replace(/\n$/, ""));
  }
  curlCalls() {
    return this.log("curl.log").split("\n").filter(Boolean).map((l) => {
      const f = Object.fromEntries([...l.matchAll(/(?:^| )(call|status|token_len|token_has_dollar|argv_has_token)=(\S*)/g)].map((m) => [m[1], m[2]]));
      return { ...f, url: (/ url=(\S*)/.exec(l) || [])[1] || "", argv: l.slice(l.indexOf(" argv=") + 6) };
    });
  }
  hermesCalls() {
    return this.log("hermes-argv.log").split("\n").filter(Boolean).map((l) => l.split("\t"));
  }

  /** Run a script (string) with /bin/bash under a minimal environment. Resolves to { code, out }. */
  run(script, { env = {}, timeoutMs = Number(process.env.HSTACK_SCRIPT_TIMEOUT_MS) || 90000 } = {}) {
    const file = path.join(this.root, "script.sh");
    writeFileSync(file, script);
    const childEnv = {
      HOME: this.home,
      HSTACK_FAKE: this.home,
      PATH: `${path.join(this.home, "local_bin")}:/usr/bin:/bin`,
      VPS_IP: "203.0.113.9",
      VPS_USER: "root",
      AUTO_APPROVE: "1",
      ...env,
    };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    return new Promise((resolve) => {
      const cp = spawn(BASH, [file], { env: childEnv, cwd: this.root, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      cp.stdout.on("data", (d) => (out += d));
      cp.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => cp.kill("SIGKILL"), timeoutMs);
      cp.on("close", (code, signal) => {
        clearTimeout(timer);
        this.lastOut = out;
        resolve({ code: signal ? `signal:${signal}` : code, out });
      });
    });
  }
  cleanup() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * Run one scenario in a fresh sandbox and hand a result object to `fn`. The sandbox is removed on
 * success; on failure it is kept and its path plus the tail of the script output are appended to the
 * assertion message. HSTACK_KEEP=1 keeps it always.
 */
export async function scenario(opts, fn) {
  const sb = new Sandbox(opts.name || "scenario");
  try {
    sb.seed(opts.seed || {});
    sb.validTokens(opts.valid || []);
    for (const [k, v] of Object.entries(opts.knobs || {})) sb.knob(k, v === true ? "" : String(v));
    for (const [rel, content] of Object.entries(opts.files || {})) sb.write(rel, content);
    if (opts.setup) opts.setup(sb);
    const before = sb.state();
    const res = await sb.run(opts.script, { env: opts.env || {}, timeoutMs: opts.timeoutMs ?? (Number(process.env.HSTACK_TEST_TIMEOUT_MS || 0) || undefined) });
    const run = { sb, before, after: sb.state(), code: res.code, out: res.out, completed: res.out.includes("SCRIPT-COMPLETED") };
    try {
      await fn(run);
    } catch (e) {
      const tail = res.out.split("\n").slice(-45).join("\n");
      e.message = `${e.message}\n--- sandbox kept at ${sb.root}\n--- script output (tail) ---\n${tail}`;
      sb.keep = true;
      throw e;
    }
  } finally {
    if (!sb.keep && process.env.HSTACK_KEEP !== "1") sb.cleanup();
  }
}

export const SCRIPT_END = 'echo "SCRIPT-COMPLETED"\n';
