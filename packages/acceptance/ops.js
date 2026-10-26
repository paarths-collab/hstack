// Operation builders. Each builder returns a frozen
//   { op, remote, stdin, redactedStdin, mutates }
// where `remote` is the EXACT string handed to the transport (one ssh argument, or `bash -c` in the
// sandbox). Secrets and tarballs travel only on stdin; argv never contains a secret. Every argument
// passes assertSafeArg and is single-quoted. hstack never builds `doctor` or `--fix` commands.
//
// mutates: "none" | "hstack-dir" (only ~/.hermes/.hstack) | "staging" (staged copy inside a txn dir)
//        | "live" (the user's env/config/cron/skills/gateway — only legal after write-ahead).
// Raw target builders retain the legacy helper path. For a new helper installation, use
// bindHelper(op, install.helperSha); Transaction performs that binding automatically.

import { isIP } from "node:net";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { sha256Hex } from "./receipt.js";

export const HELPER_PATH = "~/.hermes/.hstack/bin/hstack-target.sh";
export const PATH_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"; ';

export class UnsafeArgument extends Error {
  constructor(label, why) {
    super(`unsafe ${label}: ${why}`);
    this.name = "UnsafeArgument";
  }
}

const SAFE_CHARS = /^[A-Za-z0-9_.,:=+@%/|*-]+$/;
const SAFE_CHARS_WITH_SPACE = /^[A-Za-z0-9_.,:=+@%/|* -]+$/;
const PATTERNS = {
  txn: /^[a-z0-9]{8,32}$/,
  envKey: /^[A-Z][A-Z0-9_]{0,63}$/,
  skill: /^[a-z0-9][a-z0-9-]{0,63}$/,
  cronId: /^[a-z0-9][a-z0-9-]{0,63}$/,
  schedule: /^[0-9*/, -]{1,64}$/,
  fingerprint: /^[0-9a-f]{16}$/,
};
const SECRET_VALUE = /^[A-Za-z0-9_.:/=+,@-]{1,4096}$/;

/** Throws unless `arg` is a short string drawn only from the safe alphabet (space only when allowSpace). */
export function assertSafeArg(arg, { allowSpace = false, label = "argument" } = {}) {
  if (typeof arg !== "string") throw new UnsafeArgument(label, "not a string");
  if (arg.length === 0 || arg.length > 512) throw new UnsafeArgument(label, "empty or too long");
  if (!(allowSpace ? SAFE_CHARS_WITH_SPACE : SAFE_CHARS).test(arg)) {
    throw new UnsafeArgument(label, "contains a character outside the safe alphabet");
  }
  // A value that starts with '-' would be read as an option (`--fix`); `..` is never a legitimate path segment here.
  if (arg.startsWith("-") || arg.includes("..")) throw new UnsafeArgument(label, "looks like an option or a path traversal");
  return arg;
}

function quote(arg, options) {
  assertSafeArg(arg, options);
  return `'${arg}'`;
}

function check(kind, value, label) {
  if (typeof value !== "string" || !PATTERNS[kind].test(value)) throw new UnsafeArgument(label, "does not match the expected shape");
  return value;
}

function csv(kind, list, label) {
  if (!Array.isArray(list) || list.length === 0) throw new UnsafeArgument(label, "must be a non-empty list");
  return list.map((item) => check(kind, item, label)).join(",");
}

// ---------------------------------------------------------------------------------------------
// host / user (ssh target)
// ---------------------------------------------------------------------------------------------

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const USERNAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;

export function validateHost(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) throw new UnsafeArgument("host", "empty or too long");
  if (/^[0-9A-Fa-f:.]+$/.test(host) && isIP(host) !== 0) return host; // IPv4 / IPv6 literal, no zone ids
  if (host.startsWith("-") || !HOSTNAME.test(host)) throw new UnsafeArgument("host", "not a hostname or IP literal");
  return host;
}

export function validateUser(user) {
  if (typeof user !== "string" || !USERNAME.test(user)) throw new UnsafeArgument("user", "does not match ^[A-Za-z0-9_][A-Za-z0-9._-]*$");
  return user;
}

// ---------------------------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------------------------

function make(fields) {
  return Object.freeze({ stdin: null, redactedStdin: null, ...fields });
}

/** Immutable, content-addressed helper used by reviewed transactions. */
export function helperPath(scriptSha) {
  if (typeof scriptSha !== "string" || !/^[0-9a-f]{64}$/.test(scriptSha)) {
    throw new UnsafeArgument("helper digest", "must be a sha256 hex digest");
  }
  return `~/.hermes/.hstack/bin/hstack-target-${scriptSha}.sh`;
}

