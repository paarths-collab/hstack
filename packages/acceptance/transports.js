// Transports run the EXACT remote string an op carries.
//   SshTransport      ssh -o BatchMode=yes user@host '<remote>'      (host key policy = operator's ssh config)
//   SandboxTransport  env -i HOME=<sandbox> PATH=/usr/bin:/bin ... bash -c '<remote>'   (same string, local sandbox)
//   RecordingTransport  records {op, remote, redactedStdin} and returns canned (or delegated) results
// exec(op) resolves to { code, stdout, stderr, transportError } and never rejects for a non-zero exit.
// transportError means "we do not know what happened on the target" (ssh exit 255, spawn failure, timeout).

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { UnsafeArgument, validateHost, validateUser } from "./ops.js";

export class TransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransportError";
  }
}

const MAX_OUTPUT = 1024 * 1024;

function runProcess(spawnImpl, command, args, { input, timeoutMs, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: `spawn failed: ${error.code ?? "error"}`, transportError: true });
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes <= MAX_OUTPUT) out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.concat(err).length <= 64 * 1024) err.push(chunk);
    });
    child.on("error", (error) => {
      finish({ code: null, stdout: "", stderr: `spawn failed: ${error.code ?? "error"}`, transportError: true });
    });
    child.on("close", (code) => {
      finish({
        code: timedOut ? null : code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        transportError: timedOut || code === null,
        timedOut,
      });
    });
    // The remote may exit before consuming all of stdin; EPIPE there is not an error of ours.
    child.stdin.on("error", () => {});
    if (input === null || input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

export class SshTransport {
  kind = "ssh";
  #spawn;
  constructor({ host, user, timeoutMs = 120_000, spawnImpl = spawn, sshCommand = "ssh" } = {}) {
    // Validation happens before anything can be executed.
    this.host = validateHost(host);
    this.user = validateUser(user);
    this.timeoutMs = timeoutMs;
    this.sshCommand = sshCommand;
    this.#spawn = spawnImpl;
  }

  /** The argv that exec() will use for `op` — exposed so tests can assert the exact command. */
  argvFor(op) {
    return ["-o", "BatchMode=yes", `${this.user}@${this.host}`, op.remote];
  }

  async exec(op) {
    const result = await runProcess(this.#spawn, this.sshCommand, this.argvFor(op), { input: op.stdin, timeoutMs: this.timeoutMs });
    // ssh itself reports connection/auth problems as 255: the target never ran the command.
    if (result.code === 255) result.transportError = true;
    return result;
  }
}

export class SandboxTransport {
  kind = "sandbox";
  #spawn;
  constructor({ home, extraEnv = {}, timeoutMs = 60_000, spawnImpl = spawn } = {}) {
    if (typeof home !== "string" || !path.isAbsolute(home) || home === path.parse(home).root) {
      throw new UnsafeArgument("sandbox home", "must be an absolute, non-root directory");
    }
    if (!existsSync(home) || !statSync(home).isDirectory()) throw new UnsafeArgument("sandbox home", "directory does not exist");
    for (const [key, value] of Object.entries(extraEnv)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string") throw new UnsafeArgument("sandbox env", "invalid entry");
    }
    this.home = home;
    this.extraEnv = { ...extraEnv };
    this.timeoutMs = timeoutMs;
    this.#spawn = spawnImpl;
  }

  argvFor(op) {
    const extra = Object.entries(this.extraEnv).map(([key, value]) => `${key}=${value}`);
    return ["-i", `HOME=${this.home}`, "PATH=/usr/bin:/bin", ...extra, "bash", "-c", op.remote];
  }

  async exec(op) {
    return runProcess(this.#spawn, "/usr/bin/env", this.argvFor(op), { input: op.stdin, timeoutMs: this.timeoutMs, env: {} });
  }
}

/**
 * Records every op (remote string + redacted stdin; never the real stdin) and answers from `respond(op, index)`
 * or, when `inner` is given, delegates to it after recording.
 */
export class RecordingTransport {
  kind = "recording";
  constructor({ respond = null, inner = null, onExec = null } = {}) {
    this.respond = respond;
    this.inner = inner;
    this.onExec = onExec;
    this.calls = [];
  }

  async exec(op) {
    const index = this.calls.length;
    this.calls.push({ op: op.op, remote: op.remote, stdin: op.redactedStdin, mutates: op.mutates });
    if (this.onExec) await this.onExec(op, index);
    if (this.inner) return this.inner.exec(op);
    const result = this.respond ? await this.respond(op, index) : null;
    return { code: 0, stdout: "", stderr: "", transportError: false, ...(result ?? {}) };
  }

  /** Text form of the recorded sequence, suitable for golden files. */
  transcript() {
    return this.calls
      .map((call, index) => [`#${String(index + 1).padStart(2, "0")} ${call.op} [${call.mutates}]`, `  $ ${call.remote}`, `  < ${call.stdin ?? "(no stdin)"}`].join("\n"))
      .join("\n");
  }
}