/** Bind a legacy-shaped op to the exact helper the operator reviewed. */
export function bindHelper(op, scriptSha) {
  const pinned = helperPath(scriptSha);
  return make({ ...op, remote: op.remote
    .split(HELPER_PATH).join(pinned)
    .split(HELPER_PATH.replace(/^~/, "$HOME")).join(pinned.replace(/^~/, "$HOME")) });
}

function scriptStdin(scriptBody) {
  if (typeof scriptBody !== "string" || scriptBody.length === 0) throw new UnsafeArgument("script", "target script body is empty");
  return { stdin: scriptBody, redactedStdin: `<STDIN script bytes=${Buffer.byteLength(scriptBody)} sha256=${sha256Hex(scriptBody)}>` };
}

function target(op, parts) {
  return `${PATH_EXPORT}${HELPER_PATH} ${op}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`;
}

/** Strictly read-only: runs the script from stdin, installs nothing. */
export function opInspect(scriptBody) {
  return make({ op: "inspect", remote: "bash -s -- inspect", mutates: "none", ...scriptStdin(scriptBody) });
}

/** Read-only re-inspection through an already reviewed helper. */
export function opInspectInstalled() {
  return make({ op: "inspect", remote: target("inspect", []), mutates: "none" });
}

export function opInstallHelper(scriptBody) {
  const input = scriptStdin(scriptBody);
  const pinned = helperPath(sha256Hex(scriptBody));
  return make({
    op: "install-helper",
    helperSha: sha256Hex(scriptBody),
    helperPath: pinned,
    // A hard link publishes complete bytes atomically without replacing an existing helper.
    // Another transaction may be executing that inode; never truncate or rename over it.
    remote: `umask 077; mkdir -p ~/.hermes/.hstack/bin || exit 1; t=$(mktemp "$HOME/.hermes/.hstack/bin/.helper.XXXXXXXX") || exit 1; trap 'rm -f "$t"' EXIT; cat > "$t" && chmod 700 "$t" || exit 1; if [ -d ${pinned} ] || [ -L ${pinned} ]; then exit 1; fi; if ln "$t" ${pinned} 2>/dev/null; then :; else [ ! -L ${pinned} ] && [ -f ${pinned} ] && cmp -s "$t" ${pinned} || exit 1; fi`,
    mutates: "hstack-dir",
    ...input,
  });
}

export function opHelperVerify() {
  return make({
    op: "helper-verify",
    remote: 'f="$HOME/.hermes/.hstack/bin/hstack-target.sh"; if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f"; else shasum -a 256 "$f"; fi',
    mutates: "none",
  });
}

export function opBackup({ txn, keys }) {
  return make({
    op: "backup",
    remote: target("backup", [quote(check("txn", txn, "txn")), "--keys", quote(csv("envKey", keys, "keys"))]),
    mutates: "hstack-dir",
  });
}

export function opPutEnv({ txn, key, allow, value }) {
  check("envKey", key, "key");
  if (!allow.includes(key)) throw new UnsafeArgument("key", "not in the allow list");
  if (typeof value !== "string" || !SECRET_VALUE.test(value)) {
    // Never echo the value.
    throw new UnsafeArgument("value", "empty, too long, or contains characters outside [A-Za-z0-9_.:/=+,@-]");
  }
  return make({
    op: "put-env",
    remote: target("put-env", [quote(check("txn", txn, "txn")), quote(key), "--allow", quote(csv("envKey", allow, "allow"))]),
    stdin: `${value}\n`,
    redactedStdin: `<STDIN secret len=${value.length}>`,
    mutates: "staging",
  });
}

export function opStageCheck({ txn }) {
  return make({ op: "stage-check", remote: target("stage-check", [quote(check("txn", txn, "txn"))]), mutates: "none" });
}

export function opSkillsSync({ txn, names, tar }) {
  if (!Buffer.isBuffer(tar) || tar.length === 0) throw new UnsafeArgument("tar", "empty skills archive");
  return make({
    op: "skills-sync",
    remote: target("skills-sync", [quote(check("txn", txn, "txn")), "--names", quote(csv("skill", names, "names"))]),
    stdin: tar,
    redactedStdin: `<STDIN tar bytes=${tar.length} sha256=${sha256Hex(tar)}>`,
    mutates: "live",
  });
}

export function opApply({ txn, cron }) {
  if (typeof cron.prompt !== "string" || cron.prompt.includes("|")) throw new UnsafeArgument("cron prompt", "must not contain '|'");
  const spec = `${check("cronId", cron.id, "cron id")}|${check("schedule", cron.schedule, "schedule")}|${cron.prompt}`;
  return make({
    op: "apply",
    remote: target("apply", [quote(check("txn", txn, "txn")), "--cron", quote(spec, { allowSpace: true, label: "cron spec" })]),
    mutates: "live",
  });
}

/**
 * Reload the gateway. `interruptLiveSessions` is the operator's explicit opt-in to Hermes 0.22.5's `restart -y`
 * (interrupt live sessions); by default the reload is refused, and reported as failed, while sessions are live.
 */
export function opReload({ txn, interruptLiveSessions = false }) {
  const args = [quote(check("txn", txn, "txn"))];
  if (interruptLiveSessions === true) args.push("--interrupt-live-sessions");
  return make({ op: "reload", remote: target("reload", args), mutates: "live" });
}

export function opVerify({ txn, destinationFp, allowVar, destVar, cronId, schedule, skills = null }) {
  return make({
    op: "verify",
    remote: target("verify", [
      quote(check("txn", txn, "txn")),
      "--destination-fp", quote(check("fingerprint", destinationFp, "destination fingerprint")),
      "--allow-var", quote(check("envKey", allowVar, "allow var")),
      "--dest-var", quote(check("envKey", destVar, "destination var")),
      "--cron-id", quote(check("cronId", cronId, "cron id")),
      "--schedule", quote(check("schedule", schedule, "schedule"), { allowSpace: true, label: "schedule" }),
      ...(skills ? ["--skills", quote(csv("skill", skills, "skills"))] : []),
    ]),
    mutates: "none",
  });
}

export function opRestore({ txn }) {
  return make({ op: "restore", remote: target("restore", [quote(check("txn", txn, "txn"))]), mutates: "live" });
}

export function opCommit({ txn }) {
  return make({ op: "commit", remote: target("commit", [quote(check("txn", txn, "txn"))]), mutates: "hstack-dir" });
}

export function opPurge({ txn }) {
  return make({ op: "purge", remote: target("purge", [quote(check("txn", txn, "txn"))]), mutates: "hstack-dir" });
}

/** The reviewable form of an op: never contains stdin content. */
export function describeOp(op) {
  return { op: op.op, remote: op.remote, stdin: op.redactedStdin, mutates: op.mutates };
}

// ---------------------------------------------------------------------------------------------
// deterministic ustar archive of skill directories
// ---------------------------------------------------------------------------------------------

const MAX_FILES = 500;
const MAX_BYTES = 8 * 1024 * 1024;
const TAR_PATH = /^[A-Za-z0-9_./-]+$/;

function octal(value, width) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function tarHeader(name, { size, mode, type }) {
  if (!TAR_PATH.test(name) || name.includes("..") || name.startsWith("/")) throw new UnsafeArgument("tar path", "unsafe archive member name");
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(base) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || name.length - cut - 1 > 100) throw new UnsafeArgument("tar path", "member name too long");
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const header = Buffer.alloc(512, 0);
  header.write(base, 0, "ascii");
  header.write(octal(mode, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(size, 12), 124, "ascii");
  header.write(octal(0, 12), 136, "ascii");
  header.write("        ", 148, "ascii"); // checksum placeholder (spaces)
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.write(prefix, 345, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function collect(dir, relative, out) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = `${relative}/${entry.name}`;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new UnsafeArgument("skills archive", `symlink not allowed: ${rel}`);
    if (stat.isDirectory()) {
      out.push({ rel: `${rel}/`, dir: true });
      collect(full, rel, out);
    } else if (stat.isFile()) {
      out.push({ rel, full, executable: (stat.mode & 0o111) !== 0 });
    } else {
      throw new UnsafeArgument("skills archive", `unsupported file type: ${rel}`);
    }
  }
}

/** Deterministic tar (sorted, mtime 0, uid/gid 0) of skills/<name>/ for each name. */
export function buildSkillsTar(skillsRoot, names) {
  const members = [];
  for (const name of names) {
    check("skill", name, "skill name");
    const dir = path.join(skillsRoot, name);
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      throw new UnsafeArgument("skills archive", `skill directory missing: ${name}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UnsafeArgument("skills archive", `not a plain directory: ${name}`);
    members.push({ rel: `${name}/`, dir: true });
    collect(dir, name, members);
  }
  if (members.length > MAX_FILES) throw new UnsafeArgument("skills archive", "too many files");
  const blocks = [];
  let total = 0;
  for (const member of members) {
    if (member.dir) {
      blocks.push(tarHeader(member.rel, { size: 0, mode: 0o755, type: "5" }));
      continue;
    }
    const data = readFileSync(member.full);
    total += data.length;
    if (total > MAX_BYTES) throw new UnsafeArgument("skills archive", "archive too large");
    blocks.push(tarHeader(member.rel, { size: data.length, mode: member.executable ? 0o755 : 0o644, type: "0" }));
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

/** sha256 over the sorted (relative path, content) pairs of the named skills; identifies the shipped skill tree. */
export function skillsTreeHash(skillsRoot, names) {
  const tar = buildSkillsTar(skillsRoot, names);
  return sha256Hex(tar);
}
